import { describe, expect, it } from 'vitest'
import {
  buildExecutePrompt,
  buildPlanPrompt,
  buildSystemPrompt,
  charsPerToken,
  computeContextUsage,
  estimateTokens,
  formatTokensK,
  normalizeSteps,
  parsePlan,
  PLAN_SCHEMA,
  selectHistory,
  type HistoryMessage
} from '../src/shared/prompt'

const brief = (b: Partial<Record<'role' | 'context' | 'goals' | 'constraints', string>>) => ({
  role: '',
  context: '',
  goals: '',
  constraints: '',
  ...b
})

describe('buildSystemPrompt', () => {
  it('brief vuoto → stringa vuota', () => {
    expect(buildSystemPrompt(brief({}))).toBe('')
    expect(buildSystemPrompt(brief({ role: '   \n ' }))).toBe('')
  })

  it('omette le sezioni vuote', () => {
    expect(buildSystemPrompt(brief({ goals: 'Spiegare bene' }))).toBe('# Obiettivi\nSpiegare bene')
  })

  it('ordine fisso Ruolo, Contesto, Obiettivi, Vincoli, a prescindere dall\'input', () => {
    const out = buildSystemPrompt({
      constraints: 'Rispondi in italiano',
      goals: 'G',
      context: 'C',
      role: 'Sei un tutor'
    })
    expect(out).toBe('# Ruolo\nSei un tutor\n\n# Contesto\nC\n\n# Obiettivi\nG\n\n# Vincoli\nRispondi in italiano')
  })

  it('rimuove spazi ai bordi ma conserva il testo multilinea', () => {
    expect(buildSystemPrompt(brief({ context: '\n  riga 1\nriga 2  \n' }))).toBe('# Contesto\nriga 1\nriga 2')
  })
})

describe('selectHistory', () => {
  const msg = (role: 'user' | 'assistant', len: number, tag = ''): HistoryMessage => ({
    role,
    content: tag + 'x'.repeat(len - tag.length)
  })

  it('tutto lo storico se ci sta', () => {
    const h = [msg('user', 10), msg('assistant', 10), msg('user', 10)]
    expect(selectHistory(h, '')).toEqual(h)
  })

  it('limita il numero di messaggi tenendo i più recenti', () => {
    const h = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 5, String(i)))
    const out = selectHistory(h, '', { maxMessages: 4, maxTokens: 1e6, reserveTokens: 0 })
    expect(out.map((m) => m.content[0])).toEqual(['6', '7', '8', '9'])
  })

  it('il brief si sottrae dal budget e non viene mai troncato', () => {
    const h = [msg('user', 400, 'a'), msg('assistant', 400, 'b'), msg('user', 400, 'c')]
    const system = 'y'.repeat(400)
    // budget: 350 - 104 (brief) = 246 token → entrano 'c' e 'b' (104 ciascuno), non 'a';
    // poi la risposta 'b' resterebbe in testa senza la sua domanda e viene scartata.
    const out = selectHistory(h, system, { maxMessages: 50, maxTokens: 350, reserveTokens: 0 })
    expect(out.map((m) => m.content[0])).toEqual(['c'])
    // con budget sufficiente entra tutto
    const out2 = selectHistory(h, system, { maxMessages: 50, maxTokens: 450, reserveTokens: 0 })
    expect(out2.map((m) => m.content[0])).toEqual(['a', 'b', 'c'])
    // senza brief lo stesso budget di 350 basta per tutti e tre
    const out3 = selectHistory(h, '', { maxMessages: 50, maxTokens: 350, reserveTokens: 0 })
    expect(out3.map((m) => m.content[0])).toEqual(['a', 'b', 'c'])
  })

  it('l\'ultimo messaggio entra sempre, anche se fuori budget', () => {
    const out = selectHistory([msg('user', 10_000)], 'brief', { maxMessages: 50, maxTokens: 100, reserveTokens: 50 })
    expect(out).toHaveLength(1)
  })

  it('stima token ~ caratteri/4', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(104)
  })
})

describe('plan mode: prompt', () => {
  const b = brief({ role: 'Sei un tutor', constraints: 'Solo italiano' })
  const steps = [
    { title: 'Definire', detail: 'Spiegare il concetto.' },
    { title: 'Esempio', detail: '' }
  ]

  it('buildPlanPrompt: brief prima, poi le istruzioni del piano', () => {
    const out = buildPlanPrompt(b)
    expect(out.startsWith('# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano\n\n# Modalità piano\n')).toBe(true)
    expect(out).toContain('{"steps":[{"title":"…","detail":"…"}]}')
  })

  it('buildPlanPrompt senza brief: solo le istruzioni', () => {
    expect(buildPlanPrompt(brief({})).startsWith('# Modalità piano')).toBe(true)
  })

  it('buildExecutePrompt: inietta il piano numerato dopo il brief', () => {
    const out = buildExecutePrompt(b, steps)
    expect(out.startsWith('# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano\n\n# Piano approvato\n')).toBe(true)
    expect(out.endsWith('1. Definire — Spiegare il concetto.\n2. Esempio')).toBe(true)
  })

  it('lo schema JSON richiede steps con title e detail', () => {
    expect(PLAN_SCHEMA.required).toEqual(['steps'])
    expect(PLAN_SCHEMA.properties.steps.items.required).toEqual(['title', 'detail'])
  })
})

describe('plan mode: parsing e normalizzazione', () => {
  it('JSON valido', () => {
    expect(parsePlan('{"steps":[{"title":" A ","detail":" a "},{"title":"B","detail":"b"}]}')).toEqual([
      { title: 'A', detail: 'a' },
      { title: 'B', detail: 'b' }
    ])
  })

  it('JSON dentro un blocco di codice o testo, e array nudo', () => {
    expect(parsePlan('Ecco:\n```json\n{"steps":[{"title":"A","detail":""}]}\n```')).toEqual([{ title: 'A', detail: '' }])
    expect(parsePlan('[{"title":"A","detail":"x"}]')).toEqual([{ title: 'A', detail: 'x' }])
  })

  it('scarta passi senza titolo; errore se non resta niente o non è JSON', () => {
    expect(parsePlan('{"steps":[{"title":"","detail":"x"},{"title":"B"},42]}')).toEqual([{ title: 'B', detail: '' }])
    expect(() => parsePlan('{"steps":[]}')).toThrow('piano valido')
    expect(() => parsePlan('non è json')).toThrow('piano valido')
    expect(() => parsePlan('{"altro":1}')).toThrow('piano valido')
  })

  it('normalizeSteps limita a 20 passi e la lunghezza dei campi', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, detail: 'd'.repeat(5000) }))
    const out = normalizeSteps(many)
    expect(out).toHaveLength(20)
    expect(out[0].detail).toHaveLength(2000)
    expect(() => normalizeSteps('x')).toThrow()
  })
})

describe('uso del contesto', () => {
  const base = { brief: brief({}), numCtx: 4096 }
  const u = (content: string) => ({ role: 'user' as const, content })

  it('senza risposte: stima su brief + messaggi, memoria di riserva', () => {
    const r = computeContextUsage({ ...base, brief: brief({ role: 'x'.repeat(400) }), messages: [u('y'.repeat(396))] })
    // brief "# Ruolo\n" + 400 = 408 caratteri → 106 token; messaggio 396 → 103
    expect(r).toMatchObject({ used: 106 + 103, total: 4096, estimated: true })
    expect(r.ratio).toBeCloseTo(209 / 4096)
  })

  it('con il conteggio di Ollama: prompt + risposta, più la stima dei messaggi successivi', () => {
    const msgs = [u('ciao'), { role: 'assistant' as const, content: 'risposta', promptEvalCount: 30, evalCount: 12 }]
    expect(computeContextUsage({ ...base, messages: msgs })).toMatchObject({ used: 42, estimated: false })
    const withNext = computeContextUsage({ ...base, messages: [...msgs, u('x'.repeat(40))] })
    expect(withNext).toMatchObject({ used: 42 + 14, estimated: true })
  })

  it('conteggio troppo basso (cache dei prompt di Ollama) → resta la stima', () => {
    const msgs = [u('x'.repeat(4000)), { role: 'assistant' as const, content: 'ok', promptEvalCount: 3, evalCount: 1 }]
    const r = computeContextUsage({ ...base, messages: msgs })
    expect(r.estimated).toBe(true)
    expect(r.used).toBe(1004 + 5)
  })

  it('la memoria totale è quella effettiva passata (vedi resolveNumCtx)', () => {
    expect(computeContextUsage({ ...base, messages: [], numCtx: 2048 }).total).toBe(2048)
  })

  it('oltre il limite il rapporto supera 1', () => {
    expect(computeContextUsage({ ...base, messages: [u('x'.repeat(40000))] }).ratio).toBeGreaterThan(1)
  })

  it('formatTokensK', () => {
    expect(formatTokensK(850)).toBe('850')
    expect(formatTokensK(3200)).toBe('3,2k')
    expect(formatTokensK(8192)).toBe('8,2k')
    expect(formatTokensK(40960)).toBe('41k')
    expect(formatTokensK(4000)).toBe('4k')
  })
})

describe('caratteri per token misurati sulla conversazione', () => {
  const answer = (content: string, evalCount: number | null, thinking: string | null = null) =>
    ({ role: 'assistant' as const, content, evalCount, thinking })
  const u = (content: string) => ({ role: 'user' as const, content })

  it('senza conteggi, o con pochi token, resta 4', () => {
    expect(charsPerToken([])).toBe(4)
    expect(charsPerToken([u('x'.repeat(400)), answer('y'.repeat(300), null)])).toBe(4)
    expect(charsPerToken([answer('y'.repeat(147), 49)])).toBe(4)
  })

  it('rapporto reale: risposta + ragionamento diviso i token generati', () => {
    // 300 caratteri in 100 token → 3 per token
    expect(charsPerToken([answer('y'.repeat(300), 100)])).toBe(3)
    // il ragionamento conta nei token generati
    expect(charsPerToken([answer('y'.repeat(100), 100, 't'.repeat(250))])).toBe(3.5)
    // si somma su tutte le risposte; i messaggi dell'utente non contano
    expect(charsPerToken([u('x'.repeat(5000)), answer('y'.repeat(300), 100), answer('y'.repeat(100), 100)])).toBe(2)
  })

  it('fuori dall\'intervallo plausibile il conteggio è inattendibile → 4', () => {
    expect(charsPerToken([answer('y'.repeat(100), 100)])).toBe(4) // 1 carattere per token
    expect(charsPerToken([answer('y'.repeat(1000), 100)])).toBe(4) // 10
  })

  it('selectHistory e computeContextUsage usano il rapporto misurato', () => {
    // 3 caratteri per token: 3000 caratteri = 1004 token, non 754
    const h = [answer('y'.repeat(300), 100), u('x'.repeat(3000)), answer('ok', null), u('fine')]
    const limits = { maxMessages: 50, maxTokens: 1000, reserveTokens: 0 }
    // budget 1000: 'fine' (6) + 'ok' (5), poi 3000 caratteri = 1004 token non entrano → resta solo 'fine' (niente risposte orfane)
    expect(selectHistory(h, '', limits)).toHaveLength(1)
    // senza conteggi (4 per token) i 3000 caratteri costerebbero 754 ed entrerebbero
    const uncalibrated = [answer('y'.repeat(300), null), u('x'.repeat(3000)), answer('ok', null), u('fine')]
    expect(selectHistory(uncalibrated, '', limits)).toHaveLength(3)
    const usage = computeContextUsage({ brief: brief({}), messages: [answer('y'.repeat(300), 100), u('x'.repeat(3000))], numCtx: 4096 })
    expect(usage.charsPerToken).toBe(3)
    expect(usage.estimated).toBe(true)
  })
})
