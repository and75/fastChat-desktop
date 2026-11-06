import { describe, expect, it } from 'vitest'
import {
  describeSuggestion,
  floorPow2,
  minNumCtx,
  reserveTokensFor,
  resolveNumCtx,
  resolveSettings,
  resolveTopP,
  suggestNumCtx,
  suggestSettings,
  type SystemInfo
} from '../src/shared/settings'
import type { ConversationSettings, ModelCapabilities } from '../src/shared/types'

const GB = 1024 ** 3
const caps: ModelCapabilities = {
  capabilities: ['completion', 'thinking'],
  thinking: true,
  contextLength: 8192,
  kvBytesPerToken: null,
  layers: null,
  defaults: { temperature: 0.6, topP: 0.95, numCtx: 2048 }
}
const bare: ModelCapabilities = { capabilities: [], thinking: false, contextLength: null, kvBytesPerToken: null, layers: null, defaults: { temperature: null, topP: null, numCtx: null } }
const conv: ConversationSettings = { temperature: 0.7, think: true, planMode: false, topP: null, numCtx: null, seed: null, style: 'normal' }
const mac = (gb: number, kvCacheType: SystemInfo['kvCacheType'] = 'f16'): SystemInfo => ({ ramBytes: gb * GB, unified: true, kvCacheType })
const pc = (gb: number): SystemInfo => ({ ramBytes: gb * GB, unified: false, kvCacheType: 'f16' })
const big = (contextLength: number, kv: number | null = null): ModelCapabilities => ({ ...bare, contextLength, kvBytesPerToken: kv })

describe('memoria della conversazione suggerita dalla RAM', () => {
  it('floorPow2', () => {
    expect(floorPow2(1)).toBe(1)
    expect(floorPow2(4096)).toBe(4096)
    expect(floorPow2(43_000)).toBe(32768)
  })

  it('esempi: (RAM − pesi) ÷ costo per token, potenza di 2 inferiore', () => {
    expect(suggestNumCtx({ system: mac(8), modelBytes: 2.5 * GB, caps: big(262_144) })).toBe(32768) // 5,5 GB → 45k
    expect(suggestNumCtx({ system: mac(16), modelBytes: 5 * GB, caps: big(262_144) })).toBe(65536) // 11 GB → 90k
    expect(suggestNumCtx({ system: mac(64), modelBytes: 18 * GB, caps: big(262_144, 256 * 1024) })).toBe(131_072) // 46 GB → 188k
    expect(suggestNumCtx({ system: pc(32), modelBytes: 5 * GB, caps: big(262_144) })).toBe(131_072) // 27 GB → 221k
    expect(suggestNumCtx({ system: pc(16), modelBytes: 5 * GB, caps: big(262_144) })).toBe(65536)
  })

  it('mai sopra il massimo del modello, mai sotto 2k', () => {
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: big(262_144) })).toBe(262_144)
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: big(8192) })).toBe(8192)
    // modello più grande della RAM: mai sotto il minimo del modello (predefinito di Ollama)
    expect(suggestNumCtx({ system: mac(2), modelBytes: 3 * GB, caps: big(8192) })).toBe(4096)
    expect(suggestNumCtx({ system: mac(2), modelBytes: 3 * GB, caps: { ...big(8192), defaults: { ...big(8192).defaults, numCtx: 8192 } } })).toBe(8192)
    // massimo ignoto: 32k
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: bare })).toBe(32768)
  })

  it('usa il costo per token dichiarato dal modello', () => {
    const cheap = big(262_144, 64 * 1024)
    expect(suggestNumCtx({ system: mac(16), modelBytes: 5 * GB, caps: cheap })).toBe(131_072) // 11 GB ÷ 64 KiB → 180k
  })

  it('cache KV quantizzata: ogni token costa meno, il contesto che ci sta cresce', () => {
    // 11 GB ÷ 128 KiB = 90k → 65.536; q8_0 (×0,53) → 169k → 131.072; q4_0 (×0,28) → 320k → 262.144
    expect(suggestNumCtx({ system: mac(16), modelBytes: 5 * GB, caps: big(262_144) })).toBe(65536)
    expect(suggestNumCtx({ system: mac(16, 'q8_0'), modelBytes: 5 * GB, caps: big(262_144) })).toBe(131_072)
    expect(suggestNumCtx({ system: mac(16, 'q4_0'), modelBytes: 5 * GB, caps: big(262_144) })).toBe(262_144)
    expect(describeSuggestion({ system: mac(16, 'q8_0'), modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di RAM unificata e un modello da 5 GB, con cache KV q8_0.')
  })

  it('senza RAM (Ollama remoto) o senza dimensione del modello: nessun suggerimento', () => {
    expect(suggestNumCtx({ system: { ramBytes: null, unified: false, kvCacheType: 'f16' }, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: null, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: mac(16), modelBytes: null, caps })).toBeNull()
  })

  it('describeSuggestion', () => {
    expect(describeSuggestion({ system: mac(16), modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di RAM unificata e un modello da 5 GB.')
    expect(describeSuggestion({ system: pc(32), modelBytes: 5 * GB, caps })).toBe('Calcolato su 32 GB di RAM e un modello da 5 GB.')
    expect(describeSuggestion({ system: { ramBytes: null, unified: false, kvCacheType: 'f16' }, modelBytes: 5 * GB, caps })).toMatch(/non è su questa macchina/)
  })
})

describe('valori suggeriti per il modello', () => {
  it('temperatura e top_p dal Modelfile, altrimenti Ollama', () => {
    expect(suggestSettings({ system: null, modelBytes: null, caps })).toEqual({ temperature: 0.6, topP: 0.95, numCtx: 2048 })
    expect(suggestSettings({ system: null, modelBytes: null, caps: bare })).toEqual({ temperature: 0.8, topP: 0.9, numCtx: 4096 })
    expect(suggestSettings({ system: null, modelBytes: null, caps: null })).toEqual({ temperature: 0.8, topP: 0.9, numCtx: 4096 })
  })

  it('num_ctx: calcolato dalla RAM vince sul Modelfile; senza RAM il Modelfile, entro il massimo', () => {
    expect(suggestSettings({ system: mac(16), modelBytes: 5 * GB, caps }).numCtx).toBe(8192) // massimo del modello
    expect(suggestSettings({ system: null, modelBytes: null, caps: { ...caps, defaults: { ...caps.defaults, numCtx: 100_000 } } }).numCtx).toBe(8192)
  })
})

describe('memoria minima consigliata', () => {
  it('predefinito di Ollama per il modello (Modelfile, altrimenti 4096), entro il massimo', () => {
    expect(minNumCtx(caps)).toBe(2048)
    expect(minNumCtx(bare)).toBe(4096)
    expect(minNumCtx(null)).toBe(4096)
    expect(minNumCtx({ ...bare, contextLength: 2048 })).toBe(2048)
  })
})

describe('riserva per la risposta (non inviata a Ollama)', () => {
  it('quota fissa: il 20% della memoria', () => {
    expect(reserveTokensFor(4096)).toBe(819)
    expect(reserveTokensFor(1024)).toBe(204)
    expect(reserveTokensFor(32768)).toBe(6553)
  })
})

describe('parametri effettivi (ciò che l\'utente vede = ciò che va a Ollama)', () => {
  it('num_ctx: il configurato; se non ancora calibrato, Modelfile poi Ollama', () => {
    expect(resolveNumCtx({ numCtx: 3000 }, caps)).toBe(3000)
    expect(resolveNumCtx({ numCtx: null }, caps)).toBe(2048)
    expect(resolveNumCtx({ numCtx: null }, bare)).toBe(4096)
    expect(resolveNumCtx({ numCtx: null }, null)).toBe(4096)
  })

  it('num_ctx non supera mai il contesto massimo del modello (32k se ignoto)', () => {
    expect(resolveNumCtx({ numCtx: 65536 }, caps)).toBe(8192)
    expect(resolveNumCtx({ numCtx: null }, { ...caps, defaults: { ...caps.defaults, numCtx: 100_000 } })).toBe(8192)
    expect(resolveNumCtx({ numCtx: 65536 }, bare)).toBe(32768)
  })

  it('top_p: configurato, poi modello, poi Ollama', () => {
    expect(resolveTopP({ topP: 0.5 }, caps)).toBe(0.5)
    expect(resolveTopP({ topP: null }, caps)).toBe(0.95)
    expect(resolveTopP({ topP: null }, null)).toBe(0.9)
  })

  it('think solo se il modello lo supporta', () => {
    expect(resolveSettings(conv, caps)).toEqual({ temperature: 0.7, topP: 0.95, numCtx: 2048, reserveTokens: 409, seed: null, think: true })
    expect(resolveSettings(conv, bare).think).toBe(false)
    expect(resolveSettings({ ...conv, think: false }, caps).think).toBe(false)
  })
})
