import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  IPC,
  type AppSettings,
  type ConversationDetail,
  type ConversationListQuery,
  type ConversationPatch,
  type Result
} from '@shared/types'
import { createChatService } from './chat'
import type { Db } from './db/client'
import {
  createConversation,
  getConversation,
  getSettings,
  listConversations,
  listMessages,
  removeConversation,
  setSettings,
  updateConversation
} from './db/repo'
import { OllamaError, type OllamaClient } from './ollama'

export interface IpcDeps {
  db: Db
  ollama: OllamaClient
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

const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !id) throw new Error('Id mancante')
  return id
}

export function registerIpc({ db, ollama, setOllamaUrl }: IpcDeps): void {
  const watched = new WeakSet<WebContents>()
  const chat = createChatService({
    db,
    ollama,
    emit: (target, event) => {
      const wc = target as WebContents
      if (!wc.isDestroyed()) wc.send(IPC.chatStream, event)
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

  // ---- impostazioni
  handle(IPC.settingsGet, () => getSettings(db))
  handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    if (patch.ollamaUrl !== undefined) {
      const parsed = new URL(patch.ollamaUrl) // lancia se non valido
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL di Ollama non valido')
    }
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
    const conversation = await getConversation(db, requireId(id))
    if (!conversation) throw new Error('Conversazione non trovata')
    return { conversation, messages: await listMessages(db, conversation.id) }
  })

  handle(IPC.conversationsCreate, async () => {
    const { defaultModel } = await getSettings(db)
    return createConversation(db, { model: defaultModel ?? '' })
  })

  handle(IPC.conversationsUpdate, (_e, id: string, patch: ConversationPatch) =>
    updateConversation(db, requireId(id), patch ?? {})
  )

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
}
