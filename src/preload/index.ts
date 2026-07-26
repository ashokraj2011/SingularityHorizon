import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { AcpStudioApi, MainEvent } from '../shared/ipc'
import type { ContentBlock } from '../shared/acp'

/**
 * The renderer never touches Node or Electron directly — this is the entire
 * surface it gets. Every method is a thin, typed pass-through to a main-process
 * handler.
 */
const api: AcpStudioApi = {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (opts) => ipcRenderer.invoke('sessions:create', opts),
  closeSession: (sessionId) => ipcRenderer.invoke('sessions:close', sessionId),
  prompt: (sessionId: string, content: ContentBlock[]) =>
    ipcRenderer.invoke('sessions:prompt', sessionId, content),
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
