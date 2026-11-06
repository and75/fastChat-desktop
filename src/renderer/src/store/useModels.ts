import { create } from 'zustand'
import type { SystemInfo } from '@shared/settings'
import type { AppSettings, BenchmarkProgress, ModelCapabilities, ModelSetting, ModelSettingPatch, OllamaModel, PullProgress } from '@shared/types'

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
  /** Configurazione di esecuzione (CPU/GPU) per modello, dal database. */
  modelSettings: Record<string, ModelSetting>
  /** Download e test in corso, per modello. */
  pulls: Record<string, PullProgress>
  benchmarks: Record<string, BenchmarkProgress>

  loadModelSettings(): Promise<void>
  setModelSetting(model: string, patch: ModelSettingPatch): Promise<string | null>
  benchmark(model: string): Promise<string | null>
  pull(name: string): Promise<string | null>
  removeModel(name: string): Promise<string | null>

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
  modelSettings: {},
  pulls: {},
  benchmarks: {},

  async init() {
    window.api.models.onPullProgress((p) => set((s) => ({ pulls: { ...s.pulls, [p.model]: p } })))
    window.api.models.onBenchmarkProgress((p) => set((s) => ({ benchmarks: { ...s.benchmarks, [p.model]: p } })))
    const res = await window.api.settings.get()
    if (res.ok) set({ settings: res.data, selected: res.data.defaultModel })
    await Promise.all([get().refresh(), get().loadSystem(), get().loadModelSettings()])
  },

  async loadModelSettings() {
    const res = await window.api.models.settings()
    if (res.ok) set({ modelSettings: Object.fromEntries(res.data.map((m) => [m.model, m])) })
  },

  async setModelSetting(model, patch) {
    const res = await window.api.models.setSetting(model, patch)
    if (!res.ok) return res.error
    set((s) => ({ modelSettings: { ...s.modelSettings, [model]: res.data } }))
    return null
  },

  async benchmark(model) {
    set((s) => ({ benchmarks: { ...s.benchmarks, [model]: { model, step: 0, steps: 3, label: 'Preparazione' } } }))
    const res = await window.api.models.benchmark(model)
    set((s) => {
      const benchmarks = { ...s.benchmarks }
      delete benchmarks[model]
      return res.ok ? { benchmarks, modelSettings: { ...s.modelSettings, [model]: res.data } } : { benchmarks }
    })
    return res.ok ? null : res.error
  },

  async pull(name) {
    set((s) => ({ pulls: { ...s.pulls, [name]: { model: name, status: 'avvio', completed: null, total: null, done: false } } }))
    const res = await window.api.models.pull(name)
    set((s) => {
      const pulls = { ...s.pulls }
      delete pulls[name]
      return { pulls }
    })
    if (!res.ok) return res.error
    set({ capabilities: {} })
    await get().refresh()
    return null
  },

  async removeModel(name) {
    const res = await window.api.models.remove(name)
    if (!res.ok) return res.error
    set((s) => {
      const modelSettings = { ...s.modelSettings }
      delete modelSettings[name]
      return { modelSettings }
    })
    await get().refresh()
    return null
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
