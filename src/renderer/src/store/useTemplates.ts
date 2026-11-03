import { create } from 'zustand'
import type { BriefTemplate } from '@shared/types'

interface TemplatesState {
  templates: BriefTemplate[]
  error: string | null
  refresh(): Promise<void>
  /** Salva brief e impostazioni della conversazione come template. */
  saveFrom(conversationId: string, name: string): Promise<boolean>
  remove(id: string): Promise<void>
}

export const useTemplates = create<TemplatesState>((set, get) => ({
  templates: [],
  error: null,

  async refresh() {
    const res = await window.api.templates.list()
    if (res.ok) set({ templates: res.data, error: null })
    else set({ error: res.error })
  },

  async saveFrom(conversationId, name) {
    const res = await window.api.templates.create(conversationId, name)
    if (!res.ok) {
      set({ error: res.error })
      return false
    }
    await get().refresh()
    return true
  },

  async remove(id) {
    const res = await window.api.templates.remove(id)
    if (!res.ok) return set({ error: res.error })
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
  }
}))
