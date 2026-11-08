// Base di conoscenza di una conversazione: aggiunge documenti tramite i plugin, li divide in pezzi con
// embedding (SQLite, per modello di embedding) e, prima di una risposta, recupera gli estratti pertinenti.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { t } from '@shared/i18n'
import { buildDocumentChunks, buildKnowledgeSection, ftsQuery, KNOWLEDGE, pickDocumentChunks, toKnowledgeRefs, totalChars, wholeDocuments, type SectionItem } from '@shared/knowledge'
import { fromBuffer, toBuffer } from '@shared/memory'
import type { Conversation, DocumentRef, KnowledgeConnection, KnowledgeDocument, KnowledgeProgress, KnowledgeRef, KnowledgeStatus } from '@shared/types'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { knowledgeChunks } from '../db/schema'
import {
  addConnection,
  addDocument,
  addKnowledgeChunks,
  countKnowledgeChunks,
  findDocumentByHash,
  getConnection,
  getDocument,
  listConnections,
  listDocuments,
  listKnowledgeChunks,
  searchKnowledgeChunks,
  removeConnection,
  removeDocument,
  removeKnowledgeChunks,
  updateConnection,
  updateDocument
} from '../db/repo'
import type { Embedder } from '../embedder'
import { OllamaError } from '../ollama'
import type { SourceRegistry } from './registry'
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
}

export interface KnowledgeRecall {
  /** Sezione del system prompt ('' se non c'è nulla di pertinente). */
  section: string
  refs: KnowledgeRef[]
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

export function createKnowledge({ db, embedder, registry, cipher = plainCipher, onProgress }: KnowledgeDeps) {
  /** Indicizzazioni in corso, per documento. */
  const indexing = new Map<string, Promise<void>>()
  /** Coda per conversazione: un documento alla volta, così Ollama non riceve richieste in parallelo. */
  const queues = new Map<string, Promise<void>>()

  const progress = (doc: KnowledgeDocument, done = 0, total = 0): void =>
    onProgress?.({ conversationId: doc.conversationId, documentId: doc.id, status: doc.status, done, total })

  const fail = (doc: KnowledgeDocument, err: unknown): Promise<KnowledgeDocument | null> => {
    const message = err instanceof SourceError || err instanceof OllamaError || err instanceof Error ? err.message : String(err)
    return updateDocument(db, doc.id, { status: 'error', error: message.slice(0, 500) })
  }

  /** Legge il documento con il suo plugin, lo divide in pezzi, calcola gli embedding e li salva. */
  async function run(doc: KnowledgeDocument, conv: Conversation, signal: AbortSignal): Promise<void> {
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
      const model = await embedder.model()
      await removeKnowledgeChunks(db, current.id)
      const title = extracted.title.trim() || current.title
      current = (await updateDocument(db, current.id, { title, chars, version: extracted.version ?? current.version ?? null, chunkCount: 0 })) ?? current
      const batches = Math.ceil(drafts.length / KNOWLEDGE.embedBatch)
      for (let i = 0; i < drafts.length; i += KNOWLEDGE.embedBatch) {
        if (signal.aborted) throw new Error(t('err.knowledge.aborted'))
        const batch = drafts.slice(i, i + KNOWLEDGE.embedBatch)
        const vectors = await embedder.embed({
          conversationId: current.conversationId,
          kind: 'embed-doc',
          texts: batch.map((d) => d.text),
          chatModel: conv.model,
          cpt: 4,
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

  /** Mette in coda l'indicizzazione di un documento (una alla volta per conversazione). */
  function enqueue(doc: KnowledgeDocument, conv: Conversation, signal = new AbortController().signal): Promise<void> {
    const running = indexing.get(doc.id)
    if (running) return running
    const previous = queues.get(doc.conversationId) ?? Promise.resolve()
    const job = previous.then(() => run(doc, conv, signal)).finally(() => indexing.delete(doc.id))
    indexing.set(doc.id, job)
    const chained = job.catch(() => undefined)
    queues.set(doc.conversationId, chained)
    void chained.then(() => {
      if (queues.get(doc.conversationId) === chained) queues.delete(doc.conversationId)
    })
    return job
  }

  /**
   * Aggiunge file alla conversazione: controlla dimensione e plugin, salta i duplicati (stessa impronta),
   * registra il documento e lo indicizza in sottofondo. Restituisce i documenti creati o già presenti.
   */
  async function addFiles(conv: Conversation, paths: string[]): Promise<KnowledgeDocument[]> {
    const out: KnowledgeDocument[] = []
    for (const path of paths) {
      const ref: DocumentRef = { kind: 'file', path }
      const source = registry.sourceFor(ref)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) throw new SourceError('read', t('err.knowledge.read', { name: path.split(/[\\/]/).pop() ?? path, error: t('err.knowledge.notFile') }))
      if (info.size > KNOWLEDGE.maxBytes) throw new SourceError('tooBig', t('err.knowledge.tooBig', { name: path.split(/[\\/]/).pop() ?? path, max: Math.round(KNOWLEDGE.maxBytes / 1024 / 1024) }))
      const hash = await hashFile(path)
      const existing = await findDocumentByHash(db, conv.id, hash)
      if (existing) {
        out.push(existing)
        continue
      }
      const title = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, '')
      const doc = await addDocument(db, { conversationId: conv.id, source: source.id, title, ref, hash, bytes: info.size })
      out.push(doc)
      void enqueue(doc, conv)
    }
    return out
  }

  /** Rifà l'indice di un documento (dopo un errore, o dopo aver cambiato il modello di embedding). */
  async function reindex(conv: Conversation, documentId: string): Promise<KnowledgeDocument> {
    const doc = await getDocument(db, documentId)
    if (!doc || doc.conversationId !== conv.id) throw new Error(t('err.knowledge.docNotFound'))
    await enqueue(doc, conv)
    return (await getDocument(db, documentId)) ?? doc
  }

  async function remove(conv: Conversation, documentId: string): Promise<void> {
    const doc = await getDocument(db, documentId)
    if (!doc || doc.conversationId !== conv.id) throw new Error(t('err.knowledge.docNotFound'))
    await removeDocument(db, documentId)
  }

  /** Documenti pronti ma indicizzati con un altro modello di embedding: si rifanno in sottofondo. */
  async function ensureModel(conv: Conversation): Promise<void> {
    const docs = await listDocuments(db, conv.id)
    const model = await embedder.model()
    const counts = await countKnowledgeChunks(db, docs.map((d) => d.id), model)
    for (const d of docs) if ((d.status === 'ready' && !counts.get(d.id)) || d.status === 'pending') void enqueue(d, conv)
  }

  /** Documenti pronti con pezzi per il modello attuale. */
  async function readyDocuments(conversationId: string, model: string): Promise<KnowledgeDocument[]> {
    const docs = (await listDocuments(db, conversationId)).filter((d) => d.status === 'ready')
    const counts = await countKnowledgeChunks(db, docs.map((d) => d.id), model)
    return docs.filter((d) => counts.get(d.id))
  }

  /** Vero se la conversazione ha almeno un documento pronto (per abilitare il bottone libro). */
  async function hasReady(conversationId: string): Promise<boolean> {
    return (await readyDocuments(conversationId, await embedder.model())).length > 0
  }

  /**
   * Documenti per la risposta, entro `maxTokens`:
   * 1. se tutti i documenti pronti stanno nel budget, vanno al modello per intero (può contare e sommare);
   * 2. altrimenti prima i documenti «fissati» per intero (finché stanno), poi gli estratti scelti con il
   *    punteggio ibrido (somiglianza semantica + parole esatte) nello spazio che resta.
   * `question` è la domanda: il vettore (lo stesso usato dalla memoria) e il testo per la ricerca a parole.
   */
  async function recall(conv: Conversation, question: { vector: ArrayLike<number>; text: string }, maxTokens: number, cpt: number): Promise<KnowledgeRecall> {
    const empty: KnowledgeRecall = { section: '', refs: [] }
    if (maxTokens < 64) return empty
    const model = await embedder.model()
    const docs = await readyDocuments(conv.id, model)
    if (docs.length === 0) return empty
    const titles = new Map(docs.map((d) => [d.id, d.title]))
    const ids = docs.map((d) => d.id)
    const chunks = (await listKnowledgeChunks(db, ids, model)).map((c) => ({
      id: c.id,
      documentId: c.documentId,
      title: titles.get(c.documentId) ?? '',
      locator: c.locator,
      part: c.part,
      text: c.text,
      embedding: fromBuffer(c.embedding)
    }))
    const maxChars = maxTokens * cpt
    // 1. tutto per intero
    if (totalChars(chunks) <= maxChars) {
      const items: SectionItem[] = chunks.map((c) => ({ ...c, whole: true }))
      return { section: buildKnowledgeSection(items), refs: toKnowledgeRefs(items, []) }
    }
    // 2. i fissati per intero, poi gli estratti
    const pinnedIds = new Set(docs.filter((d) => d.pinned).map((d) => d.id))
    const { picked: whole } = wholeDocuments(chunks, pinnedIds, maxChars)
    const wholeItems: SectionItem[] = whole.map((c) => ({ ...c, whole: true }))
    const rest = chunks.filter((c) => !pinnedIds.has(c.documentId))
    const room = maxChars - totalChars(whole)
    const bm25 = await searchKnowledgeChunks(db, ids, model, ftsQuery(question.text)).catch(() => new Map<string, number>())
    const picked = room > 0 ? pickDocumentChunks(question.vector, rest, room, { bm25 }) : []
    if (wholeItems.length === 0 && picked.length === 0) return empty
    return { section: buildKnowledgeSection([...wholeItems, ...picked]), refs: toKnowledgeRefs(wholeItems, picked) }
  }

  /** «Intero» sì/no per un documento. */
  async function setPinned(conv: Conversation, documentId: string, pinned: boolean): Promise<KnowledgeDocument> {
    const doc = await getDocument(db, documentId)
    if (!doc || doc.conversationId !== conv.id) throw new Error(t('err.knowledge.docNotFound'))
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

  /** Collega una sorgente alla conversazione e la sincronizza subito. */
  async function connect(conv: Conversation, sourceId: string, config: Record<string, unknown>): Promise<KnowledgeConnection> {
    const source = registry.get(sourceId)
    if (!source || source.kind !== 'connected') throw new Error(t('err.knowledge.sourceMissing', { id: sourceId }))
    const sealed = sealConfig(source, config, cipher)
    const connection = await addConnection(db, { conversationId: conv.id, source: sourceId, config: sealed })
    return masked(await refresh(conv, connection.id))
  }

  /**
   * «Aggiorna»: chiede alla sorgente l'elenco dei documenti e lo confronta con quelli salvati: nuovi indicizzati,
   * cambiati (versione diversa) reindicizzati, spariti rimossi. Nessuna sincronizzazione automatica: la lancia l'utente.
   */
  async function refresh(conv: Conversation, connectionId: string): Promise<KnowledgeConnection> {
    const connection = await getConnection(db, connectionId)
    if (!connection || connection.conversationId !== conv.id) throw new Error(t('err.knowledge.connectionNotFound'))
    const source = sourceOf(connection)
    await updateConnection(db, connectionId, { status: 'syncing', error: null })
    try {
      const listed = await source.list!(openConfig(source, connection.config, cipher), new AbortController().signal)
      const existing = (await listDocuments(db, conv.id)).filter((d) => d.connectionId === connectionId)
      const byUri = new Map(existing.map((d) => [d.ref.kind === 'remote' ? d.ref.uri : '', d]))
      const seen = new Set<string>()
      for (const item of listed) {
        if (item.ref.kind !== 'remote') continue
        seen.add(item.ref.uri)
        const current = byUri.get(item.ref.uri)
        if (!current) {
          const doc = await addDocument(db, { conversationId: conv.id, connectionId, source: source.id, title: item.title, ref: item.ref, version: item.version ?? null, bytes: item.bytes ?? null })
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
  async function disconnect(conv: Conversation, connectionId: string): Promise<void> {
    const connection = await getConnection(db, connectionId)
    if (!connection || connection.conversationId !== conv.id) throw new Error(t('err.knowledge.connectionNotFound'))
    await removeConnection(db, connectionId)
  }

  async function status(conv: Conversation): Promise<KnowledgeStatus> {
    const model = await embedder.model()
    const documents = await listDocuments(db, conv.id)
    const counts = await countKnowledgeChunks(db, documents.map((d) => d.id), model)
    let chunks = 0
    let pending = 0
    for (const d of documents) {
      const n = counts.get(d.id) ?? 0
      chunks += n
      if (d.status === 'pending' || d.status === 'indexing' || (d.status === 'ready' && n === 0)) pending++
    }
    const ready = documents.filter((d) => d.status === 'ready' && counts.get(d.id))
    const sizes = await db
      .select({ documentId: knowledgeChunks.documentId, chars: sql<number>`sum(length(${knowledgeChunks.text}))` })
      .from(knowledgeChunks)
      .where(and(inArray(knowledgeChunks.documentId, ready.length ? ready.map((d) => d.id) : ['']), eq(knowledgeChunks.model, model)))
      .groupBy(knowledgeChunks.documentId)
    const total = sizes.reduce((n, r) => n + Number(r.chars), 0)
    const pinnedIds = new Set(ready.filter((d) => d.pinned).map((d) => d.id))
    const pinned = sizes.filter((r) => pinnedIds.has(r.documentId)).reduce((n, r) => n + Number(r.chars), 0)
    return { documents, connections: (await listConnections(db, conv.id)).map(masked), chunks, pending, totalChars: total, pinnedChars: pinned, model, modelInstalled: await embedder.installed(model) }
  }

  /** Per i test: attende la fine delle indicizzazioni in corso della conversazione. */
  async function wait(conversationId: string): Promise<void> {
    for (;;) {
      const q = queues.get(conversationId)
      if (!q) return
      await q
    }
  }

  return { embedder, addFiles, reindex, remove, setPinned, connect, refresh, disconnect, ensureModel, hasReady, recall, status, wait, isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model' }
}

export type Knowledge = ReturnType<typeof createKnowledge>
