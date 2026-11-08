// Monitor del contesto: funzioni pure per descrivere cosa parte verso Ollama (stima per voce) e confrontarlo
// con quello che Ollama conta davvero (prompt_eval_count, eval_count).
import { t, type Key } from './i18n'
import { estimateTokens, splitTokens } from './prompt'
import type { ContextCall, ContextCallKind, ContextPart } from './types'

/** Nome del tipo di chiamata nella lingua attiva. */
export const callKindLabel = (kind: ContextCallKind): string => t(`call.${kind}`)

/** Etichette delle voci salvate come id (le chiamate registrate prima avevano il testo italiano). */
const PART_LABEL_KEYS: Record<string, Key> = {
  instructions: 'part.instructions',
  style: 'part.style',
  summary: 'part.summary',
  memory: 'part.memory',
  knowledge: 'part.knowledge',
  history: 'part.history',
  question: 'part.question',
  'transcript.qa': 'part.transcript.qa',
  'transcript.messages': 'part.transcript.messages',
  'summary.previous': 'part.summary.previous',
  'summary.condense': 'part.summary.condense',
  'texts.index': 'part.texts.index',
  'texts.query': 'part.texts.query',
  'texts.doc': 'part.texts.doc',
  answer: 'part.answer',
  ollama: 'part.ollamaDelta',
  // testi delle chiamate registrate prima della traduzione
  Istruzioni: 'part.instructions',
  'Stile della risposta': 'part.style',
  Riassunto: 'part.summary',
  'Estratti della memoria': 'part.memory',
  Storico: 'part.history',
  Domanda: 'part.question',
  'Domanda e risposta': 'part.transcript.qa',
  'Messaggi da riassumere': 'part.transcript.messages',
  'Riassunto precedente': 'part.summary.previous',
  'Riassunto da condensare': 'part.summary.condense',
  'Pezzi da indicizzare': 'part.texts.index',
  'Domanda e contesto': 'part.texts.query'
}

/** Etichetta di una voce nella lingua attiva (il testo salvato, se non è un id noto). */
export const partLabel = (label: string): string => (PART_LABEL_KEYS[label] ? t(PART_LABEL_KEYS[label]) : label)

export interface ChatPartsInput {
  /** System prompt inviato per intero. */
  system: string
  /** Le sue sezioni ('' se assenti): istruzioni (brief o prompt del piano), stile, riassunto, estratti. */
  instructions: string
  style: string
  summary: string
  memory: string
  /** Estratti dei documenti della base di conoscenza ('' se assenti). */
  knowledge?: string
  /** Messaggi coperti dal riassunto ed estratti scelti. */
  summaryCount: number
  memoryCount: number
  knowledgeCount?: number
  /** Messaggi inviati dopo il system prompt, in ordine. */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  cpt: number
}

/**
 * Voci di una richiesta di chat: il system prompt diviso tra istruzioni, stile, riassunto ed estratti
 * (la somma è la stima del system prompt intero), poi storico e domanda.
 */
export function chatParts(input: ChatPartsInput): ContextPart[] {
  const { cpt } = input
  const knowledge = input.knowledge ?? ''
  const [ti, ts, tsum, tm, tk] = splitTokens(input.system ? estimateTokens(input.system, cpt) : 0, [input.instructions, input.style, input.summary, input.memory, knowledge])
  const last = input.messages.at(-1)
  const question = last?.role === 'user' ? last : null
  const history = question ? input.messages.slice(0, -1) : input.messages
  const historyTokens = history.reduce((n, m) => n + estimateTokens(m.content, cpt), 0)
  return [
    ...(input.instructions.trim() ? [{ key: 'instructions' as const, label: 'instructions', tokens: ti }] : []),
    ...(input.style ? [{ key: 'style' as const, label: 'style', tokens: ts }] : []),
    ...(input.summary ? [{ key: 'summary' as const, label: 'summary', tokens: tsum, count: input.summaryCount }] : []),
    ...(input.memory ? [{ key: 'memory' as const, label: 'memory', tokens: tm, count: input.memoryCount }] : []),
    ...(knowledge ? [{ key: 'knowledge' as const, label: 'knowledge', tokens: tk, count: input.knowledgeCount ?? 0 }] : []),
    ...(history.length ? [{ key: 'history' as const, label: 'history', tokens: historyTokens, count: history.length }] : []),
    ...(question ? [{ key: 'question' as const, label: 'question', tokens: estimateTokens(question.content, cpt) }] : [])
  ]
}

export interface CallAnalysis {
  /** Totale inviato secondo le stime dell'app. */
  sent: number
  /** Token occupati secondo Ollama (prompt letto + risposta), null se Ollama non li ha dati. */
  occupied: number | null
  /** Prompt letto da Ollama meno la stima (positivo: la stima era bassa). */
  delta: number | null
  deltaShare: number | null
  /** Il prompt stimato non entrava in num_ctx, o Ollama ne ha letto molto meno: probabile taglio. */
  truncated: boolean
  /** Ollama ha letto molto meno della stima ma il prompt entrava: cache riusata o stima sbagliata. */
  readLess: boolean
}

/** Sotto questa quota della stima, il prompt letto da Ollama è "molto meno". */
const READ_LESS = 0.7

export function analyzeCall(call: Pick<ContextCall, 'parts' | 'numCtx' | 'promptEvalCount' | 'evalCount'>): CallAnalysis {
  const sent = call.parts.reduce((n, p) => n + p.tokens, 0)
  const read = call.promptEvalCount
  const occupied = read != null ? read + (call.evalCount ?? 0) : null
  const delta = read != null ? read - sent : null
  const deltaShare = read != null && sent > 0 ? (read - sent) / sent : null
  const over = call.numCtx != null && sent > call.numCtx
  const much = read != null && sent > 0 && read < sent * READ_LESS
  const truncated = over || (much && call.numCtx != null && read! >= call.numCtx * 0.9)
  return { sent, occupied, delta, deltaShare, truncated, readLess: much && !truncated }
}

export interface ReconcileRow {
  key: ContextPart['key'] | 'answer' | 'ollama'
  label: string
  /** Valore nella chiamata e ora (null = voce assente). */
  then: number | null
  now: number | null
  thenCount?: number
  nowCount?: number
  delta: number
}

const ORDER: Array<ContextPart['key']> = ['instructions', 'style', 'summary', 'memory', 'knowledge', 'history', 'question']

/**
 * Riconcilia l'ultima risposta con lo stato attuale: per ogni voce il valore di allora e di adesso. Allora:
 * voci inviate + risposta generata + scarto di Ollama (= occupato); ora: voci + scarto (= contatore).
 * La somma delle differenze è esattamente la differenza dei totali.
 */
export function reconcile(
  call: Pick<ContextCall, 'parts' | 'numCtx' | 'promptEvalCount' | 'evalCount'>,
  now: { used: number; parts: ContextPart[]; adjustment: number }
): { rows: ReconcileRow[]; thenTotal: number; nowTotal: number } {
  const a = analyzeCall(call)
  const rows: ReconcileRow[] = []
  for (const key of ORDER) {
    const t = call.parts.find((p) => p.key === key)
    const n = now.parts.find((p) => p.key === key)
    if (!t && !n) continue
    rows.push({ key, label: (t ?? n)!.label, then: t?.tokens ?? null, now: n?.tokens ?? null, thenCount: t?.count, nowCount: n?.count, delta: (n?.tokens ?? 0) - (t?.tokens ?? 0) })
  }
  const answer = call.evalCount ?? 0
  if (answer) rows.push({ key: 'answer', label: 'answer', then: answer, now: null, delta: -answer })
  const thenAdj = a.delta ?? 0
  if (thenAdj || now.adjustment) rows.push({ key: 'ollama', label: 'ollama', then: thenAdj || null, now: now.adjustment || null, delta: now.adjustment - thenAdj })
  return { rows, thenTotal: a.sent + answer + thenAdj, nowTotal: now.used }
}
