// Embedding con Ollama, condiviso da memoria della conversazione e base di conoscenza: stesso modello (dalle
// Impostazioni), stessa esecuzione CPU/GPU del modello di chat, ogni chiamata registrata nel monitor del contesto.
import { estimateTokens } from '@shared/prompt'
import type { ContextCallKind } from '@shared/types'
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
  conversationId: string
  kind: EmbedKind
  texts: string[]
  /** Modello di chat della conversazione: gli embedding ne seguono la CPU/GPU. */
  chatModel: string
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
    const start = {
      conversationId: req.conversationId,
      kind: req.kind,
      note: req.note ?? null,
      model: name,
      numCtx: null,
      parts: [{ key: 'texts' as const, label: PART_LABEL[req.kind], tokens: req.texts.reduce((n, x) => n + estimateTokens(x, req.cpt), 0), count: req.texts.length }]
    }
    try {
      const vectors = await ollama.embed(name, req.texts, await options(req.chatModel), (s) => (stats = s))
      await contextLog?.record(callInput(start, stats))
      return vectors
    } catch (err) {
      await contextLog?.record(callInput(start, null, err))
      throw err
    }
  }

  return { model, options, installed, embed }
}

export type Embedder = ReturnType<typeof createEmbedder>
