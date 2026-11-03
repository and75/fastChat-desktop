import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/api'
import { IPC, type Conversation, type Result, type StreamEvent } from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>

/** Listener per un evento main → renderer. L'oggetto evento di Electron non viene mai passato al renderer. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** Unica superficie esposta al renderer. Nessun accesso diretto a ipcRenderer o a Node. */
const api: Api = {
  models: {
    list: () => invoke(IPC.modelsList),
    capabilities: (name) => invoke(IPC.modelsCapabilities, name),
    check: (url) => invoke(IPC.modelsCheck, url)
  },
  conversations: {
    list: (query) => invoke(IPC.conversationsList, query),
    get: (id) => invoke(IPC.conversationsGet, id),
    create: (fromTemplateId) => invoke(IPC.conversationsCreate, fromTemplateId),
    update: (id, patch) => invoke(IPC.conversationsUpdate, id, patch),
    remove: (id) => invoke(IPC.conversationsRemove, id),
    export: (id, format) => invoke(IPC.conversationsExport, id, format),
    onUpdated: (cb) => subscribe<Conversation>(IPC.conversationUpdated, cb)
  },
  templates: {
    list: () => invoke(IPC.templatesList),
    create: (conversationId, name) => invoke(IPC.templatesCreate, conversationId, name),
    remove: (id) => invoke(IPC.templatesRemove, id)
  },
  chat: {
    send: (id, text) => invoke(IPC.chatSend, id, text),
    regenerate: (id) => invoke(IPC.chatRegenerate, id),
    abort: (streamId) => invoke(IPC.chatAbort, streamId),
    onStream: (cb) => subscribe<StreamEvent>(IPC.chatStream, cb)
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
