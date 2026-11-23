// Calibrazione dei parametri di una conversazione sul modello scelto e sulla macchina.
import { suggestSettings, type SuggestedSettings, type SystemInfo } from '@shared/settings'
import type { ConversationPatch, ModelSetting } from '@shared/types'
import type { OllamaClient } from './ollama'

export interface CalibrateDeps {
  ollama: OllamaClient
  system(): SystemInfo | Promise<SystemInfo>
  /** Nome del modello di embedding delle Impostazioni: se è installato, occupa memoria insieme a quello di chat. */
  embeddingModel?(): string | Promise<string>
  /** Configurazione del modello: gira solo in CPU? un caricamento è già fallito per memoria insufficiente? */
  modelSetting?(model: string): Promise<Pick<ModelSetting, 'numGpu' | 'failedNumCtx'> | null>
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
    const sizeOf = (name: string | undefined): number | null => (name ? (models.find((m) => m.name === name || m.name === `${name}:latest`)?.size ?? null) : null)
    const setting = (await deps.modelSetting?.(model)) ?? null
    const embedding = await deps.embeddingModel?.()
    return suggestSettings({
      system: await deps.system(),
      modelBytes: sizeOf(model),
      caps,
      // Il modello di embedding conta solo se è un altro modello.
      embeddingBytes: embedding && embedding !== model ? sizeOf(embedding) : null,
      cpuOnly: setting?.numGpu === 0,
      failedNumCtx: setting?.failedNumCtx ?? null
    })
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
