import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '@shared/api'
import { IPC, type Result } from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>

/** Unica superficie esposta al renderer. Nessun accesso diretto a ipcRenderer o a Node. */
const api: Api = {
  models: {
    list: () => invoke(IPC.modelsList),
    capabilities: (name) => invoke(IPC.modelsCapabilities, name)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  }
}

contextBridge.exposeInMainWorld('api', api)
