import { randomUUID } from 'node:crypto'
import {
  buildExecutePrompt,
  buildPlanPrompt,
  buildStyleSection,
  buildSystemPrompt,
  charsPerToken,
  DEFAULT_HISTORY_LIMITS,
  estimateTokens,
  historyAfter,
  parsePlan,
  PLAN_SCHEMA,
  selectHistory,
  withSummary
} from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import { DEFAULT_TITLE, type Conversation, type DoneReason, type MemoryRef, type ModelCapabilities, type Message, type Plan, type SendResult, type StreamEvent, type StreamKind } from '@shared/types'
import type { Db } from './db/client'
import {
  addMessage,
  createPlan,
  planToFollow,
  getConversation,
  getModelSetting,
  getPlan,
  listMessages,
  listPlans,
  removeMessage,
  removePlan,
  updateConversation,
  updatePlan
} from './db/repo'
import { chatParts } from '@shared/context'
import type { ContextPart } from '@shared/types'
import { callInput, type CallStart, type ContextLog } from './contextLog'
import type { ChatMessage, ChatOptions, ChatRequest, OllamaClient } from './ollama'
import { memoryBudget, type Memory, type Recall } from './memory'
import type { Summarizer } from './summary'

/** Destinatario degli eventi di stream (in produzione: il WebContents che ha fatto la richiesta). */
export type StreamTarget = object

export interface ChatServiceDeps {
  db: Db
  ollama: OllamaClient
  emit(target: StreamTarget, event: StreamEvent): void
  /** Notifica una conversazione modificata dal main (es. titolo generato, riassunto aggiornato). */
  onConversationUpdated?(target: StreamTarget, conversation: Conversation): void
  /** Riassunto automatico, eseguito dopo ogni risposta. */
  summarizer?: Summarizer
  /** Memoria della conversazione (RAG sui messaggi riassunti). */
  memory?: Memory
  /** Monitor del contesto: registra ogni chiamata a Ollama. */
  contextLog?: ContextLog
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

/**
 * Opzioni del modello: i valori effettivi (scelti, consigliati dal modello o predefiniti di Ollama),
 * sempre espliciti, così Ollama usa esattamente ciò che l'app mostra e su cui dimensiona lo storico.
 * Il seed resta assente quando è "casuale".
 */
export function buildOptions(conv: Conversation, caps: ModelCapabilities | null = null, numGpu: number | null = null): ChatOptions {
  const s = resolveSettings(conv, caps)
  const options: ChatOptions = { temperature: s.temperature, top_p: s.topP, num_ctx: s.numCtx }
  if (s.seed != null) options.seed = s.seed
  // Esecuzione del modello (CPU/GPU), configurata per modello: assente = decide Ollama.
  if (numGpu != null) options.num_gpu = numGpu
  return options
}

/**
 * Messaggi da inviare: system prompt (brief + stile + riassunto; mai troncato) + coda dei messaggi non
 * coperti dal riassunto che sta nel contesto, lasciando liberi i token di riserva per la risposta.
 */
export function buildChatMessages(
  conv: Conversation,
  history: Message[],
  system: string = buildSystemPrompt(conv, conv.style),
  caps: ModelCapabilities | null = null,
  /** Estratti della memoria della conversazione (sezione già pronta), dopo il riassunto. */
  memory = ''
): ChatMessage[] {
  return composeChat(conv, history, system, caps, memory).messages
}

/** Come buildChatMessages, più le voci per il monitor del contesto e i messaggi rimasti fuori. */
export function composeChat(
  conv: Conversation,
  history: Message[],
  base: string,
  caps: ModelCapabilities | null = null,
  memory = '',
  memoryCount = 0
): { messages: ChatMessage[]; parts: ContextPart[]; dropped: number } {
  const s = resolveSettings(conv, caps)
  const { recent, aligned } = historyAfter(history, conv.summaryUpTo)
  let system = aligned ? withSummary(base, conv.summary) : base
  const summary = system.slice(base.length)
  if (memory) system = system ? `${system}\n\n${memory}` : memory
  const picked = selectHistory(recent, system, { ...DEFAULT_HISTORY_LIMITS, maxTokens: s.numCtx, reserveTokens: s.reserveTokens })
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : []
  for (const m of picked) out.push({ role: m.role, content: m.content })
  const style = buildStyleSection(conv.style)
  const hasStyle = !!style && base.includes(style)
  const parts = chatParts({
    system,
    instructions: hasStyle ? base.replace(style, '') : base,
    style: hasStyle ? style : '',
    summary,
    memory,
    summaryCount: summary ? history.length - recent.length : 0,
    memoryCount,
    messages: picked,
    cpt: charsPerToken(history)
  })
  return { messages: out, parts, dropped: recent.length - picked.length }
}

const TITLE_PROMPT = `Genera un titolo breve (da 2 a 6 parole) per la conversazione che segue.
Usa la lingua della conversazione. Niente virgolette, niente punto finale, niente spiegazioni: rispondi solo con il titolo.`

/** Ripulisce il titolo proposto dal modello: prima riga utile, niente virgolette/markdown/prefissi, max 60 caratteri. */
export function cleanTitle(raw: string): string {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  let t = line
    .replace(/^(#+|\*+|-)\s*/, '')
    .replace(/^(titolo|title)\s*:\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/^["'«“`]+|["'»”`]+$/g, '')
    .replace(/[.:;,\s]+$/, '')
    .trim()
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '') + '…'
  return t
}

/** Titolo di riserva: l'inizio della prima domanda. */
export function fallbackTitle(question: string): string {
  const line = question.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > 50 ? line.slice(0, 50).replace(/\s+\S*$/, '') + '…' : line || DEFAULT_TITLE
}

function systemFor(conv: Conversation, mode: Mode): string {
  switch (mode.kind) {
    case 'plan':
      return buildPlanPrompt(conv, conv.style)
    case 'execute':
      return buildExecutePrompt(conv, mode.plan.steps, conv.style)
    default:
      return buildSystemPrompt(conv, conv.style)
  }
}

export function createChatService({ db, ollama, emit, onConversationUpdated, summarizer, memory, contextLog }: ChatServiceDeps) {
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

  /** Layer in GPU configurati per il modello (null = automatico). */
  async function numGpuOf(model: string): Promise<number | null> {
    return (await getModelSetting(db, model))?.numGpu ?? null
  }

  async function capsOf(conv: Conversation): Promise<ModelCapabilities | null> {
    try {
      return await ollama.showModel(conv.model)
    } catch {
      return null
    }
  }

  /**
   * Dopo il primo scambio, se la conversazione ha ancora il titolo predefinito, ne genera uno con il modello.
   * Se il modello non risponde usa l'inizio della domanda. Non sovrascrive mai un titolo scelto dall'utente.
   */
  async function maybeAutoTitle(target: StreamTarget, conversationId: string): Promise<void> {
    const conv = await getConversation(db, conversationId)
    if (!conv || conv.title !== DEFAULT_TITLE) return
    const history = await listMessages(db, conversationId)
    const question = history.find((m) => m.role === 'user')
    const answer = history.find((m) => m.role === 'assistant')
    if (!question || !answer || history.filter((m) => m.role === 'assistant').length !== 1) return

    let title = ''
    try {
      const caps = await capsOf(conv)
      // Stesso num_ctx della conversazione: con un valore diverso Ollama ricaricherebbe il modello
      // per il titolo e di nuovo alla domanda successiva.
      const request: ChatRequest = {
        model: conv.model,
        messages: [
          { role: 'system', content: TITLE_PROMPT },
          {
            role: 'user',
            content: `Domanda:\n${question.content.slice(0, 1500)}\n\nRisposta:\n${answer.content.slice(0, 1500)}`
          }
        ],
        options: { ...buildOptions(conv, caps, await numGpuOf(conv.model)), temperature: 0.3, num_predict: 32 }
      }
      if (caps?.thinking) request.think = false
      const start: CallStart = {
        conversationId,
        kind: 'title',
        model: conv.model,
        numCtx: request.options?.num_ctx ?? null,
        parts: [
          { key: 'instructions', label: 'Istruzioni', tokens: estimateTokens(TITLE_PROMPT, charsPerToken(history)) },
          { key: 'transcript', label: 'Domanda e risposta', tokens: estimateTokens(request.messages[1].content, charsPerToken(history)) }
        ]
      }
      const result = await ollama.chatStream(request, {}).catch(async (err: unknown) => {
        await contextLog?.record(callInput(start, null, err))
        throw err
      })
      await contextLog?.record(callInput(start, result))
      title = cleanTitle(result.content)
    } catch {
      /* si usa il titolo di riserva */
    }
    if (!title) title = fallbackTitle(question.content)

    // L'utente potrebbe averla rinominata nel frattempo.
    const current = await getConversation(db, conversationId)
    if (!current || current.title !== DEFAULT_TITLE) return
    // Prima si salva, poi si notifica: con `fn?.(await …)` il salvataggio verrebbe saltato se fn manca.
    const saved = await updateConversation(db, conversationId, { title })
    onConversationUpdated?.(target, saved)
  }

  /** Conclude uno stream: salva ciò che serve e costruisce l'evento 'done'. */
  async function finish(
    conv: Conversation,
    mode: Mode,
    result: {
      content: string
      thinking: string
      evalCount: number | null
      promptEvalCount: number | null
      durationMs: number | null
      doneReason: DoneReason | null
      aborted: boolean
    },
    memoryRefs: MemoryRef[] = []
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
        promptEvalCount: result.promptEvalCount,
        durationMs: result.durationMs,
        doneReason: result.aborted ? null : result.doneReason,
        memoryRefs
      })
    }
    const out: Partial<StreamEvent> = { message, aborted: result.aborted }
    if (mode.kind === 'execute' && message && mode.plan.status !== 'executed') {
      out.executedPlan = await updatePlan(db, mode.plan.id, { status: 'executed' })
    }
    return out
  }

  /** Richiesta a Ollama per lo stato attuale della conversazione. */
  async function buildRequest(
    conv: Conversation,
    mode: Mode,
    caps: ModelCapabilities | null,
    memorySection = '',
    memoryCount = 0
  ): Promise<{ request: ChatRequest; start: CallStart }> {
    const history = await listMessages(db, conv.id)
    const composed = composeChat(conv, history, systemFor(conv, mode), caps, memorySection, memoryCount)
    const request: ChatRequest = {
      model: conv.model,
      messages: composed.messages,
      options: buildOptions(conv, caps, await numGpuOf(conv.model))
    }
    if (mode.kind === 'plan') request.format = PLAN_SCHEMA as unknown as Record<string, unknown>
    if (caps?.thinking) request.think = resolveSettings(conv, caps).think
    const start: CallStart = {
      conversationId: conv.id,
      kind: mode.kind,
      model: conv.model,
      numCtx: request.options?.num_ctx ?? null,
      parts: composed.parts,
      droppedMessages: composed.dropped
    }
    return { request, start }
  }

  async function startStream(target: StreamTarget, original: Conversation, mode: Mode): Promise<string> {
    const streamId = randomUUID()
    const controller = new AbortController()
    const caps = await capsOf(original)

    const kind: StreamKind = mode.kind === 'plan' ? 'plan' : 'chat'
    const base = { streamId, conversationId: original.id, kind }
    const run = async (): Promise<void> => {
      let answered = false
      let conv = original
      try {
        // Prima della risposta: se la memoria è oltre la soglia, i messaggi più vecchi vengono riassunti,
        // così la risposta parte con la riserva intera. Lo stato è visibile; se fallisce si risponde comunque.
        // Se un riassunto è già in corso (quello dopo la risposta precedente), si aspetta che finisca:
        // altrimenti la domanda partirebbe con lo stato vecchio e potrebbe esaurire la memoria.
        const summarized = await summarizer
          ?.summarize(conv.id, false, () => emit(target, { ...base, type: 'summarizing' }), true)
          .catch(() => null)
        if (summarized?.outcome === 'updated' && summarized.conversation) {
          conv = summarized.conversation
          onConversationUpdated?.(target, conv)
        }
        if (controller.signal.aborted) {
          emit(target, { ...base, type: 'done', aborted: true })
          return
        }
        // Memoria della conversazione: dopo il primo riassunto, estratti pertinenti dei messaggi riassunti.
        let recall: Recall = { section: '', refs: [] }
        if (memory && conv.longMemory && conv.summary) {
          emit(target, { ...base, type: 'remembering' })
          const { request: draft } = await buildRequest(conv, mode, caps)
          const s = resolveSettings(conv, caps)
          const used = draft.messages.reduce((n, m) => n + estimateTokens(m.content), 0)
          recall = await memory.recall(conv, memoryBudget(s.numCtx, s.reserveTokens, used)).catch(() => recall)
        }
        const { request, start } = await buildRequest(conv, mode, caps, recall.section, recall.refs.length)
        const result = await ollama
          .chatStream(
            request,
            {
              onThinking: (delta) => emit(target, { ...base, type: 'thinking', delta }),
              onContent: (delta) => emit(target, { ...base, type: 'content', delta })
            },
            controller.signal
          )
          .catch(async (err: unknown) => {
            await contextLog?.record(callInput(start, null, err))
            throw err
          })
        await contextLog?.record(callInput(start, result))
        const done = await finish(conv, mode, result, recall.refs)
        answered = !!done.message
        emit(target, { ...base, type: 'done', ...done })
      } catch (err) {
        emit(target, { ...base, type: 'error', error: err instanceof Error ? err.message : String(err) })
      } finally {
        // La conversazione è di nuovo libera prima di generare il titolo.
        streams.delete(streamId)
      }
      if (answered) {
        await maybeAutoTitle(target, conv.id).catch(() => undefined)
        // In anticipo per la domanda successiva: di norma all'invio non resta nulla da riassumere.
        const r = await summarizer?.summarize(conv.id).catch(() => null)
        if (r?.outcome === 'updated' && r.conversation) onConversationUpdated?.(target, r.conversation)
        // I messaggi appena riassunti entrano nella memoria subito, non alla prossima domanda.
        const latest = await getConversation(db, conv.id)
        if (memory && latest) await memory.indexQuietly(latest)
      }
    }

    const active: ActiveStream = { conversationId: original.id, target, controller, done: Promise.resolve() }
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
