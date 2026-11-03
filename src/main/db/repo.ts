import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type Message,
  type MessageRole
} from '@shared/types'
import type { Db } from './client'
import { conversations, messages, settings } from './schema'

// ---------------------------------------------------------------- impostazioni

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

export async function getSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select().from(settings)
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if ((SETTING_KEYS as string[]).includes(row.key)) {
      ;(out as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  return out
}

export async function setSettings(db: Db, patch: Partial<AppSettings>): Promise<AppSettings> {
  const entries = Object.entries(patch).filter(([k, v]) => (SETTING_KEYS as string[]).includes(k) && v !== undefined)
  for (const [key, value] of entries) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
  }
  return getSettings(db)
}

// ---------------------------------------------------------------- conversazioni

const PATCHABLE: (keyof ConversationPatch)[] = [
  'title',
  'model',
  'role',
  'context',
  'goals',
  'constraints',
  'temperature',
  'think',
  'planMode',
  'topP',
  'numCtx',
  'seed',
  'archived'
]

/** Tiene solo i campi ammessi: il patch arriva dal renderer e non va preso alla lettera. */
export function sanitizePatch(patch: ConversationPatch): ConversationPatch {
  const out: Record<string, unknown> = {}
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) out[key] = patch[key]
  }
  if (typeof out.title === 'string') out.title = out.title.trim().slice(0, 200) || 'Nuova conversazione'
  if (typeof out.temperature === 'number') out.temperature = Math.min(2, Math.max(0, out.temperature))
  return out as ConversationPatch
}

export async function listConversations(db: Db, query: ConversationListQuery = {}): Promise<Conversation[]> {
  const filters = [eq(conversations.archived, query.archived ?? false)]
  const term = query.search?.trim()
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`
    filters.push(
      sql`(${conversations.title} LIKE ${like} ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM ${messages} m WHERE m.conversation_id = ${conversations.id}
        AND m.content LIKE ${like} ESCAPE '\\'))`
    )
  }
  return db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(conversations.updatedAt))
}

export async function getConversation(db: Db, id: string): Promise<Conversation | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id))
  return row ?? null
}

export async function createConversation(
  db: Db,
  init: ConversationPatch = {}
): Promise<Conversation> {
  const id = randomUUID()
  const now = Date.now()
  await db.insert(conversations).values({ ...sanitizePatch(init), id, createdAt: now, updatedAt: now })
  return (await getConversation(db, id))!
}

export async function updateConversation(db: Db, id: string, patch: ConversationPatch): Promise<Conversation> {
  const clean = sanitizePatch(patch)
  await db
    .update(conversations)
    .set({ ...clean, updatedAt: Date.now() })
    .where(eq(conversations.id, id))
  const conv = await getConversation(db, id)
  if (!conv) throw new Error('Conversazione non trovata')
  return conv
}

export async function removeConversation(db: Db, id: string): Promise<void> {
  await db.delete(conversations).where(eq(conversations.id, id))
}

async function touchConversation(db: Db, id: string, at: number): Promise<void> {
  await db.update(conversations).set({ updatedAt: at }).where(eq(conversations.id, id))
}

// ---------------------------------------------------------------- messaggi

export async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(sql`rowid`))
}

export interface NewMessage {
  conversationId: string
  role: MessageRole
  content: string
  thinking?: string | null
  model?: string | null
  evalCount?: number | null
  durationMs?: number | null
}

export async function addMessage(db: Db, msg: NewMessage): Promise<Message> {
  const row: Message = {
    id: randomUUID(),
    conversationId: msg.conversationId,
    role: msg.role,
    content: msg.content,
    thinking: msg.thinking || null,
    model: msg.model ?? null,
    evalCount: msg.evalCount ?? null,
    durationMs: msg.durationMs ?? null,
    createdAt: Date.now()
  }
  await db.insert(messages).values(row)
  await touchConversation(db, msg.conversationId, row.createdAt)
  return row
}

export async function removeMessage(db: Db, id: string): Promise<void> {
  await db.delete(messages).where(eq(messages.id, id))
}
