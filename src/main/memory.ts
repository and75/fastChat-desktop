// Memoria della conversazione: indicizza i messaggi coperti dal riassunto (pezzi + embedding in SQLite) e,
// prima di ogni risposta, recupera gli estratti più pertinenti alla domanda. Attiva solo dopo il primo
// riassunto: prima tutti i messaggi sono già nel prompt per intero.
import { buildChunks, buildMemorySection, fromBuffer, MEMORY, memoryQuery, pickChunks, toBuffer } from '@shared/memory'
import { charsPerToken, historyAfter } from '@shared/prompt'
import type { Conversation, MemoryRef, MemoryStatus, Message } from '@shared/types'
import type { Db } from './db/client'
import { addChunks, listChunks, listMessages, removeChunks } from './db/repo'
import { createEmbedder, type Embedder } from './embedder'
import type { ContextLog } from './contextLog'
import { OllamaError, type OllamaClient } from './ollama'

export interface MemoryDeps {
  db: Db
  ollama: OllamaClient
  contextLog?: ContextLog
  /** Embedder condiviso con la base di conoscenza; se manca se ne crea uno. */
  embedder?: Embedder
}

/** Pezzi per richiesta di embedding. */
const EMBED_BATCH = 16

export interface Recall {
  /** Sezione del system prompt ('' se non c'è nulla di pertinente). */
  section: string
  refs: MemoryRef[]
}

/** Messaggi coperti dal riassunto (null se il riassunto manca o non è allineato). */
function coveredMessages(conv: Conversation, history: Message[]): Message[] | null {
  if (!conv.summary || !conv.summaryUpTo) return null
  const { aligned } = historyAfter(history, conv.summaryUpTo)
  if (!aligned) return null
  const idx = history.findIndex((m) => m.id === conv.summaryUpTo)
  return history.slice(0, idx + 1)
}

export function createMemory({ db, ollama, contextLog, embedder = createEmbedder({ db, ollama, contextLog }) }: MemoryDeps) {
  const indexing = new Map<string, Promise<number>>()

  /**
   * Indicizza i messaggi coperti dal riassunto non ancora indicizzati con il modello attuale (quelli di un
   * modello diverso vengono rifatti). Restituisce i pezzi aggiunti. Lancia se il modello non è installato.
   */
  async function index(conv: Conversation): Promise<number> {
    const running = indexing.get(conv.id)
    if (running) return running
    const job = (async () => {
      const history = await listMessages(db, conv.id)
      const covered = coveredMessages(conv, history)
      if (!covered) return 0
      const model = await embedder.model()
      await removeChunks(db, conv.id, model)
      const done = new Set((await listChunks(db, conv.id, model)).map((c) => c.messageId))
      // Le domande vanno indicizzate insieme alla loro risposta: si passa la coppia intera, si tengono i nuovi.
      const drafts = buildChunks(covered).filter((d) => !done.has(d.messageId))
      if (drafts.length === 0) return 0
      let added = 0
      for (let i = 0; i < drafts.length; i += EMBED_BATCH) {
        const batch = drafts.slice(i, i + EMBED_BATCH)
        const vectors = await embedder.embed({ conversationId: conv.id, kind: 'embed-index', texts: batch.map((d) => d.text), chatModel: conv.model, cpt: charsPerToken(history) })
        await addChunks(
          db,
          batch.map((d, j) => ({ conversationId: conv.id, messageId: d.messageId, role: d.role, part: d.part, text: d.text, model, embedding: toBuffer(vectors[j]) }))
        )
        added += batch.length
      }
      return added
    })()
    indexing.set(conv.id, job)
    try {
      return await job
    } finally {
      indexing.delete(conv.id)
    }
  }

  /** Indicizza senza far fallire chi chiama (modello mancante, Ollama giù): si riproverà. */
  async function indexQuietly(conv: Conversation): Promise<void> {
    if (!conv.longMemory) return
    await index(conv).catch(() => 0)
  }

  /**
   * Embedding della domanda in attesa (più la fine della risposta precedente), condiviso tra memoria e base di
   * conoscenza: una sola chiamata a Ollama per risposta. null se non c'è una domanda.
   */
  async function embedQuestion(conv: Conversation, history: Message[]): Promise<number[] | null> {
    const question = history.findLast((m) => m.role === 'user')
    if (!question) return null
    const qIdx = history.indexOf(question)
    const previous = history.slice(0, qIdx).findLast((m) => m.role === 'assistant')
    const [vector] = await embedder.embed({ conversationId: conv.id, kind: 'embed-query', texts: [memoryQuery(question.content, previous?.content)], chatModel: conv.model, cpt: charsPerToken(history) })
    return vector
  }

  /**
   * Estratti pertinenti all'ultima domanda, entro `maxTokens`. Vuoto se la memoria è spenta, se non c'è
   * ancora un riassunto, se il modello di embedding manca o se nulla supera la soglia.
   * `query` è l'embedding della domanda già calcolato (vedi embedQuestion); se manca si calcola qui.
   */
  async function recall(conv: Conversation, maxTokens: number, query?: ArrayLike<number> | null): Promise<Recall> {
    const empty: Recall = { section: '', refs: [] }
    if (!conv.longMemory || maxTokens < 64) return empty
    const history = await listMessages(db, conv.id)
    const covered = coveredMessages(conv, history)
    if (!covered) return empty
    if (!history.some((m) => m.role === 'user')) return empty
    const model = await embedder.model()
    await index(conv)
    const coveredIds = new Set(covered.map((m) => m.id))
    const chunks = (await listChunks(db, conv.id, model))
      .filter((c) => coveredIds.has(c.messageId))
      .map((c) => ({ id: c.id, messageId: c.messageId, role: c.role, text: c.text, embedding: fromBuffer(c.embedding) }))
    if (chunks.length === 0) return empty
    const vector = query ?? (await embedQuestion(conv, history))
    if (!vector) return empty
    const picked = pickChunks(vector, chunks, maxTokens * charsPerToken(history))
    const position = new Map(history.map((m, i) => [m.id, i + 1]))
    const items = picked.map((p) => ({ ...p, position: position.get(p.messageId) ?? 0 }))
    return {
      section: buildMemorySection(items, history.length),
      refs: items
        .sort((a, b) => a.position - b.position)
        .map((p) => ({ messageId: p.messageId, position: p.position, role: p.role, score: Math.round(p.score * 100) / 100, excerpt: p.text.slice(0, 240) }))
    }
  }

  /** Vero se la memoria ha qualcosa da cercare (accesa, riassunto allineato con messaggi coperti). */
  async function canRecall(conv: Conversation): Promise<boolean> {
    if (!conv.longMemory || !conv.summary) return false
    return !!coveredMessages(conv, await listMessages(db, conv.id))
  }

  async function status(conv: Conversation): Promise<MemoryStatus> {
    const model = await embedder.model()
    const history = await listMessages(db, conv.id)
    const covered = coveredMessages(conv, history) ?? []
    const chunks = await listChunks(db, conv.id, model)
    const done = new Set(chunks.map((c) => c.messageId))
    const pending = buildChunks(covered).filter((d) => !done.has(d.messageId)).length
    return { chunks: chunks.length, pending, model, modelInstalled: await embedder.installed(model) }
  }

  /** Rifà l'indice da zero (es. dopo aver cambiato il modello di embedding). */
  async function rebuild(conv: Conversation): Promise<number> {
    await removeChunks(db, conv.id)
    return index(conv)
  }

  return { index, indexQuietly, embedQuestion, recall, canRecall, status, rebuild, isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model' }
}

export type Memory = ReturnType<typeof createMemory>

/** Quota della memoria per gli estratti: al massimo il 12%, e solo lo spazio che resta sotto la riserva. */
export function memoryBudget(numCtx: number, reserveTokens: number, usedTokens: number): number {
  return Math.max(0, Math.min(Math.floor(numCtx * MEMORY.budgetShare), numCtx - reserveTokens - usedTokens))
}
