// Basi di conoscenza: ogni conversazione ha la sua (per i documenti dell'utente) e può collegare basi della
// libreria, condivise tra più conversazioni. Il servizio aggiunge documenti tramite i plugin, li divide in
// pezzi con embedding (SQLite, per modello di embedding) e, prima di una risposta, recupera da tutte le basi
// della conversazione i documenti interi o gli estratti pertinenti.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createReadStream } from 'node:fs'
import { getLocale, t } from '@shared/i18n'
import {
  buildDocumentChunks,
  buildBehaviorSection,
  buildExamplesSection,
  buildKnowledgeSection,
  splitKnowledgeBudget,
  ftsQuery,
  hybridScores,
  KNOWLEDGE,
  pickDocumentChunks,
  toKnowledgeRefs,
  totalChars,
  wholeDocuments,
  type PickedDocumentChunk,
  type SectionItem,
  type StoredDocumentChunk
} from '@shared/knowledge'
import { fromBuffer, toBuffer } from '@shared/memory'
import { BASE_PURPOSES, type BasePurpose } from '@shared/types'
import type {
  Conversation,
  DocumentRef,
  KnowledgeBase,
  KnowledgeBaseInfo,
  KnowledgeBaseMeta,
  KnowledgeConnection,
  KnowledgeDocument,
  KnowledgeProgress,
  KnowledgeRef,
  KnowledgeStatus,
  PackInspection
} from '@shared/types'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { knowledgeChunks } from '../db/schema'
import {
  addConnection,
  addDocument,
  addKnowledgeChunks,
  countBaseLinks,
  countKnowledgeChunks,
  createBase,
  findDocumentByHash,
  getBase,
  getConnection,
  getConversation,
  getConversationBase,
  getDocument,
  linkBase,
  clearBase,
  getBaseByPackage,
  listAutoLinkBases,
  listPendingLibraryDocuments,
  listConnections,
  listBasesById,
  listDocuments,
  listKnowledgeChunks,
  listLibraryBases,
  listLinkedBases,
  listLinkPurposes,
  setLinkPurpose,
  searchKnowledgeChunks,
  removeBase,
  removeConnection,
  removeDocument,
  removeKnowledgeChunks,
  unlinkBase,
  updateBase,
  updateConnection,
  updateDocument
} from '../db/repo'
import type { Embedder } from '../embedder'
import { OllamaError } from '../ollama'
import { PACK_EXTENSION, PackError, readPack, slugify, writePack, type PackKnowledge, type PackSigner, type TrustedKeys } from './pack'
import type { SourceRegistry } from './registry'
import { packageUri } from './sources/package'
import { maskConfig, openConfig, plainCipher, sealConfig, type Cipher } from './secrets'
import { SourceError } from './source'

export interface KnowledgeDeps {
  db: Db
  embedder: Embedder
  registry: SourceRegistry
  /** Cifrario per i campi segreti delle connessioni (safeStorage in produzione). */
  cipher?: Cipher
  /** Avanzamento dell'indicizzazione, per l'interfaccia. */
  onProgress?(p: KnowledgeProgress): void
  /** Dove tenere una copia dei pacchetti installati (serve per reindicizzare quelli di solo testo). */
  packsDir?: string
  /** Chiavi pubbliche riconosciute per la firma dei pacchetti. */
  trustedKeys?: TrustedKeys
}

/**
 * Su cosa si lavora: una conversazione (la sua base, creata al primo uso; le chiamate di embedding finiscono
 * nel suo monitor e seguono la CPU/GPU del suo modello) oppure una base della libreria.
 */
export type Owner = Conversation | KnowledgeBase

const isBase = (o: Owner): o is KnowledgeBase => 'origin' in o

interface Target {
  base: KnowledgeBase
  conv: Conversation | null
}

export interface KnowledgeRecall {
  /** Sezione del system prompt ('' se non c'è nulla di pertinente). */
  section: string
  refs: KnowledgeRef[]
}

/** Ciò che le basi danno alla risposta, per tipo: documenti (con le fonti), tecniche ed esempi del ruolo (senza). */
export interface RoleRecall {
  documents: KnowledgeRecall
  behavior: { section: string; count: number }
  examples: { section: string; count: number }
}

/** Impronta del contenuto di un file (SHA-256, in streaming). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export function createKnowledge({ db, embedder, registry, cipher = plainCipher, onProgress, packsDir, trustedKeys = {} }: KnowledgeDeps) {
  /** Indicizzazioni in corso, per documento. */
  const indexing = new Map<string, Promise<void>>()
  /** Coda per base: un documento alla volta, così Ollama non riceve richieste in parallelo. */
  const queues = new Map<string, Promise<void>>()

  const progress = (doc: KnowledgeDocument, done = 0, total = 0): void =>
    onProgress?.({ baseId: doc.baseId, documentId: doc.id, status: doc.status, done, total })

  const fail = (doc: KnowledgeDocument, err: unknown): Promise<KnowledgeDocument | null> => {
    const message = err instanceof SourceError || err instanceof OllamaError || err instanceof Error ? err.message : String(err)
    return updateDocument(db, doc.id, { status: 'error', error: message.slice(0, 500) })
  }

  // ---- basi

  /** La base su cui agire: quella della conversazione (creata se manca) o la base indicata. */
  async function target(owner: Owner): Promise<Target> {
    if (isBase(owner)) {
      // Una base di conversazione usata direttamente porta con sé la sua conversazione (monitor, CPU/GPU).
      const conv = owner.conversationId ? await getConversation(db, owner.conversationId) : null
      return { base: owner, conv }
    }
    const base = (await getConversationBase(db, owner.id)) ?? (await createBase(db, { origin: 'conversation', conversationId: owner.id }))
    return { base, conv: owner }
  }

  /** Basi che la conversazione usa: la sua (se esiste) e quelle collegate. */
  async function basesOf(conversationId: string): Promise<{ own: KnowledgeBase | null; linked: KnowledgeBase[] }> {
    return { own: await getConversationBase(db, conversationId), linked: await listLinkedBases(db, conversationId) }
  }

  /** Conversazione o base della libreria dall'id (per l'IPC: il renderer indica su cosa sta lavorando). */
  async function owner(id: string): Promise<Owner> {
    const found = (await getConversation(db, id)) ?? (await getBase(db, id))
    if (!found) throw new Error(t('err.knowledge.baseNotFound'))
    return found
  }

  /** Modello di embedding di ogni base: il suo (dichiarato dal pacchetto) o quello delle Impostazioni. */
  async function modelsOf(baseIds: string[]): Promise<Map<string, string>> {
    const fallback = await embedder.model()
    const bases = await listBasesById(db, [...new Set(baseIds)])
    return new Map(bases.map((b) => [b.id, b.embeddingModel ?? fallback]))
  }

  /**
   * Numeri di un insieme di documenti, ciascuno con il modello della sua base: pezzi, caratteri, pronti, e quali
   * sono usabili (il loro modello di embedding è installato in Ollama).
   */
  async function measure(documents: KnowledgeDocument[]) {
    const models = await modelsOf(documents.map((d) => d.baseId))
    const modelOf = (d: KnowledgeDocument): string => models.get(d.baseId) ?? ''
    const counts = new Map<string, number>()
    const chars = new Map<string, number>()
    for (const model of new Set(documents.map(modelOf))) {
      const ids = documents.filter((d) => modelOf(d) === model).map((d) => d.id)
      for (const [id, n] of await countKnowledgeChunks(db, ids, model)) counts.set(id, n)
      const sizes = await db
        .select({ documentId: knowledgeChunks.documentId, chars: sql<number>`sum(length(${knowledgeChunks.text}))` })
        .from(knowledgeChunks)
        .where(and(inArray(knowledgeChunks.documentId, ids), eq(knowledgeChunks.model, model)))
        .groupBy(knowledgeChunks.documentId)
      for (const r of sizes) chars.set(r.documentId, Number(r.chars))
    }
    const ready = documents.filter((d) => d.status === 'ready' && counts.get(d.id))
    const installed = await embedder.installedAmong(new Set(models.values()))
    const usable = ready.filter((d) => installed.has(modelOf(d)))
    return { counts, ready, usable, chars, models, modelOf, installed }
  }

  /** Basi della libreria con i loro numeri. */
  async function describe(bases: KnowledgeBase[]): Promise<KnowledgeBaseInfo[]> {
    const docs = await listDocuments(db, bases.map((b) => b.id))
    const { ready, chars } = await measure(docs)
    const links = await countBaseLinks(db, bases.map((b) => b.id))
    const models = await modelsOf(bases.map((b) => b.id))
    const installed = await embedder.installedAmong(new Set(models.values()))
    return bases.map((b) => ({
      ...b,
      documents: docs.filter((d) => d.baseId === b.id).length,
      ready: ready.filter((d) => d.baseId === b.id).length,
      chars: ready.filter((d) => d.baseId === b.id).reduce((n, d) => n + (chars.get(d.id) ?? 0), 0),
      conversations: links.get(b.id) ?? 0,
      model: models.get(b.id) ?? '',
      modelInstalled: installed.has(models.get(b.id) ?? '')
    }))
  }

  const listBases = async (): Promise<KnowledgeBaseInfo[]> => describe(await listLibraryBases(db))

  async function libraryBase(id: string): Promise<KnowledgeBase> {
    const base = await getBase(db, id)
    if (!base || base.origin === 'conversation') throw new Error(t('err.knowledge.baseNotFound'))
    return base
  }

  /** Nuova base della libreria. */
  async function createLibraryBase(name: string, description = ''): Promise<KnowledgeBaseInfo> {
    if (!name.trim()) throw new Error(t('err.knowledge.baseName'))
    return (await describe([await createBase(db, { name, description, origin: 'local' })]))[0]
  }

  async function renameBase(id: string, patch: { name?: string; description?: string; autoLink?: boolean }): Promise<KnowledgeBaseInfo> {
    await libraryBase(id)
    if (patch.name !== undefined && !patch.name.trim()) throw new Error(t('err.knowledge.baseName'))
    return (await describe([(await updateBase(db, id, patch))!]))[0]
  }

  /** Elimina una base della libreria: sparisce da tutte le conversazioni che la collegano, con documenti e pezzi. */
  async function removeLibraryBase(id: string): Promise<void> {
    const base = await libraryBase(id)
    // Tornerebbe comunque al prossimo avvio: è ciò che l'app sa di suo.
    if (base.meta?.trust === 'builtin' && base.packageId?.startsWith('app.')) throw new Error(t('err.knowledge.builtin'))
    await removeBase(db, id)
  }

  async function link(conv: Conversation, baseId: string): Promise<void> {
    await libraryBase(baseId)
    await linkBase(db, conv.id, baseId)
  }

  const unlink = (conv: Conversation, baseId: string): Promise<void> => unlinkBase(db, conv.id, baseId)

  /** Collega alla conversazione (appena creata) le basi segnate «collega alle nuove conversazioni». */
  async function linkDefaults(conv: Conversation): Promise<void> {
    for (const base of await listAutoLinkBases(db)) await linkBase(db, conv.id, base.id)
  }

  // ---- indicizzazione

  /** Legge il documento con il suo plugin, lo divide in pezzi, calcola gli embedding e li salva. */
  async function run(doc: KnowledgeDocument, conv: Conversation | null, signal: AbortSignal): Promise<void> {
    let current = (await updateDocument(db, doc.id, { status: 'indexing', error: null })) ?? doc
    progress(current)
    try {
      const source = registry.get(current.source) ?? registry.sourceFor(current.ref)
      const connection = current.connectionId ? await getConnection(db, current.connectionId) : null
      const config = connection ? openConfig(source, connection.config, cipher) : {}
      const extracted = await source.extract(current.ref, config, signal)
      const chars = extracted.sections.reduce((n, s) => n + s.text.length, 0)
      if (chars > KNOWLEDGE.maxChars) throw new SourceError('tooLong', t('err.knowledge.tooLong', { name: current.title, max: Math.round(KNOWLEDGE.maxChars / 1000) }))
      const drafts = buildDocumentChunks(extracted.sections)
      if (drafts.length === 0) throw new SourceError('empty', t('err.knowledge.empty', { name: current.title }))
      const model = (await modelsOf([current.baseId])).get(current.baseId) ?? (await embedder.model())
      await removeKnowledgeChunks(db, current.id)
      const title = extracted.title.trim() || current.title
      current = (await updateDocument(db, current.id, { title, chars, version: extracted.version ?? current.version ?? null, chunkCount: 0 })) ?? current
      const batches = Math.ceil(drafts.length / KNOWLEDGE.embedBatch)
      for (let i = 0; i < drafts.length; i += KNOWLEDGE.embedBatch) {
        if (signal.aborted) throw new Error(t('err.knowledge.aborted'))
        const batch = drafts.slice(i, i + KNOWLEDGE.embedBatch)
        const vectors = await embedder.embed({
          conversationId: conv?.id ?? null,
          kind: 'embed-doc',
          texts: batch.map((d) => d.text),
          chatModel: conv?.model || null,
          cpt: 4,
          model,
          note: batches > 1 ? t('call.note.doc', { title, i: Math.floor(i / KNOWLEDGE.embedBatch) + 1, n: batches }) : title
        })
        await addKnowledgeChunks(
          db,
          batch.map((d, j) => ({ documentId: current.id, part: d.part, locator: d.locator, text: d.text, model, embedding: toBuffer(vectors[j]) }))
        )
        progress({ ...current, status: 'indexing' }, Math.min(drafts.length, i + batch.length), drafts.length)
      }
      const ready = await updateDocument(db, current.id, { status: 'ready', chunkCount: drafts.length, indexedAt: Date.now(), error: null })
      if (ready) progress(ready, drafts.length, drafts.length)
    } catch (err) {
      // Nel frattempo il documento può essere stato rimosso.
      if (!(await getDocument(db, current.id))) return
      const failed = await fail(current, err)
      if (failed) progress(failed)
    }
  }

  /** Mette in coda l'indicizzazione di un documento (una alla volta per base). */
  function enqueue(doc: KnowledgeDocument, conv: Conversation | null, signal = new AbortController().signal): Promise<void> {
    const running = indexing.get(doc.id)
    if (running) return running
    const previous = queues.get(doc.baseId) ?? Promise.resolve()
    const job = previous.then(() => run(doc, conv, signal)).finally(() => indexing.delete(doc.id))
    indexing.set(doc.id, job)
    const chained = job.catch(() => undefined)
    queues.set(doc.baseId, chained)
    void chained.then(() => {
      if (queues.get(doc.baseId) === chained) queues.delete(doc.baseId)
    })
    return job
  }

  /**
   * Aggiunge file alla base: controlla dimensione e plugin, salta i duplicati (stessa impronta), registra il
   * documento e lo indicizza in sottofondo. Restituisce i documenti creati o già presenti.
   */
  async function addFiles(owner: Owner, paths: string[]): Promise<KnowledgeDocument[]> {
    const { base, conv } = await target(owner)
    editable(base)
    const out: KnowledgeDocument[] = []
    for (const path of paths) {
      const ref: DocumentRef = { kind: 'file', path }
      const source = registry.sourceFor(ref)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) throw new SourceError('read', t('err.knowledge.read', { name: path.split(/[\\/]/).pop() ?? path, error: t('err.knowledge.notFile') }))
      if (info.size > KNOWLEDGE.maxBytes) throw new SourceError('tooBig', t('err.knowledge.tooBig', { name: path.split(/[\\/]/).pop() ?? path, max: Math.round(KNOWLEDGE.maxBytes / 1024 / 1024) }))
      const hash = await hashFile(path)
      const existing = await findDocumentByHash(db, base.id, hash)
      if (existing) {
        out.push(existing)
        continue
      }
      const title = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '')
      const doc = await addDocument(db, { baseId: base.id, source: source.id, title, ref, hash, bytes: info.size })
      out.push(doc)
      void enqueue(doc, conv)
    }
    return out
  }

  /** Le basi installate da un pacchetto non si modificano: il contenuto è quello del pacchetto. */
  function editable(base: KnowledgeBase): void {
    if (base.origin === 'package') throw new Error(t('err.knowledge.readOnly'))
  }

  /** Il documento, se appartiene alla base su cui si sta lavorando. */
  async function ownDocument(owner: Owner, documentId: string): Promise<{ doc: KnowledgeDocument; conv: Conversation | null }> {
    const { base, conv } = await target(owner)
    const doc = await getDocument(db, documentId)
    if (!doc || doc.baseId !== base.id) throw new Error(t('err.knowledge.docNotFound'))
    return { doc, conv }
  }

  /** Rifà l'indice di un documento (dopo un errore, o dopo aver cambiato il modello di embedding). */
  async function reindex(owner: Owner, documentId: string): Promise<KnowledgeDocument> {
    const { doc, conv } = await ownDocument(owner, documentId)
    await enqueue(doc, conv)
    return (await getDocument(db, documentId)) ?? doc
  }

  async function remove(owner: Owner, documentId: string): Promise<void> {
    editable((await target(owner)).base)
    await ownDocument(owner, documentId)
    await removeDocument(db, documentId)
  }

  /** Tutti i documenti che la conversazione usa, con la base da cui vengono. */
  async function documentsOf(conversationId: string): Promise<{ docs: KnowledgeDocument[]; own: KnowledgeBase | null; linked: KnowledgeBase[] }> {
    const { own, linked } = await basesOf(conversationId)
    const ids = [...(own ? [own.id] : []), ...linked.map((b) => b.id)]
    return { docs: await listDocuments(db, ids), own, linked }
  }

  /**
   * Documenti in attesa, o indicizzati con un altro modello di embedding: si rifanno in sottofondo. Le basi con
   * il modello dichiarato dal pacchetto hanno già i loro vettori e non si toccano.
   */
  async function ensureModel(conv: Conversation): Promise<void> {
    const { docs, own, linked } = await documentsOf(conv.id)
    const fixed = new Set(linked.filter((b) => b.embeddingModel).map((b) => b.id))
    const { counts } = await measure(docs)
    // I documenti della conversazione si registrano nel suo monitor; quelli delle basi collegate no.
    for (const d of docs) {
      if (fixed.has(d.baseId)) continue
      if ((d.status === 'ready' && !counts.get(d.id)) || d.status === 'pending') void enqueue(d, d.baseId === own?.id ? conv : null)
    }
  }

  /**
   * Documenti usabili delle basi della conversazione (pronti, con pezzi, e con il modello di embedding installato),
   * ciascuno con l'uso della sua base: i documenti della conversazione sono sempre `documents`; quelli di una base
   * collegata seguono l'uso scelto per il collegamento.
   */
  async function readyDocuments(conversationId: string) {
    const { docs, own, linked } = await documentsOf(conversationId)
    const { usable, modelOf } = await measure(docs)
    const purposes = await listLinkPurposes(db, conversationId)
    const purposeOf = (d: KnowledgeDocument): BasePurpose => purposes.get(d.baseId) ?? 'documents'
    return { docs: usable, own, linked, modelOf, purposeOf }
  }

  /** Vero se la conversazione ha almeno un documento usabile su cui rispondere (per abilitare il bottone libro). */
  async function hasReady(conversationId: string): Promise<boolean> {
    const { docs, purposeOf } = await readyDocuments(conversationId)
    return docs.some((d) => purposeOf(d) === 'documents')
  }

  /** Vero se la conversazione ha basi di comportamento o di esempi usabili: quelle entrano sempre, anche a libro spento. */
  async function hasRole(conversationId: string): Promise<boolean> {
    const { docs, purposeOf } = await readyDocuments(conversationId)
    return docs.some((d) => purposeOf(d) !== 'documents')
  }

  type Question = { text: string; vector(model: string): Promise<ArrayLike<number> | null> }

  /** I pezzi dei documenti indicati, per modello di embedding (i vettori di modelli diversi non si mescolano). */
  async function loadChunks(docs: KnowledgeDocument[], modelOf: (d: KnowledgeDocument) => string): Promise<Map<string, StoredDocumentChunk[]>> {
    const titles = new Map(docs.map((d) => [d.id, d.title]))
    const groups = new Map<string, StoredDocumentChunk[]>()
    for (const model of new Set(docs.map(modelOf))) {
      const ids = docs.filter((d) => modelOf(d) === model).map((d) => d.id)
      groups.set(
        model,
        (await listKnowledgeChunks(db, ids, model)).map((c) => ({
          id: c.id,
          documentId: c.documentId,
          title: titles.get(c.documentId) ?? '',
          locator: c.locator,
          part: c.part,
          text: c.text,
          embedding: fromBuffer(c.embedding)
        }))
      )
    }
    return groups
  }

  /**
   * Sceglie cosa dare al modello entro `maxChars`:
   * 1. se tutto sta nello spazio, i documenti vanno per intero (il modello può contare e sommare): non serve
   *    nessun embedding della domanda;
   * 2. altrimenti prima i documenti «fissati» per intero (finché stanno), poi gli estratti scelti con il
   *    punteggio ibrido (somiglianza semantica + parole esatte) nello spazio che resta.
   */
  async function choose(docs: KnowledgeDocument[], groups: Map<string, StoredDocumentChunk[]>, question: Question, maxChars: number): Promise<{ whole: SectionItem[]; picked: PickedDocumentChunk[] }> {
    const chunks = [...groups.values()].flat()
    if (totalChars(chunks) <= maxChars) return { whole: chunks.map((c) => ({ ...c, whole: true })), picked: [] }
    const pinnedIds = new Set(docs.filter((d) => d.pinned).map((d) => d.id))
    const { picked: whole } = wholeDocuments(chunks, pinnedIds, maxChars)
    const room = maxChars - totalChars(whole)
    // Punteggio ibrido per gruppo (ogni modello con il suo vettore della domanda), poi una sola scelta su tutti.
    const scores = new Map<string, number>()
    const rest: StoredDocumentChunk[] = []
    const fts = ftsQuery(question.text)
    if (room > 0) {
      for (const [model, group] of groups) {
        const candidates = group.filter((c) => !pinnedIds.has(c.documentId))
        if (candidates.length === 0) continue
        const vector = await question.vector(model).catch(() => null)
        if (!vector) continue
        const bm25 = await searchKnowledgeChunks(db, [...new Set(candidates.map((c) => c.documentId))], model, fts).catch(() => new Map<string, number>())
        for (const [id, score] of hybridScores(vector, candidates, bm25)) scores.set(id, score)
        rest.push(...candidates)
      }
    }
    return { whole: whole.map((c) => ({ ...c, whole: true })), picked: rest.length ? pickDocumentChunks([], rest, room, { scores }) : [] }
  }

  /**
   * Ciò che le basi della conversazione danno alla risposta, entro `total` token divisi in quote per tipo:
   * - `documents`: i contenuti su cui rispondere, con le fonti; solo se `documents` è vero (pill e bottone libro);
   * - `behavior` ed `examples`: tecniche ed esempi del ruolo, sempre, senza fonti.
   * Lo spazio che un tipo non usa passa agli altri. `question.vector(model)` dà l'embedding della domanda con il
   * modello indicato: le basi possono avere modelli diversi e i vettori non si mescolano.
   */
  async function recallAll(
    conv: Conversation,
    question: Question,
    budget: { total: number; shares?: Record<BasePurpose, number>; documents?: boolean },
    cpt: number
  ): Promise<RoleRecall> {
    const out: RoleRecall = { documents: { section: '', refs: [] }, behavior: { section: '', count: 0 }, examples: { section: '', count: 0 } }
    if (budget.total < 64) return out
    const { docs: all, linked, modelOf, purposeOf } = await readyDocuments(conv.id)
    const of = (purpose: BasePurpose): KnowledgeDocument[] => (purpose === 'documents' && budget.documents === false ? [] : all.filter((d) => purposeOf(d) === purpose))
    const docs = { documents: of('documents'), behavior: of('behavior'), examples: of('examples') }
    if (all.length === 0 || BASE_PURPOSES.every((k) => docs[k].length === 0)) return out
    const groups = { documents: await loadChunks(docs.documents, modelOf), behavior: await loadChunks(docs.behavior, modelOf), examples: await loadChunks(docs.examples, modelOf) }
    const need = (k: BasePurpose): number => Math.ceil(totalChars([...groups[k].values()].flat()) / cpt)
    const tokens = splitKnowledgeBudget(budget.total, budget.shares ?? { documents: 1, behavior: 0, examples: 0 }, { documents: need('documents'), behavior: need('behavior'), examples: need('examples') })

    for (const k of ['behavior', 'examples'] as const) {
      if (docs[k].length === 0 || tokens[k] <= 0) continue
      const { whole, picked } = await choose(docs[k], groups[k], question, tokens[k] * cpt)
      const items = [...whole, ...picked]
      out[k] = { section: k === 'behavior' ? buildBehaviorSection(items) : buildExamplesSection(items), count: items.length }
    }
    if (docs.documents.length && tokens.documents > 0) {
      // Le fonti dicono da quale base della libreria viene il documento.
      const baseNames = new Map(linked.map((b) => [b.id, b.meta?.i18n?.[getLocale()]?.name ?? b.name]))
      const baseOf = new Map(docs.documents.map((d) => [d.id, baseNames.get(d.baseId)]))
      const withBase = (refs: KnowledgeRef[]): KnowledgeRef[] => refs.map((r) => (baseOf.get(r.documentId) ? { ...r, base: baseOf.get(r.documentId) } : r))
      const { whole, picked } = await choose(docs.documents, groups.documents, question, tokens.documents * cpt)
      if (whole.length || picked.length) out.documents = { section: buildKnowledgeSection([...whole, ...picked]), refs: withBase(toKnowledgeRefs(whole, picked)) }
    }
    return out
  }

  /** I soli documenti su cui rispondere, entro `maxTokens` (senza le basi di comportamento e di esempi). */
  async function recall(conv: Conversation, question: Question, maxTokens: number, cpt: number): Promise<KnowledgeRecall> {
    const { docs, purposeOf } = await readyDocuments(conv.id)
    // Solo i documenti: lo spazio è tutto loro, e le basi del ruolo non lo consumano.
    if (!docs.some((d) => purposeOf(d) === 'documents')) return { section: '', refs: [] }
    return (await recallAll(conv, question, { total: maxTokens, shares: { documents: 1, behavior: 0, examples: 0 }, documents: true }, cpt)).documents
  }

  /** Cambia l'uso di una base collegata alla conversazione. */
  async function setPurpose(conv: Conversation, baseId: string, purpose: BasePurpose): Promise<void> {
    if (!BASE_PURPOSES.includes(purpose)) throw new Error(t('err.knowledge.purpose'))
    if (!(await listLinkedBases(db, conv.id)).some((b) => b.id === baseId)) throw new Error(t('err.knowledge.baseNotFound'))
    await setLinkPurpose(db, conv.id, baseId, purpose)
  }

  /** «Intero» sì/no per un documento. */
  async function setPinned(owner: Owner, documentId: string, pinned: boolean): Promise<KnowledgeDocument> {
    await ownDocument(owner, documentId)
    return (await updateDocument(db, documentId, { pinned }))!
  }

  // ---- sorgenti collegate

  const sourceOf = (connection: KnowledgeConnection) => {
    const source = registry.get(connection.source)
    if (!source || source.kind !== 'connected' || !source.list) throw new Error(t('err.knowledge.sourceMissing', { id: connection.source }))
    return source
  }

  /** La connessione come la vede il renderer: segreti mascherati. */
  const masked = (c: KnowledgeConnection): KnowledgeConnection => {
    const source = registry.get(c.source)
    return source ? { ...c, config: maskConfig(source, c.config) } : c
  }

  /** Collega una sorgente alla base e la sincronizza subito. */
  async function connect(owner: Owner, sourceId: string, config: Record<string, unknown>): Promise<KnowledgeConnection> {
    const source = registry.get(sourceId)
    if (!source || source.kind !== 'connected') throw new Error(t('err.knowledge.sourceMissing', { id: sourceId }))
    const sealed = sealConfig(source, config, cipher)
    const { base } = await target(owner)
    editable(base)
    const connection = await addConnection(db, { baseId: base.id, source: sourceId, config: sealed })
    return masked(await refresh(owner, connection.id))
  }

  async function ownConnection(owner: Owner, connectionId: string) {
    const { base, conv } = await target(owner)
    const connection = await getConnection(db, connectionId)
    if (!connection || connection.baseId !== base.id) throw new Error(t('err.knowledge.connectionNotFound'))
    return { connection, base, conv }
  }

  /**
   * «Aggiorna»: chiede alla sorgente l'elenco dei documenti e lo confronta con quelli salvati: nuovi indicizzati,
   * cambiati (versione diversa) reindicizzati, spariti rimossi. Nessuna sincronizzazione automatica: la lancia l'utente.
   */
  async function refresh(owner: Owner, connectionId: string): Promise<KnowledgeConnection> {
    const { connection, base, conv } = await ownConnection(owner, connectionId)
    const source = sourceOf(connection)
    await updateConnection(db, connectionId, { status: 'syncing', error: null })
    try {
      const listed = await source.list!(openConfig(source, connection.config, cipher), new AbortController().signal)
      const existing = (await listDocuments(db, base.id)).filter((d) => d.connectionId === connectionId)
      const byUri = new Map(existing.map((d) => [d.ref.kind === 'remote' ? d.ref.uri : '', d]))
      const seen = new Set<string>()
      for (const item of listed) {
        if (item.ref.kind !== 'remote') continue
        seen.add(item.ref.uri)
        const current = byUri.get(item.ref.uri)
        if (!current) {
          const doc = await addDocument(db, { baseId: base.id, connectionId, source: source.id, title: item.title, ref: item.ref, version: item.version ?? null, bytes: item.bytes ?? null })
          void enqueue(doc, conv)
        } else if ((item.version ?? null) !== current.version || current.status === 'error') {
          const doc = (await updateDocument(db, current.id, { version: item.version ?? null })) ?? current
          void enqueue(doc, conv)
        }
      }
      for (const d of existing) if (d.ref.kind === 'remote' && !seen.has(d.ref.uri)) await removeDocument(db, d.id)
      return (await updateConnection(db, connectionId, { status: 'ready', error: null, lastSyncAt: Date.now() }))!
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return (await updateConnection(db, connectionId, { status: 'error', error: message.slice(0, 500) }))!
    }
  }

  /** Scollega la sorgente: i suoi documenti e pezzi spariscono con lei. */
  async function disconnect(owner: Owner, connectionId: string): Promise<void> {
    await ownConnection(owner, connectionId)
    await removeConnection(db, connectionId)
  }

  // ---- pacchetti

  /** Legge un pacchetto senza installarlo: cosa contiene, se la firma è riconosciuta, se il suo modello c'è. */
  async function inspectPack(path: string): Promise<PackInspection> {
    const { manifest, trust } = await readPack(await readFile(path), trustedKeys)
    const existing = await getBaseByPackage(db, manifest.id)
    const model = manifest.embedding?.model
    return { path, manifest, trust, installedVersion: existing ? existing.version : null, modelInstalled: model ? await embedder.installed(model) : true }
  }

  /**
   * Installa un pacchetto di conoscenza come base della libreria (o aggiorna quella già installata dallo stesso
   * pacchetto, che resta collegata alle sue conversazioni). Con i vettori: i pezzi sono subito pronti, legati
   * al modello di embedding dichiarato. Di solo testo: i documenti si indicizzano con il modello dell'utente.
   * Senza firma riconosciuta serve la conferma esplicita (`allowUntrusted`); i pacchetti dell'app sono fidati.
   */
  async function installPack(path: string, opts: { allowUntrusted?: boolean; builtin?: boolean; store?: boolean } = {}): Promise<KnowledgeBaseInfo> {
    const data = await readFile(path)
    const { manifest, knowledge, vectors, trust } = await readPack(data, trustedKeys)
    if (manifest.type !== 'knowledge' || !knowledge) throw new PackError(t('err.pack.unsupported', { type: manifest.type }))
    if (trust !== 'verified' && !opts.builtin && !opts.allowUntrusted) throw new PackError(t('err.pack.untrusted'))
    let stored = path
    if (packsDir) {
      await mkdir(packsDir, { recursive: true })
      stored = join(packsDir, `${manifest.id}.${PACK_EXTENSION}`)
      if (resolve(stored) !== resolve(path)) await writeFile(stored, data)
    }
    const meta: KnowledgeBaseMeta = {
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.language ? { language: manifest.language } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(manifest.embedding ? { dimensions: manifest.embedding.dimensions, digest: manifest.embedding.digest ?? null } : {}),
      ...(manifest.i18n ? { i18n: manifest.i18n } : {}),
      trust: opts.builtin ? 'builtin' : trust,
      ...(opts.store ? { store: true } : {})
    }
    const fields = { name: manifest.name, description: manifest.description ?? '', version: manifest.version, embeddingModel: manifest.embedding?.model ?? null, packageId: manifest.id, meta }
    const existing = await getBaseByPackage(db, manifest.id)
    if (existing) await clearBase(db, existing.id)
    const base = existing ? (await updateBase(db, existing.id, fields))! : await createBase(db, { ...fields, origin: 'package' })
    const dims = manifest.embedding?.dimensions ?? 0
    let offset = 0
    for (const [i, d] of knowledge.documents.entries()) {
      const doc = await addDocument(db, { baseId: base.id, source: 'package', title: d.title, ref: { kind: 'remote', sourceId: 'package', uri: packageUri(stored, i) }, version: manifest.version })
      if (vectors && manifest.embedding) {
        const rows = d.chunks.map((c, part) => ({
          documentId: doc.id,
          part,
          locator: c.locator,
          text: c.text,
          model: manifest.embedding!.model,
          embedding: Buffer.from(vectors.buffer, vectors.byteOffset + (offset + part * dims) * 4, dims * 4)
        }))
        // A blocchi: SQLite ha un limite al numero di parametri per istruzione.
        for (let k = 0; k < rows.length; k += 200) await addKnowledgeChunks(db, rows.slice(k, k + 200))
        offset += d.chunks.length * dims
        await updateDocument(db, doc.id, { status: 'ready', chunkCount: d.chunks.length, chars: d.chunks.reduce((n, c) => n + c.text.length, 0), indexedAt: Date.now(), pinned: d.pinned === true })
      } else if (d.pinned) {
        await updateDocument(db, doc.id, { pinned: true })
      }
    }
    if (!vectors) void resumePending()
    return (await describe([base]))[0]
  }

  /**
   * Indicizza i documenti rimasti in attesa nelle basi della libreria, se il loro modello di embedding è
   * installato: un pacchetto di solo testo installato senza il modello aspetta qui finché non lo si scarica.
   */
  async function resumePending(): Promise<void> {
    const docs = await listPendingLibraryDocuments(db)
    if (docs.length === 0) return
    const models = await modelsOf(docs.map((d) => d.baseId))
    const installed = await embedder.installedAmong(new Set(models.values()))
    for (const d of docs) if (installed.has(models.get(d.baseId) ?? '')) void enqueue(d, null)
  }

  /** Pacchetti installati: id del pacchetto → base e versione (per lo store). */
  async function installedPacks(): Promise<Map<string, KnowledgeBase>> {
    return new Map((await listLibraryBases(db)).filter((b) => b.origin === 'package' && b.packageId).map((b) => [b.packageId!, b]))
  }

  /** Installa o aggiorna i pacchetti integrati nell'app (cartella `packs/`): è ciò che l'app sa di suo. */
  async function installBuiltin(dir: string): Promise<void> {
    const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(`.${PACK_EXTENSION}`)).sort()
    for (const name of names) {
      try {
        const path = join(dir, name)
        const { manifest, installedVersion } = await inspectPack(path)
        if (installedVersion !== manifest.version) await installPack(path, { builtin: true })
      } catch {
        /* un pacchetto integrato difettoso non deve impedire l'avvio */
      }
    }
    await resumePending()
  }

  /**
   * Esporta una base della libreria come pacchetto, con i vettori del suo modello di embedding dichiarato nel
   * manifest: chi lo installa deve avere quel modello. Senza chi firma il pacchetto è «non firmato».
   */
  async function exportBase(baseId: string, opts: { author?: string; version?: string; signer?: PackSigner } = {}): Promise<{ data: Buffer; fileName: string }> {
    const base = await libraryBase(baseId)
    if (base.origin !== 'local') throw new PackError(t('err.pack.exportLocal'))
    const docs = await listDocuments(db, base.id)
    if (docs.length === 0) throw new PackError(t('err.pack.empty'))
    const { counts, models } = await measure(docs)
    if (docs.some((d) => d.status !== 'ready' || !counts.get(d.id))) throw new PackError(t('err.pack.notReady'))
    const model = models.get(base.id)!
    const chunks = await listKnowledgeChunks(db, docs.map((d) => d.id), model)
    const dims = fromBuffer(chunks[0].embedding).length
    const knowledge: PackKnowledge = { documents: [] }
    const vectors = new Float32Array(chunks.length * dims)
    let at = 0
    for (const d of docs) {
      const own = chunks.filter((c) => c.documentId === d.id).sort((a, b) => a.part - b.part)
      const path = d.ref.kind === 'file' ? d.ref.path : d.ref.uri
      knowledge.documents.push({ title: d.title, source: path.split('.').pop()?.toLowerCase(), ...(d.pinned ? { pinned: true } : {}), chunks: own.map((c) => ({ locator: c.locator, text: c.text })) })
      for (const c of own) {
        vectors.set(fromBuffer(c.embedding), at)
        at += dims
      }
    }
    const version = opts.version ?? base.version ?? '1.0.0'
    const data = await writePack({
      manifest: {
        id: `local.${slugify(base.name)}-${base.id.slice(0, 8)}`,
        type: 'knowledge',
        name: base.name,
        version,
        ...(base.description ? { description: base.description } : {}),
        ...(opts.author ? { author: opts.author } : {}),
        createdAt: Date.now(),
        embedding: { model, dimensions: dims, digest: await embedder.digest(model) }
      },
      knowledge,
      vectors,
      signer: opts.signer
    })
    return { data, fileName: `${slugify(base.name)}-${version}.${PACK_EXTENSION}` }
  }

  /**
   * Stato: per una conversazione, i documenti della sua base (modificabili da lì) più le basi collegate e i
   * totali su tutto ciò che la conversazione usa; per una base della libreria, i suoi documenti.
   */
  async function status(owner: Owner): Promise<KnowledgeStatus> {
    // Guardare lo stato non crea la base della conversazione: nasce al primo documento.
    const own = isBase(owner) ? owner : await getConversationBase(db, owner.id)
    const linked = isBase(owner) ? [] : await listLinkedBases(db, owner.id)
    const documents = own ? await listDocuments(db, own.id) : []
    const purposes = isBase(owner) ? new Map<string, BasePurpose>() : await listLinkPurposes(db, owner.id)
    // «Pronti» e dimensioni riguardano i documenti su cui rispondere: le basi di comportamento e di esempi sono a parte.
    const all = [...documents, ...(await listDocuments(db, linked.filter((b) => (purposes.get(b.id) ?? 'documents') === 'documents').map((b) => b.id)))]
    const { counts, usable: ready, chars, models, installed } = await measure(all)
    const model = (own && models.get(own.id)) || (own?.embeddingModel ?? (await embedder.model()))
    let chunks = 0
    let pending = 0
    for (const d of documents) {
      const n = counts.get(d.id) ?? 0
      chunks += n
      if (d.status === 'pending' || d.status === 'indexing' || (d.status === 'ready' && n === 0)) pending++
    }
    const sum = (docs: KnowledgeDocument[]): number => docs.reduce((n, d) => n + (chars.get(d.id) ?? 0), 0)
    return {
      baseId: own?.id ?? null,
      documents,
      connections: own ? (await listConnections(db, own.id)).map(masked) : [],
      linked: (await describe(linked)).map((b) => ({ ...b, purpose: purposes.get(b.id) ?? 'documents' })),
      chunks,
      pending,
      ready: ready.length,
      totalChars: sum(ready),
      pinnedChars: sum(ready.filter((d) => d.pinned)),
      model,
      modelInstalled: installed.has(model) || (await embedder.installed(model))
    }
  }

  /** Per i test: attende la fine delle indicizzazioni in corso (id di una conversazione o di una base). */
  async function wait(id: string): Promise<void> {
    for (;;) {
      const { own, linked } = await basesOf(id)
      const q = [id, own?.id, ...linked.map((b) => b.id)].map((k) => (k ? queues.get(k) : undefined)).find(Boolean)
      if (!q) return
      await q
    }
  }

  return {
    embedder,
    owner,
    listBases,
    createBase: createLibraryBase,
    renameBase,
    removeBase: removeLibraryBase,
    link,
    unlink,
    linkDefaults,
    inspectPack,
    installPack,
    installBuiltin,
    installedPacks,
    resumePending,
    exportBase,
    documentsOf,
    addFiles,
    reindex,
    remove,
    setPinned,
    connect,
    refresh,
    disconnect,
    ensureModel,
    hasReady,
    hasRole,
    recall,
    recallAll,
    setPurpose,
    status,
    wait,
    isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model'
  }
}

export type Knowledge = ReturnType<typeof createKnowledge>
