// Tipi condivisi tra main, preload e renderer.

export interface Brief {
  role: string
  context: string
  goals: string
  constraints: string
}

export interface ConversationSettings {
  temperature: number
  think: boolean
  planMode: boolean
  topP: number | null
  numCtx: number | null
  /** Token massimi per la risposta (num_predict): anche lo spazio riservato alla risposta nel contesto. */
  numPredict: number | null
  seed: number | null
}

/** Titolo delle conversazioni appena create: finché resta questo, dopo il primo scambio se ne genera uno. */
export const DEFAULT_TITLE = 'Nuova conversazione'

export interface Conversation extends Brief, ConversationSettings {
  id: string
  title: string
  model: string
  archived: boolean
  /** Riassunto automatico dei messaggi più vecchi quando la conversazione non sta più nella memoria. */
  autoSummary: boolean
  summary: string | null
  /** Id dell'ultimo messaggio coperto dal riassunto; i successivi vengono inviati per intero. */
  summaryUpTo: string | null
  summaryUpdatedAt: number | null
  createdAt: number
  updatedAt: number
}

export type MessageRole = 'user' | 'assistant'

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  thinking: string | null
  model: string | null
  evalCount: number | null
  /** Token del prompt (system + storico + domanda) usati per generare la risposta, da Ollama. */
  promptEvalCount: number | null
  durationMs: number | null
  /** Come Ollama ha chiuso la risposta: 'length' = tagliata al limite di token (num_predict). */
  doneReason: DoneReason | null
  createdAt: number
}

export type DoneReason = 'stop' | 'length'

export interface PlanStep {
  title: string
  detail: string
}

export type PlanStatus = 'proposed' | 'approved' | 'rejected' | 'executed'

export interface Plan {
  id: string
  conversationId: string
  userMessageId: string
  steps: PlanStep[]
  status: PlanStatus
  createdAt: number
}

export interface BriefTemplate extends Brief {
  id: string
  name: string
  model: string | null
  temperature: number
  think: boolean
  planMode: boolean
  createdAt: number
}

export interface OllamaModel {
  name: string
  size: number
  modifiedAt: string
  family: string | null
  parameterSize: string | null
  quantization: string | null
}

/** Valori predefiniti del modello (dal Modelfile, campo `parameters` di /api/show); null se non indicati. */
export interface ModelDefaults {
  temperature: number | null
  topP: number | null
  numCtx: number | null
}

export interface ModelCapabilities {
  /** Elenco grezzo restituito da /api/show, es. ["completion", "thinking", "tools"]. */
  capabilities: string[]
  thinking: boolean
  /** Lunghezza massima del contesto con cui il modello è stato addestrato (token). */
  contextLength: number | null
  /** Memoria occupata da ogni token di contesto (cache KV in f16), dall'architettura in /api/show; null se non calcolabile. */
  kvBytesPerToken: number | null
  defaults: ModelDefaults
}

/** Valori usati da Ollama quando il Modelfile non indica nulla. */
export const OLLAMA_DEFAULTS = { temperature: 0.8, topP: 0.9, numCtx: 4096 } as const

/** Campi modificabili di una conversazione. */
export type ConversationPatch = Partial<
  Pick<
    Conversation,
    | 'title'
    | 'model'
    | 'role'
    | 'context'
    | 'goals'
    | 'constraints'
    | 'temperature'
    | 'think'
    | 'planMode'
    | 'topP'
    | 'numCtx'
    | 'numPredict'
    | 'seed'
    | 'archived'
    | 'autoSummary'
    | 'summary'
    | 'summaryUpTo'
    | 'summaryUpdatedAt'
  >
>

export interface ConversationListQuery {
  search?: string
  archived?: boolean
}

export interface ConversationDetail {
  conversation: Conversation
  messages: Message[]
  plans: Plan[]
}

export interface SendResult {
  streamId: string
  /** Il messaggio utente appena salvato (assente in caso di rigenerazione). */
  userMessage?: Message
}

export type StreamEventType = 'thinking' | 'content' | 'done' | 'error'

/** 'chat': risposta normale o esecuzione di un piano; 'plan': proposta di un piano (content è JSON). */
export type StreamKind = 'chat' | 'plan'

export interface StreamEvent {
  streamId: string
  conversationId: string
  kind: StreamKind
  type: StreamEventType
  delta?: string
  error?: string
  /** Sull'evento 'done': il messaggio dell'assistente salvato (assente se interrotto senza testo). */
  message?: Message
  /** Sull'evento 'done': true se la generazione è stata interrotta dall'utente. */
  aborted?: boolean
  /** Sull'evento 'done' di uno stream 'plan': il piano proposto e salvato. */
  plan?: Plan
  /** Sull'evento 'done' dell'esecuzione: il piano passato a 'executed'. */
  executedPlan?: Plan
}

export interface PlanUpdate {
  steps?: PlanStep[]
  status?: PlanStatus
}

export interface AppSettings {
  ollamaUrl: string
  theme: 'system' | 'light' | 'dark'
  defaultModel: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  theme: 'system',
  defaultModel: null
}

/** Esito tipizzato delle chiamate IPC: gli errori arrivano al renderer come valori, non come eccezioni. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export const IPC = {
  modelsList: 'models:list',
  modelsCapabilities: 'models:capabilities',
  modelsCheck: 'models:check',
  systemInfo: 'system:info',
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsCalibrate: 'conversations:calibrate',
  conversationsSummarize: 'conversations:summarize',
  conversationsRemove: 'conversations:remove',
  chatSend: 'chat:send',
  chatRegenerate: 'chat:regenerate',
  chatAbort: 'chat:abort',
  plansPropose: 'plans:propose',
  plansRegenerate: 'plans:regenerate',
  plansUpdate: 'plans:update',
  plansExecute: 'plans:execute',
  conversationsExport: 'conversations:export',
  templatesList: 'templates:list',
  templatesCreate: 'templates:create',
  templatesRemove: 'templates:remove',
  /** Eventi main → renderer. */
  chatStream: 'chat:stream',
  conversationUpdated: 'conversations:updated',
  clipboardWrite: 'clipboard:write',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  /** Evento main → renderer: la finestra è stata ingrandita o ripristinata. */
  windowMaximized: 'window:maximized',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const
