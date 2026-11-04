import { create } from 'zustand'
import { flushPendingSaves } from './pendingSaves'
import type { Conversation, Message, Plan, PlanStep, Result, SendResult, StreamEvent, StreamKind } from '@shared/types'

export interface LiveStream {
  streamId: string
  kind: StreamKind
  content: string
  thinking: string
  /** Inizio della richiesta (ms), per mostrare il tempo trascorso. */
  startedAt: number
}

interface ChatState {
  conversation: Conversation | null
  messages: Message[]
  plans: Plan[]
  /** Stream in corso, per conversazione: proseguono anche se si cambia conversazione. */
  streams: Record<string, LiveStream>
  error: string | null
  /** Tipo dello stream fallito: decide cosa fa "Riprova". */
  errorKind: StreamKind | null
  loading: boolean

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
}

/** Eventi arrivati prima che la risposta della chiamata IPC ci abbia comunicato lo streamId. */
const pending = new Map<string, StreamEvent[]>()

const replacePlan = (plans: Plan[], plan: Plan): Plan[] => plans.map((p) => (p.id === plan.id ? plan : p))

export const useChat = create<ChatState>((set, get) => {
  /** Registra un nuovo stream e applica gli eventi eventualmente già arrivati. */
  const startStream = (conversationId: string, streamId: string, kind: StreamKind): void => {
    set((s) => ({ streams: { ...s.streams, [conversationId]: { streamId, kind, content: '', thinking: '', startedAt: Date.now() } } }))
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
    set({ error: null, errorKind: null })
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
    errorKind: null,
    loading: false,

    async load(id) {
      if (!id) return set({ conversation: null, messages: [], plans: [], error: null, errorKind: null })
      set({ loading: true, error: null, errorKind: null })
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
      return get().conversation?.planMode
        ? run('plan', (c) => window.api.plans.propose(c.id, text))
        : run('chat', (c) => window.api.chat.send(c.id, text))
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
        case 'thinking':
        case 'content': {
          const key = event.type === 'thinking' ? 'thinking' : 'content'
          set((s) => ({
            streams: { ...s.streams, [event.conversationId]: { ...live, [key]: live[key] + (event.delta ?? '') } }
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
              ...(event.type === 'error' ? { error: event.error ?? 'Errore sconosciuto', errorKind: event.kind } : {})
            }
          })
        }
      }
    },

    clearError() {
      set({ error: null, errorKind: null })
    }
  }
})
