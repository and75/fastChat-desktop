import { describe, expect, it } from 'vitest'
import { autoSource, resolveNumCtx, resolveSettings, resolveTopP } from '../src/shared/settings'
import type { ConversationSettings, ModelCapabilities } from '../src/shared/types'

const caps: ModelCapabilities = {
  capabilities: ['completion', 'thinking'],
  thinking: true,
  contextLength: 8192,
  defaults: { temperature: 0.6, topP: 0.95, numCtx: 2048 }
}
const bare: ModelCapabilities = { capabilities: [], thinking: false, contextLength: null, defaults: { temperature: null, topP: null, numCtx: null } }
const conv: ConversationSettings = { temperature: 0.7, think: true, planMode: false, topP: null, numCtx: null, seed: null }

describe('parametri effettivi (ciò che l\'utente vede = ciò che va a Ollama)', () => {
  it('num_ctx: scelta, poi consigliato dal modello, poi predefinito di Ollama', () => {
    expect(resolveNumCtx({ numCtx: 3000 }, caps)).toBe(3000)
    expect(resolveNumCtx({ numCtx: null }, caps)).toBe(2048)
    expect(resolveNumCtx({ numCtx: null }, bare)).toBe(4096)
    expect(resolveNumCtx({ numCtx: null }, null)).toBe(4096)
  })

  it('num_ctx non supera mai il contesto massimo del modello', () => {
    expect(resolveNumCtx({ numCtx: 65536 }, caps)).toBe(8192)
    expect(resolveNumCtx({ numCtx: null }, { ...caps, defaults: { ...caps.defaults, numCtx: 100_000 } })).toBe(8192)
    // massimo ignoto: nessun limite
    expect(resolveNumCtx({ numCtx: 65536 }, bare)).toBe(65536)
  })

  it('top_p: scelta, poi modello, poi Ollama', () => {
    expect(resolveTopP({ topP: 0.5 }, caps)).toBe(0.5)
    expect(resolveTopP({ topP: null }, caps)).toBe(0.95)
    expect(resolveTopP({ topP: null }, null)).toBe(0.9)
  })

  it('origine del valore automatico', () => {
    expect(autoSource(caps, 'numCtx')).toBe('model')
    expect(autoSource(bare, 'numCtx')).toBe('ollama')
    expect(autoSource(undefined, 'topP')).toBe('ollama')
  })

  it('think solo se il modello lo supporta', () => {
    expect(resolveSettings(conv, caps)).toEqual({ temperature: 0.7, topP: 0.95, numCtx: 2048, seed: null, think: true })
    expect(resolveSettings(conv, bare).think).toBe(false)
    expect(resolveSettings({ ...conv, think: false }, caps).think).toBe(false)
  })
})
