// Memoria della conversazione: indicizza i messaggi coperti dal riassunto (pezzi + embedding in SQLite) e,
// prima di ogni risposta, recupera gli estratti più pertinenti alla domanda. Attiva solo dopo il primo
// riassunto: prima tutti i messaggi sono già nel prompt per intero.
import { buildChunks, buildMemorySection, fromBuffer, MEMORY, memoryQuery, pickChunks, toBuffer } from '@shared/memory'
import { charsPerToken, estimateTokens, historyAfter } from '@shared/prompt'
import type { Conversation, MemoryRef, MemoryStatus, Message } from '@shared/types'
import type { Db } from './db/client'
import { addChunks, getModelSetting, getSettings, listChunks, listMessages, removeChunks } from './db/repo'
import { callInput, type ContextLog } from './contextLog'
import { OllamaError, type EmbedStats, type OllamaClient } from './ollama'

export interface MemoryDeps {
  db: Db
  ollama: OllamaClient
  contextLog?: ContextLog
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

export function createMemory({ db, ollama, contextLog }: MemoryDeps) {
  /** Embedding registrato nel monitor del contesto (una voce: i testi inviati). */
  async function embed(
    conversationId: string,
    kind: 'embed-index' | 'embed-query',
    model: string,
    texts: string[],
    options: { num_gpu?: number } | undefined,
    cpt: number
  ): Promise<number[][]> {
    let stats: EmbedStats | null = null
    const start = {
      conversationId,
      kind,
      model,
      numCtx: null,
      parts: [{ key: 'texts' as const, label: kind === 'embed-index' ? 'texts.index' : 'texts.query', tokens: texts.reduce((n, x) => n + estimateTokens(x, cpt), 0), count: texts.length }]
    }
    try {
      const vectors = await ollama.embed(model, texts, options, (s) => (stats = s))
      await contextLog?.record(callInput(start, stats))
      return vectors
    } catch (err) {
      await contextLog?.record(callInput(start, null, err))
      throw err
    }
  }

  const indexing = new Map<string, Promise<number>>()

  const embeddingModel = async (): Promise<string> => (await getSettings(db)).embeddingModel

  /** CPU o GPU come il modello principale: se la chat gira in CPU, anche gli embedding. */
  async function embedOptions(chatModel: string): Promise<{ num_gpu?: number } | undefined> {
    const numGpu = (await getModelSetting(db, chatModel))?.numGpu
    return numGpu === 0 ? { num_gpu: 0 } : undefined
  }

  async function modelInstalled(model: string): Promise<boolean> {
    const models = await ollama.listModels().catch(() => [])
    return models.some((m) => m.name === model || m.name === `${model}:latest`)
  }

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
      const model = await embeddingModel()
      await removeChunks(db, conv.id, model)
      const done = new Set((await listChunks(db, conv.id, model)).map((c) => c.messageId))
      // Le domande vanno indicizzate insieme alla loro risposta: si passa la coppia intera, si tengono i nuovi.
      const drafts = buildChunks(covered).filter((d) => !done.has(d.messageId))
      if (drafts.length === 0) return 0
      const options = await embedOptions(conv.model)
      let added = 0
      for (let i = 0; i < drafts.length; i += EMBED_BATCH) {
        const batch = drafts.slice(i, i + EMBED_BATCH)
        const vectors = await embed(conv.id, 'embed-index', model, batch.map((d) => d.text), options, charsPerToken(history))
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
   * Estratti pertinenti all'ultima domanda, entro `maxTokens`. Vuoto se la memoria è spenta, se non c'è
   * ancora un riassunto, se il modello di embedding manca o se nulla supera la soglia.
   */
  async function recall(conv: Conversation, maxTokens: number): Promise<Recall> {
    const empty: Recall = { section: '', refs: [] }
    if (!conv.longMemory || maxTokens < 64) return empty
    const history = await listMessages(db, conv.id)
    const covered = coveredMessages(conv, history)
    if (!covered) return empty
    const question = history.findLast((m) => m.role === 'user')
    if (!question) return empty
    const qIdx = history.indexOf(question)
    const previous = history.slice(0, qIdx).findLast((m) => m.role === 'assistant')
    const model = await embeddingModel()
    await index(conv)
    const coveredIds = new Set(covered.map((m) => m.id))
    const chunks = (await listChunks(db, conv.id, model))
      .filter((c) => coveredIds.has(c.messageId))
      .map((c) => ({ id: c.id, messageId: c.messageId, role: c.role, text: c.text, embedding: fromBuffer(c.embedding) }))
    if (chunks.length === 0) return empty
    const [query] = await embed(conv.id, 'embed-query', model, [memoryQuery(question.content, previous?.content)], await embedOptions(conv.model), charsPerToken(history))
    const picked = pickChunks(query, chunks, maxTokens * charsPerToken(history))
    const position = new Map(history.map((m, i) => [m.id, i + 1]))
    const items = picked.map((p) => ({ ...p, position: position.get(p.messageId) ?? 0 }))
    return {
      section: buildMemorySection(items, history.length),
      refs: items
        .sort((a, b) => a.position - b.position)
        .map((p) => ({ messageId: p.messageId, position: p.position, role: p.role, score: Math.round(p.score * 100) / 100, excerpt: p.text.slice(0, 240) }))
    }
  }

  async function status(conv: Conversation): Promise<MemoryStatus> {
    const model = await embeddingModel()
    const history = await listMessages(db, conv.id)
    const covered = coveredMessages(conv, history) ?? []
    const chunks = await listChunks(db, conv.id, model)
    const done = new Set(chunks.map((c) => c.messageId))
    const pending = buildChunks(covered).filter((d) => !done.has(d.messageId)).length
    return { chunks: chunks.length, pending, model, modelInstalled: await modelInstalled(model) }
  }

  /** Rifà l'indice da zero (es. dopo aver cambiato il modello di embedding). */
  async function rebuild(conv: Conversation): Promise<number> {
    await removeChunks(db, conv.id)
    return index(conv)
  }

  return { index, indexQuietly, recall, status, rebuild, isMissingModel: (err: unknown) => err instanceof OllamaError && err.code === 'model' }
}

export type Memory = ReturnType<typeof createMemory>

/** Quota della memoria per gli estratti: al massimo il 12%, e solo lo spazio che resta sotto la riserva. */
export function memoryBudget(numCtx: number, reserveTokens: number, usedTokens: number): number {
  return Math.max(0, Math.min(Math.floor(numCtx * MEMORY.budgetShare), numCtx - reserveTokens - usedTokens))
}
