import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BriefTemplate,
  type ContextCall,
  type ContextCallInput,
  type Conversation,
  type ConversationListQuery,
  type ConversationPatch,
  type DoneReason,
  RESPONSE_STYLES,
  type ResponseStyle,
  type Message,
  type MemoryRef,
  type KnowledgeBase,
  type KnowledgeConnection,
  type KnowledgeDocument,
  type KnowledgeDocumentStatus,
  type KnowledgeRef,
  KNOWLEDGE_SHARES,
  type KnowledgeShare,
  type MessageRole,
  type ModelSetting,
  type Plan,
  type PlanStatus,
  type PlanStep
} from '@shared/types'
import type { Db } from './client'
import {
  briefTemplates,
  contextCalls,
  conversationBases,
  conversations,
  knowledgeBases,
  knowledgeChunks,
  knowledgeConnections,
  knowledgeDocuments,
  messageChunks,
  messages,
  modelSettings,
  plans,
  settings
} from './schema'

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
  'style',
  'archived',
  'autoSummary',
  'summary',
  'summaryUpTo',
  'summaryUpdatedAt',
  'longMemory',
  'knowledge',
  'knowledgeShare'
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
  if ('style' in out && !RESPONSE_STYLES.includes(out.style as ResponseStyle)) out.style = 'normal'
  if ('seed' in out) out.seed = toInt(out.seed, -2_147_483_648, 2_147_483_647)
  for (const key of ['think', 'planMode', 'archived', 'autoSummary', 'longMemory', 'knowledge'] as const) {
    if (key in out) out[key] = out[key] === true
  }
  if ('knowledgeShare' in out && !KNOWLEDGE_SHARES.includes(out.knowledgeShare as KnowledgeShare)) out.knowledgeShare = 0.5
  if ('summary' in out) {
    out.summary = typeof out.summary === 'string' && out.summary.trim() ? out.summary.trim().slice(0, 20_000) : null
    // Senza riassunto non c'è nulla di coperto.
    if (out.summary == null) {
      out.summaryUpTo = null
      out.summaryUpdatedAt = null
    }
  }
  if ('summaryUpTo' in out && typeof out.summaryUpTo !== 'string') out.summaryUpTo = null
  if ('summaryUpdatedAt' in out) out.summaryUpdatedAt = toInt(out.summaryUpdatedAt, 0, Number.MAX_SAFE_INTEGER)
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
  doneReason?: DoneReason | null
  memoryRefs?: MemoryRef[] | null
  knowledge?: boolean | null
  knowledgeRefs?: KnowledgeRef[] | null
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
    doneReason: msg.doneReason ?? null,
    memoryRefs: msg.memoryRefs?.length ? msg.memoryRefs : null,
    knowledge: typeof msg.knowledge === 'boolean' ? msg.knowledge : null,
    knowledgeRefs: msg.knowledgeRefs?.length ? msg.knowledgeRefs : null,
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
    style: conv.style,
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
    planMode: t.planMode,
    style: t.style
  }
}

// ---------------------------------------------------------------- configurazione per modello

export async function listModelSettings(db: Db): Promise<ModelSetting[]> {
  return (await db.select().from(modelSettings)).map((r) => ({ ...r, benchmark: r.benchmark ?? null }))
}

export async function getModelSetting(db: Db, model: string): Promise<ModelSetting | null> {
  const [row] = await db.select().from(modelSettings).where(eq(modelSettings.model, model))
  return row ? { ...row, benchmark: row.benchmark ?? null } : null
}

/** Crea o aggiorna la configurazione di un modello (solo i campi indicati). */
export async function saveModelSetting(db: Db, model: string, patch: Partial<Omit<ModelSetting, 'model'>>): Promise<ModelSetting> {
  const clean: Partial<Omit<ModelSetting, 'model'>> = { ...patch }
  if ('numGpu' in clean) {
    const n = clean.numGpu
    clean.numGpu = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(999, Math.round(n))) : null
  }
  if ('dismissed' in clean) clean.dismissed = clean.dismissed === true
  await db
    .insert(modelSettings)
    .values({ model, dismissed: false, ...clean })
    .onConflictDoUpdate({ target: modelSettings.model, set: clean })
  return (await getModelSetting(db, model))!
}

export async function removeModelSetting(db: Db, model: string): Promise<void> {
  await db.delete(modelSettings).where(eq(modelSettings.model, model))
}

// ---------------------------------------------------------------- memoria (pezzi con embedding)

export interface ChunkRow {
  id: string
  conversationId: string
  messageId: string
  role: MessageRole
  part: number
  text: string
  model: string
  embedding: Buffer
}

export async function listChunks(db: Db, conversationId: string, model: string): Promise<ChunkRow[]> {
  return db
    .select()
    .from(messageChunks)
    .where(and(eq(messageChunks.conversationId, conversationId), eq(messageChunks.model, model)))
}

export async function addChunks(db: Db, rows: Array<Omit<ChunkRow, 'id'>>): Promise<void> {
  if (rows.length === 0) return
  await db.insert(messageChunks).values(rows.map((r) => ({ ...r, id: randomUUID(), createdAt: Date.now() })))
}

/** Toglie i pezzi della conversazione: tutti, o quelli di un modello di embedding diverso da `keepModel`. */
export async function removeChunks(db: Db, conversationId: string, keepModel?: string): Promise<void> {
  const where = keepModel
    ? and(eq(messageChunks.conversationId, conversationId), sql`${messageChunks.model} <> ${keepModel}`)
    : eq(messageChunks.conversationId, conversationId)
  await db.delete(messageChunks).where(where)
}

// ---------------------------------------------------------------- base di conoscenza

// Basi: quella di una conversazione (creata al primo uso) e quelle della libreria, collegabili.

export async function getBase(db: Db, id: string): Promise<KnowledgeBase | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id))
  return row ?? null
}

/** La base della conversazione, se esiste già. */
export async function getConversationBase(db: Db, conversationId: string): Promise<KnowledgeBase | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.conversationId, conversationId))
  return row ?? null
}

/** La base installata da un pacchetto (o esportata con quell'id). */
export async function getBaseByPackage(db: Db, packageId: string): Promise<KnowledgeBase | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.packageId, packageId))
  return row ?? null
}

/** Basi da collegare da sole alle nuove conversazioni. */
export async function listAutoLinkBases(db: Db): Promise<KnowledgeBase[]> {
  return db.select().from(knowledgeBases).where(and(eq(knowledgeBases.autoLink, true), sql`${knowledgeBases.origin} <> 'conversation'`))
}

export async function createBase(
  db: Db,
  init: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'origin' | 'conversationId' | 'version' | 'embeddingModel' | 'packageId' | 'meta' | 'autoLink'>>
): Promise<KnowledgeBase> {
  const now = Date.now()
  const row: KnowledgeBase = {
    id: randomUUID(),
    name: (init.name ?? '').trim().slice(0, 120),
    description: (init.description ?? '').trim().slice(0, 2000),
    origin: init.origin ?? 'local',
    conversationId: init.conversationId ?? null,
    version: init.version ?? null,
    embeddingModel: init.embeddingModel ?? null,
    packageId: init.packageId ?? null,
    meta: init.meta ?? null,
    autoLink: init.autoLink === true,
    createdAt: now,
    updatedAt: now
  }
  await db.insert(knowledgeBases).values(row)
  return row
}

export async function updateBase(
  db: Db,
  id: string,
  patch: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'autoLink' | 'version' | 'embeddingModel' | 'packageId' | 'meta'>>
): Promise<KnowledgeBase | null> {
  const set: Partial<KnowledgeBase> = { updatedAt: Date.now() }
  if (typeof patch.name === 'string') set.name = patch.name.trim().slice(0, 120)
  if (typeof patch.description === 'string') set.description = patch.description.trim().slice(0, 2000)
  if (typeof patch.autoLink === 'boolean') set.autoLink = patch.autoLink
  for (const key of ['version', 'embeddingModel', 'packageId', 'meta'] as const) if (key in patch) (set as Record<string, unknown>)[key] = patch[key] ?? null
  await db.update(knowledgeBases).set(set).where(eq(knowledgeBases.id, id))
  return getBase(db, id)
}

export async function removeBase(db: Db, id: string): Promise<void> {
  await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id))
}

/** Basi della libreria (non quelle delle conversazioni), per nome. */
export async function listLibraryBases(db: Db): Promise<KnowledgeBase[]> {
  return db
    .select()
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.origin} <> 'conversation'`)
    .orderBy(asc(sql`lower(${knowledgeBases.name})`), asc(knowledgeBases.createdAt))
}

/** Basi della libreria collegate alla conversazione, nell'ordine in cui sono state collegate. */
export async function listLinkedBases(db: Db, conversationId: string): Promise<KnowledgeBase[]> {
  const rows = await db
    .select({ base: knowledgeBases })
    .from(conversationBases)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, conversationBases.baseId))
    .where(eq(conversationBases.conversationId, conversationId))
    .orderBy(asc(conversationBases.createdAt), asc(sql`conversation_bases.rowid`))
  return rows.map((r) => r.base)
}

export async function linkBase(db: Db, conversationId: string, baseId: string): Promise<void> {
  await db.insert(conversationBases).values({ conversationId, baseId, createdAt: Date.now() }).onConflictDoNothing()
}

export async function unlinkBase(db: Db, conversationId: string, baseId: string): Promise<void> {
  await db.delete(conversationBases).where(and(eq(conversationBases.conversationId, conversationId), eq(conversationBases.baseId, baseId)))
}

/** Quante conversazioni collegano ogni base. */
export async function countBaseLinks(db: Db, baseIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (baseIds.length === 0) return out
  const rows = await db
    .select({ baseId: conversationBases.baseId, n: sql<number>`count(*)` })
    .from(conversationBases)
    .where(inArray(conversationBases.baseId, baseIds))
    .groupBy(conversationBases.baseId)
  for (const r of rows) out.set(r.baseId, Number(r.n))
  return out
}

export async function listBasesById(db: Db, ids: string[]): Promise<KnowledgeBase[]> {
  return ids.length ? db.select().from(knowledgeBases).where(inArray(knowledgeBases.id, ids)) : []
}

/** Documenti in attesa nelle basi della libreria (pacchetti installati quando il modello di embedding mancava). */
export async function listPendingLibraryDocuments(db: Db): Promise<KnowledgeDocument[]> {
  const rows = await db
    .select({ doc: knowledgeDocuments })
    .from(knowledgeDocuments)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, knowledgeDocuments.baseId))
    .where(and(eq(knowledgeDocuments.status, 'pending'), sql`${knowledgeBases.origin} <> 'conversation'`))
  return rows.map((r) => r.doc)
}

/** Toglie tutti i documenti di una base (reinstallazione di un pacchetto). */
export async function clearBase(db: Db, baseId: string): Promise<void> {
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.baseId, baseId))
}

/** Documenti delle basi indicate, in ordine di aggiunta. */
export async function listDocuments(db: Db, baseIds: string | string[]): Promise<KnowledgeDocument[]> {
  const ids = Array.isArray(baseIds) ? baseIds : [baseIds]
  if (ids.length === 0) return []
  return db
    .select()
    .from(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.baseId, ids))
    .orderBy(asc(knowledgeDocuments.createdAt), asc(sql`rowid`))
}

export async function getDocument(db: Db, id: string): Promise<KnowledgeDocument | null> {
  const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id))
  return row ?? null
}

/** Documento della base con la stessa impronta (lo stesso file non si aggiunge due volte). */
export async function findDocumentByHash(db: Db, baseId: string, hash: string): Promise<KnowledgeDocument | null> {
  const [row] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.baseId, baseId), eq(knowledgeDocuments.hash, hash)))
  return row ?? null
}

export type NewDocument = Pick<KnowledgeDocument, 'baseId' | 'source' | 'title' | 'ref'> &
  Partial<Pick<KnowledgeDocument, 'connectionId' | 'version' | 'bytes'>> & { hash?: string | null }

export async function addDocument(db: Db, doc: NewDocument): Promise<KnowledgeDocument> {
  const row = {
    id: randomUUID(),
    baseId: doc.baseId,
    connectionId: doc.connectionId ?? null,
    source: doc.source,
    title: doc.title.trim().slice(0, 200) || 'Documento',
    ref: doc.ref,
    version: doc.version ?? null,
    hash: doc.hash ?? null,
    bytes: doc.bytes ?? null,
    chars: 0,
    status: 'pending' as const,
    error: null,
    chunkCount: 0,
    pinned: false,
    createdAt: Date.now(),
    indexedAt: null
  }
  await db.insert(knowledgeDocuments).values(row)
  return row
}

export type DocumentPatch = Partial<Pick<KnowledgeDocument, 'title' | 'version' | 'chars' | 'status' | 'error' | 'chunkCount' | 'indexedAt' | 'pinned'>> & {
  status?: KnowledgeDocumentStatus
}

export async function updateDocument(db: Db, id: string, patch: DocumentPatch): Promise<KnowledgeDocument | null> {
  if (Object.keys(patch).length) await db.update(knowledgeDocuments).set(patch).where(eq(knowledgeDocuments.id, id))
  return getDocument(db, id)
}

export async function removeDocument(db: Db, id: string): Promise<void> {
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, id))
}

export interface KnowledgeChunkRow {
  id: string
  documentId: string
  part: number
  locator: string | null
  text: string
  model: string
  embedding: Buffer
}

/** Pezzi di tutti i documenti indicati, per il modello di embedding dato. */
export async function listKnowledgeChunks(db: Db, documentIds: string[], model: string): Promise<KnowledgeChunkRow[]> {
  if (documentIds.length === 0) return []
  return db
    .select()
    .from(knowledgeChunks)
    .where(and(inArray(knowledgeChunks.documentId, documentIds), eq(knowledgeChunks.model, model)))
}

/** Quanti pezzi ha ogni documento con il modello dato. */
export async function countKnowledgeChunks(db: Db, documentIds: string[], model: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (documentIds.length === 0) return out
  const rows = await db
    .select({ documentId: knowledgeChunks.documentId, n: sql<number>`count(*)` })
    .from(knowledgeChunks)
    .where(and(inArray(knowledgeChunks.documentId, documentIds), eq(knowledgeChunks.model, model)))
    .groupBy(knowledgeChunks.documentId)
  for (const r of rows) out.set(r.documentId, Number(r.n))
  return out
}

/**
 * Ricerca a parole esatte (FTS5, BM25) tra i pezzi dei documenti indicati: punteggio positivo per pezzo (più alto =
 * più pertinente). `match` è una query FTS5 già preparata (vedi ftsQuery). Vuoto se la query è vuota.
 */
export async function searchKnowledgeChunks(db: Db, documentIds: string[], model: string, match: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (documentIds.length === 0 || !match.trim()) return out
  const ids = sql.join(documentIds.map((id) => sql`${id}`), sql`, `)
  // Righe come array di valori (driver sqlite-proxy) o come oggetti: si accettano entrambe.
  const rows = (await db.all<unknown>(
    sql`SELECT c.id AS id, -bm25(knowledge_fts) AS rank FROM knowledge_fts
        JOIN knowledge_chunks c ON c.rowid = knowledge_fts.rowid
        WHERE knowledge_fts MATCH ${match} AND c.model = ${model} AND c.document_id IN (${ids})`
  )) as Array<[string, number] | { id: string; rank: number }>
  for (const r of rows) {
    const [id, rank] = Array.isArray(r) ? r : [r.id, r.rank]
    out.set(id, Number(rank))
  }
  return out
}

export async function addKnowledgeChunks(db: Db, rows: Array<Omit<KnowledgeChunkRow, 'id'>>): Promise<void> {
  if (rows.length === 0) return
  await db.insert(knowledgeChunks).values(rows.map((r) => ({ ...r, id: randomUUID(), createdAt: Date.now() })))
}

export async function removeKnowledgeChunks(db: Db, documentId: string): Promise<void> {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId))
}

export async function listConnections(db: Db, baseId: string): Promise<KnowledgeConnection[]> {
  return db
    .select()
    .from(knowledgeConnections)
    .where(eq(knowledgeConnections.baseId, baseId))
    .orderBy(asc(knowledgeConnections.createdAt), asc(sql`rowid`))
}

export async function getConnection(db: Db, id: string): Promise<KnowledgeConnection | null> {
  const [row] = await db.select().from(knowledgeConnections).where(eq(knowledgeConnections.id, id))
  return row ?? null
}

export async function addConnection(db: Db, init: Pick<KnowledgeConnection, 'baseId' | 'source' | 'config'>): Promise<KnowledgeConnection> {
  const row: KnowledgeConnection = { id: randomUUID(), ...init, status: 'ready', error: null, lastSyncAt: null, createdAt: Date.now() }
  await db.insert(knowledgeConnections).values(row)
  return row
}

export async function updateConnection(
  db: Db,
  id: string,
  patch: Partial<Pick<KnowledgeConnection, 'config' | 'status' | 'error' | 'lastSyncAt'>>
): Promise<KnowledgeConnection | null> {
  if (Object.keys(patch).length) await db.update(knowledgeConnections).set(patch).where(eq(knowledgeConnections.id, id))
  return getConnection(db, id)
}

export async function removeConnection(db: Db, id: string): Promise<void> {
  await db.delete(knowledgeConnections).where(eq(knowledgeConnections.id, id))
}

// ---------------------------------------------------------------- monitor del contesto

/** Chiamate tenute per conversazione: le più vecchie vengono cancellate. */
export const CONTEXT_CALLS_KEPT = 50

export async function addContextCall(db: Db, input: ContextCallInput): Promise<ContextCall> {
  const row = { ...input, id: randomUUID(), createdAt: Date.now() }
  await db.insert(contextCalls).values(row)
  const old = await db
    .select({ id: contextCalls.id })
    .from(contextCalls)
    .where(eq(contextCalls.conversationId, input.conversationId))
    .orderBy(desc(contextCalls.createdAt), desc(sql`rowid`))
    .limit(1_000_000)
    .offset(CONTEXT_CALLS_KEPT)
  if (old.length) await db.delete(contextCalls).where(inArray(contextCalls.id, old.map((r) => r.id)))
  return row
}

/** Ultime chiamate della conversazione, dalla più recente. */
export async function listContextCalls(db: Db, conversationId: string): Promise<ContextCall[]> {
  const rows = await db
    .select()
    .from(contextCalls)
    .where(eq(contextCalls.conversationId, conversationId))
    .orderBy(desc(contextCalls.createdAt), desc(sql`rowid`))
    .limit(CONTEXT_CALLS_KEPT)
  return rows.map((r) => ({ ...r, parts: r.parts ?? [] }))
}
