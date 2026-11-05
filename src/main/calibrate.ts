// Calibrazione dei parametri di una conversazione sul modello scelto e sulla macchina.
import { suggestSettings, type SuggestedSettings, type SystemInfo } from '@shared/settings'
import type { ConversationPatch } from '@shared/types'
import type { OllamaClient } from './ollama'

export interface CalibrateDeps {
  ollama: OllamaClient
  system(): SystemInfo
}

/** Campi che la calibrazione riempie. */
export const CALIBRATED_KEYS = ['temperature', 'topP', 'numCtx'] as const

/**
 * Valori suggeriti per il modello. null se Ollama non risponde o non conosce il modello: in quel caso
 * la conversazione resta non calibrata e si riprova al prossimo caricamento.
 */
export async function suggestFor(deps: CalibrateDeps, model: string): Promise<SuggestedSettings | null> {
  if (!model) return null
  try {
    const [caps, models] = await Promise.all([deps.ollama.showModel(model), deps.ollama.listModels()])
    const modelBytes = models.find((m) => m.name === model)?.size ?? null
    return suggestSettings({ system: deps.system(), modelBytes, caps })
  } catch {
    return null
  }
}

/**
 * Patch di calibrazione: tutti i campi (cambio modello), oppure solo quelli ancora vuoti
 * (prima apertura di una conversazione non calibrata). {} se non c'è nulla da fare.
 */
export async function calibrationPatch(
  deps: CalibrateDeps,
  model: string,
  current: Partial<Record<(typeof CALIBRATED_KEYS)[number], number | null>>,
  onlyMissing: boolean
): Promise<ConversationPatch> {
  const missing = CALIBRATED_KEYS.filter((k) => current[k] == null)
  if (onlyMissing && missing.length === 0) return {}
  const suggested = await suggestFor(deps, model)
  if (!suggested) return {}
  const patch: ConversationPatch = {}
  for (const key of onlyMissing ? missing : CALIBRATED_KEYS) patch[key] = suggested[key]
  return patch
}
