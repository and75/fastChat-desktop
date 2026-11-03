import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/api'
import { IPC, type Result, type StreamEvent } from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>

/** Unica superficie esposta al renderer. Nessun accesso diretto a ipcRenderer o a Node. */
const api: Api = {
  models: {
    list: () => invoke(IPC.modelsList),
    capabilities: (name) => invoke(IPC.modelsCapabilities, name)
  },
  conversations: {
    list: (query) => invoke(IPC.conversationsList, query),
    get: (id) => invoke(IPC.conversationsGet, id),
    create: () => invoke(IPC.conversationsCreate),
    update: (id, patch) => invoke(IPC.conversationsUpdate, id, patch),
    remove: (id) => invoke(IPC.conversationsRemove, id)
  },
  chat: {
    send: (id, text) => invoke(IPC.chatSend, id, text),
    regenerate: (id) => invoke(IPC.chatRegenerate, id),
    abort: (streamId) => invoke(IPC.chatAbort, streamId),
    onStream: (cb) => {
      // L'oggetto evento di Electron non viene mai passato al renderer.
      const listener = (_e: IpcRendererEvent, event: StreamEvent): void => cb(event)
      ipcRenderer.on(IPC.chatStream, listener)
      return () => {
        ipcRenderer.removeListener(IPC.chatStream, listener)
      }
    }
  },
  plans: {
    propose: (id, text) => invoke(IPC.plansPropose, id, text),
    regenerate: (id) => invoke(IPC.plansRegenerate, id),
    update: (planId, update) => invoke(IPC.plansUpdate, planId, update),
    execute: (planId) => invoke(IPC.plansExecute, planId)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  }
}

contextBridge.exposeInMainWorld('api', api)
