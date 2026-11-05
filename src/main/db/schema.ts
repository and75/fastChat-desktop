import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { DoneReason, PlanStatus, PlanStep } from '@shared/types'

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
    /** Token massimi per la risposta (num_predict): è anche lo spazio riservato alla risposta nel contesto. */
    numPredict: integer('num_predict'),
    seed: integer('seed'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    /** Riassunto automatico dei messaggi più vecchi, inviato nel system prompt al posto loro. */
    autoSummary: integer('auto_summary', { mode: 'boolean' }).notNull().default(true),
    summary: text('summary'),
    /** Id dell'ultimo messaggio coperto dal riassunto: i successivi vengono inviati per intero. */
    summaryUpTo: text('summary_up_to'),
    summaryUpdatedAt: integer('summary_updated_at'),
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
  createdAt: integer('created_at').notNull().default(now)
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull()
})
