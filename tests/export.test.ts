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
  seed: null,
  style: 'normal',
  archived: false,
  autoSummary: true,
  summary: null,
  summaryUpTo: null,
  summaryUpdatedAt: null,
  longMemory: true,
  knowledge: true,
  knowledgeShare: 0.5,
  roleId: null,
  roleParams: null,
  mindOverrides: null,
  situation: null,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2)
}

const data: ExportData = {
  conversation: conv,
  messages: [
    { id: 'u1', conversationId: 'c1', role: 'user', content: 'Cos\'è 1/2?', thinking: null, model: null, evalCount: null, promptEvalCount: null, durationMs: null, doneReason: null, memoryRefs: null, knowledge: null, knowledgeRefs: null, createdAt: Date.UTC(2026, 0, 1, 10) },
    { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Metà.', thinking: 'Facile.', model: 'qwen3', evalCount: 3, promptEvalCount: 20, durationMs: 100, doneReason: 'stop', memoryRefs: null, knowledge: null, knowledgeRefs: null, createdAt: Date.UTC(2026, 0, 1, 10, 1) }
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

## Situazione

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

  it('Markdown: documenti della base di conoscenza, scelta sulla domanda e fonti della risposta', () => {
    const md = toMarkdown({
      ...data,
      documents: [
        { id: 'd1', baseId: 'b1', connectionId: null, source: 'text', title: 'Relazione', ref: { kind: 'file', path: '/doc/relazione.txt' }, version: null, hash: null, bytes: 10, chars: 10, status: 'ready', error: null, chunkCount: 1, pinned: false, createdAt: 0, indexedAt: 0 },
        { id: 'd2', baseId: 'b1', connectionId: null, source: 'text', title: 'Vuoto', ref: { kind: 'file', path: '/doc/vuoto.txt' }, version: null, hash: null, bytes: 0, chars: 0, status: 'error', error: 'x', chunkCount: 0, pinned: false, createdAt: 0, indexedAt: null }
      ],
      messages: [
        { ...data.messages[0], knowledge: true },
        { ...data.messages[1], knowledgeRefs: [{ documentId: 'd1', title: 'Relazione', locator: 'p. 2', score: 0.8, excerpt: '…' }] }
      ]
    })
    expect(md).toContain('## Base di conoscenza\n\n- Relazione (/doc/relazione.txt)\n- Vuoto (/doc/vuoto.txt) — error\n')
    expect(md).toContain('### Utente · 2026-01-01T10:00:00.000Z · Base di conoscenza: sì')
    expect(md).toContain('Metà.\n\nFonti:\n- Relazione, p. 2\n')
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

  it('con un ruolo: nome, scelte fatte e situazione', () => {
    const definition = {
      instructions: 'Sei un tutor.',
      parameters: [
        { id: 'livello', section: 'style' as const, label: 'Livello', type: 'single' as const, default: 'base', options: [{ id: 'base', label: 'Base' }, { id: 'avanzato', label: 'Avanzato' }] },
        { id: 'temi', section: 'rules' as const, label: 'Temi', type: 'multi' as const, default: [], options: [{ id: 'a', label: 'Algebra' }, { id: 'g', label: 'Geometria' }] }
      ]
    }
    const md = toMarkdown({ ...data, conversation: { ...conv, roleId: 'tutor', roleParams: { livello: 'avanzato' }, situation: 'Lezione di matematica' }, role: { name: 'Tutor', definition } })
    expect(md).toContain('## Ruolo\n\nTutor\n\n- Livello: Avanzato\n- Temi: —\n\n## Situazione\n\nLezione di matematica\n')
    // senza ruolo (Generalista) la sezione non c'è
    expect(toMarkdown(data)).not.toContain('## Ruolo\n\n')
  })
})
