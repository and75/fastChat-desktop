// Composizione del contesto: dove finiscono, nei messaggi inviati a Ollama, le istruzioni, la situazione, il
// riassunto, gli estratti (memoria, comportamento, esempi, documenti), il promemoria e la domanda.
//
// Tre ordini (docs/ruoli.md §5.3):
//   A  tutto nel system prompt — il comportamento storico dell'app;
//   B  conoscenza accanto alla domanda: il system prompt resta fermo tra una domanda e l'altra, così Ollama
//      riusa il calcolo già fatto e gli estratti stanno dove il modello presta più attenzione;
//   C  anche le istruzioni del ruolo accanto alla domanda (diagnostico).
// Con B e C ciò che accompagna la domanda viaggia nello stesso messaggio utente: mai due messaggi utente di
// seguito. Nel database resta solo il testo scritto dall'utente.
import { t } from './i18n'
import { selectHistory, withSummary, type HistoryLimits, type HistoryMessage } from './prompt'
import { DEFAULT_CONTEXT_SETTINGS, type ContextOrder, type ContextSettings, type SystemSlot } from './types'

export const CONTEXT_ORDERS: ContextOrder[] = ['A', 'B', 'C']

/** Un blocco che cambia a ogni domanda: sezione già pronta, con il suo titolo. */
export interface ComposeBlock {
  key: 'memory' | 'behavior' | 'examples' | 'knowledge' | 'rules' | 'style' | 'plan'
  text: string
}

export interface ComposeInput<T extends HistoryMessage> {
  order: ContextOrder
  /** L'apertura del prompt: ruolo e situazione, ciascuno con il suo titolo. */
  base: string
  /** Testo del riassunto (senza titolo), se allineato allo storico. */
  summary?: string | null
  /** I blocchi che seguono il riassunto, nell'ordine fisso: memoria, tecniche, esempi, documenti, regole, stile, piano. */
  blocks?: ReadonlyArray<ComposeBlock>
  /** Promemoria del ruolo, già pronto; '' = nessuno. Sta sempre accanto alla domanda. */
  reminder?: string
  /** Messaggi non coperti dal riassunto. */
  history: T[]
  limits: HistoryLimits
}

export interface ComposeMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Composed<T extends HistoryMessage> {
  messages: ComposeMessage[]
  /** I messaggi dello storico entrati, con il loro testo originale. */
  picked: T[]
  /** Il system prompt inviato ('' se assente). */
  system: string
  /** Ciò che accompagna la domanda nello stesso messaggio ('' se nulla). */
  attached: string
  /** Tutte le sezioni come starebbero nel system prompt dell'ordine A: serve alle stime per voce del monitor. */
  flat: string
}

const join = (parts: ReadonlyArray<string>): string => parts.filter((p) => p).join('\n\n')

/** La domanda quando è preceduta da altro nello stesso messaggio: un titolo la separa dal materiale. */
export const questionSection = (question: string): string => `# ${t('prompt.questionHeading')}\n${question}`

export function composeMessages<T extends HistoryMessage>(input: ComposeInput<T>): Composed<T> {
  const sections = (input.blocks ?? []).map((b) => b.text).filter((s) => s)
  const reminder = input.reminder ?? ''
  const flat = join([withSummary(input.base, input.summary), ...sections])

  // La sequenza dei blocchi è una sola: l'ordine sceglie soltanto quanti stanno nel messaggio di sistema.
  // A: tutti; B: ruolo, situazione e riassunto; C: nessuno (tutto viaggia con la domanda).
  const opening = withSummary(input.base, input.summary)
  let system = input.order === 'A' ? join([opening, ...sections]) : input.order === 'B' ? opening : ''
  let tail: string[] = input.order === 'A' ? [] : input.order === 'B' ? [...sections] : [opening, ...sections].filter((s) => s)
  if (reminder) tail.push(reminder)

  // Lo storico entra finché c'è spazio: conta anche ciò che viaggia con la domanda.
  const picked = selectHistory(input.history, join([system, ...tail]), input.limits)
  const at = picked.findLastIndex((m) => m.role === 'user')
  // Senza una domanda a cui accompagnarsi (non dovrebbe succedere) il materiale torna nel system prompt.
  if (at < 0 && tail.length) {
    system = join([system, ...tail])
    tail = []
  }
  const attached = join(tail)
  const messages: ComposeMessage[] = system ? [{ role: 'system', content: system }] : []
  picked.forEach((m, i) => messages.push({ role: m.role, content: i === at && attached ? `${attached}\n\n${questionSection(m.content)}` : m.content }))
  return { messages, picked, system, attached, flat }
}

/** Promemoria del ruolo: una riga sotto il suo titolo, da mettere accanto alla domanda. */
export function roleReminder(role: string | null | undefined, max = 240): string {
  const line = (role ?? '').split('\n').map((l) => l.trim()).find((l) => l) ?? ''
  if (!line) return ''
  return `# ${t('prompt.reminder')}\n${line.length > max ? `${line.slice(0, max).replace(/\s+\S*$/, '')}…` : line}`
}

// ---------------------------------------------------------------- impostazioni

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Impostazioni lette dal database (anche salvate da una versione precedente): ciò che manca o non vale torna al predefinito. */
export function normalizeContextSettings(raw: unknown): ContextSettings {
  const d = DEFAULT_CONTEXT_SETTINGS
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ContextSettings>
  const s = (r.shares && typeof r.shares === 'object' ? r.shares : {}) as Partial<ContextSettings['shares']>
  const shares = { behavior: num(s.behavior), examples: num(s.examples), documents: num(s.documents) }
  const ok = Object.values(shares).every((v) => v != null && v >= 0 && v <= 1) && Math.abs(shares.behavior! + shares.examples! + shares.documents! - 1) < 0.005
  const situation = num(r.situationShare)
  return {
    order: r.order === 'auto' || CONTEXT_ORDERS.includes(r.order as ContextOrder) ? (r.order as ContextSettings['order']) : d.order,
    reminder: r.reminder === 'on' || r.reminder === 'off' || r.reminder === 'auto' ? r.reminder : d.reminder,
    shares: ok ? (shares as ContextSettings['shares']) : { ...d.shares },
    situationShare: situation != null && situation >= 0.01 && situation <= 0.25 ? situation : d.situationShare
  }
}

/** Impostazioni da salvare: ciò che non vale è un errore (chiave i18n), non un ripiego silenzioso. */
export function validateContextSettings(raw: unknown): ContextSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ContextSettings>
  const clean = normalizeContextSettings(raw)
  if (r.order !== undefined && clean.order !== r.order) throw new Error(t('err.context.order'))
  if (r.reminder !== undefined && clean.reminder !== r.reminder) throw new Error(t('err.context.reminder'))
  if (r.shares !== undefined && JSON.stringify(clean.shares) !== JSON.stringify({ behavior: r.shares?.behavior, examples: r.shares?.examples, documents: r.shares?.documents }))
    throw new Error(t('err.context.shares'))
  if (r.situationShare !== undefined && clean.situationShare !== r.situationShare) throw new Error(t('err.context.situation'))
  return clean
}

/** Composizione effettiva per una chiamata. «Automatico» oggi vale il comportamento storico: ordine A, niente promemoria. */
export function resolveContext(settings: ContextSettings | null | undefined): { order: ContextOrder; reminder: boolean; shares: ContextSettings['shares'] } {
  const s = settings ?? DEFAULT_CONTEXT_SETTINGS
  const order = s.order === 'auto' ? 'A' : s.order
  return { order, reminder: s.reminder === 'on' && reminderApplies(order), shares: s.shares }
}

// ---------------------------------------------------------------- posto «sistema» del modello

/** Marcatori di un turno di sistema separato (ChatML, Llama 3, Phi, Mistral recenti, Gemma 4…). */
const DEDICATED = [/<\|im_start\|>\s*system/, /<\|start_header_id\|>\s*system/, /<\|system\|>/, /\[SYSTEM_PROMPT\]/, /<<SYS>>/, /<\|turn>\s*system/, /<start_of_turn>\s*system/, /<\|start_of_role\|>\s*system/]
/** Il testo di sistema finisce dentro il turno dell'utente (Gemma 2 e 3, Mistral con [INST]). */
const MERGED = [
  /eq \.Role "user"\)\s*\(eq \.Role "system"\)/,
  /eq \.Role "system"\)\s*\(eq \.Role "user"\)/,
  /<start_of_turn>user\s*(\{\{-?\s*if\s+(and\s+)?[^}]*\.System[^}]*\}\}\s*)?\{\{-?\s*\.System/,
  /\[INST\]\s*(\{\{-?\s*if\s+[^}]*\.System[^}]*\}\}\s*)?\{\{-?\s*\.System/
]

/**
 * Come il modello tratta il messaggio di sistema, dal template di chat che Ollama espone (/api/show). È un
 * riconoscimento di schemi noti: quando non basta, o quando Ollama compone il testo con un formattatore interno
 * (riga RENDERER nel Modelfile, template ridotto a «{{ .Prompt }}»), la risposta è `unknown` e decidono i test.
 */
export function detectSystemSlot(template: unknown, modelfile?: unknown): SystemSlot {
  const tpl = typeof template === 'string' ? template : ''
  if (typeof modelfile === 'string' && /^\s*RENDERER\s+\S/m.test(modelfile)) return 'unknown'
  if (!tpl.trim() || /^\{\{-?\s*\.Prompt\s*-?\}\}$/.test(tpl.trim())) return 'unknown'
  if (!/\.System|"system"/.test(tpl)) return 'unknown'
  if (MERGED.some((re) => re.test(tpl))) return 'merged'
  if (DEDICATED.some((re) => re.test(tpl))) return 'dedicated'
  return 'unknown'
}

// ---------------------------------------------------------------- disegno dell'ordine

/**
 * L'ordine fisso dei blocchi del prompt, uguale per ogni ruolo e per ogni ordine del contesto. Ogni blocco ha
 * il suo titolo e una sola competenza (docs/ruoli.md, «Contratto del prompt»).
 */
export const BLOCK_SEQUENCE = ['instructions', 'situation', 'summary', 'memory', 'behavior', 'examples', 'knowledge', 'rules', 'style', 'plan', 'reminder', 'question'] as const

/** Un blocco del contesto, per i disegni dell'interfaccia. */
export type ContextBlock = 'instructions' | 'situation' | 'summary' | 'memory' | 'behavior' | 'examples' | 'knowledge' | 'rules' | 'style' | 'plan' | 'reminder' | 'history' | 'question'

/** Con l'ordine C le istruzioni complete sono già accanto alla domanda: il promemoria non aggiunge nulla. */
export const reminderApplies = (order: ContextOrder): boolean => order !== 'C'

/**
 * Dove finisce ogni blocco con un dato ordine: nel messaggio di sistema, nella conversazione, o nel messaggio
 * dell'utente con la domanda. È la stessa disposizione che produce composeMessages, in forma di schema.
 */
export function orderLayout(order: ContextOrder, reminder: boolean): { system: ContextBlock[]; conversation: ContextBlock[]; user: ContextBlock[]; reuse: 'none' | 'previous' } {
  // La sequenza è una sola (vedi BLOCK_SEQUENCE): l'ordine dice quanti blocchi stanno nel messaggio di sistema.
  const opening: ContextBlock[] = ['instructions', 'situation', 'summary']
  const rest: ContextBlock[] = ['memory', 'behavior', 'examples', 'knowledge', 'rules', 'style', 'plan']
  const rem: ContextBlock[] = reminder && reminderApplies(order) ? ['reminder'] : []
  if (order === 'A') return { system: [...opening, ...rest], conversation: ['history'], user: [...rem, 'question'], reuse: 'none' }
  if (order === 'B') return { system: opening, conversation: ['history'], user: [...rest, ...rem, 'question'], reuse: 'previous' }
  return { system: [], conversation: ['history'], user: [...opening, ...rest, 'question'], reuse: 'previous' }
}
