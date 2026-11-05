import { describe, expect, it } from 'vitest'
import {
  describeSuggestion,
  floorPow2,
  followNumPredict,
  numPredictSteps,
  suggestNumPredict,
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
  defaults: { temperature: 0.6, topP: 0.95, numCtx: 2048 }
}
const bare: ModelCapabilities = { capabilities: [], thinking: false, contextLength: null, kvBytesPerToken: null, defaults: { temperature: null, topP: null, numCtx: null } }
const conv: ConversationSettings = { temperature: 0.7, think: true, planMode: false, topP: null, numCtx: null, numPredict: null, seed: null }
const noThink = { think: false }
const mac = (gb: number): SystemInfo => ({ ramBytes: gb * GB, unified: true })
const pc = (gb: number): SystemInfo => ({ ramBytes: gb * GB, unified: false })
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
    // modello più grande della RAM
    expect(suggestNumCtx({ system: mac(2), modelBytes: 3 * GB, caps: big(8192) })).toBe(2048)
    // massimo ignoto: 32k
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: bare })).toBe(32768)
  })

  it('usa il costo per token dichiarato dal modello', () => {
    const cheap = big(262_144, 64 * 1024)
    expect(suggestNumCtx({ system: mac(16), modelBytes: 5 * GB, caps: cheap })).toBe(131_072) // 11 GB ÷ 64 KiB → 180k
  })

  it('senza RAM (Ollama remoto) o senza dimensione del modello: nessun suggerimento', () => {
    expect(suggestNumCtx({ system: { ramBytes: null, unified: false }, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: null, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: mac(16), modelBytes: null, caps })).toBeNull()
  })

  it('describeSuggestion', () => {
    expect(describeSuggestion({ system: mac(16), modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di RAM unificata e un modello da 5 GB.')
    expect(describeSuggestion({ system: pc(32), modelBytes: 5 * GB, caps })).toBe('Calcolato su 32 GB di RAM e un modello da 5 GB.')
    expect(describeSuggestion({ system: { ramBytes: null, unified: false }, modelBytes: 5 * GB, caps })).toMatch(/non è su questa macchina/)
  })
})

describe('valori suggeriti per il modello', () => {
  it('temperatura e top_p dal Modelfile, altrimenti Ollama', () => {
    expect(suggestSettings({ system: null, modelBytes: null, caps, ...noThink })).toEqual({ temperature: 0.6, topP: 0.95, numCtx: 2048, numPredict: 1024 })
    expect(suggestSettings({ system: null, modelBytes: null, caps: bare, ...noThink })).toEqual({ temperature: 0.8, topP: 0.9, numCtx: 4096, numPredict: 1024 })
    expect(suggestSettings({ system: null, modelBytes: null, caps: null, ...noThink })).toEqual({ temperature: 0.8, topP: 0.9, numCtx: 4096, numPredict: 1024 })
  })

  it('num_ctx: calcolato dalla RAM vince sul Modelfile; senza RAM il Modelfile, entro il massimo', () => {
    expect(suggestSettings({ system: mac(16), modelBytes: 5 * GB, caps, ...noThink }).numCtx).toBe(8192) // massimo del modello
    expect(suggestSettings({ system: null, modelBytes: null, caps: { ...caps, defaults: { ...caps.defaults, numCtx: 100_000 } }, ...noThink }).numCtx).toBe(8192)
  })

  it('num_predict si suggerisce sulla memoria configurata, se c\'è', () => {
    expect(suggestSettings({ system: mac(16), modelBytes: 5 * GB, caps, think: false, numCtx: 32768 }).numPredict).toBe(8192)
    expect(suggestSettings({ system: mac(16), modelBytes: 5 * GB, caps, think: true, numCtx: 32768 }).numPredict).toBe(16384)
  })
})

describe('lunghezza massima della risposta (num_predict)', () => {
  it('un quarto della memoria tra 1k e 8k; il doppio con il ragionamento, fino a 16k', () => {
    expect(suggestNumPredict(4096, false)).toBe(1024)
    expect(suggestNumPredict(8192, false)).toBe(2048)
    expect(suggestNumPredict(16384, false)).toBe(4096)
    expect(suggestNumPredict(32768, false)).toBe(8192)
    expect(suggestNumPredict(131_072, false)).toBe(8192)
    expect(suggestNumPredict(4096, true)).toBe(2048)
    expect(suggestNumPredict(32768, true)).toBe(16384)
    expect(suggestNumPredict(131_072, true)).toBe(16384)
  })

  it('mai oltre metà della memoria', () => {
    expect(suggestNumPredict(2048, false)).toBe(1024)
    expect(suggestNumPredict(2048, true)).toBe(1024)
    expect(suggestNumPredict(512, false)).toBe(256)
  })

  it('numPredictSteps: potenze di 2 da 256 a metà della memoria', () => {
    expect(numPredictSteps(4096)).toEqual([256, 512, 1024, 2048])
    expect(numPredictSteps(256)).toEqual([256])
  })

  it('followNumPredict: segue il suggerimento solo se era quello suggerito', () => {
    const c = big(131_072)
    // era il suggerito per 8k senza ragionamento (2048): con 32k diventa 8192
    expect(followNumPredict({ numCtx: 8192, numPredict: 2048, think: false }, { numCtx: 32768, think: false }, c)).toBe(8192)
    // ragionamento acceso su modello che lo supporta: raddoppia
    expect(followNumPredict({ numCtx: 8192, numPredict: 2048, think: false }, { numCtx: 8192, think: true }, { ...c, thinking: true })).toBe(4096)
    // modello senza ragionamento: l'interruttore non conta
    expect(followNumPredict({ numCtx: 8192, numPredict: 2048, think: false }, { numCtx: 8192, think: true }, c)).toBeNull()
    // valore scelto dall'utente: resta
    expect(followNumPredict({ numCtx: 8192, numPredict: 512, think: false }, { numCtx: 32768, think: false }, c)).toBeNull()
    // niente cambia
    expect(followNumPredict({ numCtx: 8192, numPredict: 2048, think: false }, { numCtx: 8192, think: false }, c)).toBeNull()
    expect(followNumPredict({ numCtx: 8192, numPredict: null, think: false }, { numCtx: 32768, think: false }, c)).toBeNull()
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
    expect(resolveSettings(conv, caps)).toEqual({ temperature: 0.7, topP: 0.95, numCtx: 2048, numPredict: 1024, seed: null, think: true })
    // num_predict configurato, ma mai oltre metà della memoria
    expect(resolveSettings({ ...conv, numPredict: 512 }, caps).numPredict).toBe(512)
    expect(resolveSettings({ ...conv, numPredict: 4096 }, caps).numPredict).toBe(1024)
    expect(resolveSettings(conv, bare).think).toBe(false)
    expect(resolveSettings({ ...conv, think: false }, caps).think).toBe(false)
  })
})
