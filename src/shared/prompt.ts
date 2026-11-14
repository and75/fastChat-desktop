// Funzioni pure per comporre i prompt. Condivise: il main le usa per le chiamate a Ollama,
// il renderer per l'anteprima del system prompt nella scheda «Situazione».
import { localeTag, t } from './i18n'
import { OLLAMA_DEFAULTS, type Brief, type ContextPart, type PlanStep, type ResponseStyle } from './types'

const SECTIONS: Array<keyof Brief> = ['role', 'context', 'goals', 'constraints']

const joinSections = (...parts: string[]): string => parts.filter((p) => p.trim()).join('\n\n')

/**
 * Istruzioni di stile, dal più sintetico al più esteso. Riguardano solo il testo finale: la brevità non
 * deve costare precisione, e i modelli con ragionamento possono ragionare quanto serve.
 */
export function styleInstruction(style: ResponseStyle | null | undefined): string | null {
  if (!style || style === 'normal') return null
  return t(`prompt.style.${style}`, { accuracy: t('prompt.accuracy') })
}

/** Sezione "# Stile della risposta", o '' per lo stile normale. */
export function buildStyleSection(style: ResponseStyle | null | undefined): string {
  const text = styleInstruction(style)
  return text ? `# ${t('prompt.styleHeading')}\n${text}` : ''
}

/**
 * Compone il system prompt dal brief: solo le sezioni non vuote, nell'ordine
 * Ruolo, Contesto, Obiettivi, Vincoli, poi lo stile della risposta (se non normale).
 * Restituisce '' se il brief è vuoto e lo stile è normale.
 */
export function buildSystemPrompt(brief: Brief, style?: ResponseStyle | null): string {
  const sections = SECTIONS.map((key) => [t(`prompt.section.${key}`), brief[key]?.trim() ?? ''] as const)
    .filter(([, body]) => body.length > 0)
    .map(([title, body]) => `# ${title}\n${body}`)
  return joinSections(...sections, buildStyleSection(style))
}

/**
 * Il Brief a quattro campi come testo unico: è la «situazione» delle conversazioni nate prima dei ruoli.
 * Stesse sezioni e stessi titoli del system prompt, senza lo stile: il prompt di una conversazione convertita
 * resta identico.
 */
export const briefToSituation = (brief: Partial<Brief>): string =>
  buildSystemPrompt({ role: brief.role ?? '', context: brief.context ?? '', goals: brief.goals ?? '', constraints: brief.constraints ?? '' })

/** La situazione nel prompt. Con il titolo quando segue le istruzioni di un ruolo, così le due voci restano distinte. */
export function situationSection(situation: string | null | undefined, titled: boolean): string {
  const text = situation?.trim() ?? ''
  return text && titled ? `# ${t('prompt.situationHeading')}\n${text}` : text
}

export interface RolePromptInput {
  /** Istruzioni del ruolo con le frasi delle opzioni scelte; '' per il Generalista. */
  instructions?: string
  situation?: string | null
  style?: ResponseStyle | null
}

/**
 * System prompt di una conversazione: istruzioni del ruolo, situazione, stile. Per il Generalista la situazione
 * entra senza titolo: una conversazione nata con il Brief riceve lo stesso prompt di prima.
 */
export function buildRolePrompt({ instructions = '', situation, style }: RolePromptInput): string {
  return joinSections(instructions.trim(), situationSection(situation, !!instructions.trim()), buildStyleSection(style))
}

/** System prompt per la fase di pianificazione, a partire da quello della conversazione. */
export const planPrompt = (system: string): string => joinSections(system, t('prompt.plan'))

/** System prompt per l'esecuzione: quello della conversazione più il piano approvato dall'utente. */
export const executePrompt = (system: string, steps: PlanStep[]): string => joinSections(system, t('prompt.execute', { plan: formatPlan(steps) }))

export interface HistoryMessage {
  /** Id del messaggio (serve per sapere quali sono coperti dal riassunto). */
  id?: string
  role: 'user' | 'assistant'
  content: string
  /** Ragionamento della risposta (conta nei token generati). */
  thinking?: string | null
  /** Token generati da Ollama per questa risposta (content + thinking). */
  evalCount?: number | null
  createdAt?: number
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

/**
 * Divide i token di un testo composto tra le sue sezioni, in proporzione ai caratteri: la somma resta
 * esattamente il totale (l'arrotondamento va alla sezione più lunga).
 */
export function splitTokens(total: number, sections: ReadonlyArray<string>): number[] {
  const lens = sections.map((t) => t.length)
  const sum = lens.reduce((a, b) => a + b, 0)
  if (sum === 0) return sections.map(() => 0)
  const out = lens.map((l) => Math.floor((total * l) / sum))
  out[lens.indexOf(Math.max(...lens))] += total - out.reduce((a, b) => a + b, 0)
  return out
}

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

// ---------------------------------------------------------------- riassunto automatico

/** Soglie del riassunto, in frazione dello spazio per lo storico (memoria − riserva − system prompt). */
export const SUMMARY = {
  /** Quando prompt + storico + domanda superano questa quota della memoria, si riassume prima di rispondere. */
  trigger: 0.7,
  /** Si riassumono i messaggi più vecchi finché il totale scende sotto questa quota della memoria. */
  target: 0.4,
  /** Token massimi del riassunto generato (con memoria grande); con memoria piccola si scala. */
  maxTokens: 600,
  minTokens: 64
} as const

/** Lunghezza del riassunto: un quarto dello spazio per lo storico, tra 64 e 600 token. */
export function summaryMaxTokens(numCtx: number, reserveTokens: number): number {
  return Math.min(SUMMARY.maxTokens, Math.max(SUMMARY.minTokens, Math.floor((numCtx - reserveTokens) / 4)))
}

/** System prompt completo: brief + riassunto della conversazione finora (se c'è). */
export function withSummary(system: string, summary: string | null | undefined): string {
  const text = summary?.trim()
  if (!text) return system
  return joinSections(system, `# ${t('prompt.summaryHeading')}\n${text}`)
}

/**
 * Messaggi non coperti dal riassunto. Se il messaggio indicato non esiste più (eliminato), il
 * riassunto non è più allineato e si restituisce tutto lo storico: chi chiama non deve usarlo.
 */
export function historyAfter<T extends HistoryMessage>(history: T[], summaryUpTo: string | null | undefined): { recent: T[]; aligned: boolean } {
  if (!summaryUpTo) return { recent: history, aligned: true }
  const idx = history.findIndex((m) => m.id === summaryUpTo)
  return idx < 0 ? { recent: history, aligned: false } : { recent: history.slice(idx + 1), aligned: true }
}

export interface SummaryPlanInput<T extends HistoryMessage> {
  /** Messaggi non ancora coperti dal riassunto, in ordine. */
  recent: T[]
  /** System prompt completo (brief + stile + riassunto attuale). */
  systemPrompt: string
  /** Memoria della conversazione (num_ctx). */
  numCtx: number
  /**
   * Totale misurato da Ollama (prompt + risposta dell'ultimo scambio, più i messaggi arrivati dopo), se valido:
   * le stime a caratteri possono sbagliare, i conteggi reali no. Vedi computeContextUsage.
   */
  measuredTotal?: number | null
  /** Forza il riassunto anche sotto la soglia (azione manuale). */
  force?: boolean
}

/**
 * Decide quali messaggi far confluire nel riassunto. Regola: se system prompt + messaggi superano il 70%
 * della memoria, si riassumono i più vecchi finché il totale scende al 40%. La domanda in attesa resta sempre
 * per intero; l'ultimo scambio solo se ci sta sotto la soglia. null se non serve.
 */
export function planSummary<T extends HistoryMessage>(input: SummaryPlanInput<T>): { cover: T[]; keep: T[] } | null {
  const { recent, numCtx } = input
  if (recent.length === 0 || numCtx <= 0) return null
  const cpt = charsPerToken(recent)
  const system = input.systemPrompt ? estimateTokens(input.systemPrompt, cpt) : 0
  let costs = recent.map((m) => estimateTokens(m.content, cpt))
  const estimated = system + costs.reduce((a, b) => a + b, 0)
  // Se Ollama ha contato di più della stima, si corregge la stima nella stessa proporzione.
  const measured = input.measuredTotal ?? 0
  if (measured > estimated && estimated > 0) {
    const k = measured / estimated
    costs = costs.map((c) => c * k)
  }
  const sys = measured > estimated && estimated > 0 ? system * (measured / estimated) : system
  let used = sys + costs.reduce((a, b) => a + b, 0)
  const trigger = numCtx * SUMMARY.trigger
  // A mano («Riassumi ora») si riassume tutto il riassumibile, anche sotto la soglia.
  const target = input.force ? 0 : numCtx * SUMMARY.target
  if (!input.force && used <= trigger) return null

  // Cosa resta sempre per intero: la domanda in attesa (ultimo messaggio, se è dell'utente). L'ultimo scambio
  // resta per intero solo se ci sta sotto la soglia; altrimenti finisce anche lui nel riassunto.
  const last = recent.length - 1
  const pending = recent[last].role === 'user' ? 1 : 0
  const prevRole = last > 0 ? recent[last - 1].role : null
  const tailStart = pending ? (prevRole === 'assistant' ? last - 1 : last) : prevRole === 'user' ? last - 1 : last
  const tailCost = costs.slice(tailStart).reduce((a, b) => a + b, 0)
  const keepMin = sys + tailCost <= trigger ? recent.length - tailStart : pending

  let n = 0
  while (n < recent.length - keepMin && used > target) used -= costs[n++]
  // Si chiude su una risposta, così i messaggi tenuti iniziano con una domanda.
  while (n > 0 && n < recent.length - keepMin && recent[n - 1].role === 'user') n++
  if (n === 0) return null
  return { cover: recent.slice(0, n), keep: recent.slice(n) }
}

/**
 * Trascrizione dei messaggi da riassumere, divisa in blocchi di al massimo `maxChars` caratteri, in ordine.
 * I messaggi più lunghi di un blocco vengono spezzati in parti ("Assistente (parte 2/3): …"): niente si perde.
 */
export function transcriptChunks(messages: ReadonlyArray<HistoryMessage>, maxChars: number): string[] {
  const size = Math.max(200, Math.floor(maxChars))
  const pieces: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? t('prompt.transcript.user') : t('prompt.transcript.assistant')
    const text = m.content.trim()
    if (text.length + who.length + 2 <= size) {
      pieces.push(`${who}: ${text}`)
      continue
    }
    const room = size - who.length - 20
    const parts = Math.ceil(text.length / room)
    for (let i = 0; i < parts; i++) pieces.push(t('prompt.transcript.part', { who, i: i + 1, n: parts }) + text.slice(i * room, (i + 1) * room))
  }
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > size) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current}\n\n${piece}` : piece
  }
  if (current) chunks.push(current)
  return chunks
}

/** Prompt dell'archivista, con la lunghezza massima del riassunto in parole. */
export function buildSummaryPrompt(maxWords: number): string {
  return t('prompt.summary.system', { maxWords })
}

/** Testo del messaggio utente per la richiesta di riassunto. */
export function buildSummaryRequest(previous: string | null, newMessages: string): string {
  const head = previous?.trim() ? t('prompt.summary.previous', { previous: previous.trim() }) : t('prompt.summary.messages')
  return `${head}\n${newMessages}`
}

/** Ripulisce il riassunto generato: niente blocchi di ragionamento, niente titoli ridondanti. */
export function cleanSummary(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*#+\s*(riassunto|summary|résumé)[^\n]*\n/i, '')
    .trim()
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

/** System prompt per la fase di pianificazione: brief + stile + istruzioni del piano. */
export function buildPlanPrompt(brief: Brief, style?: ResponseStyle | null): string {
  return planPrompt(buildSystemPrompt(brief, style))
}

export function formatPlan(steps: PlanStep[]): string {
  return steps
    .map((s, i) => {
      const detail = s.detail.trim()
      return `${i + 1}. ${s.title.trim()}${detail ? ` — ${detail}` : ''}`
    })
    .join('\n')
}

/** System prompt per l'esecuzione: brief + stile + piano approvato dall'utente. */
export function buildExecutePrompt(brief: Brief, steps: PlanStep[], style?: ResponseStyle | null): string {
  return executePrompt(buildSystemPrompt(brief, style), steps)
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
  if (steps.length === 0) throw new Error(t('err.planNoSteps'))
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
    if (!match) throw new Error(t('err.planInvalid'))
    try {
      data = JSON.parse(match[0])
    } catch {
      throw new Error(t('err.planInvalid'))
    }
  }
  const steps = Array.isArray(data) ? data : (data as { steps?: unknown })?.steps
  try {
    return normalizeSteps(steps)
  } catch {
    throw new Error(t('err.planInvalid'))
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
  /** Voci stimate: istruzioni, stile, riassunto (count = messaggi coperti), storico (count = messaggi). */
  parts: ContextPart[]
  /** Differenza tra il totale e la somma delle voci: lo scarto dei conteggi di Ollama (0 se è una stima). */
  adjustment: number
  /**
   * Da dove viene il numero: conteggi di Ollama dell'ultima risposta, oppure stima perché non ce ne sono,
   * perché il riassunto è cambiato dopo, o perché sono troppo bassi (cache).
   */
  source: 'ollama' | 'no-count' | 'summary-changed' | 'cache'
}

export interface ContextUsageInput {
  brief: Brief
  /** Con i ruoli: istruzioni del ruolo e situazione. Se la situazione manca si stima dal Brief (righe non convertite). */
  instructions?: string
  situation?: string | null
  style?: ResponseStyle | null
  messages: Array<HistoryMessage & { promptEvalCount?: number | null }>
  /** Memoria effettiva della conversazione (num_ctx inviato a Ollama): vedi resolveNumCtx. */
  numCtx: number
  /** Riassunto in vigore e ultimo messaggio coperto: i messaggi coperti non si contano. */
  summary?: string | null
  summaryUpTo?: string | null
  summaryUpdatedAt?: number | null
}

/**
 * Quanta parte della memoria della conversazione è occupata.
 * Se l'ultima risposta ha i conteggi di Ollama si usano quelli (prompt + risposta) più una stima dei
 * messaggi arrivati dopo; altrimenti si stima tutto (brief + storico) con ~4 caratteri per token.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsage {
  const total = input.numCtx

  const { recent: messages, aligned } = historyAfter(input.messages, input.summaryUpTo)
  const role = input.situation != null ? { instructions: input.instructions ?? '', situation: input.situation } : null
  const system = withSummary(role ? buildRolePrompt({ ...role, style: input.style }) : buildSystemPrompt(input.brief, input.style), aligned ? input.summary : null)
  const cpt = charsPerToken(input.messages)
  const est = (text: string): number => estimateTokens(text, cpt)
  const systemTokens = system ? est(system) : 0
  const historyTokens = messages.reduce((n, m) => n + est(m.content), 0)
  const estimateAll = systemTokens + historyTokens
  // Voci: il system prompt diviso tra istruzioni, stile e riassunto; poi lo storico non riassunto.
  const instructions = role ? role.instructions.trim() : buildSystemPrompt(input.brief, null)
  const situation = role ? situationSection(role.situation, !!instructions) : ''
  const style = buildStyleSection(input.style)
  const summaryText = aligned ? withSummary('', input.summary) : ''
  const [ti, ts, tsum, tsit] = splitTokens(systemTokens, [instructions, style, summaryText, situation])
  const parts: ContextPart[] = [
    ...(instructions ? [{ key: 'instructions' as const, label: 'instructions', tokens: ti }] : []),
    ...(situation ? [{ key: 'situation' as const, label: 'situation', tokens: tsit }] : []),
    ...(style ? [{ key: 'style' as const, label: 'style', tokens: ts }] : []),
    ...(summaryText ? [{ key: 'summary' as const, label: 'summary', tokens: tsum, count: input.messages.length - messages.length }] : []),
    ...(messages.length ? [{ key: 'history' as const, label: 'history', tokens: historyTokens, count: messages.length }] : [])
  ]

  let lastIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].promptEvalCount != null) {
      lastIdx = i
      break
    }
  }

  let used = estimateAll
  let estimated = true
  // Se il riassunto è cambiato dopo l'ultima risposta, il conteggio di Ollama non descrive più il prompt attuale.
  const countValid = lastIdx >= 0 && (input.summaryUpdatedAt == null || (messages[lastIdx].createdAt ?? 0) >= input.summaryUpdatedAt)
  let source: ContextUsage['source'] = lastIdx < 0 ? (input.summary && aligned ? 'summary-changed' : 'no-count') : countValid ? 'cache' : 'summary-changed'
  if (countValid) {
    const last = messages[lastIdx]
    const real = (last.promptEvalCount ?? 0) + (last.evalCount ?? est(last.content))
    const after = messages.slice(lastIdx + 1).reduce((n, m) => n + est(m.content), 0)
    // Con la cache dei prompt Ollama può riportare solo i token rivalutati: se il numero è molto più
    // basso della stima, non è attendibile e si resta sulla stima.
    const estimateUpToLast = (system ? est(system) : 0) + messages.slice(0, lastIdx + 1).reduce((n, m) => n + est(m.content), 0)
    if (real >= estimateUpToLast * 0.5) {
      used = real + after
      estimated = after > 0
      source = 'ollama'
    }
  }

  return { used, total, ratio: total > 0 ? used / total : 0, estimated, charsPerToken: cpt, parts, adjustment: used - estimateAll, source }
}

/** Formato compatto in migliaia: 850 → "850", 3200 → "3,2k", 40960 → "41k". */
export function formatTokensK(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  return (k < 10 ? k.toLocaleString(localeTag(), { maximumFractionDigits: 1 }) : Math.round(k).toLocaleString(localeTag())) + 'k'
}
