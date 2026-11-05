// Parametri del modello per una conversazione: valori suggeriti (calibrazione) e valori effettivi.
//
// Principio: il valore configurato nella conversazione è ciò che l'utente vede sul cursore e ciò che
// va a Ollama. L'app lo riempie quando si sceglie il modello (calibrazione), poi l'utente lo cambia
// a piacere. Le funzioni resolve* sono solo la rete di sicurezza per le conversazioni non ancora
// calibrate (create prima di questa versione, o con Ollama irraggiungibile).
import { OLLAMA_DEFAULTS, type ConversationSettings, type ModelCapabilities } from './types'

/** Parametri risolti: nessun "automatico", solo numeri. */
export interface EffectiveSettings {
  temperature: number
  topP: number
  /** Memoria della conversazione (num_ctx), mai oltre il contesto massimo del modello. */
  numCtx: number
  /** Token massimi per la risposta (num_predict): lo spazio riservato alla risposta nel contesto. */
  numPredict: number
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
}

// ---------------------------------------------------------------- calibrazione di num_ctx

/** Quota della RAM che Ollama può usare per il modello: più alta con memoria unificata. */
export const RAM_SHARE = { unified: 0.65, other: 0.5 } as const
/** Byte lasciati liberi oltre a pesi e contesto (sistema operativo, altre app). */
export const RAM_MARGIN_BYTES = 1024 ** 3
/** Costo in memoria di un token di contesto quando il modello non lo dichiara (~modelli da 3 a 14B). */
export const DEFAULT_KV_BYTES_PER_TOKEN = 128 * 1024
/** Limiti del suggerimento: sotto 2k il modello non è utilizzabile; sopra il massimo del modello non ha senso. */
export const MIN_NUM_CTX = 2048
/** Massimo usato se il modello non dichiara la lunghezza del contesto. */
export const FALLBACK_MAX_CTX = 32768

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
 * Calcolo di massima dalla RAM: (RAM × quota − pesi − margine) ÷ costo per token, arrotondato alla
 * potenza di 2 inferiore, tra MIN_NUM_CTX e il massimo del modello. null se mancano RAM o modello.
 */
export function suggestNumCtx({ system, modelBytes, caps }: SuggestNumCtxInput): number | null {
  if (!system?.ramBytes || !modelBytes) return null
  const usable = system.ramBytes * (system.unified ? RAM_SHARE.unified : RAM_SHARE.other)
  const forContext = usable - modelBytes - RAM_MARGIN_BYTES
  const perToken = caps?.kvBytesPerToken ?? DEFAULT_KV_BYTES_PER_TOKEN
  const tokens = forContext > 0 ? floorPow2(forContext / perToken) : 0
  return Math.max(MIN_NUM_CTX, Math.min(tokens, maxNumCtx(caps)))
}

/** Riga per l'interfaccia: da dove viene il suggerimento. */
export function describeSuggestion(input: SuggestNumCtxInput): string {
  const gb = (b: number): string => `${Math.round(b / 1024 ** 3)} GB`
  if (!input.system?.ramBytes) return 'Ollama non è su questa macchina: si usa il valore del modello.'
  if (!input.modelBytes) return 'Dimensione del modello non nota: si usa il valore del modello.'
  return `Calcolato su ${gb(input.system.ramBytes)} di RAM${input.system.unified ? ' unificata' : ''} e un modello da ${gb(input.modelBytes)}.`
}

// ---------------------------------------------------------------- lunghezza della risposta

/** Limiti del suggerimento per num_predict. */
export const NUM_PREDICT = { min: 1024, max: 8192, maxThinking: 16384, floor: 256 } as const

/**
 * Token massimi per la risposta: un quarto della memoria, tra 1k e 8k; il doppio con il ragionamento
 * (i token "pensati" contano), fino a 16k. Mai oltre metà della memoria: il resto è per brief e storico.
 */
export function suggestNumPredict(numCtx: number, think: boolean): number {
  const base = Math.min(NUM_PREDICT.max, Math.max(NUM_PREDICT.min, floorPow2(numCtx / 4)))
  const value = think ? Math.min(NUM_PREDICT.maxThinking, base * 2) : base
  return Math.max(NUM_PREDICT.floor, Math.min(value, floorPow2(numCtx / 2)))
}

/** Valori del cursore della lunghezza della risposta: potenze di 2 da 256 a metà della memoria. */
export function numPredictSteps(numCtx: number): number[] {
  const steps: number[] = []
  for (let v = NUM_PREDICT.floor; v <= Math.max(NUM_PREDICT.floor, numCtx / 2); v *= 2) steps.push(v)
  return steps
}

// ---------------------------------------------------------------- valori suggeriti e calibrazione

/** Valori con cui una conversazione parte per un dato modello: quelli che l'utente poi può cambiare. */
export interface SuggestedSettings {
  temperature: number
  topP: number
  numCtx: number
  numPredict: number
}

export interface SuggestSettingsInput extends SuggestNumCtxInput {
  /** Ragionamento acceso: la risposta suggerita è più lunga. */
  think: boolean
  /** Memoria già configurata, se c'è: la lunghezza della risposta si suggerisce su quella. */
  numCtx?: number | null
}

/**
 * Suggerimenti per il modello: num_ctx calibrato sulla macchina, altrimenti il Modelfile, altrimenti
 * Ollama; temperatura e top_p dal Modelfile, altrimenti Ollama; num_predict dalla memoria.
 */
export function suggestSettings(input: SuggestSettingsInput): SuggestedSettings {
  const { caps } = input
  const numCtx = suggestNumCtx(input) ?? Math.min(caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx, maxNumCtx(caps))
  return {
    temperature: caps?.defaults.temperature ?? OLLAMA_DEFAULTS.temperature,
    topP: caps?.defaults.topP ?? OLLAMA_DEFAULTS.topP,
    numCtx,
    numPredict: suggestNumPredict(input.numCtx ?? numCtx, input.think)
  }
}

/**
 * Se la lunghezza della risposta era quella suggerita, segue il nuovo suggerimento quando cambiano
 * memoria o ragionamento; un valore scelto dall'utente resta suo. Restituisce il nuovo numPredict o null.
 */
export function followNumPredict(
  before: Pick<ConversationSettings, 'numCtx' | 'numPredict' | 'think'>,
  after: Pick<ConversationSettings, 'numCtx' | 'think'>,
  caps: ModelCapabilities | null | undefined
): number | null {
  if (before.numPredict == null) return null
  const thinks = caps?.thinking === true
  const was = suggestNumPredict(resolveNumCtx(before, caps), thinks && before.think)
  const now = suggestNumPredict(resolveNumCtx(after, caps), thinks && after.think)
  return before.numPredict === was && was !== now ? now : null
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
    // La risposta non può occupare tutta la memoria: resta sempre almeno metà per brief e storico.
    numPredict: Math.min(conv.numPredict ?? suggestNumPredict(numCtx, think), floorPow2(Math.max(2, numCtx / 2))),
    seed: conv.seed,
    think
  }
}
