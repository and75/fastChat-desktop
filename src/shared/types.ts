// Tipi condivisi tra main, preload e renderer.
import type { Role, RoleChoices, RoleProfileMind } from './roles'

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
  /** Stile della risposta: istruzione nel system prompt, dal più sintetico al più esteso. */
  style: ResponseStyle
}

export type ResponseStyle = 'essential' | 'concise' | 'normal' | 'extended'
export const RESPONSE_STYLES: ResponseStyle[] = ['essential', 'concise', 'normal', 'extended']

/** Titolo delle conversazioni appena create: finché resta questo, dopo il primo scambio se ne genera uno. */
export const DEFAULT_TITLE = 'Nuova conversazione'

/** Ruolo di una conversazione o di un template (docs/ruoli.md). I campi del Brief restano per una versione. */
export interface RoleBinding {
  /** Ruolo con cui si parla. `null` solo finché il Brief non è stato convertito (all'avvio). */
  roleId: string | null
  /** Scelte dei parametri del ruolo; ciò che manca prende il predefinito del ruolo. */
  roleParams: RoleChoices | null
  /** Ritocchi manuali alla mente: valgono finché non cambia l'opzione che governa quel valore. */
  mindOverrides: RoleProfileMind | null
  /** Il contesto di questa conversazione, scritto dall'utente. Sostituisce il Brief. */
  situation: string | null
}

/** Id del ruolo senza istruzioni né parametri: è l'app senza ruoli. */
export const GENERALIST_ROLE_ID = 'app.fastchat.ruolo.generalista'

export type RoleOrigin = 'builtin' | 'package'

/** Un ruolo installato. La definizione è il contenuto di `role.json` del pacchetto. */
export interface RoleRecord {
  id: string
  packageId: string | null
  /** Lega le varianti dello stesso ruolo in lingue diverse. */
  group: string | null
  /** Lingua in cui il ruolo è scritto; `null` = segue l'interfaccia (Generalista). */
  language: string | null
  name: string
  description: string
  version: string | null
  definition: Role
  origin: RoleOrigin
  createdAt: number
}

/** Come nasce una conversazione: vuota (Generalista), da un template, o con un ruolo. */
export interface NewConversationOptions {
  templateId?: string
  roleId?: string
  /** Conversazione di cui portare il riassunto: il cambio di ruolo a conversazione avviata (D23). */
  carryFrom?: string
}

/** Cosa manca al ruolo di una conversazione, per l'avviso non bloccante. */
export interface RoleHealth {
  /** Il ruolo non è più installato: la conversazione continua come Generalista. */
  roleMissing: boolean
  /** Id dei pacchetti delle basi che il ruolo richiede e che non sono installate. */
  missingBases: string[]
}

export interface Conversation extends Brief, ConversationSettings, RoleBinding {
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
  /** Memoria della conversazione (RAG): dopo il primo riassunto, estratti pertinenti dei messaggi riassunti. */
  longMemory: boolean
  /** Base di conoscenza: di norma ogni domanda usa i documenti della conversazione (il bottone libro lo cambia per una domanda). */
  knowledge: boolean
  /** Quota massima della memoria (num_ctx) per i documenti: 0,25 / 0,5 / 0,75. */
  knowledgeShare: KnowledgeShare
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
  /** Come Ollama ha chiuso la risposta: 'length' = fermata al limite di token (contesto esaurito). */
  doneReason: DoneReason | null
  /** Estratti della conversazione forniti al modello per questa risposta (memoria della conversazione). */
  memoryRefs: MemoryRef[] | null
  /** Sulla domanda: la risposta deve usare la base di conoscenza (null = come la conversazione). */
  knowledge: boolean | null
  /** Sulla risposta: estratti dei documenti forniti al modello (fonti). */
  knowledgeRefs: KnowledgeRef[] | null
  createdAt: number
}

// ---------------------------------------------------------------- base di conoscenza

export type KnowledgeBaseOrigin = 'conversation' | 'local' | 'package'
export type KnowledgeShare = 0.25 | 0.5 | 0.75
export const KNOWLEDGE_SHARES: KnowledgeShare[] = [0.25, 0.5, 0.75]

/** Riferimento a un documento di una sorgente: un file locale, o un elemento di una sorgente collegata. */
export type DocumentRef =
  | { kind: 'file'; path: string }
  | { kind: 'remote'; sourceId: string; uri: string; version?: string }

export type KnowledgeDocumentStatus = 'pending' | 'indexing' | 'ready' | 'error'

/** Una base di conoscenza: quella di una conversazione, oppure una della libreria (collegabile a più conversazioni). */
export interface KnowledgeBase {
  id: string
  name: string
  description: string
  origin: KnowledgeBaseOrigin
  /** Conversazione proprietaria (solo origin 'conversation'). */
  conversationId: string | null
  version: string | null
  /** Modello di embedding fisso (dichiarato dal pacchetto); null = quello delle Impostazioni. */
  embeddingModel: string | null
  /** Id del pacchetto da cui viene, o con cui è stata esportata. */
  packageId: string | null
  meta: KnowledgeBaseMeta | null
  /** Collegata da sola alle nuove conversazioni. */
  autoLink: boolean
  createdAt: number
  updatedAt: number
}

/** Dati del pacchetto di una base. */
export interface KnowledgeBaseMeta {
  author?: string
  language?: string
  license?: string
  /** Dimensione dei vettori e impronta del modello di embedding dichiarate dal pacchetto. */
  dimensions?: number
  digest?: string | null
  /** Come è stata verificata l'origine: firma riconosciuta, integrata nell'app, o installata senza firma valida. */
  trust?: PackTrust | 'builtin'
  /** Installata dallo Store: si aggiorna e si rimuove da lì. */
  store?: boolean
  /** Arrivata insieme a un ruolo che la richiede: se ne va con l'ultimo ruolo che la usa. */
  forRole?: boolean
  /** Nome e descrizione nelle altre lingue dell'interfaccia (dal manifest del pacchetto). */
  i18n?: PackI18n
}

/** Titoli di un pacchetto per lingua dell'interfaccia: il contenuto resta nella lingua del pacchetto. */
export type PackI18n = Partial<Record<'it' | 'en' | 'fr', { name?: string; description?: string }>>

/** Esito della verifica della firma di un pacchetto. */
export type PackTrust = 'verified' | 'unsigned' | 'unknown'

export type PackType = 'knowledge' | 'identity' | 'bundle'

/** Il manifest di un pacchetto (.fcpack): cosa contiene e con quale modello è fatto. */
export interface PackManifest {
  format: 'fastchat-pack'
  formatVersion: number
  /** Identificativo stabile, es. «it.fastchat.guida»: una nuova versione sostituisce la precedente. */
  id: string
  type: PackType
  /** Lega le varianti dello stesso contenuto in lingue diverse (es. un ruolo in italiano e in francese). */
  group?: string
  name: string
  version: string
  description?: string
  author?: string
  language?: string
  license?: string
  createdAt: number
  /**
   * Modello di embedding con cui sono calcolati i vettori del pacchetto: per usarlo serve quel modello in
   * Ollama. Assente = pacchetto di solo testo, indicizzato all'installazione con il modello dell'utente.
   */
  embedding?: { model: string; dimensions: number; digest?: string | null }
  /** Modello di chat per cui è pensata un'identità: consigliato (predefinito) o richiesto. */
  model?: { name: string; required?: boolean }
  /** Nome e descrizione nelle altre lingue dell'interfaccia. */
  i18n?: PackI18n
  documents?: number
  chunks?: number
  /** Impronta SHA-256 di ogni file del pacchetto: è ciò che la firma del manifest protegge. */
  files: Record<string, string>
}

/** Un pacchetto letto ma non ancora installato: cosa mostrare prima di confermare. */
export interface PackInspection {
  path: string
  manifest: PackManifest
  trust: PackTrust
  /** Versione già installata dello stesso pacchetto, se c'è. */
  installedVersion: string | null
  /** Il pacchetto è una voce dello Store: si installa da lì, non da file. */
  inStore?: boolean
  /** Il modello di embedding dichiarato è installato in Ollama (true anche per i pacchetti di solo testo). */
  modelInstalled: boolean
}

/**
 * A cosa serve una base collegata a una conversazione: `documents` sono i contenuti su cui rispondere (opzionali,
 * con le fonti citate); `behavior` le tecniche del ruolo e `examples` gli esempi da imitare (sempre attivi).
 */
export type BasePurpose = 'documents' | 'behavior' | 'examples'
export const BASE_PURPOSES: BasePurpose[] = ['documents', 'behavior', 'examples']

/** Una base della libreria con i suoi numeri, per gli elenchi. */
export interface KnowledgeBaseInfo extends KnowledgeBase {
  /** Documenti in tutto e pronti (con pezzi per il modello di embedding attuale). */
  documents: number
  ready: number
  /** Caratteri dei pezzi pronti. */
  chars: number
  /** Conversazioni che la collegano. */
  conversations: number
  /** Modello di embedding effettivo (il suo, o quello delle Impostazioni) e se è installato in Ollama. */
  model: string
  modelInstalled: boolean
  /** Solo per le basi collegate a una conversazione: a cosa servono lì. */
  purpose?: BasePurpose
}

/** Un documento di una base di conoscenza. Si salva il testo estratto, non il file. */
export interface KnowledgeDocument {
  id: string
  baseId: string
  /** Connessione (sorgente collegata) da cui viene; null se aggiunto a mano. */
  connectionId: string | null
  /** Plugin che l'ha letto. */
  source: string
  title: string
  ref: DocumentRef
  /** Versione della sorgente (etag, data, hash): se cambia al refresh, si reindicizza. */
  version: string | null
  /** Impronta del contenuto (SHA-256): lo stesso file non si aggiunge due volte alla stessa base. */
  hash: string | null
  bytes: number | null
  chars: number
  status: KnowledgeDocumentStatus
  error: string | null
  chunkCount: number
  /** «Intero»: va al modello per intero a ogni domanda, prima degli estratti scelti per somiglianza. */
  pinned: boolean
  createdAt: number
  indexedAt: number | null
}

/** Una sorgente collegata a una base (plugin `connected`), con la sua configurazione. */
export interface KnowledgeConnection {
  id: string
  baseId: string
  source: string
  /** Valori dei campi di configurazione del plugin (le credenziali sono cifrate a parte). */
  config: Record<string, string>
  status: 'ready' | 'syncing' | 'error'
  error: string | null
  lastSyncAt: number | null
  createdAt: number
}

/** Un estratto di documento usato per una risposta. */
export interface KnowledgeRef {
  documentId: string
  title: string
  /** Dove nel documento ("p. 12", "§ Introduzione"), se noto. */
  locator: string | null
  score: number
  excerpt: string
  /** Il documento è stato fornito per intero (fissato, o tutti i documenti stavano nella memoria). */
  whole?: boolean
  /** Nome della base della libreria da cui viene (assente per i documenti della conversazione). */
  base?: string
}

/**
 * Stato della base di conoscenza di una conversazione (la sua base più quelle collegate) o di una base
 * della libreria. `documents` e `connections` sono quelli modificabili da qui: della base della
 * conversazione, o della base stessa.
 */
export interface KnowledgeStatus {
  /** La base a cui appartengono `documents` (null se la conversazione non ne ha ancora una). */
  baseId: string | null
  documents: KnowledgeDocument[]
  connections: KnowledgeConnection[]
  /** Basi della libreria collegate alla conversazione (vuoto per una base). */
  linked: KnowledgeBaseInfo[]
  /** Pezzi indicizzati con il modello di embedding attuale (di `documents`). */
  chunks: number
  /** Documenti ancora da indicizzare (in attesa, in corso, o indicizzati con un altro modello). */
  pending: number
  /** Documenti pronti in tutto, basi collegate comprese: abilitano il bottone libro. */
  ready: number
  /** Caratteri dei pezzi pronti, in tutto e dei soli documenti fissati (basi collegate comprese). */
  totalChars: number
  pinnedChars: number
  model: string
  modelInstalled: boolean
}

/** Avanzamento dell'indicizzazione di un documento (main → renderer). */
export interface KnowledgeProgress {
  baseId: string
  documentId: string
  status: KnowledgeDocumentStatus
  /** Pezzi fatti e totali, durante 'indexing'. */
  done: number
  total: number
}

/** Un plugin, come lo vede il renderer. */
export interface KnowledgeSourceInfo {
  id: string
  label: string
  kind: 'file' | 'connected'
  extensions: string[]
  configFields: ConfigField[]
}

/** Campo di configurazione di una sorgente collegata, reso dal nucleo. */
export interface ConfigField {
  key: string
  label: string
  type: 'text' | 'folder' | 'secret'
  required: boolean
  placeholder?: string
}

/** Un estratto della conversazione usato per una risposta. */
export interface MemoryRef {
  /** Messaggio da cui viene l'estratto (per saltarci). */
  messageId: string
  /** Posizione del messaggio nella conversazione, 1 = il primo. */
  position: number
  role: MessageRole
  score: number
  /** Inizio del testo dell'estratto, per l'interfaccia. */
  excerpt: string
}

/** Stato dell'indice della memoria di una conversazione. */
/** Tipo di chiamata a Ollama registrata dal monitor del contesto. */
export type ContextCallKind = 'chat' | 'plan' | 'execute' | 'summary' | 'condense' | 'title' | 'embed-index' | 'embed-query' | 'embed-doc'

/** Voce di ciò che è stato inviato, con i token stimati dall'app. */
export interface ContextPart {
  key: 'instructions' | 'style' | 'situation' | 'summary' | 'memory' | 'behavior' | 'examples' | 'knowledge' | 'reminder' | 'history' | 'question' | 'transcript' | 'texts'
  label: string
  tokens: number
  /** Quanti elementi (messaggi, estratti, pezzi), se ha senso. */
  count?: number
}

/** Una chiamata a Ollama: cosa è partito (stima per voce) e cosa ha contato Ollama. */
export interface ContextCall {
  id: string
  conversationId: string
  kind: ContextCallKind
  /** Dettaglio della chiamata (es. "blocco 2 di 3"). */
  note: string | null
  model: string
  /** null per gli embedding (Ollama usa il contesto predefinito del modello). */
  numCtx: number | null
  parts: ContextPart[]
  /** Messaggi non coperti dal riassunto rimasti fuori perché non entravano. */
  droppedMessages: number
  promptEvalCount: number | null
  evalCount: number | null
  loadMs: number | null
  promptEvalMs: number | null
  evalMs: number | null
  durationMs: number | null
  doneReason: DoneReason | null
  aborted: boolean
  error: string | null
  /** Composizione usata (solo chiamate di chat): ordine dei blocchi e promemoria del ruolo. */
  contextOrder: ContextOrder | null
  reminder: boolean | null
  /** Tempo al primo frammento, misurato dall'app (ms). */
  firstTokenMs: number | null
  /** Token di ragionamento, stimati dal testo (Ollama li conta insieme alla risposta in evalCount). */
  thinkingTokens: number | null
  /** Come il modello tratta il messaggio di sistema. */
  systemSlot: SystemSlot | null
  createdAt: number
}

export type ContextCallInput = Omit<ContextCall, 'id' | 'createdAt'>

export interface MemoryStatus {
  /** Pezzi indicizzati con il modello di embedding attuale. */
  chunks: number
  /** Messaggi coperti dal riassunto ancora da indicizzare. */
  pending: number
  model: string
  /** Il modello di embedding è installato in Ollama. */
  modelInstalled: boolean
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

export interface BriefTemplate extends Brief, RoleBinding {
  id: string
  name: string
  model: string | null
  temperature: number
  think: boolean
  planMode: boolean
  style: ResponseStyle
  createdAt: number
}

export interface OllamaModel {
  name: string
  /** Impronta del modello: cambia quando viene aggiornato con `ollama pull`. */
  digest: string | null
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
  /** Numero di layer del modello (block_count), per proporre una divisione tra GPU e CPU. */
  layers: number | null
  /** Memoria occupata da ogni token di contesto (cache KV in f16), dall'architettura in /api/show; null se non calcolabile. */
  kvBytesPerToken: number | null
  defaults: ModelDefaults
  /** Come il modello tratta il messaggio di sistema, letto dal suo template (assente nei dati salvati prima). */
  systemSlot?: SystemSlot
}

/**
 * Dove finisce il messaggio di sistema: in un posto suo (`dedicated`), incollato al primo messaggio dell'utente
 * (`merged`), o non leggibile dal template (`unknown`, es. modelli che Ollama compone con un formattatore interno).
 */
export type SystemSlot = 'dedicated' | 'merged' | 'unknown'

/** Una configurazione provata dal test CPU/GPU. */
export interface BenchmarkRun {
  label: string
  /** Layer sulla GPU (num_gpu): 0 = solo CPU. */
  numGpu: number
  /** Velocità di lettura del prompt e di scrittura della risposta, token al secondo. */
  promptTps: number | null
  evalTps: number | null
  /** Tempo di caricamento del modello, ms. */
  loadMs: number | null
  /** Quota del modello finita davvero in GPU (da /api/ps), 0–1. */
  vramShare: number | null
  error?: string
}

/** Configurazione di esecuzione di un modello, salvata nel database. */
export interface ModelSetting {
  model: string
  /** Digest del modello quando è stato configurato: se cambia, il test va ripetuto. */
  digest: string | null
  /** Layer sulla GPU inviati come num_gpu; null = automatico (decide Ollama). */
  numGpu: number | null
  benchmark: BenchmarkRun[] | null
  benchmarkedAt: number | null
  /** Ollama vede una GPU utilizzabile per questo modello (dal test); null = non si sa. */
  gpuAvailable: boolean | null
  /** L'utente non vuole l'avviso «fai il test» per questo modello. */
  dismissed: boolean
}

export type ModelSettingPatch = Partial<Pick<ModelSetting, 'numGpu' | 'dismissed'>>

/** Avanzamento del download di un modello (/api/pull). */
export interface PullProgress {
  model: string
  status: string
  completed: number | null
  total: number | null
  done: boolean
  error?: string
}

/** Avanzamento del test CPU/GPU. */
export interface BenchmarkProgress {
  model: string
  step: number
  steps: number
  label: string
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
    | 'seed'
    | 'style'
    | 'archived'
    | 'autoSummary'
    | 'summary'
    | 'summaryUpTo'
    | 'summaryUpdatedAt'
    | 'longMemory'
    | 'knowledge'
    | 'knowledgeShare'
    | 'roleId'
    | 'roleParams'
    | 'mindOverrides'
    | 'situation'
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

/** Scelte per la singola domanda. */
export interface SendOptions {
  /** Bottone libro: la risposta usa (o non usa) la base di conoscenza, a prescindere dall'impostazione della conversazione. */
  knowledge?: boolean
}

/**
 * 'summarizing': prima della risposta i messaggi più vecchi vengono riassunti (la risposta arriva dopo).
 * 'searching': prima della risposta si cercano estratti pertinenti nei documenti della base di conoscenza.
 * 'remembering': prima della risposta si cercano estratti pertinenti nei messaggi riassunti.
 */
export type StreamEventType = 'summarizing' | 'searching' | 'remembering' | 'thinking' | 'content' | 'done' | 'error'

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

/** Tipo della cache KV del server Ollama (OLLAMA_KV_CACHE_TYPE): decide quanto costa ogni token di contesto. */
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'
export const KV_CACHE_TYPES: KvCacheType[] = ['f16', 'q8_0', 'q4_0']

export interface AppSettings {
  ollamaUrl: string
  theme: 'system' | 'light' | 'dark'
  defaultModel: string | null
  /** Non leggibile dall'API: va impostato uguale a quello del server. */
  kvCacheType: KvCacheType
  /** Modello di Ollama per gli embedding della memoria delle conversazioni (multilingue). */
  embeddingModel: string
  /** Lingua dell'interfaccia e dei prompt al modello: automatica (sistema), italiano o inglese. */
  language: 'auto' | 'it' | 'en' | 'fr'
  /** Indirizzo del repository dello store; vuoto = catalogo incluso nell'app. */
  storeUrl: string
  /** Composizione del contesto inviato al modello: ordine dei blocchi, promemoria, quote. */
  context: ContextSettings
}

/**
 * Ordine dei blocchi nel contesto: A = tutto nel system prompt (storico), B = conoscenza accanto alla domanda,
 * C = anche le istruzioni del ruolo accanto alla domanda (diagnostico). Vedi docs/ruoli.md §5.3.
 */
export type ContextOrder = 'A' | 'B' | 'C'

export interface ContextSettings {
  /** «auto»: decide il ruolo (finché non ci sono ruoli vale A). */
  order: 'auto' | ContextOrder
  /** Promemoria del ruolo accanto alla domanda. «auto»: decide il ruolo (oggi spento). */
  reminder: 'auto' | 'on' | 'off'
  /** Come si divide lo spazio della conoscenza tra i tre tipi di base (somma 1). */
  shares: { behavior: number; examples: number; documents: number }
  /** Quota del contesto del modello concessa alla «situazione» scritta dall'utente. */
  situationShare: number
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  order: 'auto',
  reminder: 'auto',
  shares: { behavior: 0.2, examples: 0.2, documents: 0.6 },
  situationShare: 0.05
}

export const DEFAULT_SETTINGS: AppSettings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  theme: 'system',
  defaultModel: null,
  kvCacheType: 'f16',
  embeddingModel: 'embeddinggemma',
  language: 'auto',
  storeUrl: '',
  context: DEFAULT_CONTEXT_SETTINGS
}

/** Esito tipizzato delle chiamate IPC: gli errori arrivano al renderer come valori, non come eccezioni. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export const IPC = {
  modelsList: 'models:list',
  modelsCapabilities: 'models:capabilities',
  modelsCheck: 'models:check',
  systemInfo: 'system:info',
  /** Sincrono (sendSync): lingua del sistema, letta dal preload prima del primo render. */
  systemLocale: 'system:locale',
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsUpdate: 'conversations:update',
  conversationsCalibrate: 'conversations:calibrate',
  conversationsSummarize: 'conversations:summarize',
  memoryStatus: 'memory:status',
  memoryRebuild: 'memory:rebuild',
  /** Base di conoscenza della conversazione. */
  knowledgeStatus: 'knowledge:status',
  knowledgeSources: 'knowledge:sources',
  knowledgeAddFiles: 'knowledge:add-files',
  knowledgePickFiles: 'knowledge:pick-files',
  knowledgeRemove: 'knowledge:remove',
  knowledgeReindex: 'knowledge:reindex',
  knowledgePin: 'knowledge:pin',
  /** Libreria delle basi e collegamenti con le conversazioni. */
  knowledgeBases: 'knowledge:bases',
  knowledgeBaseCreate: 'knowledge:base-create',
  knowledgeBaseUpdate: 'knowledge:base-update',
  knowledgeBaseRemove: 'knowledge:base-remove',
  knowledgePackPick: 'knowledge:pack-pick',
  knowledgePackInstall: 'knowledge:pack-install',
  knowledgeBaseExport: 'knowledge:base-export',
  storeCatalog: 'store:catalog',
  storeInstall: 'store:install',
  storeRemove: 'store:remove',
  knowledgeLink: 'knowledge:link',
  knowledgeUnlink: 'knowledge:unlink',
  knowledgeLinkPurpose: 'knowledge:linkPurpose',
  knowledgeConnect: 'knowledge:connect',
  knowledgeRefresh: 'knowledge:refresh',
  knowledgeDisconnect: 'knowledge:disconnect',
  knowledgePickFolder: 'knowledge:pick-folder',
  /** Evento main → renderer: avanzamento dell'indicizzazione di un documento. */
  knowledgeProgress: 'knowledge:progress',
  contextCalls: 'context:calls',
  contextExport: 'context:export',
  /** Evento main → renderer: nuova chiamata registrata. */
  contextCallAdded: 'context:call-added',
  modelSettingsList: 'model-settings:list',
  modelSettingsSet: 'model-settings:set',
  modelsPull: 'models:pull',
  modelsDelete: 'models:delete',
  modelsBenchmark: 'models:benchmark',
  /** Eventi main → renderer. */
  pullProgress: 'models:pull-progress',
  benchmarkProgress: 'models:benchmark-progress',
  ollamaEnvGet: 'ollama-env:get',
  ollamaEnvApply: 'ollama-env:apply',
  conversationsRemove: 'conversations:remove',
  chatSend: 'chat:send',
  chatRegenerate: 'chat:regenerate',
  chatAbort: 'chat:abort',
  plansPropose: 'plans:propose',
  plansRegenerate: 'plans:regenerate',
  plansUpdate: 'plans:update',
  plansExecute: 'plans:execute',
  conversationsExport: 'conversations:export',
  rolesList: 'roles:list',
  rolesSet: 'roles:set',
  rolesChoose: 'roles:choose',
  rolesHealth: 'roles:health',
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
