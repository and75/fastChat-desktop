// Valori effettivi dei parametri del modello per una conversazione.
// Unica fonte di verità: il main li manda a Ollama, il renderer li mostra (pannello impostazioni,
// misuratore del contesto). Così ciò che l'utente vede è esattamente ciò che viene inviato.
import { OLLAMA_DEFAULTS, type ConversationSettings, type ModelCapabilities } from './types'

/** Parametri risolti: nessun "automatico", solo numeri. */
export interface EffectiveSettings {
  temperature: number
  topP: number
  /** Memoria della conversazione (num_ctx), mai oltre il contesto massimo del modello. */
  numCtx: number
  /** null = casuale a ogni risposta. */
  seed: number | null
  /** Ragionamento: solo se il modello lo supporta. */
  think: boolean
}

/** Da dove viene un valore automatico, per l'interfaccia. */
export type AutoSource = 'model' | 'ollama'

/** Contesto massimo del modello, se noto; altrimenti nessun limite. */
export function maxNumCtx(caps: ModelCapabilities | null | undefined): number | null {
  return caps?.contextLength ?? null
}

/**
 * Memoria della conversazione: la scelta dell'utente, altrimenti il `num_ctx` consigliato dal modello
 * (Modelfile), altrimenti il predefinito di Ollama. Mai oltre il contesto massimo del modello
 * (la scelta può superarlo dopo un cambio di modello).
 */
export function resolveNumCtx(conv: Pick<ConversationSettings, 'numCtx'>, caps: ModelCapabilities | null | undefined): number {
  const chosen = conv.numCtx ?? caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx
  const max = maxNumCtx(caps)
  return max != null && chosen > max ? max : chosen
}

/** Varietà delle parole: la scelta dell'utente, altrimenti il consigliato dal modello, altrimenti Ollama. */
export function resolveTopP(conv: Pick<ConversationSettings, 'topP'>, caps: ModelCapabilities | null | undefined): number {
  return conv.topP ?? caps?.defaults.topP ?? OLLAMA_DEFAULTS.topP
}

/** Origine del valore automatico di un parametro (per la dicitura "consigliato dal modello"/"predefinito di Ollama"). */
export function autoSource(caps: ModelCapabilities | null | undefined, key: 'topP' | 'numCtx'): AutoSource {
  return caps?.defaults[key] != null ? 'model' : 'ollama'
}

/** Tutti i parametri effettivi della conversazione con il modello indicato. */
export function resolveSettings(conv: ConversationSettings, caps: ModelCapabilities | null | undefined): EffectiveSettings {
  return {
    temperature: conv.temperature,
    topP: resolveTopP(conv, caps),
    numCtx: resolveNumCtx(conv, caps),
    seed: conv.seed,
    think: caps?.thinking === true && conv.think
  }
}
