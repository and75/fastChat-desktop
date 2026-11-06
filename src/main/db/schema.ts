import { sql } from 'drizzle-orm'
import { blob, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { BenchmarkRun, DoneReason, MemoryRef, PlanStatus, PlanStep, ResponseStyle } from '@shared/types'

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
