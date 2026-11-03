import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BriefTemplate,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type Message,
  type MessageRole,
  type Plan,
  type PlanStatus,
  type PlanStep
} from '@shared/types'
import type { Db } from './client'
import { briefTemplates, conversations, messages, plans, settings } from './schema'

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
  if ('temperature' in out) out.temperature = clampNumber(out.temperature, 0, 2) ?? 0.7
  if ('topP' in out) out.topP = clampNumber(out.topP, 0, 1)
  if ('numCtx' in out) out.numCtx = toInt(out.numCtx, 256, 1_048_576)
  if ('seed' in out) out.seed = toInt(out.seed, -2_147_483_648, 2_147_483_647)
  for (const key of ['think', 'planMode', 'archived'] as const) {
    if (key in out) out[key] = out[key] === true
  }
  return out as ConversationPatch
}

/** Numero limitato all'intervallo; null se non è un numero finito (= "usa il default di Ollama"). */
function clampNumber(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

function toInt(v: unknown, min: number, max: number): number | null {
  const n = clampNumber(v, min, max)
  return n == null ? null : Math.round(n)
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
  promptEvalCount?: number | null
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
    promptEvalCount: msg.promptEvalCount ?? null,
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

// ---------------------------------------------------------------- piani

/** Transizioni ammesse: proposto → approvato/rifiutato, approvato → eseguito/rifiutato. */
const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['executed', 'rejected', 'approved'],
  rejected: [],
  executed: []
}

export async function listPlans(db: Db, conversationId: string): Promise<Plan[]> {
  return db
    .select()
    .from(plans)
    .where(eq(plans.conversationId, conversationId))
    .orderBy(asc(plans.createdAt), asc(sql`rowid`))
}

export async function getPlan(db: Db, id: string): Promise<Plan | null> {
  const [row] = await db.select().from(plans).where(eq(plans.id, id))
  return row ?? null
}

export async function createPlan(
  db: Db,
  init: { conversationId: string; userMessageId: string; steps: PlanStep[] }
): Promise<Plan> {
  const row: Plan = { id: randomUUID(), ...init, status: 'proposed', createdAt: Date.now() }
  await db.insert(plans).values(row)
  return row
}

export async function updatePlan(
  db: Db,
  id: string,
  patch: { steps?: PlanStep[]; status?: PlanStatus }
): Promise<Plan> {
  const plan = await getPlan(db, id)
  if (!plan) throw new Error('Piano non trovato')
  if (patch.steps && plan.status !== 'proposed' && plan.status !== 'approved') {
    throw new Error('Questo piano non è più modificabile')
  }
  if (patch.status && patch.status !== plan.status && !TRANSITIONS[plan.status].includes(patch.status)) {
    throw new Error(`Transizione non ammessa: ${plan.status} → ${patch.status}`)
  }
  const set: Partial<Plan> = {}
  if (patch.steps) set.steps = patch.steps
  if (patch.status) set.status = patch.status
  if (Object.keys(set).length) await db.update(plans).set(set).where(eq(plans.id, id))
  return { ...plan, ...set }
}

export async function removePlan(db: Db, id: string): Promise<void> {
  await db.delete(plans).where(eq(plans.id, id))
}

/**
 * Il piano da seguire per un messaggio utente: l'ultimo approvato o eseguito.
 * Serve a rigenerare (o riprovare) una risposta seguendo lo stesso piano.
 */
export async function planToFollow(db: Db, userMessageId: string): Promise<Plan | null> {
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.userMessageId, userMessageId), inArray(plans.status, ['approved', 'executed'])))
    .orderBy(desc(plans.createdAt))
    .limit(1)
  return row ?? null
}

// ---------------------------------------------------------------- template del brief

export async function listTemplates(db: Db): Promise<BriefTemplate[]> {
  return db.select().from(briefTemplates).orderBy(asc(sql`lower(${briefTemplates.name})`))
}

export async function getTemplate(db: Db, id: string): Promise<BriefTemplate | null> {
  const [row] = await db.select().from(briefTemplates).where(eq(briefTemplates.id, id))
  return row ?? null
}

/** Salva il brief e le impostazioni di una conversazione come template riutilizzabile. */
export async function createTemplateFromConversation(db: Db, conversationId: string, name: string): Promise<BriefTemplate> {
  const conv = await getConversation(db, conversationId)
  if (!conv) throw new Error('Conversazione non trovata')
  const clean = name.trim().slice(0, 100)
  if (!clean) throw new Error('Il template ha bisogno di un nome')
  const row: BriefTemplate = {
    id: randomUUID(),
    name: clean,
    role: conv.role,
    context: conv.context,
    goals: conv.goals,
    constraints: conv.constraints,
    model: conv.model || null,
    temperature: conv.temperature,
    think: conv.think,
    planMode: conv.planMode,
    createdAt: Date.now()
  }
  await db.insert(briefTemplates).values(row)
  return row
}

export async function removeTemplate(db: Db, id: string): Promise<void> {
  await db.delete(briefTemplates).where(eq(briefTemplates.id, id))
}

/** Valori iniziali di una conversazione creata da un template. */
export function conversationFromTemplate(t: BriefTemplate, fallbackModel: string): ConversationPatch {
  return {
    model: t.model || fallbackModel,
    role: t.role,
    context: t.context,
    goals: t.goals,
    constraints: t.constraints,
    temperature: t.temperature,
    think: t.think,
    planMode: t.planMode
  }
}
