import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ContentBlock } from '../shared/acp'
import type { DirEntry, MainEvent } from '../shared/ipc'
import { availableAgents } from './agents'
import { SessionManager } from './manager'

const manager = new SessionManager()
let mainWindow: BrowserWindow | null = null

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
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`)
  })
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

manager.on('event', (event: MainEvent) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('acp:event', event)
  }
})

/* ------------------------------------------------------------------- IPC */

function handle(channel: string, fn: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

handle('agents:list', () => availableAgents())
handle('sessions:list', () => manager.list())
handle('sessions:create', (opts: { cwd: string; agentId: string }) =>
  manager.create(opts.cwd, opts.agentId)
)
handle('sessions:close', (sessionId: string) => manager.close(sessionId))
handle('sessions:prompt', (sessionId: string, content: ContentBlock[]) =>
  manager.prompt(sessionId, content)
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

/* --------------------------------------------------------------- lifecycle */

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => manager.disposeAll())
