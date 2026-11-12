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
