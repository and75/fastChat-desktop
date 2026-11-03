import { create } from 'zustand'
import type { Conversation, ConversationPatch } from '@shared/types'
import { useChat } from './useChat'

interface ConversationsState {
  conversations: Conversation[]
  search: string
  showArchived: boolean
  activeId: string | null
  error: string | null

  refresh(): Promise<void>
  setSearch(search: string): void
  setShowArchived(value: boolean): void
  /** Nuova conversazione, vuota o da un template. */
  create(fromTemplateId?: string): Promise<void>
  select(id: string | null): Promise<void>
  update(id: string, patch: ConversationPatch): Promise<Conversation | null>
  remove(id: string): Promise<void>
  /** Aggiorna una voce della lista con la versione ricevuta dal main. */
  upsertLocal(conv: Conversation): void
}

const byUpdated = (a: Conversation, b: Conversation): number => b.updatedAt - a.updatedAt

export const useConversations = create<ConversationsState>((set, get) => ({
  conversations: [],
  search: '',
  showArchived: false,
  activeId: null,
  error: null,

  async refresh() {
    const { search, showArchived } = get()
    const res = await window.api.conversations.list({ search, archived: showArchived })
    if (res.ok) set({ conversations: res.data, error: null })
    else set({ error: res.error })
  },

  setSearch(search) {
    set({ search })
    void get().refresh()
  },

  setShowArchived(showArchived) {
    set({ showArchived })
    void get().refresh()
  },

  async create(fromTemplateId) {
    const res = await window.api.conversations.create(fromTemplateId)
    if (!res.ok) return set({ error: res.error })
    set({ search: '', showArchived: false })
    await get().refresh()
    await get().select(res.data.id)
  },

  async select(id) {
    set({ activeId: id })
    await useChat.getState().load(id)
  },

  async update(id, patch) {
    const res = await window.api.conversations.update(id, patch)
    if (!res.ok) {
      set({ error: res.error })
      return null
    }
    get().upsertLocal(res.data)
    useChat.getState().replaceConversation(res.data)
    return res.data
  },

  async remove(id) {
    const res = await window.api.conversations.remove(id)
    if (!res.ok) return set({ error: res.error })
    if (get().activeId === id) await get().select(null)
    set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
  },

  upsertLocal(conv) {
    set((s) => {
      const visible = conv.archived === s.showArchived
      const rest = s.conversations.filter((c) => c.id !== conv.id)
      return { conversations: visible ? [conv, ...rest].sort(byUpdated) : rest }
    })
  }
}))
