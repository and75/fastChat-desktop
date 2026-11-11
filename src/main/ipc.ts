import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  IPC,
  KV_CACHE_TYPES,
  type AppSettings,
  type BenchmarkProgress,
  type ModelSettingPatch,
  type PullProgress,
  type ConversationDetail,
  type ConversationListQuery,
  type ConversationPatch,
  type PlanUpdate,
  type Result,
  type SendOptions
} from '@shared/types'
import { normalizeSteps } from '@shared/prompt'
import { LANGUAGE_SETTINGS, resolveLocale, setLocale, t } from '@shared/i18n'
import type { SystemInfo } from '@shared/settings'
import { calibrationPatch, type CalibrateDeps } from './calibrate'
import { createChatService } from './chat'
import type { Db } from './db/client'
import {
  conversationFromTemplate,
  createConversation,
  createTemplateFromConversation,
  getConversation,
  getTemplate,
  getSettings,
  listConversations,
  listContextCalls,
  listModelSettings,
  removeModelSetting,
  saveModelSetting,
  listMessages,
  listPlans,
  listTemplates,
  removeConversation,
  removeTemplate,
  setSettings,
  updateConversation,
  updatePlan
} from './db/repo'
import { suggestedFileName, toJson, toMarkdown, type ExportFormat } from './export'
import { createOllamaClient, OllamaError, type OllamaClient } from './ollama'
import { createMemory } from './memory'
import { createEmbedder } from './embedder'
import { createKnowledge } from './knowledge'
import { createBuiltinRegistry } from './knowledge/sources'
import { electronCipher } from './knowledge/secrets'
import { PACK_EXTENSION } from './knowledge/pack'
import { TRUSTED_KEYS } from './knowledge/trust'
import { createContextLog } from './contextLog'
import { createStore } from './store'
import { createSummarizer } from './summary'
import { isLocalOllama, systemInfo } from './system'
import { runBenchmark } from './benchmark'
import { applyEnvWindows, envCommands, OLLAMA_ENV_VARS, readUserEnv, validateEnv, type EnvDeps, type OllamaEnvValues } from './ollamaEnv'

/** Lingua del sistema; FASTCHAT_LANG la forza (test end-to-end). */
export const systemLocale = (): string => process.env.FASTCHAT_LANG || app.getLocale()

export interface IpcDeps {
  db: Db
  ollama: OllamaClient
  getOllamaUrl(): string
  /** Aggiorna l'URL di Ollama usato dal client (tenuto in memoria nel main). */
  setOllamaUrl(url: string): void
}

function toMessage(err: unknown): string {
  if (err instanceof OllamaError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** Avvolge un handler: il renderer riceve sempre un Result, mai un'eccezione serializzata a metà. */
function handle<A extends unknown[], T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(event, ...(args as A)) }
    } catch (err) {
      return { ok: false, error: toMessage(err) }
    }
  })
}

function validOllamaUrl(url: unknown): string {
  let parsed: URL
  try {
    parsed = new URL(String(url).trim())
  } catch {
    throw new Error(t('err.badUrl'))
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(t('err.badUrlScheme'))
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !id) throw new Error(t('err.missingId'))
  return id
}

export function registerIpc({ db, ollama, getOllamaUrl, setOllamaUrl }: IpcDeps): void {
  const watched = new WeakSet<WebContents>()
  const system = async (): Promise<SystemInfo> => systemInfo(getOllamaUrl(), (await getSettings(db)).kvCacheType)
  const calibrate: CalibrateDeps = { ollama, system }
  // Monitor del contesto: ogni chiamata registrata arriva a tutte le finestre.
  const contextLog = createContextLog(db, (call) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(IPC.contextCallAdded, call)
  })
  const summarizer = createSummarizer({ db, ollama, contextLog })
  const embedder = createEmbedder({ db, ollama, contextLog })
  const memory = createMemory({ db, ollama, contextLog, embedder })
  const registry = createBuiltinRegistry()
  const knowledge = createKnowledge({
    db,
    embedder,
    registry,
    cipher: electronCipher(safeStorage),
    packsDir: join(app.getPath('userData'), 'packs'),
    trustedKeys: TRUSTED_KEYS,
    onProgress: (p) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(IPC.knowledgeProgress, p)
    }
  })
  const chat = createChatService({
    db,
    ollama,
    summarizer,
    memory,
    knowledge,
    embedder,
    contextLog,
    emit: (target, event) => {
      const wc = target as WebContents
      if (!wc.isDestroyed()) wc.send(IPC.chatStream, event)
    },
    onConversationUpdated: (target, conversation) => {
      const wc = target as WebContents
      if (!wc.isDestroyed()) wc.send(IPC.conversationUpdated, conversation)
    }
  })

  // Pacchetti integrati nell'app: installati o aggiornati all'avvio, in sottofondo.
  void knowledge.installBuiltin(join(app.getAppPath(), 'packs')).catch(() => undefined)

  /** Se la finestra si chiude a metà generazione, fermiamo i suoi stream (il parziale viene salvato). */
  const watch = (wc: WebContents): WebContents => {
    if (!watched.has(wc)) {
      watched.add(wc)
      wc.once('destroyed', () => chat.abortWhere((s) => s.target === wc))
    }
    return wc
  }

  // ---- modelli
  handle(IPC.modelsList, () => ollama.listModels())
  handle(IPC.modelsCapabilities, (_e, name: string) => ollama.showModel(requireId(name)))
  handle(IPC.modelsCheck, (_e, url: string) => createOllamaClient(() => validOllamaUrl(url)).listModels())
  handle(IPC.systemInfo, () => system())

  // ---- configurazione per modello (CPU/GPU), download, eliminazione, test
  handle(IPC.modelSettingsList, () => listModelSettings(db))
  handle(IPC.modelSettingsSet, (_e, model: string, patch: ModelSettingPatch) => {
    const clean: ModelSettingPatch = {}
    if (patch?.numGpu !== undefined) clean.numGpu = patch.numGpu
    if (patch?.dismissed !== undefined) clean.dismissed = patch.dismissed
    return saveModelSetting(db, requireId(model), clean)
  })

  const pulls = new Map<string, AbortController>()
  handle(IPC.modelsPull, async (e, name: string) => {
    const model = String(name ?? '').trim()
    if (!/^[\w.\-/:]+$/.test(model)) throw new Error(t('err.badModelName'))
    if (pulls.has(model)) throw new Error(t('err.pullInProgress'))
    const controller = new AbortController()
    pulls.set(model, controller)
    const send = (p: Omit<PullProgress, 'model'>): void => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.pullProgress, { model, ...p })
    }
    try {
      await ollama.pullModel(model, (p) => send({ ...p, done: false }), controller.signal)
      send({ status: 'success', completed: null, total: null, done: true })
      // Se era il modello di embedding che mancava, i documenti dei pacchetti in attesa si indicizzano ora.
      void knowledge.resumePending().catch(() => undefined)
    } catch (err) {
      send({ status: 'error', completed: null, total: null, done: true, error: toMessage(err) })
      throw err
    } finally {
      pulls.delete(model)
    }
  })

  handle(IPC.modelsDelete, async (_e, name: string) => {
    const model = requireId(name)
    await ollama.deleteModel(model)
    await removeModelSetting(db, model)
  })

  handle(IPC.modelsBenchmark, async (e, name: string) => {
    const model = requireId(name)
    const caps = await ollama.showModel(model).catch(() => null)
    const digest = (await ollama.listModels().catch(() => [])).find((m) => m.name === model)?.digest ?? null
    const result = await runBenchmark(ollama, model, caps, (step, steps, label) => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.benchmarkProgress, { model, step, steps, label } satisfies BenchmarkProgress)
    })
    return saveModelSetting(db, model, {
      numGpu: result.best,
      benchmark: result.runs,
      benchmarkedAt: Date.now(),
      gpuAvailable: result.gpuAvailable,
      digest,
      dismissed: false
    })
  })

  // ---- variabili d'ambiente di Ollama
  const envDeps: EnvDeps = {
    platform: process.platform,
    run: (file, args) =>
      new Promise((resolve, reject) =>
        execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
      ),
    spawnDetached: (file, args, env) => spawn(file, args, { detached: true, stdio: 'ignore', env, windowsHide: true }).unref(),
    exists: existsSync,
    localAppData: process.env.LOCALAPPDATA ?? '',
    baseEnv: process.env,
    waitUntilUp: async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (await ollama.listModels().then(() => true, () => false)) return true
      }
      return false
    }
  }

  handle(IPC.ollamaEnvGet, async () => {
    const canApply = process.platform === 'win32' && isLocalOllama(getOllamaUrl())
    const values: OllamaEnvValues = canApply ? await readUserEnv(envDeps).catch(() => ({})) : {}
    return { platform: process.platform, canApply, values, vars: OLLAMA_ENV_VARS }
  })

  handle(IPC.ollamaEnvApply, async (_e, values: OllamaEnvValues) => {
    const clean = validateEnv(values ?? {})
    if (!(process.platform === 'win32' && isLocalOllama(getOllamaUrl()))) {
      return { applied: false, restarted: false, commands: envCommands(process.platform, clean) }
    }
    chat.abortWhere(() => true)
    const { restarted } = await applyEnvWindows(envDeps, clean)
    ollama.clearCache()
    // La memoria suggerita usa lo stesso tipo di cache KV del server.
    const kv = clean.OLLAMA_KV_CACHE_TYPE
    if (kv !== undefined) await setSettings(db, { kvCacheType: (kv ?? 'f16') as AppSettings['kvCacheType'] })
    return { applied: true, restarted, commands: '' }
  })

  // ---- impostazioni
  // ---- finestra (agisce sulla finestra che ha fatto la richiesta)
  const winOf = (e: IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error(t('err.noWindow'))
    return win
  }
  handle(IPC.windowMinimize, (e) => winOf(e).minimize())
  handle(IPC.windowToggleMaximize, (e) => {
    const win = winOf(e)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle(IPC.windowClose, (e) => winOf(e).close())
  handle(IPC.windowIsMaximized, (e) => winOf(e).isMaximized())

  // ---- appunti
  handle(IPC.clipboardWrite, (_e, text: string) => {
    if (typeof text !== 'string') throw new Error(t('err.badText'))
    clipboard.writeText(text)
  })

  handle(IPC.settingsGet, () => getSettings(db))
  handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    if (patch.ollamaUrl !== undefined) patch.ollamaUrl = validOllamaUrl(patch.ollamaUrl)
    if (patch.embeddingModel !== undefined) {
      const name = String(patch.embeddingModel).trim()
      if (!/^[\w.\-/:]+$/.test(name)) throw new Error(t('err.badEmbeddingName'))
      patch.embeddingModel = name
    }
    if (patch.storeUrl !== undefined) {
      const url = String(patch.storeUrl).trim()
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error(t('err.store.badUrl'))
      patch.storeUrl = url.replace(/\/+$/, '')
    }
    if (patch.kvCacheType !== undefined && !KV_CACHE_TYPES.includes(patch.kvCacheType)) throw new Error(t('err.badKv'))
    if (patch.language !== undefined && !LANGUAGE_SETTINGS.includes(patch.language)) throw new Error(t('err.badLanguage'))
    const next = await setSettings(db, patch)
    if (patch.language !== undefined) setLocale(resolveLocale(next.language, systemLocale()))
    if (patch.ollamaUrl !== undefined) {
      setOllamaUrl(next.ollamaUrl)
      ollama.clearCache()
    }
    return next
  })

  // ---- conversazioni
  handle(IPC.conversationsList, (_e, query?: ConversationListQuery) => listConversations(db, query ?? {}))

  handle(IPC.conversationsGet, async (_e, id: string): Promise<ConversationDetail> => {
    let conversation = await getConversation(db, requireId(id))
    if (!conversation) throw new Error(t('err.convNotFound'))
    // Conversazioni non ancora calibrate (versioni precedenti, o Ollama assente alla creazione).
    const fill = await calibrationPatch(calibrate, conversation.model, conversation, true)
    if (Object.keys(fill).length) conversation = await updateConversation(db, conversation.id, fill)
    // Conversazioni già riassunte: la memoria si costruisce in sottofondo alla prima apertura.
    void memory.indexQuietly(conversation)
    // Documenti in attesa o indicizzati con un altro modello di embedding: si rifanno in sottofondo.
    void knowledge.ensureModel(conversation).catch(() => undefined)
    return {
      conversation,
      messages: await listMessages(db, conversation.id),
      plans: await listPlans(db, conversation.id)
    }
  })

  /** Modello per una nuova conversazione: il predefinito, altrimenti il primo installato (prima installazione). */
  const initialModel = async (): Promise<string> => {
    const { defaultModel } = await getSettings(db)
    if (defaultModel) return defaultModel
    try {
      return (await ollama.listModels())[0]?.name ?? ''
    } catch {
      return ''
    }
  }

  handle(IPC.conversationsCreate, async (_e, fromTemplateId?: string) => {
    const model = await initialModel()
    let init: ConversationPatch = { model }
    if (fromTemplateId) {
      const template = await getTemplate(db, requireId(fromTemplateId))
      if (!template) throw new Error(t('err.templateNotFound'))
      init = conversationFromTemplate(template, model)
    }
    // I parametri partono dai valori suggeriti per il modello; il template può fissarne alcuni (temperatura).
    const conv = await createConversation(db, init)
    const fill = await calibrationPatch(calibrate, conv.model, { ...conv, temperature: init.temperature ?? null }, true)
    // Le basi segnate «collega alle nuove conversazioni» (es. quelle predefinite dell'app) arrivano già collegate.
    await knowledge.linkDefaults(conv).catch(() => undefined)
    return Object.keys(fill).length ? updateConversation(db, conv.id, fill) : conv
  })

  // ---- memoria della conversazione
  const convOrThrow = async (id: string) => {
    const conv = await getConversation(db, requireId(id))
    if (!conv) throw new Error(t('err.convNotFound'))
    return conv
  }
  ipcMain.on(IPC.systemLocale, (e) => {
    e.returnValue = systemLocale()
  })
  handle(IPC.contextCalls, (_e, id: string) => listContextCalls(db, requireId(id)))
  handle(IPC.memoryStatus, async (_e, id: string) => memory.status(await convOrThrow(id)))
  handle(IPC.memoryRebuild, async (_e, id: string) => {
    const conv = await convOrThrow(id)
    try {
      await memory.rebuild(conv)
    } catch (err) {
      if (memory.isMissingModel(err)) throw new Error(t('err.embeddingMissing'))
      throw err
    }
    return memory.status(conv)
  })

  // ---- base di conoscenza
  handle(IPC.knowledgeSources, () => registry.describe())
  // Il primo argomento dei canali sui documenti è l'id di una conversazione (la sua base) o di una base della libreria.
  handle(IPC.knowledgeStatus, async (_e, id: string) => knowledge.status(await knowledge.owner(requireId(id))))
  const validPaths = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !p)) throw new Error(t('err.badText'))
    return raw as string[]
  }
  handle(IPC.knowledgeAddFiles, async (_e, id: string, paths: unknown) => knowledge.addFiles(await knowledge.owner(requireId(id)), validPaths(paths)))
  /** Dialog di scelta dei file, filtrato sulle estensioni dei plugin; poi aggiunta. Null se annullato. */
  handle(IPC.knowledgePickFiles, async (e, id: string) => {
    const owner = await knowledge.owner(requireId(id))
    const extensions = registry.extensions()
    const options: Electron.OpenDialogOptions = {
      title: t('knowledge.pickTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('knowledge.pickFilter'), extensions }]
    }
    // Per i test end-to-end: salta la finestra di dialogo e aggiunge i file indicati.
    const forced = process.env.FASTCHAT_KNOWLEDGE_FILES
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePaths } = forced
      ? { canceled: false, filePaths: forced.split(process.platform === 'win32' ? ';' : ':').filter(Boolean) }
      : win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    if (canceled || filePaths.length === 0) return null
    return knowledge.addFiles(owner, filePaths)
  })
  handle(IPC.knowledgeRemove, async (_e, id: string, documentId: string) => {
    const owner = await knowledge.owner(requireId(id))
    await knowledge.remove(owner, requireId(documentId))
    return knowledge.status(owner)
  })
  handle(IPC.knowledgeReindex, async (_e, id: string, documentId: string) => knowledge.reindex(await knowledge.owner(requireId(id)), requireId(documentId)))
  handle(IPC.knowledgePin, async (_e, id: string, documentId: string, pinned: unknown) => knowledge.setPinned(await knowledge.owner(requireId(id)), requireId(documentId), pinned === true))
  /** Sorgenti collegate: collega (con la configurazione dei campi del plugin), aggiorna, scollega. */
  handle(IPC.knowledgeConnect, async (_e, id: string, sourceId: string, config: unknown) => {
    const owner = await knowledge.owner(requireId(id))
    const clean = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
    return knowledge.connect(owner, requireId(sourceId), clean)
  })
  handle(IPC.knowledgeRefresh, async (_e, id: string, connectionId: string) => knowledge.refresh(await knowledge.owner(requireId(id)), requireId(connectionId)))
  handle(IPC.knowledgeDisconnect, async (_e, id: string, connectionId: string) => {
    const owner = await knowledge.owner(requireId(id))
    await knowledge.disconnect(owner, requireId(connectionId))
    return knowledge.status(owner)
  })
  // Libreria delle basi e collegamenti con le conversazioni.
  handle(IPC.knowledgeBases, () => knowledge.listBases())
  handle(IPC.knowledgeBaseCreate, (_e, name: unknown) => knowledge.createBase(typeof name === 'string' ? name : ''))
  handle(IPC.knowledgeBaseUpdate, (_e, id: string, patch: { name?: unknown; description?: unknown; autoLink?: unknown }) =>
    knowledge.renameBase(requireId(id), {
      ...(typeof patch?.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch?.description === 'string' ? { description: patch.description } : {}),
      ...(typeof patch?.autoLink === 'boolean' ? { autoLink: patch.autoLink } : {})
    })
  )
  handle(IPC.knowledgeBaseRemove, async (_e, id: string) => {
    await knowledge.removeBase(requireId(id))
    return knowledge.listBases()
  })
  /** Sceglie un pacchetto e lo legge senza installarlo: il renderer mostra cosa contiene e chiede conferma. */
  handle(IPC.knowledgePackPick, async (e) => {
    const forced = process.env.FASTCHAT_PACK_FILE
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = { title: t('pack.pickTitle'), properties: ['openFile'], filters: [{ name: t('pack.filter'), extensions: [PACK_EXTENSION] }] }
    const { canceled, filePaths } = forced ? { canceled: false, filePaths: [forced] } : win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return canceled || !filePaths[0] ? null : knowledge.inspectPack(filePaths[0])
  })
  handle(IPC.knowledgePackInstall, async (_e, path: unknown, allowUntrusted: unknown) => {
    if (typeof path !== 'string' || !path) throw new Error(t('err.badText'))
    await knowledge.installPack(path, { allowUntrusted: allowUntrusted === true })
    return knowledge.listBases()
  })
  /** Esporta una base come pacchetto: chiede dove salvare; restituisce il percorso, o null se annullato. */
  handle(IPC.knowledgeBaseExport, async (e, id: string) => {
    const { data, fileName } = await knowledge.exportBase(requireId(id))
    const forced = process.env.FASTCHAT_PACK_EXPORT
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: t('pack.exportTitle'), defaultPath: fileName, filters: [{ name: t('pack.filter'), extensions: [PACK_EXTENSION] }] }
    const { canceled, filePath } = forced ? { canceled: false, filePath: forced } : win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await writeFile(filePath, data)
    return filePath
  })
  // Store: catalogo (dal repository o quello incluso nell'app), installazione e rimozione.
  const store = createStore({
    knowledge,
    getUrl: async () => (await getSettings(db)).storeUrl,
    localDir: join(app.getAppPath(), 'store'),
    downloadsDir: join(app.getPath('userData'), 'downloads')
  })
  handle(IPC.storeCatalog, () => store.catalog())
  handle(IPC.storeInstall, (_e, id: string) => store.install(requireId(id)))
  handle(IPC.storeRemove, (_e, id: string) => store.remove(requireId(id)))
  handle(IPC.knowledgeLink, async (_e, id: string, baseId: string) => {
    const conv = await convOrThrow(id)
    await knowledge.link(conv, requireId(baseId))
    return knowledge.status(conv)
  })
  handle(IPC.knowledgeUnlink, async (_e, id: string, baseId: string) => {
    const conv = await convOrThrow(id)
    await knowledge.unlink(conv, requireId(baseId))
    return knowledge.status(conv)
  })
  /** Dialog di scelta di una cartella (campo `folder` di una sorgente collegata). Null se annullato. */
  handle(IPC.knowledgePickFolder, async (e) => {
    const forced = process.env.FASTCHAT_KNOWLEDGE_FOLDER
    if (forced) return forced
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = { title: t('knowledge.pickFolderTitle'), properties: ['openDirectory'] }
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return canceled || !filePaths[0] ? null : filePaths[0]
  })

  /** Riporta temperatura, top_p e num_ctx ai valori suggeriti per il modello e la macchina. */
  handle(IPC.conversationsCalibrate, async (_e, id: string) => {
    const conv = await getConversation(db, requireId(id))
    if (!conv) throw new Error(t('err.convNotFound'))
    const fill = await calibrationPatch(calibrate, conv.model, conv, false)
    if (!Object.keys(fill).length) throw new Error(t('err.calibrateNoOllama'))
    return updateConversation(db, conv.id, fill)
  })

  handle(IPC.conversationsExport, async (e, id: string, format: ExportFormat): Promise<string | null> => {
    if (format !== 'md' && format !== 'json') throw new Error(t('err.badFormat'))
    const conversation = await getConversation(db, requireId(id))
    if (!conversation) throw new Error(t('err.convNotFound'))
    const data = {
      conversation,
      messages: await listMessages(db, conversation.id),
      plans: await listPlans(db, conversation.id),
      documents: (await knowledge.documentsOf(conversation.id)).docs
    }
    const options = {
      title: t('export.dialogTitle'),
      defaultPath: suggestedFileName(conversation.title, format),
      filters:
        format === 'md'
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
    }
    // Per i test end-to-end: salta la finestra di dialogo e scrive nel percorso indicato.
    const forced = process.env.FASTCHAT_EXPORT_PATH
    const win = BrowserWindow.fromWebContents(e.sender)
    const { canceled, filePath } = forced
      ? { canceled: false, filePath: `${forced}.${format}` }
      : win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await writeFile(filePath, format === 'md' ? toMarkdown(data) : toJson(data), 'utf8')
    return filePath
  })

  /** Riassunto manuale: riassume i messaggi più vecchi anche sotto la soglia. */
  handle(IPC.conversationsSummarize, async (_e, id: string) => {
    const r = await summarizer.summarize(requireId(id), true)
    if (r.outcome === 'updated' && r.conversation) {
      void memory.indexQuietly(r.conversation)
      return r.conversation
    }
    if (r.outcome === 'not-needed') throw new Error(t('err.nothingToSummarize'))
    throw new Error(t('err.summaryFailed'))
  })

  handle(IPC.conversationsUpdate, async (_e, id: string, patch: ConversationPatch) => {
    const convId = requireId(id)
    patch = patch ?? {}
    const current = await getConversation(db, convId)
    if (current && typeof patch.model === 'string' && current.model !== patch.model) {
      // Cambio modello: i parametri ripartono dai valori suggeriti per il nuovo modello (salvo quelli nel patch).
      const fill = await calibrationPatch(calibrate, patch.model, {}, false)
      patch = { ...fill, ...patch }
    }
    return updateConversation(db, convId, patch)
  })

  handle(IPC.conversationsRemove, async (_e, id: string) => {
    const convId = requireId(id)
    chat.abortWhere((s) => s.conversationId === convId)
    await removeConversation(db, convId)
  })

  // ---- chat
  /** Opzioni dell'invio dal renderer: solo i campi noti, con il tipo giusto. */
  const sendOptions = (raw: unknown): SendOptions => {
    const out: SendOptions = {}
    if (raw && typeof raw === 'object' && typeof (raw as SendOptions).knowledge === 'boolean') out.knowledge = (raw as SendOptions).knowledge
    return out
  }
  handle(IPC.chatSend, (e, id: string, text: string, options?: unknown) => {
    if (typeof text !== 'string') throw new Error(t('err.badMessage'))
    return chat.send(watch(e.sender), requireId(id), text, sendOptions(options))
  })
  handle(IPC.chatRegenerate, (e, id: string) => chat.regenerate(watch(e.sender), requireId(id)))
  handle(IPC.chatAbort, (_e, streamId: string) => chat.abort(requireId(streamId)))

  // ---- template del brief
  handle(IPC.templatesList, () => listTemplates(db))
  handle(IPC.templatesCreate, (_e, conversationId: string, name: string) => {
    if (typeof name !== 'string') throw new Error(t('err.badName'))
    return createTemplateFromConversation(db, requireId(conversationId), name)
  })
  handle(IPC.templatesRemove, (_e, id: string) => removeTemplate(db, requireId(id)))

  // ---- plan mode
  handle(IPC.plansPropose, (e, id: string, text: string, options?: unknown) => {
    if (typeof text !== 'string') throw new Error(t('err.badMessage'))
    return chat.proposePlan(watch(e.sender), requireId(id), text, sendOptions(options))
  })
  handle(IPC.plansRegenerate, (e, conversationId: string) => chat.regeneratePlan(watch(e.sender), requireId(conversationId)))
  handle(IPC.plansUpdate, (_e, planId: string, update: PlanUpdate) => {
    const patch: PlanUpdate = {}
    if (update?.steps !== undefined) patch.steps = normalizeSteps(update.steps)
    if (update?.status !== undefined) {
      if (!['proposed', 'approved', 'rejected', 'executed'].includes(update.status)) throw new Error(t('err.badState'))
      // 'executed' lo imposta solo il main, a esecuzione completata.
      if (update.status === 'executed') throw new Error(t('err.usePlansExecute'))
      patch.status = update.status
    }
    return updatePlan(db, requireId(planId), patch)
  })
  handle(IPC.plansExecute, (e, planId: string) => chat.executePlan(watch(e.sender), requireId(planId)))
}
