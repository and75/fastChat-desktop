import { describe, expect, it } from 'vitest'
import {
  buildExecutePrompt,
  buildPlanPrompt,
  buildSystemPrompt,
  buildStyleSection,
  buildSummaryRequest,
  STYLE_INSTRUCTIONS,
  charsPerToken,
  cleanSummary,
  computeContextUsage,
  historyAfter,
  planSummary,
  summaryMaxTokens,
  transcriptChunks,
  withSummary,
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

describe('riassunto automatico', () => {
  const msg = (id: string, role: 'user' | 'assistant', chars: number) => ({ id, role, content: 'x'.repeat(chars) })
  // 8 messaggi da 400 caratteri = 104 token l'uno (a 4 caratteri per token)
  const eight = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', 400))

  it('withSummary: sezione in coda al brief; niente se vuoto', () => {
    expect(withSummary('# Ruolo\nTutor', 'Si parlava di Roma.')).toBe('# Ruolo\nTutor\n\n# Riassunto della conversazione finora\nSi parlava di Roma.')
    expect(withSummary('', 'Si parlava di Roma.')).toBe('# Riassunto della conversazione finora\nSi parlava di Roma.')
    expect(withSummary('# Ruolo\nTutor', '  ')).toBe('# Ruolo\nTutor')
    expect(withSummary('# Ruolo\nTutor', null)).toBe('# Ruolo\nTutor')
  })

  it('historyAfter: i messaggi dopo quello coperto; disallineato se non esiste più', () => {
    expect(historyAfter(eight, null)).toEqual({ recent: eight, aligned: true })
    expect(historyAfter(eight, 'm3')).toEqual({ recent: eight.slice(4), aligned: true })
    expect(historyAfter(eight, 'sparito')).toEqual({ recent: eight, aligned: false })
  })

  it('planSummary: sotto la soglia non fa nulla', () => {
    // 8 × 104 = 832 token su 2000 → 42% < 70%
    expect(planSummary({ recent: eight, systemPrompt: '', numCtx: 2000 })).toBeNull()
    // a mano («Riassumi ora») si riassume tutto tranne l'ultimo scambio, che ci sta
    const forced = planSummary({ recent: eight, systemPrompt: '', numCtx: 2000, force: true })!
    expect(forced.cover.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(forced.keep.map((m) => m.id)).toEqual(['m6', 'm7'])
  })

  it('planSummary: sopra la soglia copre i più vecchi fino all\'obiettivo, chiudendo su una risposta', () => {
    // 832 su 1000 > 70% → scende sotto il 40% (400): tiene 3 (312), copre 5…
    // …ma il 5º coperto sarebbe una domanda (m4): si chiude sulla risposta m5
    const plan = planSummary({ recent: eight, systemPrompt: '', numCtx: 1000 })!
    expect(plan.cover.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(plan.keep.map((m) => m.id)).toEqual(['m6', 'm7'])
  })

  it('planSummary: l\'ultimo scambio resta per intero solo se ci sta; la domanda in attesa sempre', () => {
    // memoria 250: l'ultimo scambio (208) supera il 70% (175) → si riassume tutto
    const tiny = planSummary({ recent: eight, systemPrompt: '', numCtx: 250 })!
    expect(tiny.cover).toHaveLength(8)
    expect(tiny.keep).toEqual([])
    // con una domanda in attesa: resta solo quella
    const pending = [...eight, msg('q', 'user', 400)]
    const withQ = planSummary({ recent: pending, systemPrompt: '', numCtx: 250 })!
    expect(withQ.keep.map((m) => m.id)).toEqual(['q'])
    // system prompt enorme: si riassume tutto il riassumibile
    expect(planSummary({ recent: eight, systemPrompt: 'x'.repeat(10_000), numCtx: 1000 })!.cover).toHaveLength(8)
  })

  it('caso v0.1.13: la stima dice 44%, Ollama ha contato il 99% → si riassume prima della risposta', () => {
    const recent = [
      { id: 'q', role: 'user' as const, content: 'Adorno ha una teoria sull\'amore?' },
      { id: 'a', role: 'assistant' as const, content: 'z'.repeat(4099), evalCount: 1065 },
      { id: 'n', role: 'user' as const, content: 'Ci sono filosofi post critici che si occupano dell\'amore?' }
    ]
    const system = 's'.repeat(2500)
    // con la sola stima non scatterebbe
    expect(planSummary({ recent, systemPrompt: system, numCtx: 4096 })).toBeNull()
    // con il conteggio reale (3.007 + 1.065 + domanda) sì: si riassume l'ultimo scambio, resta la domanda
    const plan = planSummary({ recent, systemPrompt: system, numCtx: 4096, measuredTotal: 3007 + 1065 + 20 })!
    expect(plan.cover.map((m) => m.id)).toEqual(['q', 'a'])
    expect(plan.keep.map((m) => m.id)).toEqual(['n'])
  })

  it('caso reale: memoria 1024, due risposte da ~1.800 token → «Riassumi ora» copre tutti e 4 i messaggi', () => {
    const conv = [
      { id: 'u1', role: 'user' as const, content: "Parlami dell'amore!" },
      { id: 'a1', role: 'assistant' as const, content: 'x'.repeat(6200), evalCount: 1809 },
      { id: 'u2', role: 'user' as const, content: "Parlami dell'amore romantico" },
      { id: 'a2', role: 'assistant' as const, content: 'y'.repeat(5900), evalCount: 1750 }
    ]
    const plan = planSummary({ recent: conv, systemPrompt: '# Stile della risposta\nRispondi in modo completo', numCtx: 1024, force: true })!
    expect(plan.cover.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    // e la domanda successiva: si riassume tutto tranne la domanda stessa
    const next = planSummary({ recent: [...conv, { id: 'u3', role: 'user' as const, content: 'E poi?' }], systemPrompt: '', numCtx: 1024 })!
    expect(next.keep.map((m) => m.id)).toEqual(['u3'])
  })

  it('transcriptChunks: blocchi in ordine; i messaggi lunghi spezzati in parti, niente si perde', () => {
    const chunks = transcriptChunks([msg('a', 'user', 100), msg('b', 'assistant', 1000), msg('c', 'user', 100)], 400)
    expect(chunks.every((c) => c.length <= 400)).toBe(true)
    expect(chunks[0].startsWith('Utente: ')).toBe(true)
    expect(chunks.join('\n')).toMatch(/Assistente \(parte 1\/3\): /)
    expect(chunks.join('\n')).toMatch(/Assistente \(parte 3\/3\): /)
    // tutto il testo della risposta lunga c'è, in ordine
    const body = chunks.join('\n').match(/Assistente \(parte \d\/3\): (x+)/g)!.map((p) => p.replace(/^.*: /, '')).join('')
    expect(body).toBe('x'.repeat(1000))
    expect(chunks.at(-1)!.endsWith('Utente: ' + 'x'.repeat(100))).toBe(true)
  })

  it('summaryMaxTokens: un quarto dello spazio per lo storico, tra 64 e 600', () => {
    expect(summaryMaxTokens(1024, 512)).toBe(128)
    expect(summaryMaxTokens(32768, 8192)).toBe(600)
    expect(summaryMaxTokens(256, 256)).toBe(64)
  })

  it('buildSummaryRequest e cleanSummary', () => {
    expect(buildSummaryRequest(null, 'Utente: ciao')).toBe('Messaggi:\nUtente: ciao')
    expect(buildSummaryRequest('Prima.', 'Utente: ciao')).toBe('Riassunto finora:\nPrima.\n\nNuovi messaggi:\nUtente: ciao')
    expect(cleanSummary('<think>mah</think>\n# Riassunto aggiornato\n- punto uno\n')).toBe('- punto uno')
  })

  it('computeContextUsage: con il riassunto contano solo system (con riassunto) e messaggi non coperti', () => {
    const summary = 's'.repeat(400) // 100 token + "# Riassunto…" (43 caratteri → 11) + separatore
    const r = computeContextUsage({ brief: brief({}), messages: eight, numCtx: 4096, summary, summaryUpTo: 'm3' })
    const title = '# Riassunto della conversazione finora\n'
    expect(r.used).toBe(Math.ceil((title.length + 400) / 4) + 4 + 4 * 104)
    // riassunto disallineato: si ignora e si contano tutti i messaggi
    expect(computeContextUsage({ brief: brief({}), messages: eight, numCtx: 4096, summary, summaryUpTo: 'sparito' }).used).toBe(8 * 104)
  })

  it('computeContextUsage: un riassunto più recente dell\'ultima risposta invalida il conteggio di Ollama', () => {
    const msgs = [
      { id: 'u', role: 'user' as const, content: 'ciao', createdAt: 1000 },
      { id: 'a', role: 'assistant' as const, content: 'risposta', promptEvalCount: 30, evalCount: 12, createdAt: 2000 }
    ]
    expect(computeContextUsage({ brief: brief({}), messages: msgs, numCtx: 4096 })).toMatchObject({ used: 42, estimated: false })
    expect(computeContextUsage({ brief: brief({}), messages: msgs, numCtx: 4096, summary: 'x', summaryUpdatedAt: 3000 }).estimated).toBe(true)
  })
})

describe('stile della risposta nel system prompt', () => {
  it('sezione dopo il brief; niente per lo stile normale', () => {
    expect(buildStyleSection('normal')).toBe('')
    expect(buildStyleSection(null)).toBe('')
    expect(buildStyleSection('concise')).toMatch(/^# Stile della risposta\nVai dritto al punto/)
    expect(buildSystemPrompt(brief({ role: 'Tutor' }), 'essential')).toMatch(/^# Ruolo\nTutor\n\n# Stile della risposta\nRispondi nel modo più breve possibile/)
    expect(buildSystemPrompt(brief({ role: 'Tutor' }), 'normal')).toBe('# Ruolo\nTutor')
    // brief vuoto: solo lo stile
    expect(buildSystemPrompt(brief({}), 'extended')).toMatch(/^# Stile della risposta\nRispondi in modo completo/)
  })

  it('i livelli sintetici proteggono la precisione; il piano viene dopo lo stile', () => {
    for (const style of ['essential', 'concise'] as const) expect(STYLE_INSTRUCTIONS[style]).toContain('La brevità non deve costare precisione')
    expect(STYLE_INSTRUCTIONS.normal).toBeNull()
    const plan = buildPlanPrompt(brief({ role: 'Tutor' }), 'concise')
    expect(plan.indexOf('# Stile della risposta')).toBeGreaterThan(plan.indexOf('# Ruolo'))
    expect(plan.indexOf('# Modalità piano')).toBeGreaterThan(plan.indexOf('# Stile della risposta'))
  })
})
