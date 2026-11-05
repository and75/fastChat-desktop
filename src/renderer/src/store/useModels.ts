import { create } from 'zustand'
import type { SystemInfo } from '@shared/settings'
import type { AppSettings, ModelCapabilities, OllamaModel } from '@shared/types'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface ModelsState {
  settings: AppSettings | null
  models: OllamaModel[]
  status: Status
  error: string | null
  selected: string | null
  capabilities: Record<string, ModelCapabilities>
  /** RAM della macchina (se Ollama è locale): per il suggerimento della memoria della conversazione. */
  system: SystemInfo | null

  init(): Promise<void>
  refresh(): Promise<void>
  select(name: string): Promise<void>
  loadCapabilities(name: string): Promise<ModelCapabilities | null>
  loadSystem(): Promise<void>
  setOllamaUrl(url: string): Promise<boolean>
  /** Salva le impostazioni generali; se cambia l'URL ricarica i modelli. */
  saveSettings(patch: Partial<AppSettings>): Promise<string | null>
}

export const useModels = create<ModelsState>((set, get) => ({
  settings: null,
  models: [],
  status: 'idle',
  error: null,
  selected: null,
  capabilities: {},
  system: null,

  async init() {
    const res = await window.api.settings.get()
    if (res.ok) set({ settings: res.data, selected: res.data.defaultModel })
    await Promise.all([get().refresh(), get().loadSystem()])
  },

  async loadSystem() {
    const res = await window.api.system.info()
    set({ system: res.ok ? res.data : null })
  },

  async refresh() {
    set({ status: 'loading', error: null })
    const res = await window.api.models.list()
    if (!res.ok) {
      set({ status: 'error', error: res.error, models: [] })
      return
    }
    const models = res.data
    let selected = get().selected
    if (!selected || !models.some((m) => m.name === selected)) selected = models[0]?.name ?? null
    set({ status: 'ready', models, selected })
    if (selected) void get().loadCapabilities(selected)
  },

  async select(name) {
    set({ selected: name })
    void get().loadCapabilities(name)
    const res = await window.api.settings.set({ defaultModel: name })
    if (res.ok) set({ settings: res.data })
  },

  async loadCapabilities(name) {
    const cached = get().capabilities[name]
    if (cached) return cached
    const res = await window.api.models.capabilities(name)
    if (!res.ok) return null
    set((s) => ({ capabilities: { ...s.capabilities, [name]: res.data } }))
    return res.data
  },

  async saveSettings(patch) {
    const before = get().settings
    const res = await window.api.settings.set(patch)
    if (!res.ok) return res.error
    set({ settings: res.data })
    if (patch.defaultModel !== undefined) set({ selected: res.data.defaultModel })
    if (patch.ollamaUrl !== undefined && patch.ollamaUrl !== before?.ollamaUrl) {
      set({ capabilities: {} })
      await Promise.all([get().refresh(), get().loadSystem()])
    } else if (patch.kvCacheType !== undefined && patch.kvCacheType !== before?.kvCacheType) {
      await get().loadSystem()
    }
    return null
  },

  async setOllamaUrl(url) {
    const res = await window.api.settings.set({ ollamaUrl: url })
    if (!res.ok) {
      set({ status: 'error', error: res.error })
      return false
    }
    set({ settings: res.data, capabilities: {} })
    await Promise.all([get().refresh(), get().loadSystem()])
    return true
  }
}))
