import type { AppSettings, ModelCapabilities, OllamaModel, Result } from './types'

/** Contratto di `window.api`, implementato dal preload. */
export interface Api {
  models: {
    list(): Promise<Result<OllamaModel[]>>
    capabilities(name: string): Promise<Result<ModelCapabilities>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
}
