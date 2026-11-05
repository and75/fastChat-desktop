// Calibrazione dei parametri di una conversazione sul modello scelto e sulla macchina.
import { suggestSettings, type SuggestedSettings, type SystemInfo } from '@shared/settings'
import type { ConversationPatch } from '@shared/types'
import type { OllamaClient } from './ollama'

export interface CalibrateDeps {
  ollama: OllamaClient
  system(): SystemInfo | Promise<SystemInfo>
}

/** Campi che la calibrazione riempie. */
export const CALIBRATED_KEYS = ['temperature', 'topP', 'numCtx', 'numPredict'] as const

/** Stato della conversazione che influenza i suggerimenti. */
export interface CalibrationContext {
  think?: boolean
  /** Memoria già configurata: la lunghezza della risposta si suggerisce su quella. */
  numCtx?: number | null
}

/**
 * Valori suggeriti per il modello. null se Ollama non risponde o non conosce il modello: in quel caso
 * la conversazione resta non calibrata e si riprova al prossimo caricamento.
 */
export async function suggestFor(deps: CalibrateDeps, model: string, ctx: CalibrationContext = {}): Promise<SuggestedSettings | null> {
  if (!model) return null
  try {
    const [caps, models] = await Promise.all([deps.ollama.showModel(model), deps.ollama.listModels()])
    const modelBytes = models.find((m) => m.name === model)?.size ?? null
    return suggestSettings({ system: await deps.system(), modelBytes, caps, think: ctx.think === true && caps.thinking, numCtx: ctx.numCtx })
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
  current: Partial<Record<(typeof CALIBRATED_KEYS)[number], number | null>> & { think?: boolean },
  onlyMissing: boolean
): Promise<ConversationPatch> {
  const missing = CALIBRATED_KEYS.filter((k) => current[k] == null)
  if (onlyMissing && missing.length === 0) return {}
  // Se la memoria resta quella configurata, la lunghezza della risposta si calcola su di essa.
  const suggested = await suggestFor(deps, model, { think: current.think, numCtx: onlyMissing ? current.numCtx : null })
  if (!suggested) return {}
  const patch: ConversationPatch = {}
  for (const key of onlyMissing ? missing : CALIBRATED_KEYS) patch[key] = suggested[key]
  return patch
}
