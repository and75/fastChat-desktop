import { create } from 'zustand'
import { flushPendingSaves } from './pendingSaves'
import { t } from '@shared/i18n'
import type { Conversation, Message, ModelState, Plan, PlanStep, Result, SendResult, SkippedStep, StreamEvent, StreamKind } from '@shared/types'

export interface LiveStream {
  streamId: string
  kind: StreamKind
  content: string
  thinking: string
  /** Inizio della richiesta (ms), per mostrare il tempo trascorso. */
  startedAt: number
  /** I messaggi più vecchi vengono riassunti prima della risposta. */
  summarizing: boolean
  /** Si cercano estratti pertinenti nei messaggi riassunti, prima della risposta. */
  remembering: boolean
  /** Si cercano estratti pertinenti nei documenti della base di conoscenza, prima della risposta. */
  searching: boolean
  /** La richiesta è partita e si aspetta il primo token: cosa fa Ollama, con quale modello e quanti token legge. */
  waiting: { state: ModelState; model: string; promptTokens: number | null } | null
  /** Ultimo frammento ricevuto (ms), per avvisare quando il testo smette di arrivare. */
  lastDeltaAt: number | null
}

/** Secondi senza nuovo testo oltre i quali la risposta in corso mostra un avviso. */
export const STALL_SECONDS = 30

/** Avviso sotto la risposta: i passi facoltativi che non sono riusciti. */
export function skippedNotice(steps: SkippedStep[]): string {
  const names = steps.map((s) => t(`chat.skipped.${s}`))
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + t('chat.skipped.and') + names.at(-1) : names[0]
  return t('chat.skipped', { steps: list })
}

/** Avviso sotto la risposta: Ollama ha dovuto ricaricare il modello, e cosa aveva in memoria al suo posto. */
export function reloadedNotice(reloaded: { loadMs: number; others: string[] }): string {
  const seconds = Math.round(reloaded.loadMs / 1000)
  return reloaded.others.length ? t('chat.reloaded.others', { seconds, others: reloaded.others.join(', ') }) : t('chat.reloaded', { seconds })
}

/** Etichetta dell'attesa prima del primo token: cosa sta succedendo davvero. undefined a risposta iniziata. */
export function stageLabel(live: Pick<LiveStream, 'summarizing' | 'remembering' | 'searching' | 'waiting'>): string | undefined {
  if (live.summarizing) return t('message.summarizing')
  if (live.searching) return t('message.searching')
  if (live.remembering) return t('message.remembering')
  if (!live.waiting) return undefined
  if (live.waiting.state === 'silent') return t('message.ollamaSilent')
  if (live.waiting.state === 'loading') return t('message.loadingModel', { model: live.waiting.model })
  if (live.waiting.state === 'loaded') {
    const tokens = live.waiting.promptTokens
    // Stima: arrotondata alle centinaia sopra il migliaio, per non suggerire una precisione che non c'è.
    return t('message.readingContext', { tokens: tokens == null ? '?' : tokens >= 1000 ? Math.round(tokens / 100) * 100 : tokens })
  }
  return t('message.waitingOllama')
}

interface ChatState {
  conversation: Conversation | null
  messages: Message[]
  plans: Plan[]
  /** Stream in corso, per conversazione: proseguono anche se si cambia conversazione. */
  streams: Record<string, LiveStream>
  error: string | null
  /** L'ultima risposta è arrivata senza un passo facoltativo (documenti, memoria…): avviso, non errore. */
  warning: string | null
  /** Tipo dello stream fallito: decide cosa fa "Riprova". */
  errorKind: StreamKind | null
  loading: boolean
  /**
   * Bottone libro: scelta per la prossima domanda, se diversa dall'impostazione della conversazione
   * (null = come la conversazione). Si azzera dopo l'invio.
   */
  knowledgeNext: boolean | null
  setKnowledgeNext(value: boolean | null): void

  load(id: string | null): Promise<void>
  replaceConversation(conv: Conversation): void
  /** Invia un messaggio; in plan mode chiede prima un piano. */
  send(text: string): Promise<boolean>
  regenerate(): Promise<void>
  /** "Riprova" dopo un errore: ripete l'ultima operazione (risposta o piano). */
  retry(): Promise<void>
  abort(): Promise<void>
  approvePlan(planId: string, steps: PlanStep[]): Promise<void>
  regeneratePlan(): Promise<void>
  rejectPlan(planId: string): Promise<void>
  handleStream(event: StreamEvent): void
  clearError(): void
  clearWarning(): void
}

/** Eventi arrivati prima che la risposta della chiamata IPC ci abbia comunicato lo streamId. */
const pending = new Map<string, StreamEvent[]>()

const replacePlan = (plans: Plan[], plan: Plan): Plan[] => plans.map((p) => (p.id === plan.id ? plan : p))

export const useChat = create<ChatState>((set, get) => {
  /** Registra un nuovo stream e applica gli eventi eventualmente già arrivati. */
  const startStream = (conversationId: string, streamId: string, kind: StreamKind): void => {
    set((s) => ({ streams: { ...s.streams, [conversationId]: { streamId, kind, content: '', thinking: '', startedAt: Date.now(), summarizing: false, remembering: false, searching: false, waiting: null, lastDeltaAt: null } } }))
    const early = pending.get(streamId) ?? []
    pending.delete(streamId)
    early.forEach((e) => get().handleStream(e))
  }

  /** Esegue una chiamata che avvia uno stream sulla conversazione aperta. */
  const run = async (
    kind: StreamKind,
    call: (conv: Conversation) => Promise<Result<SendResult>>,
    before?: () => void
  ): Promise<boolean> => {
    if (!get().conversation) return false
    // Prima scriviamo impostazioni e brief appena modificati, così l'invio li usa.
    await flushPendingSaves()
    const conv = get().conversation
    if (!conv || get().streams[conv.id]) return false
    set({ error: null, errorKind: null, warning: null })
    const res = await call(conv)
    if (!res.ok) {
      set({ error: res.error, errorKind: kind })
      return false
    }
    before?.()
    if (res.data.userMessage && get().conversation?.id === conv.id) {
      set((s) => ({ messages: [...s.messages, res.data.userMessage!] }))
    }
    startStream(conv.id, res.data.streamId, kind)
    return true
  }

  /** Togli l'ultima risposta dell'assistente (il main l'ha appena eliminata per rigenerarla). */
  const dropLastAnswer = (): void =>
    set((s) => ({ messages: s.messages.at(-1)?.role === 'assistant' ? s.messages.slice(0, -1) : s.messages }))

  return {
    conversation: null,
    messages: [],
    plans: [],
    streams: {},
    error: null,
    warning: null,
    errorKind: null,
    loading: false,
    knowledgeNext: null,
    setKnowledgeNext: (value) => set({ knowledgeNext: value }),

    async load(id) {
      if (!id) return set({ conversation: null, messages: [], plans: [], error: null, errorKind: null, warning: null, knowledgeNext: null })
      set({ loading: true, error: null, errorKind: null, warning: null, knowledgeNext: null })
      const res = await window.api.conversations.get(id)
      if (res.ok) {
        set({ conversation: res.data.conversation, messages: res.data.messages, plans: res.data.plans, loading: false })
      } else {
        set({ conversation: null, messages: [], plans: [], error: res.error, loading: false })
      }
    },

    replaceConversation(conv) {
      if (get().conversation?.id === conv.id) set({ conversation: conv })
    },

    async send(text) {
      if (!text.trim()) return false
      const next = get().knowledgeNext
      const options = next == null ? undefined : { knowledge: next }
      const ok = await (get().conversation?.planMode
        ? run('plan', (c) => window.api.plans.propose(c.id, text, options))
        : run('chat', (c) => window.api.chat.send(c.id, text, options)))
      // La scelta del bottone libro vale per una domanda sola.
      if (ok) set({ knowledgeNext: null })
      return ok
    },

    async regenerate() {
      await run('chat', (c) => window.api.chat.regenerate(c.id), dropLastAnswer)
    },

    async retry() {
      if (get().errorKind === 'plan') await get().regeneratePlan()
      else await get().regenerate()
    },

    async abort() {
      const conv = get().conversation
      const stream = conv ? get().streams[conv.id] : undefined
      if (stream) await window.api.chat.abort(stream.streamId)
    },

    async approvePlan(planId, steps) {
      await flushPendingSaves()
      const conv = get().conversation
      if (!conv || get().streams[conv.id]) return
      const up = await window.api.plans.update(planId, { steps })
      if (!up.ok) return set({ error: up.error, errorKind: 'chat' })
      set((s) => ({ plans: replacePlan(s.plans, up.data) }))
      await run('chat', () => window.api.plans.execute(planId), () =>
        set((s) => ({ plans: s.plans.map((p) => (p.id === planId ? { ...p, status: 'approved' } : p)) }))
      )
    },

    async regeneratePlan() {
      const lastUser = get().messages.at(-1)
      await run('plan', (c) => window.api.plans.regenerate(c.id), () =>
        // Il main scarta i piani non eseguiti dell'ultimo messaggio.
        set((s) => ({ plans: s.plans.filter((p) => p.userMessageId !== lastUser?.id || p.status === 'executed') }))
      )
    },

    async rejectPlan(planId) {
      const res = await window.api.plans.update(planId, { status: 'rejected' })
      if (!res.ok) return set({ error: res.error, errorKind: null })
      set((s) => ({ plans: replacePlan(s.plans, res.data) }))
    },

    handleStream(event) {
      const live = get().streams[event.conversationId]
      if (!live || live.streamId !== event.streamId) {
        const list = pending.get(event.streamId) ?? []
        list.push(event)
        pending.set(event.streamId, list)
        return
      }
      const isActive = get().conversation?.id === event.conversationId

      switch (event.type) {
        case 'summarizing':
          set((s) => ({ streams: { ...s.streams, [event.conversationId]: { ...live, summarizing: true, remembering: false, searching: false, waiting: null } } }))
          return
        case 'remembering':
          set((s) => ({ streams: { ...s.streams, [event.conversationId]: { ...live, summarizing: false, remembering: true, searching: false, waiting: null } } }))
          return
        case 'searching':
          set((s) => ({ streams: { ...s.streams, [event.conversationId]: { ...live, summarizing: false, remembering: false, searching: true, waiting: null } } }))
          return
        case 'waiting':
          set((s) => ({
            streams: {
              ...s.streams,
              [event.conversationId]: {
                ...live,
                summarizing: false,
                remembering: false,
                searching: false,
                waiting: { state: event.modelState ?? 'unknown', model: event.model ?? '', promptTokens: event.promptTokens ?? null }
              }
            }
          }))
          return
        case 'thinking':
        case 'content': {
          const key = event.type === 'thinking' ? 'thinking' : 'content'
          set((s) => ({
            streams: { ...s.streams, [event.conversationId]: { ...live, summarizing: false, remembering: false, searching: false, waiting: null, lastDeltaAt: Date.now(), [key]: live[key] + (event.delta ?? '') } }
          }))
          return
        }
        case 'done':
        case 'error': {
          set((s) => {
            const streams = { ...s.streams }
            delete streams[event.conversationId]
            if (!isActive) return { streams }
            let plans = s.plans
            if (event.plan) plans = [...plans, event.plan]
            if (event.executedPlan) plans = replacePlan(plans, event.executedPlan)
            return {
              streams,
              plans,
              messages: event.message ? [...s.messages, event.message] : s.messages,
              ...(event.type === 'error' ? { error: event.error ?? 'Errore sconosciuto', errorKind: event.kind } : {}),
              ...(event.type === 'done' && (event.skipped?.length || event.reloaded)
                ? { warning: [event.skipped?.length ? skippedNotice(event.skipped) : '', event.reloaded ? reloadedNotice(event.reloaded) : ''].filter(Boolean).join(' ') }
                : {})
            }
          })
        }
      }
    },

    clearError() {
      set({ error: null, errorKind: null })
    },

    clearWarning() {
      set({ warning: null })
    }
  }
})
