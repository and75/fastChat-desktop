import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/api'
import { IPC, type BenchmarkProgress, type ContextCall, type Conversation, type KnowledgeProgress, type PullProgress, type Result, type StreamEvent } from '@shared/types'

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
    check: (url) => invoke(IPC.modelsCheck, url),
    settings: () => invoke(IPC.modelSettingsList),
    setSetting: (model, patch) => invoke(IPC.modelSettingsSet, model, patch),
    pull: (name) => invoke(IPC.modelsPull, name),
    remove: (name) => invoke(IPC.modelsDelete, name),
    benchmark: (name) => invoke(IPC.modelsBenchmark, name),
    onPullProgress: (cb) => subscribe<PullProgress>(IPC.pullProgress, cb),
    onBenchmarkProgress: (cb) => subscribe<BenchmarkProgress>(IPC.benchmarkProgress, cb)
  },
  memory: {
    status: (id) => invoke(IPC.memoryStatus, id),
    rebuild: (id) => invoke(IPC.memoryRebuild, id)
  },
  knowledge: {
    sources: () => invoke(IPC.knowledgeSources),
    status: (id) => invoke(IPC.knowledgeStatus, id),
    addFiles: (id, paths) => invoke(IPC.knowledgeAddFiles, id, paths),
    pickFiles: (id) => invoke(IPC.knowledgePickFiles, id),
    remove: (id, documentId) => invoke(IPC.knowledgeRemove, id, documentId),
    reindex: (id, documentId) => invoke(IPC.knowledgeReindex, id, documentId),
    pin: (id, documentId, pinned) => invoke(IPC.knowledgePin, id, documentId, pinned),
    connect: (id, sourceId, config) => invoke(IPC.knowledgeConnect, id, sourceId, config),
    refresh: (id, connectionId) => invoke(IPC.knowledgeRefresh, id, connectionId),
    disconnect: (id, connectionId) => invoke(IPC.knowledgeDisconnect, id, connectionId),
    pickFolder: () => invoke(IPC.knowledgePickFolder),
    bases: () => invoke(IPC.knowledgeBases),
    createBase: (name) => invoke(IPC.knowledgeBaseCreate, name),
    updateBase: (baseId, patch) => invoke(IPC.knowledgeBaseUpdate, baseId, patch),
    removeBase: (baseId) => invoke(IPC.knowledgeBaseRemove, baseId),
    pickPack: () => invoke(IPC.knowledgePackPick),
    installPack: (path, allowUntrusted) => invoke(IPC.knowledgePackInstall, path, allowUntrusted),
    exportBase: (baseId) => invoke(IPC.knowledgeBaseExport, baseId),
    link: (id, baseId) => invoke(IPC.knowledgeLink, id, baseId),
    unlink: (id, baseId) => invoke(IPC.knowledgeUnlink, id, baseId),
    onProgress: (cb) => subscribe<KnowledgeProgress>(IPC.knowledgeProgress, cb),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  store: {
    catalog: () => invoke(IPC.storeCatalog),
    install: (id) => invoke(IPC.storeInstall, id),
    remove: (id) => invoke(IPC.storeRemove, id)
  },
  context: {
    calls: (id) => invoke(IPC.contextCalls, id),
    onCall: (cb) => subscribe<ContextCall>(IPC.contextCallAdded, cb)
  },
  ollamaEnv: {
    get: () => invoke(IPC.ollamaEnvGet),
    apply: (values) => invoke(IPC.ollamaEnvApply, values)
  },
  system: {
    locale: ipcRenderer.sendSync(IPC.systemLocale) as string,
    info: () => invoke(IPC.systemInfo)
  },
  conversations: {
    list: (query) => invoke(IPC.conversationsList, query),
    get: (id) => invoke(IPC.conversationsGet, id),
    create: (fromTemplateId) => invoke(IPC.conversationsCreate, fromTemplateId),
    update: (id, patch) => invoke(IPC.conversationsUpdate, id, patch),
    calibrate: (id) => invoke(IPC.conversationsCalibrate, id),
    summarize: (id) => invoke(IPC.conversationsSummarize, id),
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
    send: (id, text, options) => invoke(IPC.chatSend, id, text, options),
    regenerate: (id) => invoke(IPC.chatRegenerate, id),
    abort: (streamId) => invoke(IPC.chatAbort, streamId),
    onStream: (cb) => subscribe<StreamEvent>(IPC.chatStream, cb)
  },
  plans: {
    propose: (id, text, options) => invoke(IPC.plansPropose, id, text, options),
    regenerate: (id) => invoke(IPC.plansRegenerate, id),
    update: (planId, update) => invoke(IPC.plansUpdate, planId, update),
    execute: (planId) => invoke(IPC.plansExecute, planId)
  },
  window: {
    platform: process.platform,
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    onMaximizedChange: (cb) => subscribe<boolean>(IPC.windowMaximized, cb)
  },
  clipboard: {
    writeText: (text) => invoke(IPC.clipboardWrite, text)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  }
}

contextBridge.exposeInMainWorld('api', api)
