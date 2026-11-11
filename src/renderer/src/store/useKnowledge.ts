import { create } from 'zustand'
import type { KnowledgeBaseInfo, KnowledgeProgress, KnowledgeSourceInfo, KnowledgeStatus } from '@shared/types'

interface KnowledgeState {
  /** Plugin disponibili (etichette, estensioni), caricati una volta. */
  sources: KnowledgeSourceInfo[]
  /** Stato per «proprietario»: l'id di una conversazione (la sua base più le collegate) o di una base della libreria. */
  status: Record<string, KnowledgeStatus>
  /** Basi della libreria. */
  bases: KnowledgeBaseInfo[]
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
  /** «Intero» sì/no per un documento. */
  pin(conversationId: string, documentId: string, pinned: boolean): Promise<void>
  /** Sorgenti collegate: collega con la configurazione, aggiorna, scollega. Restituiscono false se fallisce. */
  connect(conversationId: string, sourceId: string, config: Record<string, string>): Promise<boolean>
  refresh(conversationId: string, connectionId: string): Promise<void>
  disconnect(conversationId: string, connectionId: string): Promise<void>
  /** Libreria: elenco, crea, rinomina, elimina; collega e scollega una base a una conversazione. */
  loadBases(): Promise<void>
  createBase(name: string): Promise<KnowledgeBaseInfo | null>
  renameBase(baseId: string, name: string): Promise<void>
  removeBase(baseId: string): Promise<void>
  link(conversationId: string, baseId: string): Promise<void>
  unlink(conversationId: string, baseId: string): Promise<void>
  handleProgress(p: KnowledgeProgress): void
  clearError(): void
}

export const useKnowledge = create<KnowledgeState>((set, get) => {
  const apply = (conversationId: string, status: KnowledgeStatus): void =>
    set((s) => ({ status: { ...s.status, [conversationId]: status } }))
  /** Ricarica ogni stato già caricato (dopo una modifica alla libreria che tocca più conversazioni). */
  const reloadAll = (): void => {
    for (const key of Object.keys(get().status)) void get().load(key)
  }

  return {
    sources: [],
    status: {},
    bases: [],
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

    async pin(conversationId, documentId, pinned) {
      const res = await window.api.knowledge.pin(conversationId, documentId, pinned)
      if (!res.ok) return set({ error: res.error })
      await get().load(conversationId)
    },

    async connect(conversationId, sourceId, config) {
      set({ busy: true, error: null })
      const res = await window.api.knowledge.connect(conversationId, sourceId, config)
      set({ busy: false })
      if (!res.ok) {
        set({ error: res.error })
        return false
      }
      await get().load(conversationId)
      return true
    },

    async refresh(conversationId, connectionId) {
      set({ error: null })
      const res = await window.api.knowledge.refresh(conversationId, connectionId)
      if (!res.ok) set({ error: res.error })
      await get().load(conversationId)
    },

    async disconnect(conversationId, connectionId) {
      const res = await window.api.knowledge.disconnect(conversationId, connectionId)
      if (!res.ok) return set({ error: res.error })
      apply(conversationId, res.data)
    },

    async loadBases() {
      const res = await window.api.knowledge.bases()
      if (res.ok) set({ bases: res.data })
    },

    async createBase(name) {
      set({ error: null })
      const res = await window.api.knowledge.createBase(name)
      if (!res.ok) {
        set({ error: res.error })
        return null
      }
      await get().loadBases()
      return res.data
    },

    async renameBase(baseId, name) {
      const res = await window.api.knowledge.updateBase(baseId, { name })
      if (!res.ok) return set({ error: res.error })
      await get().loadBases()
      reloadAll()
    },

    async removeBase(baseId) {
      const res = await window.api.knowledge.removeBase(baseId)
      if (!res.ok) return set({ error: res.error })
      set((s) => {
        const status = { ...s.status }
        delete status[baseId]
        return { bases: res.data, status }
      })
      // Le conversazioni che la collegavano non la vedono più.
      reloadAll()
    },

    async link(conversationId, baseId) {
      const res = await window.api.knowledge.link(conversationId, baseId)
      if (!res.ok) return set({ error: res.error })
      apply(conversationId, res.data)
      void get().loadBases()
    },

    async unlink(conversationId, baseId) {
      const res = await window.api.knowledge.unlink(conversationId, baseId)
      if (!res.ok) return set({ error: res.error })
      apply(conversationId, res.data)
      void get().loadBases()
    },

    handleProgress(p) {
      set((s) => {
        const progress = { ...s.progress }
        if (p.status === 'indexing') progress[p.documentId] = p
        else delete progress[p.documentId]
        // Il documento segue l'avanzamento in ogni stato che lo mostra, senza ricaricare tutto a ogni lotto.
        const status: Record<string, KnowledgeStatus> = {}
        for (const [key, st] of Object.entries(s.status)) {
          status[key] = st.documents.some((d) => d.id === p.documentId) ? { ...st, documents: st.documents.map((d) => (d.id === p.documentId ? { ...d, status: p.status } : d)) } : st
        }
        return { progress, status }
      })
      // A fine indicizzazione (o errore) lo stato completo arriva dal main: pezzi, errore, titolo letto dal plugin.
      // Si ricarica chi usa quella base: la base stessa, la conversazione proprietaria, quelle che la collegano.
      if (p.status !== 'indexing') {
        for (const [key, st] of Object.entries(get().status)) {
          if (key === p.baseId || st.baseId === p.baseId || st.baseId === null || st.linked.some((l) => l.id === p.baseId)) void get().load(key)
        }
        if (get().bases.length) void get().loadBases()
      }
    },

    clearError() {
      set({ error: null })
    }
  }
})

/** Documenti pronti che la conversazione può usare, basi collegate comprese (abilitano il bottone libro). */
export const readyCount = (status: KnowledgeStatus | undefined): number => status?.ready ?? 0

/** Documenti in tutto: quelli della conversazione più quelli delle basi collegate. */
export const documentCount = (status: KnowledgeStatus | undefined): number =>
  status ? status.documents.length + status.linked.reduce((n, b) => n + b.documents, 0) : 0
