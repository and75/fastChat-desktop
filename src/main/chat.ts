import { randomUUID } from 'node:crypto'
import {
  buildExecutePrompt,
  buildPlanPrompt,
  buildSystemPrompt,
  DEFAULT_HISTORY_LIMITS,
  parsePlan,
  PLAN_SCHEMA,
  selectHistory
} from '@shared/prompt'
import type { Conversation, Message, Plan, SendResult, StreamEvent, StreamKind } from '@shared/types'
import type { Db } from './db/client'
import {
  addMessage,
  createPlan,
  planToFollow,
  getConversation,
  getPlan,
  listMessages,
  listPlans,
  removeMessage,
  removePlan,
  updatePlan
} from './db/repo'
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

/** Cosa sta generando lo stream. */
type Mode =
  | { kind: 'chat' }
  /** Risposta che segue un piano approvato. */
  | { kind: 'execute'; plan: Plan }
  /** Proposta di un piano per il messaggio utente indicato. */
  | { kind: 'plan'; userMessageId: string }

/** Opzioni del modello dalla conversazione: solo i valori impostati. */
export function buildOptions(conv: Conversation): ChatOptions {
  const options: ChatOptions = { temperature: conv.temperature }
  if (conv.topP != null) options.top_p = conv.topP
  if (conv.numCtx != null) options.num_ctx = conv.numCtx
  if (conv.seed != null) options.seed = conv.seed
  return options
}

/**
 * Messaggi da inviare: system prompt (di default il brief; mai troncato) + coda dello storico che sta nel contesto.
 */
export function buildChatMessages(
  conv: Conversation,
  history: Message[],
  system: string = buildSystemPrompt(conv)
): ChatMessage[] {
  const picked = selectHistory(history, system, {
    ...DEFAULT_HISTORY_LIMITS,
    maxTokens: conv.numCtx ?? DEFAULT_HISTORY_LIMITS.maxTokens
  })
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : []
  for (const m of picked) out.push({ role: m.role, content: m.content })
  return out
}

function systemFor(conv: Conversation, mode: Mode): string {
  switch (mode.kind) {
    case 'plan':
      return buildPlanPrompt(conv)
    case 'execute':
      return buildExecutePrompt(conv, mode.plan.steps)
    default:
      return buildSystemPrompt(conv)
  }
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

  /** Il piano deve riferirsi all'ultimo messaggio della conversazione, ancora senza risposta. */
  async function assertPlanIsCurrent(plan: Plan): Promise<void> {
    const last = (await listMessages(db, plan.conversationId)).at(-1)
    if (!last || last.id !== plan.userMessageId) {
      throw new Error('Il piano non riguarda più l\'ultimo messaggio della conversazione')
    }
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

  /** Conclude uno stream: salva ciò che serve e costruisce l'evento 'done'. */
  async function finish(
    conv: Conversation,
    mode: Mode,
    result: { content: string; thinking: string; evalCount: number | null; durationMs: number | null; aborted: boolean }
  ): Promise<Partial<StreamEvent>> {
    if (mode.kind === 'plan') {
      if (result.aborted) return { aborted: true }
      const steps = parsePlan(result.content)
      const plan = await createPlan(db, { conversationId: conv.id, userMessageId: mode.userMessageId, steps })
      return { plan }
    }

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
    const out: Partial<StreamEvent> = { message, aborted: result.aborted }
    if (mode.kind === 'execute' && message && mode.plan.status !== 'executed') {
      out.executedPlan = await updatePlan(db, mode.plan.id, { status: 'executed' })
    }
    return out
  }

  async function startStream(target: StreamTarget, conv: Conversation, mode: Mode): Promise<string> {
    const streamId = randomUUID()
    const controller = new AbortController()
    const history = await listMessages(db, conv.id)
    const request: ChatRequest = {
      model: conv.model,
      messages: buildChatMessages(conv, history, systemFor(conv, mode)),
      options: buildOptions(conv)
    }
    if (mode.kind === 'plan') request.format = PLAN_SCHEMA as unknown as Record<string, unknown>
    const think = await thinkParam(conv)
    if (think !== undefined) request.think = think

    const kind: StreamKind = mode.kind === 'plan' ? 'plan' : 'chat'
    const base = { streamId, conversationId: conv.id, kind }
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
        emit(target, { ...base, type: 'done', ...(await finish(conv, mode, result)) })
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

  async function addUserMessage(conversationId: string, text: string): Promise<Message> {
    const content = text.trim()
    if (!content) throw new Error('Messaggio vuoto')
    return addMessage(db, { conversationId, role: 'user', content })
  }

  async function loadPlan(planId: string): Promise<{ plan: Plan; conv: Conversation }> {
    const plan = await getPlan(db, planId)
    if (!plan) throw new Error('Piano non trovato')
    return { plan, conv: await loadConversation(plan.conversationId) }
  }

  return {
    async send(target: StreamTarget, conversationId: string, text: string): Promise<SendResult> {
      if (!text.trim()) throw new Error('Messaggio vuoto')
      const conv = await loadConversation(conversationId)
      const userMessage = await addUserMessage(conversationId, text)
      return { streamId: await startStream(target, conv, { kind: 'chat' }), userMessage }
    },

    /**
     * Rigenera l'ultima risposta: elimina l'ultimo messaggio dell'assistente (se c'è) e richiede di nuovo.
     * Se c'è un piano approvato o eseguito per l'ultima domanda, la nuova risposta lo segue.
     */
    async regenerate(target: StreamTarget, conversationId: string): Promise<SendResult> {
      const conv = await loadConversation(conversationId)
      const history = await listMessages(db, conversationId)
      const last = history.at(-1)
      if (!last) throw new Error('Niente da rigenerare')
      if (last.role === 'assistant') await removeMessage(db, last.id)
      const lastUser = history.findLast((m) => m.role === 'user')
      if (!lastUser) throw new Error('Niente da rigenerare')
      const plan = await planToFollow(db, lastUser.id)
      const mode: Mode = plan ? { kind: 'execute', plan } : { kind: 'chat' }
      return { streamId: await startStream(target, conv, mode) }
    },

    /** Plan mode, fase 1: salva il messaggio e chiede al modello un piano (JSON vincolato da schema). */
    async proposePlan(target: StreamTarget, conversationId: string, text: string): Promise<SendResult> {
      if (!text.trim()) throw new Error('Messaggio vuoto')
      const conv = await loadConversation(conversationId)
      const userMessage = await addUserMessage(conversationId, text)
      return { streamId: await startStream(target, conv, { kind: 'plan', userMessageId: userMessage.id }), userMessage }
    },

    /**
     * Chiede un nuovo piano per l'ultimo messaggio utente (ancora senza risposta), scartando i piani
     * non eseguiti. Copre sia "Rigenera" sulla checklist sia "Riprova" dopo un errore.
     */
    async regeneratePlan(target: StreamTarget, conversationId: string): Promise<SendResult> {
      const conv = await loadConversation(conversationId)
      const last = (await listMessages(db, conversationId)).at(-1)
      if (!last || last.role !== 'user') throw new Error('Nessun messaggio in attesa di un piano')
      for (const p of await listPlans(db, conversationId)) {
        if (p.userMessageId === last.id && p.status !== 'executed') await removePlan(db, p.id)
      }
      return { streamId: await startStream(target, conv, { kind: 'plan', userMessageId: last.id }) }
    },

    /** Plan mode, fase 2: approva il piano (se serve) e genera la risposta seguendolo. */
    async executePlan(target: StreamTarget, planId: string): Promise<SendResult> {
      const { plan, conv } = await loadPlan(planId)
      if (plan.status !== 'proposed' && plan.status !== 'approved') throw new Error('Questo piano non si può eseguire')
      await assertPlanIsCurrent(plan)
      const approved = await updatePlan(db, plan.id, { status: 'approved' })
      return { streamId: await startStream(target, conv, { kind: 'execute', plan: approved }) }
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
