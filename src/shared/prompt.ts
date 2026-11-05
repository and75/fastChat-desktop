// Funzioni pure per comporre i prompt. Condivise: il main le usa per le chiamate a Ollama,
// il renderer per l'anteprima del system prompt nel BriefPanel.
import { OLLAMA_DEFAULTS, type Brief, type PlanStep } from './types'

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
  /** Ragionamento della risposta (conta nei token generati). */
  thinking?: string | null
  /** Token generati da Ollama per questa risposta (content + thinking). */
  evalCount?: number | null
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
  // Valore di riserva; in pratica maxTokens è sempre la memoria effettiva della conversazione (resolveNumCtx).
  maxTokens: OLLAMA_DEFAULTS.numCtx,
  reserveTokens: 1024
}

/** Caratteri per token quando non ci sono ancora conteggi reali: ~4 per l'inglese, di più del vero per italiano e codice. */
export const DEFAULT_CHARS_PER_TOKEN = 4
/** Intervallo plausibile del rapporto misurato: fuori da qui il conteggio è inattendibile. */
const CHARS_PER_TOKEN_RANGE = [2, 6] as const
/** Token generati minimi perché la misura valga qualcosa. */
const MIN_CALIBRATION_TOKENS = 50

/** Stima: caratteri ÷ caratteri per token, più un piccolo costo fisso per messaggio. */
export const estimateTokens = (text: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number =>
  Math.ceil(text.length / charsPerToken) + 4

/**
 * Caratteri per token misurati sulla conversazione: per ogni risposta Ollama dice quanti token ha
 * generato (eval_count) e l'app conosce il testo (risposta + ragionamento). Niente chiamate in più,
 * e vale per la lingua e lo stile di questa conversazione. Con pochi dati resta il valore predefinito.
 */
export function charsPerToken(messages: ReadonlyArray<HistoryMessage>): number {
  let chars = 0
  let tokens = 0
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.evalCount) continue
    chars += m.content.length + (m.thinking?.length ?? 0)
    tokens += m.evalCount
  }
  if (tokens < MIN_CALIBRATION_TOKENS) return DEFAULT_CHARS_PER_TOKEN
  const ratio = chars / tokens
  if (ratio < CHARS_PER_TOKEN_RANGE[0] || ratio > CHARS_PER_TOKEN_RANGE[1]) return DEFAULT_CHARS_PER_TOKEN
  return Math.round(ratio * 100) / 100
}

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
  const cpt = charsPerToken(history)
  let budget = limits.maxTokens - limits.reserveTokens - (systemPrompt ? estimateTokens(systemPrompt, cpt) : 0)
  const picked: T[] = []
  for (let i = history.length - 1; i >= 0 && picked.length < limits.maxMessages; i--) {
    const cost = estimateTokens(history[i].content, cpt)
    if (picked.length > 0 && cost > budget) break
    budget -= cost
    picked.push(history[i])
  }
  picked.reverse()
  // Non iniziare con una risposta dell'assistente "orfana" della sua domanda.
  while (picked.length > 1 && picked[0].role === 'assistant') picked.shift()
  return picked
}

// ---------------------------------------------------------------- plan mode

/** JSON schema passato a Ollama in `format`: il modello può rispondere solo con un piano. */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' }
        },
        required: ['title', 'detail']
      }
    }
  },
  required: ['steps']
} as const

const PLAN_INSTRUCTIONS = `# Modalità piano
Non rispondere ancora alla richiesta dell'utente. Proponi prima un piano per rispondere.
- Da 3 a 7 passi, nell'ordine in cui li eseguirai.
- Ogni passo ha un titolo breve ("title") e una descrizione di una o due frasi ("detail").
- Il piano deve rispettare ruolo, contesto, obiettivi e vincoli indicati sopra.
- Scrivi nella stessa lingua dell'utente.
Rispondi solo con un oggetto JSON nella forma {"steps":[{"title":"…","detail":"…"}]}.`

const joinSections = (...parts: string[]): string => parts.filter((p) => p.trim()).join('\n\n')

/** System prompt per la fase di pianificazione: brief + istruzioni del piano. */
export function buildPlanPrompt(brief: Brief): string {
  return joinSections(buildSystemPrompt(brief), PLAN_INSTRUCTIONS)
}

export function formatPlan(steps: PlanStep[]): string {
  return steps
    .map((s, i) => {
      const detail = s.detail.trim()
      return `${i + 1}. ${s.title.trim()}${detail ? ` — ${detail}` : ''}`
    })
    .join('\n')
}

/** System prompt per l'esecuzione: brief + piano approvato dall'utente. */
export function buildExecutePrompt(brief: Brief, steps: PlanStep[]): string {
  return joinSections(
    buildSystemPrompt(brief),
    `# Piano approvato
L'utente ha approvato questo piano per rispondere alla sua ultima richiesta. Seguilo passo per passo, nell'ordine indicato, senza aggiungere né saltare passi. Non ripetere il piano: esegui.

${formatPlan(steps)}`
  )
}

/**
 * Normalizza i passi di un piano (dal modello o dal renderer): titoli non vuoti, testo ripulito, al massimo 20 passi.
 * Lancia un errore se non resta nessun passo valido.
 */
export function normalizeSteps(input: unknown): PlanStep[] {
  const raw = Array.isArray(input) ? input : []
  const steps = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      title: typeof s.title === 'string' ? s.title.trim().slice(0, 300) : '',
      detail: typeof s.detail === 'string' ? s.detail.trim().slice(0, 2000) : ''
    }))
    .filter((s) => s.title.length > 0)
    .slice(0, 20)
  if (steps.length === 0) throw new Error('Il piano non contiene passi validi')
  return steps
}

/** Estrae il piano dalla risposta JSON del modello. */
export function parsePlan(content: string): PlanStep[] {
  let data: unknown
  try {
    data = JSON.parse(content.trim())
  } catch {
    // Alcuni modelli racchiudono comunque il JSON in un blocco di codice.
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Il modello non ha restituito un piano valido')
    try {
      data = JSON.parse(match[0])
    } catch {
      throw new Error('Il modello non ha restituito un piano valido')
    }
  }
  const steps = Array.isArray(data) ? data : (data as { steps?: unknown })?.steps
  try {
    return normalizeSteps(steps)
  } catch {
    throw new Error('Il modello non ha restituito un piano valido')
  }
}

// ---------------------------------------------------------------- uso del contesto

export interface ContextUsage {
  /** Token occupati: dall'ultima risposta (prompt + risposta) più i messaggi successivi, o stimati. */
  used: number
  /** Token disponibili (memoria della conversazione). */
  total: number
  /** used / total, 0–1 (può superare 1: lo storico più vecchio verrà tagliato). */
  ratio: number
  /** true se il numero è una stima (nessuna risposta con conteggio di Ollama). */
  estimated: boolean
  /** Caratteri per token usati per le stime: misurati sulla conversazione, o il predefinito. */
  charsPerToken: number
}

export interface ContextUsageInput {
  brief: Brief
  messages: Array<HistoryMessage & { promptEvalCount?: number | null }>
  /** Memoria effettiva della conversazione (num_ctx inviato a Ollama): vedi resolveNumCtx. */
  numCtx: number
}

/**
 * Quanta parte della memoria della conversazione è occupata.
 * Se l'ultima risposta ha i conteggi di Ollama si usano quelli (prompt + risposta) più una stima dei
 * messaggi arrivati dopo; altrimenti si stima tutto (brief + storico) con ~4 caratteri per token.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsage {
  const total = input.numCtx

  const system = buildSystemPrompt(input.brief)
  const cpt = charsPerToken(input.messages)
  const est = (text: string): number => estimateTokens(text, cpt)
  const estimateAll = (system ? est(system) : 0) + input.messages.reduce((n, m) => n + est(m.content), 0)

  let lastIdx = -1
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].role === 'assistant' && input.messages[i].promptEvalCount != null) {
      lastIdx = i
      break
    }
  }

  let used = estimateAll
  let estimated = true
  if (lastIdx >= 0) {
    const last = input.messages[lastIdx]
    const real = (last.promptEvalCount ?? 0) + (last.evalCount ?? est(last.content))
    const after = input.messages.slice(lastIdx + 1).reduce((n, m) => n + est(m.content), 0)
    // Con la cache dei prompt Ollama può riportare solo i token rivalutati: se il numero è molto più
    // basso della stima, non è attendibile e si resta sulla stima.
    const estimateUpToLast =
      (system ? est(system) : 0) +
      input.messages.slice(0, lastIdx + 1).reduce((n, m) => n + est(m.content), 0)
    if (real >= estimateUpToLast * 0.5) {
      used = real + after
      estimated = after > 0
    }
  }

  return { used, total, ratio: total > 0 ? used / total : 0, estimated, charsPerToken: cpt }
}

/** Formato compatto in migliaia: 850 → "850", 3200 → "3,2k", 40960 → "41k". */
export function formatTokensK(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  return (k < 10 ? k.toLocaleString('it-IT', { maximumFractionDigits: 1 }) : Math.round(k).toLocaleString('it-IT')) + 'k'
}
