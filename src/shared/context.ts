// Monitor del contesto: funzioni pure per descrivere cosa parte verso Ollama (stima per voce) e confrontarlo
// con quello che Ollama conta davvero (prompt_eval_count, eval_count).
import { estimateTokens } from './prompt'
import type { ContextCall, ContextCallKind, ContextPart } from './types'

export const CALL_LABELS: Record<ContextCallKind, string> = {
  chat: 'Risposta',
  plan: 'Piano',
  execute: 'Risposta col piano',
  summary: 'Riassunto',
  condense: 'Riassunto (condensa)',
  title: 'Titolo',
  'embed-index': 'Indicizzazione memoria',
  'embed-query': 'Ricerca nella memoria'
}

/** Voce con i token stimati; le voci vuote non compaiono. */
export function part(key: ContextPart['key'], label: string, text: string, cpt: number, count?: number): ContextPart[] {
  if (!text.trim()) return []
  return [{ key, label, tokens: estimateTokens(text, cpt), ...(count != null ? { count } : {}) }]
}

export interface ChatPartsInput {
  /** System prompt della modalità (brief + stile, o prompt del piano), senza riassunto né estratti. */
  base: string
  /** Sezione dello stile contenuta in `base` ('' se assente). */
  style: string
  /** Sezione del riassunto aggiunta al system prompt ('' se non c'è). */
  summary: string
  /** Sezione degli estratti della memoria ('' se non ci sono). */
  memory: string
  memoryCount: number
  /** Messaggi inviati dopo il system prompt, in ordine. */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  cpt: number
}

/** Voci di una richiesta di chat: istruzioni, stile, riassunto, estratti, storico, domanda. */
export function chatParts(input: ChatPartsInput): ContextPart[] {
  const { cpt } = input
  const instructions = input.style && input.base.includes(input.style) ? input.base.replace(input.style, '') : input.base
  const last = input.messages.at(-1)
  const question = last?.role === 'user' ? last : null
  const history = question ? input.messages.slice(0, -1) : input.messages
  const historyTokens = history.reduce((n, m) => n + estimateTokens(m.content, cpt), 0)
  return [
    ...part('instructions', 'Istruzioni', instructions, cpt),
    ...(input.style && input.base.includes(input.style) ? part('style', 'Stile della risposta', input.style, cpt) : []),
    ...part('summary', 'Riassunto', input.summary, cpt),
    ...part('memory', 'Estratti della memoria', input.memory, cpt, input.memoryCount),
    ...(history.length ? [{ key: 'history' as const, label: 'Storico', tokens: historyTokens, count: history.length }] : []),
    ...(question ? part('question', 'Domanda', question.content, cpt) : [])
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
