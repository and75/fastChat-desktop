// Il banco di prova dei ruoli (bench/): esegue i casi con il codice dell'app contro un Ollama finto, e i
// controlli a regole fisse scattano sulle risposte costruite apposta.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { passRate, runChecks, splitAnswer } from '../bench/checks'
import type { Ask } from '../bench/claude'
import { createJudge, CRITERIA, judgePrompt } from '../bench/judge'
import { applyProposal, improvePrompt, proposeVariant, type Proposal } from '../bench/improve'
import { runLoop, scoreOf } from '../bench/loop'
import { buildReport, summarize } from '../bench/report'
import { runVariant } from '../bench/run'
import type { BenchCase, CaseResult, Turn, Variant } from '../bench/types'
import { loadBaseline } from '../bench/variant'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const turn = (answer: string, extra: Partial<Turn> = {}): Turn => ({
  user: 'domanda',
  answer,
  thinking: '',
  sent: [],
  doneReason: 'stop',
  error: null,
  measures: { totalMs: 1000, loadMs: 0, promptEvalMs: 100, evalMs: 900, firstTokenMs: 200, promptTokens: 100, outputTokens: 90, thinkingTokens: 30, tokensPerSecond: 100 },
  ...extra
})
const failed = (testCase: BenchCase, choices: Record<string, string | string[]>, answers: string[]): string[] =>
  runChecks(testCase, choices, answers.map((a) => turn(a))).filter((c) => !c.pass).map((c) => c.id)

const DEFAULTS = { specializzazione: 'piccoli', spiegazione: 'semplice', tipo: 'messaggio', tecniche: ['ruolo', 'formato', 'mancante'], metodo: 'chiarimenti' }
const GOOD = 'Ipotesi: il racconto è per bambini.\n\n```\nSei uno scrittore per bambini. Scrivi un racconto breve.\n```\n\nPerché è scritto così:\n1. Dice per chi è.\n2. Fissa la lunghezza.\n3. Indica il tono.'

describe('banco di prova: controlli a regole fisse', () => {
  const prompt: BenchCase = { id: 'p', split: 'train', request: 'r', expect: 'prompt', creative: true }

  it('splitAnswer separa il prompt dal resto', () => {
    expect(splitAnswer(GOOD)).toEqual({ blocks: ['Sei uno scrittore per bambini. Scrivi un racconto breve.\n'], outside: expect.stringContaining('Perché è scritto così'), before: 'Ipotesi: il racconto è per bambini.', after: expect.stringMatching(/^Perché/) })
    expect(splitAnswer('Solo testo?').blocks).toEqual([])
  })

  it('una risposta ben fatta li supera tutti; ogni difetto fa scattare il suo controllo', () => {
    const subito = { ...DEFAULTS, metodo: 'subito' }
    expect(failed(prompt, subito, [GOOD])).toEqual([])
    expect(passRate(runChecks(prompt, subito, [turn(GOOD)]))).toBe(1)
    // niente blocco di codice
    expect(failed(prompt, subito, ['Sei uno scrittore. Scrivi un racconto.'])).toEqual(['blocco-di-codice'])
    // esempio non richiesto, delimitatore inutile, regola sul dato mancante in un compito creativo
    expect(failed(prompt, subito, [GOOD.replace('Scrivi un racconto breve.', 'Scrivi un racconto breve.\nSe non viene specificato il nome, inventalo.\n<esempio>\nC\'era una volta\n</esempio>')])).toEqual(['niente-esempi-non-richiesti', 'niente-delimitatori-inutili', 'niente-regola-sul-dato-mancante'])
    // con la tecnica «Esempi» scelta, l'esempio è atteso
    expect(failed({ ...prompt, creative: false }, { ...subito, tecniche: ['ruolo', 'esempi'] }, [GOOD.replace('breve.', 'breve.\nEsempio: C\'era una volta')])).toEqual([])
    // titoli di sezione in un messaggio; sezioni mancanti in un prompt di sistema
    expect(failed(prompt, subito, [GOOD.replace('Sei uno', '# Identità\nSei uno')])).toEqual(['senza-titoli-di-sezione'])
    expect(failed(prompt, { ...subito, tipo: 'sistema' }, [GOOD])).toEqual(['con-sezioni'])
    // spiegazione: tre punti, oppure nessuna
    expect(failed(prompt, subito, [GOOD.replace('\n3. Indica il tono.', '')])).toEqual(['spiegazione-in-tre-punti'])
    expect(failed(prompt, { ...subito, spiegazione: 'nessuna' }, [GOOD + ' '.repeat(1) + 'x'.repeat(200)])).toEqual(['senza-spiegazione'])
    // con «Risponde subito» le ipotesi vanno dichiarate prima del prompt
    expect(failed(prompt, subito, [GOOD.replace('Ipotesi: il racconto è per bambini.\n\n', '')])).toEqual(['ipotesi-dichiarate'])
  })

  it('richiesta vaga: deve chiedere; diagnosi: non deve riscrivere', () => {
    const ask: BenchCase = { id: 'a', split: 'test', request: 'r', reply: 'per bambini', expect: 'ask' }
    expect(failed(ask, DEFAULTS, ['Per chi è il racconto?', GOOD])).toEqual([])
    expect(failed(ask, DEFAULTS, [GOOD])).toEqual(['fa-domande'])
    // senza la risposta dell'utente il caso finisce con le domande
    expect(failed({ ...ask, reply: undefined }, DEFAULTS, ['Per chi è?'])).toEqual([])
    const diagnosis: BenchCase = { id: 'd', split: 'test', request: 'r', expect: 'diagnosis' }
    expect(failed(diagnosis, DEFAULTS, ['1. Manca il compito.\n2. Manca il contesto.'])).toEqual([])
    expect(failed(diagnosis, DEFAULTS, ['Ecco la versione migliore:\n```\nx\n```'])).toEqual(['non-riscrive', 'elenca-problemi'])
    // errori e risposte tagliate si vedono
    expect(runChecks(diagnosis, DEFAULTS, [turn('', { error: 'modello assente' })]).map((c) => c.id)).toEqual(['senza-errori-1', 'risposta'])
    expect(runChecks(diagnosis, DEFAULTS, [turn('1. a\n2. b', { doneReason: 'length' })]).filter((c) => !c.pass).map((c) => c.id)).toEqual(['risposta-completa-1'])
  })
})

describe('banco di prova: esecuzione con il codice dell\'app', () => {
  let fake: FakeOllama
  beforeAll(async () => {
    fake = await startFakeOllama([
      {
        name: 'piccolo',
        capabilities: ['completion', 'thinking'],
        // alla richiesta vaga fa una domanda; alla risposta dell'utente, e a tutto il resto, scrive il prompt
        respond: (messages) => (messages.at(-1)!.content.includes('prima partita') && messages.filter((m) => m.role === 'user').length === 1 ? 'Per chi è il racconto?' : GOOD)
      },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())

  it('invia lo stesso prompt dell\'app (istruzioni, tecniche con i titoli, due esempi), misura e controlla', async () => {
    const variant = loadBaseline('prompt.it')
    const cases: BenchCase[] = [
      { id: 'vago', split: 'train', request: 'Scrivi un prompt per un racconto su una prima partita di calcio', reply: 'Per bambini di otto anni.', expect: 'ask', creative: true },
      { id: 'subito', split: 'test', request: 'Scrivi un prompt per una poesia sull\'autunno', choices: { metodo: 'subito' }, expect: 'prompt', creative: true }
    ]
    const seen: string[] = []
    const results = await runVariant(variant, cases, { ollamaUrl: fake.url, models: ['piccolo'], reps: 1, think: 'role', numCtx: 8192 }, { onResult: (r, p) => void seen.push(`${p.index}/${p.total} ${r.case.id}`) })
    expect(seen).toEqual(['1/2 vago', '2/2 subito'])
    const [vague, direct] = results
    expect(vague.error).toBeNull()
    // il ruolo fissa ragionamento e temperatura; la memoria è quella chiesta al banco
    expect(vague.settings).toEqual({ think: true, numCtx: 8192, temperature: 0.6 })
    // due battute: la domanda dell'Esperto, poi il prompt dopo la risposta dell'utente
    expect(vague.turns.map((t) => t.user)).toEqual([cases[0].request, cases[0].reply])
    expect(vague.turns[0].answer).toBe('Per chi è il racconto?')
    expect(vague.checks.filter((c) => !c.pass)).toEqual([])
    // il prompt di sistema è quello dell'app
    const system = vague.turns[0].sent[0]
    expect(system.role).toBe('system')
    expect(system.content.startsWith(variant.role.instructions!.split('\n')[0])).toBe(true)
    expect(system.content).toContain('fai due o tre domande brevi e fermati')
    expect(system.content).toMatch(/\n\n# Come lavorare\n\n[\s\S]*\n\n## Dare un ruolo\n\n/)
    expect(system.content.match(/\n<esempio>\n/g)).toHaveLength(2)
    expect(vague.turns[0].sent.at(-1)).toEqual({ role: 'user', content: cases[0].request })
    // la seconda battuta porta lo storico
    expect(vague.turns[1].sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    // nessuna chiamata per il titolo: le misure sono solo quelle della risposta
    expect(fake.requests.filter((r) => r.path === '/api/chat')).toHaveLength(3)
    expect(vague.turns[0].measures.outputTokens).toBeGreaterThan(0)
    // le scelte del caso arrivano nelle istruzioni
    expect(direct.choices.metodo).toBe('subito')
    expect(direct.turns[0].sent[0].content).toContain('elenca le ipotesi in una riga prima del prompt')
    expect(direct.checks.filter((c) => !c.pass)).toEqual([])

    // ripresa: ciò che è già fatto non si riesegue
    const again = await runVariant(variant, cases, { ollamaUrl: fake.url, models: ['piccolo'], reps: 1, think: 'role', numCtx: 8192 }, { done: results })
    expect(again).toEqual(results)
    expect(fake.requests.filter((r) => r.path === '/api/chat')).toHaveLength(3)

    // giudice: riceve atteso, istruzioni del ruolo (non le tecniche), conversazione e controlli; i voti entrano nel caso
    const asked: string[] = []
    const ask: Ask = async ({ user }) => {
      asked.push(user)
      return { scores: Object.keys(CRITERIA).map((criterion, i) => ({ criterion, score: i === 0 ? 9 : 3.4, reason: ' motivo ' })), problems: ['uno', 'due', 'tre', 'quattro'] } as never
    }
    const judged = await runVariant(variant, cases.slice(1), { ollamaUrl: fake.url, models: ['piccolo'], reps: 1, think: 'role', numCtx: 8192 }, { judge: createJudge(ask) })
    expect(judged[0].verdict).toEqual({ scores: Object.keys(CRITERIA).map((criterion, i) => ({ criterion, score: i === 0 ? 5 : 3, reason: 'motivo' })), mean: 3.4, problems: ['uno', 'due', 'tre'] })
    expect(asked[0]).toContain('<atteso>\nScrivere subito il prompt')
    expect(asked[0]).toContain('elenca le ipotesi in una riga prima del prompt')
    expect(asked[0]).not.toContain('# Come lavorare')
    expect(asked[0]).toContain('<esperto battuta="1">\nIpotesi: il racconto è per bambini.')
    expect(asked[0]).toContain('- superato · blocco-di-codice')
    expect(judgePrompt(vague)).toContain('<utente battuta="2">')
    // un verdetto incompleto, o un rifiuto, lascia il caso senza voto
    expect(await createJudge(async () => ({ scores: [{ criterion: 'qualita', score: 4, reason: 'x' }], problems: [] }) as never)(direct, variant)).toBeNull()
    expect(await createJudge(async () => null)(direct, variant)).toBeNull()
    expect(summarize(judged, 'base', 'piccolo', 'test').score).toBe(3.4)
    expect(buildReport({ role: 'prompt.it', startedAt: 'x', options: { models: ['piccolo'], reps: 1, think: 'role', numCtx: 8192, judge: 'claude-opus-5-5', rounds: 0 }, results: judged, notes: [] })).toContain('Giudice: **3,4 / 5**')

    // riepilogo e rapporto
    expect(summarize(results, 'base', 'piccolo', 'test')).toMatchObject({ cases: 1, checks: 1, score: null, errors: 0 })
    const report = buildReport({ role: 'prompt.it', startedAt: '2026-11-15T12:00:00Z', options: { models: ['piccolo'], reps: 1, think: 'role', numCtx: 8192, judge: null, rounds: 0 }, results, notes: [] })
    expect(report).toContain('## Casi di controllo')
    expect(report).toContain('### vago · piccolo · base')
    expect(report).toContain('Controlli: ')
  }, 60_000)

  it('ragionamento forzato; un modello che non c\'è dà un errore sul caso, non ferma il banco', async () => {
    const variant = loadBaseline('prompt.it')
    const cases: BenchCase[] = [{ id: 'subito', split: 'test', request: 'Scrivi un prompt per una poesia', choices: { metodo: 'subito' }, expect: 'prompt' }]
    const off = await runVariant(variant, cases, { ollamaUrl: fake.url, models: ['piccolo'], reps: 1, think: 'off', numCtx: 4096 })
    expect(off[0].settings.think).toBe(false)
    const missing = await runVariant(variant, cases, { ollamaUrl: fake.url, models: ['assente'], reps: 1, think: 'role', numCtx: 4096 })
    expect(missing[0].checks.some((c) => !c.pass)).toBe(true)
  }, 60_000)
})

describe('banco di prova: correzione e riprova', () => {
  const base = loadBaseline('prompt.it')
  const TECNICHE = 'app.fastchat.kb.prompt-tecniche.it'
  const ESEMPI = 'app.fastchat.kb.prompt-esempi.it'
  const empty: Proposal = { diagnosis: 'd', changes: ['c'], instructions: '', options: [], bases: [] }

  it('una proposta cambia solo i testi; ciò che altera la struttura o stravolge un documento viene scartato', () => {
    const ok = applyProposal(base, { ...empty, instructions: 'Sei un esperto di prompt.', options: [{ parameter: 'metodo', option: 'subito', instruction: 'Rispondi subito e dichiara le ipotesi.' }], bases: [{ id: TECNICHE, text: base.bases[TECNICHE].files[0].text.replace('Un buon prompt', 'Un prompt riuscito') }] }, 'giro-1')
    expect('variant' in ok).toBe(true)
    const next = (ok as { variant: Variant }).variant
    expect(next.name).toBe('giro-1')
    expect(next.role.instructions).toBe('Sei un esperto di prompt.')
    expect(next.role.parameters!.find((p) => p.id === 'metodo')!.options.find((o) => o.id === 'subito')!.instruction).toBe('Rispondi subito e dichiara le ipotesi.')
    expect(next.bases[TECNICHE].files[0].text).toContain('Un prompt riuscito')
    // la struttura resta quella: stessi parametri, opzioni, predefiniti; la variante di partenza non è toccata
    expect(next.role.parameters!.map((p) => [p.id, p.default, p.options.map((o) => o.id)])).toEqual(base.role.parameters!.map((p) => [p.id, p.default, p.options.map((o) => o.id)]))
    expect(base.role.instructions).not.toBe('Sei un esperto di prompt.')
    const rejected = (proposal: Partial<Proposal>): string => (applyProposal(base, { ...empty, ...proposal }, 'x') as { rejected: string }).rejected
    expect(rejected({})).toMatch(/nessuna modifica/)
    expect(rejected({ options: [{ parameter: 'metodo', option: 'inventata', instruction: 'x' }] })).toMatch(/opzione sconosciuta/)
    expect(rejected({ options: [{ parameter: 'metodo', option: 'subito', instruction: ' ' }] })).toMatch(/frase vuota/)
    expect(rejected({ bases: [{ id: 'app.fastchat.guida', text: 'x' }] })).toMatch(/non modificabile/)
    expect(rejected({ bases: [{ id: TECNICHE, text: 'Troppo corto.' }] })).toMatch(/cambiato troppo/)
    expect(rejected({ bases: [{ id: ESEMPI, text: 'x'.repeat(base.bases[ESEMPI].files[0].text.length) }] })).toMatch(/almeno due esempi/)
  })

  const result = (variant: string, testCase: BenchCase, pass: boolean): CaseResult => ({ variant, model: 'm', rep: 1, case: testCase, choices: {}, settings: { think: true, numCtx: 1, temperature: 0.6 }, turns: [turn('risposta di prova')], checks: [{ id: 'c', pass, detail: pass ? 'bene' : 'male' }], verdict: null, error: null })
  const cases: BenchCase[] = [
    { id: 'lavoro-1', split: 'train', request: 'r', expect: 'prompt' },
    { id: 'controllo-1', split: 'test', request: 'r', expect: 'prompt' },
    { id: 'controllo-2', split: 'test', request: 'r', expect: 'prompt' }
  ]

  it('il correttore vede i testi e i soli casi di lavoro, mai quelli di controllo', async () => {
    const results = cases.map((c) => result('base', c, false))
    const text = improvePrompt(base, results, ['prima modifica → scartata'])
    expect(text).toContain('<istruzione_fissa>')
    expect(text).toContain('parametro «metodo»')
    expect(text).toContain(`<documento id="${ESEMPI}"`)
    expect(text).toContain('<caso id="lavoro-1"')
    expect(text).not.toContain('controllo-1')
    expect(text).toContain('<giri_precedenti>\n1. prima modifica → scartata')
    expect(text).toContain('Controlli automatici falliti: c (male)')
    const proposed = await proposeVariant(async () => ({ ...empty, instructions: 'Nuova istruzione.' }) as never, base, results, 'giro-1', [])
    expect(proposed!.outcome).toMatchObject({ variant: { name: 'giro-1' } })
    expect(await proposeVariant(async () => null, base, results, 'giro-1', [])).toBeNull()
  })

  it('ciclo: una variante si tiene solo se migliora sui casi di controllo oltre il rumore', async () => {
    // quanto «passa» ogni variante sui casi di controllo: la base 1 su 2, il giro 1 peggio, il giro 2 tutto
    const quality: Record<string, boolean[]> = { base: [true, false], 'base-bis': [true, false], 'giro-1': [false, false], 'giro-2': [true, true] }
    const ran: string[] = []
    const saved: string[] = []
    const proposedFrom: string[] = []
    const outcome = await runLoop(base, cases, { models: ['m'] }, 3, {
      async run(variant, subset) {
        ran.push(`${variant.name}:${subset.length}`)
        const tests = subset.filter((c) => c.split === 'test')
        return subset.map((c) => result(variant.name, c, c.split === 'train' ? true : quality[variant.name][tests.indexOf(c)]))
      },
      async propose(best, _results, name) {
        proposedFrom.push(`${name}<-${best.name}`)
        if (name === 'giro-3') return { changes: [], diagnosis: 'nulla da cambiare', outcome: { rejected: 'nessuna modifica proposta' } }
        return { changes: [`modifica ${name}`], diagnosis: 'causa', outcome: { variant: { ...base, name } } }
      },
      onVariant: (v) => void saved.push(v.name)
    })
    // base su tutti i casi, poi di nuovo sui soli casi di controllo per il rumore, poi le due varianti provate
    expect(ran).toEqual(['base:3', 'base-bis:2', 'giro-1:3', 'giro-2:3'])
    expect(saved).toEqual(['giro-1', 'giro-2'])
    // il giro 2 parte ancora dalla base (il giro 1 è stato scartato); il giro 3 dal giro 2, tenuto
    expect(proposedFrom).toEqual(['giro-1<-base', 'giro-2<-base', 'giro-3<-giro-2'])
    expect(outcome.best.name).toBe('giro-2')
    expect(scoreOf(outcome.results, 'giro-2', ['m'], 'test')).toBe(1)
    expect(outcome.notes.join('\n')).toMatch(/«giro-1»: 0% sui casi di controllo contro 50% — scartata/)
    expect(outcome.notes.join('\n')).toMatch(/«giro-2»: 100% sui casi di controllo contro 50% — \*\*tenuta\*\*/)
    expect(outcome.notes.join('\n')).toMatch(/Giro 3: proposta scartata prima della prova/)
    expect(outcome.notes.at(-1)).toMatch(/la variante migliore è «giro-2»/)

    // senza giri: solo la misura; senza miglioramenti: resta la base
    const measure = await runLoop(base, cases, { models: ['m'] }, 0, { run: async (v, subset) => subset.map((c) => result(v.name, c, true)), propose: async () => null })
    expect(measure.best).toBe(base)
    expect(measure.notes).toHaveLength(1)
    const flat = await runLoop(base, cases, { models: ['m'] }, 1, { run: async (v, subset) => subset.map((c) => result(v.name, c, true)), propose: async (_b, _r, name) => ({ changes: ['x'], diagnosis: 'd', outcome: { variant: { ...base, name } } }) })
    expect(flat.best).toBe(base)
    expect(flat.notes.at(-1)).toMatch(/nessuna variante ha fatto meglio/)
  })
})
