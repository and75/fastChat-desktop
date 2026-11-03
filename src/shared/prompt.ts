// Funzioni pure per comporre i prompt. Condivise: il main le usa per le chiamate a Ollama,
// il renderer per l'anteprima del system prompt nel BriefPanel.
import type { Brief } from './types'

const SECTIONS: Array<[keyof Brief, string]> = [
  ['role', 'Ruolo'],
  ['context', 'Contesto'],
  ['goals', 'Obiettivi'],
  ['constraints', 'Vincoli']
]

/**
 * Compone il system prompt dal brief: solo le sezioni non vuote, nell'ordine
 * Ruolo, Contesto, Obiettivi, Vincoli. Restituisce '' se il brief è vuoto.
 */
export function buildSystemPrompt(brief: Brief): string {
  return SECTIONS.map(([key, title]) => [title, brief[key]?.trim() ?? ''] as const)
    .filter(([, body]) => body.length > 0)
    .map(([title, body]) => `# ${title}\n${body}`)
    .join('\n\n')
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HistoryLimits {
  /** Numero massimo di messaggi dello storico da inviare. */
  maxMessages: number
  /** Budget in token per l'intera richiesta (tipicamente num_ctx). */
  maxTokens: number
  /** Token riservati alla risposta del modello. */
  reserveTokens: number
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxMessages: 50,
  maxTokens: 8192,
  reserveTokens: 1024
}

/** Stima grossolana: ~4 caratteri per token, più un piccolo costo fisso per messaggio. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4) + 4

/**
 * Sceglie gli ultimi messaggi dello storico che stanno nel budget.
 * Il system prompt (brief) non si tronca mai: il suo costo si sottrae dal budget.
 * L'ultimo messaggio è sempre incluso, anche se da solo supera il budget.
 */
export function selectHistory<T extends HistoryMessage>(
  history: T[],
  systemPrompt: string,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS
): T[] {
  if (history.length === 0) return []
  let budget = limits.maxTokens - limits.reserveTokens - (systemPrompt ? estimateTokens(systemPrompt) : 0)
  const picked: T[] = []
  for (let i = history.length - 1; i >= 0 && picked.length < limits.maxMessages; i--) {
    const cost = estimateTokens(history[i].content)
    if (picked.length > 0 && cost > budget) break
    budget -= cost
    picked.push(history[i])
  }
  picked.reverse()
  // Non iniziare con una risposta dell'assistente "orfana" della sua domanda.
  while (picked.length > 1 && picked[0].role === 'assistant') picked.shift()
  return picked
}
