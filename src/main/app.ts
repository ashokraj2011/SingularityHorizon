import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  AgentDefinition,
  DirEntry,
  MainEvent,
  PromptRequest,
  SessionSnapshot
} from '../shared/ipc'
import { availableAgents, TOOL_PROFILES } from './agents'
import { indexFor } from './ast/astIndex'
import { extractSymbol } from './ast/outline'
import { statPaths } from './attachments'
import { loadProvidersFromEnv } from './providers/load'
import { registeredProviders } from './providers/registry'
import { preferredToolProfile, rememberToolProfile } from './prefs'
import { configureStore } from './store/sessionStore'
import { discoverRepo, ensureAstIgnored } from './repo'
import { SessionManager } from './manager'
import { expandSkill, listSkills } from './skills'

const manager = new SessionManager()
let mainWindow: BrowserWindow | null = null

/**
 * Opaque, host-supplied context keyed by working directory.
 *
 * Core never inspects the value — it is whatever the host wants the UI to know
 * about a folder (a work item, a ticket, a deployment target). Keeping it
 * untyped here is deliberate: the moment core understands the shape, it has
 * acquired a dependency on one host's model, which is the coupling this whole
 * design exists to avoid. The host validates its own shape on the way in and
 * renders it through a UI slot on the way out.
 */
const hostContexts = new Map<string, unknown>()

export function setHostContext(cwd: string, context: unknown): void {
  const key = resolve(cwd)
  if (context == null) hostContexts.delete(key)
  else hostContexts.set(key, context)
  broadcast({ type: 'host:context', cwd: key, context: context ?? null })
}

export function getHostContext(cwd: string): unknown {
  return hostContexts.get(resolve(cwd)) ?? null
}

function broadcast(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('acp:event', event)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#12100f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // `ready-to-show` is the clean signal, but it never fires if the renderer
  // fails to load — which would leave the app running with no window at all.
  // Show on either signal, whichever lands first.
  const reveal = (): void => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
  mainWindow.once('ready-to-show', reveal)
  mainWindow.webContents.once('did-finish-load', reveal)
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] failed to load ${url}: ${desc} (${code})`)
    reveal()
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason)
  })
  const onConsoleMessage = (_event: unknown, details: {
    level: 'verbose' | 'info' | 'warning' | 'error'
    message: string
    sourceId: string
    lineNumber: number
  }): void => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    }
  }
  // Electron 43 passes one details object. The upstream standalone still
  // typechecks against Electron 33, whose declaration exposes the deprecated
  // five-argument callback, so keep the runtime-correct two-argument handler.
  mainWindow.webContents.on('console-message', onConsoleMessage as never)
  setTimeout(reveal, 4000)

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

manager.on('event', (event: MainEvent) => broadcast(event))

/* ------------------------------------------------------------------- IPC */

function handle(channel: string, fn: (...args: any[]) => any): void {
  // removeHandler first so registering twice is a no-op rather than a throw —
  // an embedding host may call registerEventHorizonHandlers() defensively.
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

let handlersRegistered = false

/**
 * Registers every IPC handler the renderer needs.
 *
 * Split out of module scope so importing this file has no side effects: an
 * embedding host controls exactly when handlers attach, and can import the
 * module to read `eventHorizonStatus()` without mutating Electron's global
 * ipcMain registry.
 */
export function registerEventHorizonHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  // An embedding host may never call startStandalone, so configure here too.
  configureStore(join(app.getPath('userData'), 'sessions'))
  registerHandlers()
}

function registerHandlers(): void {

handle('agents:list', () => availableAgents())
handle('sessions:list', () => manager.list())
handle('agents:toolProfiles', () =>
  TOOL_PROFILES.map(({ id, name, description, measuredOverhead }) => ({
    id,
    name,
    description,
    measuredOverhead
  }))
)
handle('sessions:create', async (opts: { cwd: string; agentId: string; toolProfile?: string }) => {
  // Remember the choice against the repo so the next session on it starts the
  // same way — the saving is worthless if it has to be re-selected every time.
  const repo = await discoverRepo(opts.cwd).catch(() => null)
  const profile = opts.toolProfile ?? (await preferredToolProfile(repo?.root))
  if (profile) void rememberToolProfile(profile, repo?.root)
  return manager.create(opts.cwd, opts.agentId, profile, {
    hostContext: getHostContext(opts.cwd)
  })
})
handle('prefs:toolProfile', (repoRoot?: string) => preferredToolProfile(repoRoot))
handle('sessions:close', (sessionId: string) => manager.close(sessionId))
handle('sessions:listPersisted', () => manager.listPersisted())
handle('sessions:restore', (id: string) => manager.restore(id))
handle('sessions:forget', (id: string) => manager.forget(id))
handle('sessions:audit', (id: string) => manager.audit(id))
handle('sessions:prompt', (sessionId: string, request: PromptRequest) =>
  manager.prompt(sessionId, request)
)
handle('sessions:restart', (sessionId: string) => manager.restart(sessionId))
handle('sessions:runCommandSilent', (sessionId: string, command: string) =>
  manager.runCommandSilent(sessionId, command)
)
handle('sessions:refreshContext', (sessionId: string) => manager.refreshContext(sessionId))
handle('fs:statPaths', (paths: string[]) => statPaths(paths))

handle('repo:describe', async (workingDir: string) => {
  const info = await discoverRepo(workingDir)
  // Keep the index out of git the moment we know where the repo is, rather
  // than waiting for the first search to create an untracked directory.
  if (info.isGit) await ensureAstIgnored(info.root)
  return info
})
handle('ast:refresh', (repoRoot: string) => indexFor(repoRoot).refresh())
handle('ast:rebuild', (repoRoot: string) => indexFor(repoRoot).rebuild())
handle('ast:search', async (repoRoot: string, query: string) => {
  const index = indexFor(repoRoot)
  // Refresh before searching: a stale hit sends the agent to a line that has
  // moved, which is worse than a slightly slower search.
  await index.refresh()
  return index.search(query)
})
handle('ast:attachSymbol', async (repoRoot: string, path: string, name: string) => {
  const found = await extractSymbol(path, name)
  if (!found) return null
  return {
    path,
    name: `${name} (${found.kind})`,
    kind: 'file' as const,
    bytes: found.text.length,
    mode: 'outline' as const
  }
})
handle('dialog:pickFiles', async () => {
  if (!mainWindow) return []
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections']
  })
  return res.canceled ? [] : res.filePaths
})
handle('skills:list', (cwd: string) => listSkills(cwd))
handle('skills:expand', (cwd: string, name: string, args: string) =>
  expandSkill(cwd, name, args)
)
handle('sessions:cancel', (sessionId: string) => manager.cancel(sessionId))
handle('sessions:setConfigOption', (sessionId: string, optionId: string, value: string) =>
  manager.setConfigOption(sessionId, optionId, value)
)
handle('permissions:respond', (requestId: string, optionId: string | null) =>
  manager.respondPermission(requestId, optionId)
)

handle('dialog:pickDirectory', async () => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return res.canceled ? null : res.filePaths[0]
})

handle('fs:homeDir', () => homedir())

handle('fs:readDir', async (dir: string): Promise<DirEntry[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.github')
    .map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      isDirectory: e.isDirectory()
    }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory
          ? -1
          : 1
    )
})

handle('fs:readFile', async (path: string) => {
  const info = await stat(path)
  // Guard the renderer against accidentally loading a multi-hundred-MB blob.
  if (info.size > 2 * 1024 * 1024) throw new Error('File is too large to preview (>2 MB)')
  return readFile(path, 'utf8')
})

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'venv',
  '__pycache__',
  '.venv'
])

/** Bounded breadth-first filename search backing the composer's @-mentions. */
handle('fs:searchFiles', async (root: string, query: string): Promise<string[]> => {
  const needle = query.toLowerCase()
  const results: string[] = []
  const queue: string[] = [resolve(root)]
  let visited = 0

  while (queue.length && results.length < 50 && visited < 4000) {
    const dir = queue.shift()!
    visited++
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (!needle || entry.name.toLowerCase().includes(needle)) {
        results.push(full)
        if (results.length >= 50) break
      }
    }
  }
  return results
})

}

/* ------------------------------------------------------------ embedding API */

export interface OpenWindowOptions {
  /** Working directory to open a session on once the window is ready. */
  cwd?: string
  /** Opaque host context associated with `cwd`; see setHostContext. */
  hostContext?: unknown
  /** Focus an existing window instead of opening a second one. */
  reuse?: boolean
  /** Agent to use if `cwd` needs a new session. Defaults to copilot. */
  agentId?: string
  /** Tool profile for a newly created session. */
  toolProfile?: string
}

/**
 * Opens (or focuses) the Event Horizon window.
 *
 * This is the entry point for an in-process host: an Electron app that wants
 * Event Horizon as a surface inside itself calls this rather than spawning a
 * second process, so the two share one Electron runtime and one lifecycle.
 */
export function openEventHorizonWindow(options: OpenWindowOptions = {}): BrowserWindow {
  registerEventHorizonHandlers()
  if (options.cwd) setHostContext(options.cwd, options.hostContext)

  const reusing = options.reuse !== false && mainWindow && !mainWindow.isDestroyed()
  if (reusing) {
    mainWindow!.show()
    mainWindow!.focus()
  } else {
    createWindow()
  }

  if (options.cwd) void activateWorkspace(options.cwd, options)
  return mainWindow!
}

/**
 * Focuses the session for a directory, creating one only if none exists.
 *
 * A host that hands the same repository over twice means "show me that work",
 * not "start again" — spawning a second agent would silently fork the
 * conversation and double the process count. Existing sessions are matched on
 * the resolved cwd so a symlinked path does not read as a different repo.
 */
export async function activateWorkspace(
  cwd: string,
  options: { agentId?: string; toolProfile?: string } = {}
): Promise<SessionSnapshot | null> {
  registerEventHorizonHandlers()
  const target = resolve(cwd)

  const existing = manager.list().find((s) => resolve(s.cwd) === target)
  if (existing) {
    broadcast({ type: 'session:activate', sessionId: existing.id })
    return existing
  }

  try {
    const created = await manager.create(target, options.agentId ?? 'copilot', options.toolProfile, {
      hostContext: getHostContext(target)
    })
    broadcast({ type: 'session:activate', sessionId: created.id })
    return created
  } catch (err) {
    console.error('[event-horizon] failed to activate workspace:', (err as Error).message)
    return null
  }
}

export interface EventHorizonStatus {
  handlersRegistered: boolean
  windowOpen: boolean
  /** ACP runtimes discovered on this machine. */
  agents: AgentDefinition[]
  /** Live sessions, not a count — a host may want to render them. */
  sessions: SessionSnapshot[]
  providers: string[]
  hostContexts: number
}

/**
 * Introspection for a host that wants to show whether the surface is live and
 * what it found.
 *
 * Async because agent discovery probes the filesystem for each runtime: a host
 * asking "is Copilot available here?" wants the real answer, not a cached one
 * from before the user installed it.
 */
export async function eventHorizonStatus(): Promise<EventHorizonStatus> {
  return {
    handlersRegistered,
    windowOpen: !!mainWindow && !mainWindow.isDestroyed(),
    agents: await availableAgents(),
    sessions: manager.list(),
    providers: registeredProviders().map((p) => p.id),
    hostContexts: hostContexts.size
  }
}

/** Starts the standalone desktop app. The embedded host does not call this. */
export async function startStandalone(): Promise<void> {
  await app.whenReady()
  configureStore(join(app.getPath('userData'), 'sessions'))
  // Opt-in only: standalone loads nothing unless EVENT_HORIZON_PROVIDERS names
  // something, so a host embeds this verbatim rather than editing the source.
  const loaded = await loadProvidersFromEnv()
  if (loaded.length) console.log(`[providers] registered: ${loaded.join(', ')}`)

  registerEventHorizonHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => manager.disposeAll())
}
