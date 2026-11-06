import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Server Ollama finto per i test (unitari ed e2e): risponde a /api/tags, /api/show e /api/chat
 * con stream NDJSON. Il comportamento si personalizza per modello.
 */
export interface FakeModel {
  name: string
  capabilities: string[]
  contextLength?: number
  /** Dimensione del file del modello in byte (/api/tags). Default 2 GB. */
  size?: number
  /** Campi aggiuntivi di `model_info` (/api/show), es. block_count e teste KV per il costo del contesto. */
  modelInfo?: Record<string, unknown>
  /** Testo del campo `parameters` di /api/show (formato Modelfile), es. "top_p 0.95\nnum_ctx 8192". */
  parameters?: string
  /** Chunk da inviare su /api/chat. Default: un breve pensiero + risposta. */
  chunks?: Array<{ thinking?: string; content?: string }>
  /** Digest restituito da /api/tags. */
  digest?: string
  /** Simulazione CPU/GPU per il test: velocità di scrittura in token/s e se c'è una GPU utilizzabile. */
  cpuTps?: number
  gpuTps?: number
  gpu?: boolean
  /** done_reason dell'ultimo chunk: 'length' simula una risposta tagliata al limite di token. Default 'stop'. */
  doneReason?: 'stop' | 'length'
  /** Ritardo tra un chunk e l'altro, ms. */
  delayMs?: number
  /** Attesa prima del primo chunk, ms (simula il caricamento del modello). */
  startDelayMs?: number
  /**
   * Risposta alle richieste con `format` (plan mode): oggetto serializzato in JSON oppure stringa grezza.
   * Default: un piano di tre passi.
   */
  plan?: unknown
}

export const DEFAULT_FAKE_PLAN = {
  steps: [
    { title: 'Capire la richiesta', detail: 'Riassumere cosa chiede l\'utente.' },
    { title: 'Raccogliere i punti chiave', detail: 'Elencare gli elementi da trattare.' },
    { title: 'Scrivere la risposta', detail: 'Rispondere in modo ordinato.' }
  ]
}

export interface FakeOllama {
  url: string
  requests: Array<{ path: string; body: unknown }>
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : null
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startFakeOllama(models: FakeModel[]): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = []
  /** Modelli "caricati" e il num_gpu dell'ultima richiesta (per /api/ps). */
  const loaded = new Map<string, number | undefined>()
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const server: Server = createServer(async (req, res) => {
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : null
    requests.push({ path: req.url ?? '', body })

    if (req.url === '/api/tags') {
      return json(res, 200, {
        models: models.map((m) => ({
          name: m.name,
          digest: m.digest ?? `digest-${m.name}`,
          size: m.size ?? 2_000_000_000,
          modified_at: '2026-01-01T00:00:00Z',
          details: { family: 'fake', parameter_size: '3B', quantization_level: 'Q4_K_M' }
        }))
      })
    }

    if (req.url === '/api/ps') {
      return json(res, 200, {
        models: [...loaded.entries()].map(([name, numGpu]) => {
          const m = models.find((x) => x.name === name)
          const size = m?.size ?? 2_000_000_000
          const layers = Number(m?.modelInfo?.['fake.block_count'] ?? 32)
          const share = m?.gpu && numGpu !== undefined && numGpu > 0 ? Math.min(1, numGpu / layers) : m?.gpu && numGpu === undefined ? 1 : 0
          return { name, size, size_vram: Math.round(size * share), context_length: 2048 }
        })
      })
    }

    if (req.url === '/api/pull') {
      const name = (body as { model?: string }).model ?? ''
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
      res.write(JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\n')
      res.write(JSON.stringify({ status: 'downloading', completed: 100, total: 100 }) + '\n')
      if (!models.some((m) => m.name === name)) models.push({ name, capabilities: ['completion'] })
      return res.end(JSON.stringify({ status: 'success' }) + '\n')
    }

    if (req.url === '/api/delete') {
      const name = (body as { model?: string }).model
      const i = models.findIndex((m) => m.name === name)
      if (i < 0) return json(res, 404, { error: `model '${name}' not found` })
      models.splice(i, 1)
      return json(res, 200, {})
    }

    const modelName = (body as { model?: string } | null)?.model
    const model = models.find((m) => m.name === modelName)

    if (req.url === '/api/show') {
      if (!model) return json(res, 404, { error: `model '${modelName}' not found` })
      return json(res, 200, {
        capabilities: model.capabilities,
        model_info: { 'fake.context_length': model.contextLength ?? 8192, ...model.modelInfo },
        ...(model.parameters ? { parameters: model.parameters } : {})
      })
    }

    if (req.url === '/api/chat') {
      if (!model) return json(res, 404, { error: `model '${modelName}' not found` })
      const numGpu = (body as { options?: { num_gpu?: number } }).options?.num_gpu
      loaded.set(model.name, numGpu)
      const onGpu = !!model.gpu && numGpu !== 0
      const tpsNow = onGpu ? (model.gpuTps ?? 20) : (model.cpuTps ?? 10)
      const think = (body as { think?: boolean }).think === true
      const format = (body as { format?: unknown }).format
      let chunks = model.chunks ?? [{ thinking: 'Ci penso. ' }, { content: 'Ciao' }, { content: ' mondo!' }]
      if (format) {
        const plan = model.plan ?? DEFAULT_FAKE_PLAN
        const text = typeof plan === 'string' ? plan : JSON.stringify(plan)
        chunks = [{ thinking: 'Pianifico. ' }]
        for (let i = 0; i < text.length; i += 20) chunks.push({ content: text.slice(i, i + 20) })
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (model.startDelayMs) await sleep(model.startDelayMs)
      let aborted = false
      res.on('close', () => (aborted = !res.writableFinished))
      for (const c of chunks) {
        if (aborted) return
        if (c.thinking && !think) continue
        res.write(
          JSON.stringify({
            model: model.name,
            message: { role: 'assistant', content: c.content ?? '', ...(c.thinking ? { thinking: c.thinking } : {}) },
            done: false
          }) + '\n'
        )
        if (model.delayMs) await sleep(model.delayMs)
      }
      res.end(
        JSON.stringify({
          model: model.name,
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: model.doneReason ?? 'stop',
          eval_count: 42,
          prompt_eval_count: Math.max(1, Math.ceil(JSON.stringify((body as { messages?: unknown }).messages ?? []).length / 4)),
          total_duration: 1_500_000_000,
          load_duration: 200_000_000,
          prompt_eval_duration: 100_000_000,
          eval_duration: Math.round((42 / tpsNow) * 1e9)
        }) + '\n'
      )
      return
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
