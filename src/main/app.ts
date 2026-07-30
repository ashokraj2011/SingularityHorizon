import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
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
import { lastThemeSync, preferredToolProfile, rememberTheme, rememberToolProfile } from './prefs'
import { renderAuditMarkdown, suggestedFilename } from './auditReport'
import {
  agentAllowed,
  configChangeRefusal,
  enforceToolProfile,
  loadPolicy
} from './adminPolicy'
import { loadForest } from './capability/load'
import { buildCapabilityView } from './capability/view'
import { planMaterialization, type CapabilityDraft } from './capability/plan'
import { compileCalls, ledgerRepoUrlOf } from './capability/calls'
import { probeSgh } from './sgh'
import { GitHubApplier } from './ledger'
import { configureStore } from './store/sessionStore'
import {
  configureEndpoints,
  deleteEndpoint,
  listEndpoints,
  saveEndpoint,
  setDefaultEndpoint,
  testEndpoint
} from './llmEndpoints'
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
    // Matched to the theme the renderer is about to resolve, so there is no
    // flash on the one frame CSS cannot reach. The last resolved theme beats the
    // OS setting, because an explicit light choice on a dark system is exactly
    // the case a nativeTheme check gets wrong.
    backgroundColor:
      (lastThemeSync() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')) === 'dark'
        ? '#111113'
        : '#ffffff',
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
  /**
   * Forwards renderer console errors to the main process log.
   *
   * The signature changed across Electron majors: 33 passes
   * (event, level, message, line, sourceId) positionally, 43 passes a single
   * details object. Handling both matters because getting it wrong fails
   * silently — the listener runs, reads undefined, and forwards nothing, so
   * renderer errors simply stop appearing and the app looks healthy.
   */
  const onConsoleMessage = (...args: unknown[]): void => {
    const [a, b, c, d] = args
    let level: string | number | undefined
    let message: string | undefined
    let source: string | undefined
    let line: number | undefined

    if (a && typeof a === 'object' && 'message' in (a as object)) {
      const details = a as { level: string; message: string; sourceId?: string; lineNumber?: number }
      level = details.level
      message = details.message
      source = details.sourceId
      line = details.lineNumber
    } else {
      level = b as string | number
      message = c as string
      line = d as number
      source = args[4] as string
    }

    const isProblem =
      level === 'warning' || level === 'error' || (typeof level === 'number' && level >= 2)
    if (isProblem && message) {
      console.error(`[renderer] ${message}${source ? ` (${source}:${line ?? 0})` : ''}`)
    }
  }
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
  // Keys are encrypted by the OS keychain. safeStorage is passed in rather than
  // imported by the store, so the store stays runnable outside Electron.
  configureEndpoints(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64'))
  })
  registerHandlers()
}

function registerHandlers(): void {

handle('agents:list', async () => {
  const policy = await loadPolicy()
  return (await availableAgents()).filter((a) => agentAllowed(policy, a.id))
})
handle('adminPolicy:get', (workingDir?: string) => loadPolicy(workingDir))
handle('theme:remember', (theme: 'dark' | 'light') => rememberTheme(theme))
handle('capability:load', async (root: string) => {
  const { forest, issues, sources, pointerSources, pointers, declarations } = await loadForest(root)
  return buildCapabilityView(root, forest, pointers, issues, sources, pointerSources, declarations)
})
handle('sgh:status', () => probeSgh())
handle('capability:plan', async (root: string, draft: CapabilityDraft) => {
  const { forest } = await loadForest(root)
  const sgh = await probeSgh()
  return planMaterialization(draft, forest, {
    sghHasCapabilityCommand: sgh.hasCapabilityCommand
  })
})
handle('capability:apply', async (root: string, draft: CapabilityDraft, live?: boolean) => {
  const { forest } = await loadForest(root)
  const sgh = await probeSgh()
  const plan = planMaterialization(draft, forest, {
    sghHasCapabilityCommand: sgh.hasCapabilityCommand
  })

  // A plan with errors describes a forest that would be invalid. Compiling it to
  // requests would just move the failure to somewhere it does damage.
  if (plan.errors.length) {
    return { ok: false, dryRun: true, outcomes: [], blocked: plan.errors.map((reason) => ({ step: 'plan', reason })) }
  }

  const parent = draft.parent ? forest.byId.get(draft.parent) : undefined
  const parentLedger = ledgerRepoUrlOf(parent)

  const { calls, blocked } = compileCalls(
    plan,
    Object.fromEntries((draft.repos ?? []).map((r) => [r.repoId, r.url])),
    { parentLedgerRepo: parentLedger }
  )

  // Read from the environment only. A token typed into this app would be a
  // credential this app then has to store, and it has no business holding one.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (live && !token) {
    return {
      ok: false,
      dryRun: true,
      outcomes: [],
      blocked: [{ step: 'auth', reason: 'set GITHUB_TOKEN in the environment to apply for real' }]
    }
  }

  return new GitHubApplier({
    token: token ?? '',
    baseUrl: process.env.GITHUB_API_URL,
    // Anything short of an explicit true is a dry run.
    dryRun: live !== true
  }).apply(calls, blocked)
})
handle('llm:list', () => listEndpoints())
handle('llm:save', (input) => saveEndpoint(input))
handle('llm:delete', (id: string) => deleteEndpoint(id))
handle('llm:setDefault', (id: string) => setDefaultEndpoint(id))
handle('llm:test', (id: string) => testEndpoint(id))
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
  const policy = await loadPolicy(opts.cwd)
  if (!agentAllowed(policy, opts.agentId)) {
    throw new Error(`Agent "${opts.agentId}" is not permitted by policy.`)
  }
  // Policy overrides both the request and the remembered preference.
  const profile = enforceToolProfile(
    policy,
    opts.toolProfile ?? (await preferredToolProfile(repo?.root))
  )
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
handle('sessions:usageSummary', () => manager.usageSummary())
handle('sessions:saveAudit', async (id: string, format: 'json' | 'markdown') => {
  const record = await manager.audit(id)
  const body =
    format === 'markdown' ? renderAuditMarkdown(record) : JSON.stringify(record, null, 2)

  if (!mainWindow) return null
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export audit record',
    defaultPath: suggestedFilename(record, format),
    filters:
      format === 'markdown'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return null
  await writeFile(res.filePath, body, 'utf8')
  return res.filePath
})
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
handle(
  'sessions:setConfigOption',
  async (sessionId: string, optionId: string, value: string) => {
    // Refused here rather than only in the UI: the renderer is the layer a user
    // can most easily route around, so it cannot be the thing enforcing policy.
    const session = manager.list().find((s) => s.id === sessionId)
    const refusal = configChangeRefusal(await loadPolicy(session?.cwd), optionId, value)
    if (refusal) throw new Error(refusal)
    return manager.setConfigOption(sessionId, optionId, value)
  }
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
