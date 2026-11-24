import { randomUUID } from 'node:crypto'
import {
  buildStyleSection,
  charsPerToken,
  executeSection,
  planSection,
  DEFAULT_HISTORY_LIMITS,
  estimateTokens,
  historyAfter,
  parsePlan,
  PLAN_SCHEMA,
  withSummary
} from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import {
  DEFAULT_TITLE,
  type Conversation,
  type DoneReason,
  type KnowledgeRef,
  type MemoryRef,
  type ModelState,
  type ModelCapabilities,
  type Message,
  type Plan,
  type SendOptions,
  type SendResult,
  type SkippedStep,
  type StreamEvent,
  type StreamKind
} from '@shared/types'
import type { Db } from './db/client'
import {
  addMessage,
  createPlan,
  planToFollow,
  getConversation,
  getModelSetting,
  recentPromptReads,
  saveModelSetting,
  getPlan,
  listMessages,
  listPlans,
  removeMessage,
  removePlan,
  roleOf,
  updateConversation,
  updatePlan
} from './db/repo'
import { composeMessages, readSecondsOf, resolveContext, roleReminder } from '@shared/compose'
import { chatParts } from '@shared/context'
import { t } from '@shared/i18n'
import type { ContextOrder, ContextPart, ContextSettings } from '@shared/types'
import { callInput, type CallStart, type ContextLog } from './contextLog'
import { OllamaError, type ChatMessage, type ChatOptions, type ChatRequest, type OllamaClient } from './ollama'
import { memoryBudget, type Memory, type Recall } from './memory'
import type { Summarizer } from './summary'
import { knowledgeBudget, readingLimit, readingSpeed } from '@shared/knowledge'
import { GENERALIST_ROLE, rolePrompt, roleReminderText, roleSectionRules } from '@shared/roles'
import { withPromptLanguage } from './promptLocale'
import type { Knowledge, RoleRecall } from './knowledge'
import type { Embedder } from './embedder'
import { errorDetail, nullLogger, type Logger } from './log'

/** Ogni quanto si richiede a Ollama lo stato del modello mentre si aspetta il primo token. */
const MODEL_POLL_MS = 1500
/**
 * Ricarica inattesa: il modello aveva risposto da meno di così (Ollama di norma lo tiene 5 minuti) e il
 * caricamento è durato almeno RELOAD_MIN_MS.
 */
const RELOAD_WINDOW_MS = 4 * 60_000
const RELOAD_MIN_MS = 1000

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
  /** Base di conoscenza (RAG sui documenti della conversazione). */
  knowledge?: Knowledge
  /** Embedding della domanda, condiviso tra memoria e base di conoscenza (se manca si usa quello di memory/knowledge). */
  embedder?: Embedder
  /** Monitor del contesto: registra ogni chiamata a Ollama. */
  contextLog?: ContextLog
  /** Composizione del contesto scelta nelle Impostazioni (assente = comportamento storico). */
  getContext?(): Promise<ContextSettings>
  /** Registro diagnostico: tempi di ogni risposta ed errori che non fermano la risposta. */
  log?: Logger
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

/** Sezioni aggiunte al system prompt dopo il riassunto: estratti della memoria e dei documenti, già pronti. */
export interface Extras {
  memory?: string
  memoryCount?: number
  knowledge?: string
  knowledgeCount?: number
  /** Tecniche ed esempi del ruolo (basi di comportamento e di esempi): sempre presenti, senza fonti. */
  behavior?: string
  behaviorCount?: number
  examples?: string
  examplesCount?: number
}

/**
 * Messaggi da inviare: system prompt (brief + stile + riassunto; mai troncato) + coda dei messaggi non
 * coperti dal riassunto che sta nel contesto, lasciando liberi i token di riserva per la risposta.
 */
export function buildChatMessages(
  conv: Conversation,
  history: Message[],
  system: string = rolePrompt(GENERALIST_ROLE, conv).system,
  caps: ModelCapabilities | null = null,
  /** Estratti della memoria della conversazione (sezione già pronta), dopo il riassunto. */
  memory = ''
): ChatMessage[] {
  return composeChat(conv, history, system, caps, { memory }).messages
}

/** Come si compone il contesto di una chiamata: ordine dei blocchi e promemoria del ruolo. */
export interface ComposeConfig {
  order: ContextOrder
  reminder: boolean
  /** La situazione com'è dentro `base`, per la sua voce nel monitor. */
  situationPart?: string
  /** L'essenziale del ruolo per il promemoria. Se manca si usa il campo Ruolo del Brief (conversazioni non convertite). */
  reminderText?: string
  /** Le regole scelte dall'utente tra le opzioni del ruolo, già pronte: dopo il materiale, prima di stile e piano. */
  rules?: string
  /** Blocco del piano (richiesta di un piano, o piano approvato da eseguire), già pronto. */
  plan?: string
}

/** Come buildChatMessages, più le voci per il monitor del contesto e i messaggi rimasti fuori. */
export function composeChat(
  conv: Conversation,
  history: Message[],
  base: string,
  caps: ModelCapabilities | null = null,
  extras: Extras = {},
  config: ComposeConfig = { order: 'A', reminder: false }
): { messages: ChatMessage[]; parts: ContextPart[]; dropped: number } {
  const s = resolveSettings(conv, caps)
  const { recent, aligned } = historyAfter(history, conv.summaryUpTo)
  const memory = extras.memory ?? ''
  const knowledge = extras.knowledge ?? ''
  const behavior = extras.behavior ?? ''
  const examples = extras.examples ?? ''
  const rules = config.rules ?? ''
  const plan = config.plan ?? ''
  const style = buildStyleSection(conv.style)
  const reminder = config.reminder ? roleReminder(config.reminderText ?? conv.role) : ''
  // Ordine fisso dei blocchi (BLOCK_SEQUENCE): dopo ruolo, situazione e riassunto vengono memoria, tecniche,
  // esempi, documenti, regole scelte, stile della risposta e piano.
  const composed = composeMessages({
    order: config.order,
    base,
    summary: aligned ? conv.summary : null,
    blocks: [
      { key: 'memory', text: memory },
      { key: 'behavior', text: behavior },
      { key: 'examples', text: examples },
      { key: 'knowledge', text: knowledge },
      { key: 'rules', text: rules },
      { key: 'style', text: style },
      { key: 'plan', text: plan }
    ],
    reminder,
    history: recent,
    limits: { ...DEFAULT_HISTORY_LIMITS, maxTokens: s.numCtx, reserveTokens: s.reserveTokens }
  })
  const picked = composed.picked
  // Le stime per voce si fanno sulle sezioni messe in fila (com'è l'ordine A): la posizione non cambia i token.
  const summary = (aligned ? withSummary(base, conv.summary) : base).slice(base.length)
  const cpt = charsPerToken(history)
  const situation = config.situationPart && base.includes(config.situationPart) ? config.situationPart : ''
  const parts = chatParts({
    system: composed.flat,
    // Sotto «istruzioni» si contano il testo del ruolo, le regole scelte e il piano, anche se non stanno vicini.
    instructions: [situation ? base.replace(situation, '') : base, rules, plan].filter((x) => x.trim()).join('\n\n'),
    situation,
    style,
    summary,
    memory,
    behavior,
    examples,
    knowledge,
    summaryCount: summary ? history.length - recent.length : 0,
    memoryCount: extras.memoryCount ?? 0,
    behaviorCount: extras.behaviorCount ?? 0,
    examplesCount: extras.examplesCount ?? 0,
    knowledgeCount: extras.knowledgeCount ?? 0,
    messages: picked,
    cpt
  })
  if (reminder) {
    const at = parts.findIndex((p) => p.key === 'history' || p.key === 'question')
    parts.splice(at < 0 ? parts.length : at, 0, { key: 'reminder', label: 'reminder', tokens: estimateTokens(reminder, cpt) })
  }
  return { messages: composed.messages, parts, dropped: recent.length - picked.length }
}

/**
 * La risposta a questa domanda usa la base di conoscenza? La scelta sulla domanda (bottone libro) vince;
 * altrimenti vale l'impostazione della conversazione (pill «Usa la base di conoscenza»).
 */
export function wantsKnowledge(conv: Pick<Conversation, 'knowledge'>, question: Pick<Message, 'knowledge'> | null | undefined): boolean {
  return question?.knowledge ?? conv.knowledge
}

const titlePrompt = (): string => t('prompt.title')

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

/** Il blocco del piano per questa chiamata: la richiesta di un piano, il piano approvato da eseguire, o nulla. */
function planFor(mode: Mode): string {
  switch (mode.kind) {
    case 'plan':
      return planSection()
    case 'execute':
      return executeSection(mode.plan.steps)
    default:
      return ''
  }
}

export function createChatService({ db, ollama, emit, onConversationUpdated, summarizer, memory, knowledge, embedder, contextLog, getContext, log = nullLogger }: ChatServiceDeps) {
  const streams = new Map<string, ActiveStream>()
  const questionEmbedder = embedder ?? memory?.embedder ?? knowledge?.embedder ?? null

  const isBusy = (conversationId: string): boolean =>
    [...streams.values()].some((s) => s.conversationId === conversationId)

  async function loadConversation(id: string): Promise<Conversation> {
    const conv = await getConversation(db, id)
    if (!conv) throw new Error(t('err.convNotFound'))
    if (!conv.model) throw new Error(t('err.noModel'))
    if (isBusy(id)) throw new Error(t('err.busy'))
    return conv
  }

  /** Il piano deve riferirsi all'ultimo messaggio della conversazione, ancora senza risposta. */
  async function assertPlanIsCurrent(plan: Plan): Promise<void> {
    const last = (await listMessages(db, plan.conversationId)).at(-1)
    if (!last || last.id !== plan.userMessageId) {
      throw new Error(t('err.planStale'))
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
   * Velocità di lettura del modello, token al secondo: dalle sue ultime risposte; se non ne ha ancora, dal test sul
   * modello per la configurazione CPU/GPU in uso. null = nessuna misura.
   */
  async function readSpeedOf(model: string): Promise<number | null> {
    const measured = readingSpeed(await recentPromptReads(db, model).catch(() => []))
    if (measured != null) return measured
    const setting = await getModelSetting(db, model).catch(() => null)
    const run = setting?.benchmark?.find((r) => r.numGpu === setting.numGpu && r.promptTps != null && !r.error)
    return run?.promptTps ?? null
  }

  /** Un passo facoltativo è fallito: la risposta prosegue senza, ma il motivo resta nel registro. */
  const skipped = (step: string, conversationId: string, note?: () => void) => (err: unknown): null => {
    log.warn('chat', `${step} non riuscito: la risposta prosegue senza`, { conversation: conversationId, error: errorDetail(err) })
    note?.()
    return null
  }

  /** Quando ogni modello ha finito l'ultima risposta (in quel momento era in memoria), per riconoscere le ricariche. */
  const lastAnswerAt = new Map<string, number>()

  /** Il modello è in memoria in Ollama? «nome» vale anche per «nome:latest». `others`: gli altri modelli in memoria. */
  async function modelState(model: string): Promise<{ state: ModelState; others: string[] }> {
    try {
      const loaded = await ollama.loadedModels()
      const mine = (m: { name: string }): boolean => m.name === model || m.name === `${model}:latest`
      return { state: loaded.some(mine) ? 'loaded' : 'loading', others: loaded.filter((m) => !mine(m)).map((m) => m.name) }
    } catch (err) {
      // Ollama non raggiungibile o muto; un altro errore (versione senza /api/ps) non dice nulla.
      return { state: err instanceof OllamaError && (err.code === 'unreachable' || err.code === 'timeout') ? 'silent' : 'unknown', others: [] }
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
          { role: 'system', content: titlePrompt() },
          { role: 'user', content: t('prompt.title.request', { question: question.content.slice(0, 1500), answer: answer.content.slice(0, 1500) }) }
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
          { key: 'instructions', label: 'instructions', tokens: estimateTokens(titlePrompt(), charsPerToken(history)) },
          { key: 'transcript', label: 'transcript.qa', tokens: estimateTokens(request.messages[1].content, charsPerToken(history)) }
        ]
      }
      const result = await ollama.chatStream(request, {}).catch(async (err: unknown) => {
        await contextLog?.record(callInput(start, null, err))
        throw err
      })
      await contextLog?.record(callInput(start, result))
      title = cleanTitle(result.content)
    } catch (err) {
      // Si usa il titolo di riserva.
      skipped('titolo', conversationId)(err)
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
    memoryRefs: MemoryRef[] = [],
    knowledgeRefs: KnowledgeRef[] = []
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
        memoryRefs,
        knowledgeRefs
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
    extras: Extras = {}
  ): Promise<{ request: ChatRequest; start: CallStart }> {
    const history = await listMessages(db, conv.id)
    const context = resolveContext(await getContext?.().catch(() => null))
    const role = (await roleOf(db, conv)).definition
    const { system, situation: situationPart, rules } = rolePrompt(role, conv)
    const composed = composeChat(conv, history, system, caps, extras, { ...context, situationPart, rules, plan: planFor(mode), reminderText: roleReminderText(role) })
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
      droppedMessages: composed.dropped,
      contextOrder: context.order,
      reminder: context.reminder,
      systemSlot: caps?.systemSlot ?? null,
      cpt: charsPerToken(history),
      request: { messages: request.messages.map((m) => ({ role: m.role, content: m.content })), options: request.options as Record<string, unknown> | undefined, think: request.think ?? null }
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
      // Tempi per stadio, per il registro diagnostico.
      const t0 = Date.now()
      const times: Record<string, number> = {}
      const lap = (name: string, since: number): void => {
        times[name] = Date.now() - since
      }
      // Stato del modello in Ollama mentre si aspetta il primo token.
      const wait: { timer: ReturnType<typeof setInterval> | null; stopped: boolean; first: ModelState | null; others: string[] } = { timer: null, stopped: false, first: null, others: [] }
      // Limite del tempo di lettura applicato ai documenti, per il registro.
      const reading: Record<string, unknown> = {}
      // Passi facoltativi non riusciti: la risposta arriva lo stesso, ma l'utente lo vede.
      const missing = new Set<SkippedStep>()
      const miss = (step: SkippedStep) => (): void => void missing.add(step)
      const stopWaiting = (): void => {
        wait.stopped = true
        if (wait.timer) clearInterval(wait.timer)
        wait.timer = null
      }
      try {
        // Prima della risposta: se la memoria è oltre la soglia, i messaggi più vecchi vengono riassunti,
        // così la risposta parte con la riserva intera. Lo stato è visibile; se fallisce si risponde comunque.
        // Se un riassunto è già in corso (quello dopo la risposta precedente), si aspetta che finisca:
        // altrimenti la domanda partirebbe con lo stato vecchio e potrebbe esaurire la memoria.
        const summarized = await summarizer
          ?.summarize(conv.id, false, () => emit(target, { ...base, type: 'summarizing' }), true)
          .catch(skipped('riassunto prima della risposta', conv.id, miss('summary')))
        lap('summaryMs', t0)
        if (summarized?.outcome === 'updated' && summarized.conversation) {
          conv = summarized.conversation
          onConversationUpdated?.(target, conv)
        }
        if (controller.signal.aborted) {
          emit(target, { ...base, type: 'done', aborted: true })
          return
        }
        // Prima della risposta, con un solo embedding della domanda:
        // - base di conoscenza (se la domanda o la conversazione la chiede e ci sono documenti pronti):
        //   estratti dei documenti, fino al 25% della memoria;
        // - memoria della conversazione (dopo il primo riassunto): estratti dei messaggi riassunti, nel 12%
        //   dello spazio che resta.
        let found: RoleRecall = { documents: { section: '', refs: [] }, behavior: { section: '', count: 0 }, examples: { section: '', count: 0 } }
        let recall: Recall = { section: '', refs: [] }
        const history = await listMessages(db, conv.id)
        const question = history.findLast((m) => m.role === 'user') ?? null
        // Una sola lettura delle basi per le due domande: ci sono documenti su cui rispondere? ci sono basi del ruolo?
        const available = knowledge ? await knowledge.availability(conv.id).catch(() => ({ documents: false, role: false })) : { documents: false, role: false }
        const useKnowledge = wantsKnowledge(conv, question) && available.documents
        // Tecniche ed esempi del ruolo entrano sempre, anche a libro spento: fanno parte del ruolo.
        const useRole = available.role
        const useMemory = !!memory && (await memory.canRecall(conv).catch(() => false))
        if (useKnowledge || useRole || useMemory) {
          emit(target, { ...base, type: useKnowledge || useRole ? 'searching' : 'remembering' })
          const s = resolveSettings(conv, caps)
          const cpt = charsPerToken(history)
          const { request: draft } = await buildRequest(conv, mode, caps)
          let used = draft.messages.reduce((n, m) => n + estimateTokens(m.content, cpt), 0)
          // Embedding della domanda: calcolato solo se serve, una volta per modello di embedding (di norma uno
          // solo, condiviso tra documenti e memoria; un pacchetto può dichiararne un altro per i suoi vettori).
          const vectors = new Map<string, Promise<number[] | null>>()
          const vector = (model: string): Promise<number[] | null> => {
            if (!vectors.has(model)) vectors.set(model, questionEmbedder ? questionEmbedder.embedQuestion(conv, history, model).catch(skipped(`embedding della domanda (${model})`, conv.id, miss('embedding'))) : Promise.resolve(null))
            return vectors.get(model)!
          }
          if (useKnowledge || useRole) {
            const since = Date.now()
            const contextSettings = await getContext?.().catch(() => null)
            const { shares } = resolveContext(contextSettings)
            const readSeconds = readSecondsOf(contextSettings)
            // Limite del tempo di lettura: i documenti non superano ciò che questo modello legge nel tempo massimo.
            // Senza una misura della sua velocità vale il valore prudente fisso.
            const readTps = useKnowledge && readSeconds > 0 ? await readSpeedOf(conv.model) : null
            const documentsMax = useKnowledge ? readingLimit(readTps, readSeconds) : null
            if (documentsMax != null) Object.assign(reading, { docsMaxTokens: documentsMax, readTps: readTps == null ? 'non misurata' : Math.round(readTps) })
            found = await knowledge!
              .recallAll(conv, { text: question?.content ?? '', vector }, { total: knowledgeBudget(s.numCtx, s.reserveTokens, used, conv.knowledgeShare), shares, documents: useKnowledge, documentsMax, sections: roleSectionRules((await roleOf(db, conv)).definition, conv.roleParams) }, cpt)
              .catch((err: unknown) => {
                skipped('ricerca nei documenti', conv.id, miss('documents'))(err)
                return found
              })
            lap('searchMs', since)
            for (const section of [found.documents.section, found.behavior.section, found.examples.section]) if (section) used += estimateTokens(section, cpt)
          }
          if (useMemory) {
            if (useKnowledge || useRole) emit(target, { ...base, type: 'remembering' })
            const since = Date.now()
            const query = questionEmbedder ? await vector(await questionEmbedder.model()) : null
            recall = await memory!.recall(conv, memoryBudget(s.numCtx, s.reserveTokens, used), query).catch((err: unknown) => {
              skipped('ricerca nella conversazione', conv.id, miss('memory'))(err)
              return recall
            })
            lap('memoryMs', since)
          }
        }
        const { request, start } = await buildRequest(conv, mode, caps, {
          memory: recall.section,
          memoryCount: recall.refs.length,
          knowledge: found.documents.section,
          knowledgeCount: found.documents.refs.length,
          behavior: found.behavior.section,
          behaviorCount: found.behavior.count,
          examples: found.examples.section,
          examplesCount: found.examples.count
        })
        lap('prepareMs', t0)
        // Da qui si aspetta Ollama: l'attesa ha un nome suo, non resta «Cerco nei documenti». Lo stato del modello
        // (da caricare o già in memoria) si chiede in parallelo alla richiesta e si aggiorna finché non arriva il
        // primo token; se Ollama non lo dice resta «in attesa».
        const promptTokens = request.messages.reduce((n, m) => n + estimateTokens(m.content, start.cpt), 0)
        const waiting = (modelState: ModelState): void => emit(target, { ...base, type: 'waiting', modelState, model: conv.model, promptTokens })
        let state: ModelState = 'unknown'
        waiting(state)
        const refresh = async (): Promise<void> => {
          const { state: next, others } = await modelState(conv.model)
          if (wait.stopped || next === 'unknown') return
          if (next !== 'silent' && wait.first == null) {
            wait.first = next
            wait.others = others
          }
          if (next !== state) {
            state = next
            waiting(state)
          }
        }
        let checking = false
        const check = (): void => {
          if (checking || wait.stopped) return
          checking = true
          void refresh().finally(() => {
            checking = false
          })
        }
        check()
        wait.timer = setInterval(check, MODEL_POLL_MS)
        const result = await ollama
          .chatStream(
            request,
            {
              onThinking: (delta) => {
                stopWaiting()
                emit(target, { ...base, type: 'thinking', delta })
              },
              onContent: (delta) => {
                stopWaiting()
                emit(target, { ...base, type: 'content', delta })
              }
            },
            controller.signal
          )
          .catch(async (err: unknown) => {
            await contextLog?.record(callInput(start, null, err))
            throw err
          })
        stopWaiting()
        await contextLog?.record(callInput(start, result))
        // Ricarica inattesa: il modello aveva risposto da poco, ma all'inizio non era più in memoria e Ollama ha
        // impiegato tempo a caricarlo. Tipico dello scambio con il modello di embedding quando la memoria è poca.
        // Un caricamento riuscito con almeno la memoria che era fallita: quel limite non vale più.
        const failed = (await getModelSetting(db, conv.model).catch(() => null))?.failedNumCtx
        if (failed != null && !result.aborted && (request.options?.num_ctx ?? 0) >= failed) {
          await saveModelSetting(db, conv.model, { failedNumCtx: null }).catch(() => undefined)
        }
        const previous = lastAnswerAt.get(conv.model)
        const reloaded =
          wait.first === 'loading' && (result.loadMs ?? 0) >= RELOAD_MIN_MS && previous != null && t0 - previous < RELOAD_WINDOW_MS
            ? { loadMs: result.loadMs!, others: wait.others }
            : null
        if (!result.aborted) lastAnswerAt.set(conv.model, Date.now())
        log.info('chat', result.aborted ? 'risposta interrotta' : 'risposta', {
          conversation: conv.id,
          kind: mode.kind,
          model: conv.model,
          numCtx: request.options?.num_ctx,
          modelAtStart: wait.first ?? 'unknown',
          othersInMemory: wait.others.join(', ') || undefined,
          reloaded: reloaded ? true : undefined,
          ...reading,
          ...times,
          promptTokensEstimated: promptTokens,
          promptTokens: result.promptEvalCount,
          firstTokenMs: result.firstTokenMs,
          loadMs: result.loadMs,
          promptEvalMs: result.promptEvalMs,
          evalMs: result.evalMs,
          totalMs: Date.now() - t0
        })
        const done = await finish(conv, mode, result, recall.refs, found.documents.refs)
        answered = !!done.message
        emit(target, { ...base, type: 'done', ...done, ...(missing.size && !result.aborted ? { skipped: [...missing] } : {}), ...(reloaded && !result.aborted ? { reloaded } : {}) })
      } catch (err) {
        // Memoria insufficiente: si ricorda con quale memoria della conversazione il modello non si è caricato
        // (il valore più piccolo), così il suggerimento per questo modello resta sotto.
        if (err instanceof OllamaError && err.code === 'memory') {
          const numCtx = resolveSettings(conv, caps).numCtx
          const before = (await getModelSetting(db, conv.model).catch(() => null))?.failedNumCtx
          if (before == null || numCtx < before) await saveModelSetting(db, conv.model, { failedNumCtx: numCtx }).catch(() => undefined)
        }
        log.error('chat', 'risposta fallita', { conversation: conv.id, kind: mode.kind, model: conv.model, modelAtStart: wait.first ?? 'unknown', ...times, totalMs: Date.now() - t0, error: errorDetail(err) })
        emit(target, { ...base, type: 'error', error: err instanceof Error ? err.message : String(err), ...(err instanceof OllamaError && err.code === 'memory' ? { errorCode: 'memory' as const } : {}) })
      } finally {
        stopWaiting()
        // La conversazione è di nuovo libera prima di generare il titolo.
        streams.delete(streamId)
      }
      if (answered) {
        const after = Date.now()
        await maybeAutoTitle(target, conv.id).catch(skipped('titolo', conv.id))
        // In anticipo per la domanda successiva: di norma all'invio non resta nulla da riassumere.
        const r = await summarizer?.summarize(conv.id).catch(skipped('riassunto dopo la risposta', conv.id))
        if (r?.outcome === 'updated' && r.conversation) onConversationUpdated?.(target, r.conversation)
        // I messaggi appena riassunti entrano nella memoria subito, non alla prossima domanda.
        const latest = await getConversation(db, conv.id)
        if (memory && latest) await memory.indexQuietly(latest)
        log.info('chat', 'dopo la risposta (titolo, riassunto, memoria)', { conversation: conv.id, ms: Date.now() - after })
      }
    }

    const active: ActiveStream = { conversationId: original.id, target, controller, done: Promise.resolve() }
    streams.set(streamId, active)
    // Parte al giro successivo: il renderer riceve prima lo streamId, poi gli eventi.
    // I testi che l'app scrive per il modello seguono la lingua del ruolo, per tutta la chiamata.
    const { language } = await roleOf(db, original)
    active.done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => withPromptLanguage(language, run))
    return streamId
  }

  async function addUserMessage(conversationId: string, text: string, options?: SendOptions): Promise<Message> {
    const content = text.trim()
    if (!content) throw new Error(t('err.emptyMessage'))
    return addMessage(db, { conversationId, role: 'user', content, knowledge: typeof options?.knowledge === 'boolean' ? options.knowledge : null })
  }

  async function loadPlan(planId: string): Promise<{ plan: Plan; conv: Conversation }> {
    const plan = await getPlan(db, planId)
    if (!plan) throw new Error(t('err.planNotFound'))
    return { plan, conv: await loadConversation(plan.conversationId) }
  }

  return {
    /** `options.knowledge`: scelta del bottone libro per questa domanda (assente = come la conversazione). */
    async send(target: StreamTarget, conversationId: string, text: string, options?: SendOptions): Promise<SendResult> {
      if (!text.trim()) throw new Error(t('err.emptyMessage'))
      const conv = await loadConversation(conversationId)
      const userMessage = await addUserMessage(conversationId, text, options)
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
      if (!last) throw new Error(t('err.nothingToRegenerate'))
      if (last.role === 'assistant') await removeMessage(db, last.id)
      const lastUser = history.findLast((m) => m.role === 'user')
      if (!lastUser) throw new Error(t('err.nothingToRegenerate'))
      const plan = await planToFollow(db, lastUser.id)
      const mode: Mode = plan ? { kind: 'execute', plan } : { kind: 'chat' }
      return { streamId: await startStream(target, conv, mode) }
    },

    /** Plan mode, fase 1: salva il messaggio e chiede al modello un piano (JSON vincolato da schema). */
    async proposePlan(target: StreamTarget, conversationId: string, text: string, options?: SendOptions): Promise<SendResult> {
      if (!text.trim()) throw new Error(t('err.emptyMessage'))
      const conv = await loadConversation(conversationId)
      const userMessage = await addUserMessage(conversationId, text, options)
      return { streamId: await startStream(target, conv, { kind: 'plan', userMessageId: userMessage.id }), userMessage }
    },

    /**
     * Chiede un nuovo piano per l'ultimo messaggio utente (ancora senza risposta), scartando i piani
     * non eseguiti. Copre sia "Rigenera" sulla checklist sia "Riprova" dopo un errore.
     */
    async regeneratePlan(target: StreamTarget, conversationId: string): Promise<SendResult> {
      const conv = await loadConversation(conversationId)
      const last = (await listMessages(db, conversationId)).at(-1)
      if (!last || last.role !== 'user') throw new Error(t('err.noPendingPlan'))
      for (const p of await listPlans(db, conversationId)) {
        if (p.userMessageId === last.id && p.status !== 'executed') await removePlan(db, p.id)
      }
      return { streamId: await startStream(target, conv, { kind: 'plan', userMessageId: last.id }) }
    },

    /** Plan mode, fase 2: approva il piano (se serve) e genera la risposta seguendolo. */
    async executePlan(target: StreamTarget, planId: string): Promise<SendResult> {
      const { plan, conv } = await loadPlan(planId)
      if (plan.status !== 'proposed' && plan.status !== 'approved') throw new Error(t('err.planNotExecutable'))
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
