import { create } from 'zustand'
import type { KnowledgeDocument, KnowledgeProgress, KnowledgeSourceInfo, KnowledgeStatus } from '@shared/types'

interface KnowledgeState {
  /** Plugin disponibili (etichette, estensioni), caricati una volta. */
  sources: KnowledgeSourceInfo[]
  /** Stato della base di conoscenza, per conversazione. */
  status: Record<string, KnowledgeStatus>
  /** Avanzamento dell'indicizzazione in corso, per documento. */
  progress: Record<string, KnowledgeProgress>
  error: string | null
  busy: boolean

  init(): Promise<void>
  load(conversationId: string): Promise<void>
  pickFiles(conversationId: string): Promise<void>
  addFiles(conversationId: string, paths: string[]): Promise<void>
  remove(conversationId: string, documentId: string): Promise<void>
  reindex(conversationId: string, documentId: string): Promise<void>
  handleProgress(p: KnowledgeProgress): void
  clearError(): void
}

export const useKnowledge = create<KnowledgeState>((set, get) => {
  const apply = (conversationId: string, status: KnowledgeStatus): void =>
    set((s) => ({ status: { ...s.status, [conversationId]: status } }))

  return {
    sources: [],
    status: {},
    progress: {},
    error: null,
    busy: false,

    async init() {
      const res = await window.api.knowledge.sources()
      if (res.ok) set({ sources: res.data })
    },

    async load(conversationId) {
      const res = await window.api.knowledge.status(conversationId)
      if (res.ok) apply(conversationId, res.data)
    },

    async pickFiles(conversationId) {
      set({ busy: true, error: null })
      const res = await window.api.knowledge.pickFiles(conversationId)
      set({ busy: false })
      if (!res.ok) return set({ error: res.error })
      if (res.data) await get().load(conversationId)
    },

    async addFiles(conversationId, paths) {
      if (paths.length === 0) return
      set({ busy: true, error: null })
      const res = await window.api.knowledge.addFiles(conversationId, paths)
      set({ busy: false })
      if (!res.ok) set({ error: res.error })
      await get().load(conversationId)
    },

    async remove(conversationId, documentId) {
      const res = await window.api.knowledge.remove(conversationId, documentId)
      if (!res.ok) return set({ error: res.error })
      apply(conversationId, res.data)
    },

    async reindex(conversationId, documentId) {
      set({ error: null })
      const res = await window.api.knowledge.reindex(conversationId, documentId)
      if (!res.ok) return set({ error: res.error })
      await get().load(conversationId)
    },

    handleProgress(p) {
      set((s) => {
        const progress = { ...s.progress }
        if (p.status === 'indexing') progress[p.documentId] = p
        else delete progress[p.documentId]
        // Il documento nello stato segue l'avanzamento, senza ricaricare tutto a ogni lotto.
        const current = s.status[p.conversationId]
        const status = current ? { ...current, documents: current.documents.map((d) => (d.id === p.documentId ? { ...d, status: p.status } : d)) } : current
        return { progress, status: status ? { ...s.status, [p.conversationId]: status } : s.status }
      })
      // A fine indicizzazione (o errore) lo stato completo arriva dal main: pezzi, errore, titolo letto dal plugin.
      if (p.status !== 'indexing') void get().load(p.conversationId)
    },

    clearError() {
      set({ error: null })
    }
  }
})

/** Documenti pronti della conversazione (abilitano il bottone libro). */
export const readyDocuments = (status: KnowledgeStatus | undefined): KnowledgeDocument[] =>
  status?.documents.filter((d) => d.status === 'ready') ?? []
