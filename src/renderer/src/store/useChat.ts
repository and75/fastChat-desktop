import { create } from 'zustand'
import type { Conversation, Message, StreamEvent } from '@shared/types'

export interface LiveStream {
  streamId: string
  content: string
  thinking: string
}

interface ChatState {
  conversation: Conversation | null
  messages: Message[]
  /** Stream in corso, per conversazione: proseguono anche se si cambia conversazione. */
  streams: Record<string, LiveStream>
  error: string | null
  loading: boolean

  load(id: string | null): Promise<void>
  replaceConversation(conv: Conversation): void
  send(text: string): Promise<boolean>
  regenerate(): Promise<void>
  abort(): Promise<void>
  handleStream(event: StreamEvent): void
  clearError(): void
}

/** Eventi arrivati prima che la risposta di send() ci abbia comunicato lo streamId. */
const pending = new Map<string, StreamEvent[]>()

export const useChat = create<ChatState>((set, get) => {
  /** Registra un nuovo stream e applica gli eventi eventualmente già arrivati. */
  const startStream = (conversationId: string, streamId: string): void => {
    set((s) => ({ streams: { ...s.streams, [conversationId]: { streamId, content: '', thinking: '' } } }))
    const early = pending.get(streamId) ?? []
    pending.delete(streamId)
    early.forEach((e) => get().handleStream(e))
  }

  return {
    conversation: null,
    messages: [],
    streams: {},
    error: null,
    loading: false,

    async load(id) {
      if (!id) return set({ conversation: null, messages: [], error: null })
      set({ loading: true, error: null })
      const res = await window.api.conversations.get(id)
      if (res.ok) set({ conversation: res.data.conversation, messages: res.data.messages, loading: false })
      else set({ conversation: null, messages: [], error: res.error, loading: false })
    },

    replaceConversation(conv) {
      if (get().conversation?.id === conv.id) set({ conversation: conv })
    },

    async send(text) {
      const conv = get().conversation
      if (!conv || !text.trim() || get().streams[conv.id]) return false
      set({ error: null })
      const res = await window.api.chat.send(conv.id, text)
      if (!res.ok) {
        set({ error: res.error })
        return false
      }
      if (res.data.userMessage && get().conversation?.id === conv.id) {
        set((s) => ({ messages: [...s.messages, res.data.userMessage!] }))
      }
      startStream(conv.id, res.data.streamId)
      return true
    },

    async regenerate() {
      const conv = get().conversation
      if (!conv || get().streams[conv.id]) return
      set({ error: null })
      const res = await window.api.chat.regenerate(conv.id)
      if (!res.ok) return set({ error: res.error })
      // Il main ha eliminato l'ultima risposta: la togliamo anche qui.
      set((s) => ({ messages: s.messages.at(-1)?.role === 'assistant' ? s.messages.slice(0, -1) : s.messages }))
      startStream(conv.id, res.data.streamId)
    },

    async abort() {
      const conv = get().conversation
      const stream = conv ? get().streams[conv.id] : undefined
      if (stream) await window.api.chat.abort(stream.streamId)
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
            return {
              streams,
              messages: event.message ? [...s.messages, event.message] : s.messages,
              error: event.type === 'error' ? (event.error ?? 'Errore sconosciuto') : s.error
            }
          })
        }
      }
    },

    clearError() {
      set({ error: null })
    }
  }
})
