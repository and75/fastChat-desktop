import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calibrationPatch, suggestFor } from '../src/main/calibrate'
import { createOllamaClient } from '../src/main/ollama'
import { isLocalOllama, systemInfo } from '../src/main/system'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const GB = 1024 ** 3
let fake: FakeOllama

beforeAll(async () => {
  fake = await startFakeOllama([
    // 8B con architettura dichiarata: 32 layer × 8 teste KV × 128 = 128 KiB per token
    {
      name: 'otto',
      capabilities: ['completion'],
      contextLength: 131_072,
      size: 5 * GB,
      parameters: 'temperature 0.6\ntop_p 0.95\nnum_ctx 4096',
      modelInfo: { 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 }
    },
    { name: 'nudo', capabilities: ['completion'], contextLength: 4096 }
  ])
})
afterAll(() => fake.close())

const deps = (ramGb: number, unified = true) => ({
  ollama: createOllamaClient(() => fake.url),
  system: () => ({ ramBytes: ramGb * GB, unified, kvCacheType: 'f16' as const })
})

describe('calibrazione', () => {
  it('suggestFor: num_ctx dalla RAM e dal costo per token del modello, temperatura e top_p dal Modelfile', async () => {
    // (16 − 5) GB ÷ 128 KiB ≈ 90k → 65.536
    expect(await suggestFor(deps(16), 'otto')).toEqual({ temperature: 0.6, topP: 0.95, numCtx: 65536, numPredict: 8192 })
    // modello senza Modelfile né architettura: Ollama + 128 KiB per token, entro il massimo del modello
    expect(await suggestFor(deps(16), 'nudo')).toEqual({ temperature: 0.8, topP: 0.9, numCtx: 4096, numPredict: 1024 })
    // num_predict sulla memoria già configurata; il ragionamento conta solo se il modello lo supporta
    expect((await suggestFor(deps(16), 'otto', { numCtx: 8192, think: true }))?.numPredict).toBe(2048)
  })

  it('suggestFor: null se il modello non esiste o Ollama non risponde', async () => {
    expect(await suggestFor(deps(16), 'manca')).toBeNull()
    expect(await suggestFor(deps(16), '')).toBeNull()
    const down = { ...deps(16), ollama: createOllamaClient(() => 'http://127.0.0.1:1') }
    expect(await suggestFor(down, 'otto')).toBeNull()
  })

  it('calibrationPatch: solo i campi vuoti, oppure tutti (cambio modello)', async () => {
    expect(await calibrationPatch(deps(16), 'otto', { temperature: 0.7, topP: null, numCtx: null, numPredict: null }, true)).toEqual({ topP: 0.95, numCtx: 65536, numPredict: 8192 })
    // conversazione vecchia con memoria già scelta: num_predict si calcola su quella
    expect(await calibrationPatch(deps(16), 'otto', { temperature: 0.7, topP: 0.5, numCtx: 8192, numPredict: null }, true)).toEqual({ numPredict: 2048 })
    expect(await calibrationPatch(deps(16), 'otto', { temperature: 0.7, topP: 0.5, numCtx: 1024, numPredict: 256 }, true)).toEqual({})
    expect(await calibrationPatch(deps(16), 'otto', { temperature: 0.7, topP: 0.5, numCtx: 1024, numPredict: 256 }, false)).toEqual({ temperature: 0.6, topP: 0.95, numCtx: 65536, numPredict: 8192 })
    // Ollama non risponde: nessuna modifica, si riproverà
    expect(await calibrationPatch({ ...deps(16), ollama: createOllamaClient(() => 'http://127.0.0.1:1') }, 'otto', {}, false)).toEqual({})
  })
})

describe('informazioni di sistema', () => {
  it('isLocalOllama', () => {
    expect(isLocalOllama('http://127.0.0.1:11434')).toBe(true)
    expect(isLocalOllama('http://localhost:11434')).toBe(true)
    expect(isLocalOllama('http://[::1]:11434')).toBe(true)
    expect(isLocalOllama('http://192.168.1.10:11434')).toBe(false)
    expect(isLocalOllama('boh')).toBe(false)
  })

  it('systemInfo: RAM solo con Ollama locale; variabili d\'ambiente per i test', () => {
    process.env.FASTCHAT_SYSTEM_RAM = String(16 * GB)
    process.env.FASTCHAT_SYSTEM_UNIFIED = '1'
    try {
      expect(systemInfo('http://127.0.0.1:11434')).toEqual({ ramBytes: 16 * GB, unified: true, kvCacheType: 'f16' })
      expect(systemInfo('http://127.0.0.1:11434', 'q8_0')).toEqual({ ramBytes: 16 * GB, unified: true, kvCacheType: 'q8_0' })
      expect(systemInfo('http://10.0.0.2:11434')).toEqual({ ramBytes: null, unified: true, kvCacheType: 'f16' })
    } finally {
      delete process.env.FASTCHAT_SYSTEM_RAM
      delete process.env.FASTCHAT_SYSTEM_UNIFIED
    }
    const real = systemInfo('http://localhost:11434')
    expect(real.ramBytes).toBeGreaterThan(0)
  })
})
