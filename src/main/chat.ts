import { randomUUID } from 'node:crypto'
import { buildSystemPrompt, DEFAULT_HISTORY_LIMITS, selectHistory } from '@shared/prompt'
import type { Conversation, Message, SendResult, StreamEvent } from '@shared/types'
import type { Db } from './db/client'
import { addMessage, getConversation, listMessages, removeMessage } from './db/repo'
import type { ChatMessage, ChatOptions, ChatRequest, OllamaClient } from './ollama'

/** Destinatario degli eventi di stream (in produzione: il WebContents che ha fatto la richiesta). */
export type StreamTarget = object

export interface ChatServiceDeps {
  db: Db
  ollama: OllamaClient
  emit(target: StreamTarget, event: StreamEvent): void
}

interface ActiveStream {
  conversationId: string
  target: StreamTarget
  controller: AbortController
  done: Promise<void>
}

/** Opzioni del modello dalla conversazione: solo i valori impostati. */
export function buildOptions(conv: Conversation): ChatOptions {
  const options: ChatOptions = { temperature: conv.temperature }
  if (conv.topP != null) options.top_p = conv.topP
  if (conv.numCtx != null) options.num_ctx = conv.numCtx
  if (conv.seed != null) options.seed = conv.seed
  return options
}

/** Messaggi da inviare: system prompt dal brief (mai troncato) + coda dello storico che sta nel contesto. */
export function buildChatMessages(conv: Conversation, history: Message[]): ChatMessage[] {
  const system = buildSystemPrompt(conv)
  const picked = selectHistory(history, system, {
    ...DEFAULT_HISTORY_LIMITS,
    maxTokens: conv.numCtx ?? DEFAULT_HISTORY_LIMITS.maxTokens
  })
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : []
  for (const m of picked) out.push({ role: m.role, content: m.content })
  return out
}

export function createChatService({ db, ollama, emit }: ChatServiceDeps) {
  const streams = new Map<string, ActiveStream>()

  const isBusy = (conversationId: string): boolean =>
    [...streams.values()].some((s) => s.conversationId === conversationId)

  async function loadConversation(id: string): Promise<Conversation> {
    const conv = await getConversation(db, id)
    if (!conv) throw new Error('Conversazione non trovata')
    if (!conv.model) throw new Error('Seleziona un modello per questa conversazione')
    if (isBusy(id)) throw new Error('Una risposta è già in corso per questa conversazione')
    return conv
  }

  /** Il parametro `think` va inviato solo ai modelli che lo supportano, altrimenti Ollama risponde con un errore. */
  async function thinkParam(conv: Conversation): Promise<boolean | undefined> {
    try {
      const caps = await ollama.showModel(conv.model)
      return caps.thinking ? conv.think : undefined
    } catch {
      return undefined
    }
  }

  async function startStream(target: StreamTarget, conv: Conversation): Promise<string> {
    const streamId = randomUUID()
    const controller = new AbortController()
    const history = await listMessages(db, conv.id)
    const request: ChatRequest = {
      model: conv.model,
      messages: buildChatMessages(conv, history),
      options: buildOptions(conv)
    }
    const think = await thinkParam(conv)
    if (think !== undefined) request.think = think

    const base = { streamId, conversationId: conv.id }
    const run = async (): Promise<void> => {
      try {
        const result = await ollama.chatStream(
          request,
          {
            onThinking: (delta) => emit(target, { ...base, type: 'thinking', delta }),
            onContent: (delta) => emit(target, { ...base, type: 'content', delta })
          },
          controller.signal
        )
        let message: Message | undefined
        if (result.content || result.thinking) {
          message = await addMessage(db, {
            conversationId: conv.id,
            role: 'assistant',
            content: result.content,
            thinking: result.thinking,
            model: conv.model,
            evalCount: result.evalCount,
            durationMs: result.durationMs
          })
        }
        emit(target, { ...base, type: 'done', message, aborted: result.aborted })
      } catch (err) {
        emit(target, { ...base, type: 'error', error: err instanceof Error ? err.message : String(err) })
      } finally {
        streams.delete(streamId)
      }
    }

    const active: ActiveStream = { conversationId: conv.id, target, controller, done: Promise.resolve() }
    streams.set(streamId, active)
    // Parte al giro successivo: il renderer riceve prima lo streamId, poi gli eventi.
    active.done = new Promise<void>((resolve) => setImmediate(resolve)).then(run)
    return streamId
  }

  return {
    async send(target: StreamTarget, conversationId: string, text: string): Promise<SendResult> {
      const content = text.trim()
      if (!content) throw new Error('Messaggio vuoto')
      const conv = await loadConversation(conversationId)
      const userMessage = await addMessage(db, { conversationId, role: 'user', content })
      const streamId = await startStream(target, conv)
      return { streamId, userMessage }
    },

    /** Rigenera l'ultima risposta: elimina l'ultimo messaggio dell'assistente (se c'è) e richiede di nuovo. */
    async regenerate(target: StreamTarget, conversationId: string): Promise<SendResult> {
      const conv = await loadConversation(conversationId)
      const history = await listMessages(db, conversationId)
      const last = history.at(-1)
      if (!last) throw new Error('Niente da rigenerare')
      if (last.role === 'assistant') await removeMessage(db, last.id)
      if (!history.some((m) => m.role === 'user')) throw new Error('Niente da rigenerare')
      return { streamId: await startStream(target, conv) }
    },

    abort(streamId: string): boolean {
      const s = streams.get(streamId)
      if (!s) return false
      s.controller.abort()
      return true
    },

    /** Interrompe gli stream di un destinatario (es. finestra chiusa) o di una conversazione eliminata. */
    abortWhere(pred: (s: { target: StreamTarget; conversationId: string }) => boolean): void {
      for (const s of streams.values()) if (pred(s)) s.controller.abort()
    },

    /** Per i test: attende la fine di uno stream. */
    async wait(streamId: string): Promise<void> {
      await streams.get(streamId)?.done
    }
  }
}

export type ChatService = ReturnType<typeof createChatService>
