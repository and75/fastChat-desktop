// Base di conoscenza di una conversazione: aggiunge documenti tramite i plugin, li divide in pezzi con
// embedding (SQLite, per modello di embedding) e, prima di una risposta, recupera gli estratti pertinenti.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { t } from '@shared/i18n'
import { buildDocumentChunks, buildKnowledgeSection, KNOWLEDGE, pickDocumentChunks, toKnowledgeRefs } from '@shared/knowledge'
import { fromBuffer, toBuffer } from '@shared/memory'
import type { Conversation, DocumentRef, KnowledgeDocument, KnowledgeProgress, KnowledgeRef, KnowledgeStatus } from '@shared/types'
import type { Db } from '../db/client'
import {
  addDocument,
  addKnowledgeChunks,
  countKnowledgeChunks,
  findDocumentByHash,
  getDocument,
  listConnections,
  listDocuments,
  listKnowledgeChunks,
  removeDocument,
  removeKnowledgeChunks,
  updateDocument
} from '../db/repo'
import type { Embedder } from '../embedder'
import { OllamaError } from '../ollama'
import type { SourceRegistry } from './registry'
import { SourceError } from './source'

export interface KnowledgeDeps {
  db: Db
  embedder: Embedder
  registry: SourceRegistry
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

export function createKnowledge({ db, embedder, registry, onProgress }: KnowledgeDeps) {
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
      const config = current.connectionId ? ((await listConnections(db, current.conversationId)).find((c) => c.id === current.connectionId)?.config ?? {}) : {}
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
   * Estratti dei documenti pertinenti alla domanda, entro `maxTokens`. `query` è l'embedding della domanda
   * (lo stesso usato dalla memoria), già calcolato da chi chiama. Vuoto se non c'è nulla di pronto o pertinente.
   */
  async function recall(conv: Conversation, query: ArrayLike<number>, maxTokens: number, cpt: number): Promise<KnowledgeRecall> {
    const empty: KnowledgeRecall = { section: '', refs: [] }
    if (maxTokens < 64) return empty
    const model = await embedder.model()
    const docs = await readyDocuments(conv.id, model)
    if (docs.length === 0) return empty
    const titles = new Map(docs.map((d) => [d.id, d.title]))
    const chunks = (await listKnowledgeChunks(db, docs.map((d) => d.id), model)).map((c) => ({
      id: c.id,
      documentId: c.documentId,
      title: titles.get(c.documentId) ?? '',
      locator: c.locator,
      part: c.part,
      text: c.text,
      embedding: fromBuffer(c.embedding)
    }))
    const picked = pickDocumentChunks(query, chunks, maxTokens * cpt)
    if (picked.length === 0) return empty
    return { section: buildKnowledgeSection(picked), refs: toKnowledgeRefs(picked) }
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
    return { documents, connections: await listConnections(db, conv.id), chunks, pending, model, modelInstalled: await embedder.installed(model) }
  }

  /** Per i test: attende la fine delle indicizzazioni in corso della conversazione. */
  async function wait(conversationId: string): Promise<void> {
    for (;;) {
      const q = queues.get(conversationId)
      if (!q) return
      await q
    }
  }

  return { embedder, addFiles, reindex, remove, ensureModel, hasReady, recall, status, wait, isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model' }
}

export type Knowledge = ReturnType<typeof createKnowledge>
