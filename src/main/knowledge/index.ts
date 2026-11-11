// Basi di conoscenza: ogni conversazione ha la sua (per i documenti dell'utente) e può collegare basi della
// libreria, condivise tra più conversazioni. Il servizio aggiunge documenti tramite i plugin, li divide in
// pezzi con embedding (SQLite, per modello di embedding) e, prima di una risposta, recupera da tutte le basi
// della conversazione i documenti interi o gli estratti pertinenti.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { t } from '@shared/i18n'
import { buildDocumentChunks, buildKnowledgeSection, ftsQuery, KNOWLEDGE, pickDocumentChunks, toKnowledgeRefs, totalChars, wholeDocuments, type SectionItem } from '@shared/knowledge'
import { fromBuffer, toBuffer } from '@shared/memory'
import type { Conversation, DocumentRef, KnowledgeBase, KnowledgeBaseInfo, KnowledgeConnection, KnowledgeDocument, KnowledgeProgress, KnowledgeRef, KnowledgeStatus } from '@shared/types'
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
  listConnections,
  listDocuments,
  listKnowledgeChunks,
  listLibraryBases,
  listLinkedBases,
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

  /** Numeri di un insieme di documenti con il modello attuale: pezzi, caratteri, pronti. */
  async function measure(documents: KnowledgeDocument[], model: string) {
    const ids = documents.map((d) => d.id)
    const counts = await countKnowledgeChunks(db, ids, model)
    const ready = documents.filter((d) => d.status === 'ready' && counts.get(d.id))
    const sizes = ready.length
      ? await db
          .select({ documentId: knowledgeChunks.documentId, chars: sql<number>`sum(length(${knowledgeChunks.text}))` })
          .from(knowledgeChunks)
          .where(and(inArray(knowledgeChunks.documentId, ready.map((d) => d.id)), eq(knowledgeChunks.model, model)))
          .groupBy(knowledgeChunks.documentId)
      : []
    const chars = new Map(sizes.map((r) => [r.documentId, Number(r.chars)]))
    return { counts, ready, chars }
  }

  /** Basi della libreria con i loro numeri. */
  async function describe(bases: KnowledgeBase[]): Promise<KnowledgeBaseInfo[]> {
    const model = await embedder.model()
    const docs = await listDocuments(db, bases.map((b) => b.id))
    const { ready, chars } = await measure(docs, model)
    const links = await countBaseLinks(db, bases.map((b) => b.id))
    return bases.map((b) => ({
      ...b,
      documents: docs.filter((d) => d.baseId === b.id).length,
      ready: ready.filter((d) => d.baseId === b.id).length,
      chars: ready.filter((d) => d.baseId === b.id).reduce((n, d) => n + (chars.get(d.id) ?? 0), 0),
      conversations: links.get(b.id) ?? 0
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

  async function renameBase(id: string, patch: { name?: string; description?: string }): Promise<KnowledgeBaseInfo> {
    await libraryBase(id)
    if (patch.name !== undefined && !patch.name.trim()) throw new Error(t('err.knowledge.baseName'))
    return (await describe([(await updateBase(db, id, patch))!]))[0]
  }

  /** Elimina una base della libreria: sparisce da tutte le conversazioni che la collegano, con documenti e pezzi. */
  async function removeLibraryBase(id: string): Promise<void> {
    await libraryBase(id)
    await removeBase(db, id)
  }

  async function link(conv: Conversation, baseId: string): Promise<void> {
    await libraryBase(baseId)
    await linkBase(db, conv.id, baseId)
  }

  const unlink = (conv: Conversation, baseId: string): Promise<void> => unlinkBase(db, conv.id, baseId)

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
      const model = await embedder.model()
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
    await ownDocument(owner, documentId)
    await removeDocument(db, documentId)
  }

  /** Tutti i documenti che la conversazione usa, con la base da cui vengono. */
  async function documentsOf(conversationId: string): Promise<{ docs: KnowledgeDocument[]; own: KnowledgeBase | null; linked: KnowledgeBase[] }> {
    const { own, linked } = await basesOf(conversationId)
    const ids = [...(own ? [own.id] : []), ...linked.map((b) => b.id)]
    return { docs: await listDocuments(db, ids), own, linked }
  }

  /** Documenti in attesa o indicizzati con un altro modello di embedding: si rifanno in sottofondo. */
  async function ensureModel(conv: Conversation): Promise<void> {
    const { docs, own } = await documentsOf(conv.id)
    const model = await embedder.model()
    const counts = await countKnowledgeChunks(db, docs.map((d) => d.id), model)
    // I documenti della conversazione si registrano nel suo monitor; quelli delle basi collegate no.
    for (const d of docs) if ((d.status === 'ready' && !counts.get(d.id)) || d.status === 'pending') void enqueue(d, d.baseId === own?.id ? conv : null)
  }

  /** Documenti pronti con pezzi per il modello attuale, di tutte le basi della conversazione. */
  async function readyDocuments(conversationId: string, model: string) {
    const { docs, own, linked } = await documentsOf(conversationId)
    const counts = await countKnowledgeChunks(db, docs.map((d) => d.id), model)
    return { docs: docs.filter((d) => d.status === 'ready' && counts.get(d.id)), own, linked }
  }

  /** Vero se la conversazione ha almeno un documento pronto (per abilitare il bottone libro). */
  async function hasReady(conversationId: string): Promise<boolean> {
    return (await readyDocuments(conversationId, await embedder.model())).docs.length > 0
  }

  /**
   * Documenti per la risposta, da tutte le basi della conversazione, entro `maxTokens`:
   * 1. se tutti i documenti pronti stanno nel budget, vanno al modello per intero (può contare e sommare);
   * 2. altrimenti prima i documenti «fissati» per intero (finché stanno), poi gli estratti scelti con il
   *    punteggio ibrido (somiglianza semantica + parole esatte) nello spazio che resta.
   * `question` è la domanda: il vettore (lo stesso usato dalla memoria) e il testo per la ricerca a parole.
   */
  async function recall(conv: Conversation, question: { vector: ArrayLike<number>; text: string }, maxTokens: number, cpt: number): Promise<KnowledgeRecall> {
    const empty: KnowledgeRecall = { section: '', refs: [] }
    if (maxTokens < 64) return empty
    const model = await embedder.model()
    const { docs, linked } = await readyDocuments(conv.id, model)
    if (docs.length === 0) return empty
    const titles = new Map(docs.map((d) => [d.id, d.title]))
    // Le fonti dicono da quale base della libreria viene il documento.
    const baseNames = new Map(linked.map((b) => [b.id, b.name]))
    const baseOf = new Map(docs.map((d) => [d.id, baseNames.get(d.baseId)]))
    const withBase = (refs: KnowledgeRef[]): KnowledgeRef[] => refs.map((r) => (baseOf.get(r.documentId) ? { ...r, base: baseOf.get(r.documentId) } : r))
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
      return { section: buildKnowledgeSection(items), refs: withBase(toKnowledgeRefs(items, [])) }
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
    return { section: buildKnowledgeSection([...wholeItems, ...picked]), refs: withBase(toKnowledgeRefs(wholeItems, picked)) }
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

  /**
   * Stato: per una conversazione, i documenti della sua base (modificabili da lì) più le basi collegate e i
   * totali su tutto ciò che la conversazione usa; per una base della libreria, i suoi documenti.
   */
  async function status(owner: Owner): Promise<KnowledgeStatus> {
    const model = await embedder.model()
    // Guardare lo stato non crea la base della conversazione: nasce al primo documento.
    const own = isBase(owner) ? owner : await getConversationBase(db, owner.id)
    const linked = isBase(owner) ? [] : await listLinkedBases(db, owner.id)
    const documents = own ? await listDocuments(db, own.id) : []
    const all = [...documents, ...(await listDocuments(db, linked.map((b) => b.id)))]
    const { counts, ready, chars } = await measure(all, model)
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
      linked: await describe(linked),
      chunks,
      pending,
      ready: ready.length,
      totalChars: sum(ready),
      pinnedChars: sum(ready.filter((d) => d.pinned)),
      model,
      modelInstalled: await embedder.installed(model)
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
    recall,
    status,
    wait,
    isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model'
  }
}

export type Knowledge = ReturnType<typeof createKnowledge>
