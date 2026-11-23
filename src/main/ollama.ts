import { detectSystemSlot } from '@shared/compose'
import type { DoneReason, ModelCapabilities, ModelDefaults, OllamaModel } from '@shared/types'
import { t } from '@shared/i18n'
import { errorDetail, nullLogger, type Logger } from './log'

/**
 * 'unreachable': Ollama non accetta la connessione; 'timeout': non ha risposto in tempo; 'interrupted': la
 * connessione è caduta a risposta iniziata; 'memory': memoria insufficiente per caricare il modello;
 * 'model': modello sconosciuto (404); 'http': altro errore di Ollama; 'parse': risposta non leggibile.
 */
export type OllamaErrorCode = 'unreachable' | 'timeout' | 'interrupted' | 'memory' | 'http' | 'model' | 'parse'

/** Tempo massimo delle chiamate che Ollama serve subito (elenco e dettagli dei modelli, modelli in memoria). */
export const QUICK_TIMEOUT_MS = 15_000
/** Tempo massimo per sapere quali modelli sono in memoria: oltre, Ollama è considerato muto. */
export const PS_TIMEOUT_MS = 5_000

/** Ollama ha rifiutato di caricare il modello per mancanza di memoria (RAM o memoria video)? */
export const isOutOfMemory = (detail: string): boolean => /out[- ]of[- ]memory|failed to allocate|requires more system memory|insufficient memory/i.test(detail)

/** Codici con cui fetch (undici) chiude una richiesta rimasta 5 minuti senza dati. */
const SILENCE_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const causeCode = (err: unknown): string | null => {
  const code = ((err as { cause?: unknown } | null)?.cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : null
}

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
  /** Layer del modello sulla GPU: 0 = solo CPU; assente = decide Ollama. */
  num_gpu?: number
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
  /** Token del prompt valutati da Ollama (system + storico + domanda). */
  promptEvalCount: number | null
  durationMs: number | null
  /** Tempi di Ollama (ms): caricamento del modello, lettura del prompt, scrittura della risposta. */
  loadMs: number | null
  promptEvalMs: number | null
  evalMs: number | null
  /** Tempo, misurato dall'app, dall'invio della richiesta al primo frammento ricevuto (ragionamento o risposta). */
  firstTokenMs: number | null
  /** 'length' se Ollama ha fermato la risposta al limite di token (num_predict), 'stop' se è finita. */
  doneReason: DoneReason | null
  /** true se la generazione è stata interrotta: content/thinking contengono il parziale. */
  aborted: boolean
}

/** Conteggi di /api/embed: token letti e tempi. */
export interface EmbedStats {
  promptEvalCount: number | null
  durationMs: number | null
  loadMs: number | null
}

type FetchLike = typeof fetch

/** Nanosecondi di Ollama → millisecondi. */
const ms = (ns: number | undefined): number | null => (ns != null ? Math.round(ns / 1e6) : null)

interface ChatChunk {
  message?: { role?: string; content?: string; thinking?: string }
  done?: boolean
  done_reason?: string
  eval_count?: number
  prompt_eval_count?: number
  total_duration?: number
  load_duration?: number
  prompt_eval_duration?: number
  eval_duration?: number
  error?: string
}

/** Modello caricato in memoria (/api/ps). */
export interface LoadedModel {
  name: string
  /** Memoria totale occupata e quella in GPU, byte. */
  size: number
  sizeVram: number
  contextLength: number | null
}

export interface OllamaClient {
  listModels(): Promise<OllamaModel[]>
  showModel(name: string): Promise<ModelCapabilities>
  chatStream(req: ChatRequest, handlers: ChatHandlers, signal?: AbortSignal): Promise<ChatResult>
  /** Modelli caricati in memoria, con la quota in GPU. */
  loadedModels(): Promise<LoadedModel[]>
  /** Scarica un modello (/api/pull), riportando l'avanzamento. */
  pullModel(name: string, onProgress: (p: { status: string; completed: number | null; total: number | null }) => void, signal?: AbortSignal): Promise<void>
  deleteModel(name: string): Promise<void>
  /** Embedding di più testi in una richiesta (/api/embed). */
  embed(model: string, input: string[], options?: { num_gpu?: number }, onStats?: (stats: EmbedStats) => void): Promise<number[][]>
  clearCache(): void
}

/**
 * Legge i parametri predefiniti dal campo `parameters` di /api/show, che è testo nel formato del
 * Modelfile: una riga per parametro, es. "temperature 0.6" o "stop \"<|im_end|>\"".
 */
export function parseModelDefaults(parameters: unknown): ModelDefaults {
  const out: ModelDefaults = { temperature: null, topP: null, numCtx: null }
  if (typeof parameters !== 'string') return out
  for (const line of parameters.split('\n')) {
    const match = line.trim().match(/^(\w+)\s+(.+)$/)
    if (!match) continue
    const value = Number(match[2].trim().replace(/^"|"$/g, ''))
    if (!Number.isFinite(value)) continue
    if (match[1] === 'temperature') out.temperature = value
    else if (match[1] === 'top_p') out.topP = value
    else if (match[1] === 'num_ctx') out.numCtx = Math.round(value)
  }
  return out
}

/** Valore numerico di `model_info` la cui chiave finisce con `suffix` (le chiavi sono prefissate dall'architettura, es. "llama.block_count"). */
export function modelInfoNumber(info: Record<string, unknown>, suffix: string): number | null {
  const entry = Object.entries(info).find(([k]) => k.endsWith(suffix))
  return typeof entry?.[1] === 'number' && entry[1] > 0 ? entry[1] : null
}

/**
 * Quota dei layer che vedono tutto il contesto nelle architetture con finestra scorrevole: gli altri
 * tengono in cache solo gli ultimi `sliding_window` token, un costo fisso che non cresce con il contesto.
 * Gemma 3: 5 layer locali ogni globale; Gemma 2: alternati. Altre architetture: non noto, si resta prudenti.
 */
export function globalLayerShare(info: Record<string, unknown>): number {
  if (!modelInfoNumber(info, '.attention.sliding_window')) return 1
  const arch = Object.keys(info).find((k) => k.endsWith('.block_count'))?.split('.')[0] ?? ''
  if (arch === 'gemma3' || arch === 'gemma3n') return 1 / 6
  if (arch === 'gemma2') return 1 / 2
  return 1
}

/**
 * Memoria per token di contesto (cache KV in f16): 2 (K e V) × layer × teste KV × dimensione testa × 2 byte,
 * contando solo i layer che crescono con il contesto (vedi globalLayerShare).
 * La dimensione della testa è `attention.key_length` se dichiarata, altrimenti embedding ÷ teste.
 * null se l'architettura non espone i campi.
 */
export function kvBytesPerToken(info: Record<string, unknown>): number | null {
  const layers = modelInfoNumber(info, '.block_count')
  const heads = modelInfoNumber(info, '.attention.head_count')
  const kvHeads = modelInfoNumber(info, '.attention.head_count_kv') ?? heads
  const headDim =
    modelInfoNumber(info, '.attention.key_length') ??
    (heads && modelInfoNumber(info, '.embedding_length') ? modelInfoNumber(info, '.embedding_length')! / heads : null)
  if (!layers || !kvHeads || !headDim) return null
  return Math.round(2 * layers * globalLayerShare(info) * kvHeads * headDim * 2)
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')

/** Dati di una richiesta per il registro, il timeout e i messaggi d'errore. */
interface RequestMeta {
  model?: string
  /** Memoria della conversazione richiesta (per il messaggio di memoria insufficiente). */
  numCtx?: number
  /** Chiamate ripetute (stato dei modelli durante l'attesa): nel registro solo gli errori. */
  quiet?: boolean
  /** Tempo massimo, per le chiamate che Ollama serve subito. Assente: nessun limite dell'app. */
  timeoutMs?: number
}

export function createOllamaClient(getBaseUrl: () => string, fetchImpl: FetchLike = fetch, log: Logger = nullLogger): OllamaClient {
  const capsCache = new Map<string, ModelCapabilities>()

  const url = (path: string): string => getBaseUrl().replace(/\/+$/, '') + path

  /**
   * Richiesta a Ollama. Ogni esito va nel registro diagnostico: per /api/chat con stream «ok» vuol dire che
   * Ollama ha cominciato a rispondere (il seguito lo registra chatStream).
   */
  async function request(path: string, init: RequestInit = {}, meta: RequestMeta = {}): Promise<Response> {
    const { model, quiet = false, timeoutMs } = meta
    const started = Date.now()
    const method = init.method ?? 'GET'
    const took = (): number => Date.now() - started
    const limit = timeoutMs ? AbortSignal.timeout(timeoutMs) : null
    const signal = limit && init.signal ? AbortSignal.any([init.signal, limit]) : (limit ?? init.signal)
    let res: Response
    try {
      res = await fetchImpl(url(path), {
        ...init,
        ...(signal ? { signal } : {}),
        headers: { 'content-type': 'application/json', ...init.headers }
      })
    } catch (err) {
      // Il limite dell'app è scaduto: non è un'interruzione dell'utente.
      if (limit?.aborted && !init.signal?.aborted) {
        log.error('ollama', `${method} ${path} senza risposta entro il limite`, { model, ms: took(), url: getBaseUrl() })
        throw new OllamaError('timeout', t('err.timeout', { seconds: Math.round(timeoutMs! / 1000), url: getBaseUrl() }))
      }
      if (isAbort(err)) {
        log.info('ollama', `${method} ${path} interrotta`, { model, ms: took() })
        throw err
      }
      log.error('ollama', `${method} ${path} senza risposta`, { model, ms: took(), url: getBaseUrl(), error: errorDetail(err) })
      // fetch chiude da sé una richiesta rimasta 5 minuti senza dati: Ollama c'è, ma non ha risposto.
      if (SILENCE_CODES.has(causeCode(err) ?? '')) throw new OllamaError('timeout', t('err.timeout.long'))
      throw new OllamaError('unreachable', t('err.unreachable', { url: getBaseUrl() }))
    }
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) detail = body.error
      } catch {
        /* corpo non JSON: resta lo statusText */
      }
      log.error('ollama', `${method} ${path} errore`, { model, numCtx: meta.numCtx, ms: took(), status: res.status, error: detail })
      if (isOutOfMemory(detail)) throw new OllamaError('memory', outOfMemoryMessage(detail, meta), res.status)
      const code: OllamaErrorCode = res.status === 404 ? 'model' : 'http'
      throw new OllamaError(code, `Ollama ${res.status}: ${detail}`, res.status)
    }
    if (!quiet) log.info('ollama', `${method} ${path} ok`, { model, ms: took() })
    return res
  }

  /** Memoria insufficiente: cosa è successo e cosa si può fare, con il testo di Ollama in coda. */
  function outOfMemoryMessage(detail: string, meta: RequestMeta): string {
    const ctx = meta.numCtx ? t('err.memory.ctx', { numCtx: meta.numCtx }) : ''
    return t('err.memory', { model: meta.model ?? '', ctx, detail })
  }

  async function listModels(): Promise<OllamaModel[]> {
    const res = await request('/api/tags', {}, { timeoutMs: QUICK_TIMEOUT_MS })
    const body = (await res.json()) as {
      models?: Array<{
        name: string
        digest?: string
        size: number
        modified_at: string
        details?: { family?: string; parameter_size?: string; quantization_level?: string }
      }>
    }
    return (body.models ?? [])
      .map((m) => ({
        name: m.name,
        digest: m.digest ?? null,
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

    const res = await request('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) }, { model: name, timeoutMs: QUICK_TIMEOUT_MS })
    const body = (await res.json()) as {
      capabilities?: string[]
      model_info?: Record<string, unknown>
      parameters?: unknown
      template?: unknown
      modelfile?: unknown
    }
    const capabilities = body.capabilities ?? []
    const info = body.model_info ?? {}
    const caps: ModelCapabilities = {
      capabilities,
      thinking: capabilities.includes('thinking'),
      contextLength: modelInfoNumber(info, '.context_length'),
      kvBytesPerToken: kvBytesPerToken(info),
      layers: modelInfoNumber(info, '.block_count'),
      defaults: parseModelDefaults(body.parameters),
      systemSlot: detectSystemSlot(body.template, body.modelfile)
    }
    capsCache.set(key, caps)
    return caps
  }

  async function chatStream(
    req: ChatRequest,
    handlers: ChatHandlers,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const result: ChatResult = {
      content: '',
      thinking: '',
      evalCount: null,
      promptEvalCount: null,
      durationMs: null,
      loadMs: null,
      promptEvalMs: null,
      evalMs: null,
      firstTokenMs: null,
      doneReason: null,
      aborted: false
    }
    const started = Date.now()
    const first = (): void => {
      if (result.firstTokenMs == null) result.firstTokenMs = Date.now() - started
    }

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(line) as ChatChunk
      } catch {
        throw new OllamaError('parse', t('err.badNdjson', { line: line.slice(0, 120) }))
      }
      if (chunk.error) {
        if (isOutOfMemory(chunk.error)) throw new OllamaError('memory', outOfMemoryMessage(chunk.error, { model: req.model, numCtx: req.options?.num_ctx }))
        throw new OllamaError('http', chunk.error)
      }
      const thinking = chunk.message?.thinking
      if (thinking) {
        first()
        result.thinking += thinking
        handlers.onThinking?.(thinking)
      }
      const content = chunk.message?.content
      if (content) {
        first()
        result.content += content
        handlers.onContent?.(content)
      }
      if (chunk.done) {
        result.evalCount = chunk.eval_count ?? null
        result.promptEvalCount = chunk.prompt_eval_count ?? null
        result.durationMs = ms(chunk.total_duration)
        result.loadMs = ms(chunk.load_duration)
        result.promptEvalMs = ms(chunk.prompt_eval_duration)
        result.evalMs = ms(chunk.eval_duration)
        result.doneReason = chunk.done_reason === 'length' ? 'length' : chunk.done_reason === 'stop' ? 'stop' : null
      }
    }

    let streaming = false
    try {
      const res = await request('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ ...req, stream: true }),
        signal
      }, { model: req.model, numCtx: req.options?.num_ctx })
      streaming = true
      if (!res.body) throw new OllamaError('parse', t('err.noBody'))

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
        log.info('ollama', 'chat interrotta', { model: req.model, ms: Date.now() - started, firstTokenMs: result.firstTokenMs })
        return result
      }
      // Errore a risposta iniziata (stream interrotto, riga non valida, errore dentro lo stream): quelli
      // precedenti li ha già registrati `request`.
      if (streaming) {
        log.error('ollama', 'chat fallita durante la risposta', { model: req.model, ms: Date.now() - started, firstTokenMs: result.firstTokenMs, error: errorDetail(err) })
        // La connessione è caduta mentre si leggeva la risposta: un messaggio chiaro al posto di «terminated».
        if (!(err instanceof OllamaError)) {
          throw SILENCE_CODES.has(causeCode(err) ?? '') ? new OllamaError('timeout', t('err.timeout.long')) : new OllamaError('interrupted', t('err.interrupted'))
        }
      }
      throw err
    }
    log.info('ollama', 'chat finita', {
      model: req.model,
      numCtx: req.options?.num_ctx,
      ms: Date.now() - started,
      firstTokenMs: result.firstTokenMs,
      loadMs: result.loadMs,
      promptEvalMs: result.promptEvalMs,
      evalMs: result.evalMs,
      promptTokens: result.promptEvalCount,
      tokens: result.evalCount,
      doneReason: result.doneReason
    })
    return result
  }

  async function loadedModels(): Promise<LoadedModel[]> {
    const res = await request('/api/ps', {}, { quiet: true, timeoutMs: PS_TIMEOUT_MS })
    const body = (await res.json()) as { models?: Array<{ name: string; size?: number; size_vram?: number; context_length?: number }> }
    return (body.models ?? []).map((m) => ({
      name: m.name,
      size: m.size ?? 0,
      sizeVram: m.size_vram ?? 0,
      contextLength: m.context_length ?? null
    }))
  }

  async function pullModel(
    name: string,
    onProgress: (p: { status: string; completed: number | null; total: number | null }) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await request('/api/pull', { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal }, { model: name })
    if (!res.body) throw new OllamaError('parse', t('err.noBody'))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const handle = (line: string): void => {
      if (!line.trim()) return
      const chunk = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string }
      if (chunk.error) throw new OllamaError('http', chunk.error)
      onProgress({ status: chunk.status ?? '', completed: chunk.completed ?? null, total: chunk.total ?? null })
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    handle(buffer + decoder.decode())
    capsCache.clear()
  }

  async function deleteModel(name: string): Promise<void> {
    await request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) }, { model: name, timeoutMs: QUICK_TIMEOUT_MS })
    capsCache.clear()
  }

  async function embed(model: string, input: string[], options?: { num_gpu?: number }, onStats?: (stats: EmbedStats) => void): Promise<number[][]> {
    const res = await request('/api/embed', { method: 'POST', body: JSON.stringify({ model, input, ...(options ? { options } : {}) }) }, { model })
    const body = (await res.json()) as { embeddings?: number[][]; prompt_eval_count?: number; total_duration?: number; load_duration?: number }
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
      throw new OllamaError('parse', t('err.badEmbed'))
    }
    log.info('ollama', 'embedding', { model, texts: input.length, loadMs: ms(body.load_duration), totalMs: ms(body.total_duration) })
    onStats?.({ promptEvalCount: body.prompt_eval_count ?? null, durationMs: ms(body.total_duration), loadMs: ms(body.load_duration) })
    return body.embeddings
  }

  return { listModels, showModel, chatStream, loadedModels, pullModel, deleteModel, embed, clearCache: () => capsCache.clear() }
}
