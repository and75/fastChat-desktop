// Composizione del contesto: l'ordine dei blocchi è uno solo (ruolo, situazione, riassunto, memoria, tecniche,
// esempi, documenti, regole scelte, stile, piano, promemoria, domanda), ogni blocco ha il suo titolo, e i tre
// ordini (A, B, C) scelgono soltanto quanti blocchi stanno nel messaggio di sistema.
import { describe, expect, it } from 'vitest'
import { composeChat } from '../src/main/chat'
import { buildStyleSection, demoteHeadings, executeSection, planSection, situationSection } from '../src/shared/prompt'
import { GENERALIST_ROLE, rolePrompt, roleReminderText, type Role } from '../src/shared/roles'
import { buildBehaviorSection, buildExamplesSection, buildKnowledgeSection } from '../src/shared/knowledge'
import { buildMemorySection } from '../src/shared/memory'
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

const MEMORY = '# Messaggi precedenti\n[1] numeratore sopra'
const KNOWLEDGE = '# Base di conoscenza\n[manuale, p. 2] Tre quarti sono 0,75.'
// Il Generalista con un Brief non convertito: i quattro campi sono la situazione, con i titoli scesi di un livello.
const BASE = '# Situazione\n## Ruolo\nSei un tutor\n\n## Contesto\nLezione di matematica\n\n## Obiettivi\nFar capire le frazioni\n\n## Vincoli\nSolo italiano'
const SUMMARY = '# Riassunto della conversazione finora\nAbbiamo parlato di numeratore e denominatore.'
const STYLE = buildStyleSection('concise')
/** L'apertura del prompt di una conversazione: ruolo (qui assente) e situazione. Lo stile non ne fa parte. */
const head = (c: Conversation): string => rolePrompt(GENERALIST_ROLE, c).system

describe('composizione con l\'ordine A: tutti i blocchi nel messaggio di sistema', () => {
  it('situazione, riassunto, memoria, documenti e stile nel system prompt, in quest\'ordine; poi i messaggi non riassunti', () => {
    const base = head(conv)
    expect(base).toBe(BASE)
    expect(STYLE.startsWith('# Stile della risposta\n')).toBe(true)
    const { messages, parts, dropped } = composeChat(conv, history, base, null, { memory: MEMORY, memoryCount: 1, knowledge: KNOWLEDGE, knowledgeCount: 1 })
    expect(messages).toEqual([
      { role: 'system', content: [base, SUMMARY, MEMORY, KNOWLEDGE, STYLE].join('\n\n') },
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

  it('senza estratti: system = situazione + riassunto + stile; riassunto non allineato: tutto lo storico, senza riassunto', () => {
    const base = head(conv)
    expect(composeChat(conv, history, base).messages[0]).toEqual({ role: 'system', content: [base, SUMMARY, STYLE].join('\n\n') })
    const stale = composeChat({ ...conv, summaryUpTo: 'eliminato' }, history, base)
    expect(stale.messages[0]).toEqual({ role: 'system', content: [base, STYLE].join('\n\n') })
    expect(stale.messages).toHaveLength(6)
  })

  it('senza situazione, stile né estratti non c\'è messaggio system; con i soli documenti il system è la loro sezione', () => {
    const empty = { ...conv, role: '', context: '', goals: '', constraints: '', style: 'normal', summary: null, summaryUpTo: null } as Conversation
    expect(head(empty)).toBe('')
    expect(composeChat(empty, history, head(empty)).messages[0]).toEqual({ role: 'user', content: 'ciao' })
    expect(composeChat(empty, history, '', null, { knowledge: KNOWLEDGE }).messages[0]).toEqual({ role: 'system', content: KNOWLEDGE })
  })

  it('piano ed esecuzione: il blocco del piano è l\'ultimo, dopo riassunto, estratti e stile', () => {
    const base = head(conv)
    const plan = planSection()
    expect(plan.startsWith('# Modalità piano\n')).toBe(true)
    expect(plan).toContain('- Il piano deve rispettare tutto ciò che precede.')
    expect(composeChat(conv, history, base, null, { knowledge: KNOWLEDGE }, { order: 'A', reminder: false, plan }).messages[0].content).toBe([base, SUMMARY, KNOWLEDGE, STYLE, plan].join('\n\n'))
    const exec = executeSection([{ title: 'Definisci', detail: '' }])
    expect(exec.startsWith('# Piano approvato\n')).toBe(true)
    expect(exec).toContain('1. Definisci')
    expect(composeChat(conv, history, base, null, {}, { order: 'A', reminder: false, plan: exec }).messages[0].content).toBe([base, SUMMARY, STYLE, exec].join('\n\n'))
  })
})

// ------------------------------------------------------------------ ordini B e C, promemoria
import { composeMessages, normalizeContextSettings, readSecondsOf, resolveContext, roleReminder, validateContextSettings } from '../src/shared/compose'
import { DEFAULT_CONTEXT_SETTINGS } from '../src/shared/types'

describe('ordini del contesto', () => {
  const base = head(conv)
  const extras = { memory: MEMORY, memoryCount: 1, knowledge: KNOWLEDGE, knowledgeCount: 1 }
  const REMINDER = '# Promemoria\nSei un tutor'

  it('B: il system prompt è fisso (situazione + riassunto); memoria, documenti e stile viaggiano con la domanda, in un solo messaggio', () => {
    const { messages, parts } = composeChat(conv, history, base, null, extras, { order: 'B', reminder: false })
    expect(messages).toEqual([
      { role: 'system', content: [base, SUMMARY].join('\n\n') },
      { role: 'user', content: 'cos\'è 1/2?' },
      { role: 'assistant', content: 'La metà.' },
      { role: 'user', content: [MEMORY, KNOWLEDGE, STYLE, '# Domanda\ne 3/4?'].join('\n\n') }
    ])
    // le voci del monitor sono le stesse dell'ordine A: la posizione non cambia i token
    expect(parts).toEqual(composeChat(conv, history, base, null, extras).parts)
  })

  it('C: nessun messaggio di sistema; tutti i blocchi, nella stessa sequenza, viaggiano con la domanda', () => {
    const { messages, parts } = composeChat(conv, history, base, null, extras, { order: 'C', reminder: false })
    expect(messages).toEqual([
      { role: 'user', content: 'cos\'è 1/2?' },
      { role: 'assistant', content: 'La metà.' },
      { role: 'user', content: [base, SUMMARY, MEMORY, KNOWLEDGE, STYLE, '# Domanda\ne 3/4?'].join('\n\n') }
    ])
    expect(parts).toEqual(composeChat(conv, history, base, null, extras).parts)
  })

  it('stesso contenuto nei tre ordini; mai due messaggi utente di seguito; il promemoria con C non si applica', () => {
    for (const order of ['A', 'B', 'C'] as const) {
      // come fa la chat: l'impostazione «promemoria acceso» passa da resolveContext, che con C lo spegne
      const { reminder } = resolveContext({ ...DEFAULT_CONTEXT_SETTINGS, order, reminder: 'on' })
      const { messages } = composeChat(conv, history, base, null, extras, { order, reminder })
      const all = messages.map((m) => m.content).join('\n')
      for (const piece of ['Sei un tutor', 'Lezione di matematica', 'Far capire le frazioni', 'Solo italiano', SUMMARY, MEMORY, KNOWLEDGE, STYLE, 'e 3/4?']) expect(all).toContain(piece)
      expect(all.includes(REMINDER)).toBe(order !== 'C')
      messages.forEach((m, i) => expect(i > 0 && m.role === 'user' && messages[i - 1].role === 'user').toBe(false))
      expect(messages.filter((m) => m.role === 'system')).toHaveLength(order === 'C' ? 0 : 1)
    }
  })

  it('promemoria: una riga dal ruolo sotto il suo titolo, accanto alla domanda; assente se il ruolo è vuoto; ha la sua voce nel monitor', () => {
    expect(roleReminder('Sei un tutor\nseconda riga')).toBe(REMINDER)
    expect(roleReminder('')).toBe('')
    expect(roleReminder('x '.repeat(300)).length).toBeLessThan(280)
    const a = composeChat(conv, history, base, null, extras, { order: 'A', reminder: true })
    expect(a.messages[0].content).toBe([base, SUMMARY, MEMORY, KNOWLEDGE, STYLE].join('\n\n'))
    expect(a.messages.at(-1)!.content).toBe(`${REMINDER}\n\n# Domanda\ne 3/4?`)
    expect(a.parts.map((p) => p.key)).toEqual(['instructions', 'style', 'summary', 'memory', 'knowledge', 'reminder', 'history', 'question'])
    const b = composeChat(conv, history, base, null, extras, { order: 'B', reminder: true })
    expect(b.messages.at(-1)!.content).toBe([MEMORY, KNOWLEDGE, STYLE, REMINDER, '# Domanda\ne 3/4?'].join('\n\n'))
    // ruolo vuoto: nessun promemoria; con la domanda resta solo lo stile
    const none = composeChat({ ...conv, role: '' } as Conversation, history, base, null, {}, { order: 'B', reminder: true })
    expect(none.messages.at(-1)!.content).toBe(`${STYLE}\n\n# Domanda\ne 3/4?`)
  })

  it('senza nulla da accompagnare la domanda resta com\'è, senza titolo; senza domanda il materiale torna nel system prompt', () => {
    const plain = { ...conv, style: 'normal' } as Conversation
    expect(composeChat(plain, history, base, null, {}, { order: 'B', reminder: false }).messages.at(-1)).toEqual({ role: 'user', content: 'e 3/4?' })
    // ordine A senza promemoria: la domanda è sola nel suo messaggio, il confine del messaggio la delimita già
    expect(composeChat(conv, history, base, null, extras, { order: 'A', reminder: false }).messages.at(-1)).toEqual({ role: 'user', content: 'e 3/4?' })
    const limits = { maxMessages: 10, maxTokens: 4096, reserveTokens: 1024 }
    const only = composeMessages({ order: 'B', base: 'BASE', blocks: [{ key: 'knowledge', text: KNOWLEDGE }], history: [{ role: 'assistant', content: 'x' }], limits })
    expect(only.messages).toEqual([{ role: 'system', content: `BASE\n\n${KNOWLEDGE}` }, { role: 'assistant', content: 'x' }])
    const onlyC = composeMessages({ order: 'C', base: 'BASE', summary: 'già detto', blocks: [{ key: 'knowledge', text: KNOWLEDGE }], history: [{ role: 'assistant', content: 'x' }], limits })
    expect(onlyC.messages).toEqual([{ role: 'system', content: `BASE\n\n# Riassunto della conversazione finora\ngià detto\n\n${KNOWLEDGE}` }, { role: 'assistant', content: 'x' }])
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
  it('ordine B: i blocchi fermi in testa alla sequenza restano nel sistema; si taglia al primo che cambia', () => {
    const history = [{ role: 'user' as const, content: 'domanda' }]
    const limits = { maxMessages: 50, maxTokens: 8192, reserveTokens: 1000 }
    const compose = (blocks: Parameters<typeof composeMessages>[0]['blocks']) => composeMessages({ order: 'B', base: 'RUOLO', blocks, history, limits })
    // tecniche ferme, estratti che cambiano: le tecniche nel sistema, il resto con la domanda
    const mixed = compose([{ key: 'behavior', text: 'TECNICHE', stable: true }, { key: 'knowledge', text: 'ESTRATTI' }, { key: 'rules', text: 'REGOLE' }])
    expect(mixed.system).toBe('RUOLO\n\nTECNICHE')
    expect(mixed.attached).toBe('ESTRATTI\n\nREGOLE')
    // un blocco che cambia prima di uno fermo: la sequenza non si rompe, il fermo viaggia con la domanda
    const memoryFirst = compose([{ key: 'memory', text: 'MEMORIA' }, { key: 'behavior', text: 'TECNICHE', stable: true }])
    expect(memoryFirst.system).toBe('RUOLO')
    expect(memoryFirst.attached).toBe('MEMORIA\n\nTECNICHE')
    // un blocco vuoto non interrompe; senza indicazione un blocco viaggia con la domanda, come prima
    expect(compose([{ key: 'memory', text: '' }, { key: 'behavior', text: 'TECNICHE', stable: true }, { key: 'knowledge', text: 'INTERI', stable: true }]).system).toBe('RUOLO\n\nTECNICHE\n\nINTERI')
    expect(compose([{ key: 'behavior', text: 'TECNICHE' }]).system).toBe('RUOLO')
    // A e C non cambiano: tutto nel sistema, oppure tutto con la domanda
    const blocks = [{ key: 'behavior' as const, text: 'TECNICHE', stable: true }, { key: 'knowledge' as const, text: 'ESTRATTI' }]
    expect(composeMessages({ order: 'A', base: 'RUOLO', blocks, history, limits }).system).toBe('RUOLO\n\nTECNICHE\n\nESTRATTI')
    expect(composeMessages({ order: 'C', base: 'RUOLO', blocks, history, limits }).system).toBe('')
  })

  it('predefinito: automatico, cioè il comportamento storico (ordine A, niente promemoria)', () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({ order: 'auto', reminder: 'auto', shares: { behavior: 0.2, examples: 0.2, documents: 0.6 }, situationShare: 0.05, readSeconds: 30 })
    // tempo massimo di lettura dei documenti: 30 secondi se l'impostazione manca (salvata da una versione precedente)
    expect(readSecondsOf(null)).toBe(30)
    expect(readSecondsOf({ ...DEFAULT_CONTEXT_SETTINGS, readSeconds: 0 })).toBe(0)
    expect(normalizeContextSettings({ order: 'B' }).readSeconds).toBe(30)
    expect(normalizeContextSettings({ readSeconds: 45 }).readSeconds).toBe(30)
    expect(normalizeContextSettings({ readSeconds: 120 }).readSeconds).toBe(120)
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
    expect(validateContextSettings({ order: 'B', reminder: 'on', shares: { behavior: 0.25, examples: 0.25, documents: 0.5 }, situationShare: 0.1, readSeconds: 60 })).toEqual({ order: 'B', reminder: 'on', shares: { behavior: 0.25, examples: 0.25, documents: 0.5 }, situationShare: 0.1, readSeconds: 60 })
    expect(() => validateContextSettings({ readSeconds: 45 })).toThrow(/Tempo di lettura/)
    expect(() => validateContextSettings({ order: 'D' })).toThrow(/Ordine del contesto/)
    expect(() => validateContextSettings({ reminder: 'forse' })).toThrow(/promemoria/)
    expect(() => validateContextSettings({ shares: { behavior: 0.5, examples: 0.5, documents: 0.5 } })).toThrow(/sommare a 100/)
    expect(() => validateContextSettings({ situationShare: 0.5 })).toThrow(/tra 1 e 25/)
  })
})

// ------------------------------------------------------------------ posto «sistema» del modello
import { detectSystemSlot } from '../src/shared/compose'

describe('posto «sistema» del modello, dal template di Ollama', () => {
  it('dedicato: turno di sistema con i suoi marcatori (Llama 3, ChatML)', () => {
    const llama3 = '{{- if .System }}<|start_header_id|>system<|end_header_id|>\n\n{{ .System }}<|eot_id|>{{ end }}{{- range .Messages }}<|start_header_id|>{{ .Role }}<|end_header_id|>\n\n{{ .Content }}<|eot_id|>{{ end }}'
    const chatml = '{{- if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n'
    expect(detectSystemSlot(llama3)).toBe('dedicated')
    expect(detectSystemSlot(chatml)).toBe('dedicated')
  })

  it('fuso: il testo di sistema finisce nel turno dell\'utente (Gemma 3, Mistral con [INST])', () => {
    const gemma3 = '{{- range $i, $_ := .Messages }}{{- if or (eq .Role "user") (eq .Role "system") }}<start_of_turn>user\n{{ .Content }}<end_of_turn>\n{{ end }}{{- if eq .Role "assistant" }}<start_of_turn>model\n{{ .Content }}<end_of_turn>\n{{ end }}{{- end }}<start_of_turn>model\n'
    const gemma2 = '<start_of_turn>user\n{{ if .System }}{{ .System }} {{ end }}{{ .Prompt }}<end_of_turn>\n<start_of_turn>model\n'
    const mistral = '[INST] {{ if .System }}{{ .System }} {{ end }}{{ .Prompt }} [/INST]'
    expect(detectSystemSlot(gemma3)).toBe('merged')
    expect(detectSystemSlot(gemma2)).toBe('merged')
    expect(detectSystemSlot(mistral)).toBe('merged')
  })

  it('non determinabile: formattatore interno di Ollama (gemma4), template assente o sconosciuto', () => {
    const modelfile = 'FROM blob\nTEMPLATE {{ .Prompt }}\nRENDERER gemma4\nPARSER gemma4\nPARAMETER temperature 1\n'
    expect(detectSystemSlot('{{ .Prompt }}', modelfile)).toBe('unknown')
    expect(detectSystemSlot('{{ .Prompt }}')).toBe('unknown')
    expect(detectSystemSlot('<|im_start|>system\n{{ .System }}', modelfile)).toBe('unknown')
    expect(detectSystemSlot(undefined)).toBe('unknown')
    expect(detectSystemSlot('{{ .Prompt }} qualcosa')).toBe('unknown')
  })
})

// ------------------------------------------------------------------ l'ordine fisso dei blocchi
import { BLOCK_SEQUENCE } from '../src/shared/compose'

describe('ordine fisso dei blocchi: stessa sequenza e stessi titoli in ogni ordine del contesto', () => {
  const role: Role = {
    instructions: 'Sei un tutor di matematica.',
    reminder: 'Resta un tutor paziente.',
    parameters: [
      { id: 'tono', section: 'style', label: 'Tono', type: 'single', default: 'breve', options: [{ id: 'breve', label: 'Breve', instruction: 'Rispondi in breve.' }] },
      { id: 'tecniche', section: 'rules', label: 'Tecniche', type: 'multi', default: ['passi'], options: [{ id: 'passi', label: 'Passi', instruction: 'Procedi per passi.' }] }
    ]
  }
  // la situazione dell'utente ha titoli suoi; un esempio contiene titoli dentro un blocco di codice
  const withRole = { ...conv, role: '', context: '', goals: '', constraints: '', situation: '# Chi sono\nUno studente.\n\n## Cosa studio\nLe frazioni.', style: 'extended' } as Conversation
  const extras = {
    memory: buildMemorySection([{ text: 'Utente: numeratore sopra', role: 'user', position: 1 }], 4),
    behavior: buildBehaviorSection([{ title: 'Tecniche', locator: 'Tecniche › Spiegare', text: 'Parti da un esempio concreto.', documentId: 'd1' }]),
    examples: buildExamplesSection([{ title: 'Esempi', locator: 'Esempi › Una frazione', text: 'Richiesta: cos\'è 1/2?\n\nRisposta:\n```\n# Identità\nLa metà.\n```', documentId: 'd2' }]),
    knowledge: buildKnowledgeSection([{ title: 'manuale', locator: 'p. 2', text: 'Tre quarti sono 0,75.', documentId: 'd3', whole: true }])
  }
  /** I titoli di primo livello (fuori dai blocchi di codice) di ciò che è partito, saltando lo storico. */
  const titles = (messages: Array<{ role: string; content: string }>): string[] => {
    const sent = [...messages.filter((m) => m.role === 'system'), messages.at(-1)!]
    let fenced = false
    return sent
      .flatMap((m) => m.content.split('\n'))
      .filter((line) => {
        if (/^\s*```/.test(line)) fenced = !fenced
        return !fenced && /^# /.test(line)
      })
  }
  const ALL = [
    '# Ruolo',
    '# Situazione',
    '# Riassunto della conversazione finora',
    '# Messaggi precedenti',
    '# Come lavorare',
    '# Esempi',
    '# Base di conoscenza',
    '# Regole di questa conversazione',
    '# Stile della risposta',
    '# Modalità piano',
    '# Promemoria',
    '# Domanda'
  ]

  it('dodici blocchi, un titolo ciascuno, sempre nello stesso ordine', () => {
    expect(BLOCK_SEQUENCE).toEqual(['instructions', 'situation', 'summary', 'memory', 'behavior', 'examples', 'knowledge', 'rules', 'style', 'plan', 'reminder', 'question'])
    expect(ALL).toHaveLength(BLOCK_SEQUENCE.length)
    const { system, rules } = rolePrompt(role, withRole)
    expect(system).toBe('# Ruolo\nSei un tutor di matematica.\n\n# Situazione\n## Chi sono\nUno studente.\n\n### Cosa studio\nLe frazioni.')
    expect(rules).toBe("# Regole di questa conversazione\nLe ha scelte l'utente per questa conversazione: applicale sempre.\n- Tono: Rispondi in breve.\n- Tecniche: Procedi per passi.")
    // ogni esempio ha sopra il suo titolo, come le tecniche
    expect(extras.examples).toContain('\n\n## Una frazione\n\n<esempio>\n')
    expect(extras.behavior).toContain('\n\n## Spiegare\n\n')
    for (const order of ['A', 'B', 'C'] as const) {
      const { reminder } = resolveContext({ ...DEFAULT_CONTEXT_SETTINGS, order, reminder: 'on' })
      const { messages } = composeChat(withRole, history, system, null, extras, { order, reminder, rules, plan: planSection(), reminderText: roleReminderText(role) })
      // con C il promemoria non si applica: tutto è già accanto alla domanda
      expect(titles(messages), order).toEqual(order === 'C' ? ALL.filter((t) => t !== '# Promemoria') : ALL)
      // dove viaggiano: A tutto nel sistema fino al piano; B ruolo, situazione e riassunto; C niente
      const inSystem = titles(messages.filter((m) => m.role === 'system').concat({ role: 'user', content: '' }))
      expect(inSystem, order).toEqual(order === 'A' ? ALL.slice(0, 10) : order === 'B' ? ALL.slice(0, 3) : [])
    }
  })

  it('piano approvato: stesso posto della richiesta di piano', () => {
    const { system, rules } = rolePrompt(role, withRole)
    const { messages } = composeChat(withRole, history, system, null, extras, { order: 'B', reminder: false, rules, plan: executeSection([{ title: 'Definisci', detail: '' }]) })
    expect(titles(messages)).toEqual(ALL.filter((t) => t !== '# Promemoria').map((t) => (t === '# Modalità piano' ? '# Piano approvato' : t)))
  })

  it('i titoli scritti dall\'utente scendono di un livello, fuori dai blocchi di codice', () => {
    expect(demoteHeadings('# Uno\ntesto\n## Due\n##### Cinque\n###### Sei\n#senza spazio')).toBe('## Uno\ntesto\n### Due\n###### Cinque\n###### Sei\n#senza spazio')
    expect(demoteHeadings('prima\n```md\n# dentro il codice\n```\n# fuori')).toBe('prima\n```md\n# dentro il codice\n```\n## fuori')
    expect(demoteHeadings('~~~\n# dentro\n~~~\n# fuori')).toBe('~~~\n# dentro\n~~~\n## fuori')
    // la situazione ha sempre il suo titolo, anche senza ruolo; vuota non lascia un titolo da solo
    expect(situationSection('  # Contesto\nLezione  ')).toBe('# Situazione\n## Contesto\nLezione')
    expect(situationSection('Testo semplice')).toBe('# Situazione\nTesto semplice')
    expect(situationSection('   ')).toBe('')
    expect(situationSection(null)).toBe('')
  })
})

// ------------------------------------------------------------------ disegno dell'ordine
import { orderLayout, reminderApplies } from '../src/shared/compose'

describe('disegno dell\'ordine e promemoria', () => {
  it('lo schema corrisponde a ciò che il compositore produce', () => {
    const opening = ['instructions', 'situation', 'summary']
    const rest = ['memory', 'behavior', 'examples', 'knowledge', 'rules', 'style', 'plan']
    expect(orderLayout('A', false)).toEqual({ system: [...opening, ...rest], conversation: ['history'], user: ['question'], reuse: 'none' })
    expect(orderLayout('A', true)).toEqual({ system: [...opening, ...rest], conversation: ['history'], user: ['reminder', 'question'], reuse: 'none' })
    expect(orderLayout('B', true)).toEqual({ system: opening, conversation: ['history'], user: [...rest, 'reminder', 'question'], reuse: 'previous' })
    // C: nessun blocco nel sistema, e nessun promemoria
    expect(orderLayout('C', true)).toEqual({ system: [], conversation: ['history'], user: [...opening, ...rest, 'question'], reuse: 'previous' })
    // in ogni ordine i blocchi, letti in fila, sono la sequenza fissa
    for (const order of ['A', 'B', 'C'] as const) {
      const l = orderLayout(order, true)
      expect([...l.system, ...l.user], order).toEqual(BLOCK_SEQUENCE.filter((b) => order !== 'C' || b !== 'reminder'))
    }
  })

  it('con l\'ordine C il promemoria non si applica: tutti i blocchi sono già accanto alla domanda', () => {
    expect(reminderApplies('A')).toBe(true)
    expect(reminderApplies('C')).toBe(false)
    expect(resolveContext({ ...DEFAULT_CONTEXT_SETTINGS, order: 'C', reminder: 'on' })).toMatchObject({ order: 'C', reminder: false })
    expect(resolveContext({ ...DEFAULT_CONTEXT_SETTINGS, order: 'A', reminder: 'on' })).toMatchObject({ order: 'A', reminder: true })
  })
})
