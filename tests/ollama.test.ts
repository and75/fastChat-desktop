import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOllamaClient, kvBytesPerToken, OllamaError, parseModelDefaults } from '../src/main/ollama'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

let fake: FakeOllama

beforeAll(async () => {
  fake = await startFakeOllama([
    {
      name: 'qwen3:4b',
      capabilities: ['completion', 'thinking'],
      contextLength: 40960,
      parameters: 'repeat_penalty 1\nstop "<|im_start|>"\nstop "<|im_end|>"\ntemperature 0.6\ntop_k 20\ntop_p 0.95\nnum_ctx 8192'
    },
    { name: 'llama3.2:3b', capabilities: ['completion', 'tools'] },
    {
      name: 'slow',
      capabilities: ['completion'],
      delayMs: 30,
      chunks: Array.from({ length: 50 }, (_, i) => ({ content: `t${i} ` }))
    }
  ])
})

afterAll(() => fake.close())

const client = () => createOllamaClient(() => fake.url)

describe('listModels', () => {
  it('restituisce i modelli ordinati con i dettagli', async () => {
    const models = await client().listModels()
    expect(models.map((m) => m.name)).toEqual(['llama3.2:3b', 'qwen3:4b', 'slow'])
    expect(models[0]).toMatchObject({ parameterSize: '3B', quantization: 'Q4_K_M', family: 'fake' })
  })

  it('segnala Ollama irraggiungibile', async () => {
    const c = createOllamaClient(() => 'http://127.0.0.1:1')
    await expect(c.listModels()).rejects.toMatchObject({ name: 'OllamaError', code: 'unreachable' })
  })

  it('tollera lo slash finale nell\'URL', async () => {
    const c = createOllamaClient(() => fake.url + '/')
    await expect(c.listModels()).resolves.toHaveLength(3)
  })
})

describe('showModel', () => {
  it('rileva la capability thinking e la context length', async () => {
    const c = client()
    expect(await c.showModel('qwen3:4b')).toEqual({
      capabilities: ['completion', 'thinking'],
      thinking: true,
      contextLength: 40960,
      kvBytesPerToken: null,
      defaults: { temperature: 0.6, topP: 0.95, numCtx: 8192 }
    })
    const llama = await c.showModel('llama3.2:3b')
    expect(llama.thinking).toBe(false)
    expect(llama.defaults).toEqual({ temperature: null, topP: null, numCtx: null })
  })

  it('kvBytesPerToken: 2 × layer × teste KV × dimensione testa × 2 byte, dall\'architettura', () => {
    // llama 3.1 8B: 32 layer, 8 teste KV, 4096/32 = 128 → 128 KiB
    expect(kvBytesPerToken({ 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 })).toBe(131072)
    // key_length dichiarata vince su embedding ÷ teste; senza head_count_kv si usano tutte le teste
    expect(kvBytesPerToken({ 'gemma3.block_count': 48, 'gemma3.attention.head_count': 16, 'gemma3.attention.head_count_kv': 8, 'gemma3.attention.key_length': 256, 'gemma3.embedding_length': 3840 })).toBe(48 * 8 * 256 * 4)
    expect(kvBytesPerToken({ 'x.block_count': 10, 'x.attention.head_count': 4, 'x.embedding_length': 512 })).toBe(10 * 4 * 128 * 4)
    // campi mancanti
    expect(kvBytesPerToken({ 'x.block_count': 10 })).toBeNull()
    expect(kvBytesPerToken({})).toBeNull()
  })

  it('tiene in cache le capabilities', async () => {
    const c = client()
    const before = fake.requests.filter((r) => r.path === '/api/show').length
    await c.showModel('qwen3:4b')
    await c.showModel('qwen3:4b')
    expect(fake.requests.filter((r) => r.path === '/api/show').length).toBe(before + 1)
  })

  it('modello inesistente → errore "model" con il messaggio di Ollama', async () => {
    const err = await client().showModel('nope').catch((e) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect(err.code).toBe('model')
    expect(err.message).toContain("model 'nope' not found")
  })
})

describe('chatStream', () => {
  it('separa thinking e content e raccoglie le statistiche', async () => {
    const thinking: string[] = []
    const content: string[] = []
    const res = await client().chatStream(
      { model: 'qwen3:4b', messages: [{ role: 'user', content: 'ciao' }], think: true, options: { temperature: 0.2 } },
      { onThinking: (d) => thinking.push(d), onContent: (d) => content.push(d) }
    )
    expect(thinking).toEqual(['Ci penso. '])
    expect(content).toEqual(['Ciao', ' mondo!'])
    expect(res.promptEvalCount).toBeGreaterThan(0)
    expect({ ...res, promptEvalCount: undefined }).toEqual({
      content: 'Ciao mondo!',
      thinking: 'Ci penso. ',
      promptEvalCount: undefined,
      evalCount: 42,
      durationMs: 1500,
      doneReason: 'stop',
      aborted: false
    })
    const sent = fake.requests.at(-1)?.body as Record<string, unknown>
    expect(sent).toMatchObject({ model: 'qwen3:4b', think: true, stream: true, options: { temperature: 0.2 } })
  })

  it('con think=false non arriva ragionamento', async () => {
    const res = await client().chatStream(
      { model: 'qwen3:4b', messages: [{ role: 'user', content: 'ciao' }], think: false },
      {}
    )
    expect(res.thinking).toBe('')
    expect(res.content).toBe('Ciao mondo!')
  })

  it('abort: restituisce il parziale con aborted=true', async () => {
    const ctrl = new AbortController()
    const seen: string[] = []
    const res = await client().chatStream(
      { model: 'slow', messages: [{ role: 'user', content: 'lungo' }] },
      {
        onContent: (d) => {
          seen.push(d)
          if (seen.length === 3) ctrl.abort()
        }
      },
      ctrl.signal
    )
    expect(res.aborted).toBe(true)
    expect(res.content.startsWith('t0 t1 t2 ')).toBe(true)
    expect(res.content.length).toBeLessThan(50 * 4)
    expect(res.evalCount).toBeNull()
  })

  it('errore HTTP → OllamaError con il dettaglio', async () => {
    await expect(
      client().chatStream({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }, {})
    ).rejects.toMatchObject({ code: 'model', status: 404 })
  })

  it('errore dentro lo stream NDJSON', async () => {
    const fetchImpl = (async () =>
      new Response(
        '{"message":{"role":"assistant","content":"a"},"done":false}\n{"error":"out of memory"}\n',
        { status: 200 }
      )) as typeof fetch
    const c = createOllamaClient(() => 'http://x', fetchImpl)
    await expect(c.chatStream({ model: 'm', messages: [] }, {})).rejects.toThrow('out of memory')
  })

  it('ricompone righe spezzate tra più chunk di rete', async () => {
    const enc = new TextEncoder()
    const parts = ['{"message":{"content":"Ci', 'ao"},"done":false}\n{"message":{"con', 'tent":"!"},"done":true,"eval_count":2}']
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const p of parts) ctrl.enqueue(enc.encode(p))
        ctrl.close()
      }
    })
    const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch
    const res = await createOllamaClient(() => 'http://x', fetchImpl).chatStream({ model: 'm', messages: [] }, {})
    expect(res.content).toBe('Ciao!')
    expect(res.evalCount).toBe(2)
  })
})

describe('parseModelDefaults', () => {
  it('legge temperature, top_p e num_ctx dal formato Modelfile', () => {
    expect(parseModelDefaults('temperature   0.7\n  top_p 0.8\nnum_ctx 2048.0\nstop "x"')).toEqual({
      temperature: 0.7,
      topP: 0.8,
      numCtx: 2048
    })
  })
  it('valori assenti o non numerici → null', () => {
    expect(parseModelDefaults(undefined)).toEqual({ temperature: null, topP: null, numCtx: null })
    expect(parseModelDefaults('top_p abc\nnum_ctx')).toEqual({ temperature: null, topP: null, numCtx: null })
  })
})
