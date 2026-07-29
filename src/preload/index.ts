import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { AcpStudioApi, MainEvent } from '../shared/ipc'

/**
 * The renderer never touches Node or Electron directly — this is the entire
 * surface it gets. Every method is a thin, typed pass-through to a main-process
 * handler.
 */
const api: AcpStudioApi = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listToolProfiles: () => ipcRenderer.invoke('agents:toolProfiles'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  closeSession: (sessionId) => ipcRenderer.invoke('sessions:close', sessionId),
  listPersisted: () => ipcRenderer.invoke('sessions:listPersisted'),
  restoreSession: (id) => ipcRenderer.invoke('sessions:restore', id),
  forgetSession: (id) => ipcRenderer.invoke('sessions:forget', id),
  usageSummary: () => ipcRenderer.invoke('sessions:usageSummary'),
  getAdminPolicy: (workingDir) => ipcRenderer.invoke('adminPolicy:get', workingDir),
  rememberTheme: (theme) => ipcRenderer.invoke('theme:remember', theme),
  listEndpoints: () => ipcRenderer.invoke('llm:list'),
  saveEndpoint: (input) => ipcRenderer.invoke('llm:save', input),
  deleteEndpoint: (id) => ipcRenderer.invoke('llm:delete', id),
  setDefaultEndpoint: (id) => ipcRenderer.invoke('llm:setDefault', id),
  testEndpoint: (id) => ipcRenderer.invoke('llm:test', id),
  exportAudit: (id) => ipcRenderer.invoke('sessions:audit', id),
  saveAudit: (id, format) => ipcRenderer.invoke('sessions:saveAudit', id, format),
  restartSession: (sessionId) => ipcRenderer.invoke('sessions:restart', sessionId),
  prompt: (sessionId, request) => ipcRenderer.invoke('sessions:prompt', sessionId, request),
  runCommandSilent: (sessionId, command) =>
    ipcRenderer.invoke('sessions:runCommandSilent', sessionId, command),
  refreshContext: (sessionId) => ipcRenderer.invoke('sessions:refreshContext', sessionId),
  listSkills: (cwd) => ipcRenderer.invoke('skills:list', cwd),
  expandSkill: (cwd, name, args) => ipcRenderer.invoke('skills:expand', cwd, name, args),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  statPaths: (paths) => ipcRenderer.invoke('fs:statPaths', paths),
  describeRepo: (workingDir) => ipcRenderer.invoke('repo:describe', workingDir),
  preferredToolProfile: (repoRoot) => ipcRenderer.invoke('prefs:toolProfile', repoRoot),
  refreshAstIndex: (repoRoot) => ipcRenderer.invoke('ast:refresh', repoRoot),
  rebuildAstIndex: (repoRoot) => ipcRenderer.invoke('ast:rebuild', repoRoot),
  searchSymbols: (repoRoot, query) => ipcRenderer.invoke('ast:search', repoRoot, query),
  attachSymbol: (repoRoot, path, name) =>
    ipcRenderer.invoke('ast:attachSymbol', repoRoot, path, name),
  cancel: (sessionId) => ipcRenderer.invoke('sessions:cancel', sessionId),
  respondPermission: (requestId, optionId) =>
    ipcRenderer.invoke('permissions:respond', requestId, optionId),
  setConfigOption: (sessionId, optionId, value) =>
    ipcRenderer.invoke('sessions:setConfigOption', sessionId, optionId, value),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  searchFiles: (root, query) => ipcRenderer.invoke('fs:searchFiles', root, query),
  homeDir: () => ipcRenderer.invoke('fs:homeDir'),
  onEvent: (listener: (event: MainEvent) => void) => {
    const handler = (_e: IpcRendererEvent, event: MainEvent): void => listener(event)
    ipcRenderer.on('acp:event', handler)
    return () => ipcRenderer.removeListener('acp:event', handler)
  }
}

contextBridge.exposeInMainWorld('acp', api)
