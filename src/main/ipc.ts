import { ipcMain } from 'electron'
import { IPC, type AppSettings, type Result } from '@shared/types'
import type { Db } from './db/client'
import { getSettings, setSettings } from './db/repo'
import { OllamaError, type OllamaClient } from './ollama'

export interface IpcDeps {
  db: Db
  ollama: OllamaClient
  /** Aggiorna l'URL di Ollama usato dal client (tenuto in memoria nel main). */
  setOllamaUrl(url: string): void
}

function toMessage(err: unknown): string {
  if (err instanceof OllamaError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** Avvolge un handler: il renderer riceve sempre un Result, mai un'eccezione serializzata a metà. */
function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(...(args as A)) }
    } catch (err) {
      return { ok: false, error: toMessage(err) }
    }
  })
}

export function registerIpc({ db, ollama, setOllamaUrl }: IpcDeps): void {
  handle(IPC.modelsList, () => ollama.listModels())

  handle(IPC.modelsCapabilities, (name: string) => {
    if (typeof name !== 'string' || !name) throw new Error('Nome modello mancante')
    return ollama.showModel(name)
  })

  handle(IPC.settingsGet, () => getSettings(db))

  handle(IPC.settingsSet, async (patch: Partial<AppSettings>) => {
    if (patch.ollamaUrl !== undefined) {
      const parsed = new URL(patch.ollamaUrl) // lancia se non valido
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL di Ollama non valido')
    }
    const next = await setSettings(db, patch)
    if (patch.ollamaUrl !== undefined) {
      setOllamaUrl(next.ollamaUrl)
      ollama.clearCache()
    }
    return next
  })
}
