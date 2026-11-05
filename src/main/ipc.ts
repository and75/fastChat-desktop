import { writeFile } from 'node:fs/promises'
import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  IPC,
  type AppSettings,
  type ConversationDetail,
  type ConversationListQuery,
  type ConversationPatch,
  type PlanUpdate,
  type Result
} from '@shared/types'
import { normalizeSteps } from '@shared/prompt'
import { followNumPredict } from '@shared/settings'
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
import { systemInfo } from './system'

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
    throw new Error('URL di Ollama non valido')
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL di Ollama non valido: usa http:// o https://')
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !id) throw new Error('Id mancante')
  return id
}

export function registerIpc({ db, ollama, getOllamaUrl, setOllamaUrl }: IpcDeps): void {
  const watched = new WeakSet<WebContents>()
  const calibrate: CalibrateDeps = { ollama, system: () => systemInfo(getOllamaUrl()) }
  const chat = createChatService({
    db,
    ollama,
    emit: (target, event) => {
      const wc = target as WebContents
      if (!wc.isDestroyed()) wc.send(IPC.chatStream, event)
    },
    onConversationUpdated: (target, conversation) => {
      const wc = target as WebContents
      if (!wc.isDestroyed()) wc.send(IPC.conversationUpdated, conversation)
    }
  })

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
  handle(IPC.systemInfo, () => systemInfo(getOllamaUrl()))

  // ---- impostazioni
  // ---- finestra (agisce sulla finestra che ha fatto la richiesta)
  const winOf = (e: IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('Finestra non trovata')
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
    if (typeof text !== 'string') throw new Error('Testo non valido')
    clipboard.writeText(text)
  })

  handle(IPC.settingsGet, () => getSettings(db))
  handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    if (patch.ollamaUrl !== undefined) patch.ollamaUrl = validOllamaUrl(patch.ollamaUrl)
    const next = await setSettings(db, patch)
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
    if (!conversation) throw new Error('Conversazione non trovata')
    // Conversazioni non ancora calibrate (versioni precedenti, o Ollama assente alla creazione).
    const fill = await calibrationPatch(calibrate, conversation.model, conversation, true)
    if (Object.keys(fill).length) conversation = await updateConversation(db, conversation.id, fill)
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
      if (!template) throw new Error('Template non trovato')
      init = conversationFromTemplate(template, model)
    }
    // I parametri partono dai valori suggeriti per il modello; il template può fissarne alcuni (temperatura).
    const conv = await createConversation(db, init)
    const fill = await calibrationPatch(calibrate, conv.model, { ...conv, temperature: init.temperature ?? null, numCtx: null }, true)
    return Object.keys(fill).length ? updateConversation(db, conv.id, fill) : conv
  })

  /** Riporta temperatura, top_p e num_ctx ai valori suggeriti per il modello e la macchina. */
  handle(IPC.conversationsCalibrate, async (_e, id: string) => {
    const conv = await getConversation(db, requireId(id))
    if (!conv) throw new Error('Conversazione non trovata')
    const fill = await calibrationPatch(calibrate, conv.model, conv, false)
    if (!Object.keys(fill).length) throw new Error('Ollama non risponde: impossibile calcolare i valori suggeriti')
    return updateConversation(db, conv.id, fill)
  })

  handle(IPC.conversationsExport, async (e, id: string, format: ExportFormat): Promise<string | null> => {
    if (format !== 'md' && format !== 'json') throw new Error('Formato non supportato')
    const conversation = await getConversation(db, requireId(id))
    if (!conversation) throw new Error('Conversazione non trovata')
    const data = {
      conversation,
      messages: await listMessages(db, conversation.id),
      plans: await listPlans(db, conversation.id)
    }
    const options = {
      title: 'Esporta conversazione',
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

  handle(IPC.conversationsUpdate, async (_e, id: string, patch: ConversationPatch) => {
    const convId = requireId(id)
    patch = patch ?? {}
    const current = await getConversation(db, convId)
    if (current && typeof patch.model === 'string' && current.model !== patch.model) {
      // Cambio modello: i parametri ripartono dai valori suggeriti per il nuovo modello (salvo quelli nel patch).
      const fill = await calibrationPatch(calibrate, patch.model, { think: patch.think ?? current.think }, false)
      patch = { ...fill, ...patch }
    } else if (current && patch.numPredict === undefined && (patch.numCtx !== undefined || patch.think !== undefined)) {
      // Memoria o ragionamento cambiati: la lunghezza della risposta, se era quella suggerita, segue.
      const caps = await ollama.showModel(current.model).catch(() => null)
      const after = { numCtx: patch.numCtx ?? current.numCtx, think: patch.think ?? current.think }
      const next = followNumPredict(current, after, caps)
      if (next != null) patch = { ...patch, numPredict: next }
    }
    return updateConversation(db, convId, patch)
  })

  handle(IPC.conversationsRemove, async (_e, id: string) => {
    const convId = requireId(id)
    chat.abortWhere((s) => s.conversationId === convId)
    await removeConversation(db, convId)
  })

  // ---- chat
  handle(IPC.chatSend, (e, id: string, text: string) => {
    if (typeof text !== 'string') throw new Error('Messaggio non valido')
    return chat.send(watch(e.sender), requireId(id), text)
  })
  handle(IPC.chatRegenerate, (e, id: string) => chat.regenerate(watch(e.sender), requireId(id)))
  handle(IPC.chatAbort, (_e, streamId: string) => chat.abort(requireId(streamId)))

  // ---- template del brief
  handle(IPC.templatesList, () => listTemplates(db))
  handle(IPC.templatesCreate, (_e, conversationId: string, name: string) => {
    if (typeof name !== 'string') throw new Error('Nome non valido')
    return createTemplateFromConversation(db, requireId(conversationId), name)
  })
  handle(IPC.templatesRemove, (_e, id: string) => removeTemplate(db, requireId(id)))

  // ---- plan mode
  handle(IPC.plansPropose, (e, id: string, text: string) => {
    if (typeof text !== 'string') throw new Error('Messaggio non valido')
    return chat.proposePlan(watch(e.sender), requireId(id), text)
  })
  handle(IPC.plansRegenerate, (e, conversationId: string) => chat.regeneratePlan(watch(e.sender), requireId(conversationId)))
  handle(IPC.plansUpdate, (_e, planId: string, update: PlanUpdate) => {
    const patch: PlanUpdate = {}
    if (update?.steps !== undefined) patch.steps = normalizeSteps(update.steps)
    if (update?.status !== undefined) {
      if (!['proposed', 'approved', 'rejected', 'executed'].includes(update.status)) throw new Error('Stato non valido')
      // 'executed' lo imposta solo il main, a esecuzione completata.
      if (update.status === 'executed') throw new Error('Usa plans.execute per eseguire un piano')
      patch.status = update.status
    }
    return updatePlan(db, requireId(planId), patch)
  })
  handle(IPC.plansExecute, (e, planId: string) => chat.executePlan(watch(e.sender), requireId(planId)))
}
