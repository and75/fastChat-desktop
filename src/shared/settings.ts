// Parametri del modello per una conversazione: valori suggeriti (calibrazione) e valori effettivi.
//
// Principio: il valore configurato nella conversazione è ciò che l'utente vede sul cursore e ciò che
// va a Ollama. L'app lo riempie quando si sceglie il modello (calibrazione), poi l'utente lo cambia
// a piacere. Le funzioni resolve* sono solo la rete di sicurezza per le conversazioni non ancora
// calibrate (create prima di questa versione, o con Ollama irraggiungibile).
import { OLLAMA_DEFAULTS, type ConversationSettings, type KvCacheType, type ModelCapabilities } from './types'

/** Parametri risolti: nessun "automatico", solo numeri. */
export interface EffectiveSettings {
  temperature: number
  topP: number
  /** Memoria della conversazione (num_ctx), mai oltre il contesto massimo del modello. */
  numCtx: number
  /** Token lasciati liberi per la risposta quando si taglia lo storico (non è un limite per il modello). */
  reserveTokens: number
  /** null = casuale a ogni risposta. */
  seed: number | null
  /** Ragionamento: solo se il modello lo supporta. */
  think: boolean
}

/** Informazioni sulla macchina su cui gira Ollama, per dimensionare la memoria della conversazione. */
export interface SystemInfo {
  /** RAM totale in byte; null se Ollama non è su questa macchina (URL remoto) o non è leggibile. */
  ramBytes: number | null
  /** Memoria unificata (Mac Apple Silicon): la GPU usa la RAM di sistema. */
  unified: boolean
  /** Tipo della cache KV del server Ollama (impostazione dell'app, default f16). */
  kvCacheType: KvCacheType
}

/**
 * Byte per valore della cache KV rispetto a f16 (2 byte): q8_0 = 34 byte ogni 32 valori, q4_0 = 18 ogni 32.
 * Con la cache quantizzata (OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE) ogni token costa meno.
 */
export const KV_CACHE_SCALE: Record<KvCacheType, number> = { f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 }

// ---------------------------------------------------------------- calibrazione di num_ctx

/** Costo in memoria di un token di contesto quando il modello non lo dichiara (~modelli da 3 a 14B). */
export const DEFAULT_KV_BYTES_PER_TOKEN = 128 * 1024
/** Limiti del suggerimento: sotto 2k il modello non è utilizzabile; sopra il massimo del modello non ha senso. */
export const MIN_NUM_CTX = 2048
/** Massimo usato se il modello non dichiara la lunghezza del contesto. */
export const FALLBACK_MAX_CTX = 32768

/**
 * Memoria minima consigliata: il num_ctx predefinito di Ollama per il modello (Modelfile, altrimenti 4096),
 * entro il massimo del modello. Sotto questa soglia l'app avvisa; il suggerimento non ci scende mai.
 */
export function minNumCtx(caps: ModelCapabilities | null | undefined): number {
  return Math.min(caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx, maxNumCtx(caps))
}

export interface SuggestNumCtxInput {
  system: SystemInfo | null
  /** Dimensione del file del modello (pesi), da /api/tags. */
  modelBytes: number | null
  caps: ModelCapabilities | null
}

/** Potenza di 2 minore o uguale a n (n ≥ 1). */
export const floorPow2 = (n: number): number => 2 ** Math.floor(Math.log2(n))

/** Contesto massimo del modello, o il valore di riserva se ignoto. */
export const maxNumCtx = (caps: ModelCapabilities | null | undefined): number => caps?.contextLength ?? FALLBACK_MAX_CTX

/**
 * Memoria della conversazione suggerita per questa macchina e questo modello, in token.
 * Calcolo di massima dalla RAM: (RAM − pesi) ÷ costo per token, arrotondato alla potenza di 2
 * inferiore, tra il minimo consigliato (minNumCtx) e il massimo del modello. null se mancano RAM o modello.
 */
export function suggestNumCtx({ system, modelBytes, caps }: SuggestNumCtxInput): number | null {
  if (!system?.ramBytes || !modelBytes) return null
  // Nessuna quota prudenziale: tutta la RAM meno i pesi del modello. L'utente abbassa se serve.
  const forContext = system.ramBytes - modelBytes
  const perToken = (caps?.kvBytesPerToken ?? DEFAULT_KV_BYTES_PER_TOKEN) * KV_CACHE_SCALE[system.kvCacheType]
  const tokens = forContext > 0 ? floorPow2(forContext / perToken) : 0
  return Math.max(MIN_NUM_CTX, minNumCtx(caps), Math.min(tokens, maxNumCtx(caps)))
}

/** Riga per l'interfaccia: da dove viene il suggerimento. */
export function describeSuggestion(input: SuggestNumCtxInput): string {
  const gb = (b: number): string => `${Math.round(b / 1024 ** 3)} GB`
  if (!input.system?.ramBytes) return 'Ollama non è su questa macchina: si usa il valore del modello.'
  if (!input.modelBytes) return 'Dimensione del modello non nota: si usa il valore del modello.'
  return (
    `Calcolato su ${gb(input.system.ramBytes)} di RAM${input.system.unified ? ' unificata' : ''} e un modello da ${gb(input.modelBytes)}` +
    (input.system.kvCacheType === 'f16' ? '.' : `, con cache KV ${input.system.kvCacheType}.`)
  )
}

// ---------------------------------------------------------------- riserva per la risposta

/** Quota fissa della memoria lasciata sempre libera per la risposta (non è un limite per il modello). */
export const RESERVE_SHARE = 0.2

/** Token lasciati liberi per la risposta: il 20% della memoria. */
export function reserveTokensFor(numCtx: number): number {
  return Math.floor(numCtx * RESERVE_SHARE)
}

// ---------------------------------------------------------------- valori suggeriti e calibrazione

/** Valori con cui una conversazione parte per un dato modello: quelli che l'utente poi può cambiare. */
export interface SuggestedSettings {
  temperature: number
  topP: number
  numCtx: number
}

/**
 * Suggerimenti per il modello: num_ctx calibrato sulla macchina, altrimenti il Modelfile, altrimenti
 * Ollama; temperatura e top_p dal Modelfile, altrimenti Ollama.
 */
export function suggestSettings(input: SuggestNumCtxInput): SuggestedSettings {
  const { caps } = input
  const numCtx = suggestNumCtx(input) ?? Math.min(caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx, maxNumCtx(caps))
  return {
    temperature: caps?.defaults.temperature ?? OLLAMA_DEFAULTS.temperature,
    topP: caps?.defaults.topP ?? OLLAMA_DEFAULTS.topP,
    numCtx
  }
}

// ---------------------------------------------------------------- valori effettivi

/** Memoria della conversazione: il valore configurato, mai oltre il contesto massimo del modello. */
export function resolveNumCtx(conv: Pick<ConversationSettings, 'numCtx'>, caps: ModelCapabilities | null | undefined): number {
  const configured = conv.numCtx ?? caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx
  return Math.min(configured, maxNumCtx(caps))
}

/** Varietà delle parole: il valore configurato, altrimenti il Modelfile, altrimenti Ollama. */
export function resolveTopP(conv: Pick<ConversationSettings, 'topP'>, caps: ModelCapabilities | null | undefined): number {
  return conv.topP ?? caps?.defaults.topP ?? OLLAMA_DEFAULTS.topP
}

/** Tutti i parametri effettivi della conversazione con il modello indicato. */
export function resolveSettings(conv: ConversationSettings, caps: ModelCapabilities | null | undefined): EffectiveSettings {
  const numCtx = resolveNumCtx(conv, caps)
  const think = caps?.thinking === true && conv.think
  return {
    temperature: conv.temperature,
    topP: resolveTopP(conv, caps),
    numCtx,
    reserveTokens: reserveTokensFor(numCtx),
    seed: conv.seed,
    think
  }
}
