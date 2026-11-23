import { describe, expect, it } from 'vitest'
import {
  describeSuggestion,
  floorPow2,
  minNumCtx,
  reserveTokensFor,
  resolveNumCtx,
  resolveSettings,
  resolveTopP,
  MEMORY_MARGIN_BYTES,
  MEMORY_SHARE,
  memoryBudget,
  ramNumCtx,
  reducedNumCtx,
  suggestionLowered,
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

  it('conti della memoria: utilizzabile (RAM × quota) − modello − modello di embedding − margine', () => {
    expect(MEMORY_SHARE).toEqual({ cpu: 1, unified: 2 / 3, shared: 1 / 2 })
    expect(MEMORY_MARGIN_BYTES).toBe(1.5 * GB)
    // PC con 32 GB: metà della RAM. 16 − 7,5 − 1,5 = 7 GB per il contesto
    expect(memoryBudget({ system: pc(32), modelBytes: 7.5 * GB, caps: bare })).toEqual({ kind: 'shared', usable: 16 * GB, embedding: 0, context: 7 * GB })
    // con il modello di embedding (1 GB) installato: 6 GB
    expect(memoryBudget({ system: pc(32), modelBytes: 7.5 * GB, caps: bare, embeddingBytes: 1 * GB })?.context).toBe(6 * GB)
    // Mac con memoria unificata: due terzi. 24 × ⅔ = 16 GB
    expect(memoryBudget({ system: mac(24), modelBytes: 5 * GB, caps: bare })).toMatchObject({ kind: 'unified', usable: 16 * GB, context: 9.5 * GB })
    // modello solo in CPU: tutta la RAM
    expect(memoryBudget({ system: pc(32), modelBytes: 7.5 * GB, caps: bare, cpuOnly: true })).toMatchObject({ kind: 'cpu', usable: 32 * GB, context: 23 * GB })
  })

  it('token che stanno in memoria: byte ÷ costo per token, potenza di 2 inferiore', () => {
    // 7 GB ÷ 128 KiB = 57k → 32.768
    expect(ramNumCtx({ system: pc(32), modelBytes: 7.5 * GB, caps: big(262_144) })).toBe(32768)
    // costo per token dichiarato dal modello (64 KiB): 114k → 65.536
    expect(ramNumCtx({ system: pc(32), modelBytes: 7.5 * GB, caps: big(262_144, 64 * 1024) })).toBe(65536)
    // cache KV quantizzata: ogni token costa meno. q8_0 (×0,53) → 107k → 65.536; q4_0 (×0,28) → 203k → 131.072
    expect(ramNumCtx({ system: { ...pc(32), kvCacheType: 'q8_0' }, modelBytes: 7.5 * GB, caps: big(262_144) })).toBe(65536)
    expect(ramNumCtx({ system: { ...pc(32), kvCacheType: 'q4_0' }, modelBytes: 7.5 * GB, caps: big(262_144) })).toBe(131_072)
    // il modello non lascia spazio: nulla
    expect(ramNumCtx({ system: pc(8), modelBytes: 5 * GB, caps: big(8192) })).toBe(0)
  })

  it('il caso che faceva fallire il caricamento: 12B con un milione di token dichiarati, GPU a memoria condivisa', () => {
    // MN-12B: 7,5 GB di pesi, 160 KiB per token, contesto massimo dichiarato 1.024.000
    const nemo = big(1_024_000, 163_840)
    // prima: (32 − 7,5) GB ÷ 160 KiB → 131.072 token (20 GB di solo contesto). Ora: 7 GB → 44k → 32.768
    expect(suggestNumCtx({ system: pc(32), modelBytes: 7.5 * GB, caps: nemo })).toBe(32768)
    // con il modello di embedding in memoria (1,2 GB): 5,8 GB → 37k → 32.768; su 16 GB di RAM non resta spazio → minimo
    expect(suggestNumCtx({ system: pc(32), modelBytes: 7.5 * GB, caps: nemo, embeddingBytes: 1.2 * GB })).toBe(32768)
    expect(suggestNumCtx({ system: pc(16), modelBytes: 7.5 * GB, caps: nemo })).toBe(4096)
    // il massimo dichiarato dal modello non conta più: decide la memoria
    expect(suggestNumCtx({ system: pc(32), modelBytes: 7.5 * GB, caps: big(131_072, 163_840) })).toBe(32768)
  })

  it('tra il minimo e il massimo del modello', () => {
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: big(8192) })).toBe(8192)
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: big(262_144) })).toBe(262_144)
    // modello più grande della memoria utilizzabile: mai sotto il minimo del modello (predefinito di Ollama)
    expect(suggestNumCtx({ system: mac(2), modelBytes: 3 * GB, caps: big(8192) })).toBe(4096)
    expect(suggestNumCtx({ system: mac(2), modelBytes: 3 * GB, caps: { ...big(8192), defaults: { ...big(8192).defaults, numCtx: 8192 } } })).toBe(8192)
    // massimo ignoto: 32k
    expect(suggestNumCtx({ system: mac(128), modelBytes: 5 * GB, caps: bare })).toBe(32768)
  })

  it('dopo un caricamento fallito per memoria insufficiente il suggerimento resta sotto quel valore', () => {
    const input = { system: pc(32), modelBytes: 7.5 * GB, caps: big(1_024_000, 163_840) }
    expect(suggestNumCtx({ ...input, failedNumCtx: 32768 })).toBe(16384)
    expect(suggestionLowered({ ...input, failedNumCtx: 32768 })).toBe(true)
    // un fallimento con una memoria più grande di quella suggerita non cambia nulla
    expect(suggestNumCtx({ ...input, failedNumCtx: 131_072 })).toBe(32768)
    expect(suggestionLowered({ ...input, failedNumCtx: 131_072 })).toBe(false)
    // fallito già al minimo: si resta al minimo
    expect(suggestNumCtx({ ...input, failedNumCtx: 2048 })).toBe(2048)
  })

  it('senza RAM (Ollama remoto) o senza dimensione del modello: nessun suggerimento', () => {
    expect(suggestNumCtx({ system: { ramBytes: null, unified: false, kvCacheType: 'f16' }, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: null, modelBytes: 5 * GB, caps })).toBeNull()
    expect(suggestNumCtx({ system: mac(16), modelBytes: null, caps })).toBeNull()
  })

  it('describeSuggestion: i conti in chiaro', () => {
    expect(describeSuggestion({ system: pc(32), modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di memoria utilizzabile (metà di 32 GB di RAM), meno il modello (5 GB) e 1,5 GB di margine.')
    expect(describeSuggestion({ system: mac(24), modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di memoria utilizzabile (due terzi di 24 GB di RAM unificata), meno il modello (5 GB) e 1,5 GB di margine.')
    expect(describeSuggestion({ system: pc(32), modelBytes: 5 * GB, caps, cpuOnly: true, embeddingBytes: 0.6 * GB })).toBe(
      'Calcolato su 32 GB di memoria utilizzabile (tutta la RAM: il modello gira in CPU), meno il modello (5 GB), il modello di embedding (0,6 GB) e 1,5 GB di margine.'
    )
    expect(describeSuggestion({ system: { ...pc(32), kvCacheType: 'q8_0' }, modelBytes: 5 * GB, caps })).toBe('Calcolato su 16 GB di memoria utilizzabile (metà di 32 GB di RAM), meno il modello (5 GB) e 1,5 GB di margine, con cache KV q8_0.')
    // suggerimento abbassato da un caricamento fallito: lo si dice
    expect(describeSuggestion({ system: pc(32), modelBytes: 7.5 * GB, caps: big(1_024_000, 163_840), failedNumCtx: 32768 })).toMatch(/margine\. Ridotto: con 32\.768 token il caricamento del modello è fallito per memoria insufficiente\.$/)
    expect(describeSuggestion({ system: { ramBytes: null, unified: false, kvCacheType: 'f16' }, modelBytes: 5 * GB, caps })).toMatch(/non è su questa macchina/)
  })
})

describe('dopo «memoria insufficiente»: memoria con cui riprovare', () => {
  it('la metà (potenza di 2), mai sotto 2.048; null se è già al minimo', () => {
    expect(reducedNumCtx(131_072)).toBe(65536)
    expect(reducedNumCtx(8192)).toBe(4096)
    expect(reducedNumCtx(6000)).toBe(2048)
    expect(reducedNumCtx(3000)).toBe(2048)
    expect(reducedNumCtx(2048)).toBeNull()
    expect(reducedNumCtx(1024)).toBeNull()
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
