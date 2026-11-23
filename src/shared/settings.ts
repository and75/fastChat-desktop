// Parametri del modello per una conversazione: valori suggeriti (calibrazione) e valori effettivi.
import { fmtInt, fmtNum, t } from './i18n'
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
 * Tabella dei valori fissi del calcolo.
 * Quota della RAM che il modello può davvero occupare, secondo dove gira:
 * - `cpu`: il modello gira solo in CPU (0 layer su GPU): tutta la RAM;
 * - `unified`: memoria unificata (Mac Apple Silicon): la GPU ne usa circa due terzi;
 * - `shared`: gli altri computer. Una GPU integrata prende la memoria dalla RAM e il sistema gliene concede
 *   circa la metà; con una scheda dedicata il valore è prudente.
 * Margine: buffer di calcolo di Ollama, sistema e altre applicazioni.
 */
export const MEMORY_SHARE = { cpu: 1, unified: 2 / 3, shared: 1 / 2 } as const
export type MemoryKind = keyof typeof MEMORY_SHARE
export const MEMORY_MARGIN_BYTES = 1.5 * 1024 ** 3

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
  /** Pesi del modello di embedding, se installato: sta in memoria insieme a quello di chat. */
  embeddingBytes?: number | null
  /** Il modello è configurato per girare solo in CPU (0 layer su GPU). */
  cpuOnly?: boolean
  /** Memoria con cui il caricamento di questo modello è già fallito per memoria insufficiente, se è successo. */
  failedNumCtx?: number | null
}

/** Potenza di 2 minore o uguale a n (n ≥ 1). */
export const floorPow2 = (n: number): number => 2 ** Math.floor(Math.log2(n))

/** Contesto massimo del modello, o il valore di riserva se ignoto. */
export const maxNumCtx = (caps: ModelCapabilities | null | undefined): number => caps?.contextLength ?? FALLBACK_MAX_CTX

/** Dove gira il modello, per la quota della tabella. */
export function memoryKind(input: Pick<SuggestNumCtxInput, 'system' | 'cpuOnly'>): MemoryKind {
  return input.cpuOnly ? 'cpu' : input.system?.unified ? 'unified' : 'shared'
}

/**
 * Conti della memoria per questa macchina e questo modello, in byte:
 * utilizzabile (RAM × quota) − pesi del modello − pesi del modello di embedding − margine = memoria per il contesto.
 * null se mancano RAM o dimensione del modello.
 */
export function memoryBudget(input: SuggestNumCtxInput): { kind: MemoryKind; usable: number; embedding: number; context: number } | null {
  const { system, modelBytes } = input
  if (!system?.ramBytes || !modelBytes) return null
  const kind = memoryKind(input)
  const usable = system.ramBytes * MEMORY_SHARE[kind]
  const embedding = input.embeddingBytes ?? 0
  return { kind, usable, embedding, context: usable - modelBytes - embedding - MEMORY_MARGIN_BYTES }
}

/**
 * Token di contesto che stanno nella memoria per il contesto: byte ÷ costo per token, arrotondato alla potenza
 * di 2 inferiore (0 se non resta spazio). null se mancano RAM o dimensione del modello.
 */
export function ramNumCtx(input: SuggestNumCtxInput): number | null {
  const budget = memoryBudget(input)
  if (!budget) return null
  const perToken = (input.caps?.kvBytesPerToken ?? DEFAULT_KV_BYTES_PER_TOKEN) * KV_CACHE_SCALE[input.system!.kvCacheType]
  const tokens = budget.context / perToken
  return tokens >= 1 ? floorPow2(tokens) : 0
}

/**
 * Memoria della conversazione suggerita per questa macchina e questo modello, in token: ciò che sta in memoria,
 * tra il minimo consigliato (minNumCtx) e il massimo del modello. Se un caricamento è già fallito per memoria
 * insufficiente, il suggerimento resta sotto quel valore (la metà). null se mancano RAM o modello.
 */
export function suggestNumCtx(input: SuggestNumCtxInput): number | null {
  const tokens = ramNumCtx(input)
  if (tokens == null) return null
  const fits = Math.max(MIN_NUM_CTX, minNumCtx(input.caps), Math.min(tokens, maxNumCtx(input.caps)))
  const safe = input.failedNumCtx ? (reducedNumCtx(input.failedNumCtx) ?? MIN_NUM_CTX) : null
  return safe != null ? Math.min(fits, safe) : fits
}

/** Vero se il suggerimento è stato abbassato perché un caricamento è già fallito per memoria insufficiente. */
export function suggestionLowered(input: SuggestNumCtxInput): boolean {
  const withoutFailure = suggestNumCtx({ ...input, failedNumCtx: null })
  const actual = suggestNumCtx(input)
  return withoutFailure != null && actual != null && actual < withoutFailure
}

/** Gigabyte con al massimo un decimale, nella lingua attiva («1,5 GB»). */
const gb = (bytes: number): string => `${fmtNum(bytes / 1024 ** 3, 1)} GB`

/** Riga per l'interfaccia: da dove viene il suggerimento, con i conti della memoria. */
export function describeSuggestion(input: SuggestNumCtxInput): string {
  if (!input.system?.ramBytes) return t('suggest.remote')
  const budget = memoryBudget(input)
  if (!budget || !input.modelBytes) return t('suggest.noSize')
  const computed = t('suggest.computed', {
    usable: gb(budget.usable),
    share: t(`suggest.share.${budget.kind}`, { ram: gb(input.system.ramBytes) }),
    model: gb(input.modelBytes),
    embedding: budget.embedding ? t('suggest.embedding', { size: gb(budget.embedding) }) : '',
    margin: gb(MEMORY_MARGIN_BYTES),
    kv: input.system.kvCacheType === 'f16' ? '.' : t('suggest.kv', { type: input.system.kvCacheType })
  })
  return suggestionLowered(input) ? computed + t('suggest.failed', { tokens: fmtInt(input.failedNumCtx!) }) : computed
}

/**
 * Dopo «memoria insufficiente»: la memoria della conversazione con cui riprovare, la metà di quella attuale
 * (potenza di 2), mai sotto MIN_NUM_CTX. null se è già al minimo: ridurre ancora non serve.
 */
export function reducedNumCtx(numCtx: number): number | null {
  const next = Math.max(MIN_NUM_CTX, floorPow2(Math.max(1, numCtx / 2)))
  return next < numCtx ? next : null
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
