// Composizione del contesto. La prima parte è la «fotografia» dei messaggi inviati oggi a Ollama: deve restare
// identica finché l'ordine è A (tutto nel system prompt), qualunque cosa cambi sotto.
import { describe, expect, it } from 'vitest'
import { composeChat } from '../src/main/chat'
import { buildExecutePrompt, buildPlanPrompt, buildSystemPrompt } from '../src/shared/prompt'
import type { Conversation, Message } from '../src/shared/types'

const conv = {
  id: 'c1',
  temperature: 0.3,
  topP: null,
  numCtx: 8192,
  seed: null,
  role: 'Sei un tutor',
  context: 'Lezione di matematica',
  goals: 'Far capire le frazioni',
  constraints: 'Solo italiano',
  style: 'concise',
  summary: 'Abbiamo parlato di numeratore e denominatore.',
  summaryUpTo: 'm2'
} as Conversation

const msg = (id: string, role: 'user' | 'assistant', content: string): Message => ({ id, role, content }) as Message
const history = [msg('m1', 'user', 'ciao'), msg('m2', 'assistant', 'salve'), msg('m3', 'user', 'cos\'è 1/2?'), msg('m4', 'assistant', 'La metà.'), msg('m5', 'user', 'e 3/4?')]

const MEMORY = '# Dalla conversazione\n[1] numeratore sopra'
const KNOWLEDGE = '# Base di conoscenza\n[manuale, p. 2] Tre quarti sono 0,75.'
const BASE = '# Ruolo\nSei un tutor\n\n# Contesto\nLezione di matematica\n\n# Obiettivi\nFar capire le frazioni\n\n# Vincoli\nSolo italiano\n\n# Stile della risposta\n'
const SUMMARY = '# Riassunto della conversazione finora\nAbbiamo parlato di numeratore e denominatore.'

describe('fotografia della composizione attuale (ordine A)', () => {
  it('brief, stile, riassunto, memoria e documenti nel system prompt; poi i messaggi non riassunti', () => {
    const base = buildSystemPrompt(conv, conv.style)
    expect(base.startsWith(BASE)).toBe(true)
    const { messages, parts, dropped } = composeChat(conv, history, base, null, { memory: MEMORY, memoryCount: 1, knowledge: KNOWLEDGE, knowledgeCount: 1 })
    expect(messages).toEqual([
      { role: 'system', content: [base, SUMMARY, MEMORY, KNOWLEDGE].join('\n\n') },
      { role: 'user', content: 'cos\'è 1/2?' },
      { role: 'assistant', content: 'La metà.' },
      { role: 'user', content: 'e 3/4?' }
    ])
    expect(dropped).toBe(0)
    expect(parts.map((p) => [p.key, p.count])).toEqual([
      ['instructions', undefined],
      ['style', undefined],
      ['summary', 2],
      ['memory', 1],
      ['knowledge', 1],
      ['history', 2],
      ['question', undefined]
    ])
  })

  it('senza estratti: system = brief + riassunto; riassunto non allineato: tutto lo storico, senza riassunto', () => {
    const base = buildSystemPrompt(conv, conv.style)
    expect(composeChat(conv, history, base).messages[0]).toEqual({ role: 'system', content: [base, SUMMARY].join('\n\n') })
    const stale = composeChat({ ...conv, summaryUpTo: 'eliminato' }, history, base)
    expect(stale.messages[0]).toEqual({ role: 'system', content: base })
    expect(stale.messages).toHaveLength(6)
  })

  it('senza brief né estratti non c\'è messaggio system; con i soli documenti il system è la loro sezione', () => {
    const empty = { ...conv, role: '', context: '', goals: '', constraints: '', style: 'normal', summary: null, summaryUpTo: null } as Conversation
    expect(composeChat(empty, history, buildSystemPrompt(empty, empty.style)).messages[0]).toEqual({ role: 'user', content: 'ciao' })
    expect(composeChat(empty, history, '', null, { knowledge: KNOWLEDGE }).messages[0]).toEqual({ role: 'system', content: KNOWLEDGE })
  })

  it('piano ed esecuzione: le istruzioni del piano seguono il brief, prima del riassunto e degli estratti', () => {
    const plan = buildPlanPrompt(conv, conv.style)
    expect(composeChat(conv, history, plan, null, { knowledge: KNOWLEDGE }).messages[0].content).toBe([plan, SUMMARY, KNOWLEDGE].join('\n\n'))
    const exec = buildExecutePrompt(conv, [{ title: 'Definisci', detail: '' }], conv.style)
    expect(exec).toContain('1. Definisci')
    expect(composeChat(conv, history, exec).messages[0].content).toBe([exec, SUMMARY].join('\n\n'))
  })
})

// ------------------------------------------------------------------ ordini B e C, promemoria
import { composeMessages, normalizeContextSettings, resolveContext, roleReminder, validateContextSettings } from '../src/shared/compose'
import { DEFAULT_CONTEXT_SETTINGS } from '../src/shared/types'

describe('ordini del contesto', () => {
  const base = buildSystemPrompt(conv, conv.style)
  const extras = { memory: MEMORY, memoryCount: 1, knowledge: KNOWLEDGE, knowledgeCount: 1 }
  const instructions = buildSystemPrompt({ ...conv, context: '' }, conv.style)
  const situation = '# Contesto\nLezione di matematica'
  const REMINDER = '[Promemoria del ruolo: Sei un tutor]'

  it('B: il system prompt è fisso (brief + riassunto); memoria e documenti viaggiano con la domanda, in un solo messaggio', () => {
    const { messages, parts } = composeChat(conv, history, base, null, extras, { order: 'B', reminder: false })
    expect(messages).toEqual([
      { role: 'system', content: [base, SUMMARY].join('\n\n') },
      { role: 'user', content: 'cos\'è 1/2?' },
      { role: 'assistant', content: 'La metà.' },
      { role: 'user', content: [MEMORY, KNOWLEDGE, '# Domanda\ne 3/4?'].join('\n\n') }
    ])
    // le voci del monitor sono le stesse dell'ordine A: la posizione non cambia i token
    expect(parts).toEqual(composeChat(conv, history, base, null, extras).parts)
  })

  it('C: nel system prompt restano situazione e riassunto; le istruzioni vanno con la domanda, prima degli estratti', () => {
    const { messages } = composeChat(conv, history, base, null, extras, { order: 'C', reminder: false, instructions, situation })
    expect(messages[0]).toEqual({ role: 'system', content: [situation, SUMMARY].join('\n\n') })
    expect(messages.at(-1)).toEqual({ role: 'user', content: [instructions, MEMORY, KNOWLEDGE, '# Domanda\ne 3/4?'].join('\n\n') })
    expect(instructions).not.toContain('Lezione di matematica')
  })

  it('stesso contenuto nei tre ordini; mai due messaggi utente di seguito', () => {
    for (const order of ['A', 'B', 'C'] as const) {
      const { messages } = composeChat(conv, history, base, null, extras, { order, reminder: true, instructions, situation })
      const all = messages.map((m) => m.content).join('\n')
      for (const piece of ['Sei un tutor', 'Lezione di matematica', 'Far capire le frazioni', 'Solo italiano', SUMMARY, MEMORY, KNOWLEDGE, REMINDER, 'e 3/4?']) expect(all).toContain(piece)
      messages.forEach((m, i) => expect(i > 0 && m.role === 'user' && messages[i - 1].role === 'user').toBe(false))
      expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
    }
  })

  it('promemoria: una riga dal ruolo, accanto alla domanda in ogni ordine; assente se il ruolo è vuoto; ha la sua voce nel monitor', () => {
    expect(roleReminder('Sei un tutor\nseconda riga')).toBe(REMINDER)
    expect(roleReminder('')).toBe('')
    expect(roleReminder('x '.repeat(300)).length).toBeLessThan(280)
    const a = composeChat(conv, history, base, null, extras, { order: 'A', reminder: true })
    expect(a.messages[0].content).toBe([base, SUMMARY, MEMORY, KNOWLEDGE].join('\n\n'))
    expect(a.messages.at(-1)!.content).toBe(`${REMINDER}\n\n# Domanda\ne 3/4?`)
    expect(a.parts.map((p) => p.key)).toEqual(['instructions', 'style', 'summary', 'memory', 'knowledge', 'reminder', 'history', 'question'])
    const b = composeChat(conv, history, base, null, extras, { order: 'B', reminder: true })
    expect(b.messages.at(-1)!.content).toBe([MEMORY, KNOWLEDGE, REMINDER, '# Domanda\ne 3/4?'].join('\n\n'))
    const none = composeChat({ ...conv, role: '' } as Conversation, history, base, null, {}, { order: 'B', reminder: true })
    expect(none.messages.at(-1)!.content).toBe('e 3/4?')
  })

  it('senza nulla da accompagnare la domanda resta com\'è; senza domanda il materiale torna nel system prompt', () => {
    expect(composeChat(conv, history, base, null, {}, { order: 'B', reminder: false }).messages.at(-1)).toEqual({ role: 'user', content: 'e 3/4?' })
    const only = composeMessages({ order: 'B', base: 'BASE', blocks: [{ key: 'knowledge', text: KNOWLEDGE }], history: [{ role: 'assistant', content: 'x' }], limits: { maxMessages: 10, maxTokens: 4096, reserveTokens: 1024 } })
    expect(only.messages).toEqual([{ role: 'system', content: `BASE\n\n${KNOWLEDGE}` }, { role: 'assistant', content: 'x' }])
  })

  it('riuso: con B, tra due domande il prefisso resta identico fino alla domanda precedente esclusa; con A cambia dal system prompt', () => {
    const next = [...history, msg('m6', 'assistant', 'Tre quarti.'), msg('m7', 'user', 'e 5/8?')]
    const other = { memory: '# Dalla conversazione\n[1] altro estratto', knowledge: '# Base di conoscenza\n[manuale, p. 3] Cinque ottavi sono 0,625.' }
    const common = (order: 'A' | 'B'): number => {
      const one = composeChat(conv, history, base, null, extras, { order, reminder: false }).messages
      const two = composeChat(conv, next, base, null, other, { order, reminder: false }).messages
      let i = 0
      while (i < one.length && i < two.length && one[i].content === two[i].content && one[i].role === two[i].role) i++
      return i
    }
    // A: già il system prompt è diverso (contiene gli estratti della domanda)
    expect(common('A')).toBe(0)
    // B: system prompt e scambi precedenti identici; cambia dalla domanda precedente (che non porta più gli estratti)
    expect(common('B')).toBe(3)
  })

  it('lo storico che entra tiene conto di ciò che viaggia con la domanda', () => {
    const big = (i: number): Message => msg(`b${i}`, i % 2 ? 'assistant' : 'user', 'x'.repeat(4000))
    const long = [big(0), big(1), big(2), big(3), big(4)]
    const plain = { ...conv, role: '', context: '', goals: '', constraints: '', style: 'normal', summary: null, summaryUpTo: null, numCtx: 4096 } as Conversation
    const heavy = { knowledge: `# Base di conoscenza\n${'y'.repeat(4000)}` }
    const a = composeChat(plain, long, '', null, heavy, { order: 'A', reminder: false })
    const b = composeChat(plain, long, '', null, heavy, { order: 'B', reminder: false })
    expect(b.messages.filter((m) => m.role !== 'system')).toHaveLength(a.messages.filter((m) => m.role !== 'system').length)
    expect(b.dropped).toBe(a.dropped)
  })
})

describe('impostazioni della composizione', () => {
  it('predefinito: automatico, cioè il comportamento storico (ordine A, niente promemoria)', () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({ order: 'auto', reminder: 'auto', shares: { behavior: 0.2, examples: 0.2, documents: 0.6 }, situationShare: 0.05 })
    expect(resolveContext(DEFAULT_CONTEXT_SETTINGS)).toEqual({ order: 'A', reminder: false, shares: DEFAULT_CONTEXT_SETTINGS.shares })
    expect(resolveContext(null)).toMatchObject({ order: 'A', reminder: false })
    expect(resolveContext({ ...DEFAULT_CONTEXT_SETTINGS, order: 'B', reminder: 'on' })).toMatchObject({ order: 'B', reminder: true })
  })

  it('lettura tollerante: ciò che manca o non vale torna al predefinito', () => {
    expect(normalizeContextSettings(undefined)).toEqual(DEFAULT_CONTEXT_SETTINGS)
    expect(normalizeContextSettings({ order: 'Z', reminder: 3, shares: { behavior: 0.5, examples: 0.5, documents: 0.5 }, situationShare: 9 })).toEqual(DEFAULT_CONTEXT_SETTINGS)
    expect(normalizeContextSettings({ order: 'C', shares: { behavior: 0.5, examples: 0, documents: 0.5 } })).toEqual({ ...DEFAULT_CONTEXT_SETTINGS, order: 'C', shares: { behavior: 0.5, examples: 0, documents: 0.5 } })
  })

  it('salvataggio severo: valori non ammessi sono un errore', () => {
    expect(validateContextSettings({ order: 'B', reminder: 'on', shares: { behavior: 0.25, examples: 0.25, documents: 0.5 }, situationShare: 0.1 })).toEqual({ order: 'B', reminder: 'on', shares: { behavior: 0.25, examples: 0.25, documents: 0.5 }, situationShare: 0.1 })
    expect(() => validateContextSettings({ order: 'D' })).toThrow(/Ordine del contesto/)
    expect(() => validateContextSettings({ reminder: 'forse' })).toThrow(/promemoria/)
    expect(() => validateContextSettings({ shares: { behavior: 0.5, examples: 0.5, documents: 0.5 } })).toThrow(/sommare a 100/)
    expect(() => validateContextSettings({ situationShare: 0.5 })).toThrow(/tra 1 e 25/)
  })
})
