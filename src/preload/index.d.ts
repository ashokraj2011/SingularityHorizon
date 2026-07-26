import type { AcpStudioApi } from '../shared/ipc'

declare global {
  interface Window {
    acp: AcpStudioApi
  }
}

export {}
