import { sql } from 'drizzle-orm'
import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type {
  BenchmarkRun,
  ContextCallKind,
  ContextPart,
  DocumentRef,
  DoneReason,
  KnowledgeBaseMeta,
  KnowledgeBaseOrigin,
  KnowledgeDocumentStatus,
  KnowledgeRef,
  KnowledgeShare,
  MemoryRef,
  PlanStatus,
  PlanStep,
  ResponseStyle
} from '@shared/types'

const now = sql`(unixepoch('subsec') * 1000)`

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('Nuova conversazione'),
    model: text('model').notNull().default(''),
    role: text('role').notNull().default(''),
    context: text('context').notNull().default(''),
    goals: text('goals').notNull().default(''),
    constraints: text('constraints').notNull().default(''),
    temperature: real('temperature').notNull().default(0.7),
    think: integer('think', { mode: 'boolean' }).notNull().default(false),
    planMode: integer('plan_mode', { mode: 'boolean' }).notNull().default(false),
    topP: real('top_p'),
    numCtx: integer('num_ctx'),
    seed: integer('seed'),
    /** Stile della risposta: istruzione nel system prompt, dal più sintetico al più esteso. */
    style: text('style', { enum: ['essential', 'concise', 'normal', 'extended'] }).$type<ResponseStyle>().notNull().default('normal'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    /** Riassunto automatico dei messaggi più vecchi, inviato nel system prompt al posto loro. */
    autoSummary: integer('auto_summary', { mode: 'boolean' }).notNull().default(true),
    summary: text('summary'),
    /** Id dell'ultimo messaggio coperto dal riassunto: i successivi vengono inviati per intero. */
    summaryUpTo: text('summary_up_to'),
    summaryUpdatedAt: integer('summary_updated_at'),
    longMemory: integer('long_memory', { mode: 'boolean' }).notNull().default(true),
    /** Base di conoscenza: le domande usano i documenti della conversazione, salvo scelta sulla singola domanda. */
    knowledge: integer('knowledge', { mode: 'boolean' }).notNull().default(true),
    /** Quota massima della memoria (num_ctx) per i documenti: 0,25 / 0,5 / 0,75. */
    knowledgeShare: real('knowledge_share').$type<KnowledgeShare>().notNull().default(0.5),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now)
  },
  (t) => [index('conversations_updated_idx').on(t.updatedAt)]
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull().default(''),
    thinking: text('thinking'),
    model: text('model'),
    evalCount: integer('eval_count'),
    /** Token del prompt della richiesta che ha prodotto questa risposta (da Ollama). */
    promptEvalCount: integer('prompt_eval_count'),
    durationMs: integer('duration_ms'),
    /** Perché Ollama ha chiuso la risposta: 'stop' (finita) o 'length' (limite di token raggiunto). */
    doneReason: text('done_reason', { enum: ['stop', 'length'] }).$type<DoneReason>(),
    memoryRefs: text('memory_refs', { mode: 'json' }).$type<MemoryRef[]>(),
    /** Sulla domanda: usare la base di conoscenza per la risposta (null = come la conversazione). */
    knowledge: integer('knowledge', { mode: 'boolean' }),
    /** Sulla risposta: estratti dei documenti forniti al modello. */
    knowledgeRefs: text('knowledge_refs', { mode: 'json' }).$type<KnowledgeRef[]>(),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)]
)

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  userMessageId: text('user_message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  steps: text('steps', { mode: 'json' }).$type<PlanStep[]>().notNull(),
  status: text('status', { enum: ['proposed', 'approved', 'rejected', 'executed'] })
    .$type<PlanStatus>()
    .notNull()
    .default('proposed'),
  createdAt: integer('created_at').notNull().default(now)
})

export const briefTemplates = sqliteTable('brief_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default(''),
  context: text('context').notNull().default(''),
  goals: text('goals').notNull().default(''),
  constraints: text('constraints').notNull().default(''),
  model: text('model'),
  temperature: real('temperature').notNull().default(0.7),
  think: integer('think', { mode: 'boolean' }).notNull().default(false),
  planMode: integer('plan_mode', { mode: 'boolean' }).notNull().default(false),
  style: text('style', { enum: ['essential', 'concise', 'normal', 'extended'] }).$type<ResponseStyle>().notNull().default('normal'),
  createdAt: integer('created_at').notNull().default(now)
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull()
})

/** Configurazione di esecuzione per modello (CPU/GPU) e risultati del test. */
export const modelSettings = sqliteTable('model_settings', {
  model: text('model').primaryKey(),
  digest: text('digest'),
  numGpu: integer('num_gpu'),
  benchmark: text('benchmark', { mode: 'json' }).$type<BenchmarkRun[]>(),
  benchmarkedAt: integer('benchmarked_at'),
  gpuAvailable: integer('gpu_available', { mode: 'boolean' }),
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false)
})

/**
 * Memoria delle conversazioni: pezzi di messaggi con il loro embedding. Pensata già per cercare in tutte le
 * conversazioni; per ora la ricerca resta nella conversazione in corso.
 */
export const messageChunks = sqliteTable(
  'message_chunks',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Messaggio a cui rimanda l'estratto (la risposta per una coppia domanda+risposta). */
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Chi l'ha detto: le frasi dell'utente pesano di più di quelle del modello. */
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    /** Ordine del pezzo dentro il messaggio. */
    part: integer('part').notNull().default(0),
    text: text('text').notNull(),
    /** Modello di embedding: vettori di modelli diversi non sono confrontabili. */
    model: text('model').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('message_chunks_conversation_idx').on(t.conversationId, t.model)]
)

/**
 * Basi di conoscenza. Ogni conversazione ha la sua (origin 'conversation', eliminata con lei); le altre stanno
 * nella libreria (create dall'utente o installate da un pacchetto) e si collegano a più conversazioni.
 */
export const knowledgeBases = sqliteTable(
  'knowledge_bases',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().default(''),
    description: text('description').notNull().default(''),
    origin: text('origin', { enum: ['conversation', 'local', 'package'] }).$type<KnowledgeBaseOrigin>().notNull().default('local'),
    /** Conversazione proprietaria, solo per la base della conversazione. */
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    version: text('version'),
    /**
     * Modello di embedding della base: null = quello delle Impostazioni (i documenti si reindicizzano se cambia);
     * indicato = fisso, dichiarato dal pacchetto che ha portato i vettori già calcolati.
     */
    embeddingModel: text('embedding_model'),
    /** Id del pacchetto da cui è stata installata (o con cui è stata esportata). */
    packageId: text('package_id'),
    /** Dati del pacchetto: autore, lingua, licenza, dimensione dei vettori, impronta del modello, fiducia. */
    meta: text('meta', { mode: 'json' }).$type<KnowledgeBaseMeta>(),
    /** Collegata da sola alle nuove conversazioni. */
    autoLink: integer('auto_link', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now)
  },
  (t) => [index('knowledge_bases_conversation_idx').on(t.conversationId)]
)

/** Basi della libreria collegate a una conversazione. */
export const conversationBases = sqliteTable(
  'conversation_bases',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.baseId] })]
)

/** Base di conoscenza: sorgenti collegate a una base (plugin `connected`), con la configurazione. */
export const knowledgeConnections = sqliteTable('knowledge_connections', {
  id: text('id').primaryKey(),
  baseId: text('base_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  status: text('status', { enum: ['ready', 'syncing', 'error'] }).$type<'ready' | 'syncing' | 'error'>().notNull().default('ready'),
  error: text('error'),
  lastSyncAt: integer('last_sync_at'),
  createdAt: integer('created_at').notNull().default(now)
})

/** Base di conoscenza: documenti di una base (testo estratto dal plugin, non il file). */
export const knowledgeDocuments = sqliteTable(
  'knowledge_documents',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').references(() => knowledgeConnections.id, { onDelete: 'cascade' }),
    /** Plugin che ha letto il documento. */
    source: text('source').notNull(),
    title: text('title').notNull(),
    ref: text('ref', { mode: 'json' }).$type<DocumentRef>().notNull(),
    version: text('version'),
    /** Impronta del contenuto: lo stesso file non si aggiunge due volte alla stessa base. */
    hash: text('hash'),
    bytes: integer('bytes'),
    chars: integer('chars').notNull().default(0),
    status: text('status', { enum: ['pending', 'indexing', 'ready', 'error'] }).$type<KnowledgeDocumentStatus>().notNull().default('pending'),
    error: text('error'),
    chunkCount: integer('chunk_count').notNull().default(0),
    /** «Intero»: il documento va al modello per intero a ogni domanda, senza passare dalla ricerca. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    indexedAt: integer('indexed_at')
  },
  (t) => [index('knowledge_documents_base_idx').on(t.baseId, t.createdAt)]
)

/** Base di conoscenza: pezzi dei documenti con il loro embedding, per modello di embedding. */
export const knowledgeChunks = sqliteTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    part: integer('part').notNull().default(0),
    /** Dove nel documento ("p. 12", titolo della sezione), se noto. */
    locator: text('locator'),
    text: text('text').notNull(),
    model: text('model').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('knowledge_chunks_document_idx').on(t.documentId, t.model)]
)

/** Monitor del contesto: le ultime chiamate a Ollama di ogni conversazione, con stime e conteggi reali. */
export const contextCalls = sqliteTable(
  'context_calls',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ContextCallKind>().notNull(),
    note: text('note'),
    model: text('model').notNull(),
    numCtx: integer('num_ctx'),
    parts: text('parts', { mode: 'json' }).$type<ContextPart[]>().notNull(),
    droppedMessages: integer('dropped_messages').notNull().default(0),
    promptEvalCount: integer('prompt_eval_count'),
    evalCount: integer('eval_count'),
    loadMs: integer('load_ms'),
    promptEvalMs: integer('prompt_eval_ms'),
    evalMs: integer('eval_ms'),
    durationMs: integer('duration_ms'),
    doneReason: text('done_reason').$type<DoneReason>(),
    aborted: integer('aborted', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),
    createdAt: integer('created_at').notNull().default(now)
  },
  (t) => [index('context_calls_conversation_idx').on(t.conversationId, t.createdAt)]
)
