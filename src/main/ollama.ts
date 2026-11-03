import type { ModelCapabilities, OllamaModel } from '@shared/types'

export type OllamaErrorCode = 'unreachable' | 'http' | 'model' | 'parse'

export class OllamaError extends Error {
  constructor(
    public readonly code: OllamaErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  top_p?: number
  num_ctx?: number
  seed?: number
  /** Numero massimo di token generati. */
  num_predict?: number
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  think?: boolean
  options?: ChatOptions
  /** 'json' oppure uno JSON schema (output strutturato, usato dal plan mode). */
  format?: 'json' | Record<string, unknown>
}

export interface ChatHandlers {
  onThinking?: (delta: string) => void
  onContent?: (delta: string) => void
}

export interface ChatResult {
  content: string
  thinking: string
  evalCount: number | null
  durationMs: number | null
  /** true se la generazione è stata interrotta: content/thinking contengono il parziale. */
  aborted: boolean
}

type FetchLike = typeof fetch

interface ChatChunk {
  message?: { role?: string; content?: string; thinking?: string }
  done?: boolean
  eval_count?: number
  total_duration?: number
  error?: string
}

export interface OllamaClient {
  listModels(): Promise<OllamaModel[]>
  showModel(name: string): Promise<ModelCapabilities>
  chatStream(req: ChatRequest, handlers: ChatHandlers, signal?: AbortSignal): Promise<ChatResult>
  clearCache(): void
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')

export function createOllamaClient(getBaseUrl: () => string, fetchImpl: FetchLike = fetch): OllamaClient {
  const capsCache = new Map<string, ModelCapabilities>()

  const url = (path: string): string => getBaseUrl().replace(/\/+$/, '') + path

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(url(path), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers }
      })
    } catch (err) {
      if (isAbort(err)) throw err
      throw new OllamaError('unreachable', `Ollama non raggiungibile su ${getBaseUrl()}`)
    }
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) detail = body.error
      } catch {
        /* corpo non JSON: resta lo statusText */
      }
      const code: OllamaErrorCode = res.status === 404 ? 'model' : 'http'
      throw new OllamaError(code, `Ollama ${res.status}: ${detail}`, res.status)
    }
    return res
  }

  async function listModels(): Promise<OllamaModel[]> {
    const res = await request('/api/tags')
    const body = (await res.json()) as {
      models?: Array<{
        name: string
        size: number
        modified_at: string
        details?: { family?: string; parameter_size?: string; quantization_level?: string }
      }>
    }
    return (body.models ?? [])
      .map((m) => ({
        name: m.name,
        size: m.size,
        modifiedAt: m.modified_at,
        family: m.details?.family ?? null,
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function showModel(name: string): Promise<ModelCapabilities> {
    const key = `${getBaseUrl()}|${name}`
    const cached = capsCache.get(key)
    if (cached) return cached

    const res = await request('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) })
    const body = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> }
    const capabilities = body.capabilities ?? []
    const ctxEntry = Object.entries(body.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))
    const caps: ModelCapabilities = {
      capabilities,
      thinking: capabilities.includes('thinking'),
      contextLength: typeof ctxEntry?.[1] === 'number' ? ctxEntry[1] : null
    }
    capsCache.set(key, caps)
    return caps
  }

  async function chatStream(
    req: ChatRequest,
    handlers: ChatHandlers,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const result: ChatResult = { content: '', thinking: '', evalCount: null, durationMs: null, aborted: false }

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(line) as ChatChunk
      } catch {
        throw new OllamaError('parse', `Risposta NDJSON non valida: ${line.slice(0, 120)}`)
      }
      if (chunk.error) throw new OllamaError('http', chunk.error)
      const thinking = chunk.message?.thinking
      if (thinking) {
        result.thinking += thinking
        handlers.onThinking?.(thinking)
      }
      const content = chunk.message?.content
      if (content) {
        result.content += content
        handlers.onContent?.(content)
      }
      if (chunk.done) {
        result.evalCount = chunk.eval_count ?? null
        result.durationMs = chunk.total_duration != null ? Math.round(chunk.total_duration / 1e6) : null
      }
    }

    try {
      const res = await request('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ ...req, stream: true }),
        signal
      })
      if (!res.body) throw new OllamaError('parse', 'Risposta di Ollama senza corpo')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
        }
      }
      handleLine(buffer + decoder.decode())
    } catch (err) {
      if (isAbort(err) || signal?.aborted) {
        result.aborted = true
        return result
      }
      throw err
    }
    return result
  }

  return { listModels, showModel, chatStream, clearCache: () => capsCache.clear() }
}
