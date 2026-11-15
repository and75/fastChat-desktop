// Il banco di prova dei ruoli (bench/): esegue i casi con il codice dell'app contro un Ollama finto, e i
// controlli a regole fisse scattano sulle risposte costruite apposta.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { passRate, runChecks, splitAnswer } from '../bench/checks'
import { buildReport, summarize } from '../bench/report'
import { runVariant } from '../bench/run'
import type { BenchCase, Turn } from '../bench/types'
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
