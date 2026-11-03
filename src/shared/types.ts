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
  seed: number | null
}

export interface Conversation extends Brief, ConversationSettings {
  id: string
  title: string
  model: string
  archived: boolean
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
  durationMs: number | null
  createdAt: number
}

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

export interface ModelCapabilities {
  /** Elenco grezzo restituito da /api/show, es. ["completion", "thinking", "tools"]. */
  capabilities: string[]
  thinking: boolean
  contextLength: number | null
}

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
    | 'seed'
    | 'archived'
  >
>

export interface ConversationListQuery {
  search?: string
  archived?: boolean
}

export interface ConversationDetail {
  conversation: Conversation
  messages: Message[]
}

export interface SendResult {
  streamId: string
  /** Il messaggio utente appena salvato (assente in caso di rigenerazione). */
  userMessage?: Message
}

export type StreamEventType = 'thinking' | 'content' | 'done' | 'error'

export interface StreamEvent {
  streamId: string
  conversationId: string
  type: StreamEventType
  delta?: string
  error?: string
  /** Sull'evento 'done': il messaggio dell'assistente salvato (assente se interrotto senza testo). */
  message?: Message
  /** Sull'evento 'done': true se la generazione è stata interrotta dall'utente. */
  aborted?: boolean
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
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsRemove: 'conversations:remove',
  chatSend: 'chat:send',
  chatRegenerate: 'chat:regenerate',
  chatAbort: 'chat:abort',
  /** Evento main → renderer. */
  chatStream: 'chat:stream',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const
