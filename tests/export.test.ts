import { describe, expect, it } from 'vitest'
import { suggestedFileName, toJson, toMarkdown, type ExportData } from '../src/main/export'
import type { Conversation } from '../src/shared/types'

const conv: Conversation = {
  id: 'c1',
  title: 'Frazioni',
  model: 'qwen3',
  role: 'Sei un tutor',
  context: '',
  goals: 'Spiegare',
  constraints: '',
  temperature: 0.4,
  think: true,
  planMode: true,
  topP: null,
  numCtx: null,
  numPredict: null,
  seed: null,
  archived: false,
  autoSummary: true,
  summary: null,
  summaryUpTo: null,
  summaryUpdatedAt: null,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2)
}

const data: ExportData = {
  conversation: conv,
  messages: [
    { id: 'u1', conversationId: 'c1', role: 'user', content: 'Cos\'è 1/2?', thinking: null, model: null, evalCount: null, promptEvalCount: null, durationMs: null, doneReason: null, createdAt: Date.UTC(2026, 0, 1, 10) },
    { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Metà.', thinking: 'Facile.', model: 'qwen3', evalCount: 3, promptEvalCount: 20, durationMs: 100, doneReason: 'stop', createdAt: Date.UTC(2026, 0, 1, 10, 1) }
  ],
  plans: [
    { id: 'p1', conversationId: 'c1', userMessageId: 'u1', steps: [{ title: 'Definire', detail: 'Breve' }], status: 'executed', createdAt: 0 }
  ]
}

describe('export', () => {
  it('Markdown: intestazione, brief, messaggi, piano e ragionamento', () => {
    const md = toMarkdown(data)
    expect(md).toBe(`# Frazioni

- Modello: qwen3
- Temperatura: 0.4
- Ragionamento: sì
- Plan mode: sì
- Creata: 2026-01-01T00:00:00.000Z
- Aggiornata: 2026-01-02T00:00:00.000Z

## Brief

### Ruolo
Sei un tutor

### Obiettivi
Spiegare

## Conversazione

### Utente · 2026-01-01T10:00:00.000Z

Cos'è 1/2?

#### Piano (eseguito)

1. Definire — Breve

### Assistente (qwen3) · 2026-01-01T10:01:00.000Z

<details>
<summary>Ragionamento</summary>

Facile.

</details>

Metà.
`)
  })

  it('JSON: dati completi e reimportabili', () => {
    const parsed = JSON.parse(toJson(data))
    expect(parsed).toMatchObject({ format: 'fastchat-conversation', version: 1, conversation: { id: 'c1' } })
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.plans[0].steps).toEqual([{ title: 'Definire', detail: 'Breve' }])
  })

  it('nome file ripulito', () => {
    expect(suggestedFileName('Domanda: a/b? <ok>', 'md')).toBe('Domanda ab ok.md')
    expect(suggestedFileName('   ', 'json')).toBe('conversazione.json')
  })
})
