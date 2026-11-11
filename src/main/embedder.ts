// Embedding con Ollama, condiviso da memoria della conversazione e base di conoscenza: stesso modello (dalle
// Impostazioni), stessa esecuzione CPU/GPU del modello di chat, ogni chiamata registrata nel monitor del contesto.
import { memoryQuery } from '@shared/memory'
import { charsPerToken, estimateTokens } from '@shared/prompt'
import type { ContextCallKind, Conversation, Message } from '@shared/types'
import type { Db } from './db/client'
import { getModelSetting, getSettings } from './db/repo'
import { callInput, type ContextLog } from './contextLog'
import type { EmbedStats, OllamaClient } from './ollama'

export interface EmbedderDeps {
  db: Db
  ollama: OllamaClient
  contextLog?: ContextLog
}

export type EmbedKind = Extract<ContextCallKind, 'embed-index' | 'embed-query' | 'embed-doc'>

const PART_LABEL: Record<EmbedKind, string> = { 'embed-index': 'texts.index', 'embed-query': 'texts.query', 'embed-doc': 'texts.doc' }

export interface EmbedRequest {
  /** Conversazione nel cui monitor registrare la chiamata; null per le basi della libreria (nessun registro). */
  conversationId: string | null
  kind: EmbedKind
  texts: string[]
  /** Modello di chat della conversazione: gli embedding ne seguono la CPU/GPU. Null: decide Ollama. */
  chatModel: string | null
  /** Caratteri per token per la stima nel monitor. */
  cpt: number
  note?: string | null
}

export function createEmbedder({ db, ollama, contextLog }: EmbedderDeps) {
  const model = async (): Promise<string> => (await getSettings(db)).embeddingModel

  /** CPU o GPU come il modello principale: se la chat gira in CPU, anche gli embedding. */
  async function options(chatModel: string): Promise<{ num_gpu?: number } | undefined> {
    const numGpu = (await getModelSetting(db, chatModel))?.numGpu
    return numGpu === 0 ? { num_gpu: 0 } : undefined
  }

  async function installed(name: string): Promise<boolean> {
    const models = await ollama.listModels().catch(() => [])
    return models.some((m) => m.name === name || m.name === `${name}:latest`)
  }

  /** Embedding dei testi, registrato nel monitor del contesto (una voce: i testi inviati). */
  async function embed(req: EmbedRequest): Promise<number[][]> {
    const name = await model()
    let stats: EmbedStats | null = null
    const opts = req.chatModel ? await options(req.chatModel) : undefined
    if (!req.conversationId) return ollama.embed(name, req.texts, opts)
    const start = {
      conversationId: req.conversationId,
      kind: req.kind,
      note: req.note ?? null,
      model: name,
      numCtx: null,
      parts: [{ key: 'texts' as const, label: PART_LABEL[req.kind], tokens: req.texts.reduce((n, x) => n + estimateTokens(x, req.cpt), 0), count: req.texts.length }]
    }
    try {
      const vectors = await ollama.embed(name, req.texts, opts, (s) => (stats = s))
      await contextLog?.record(callInput(start, stats))
      return vectors
    } catch (err) {
      await contextLog?.record(callInput(start, null, err))
      throw err
    }
  }

  /**
   * Embedding della domanda in attesa (più la fine della risposta precedente, per «e quello?»), condiviso tra
   * memoria della conversazione e base di conoscenza: una sola chiamata a Ollama per risposta. null senza domanda.
   */
  async function embedQuestion(conv: Conversation, history: Message[]): Promise<number[] | null> {
    const question = history.findLast((m) => m.role === 'user')
    if (!question) return null
    const previous = history.slice(0, history.indexOf(question)).findLast((m) => m.role === 'assistant')
    const [vector] = await embed({ conversationId: conv.id, kind: 'embed-query', texts: [memoryQuery(question.content, previous?.content)], chatModel: conv.model, cpt: charsPerToken(history) })
    return vector
  }

  return { model, options, installed, embed, embedQuestion }
}

export type Embedder = ReturnType<typeof createEmbedder>
