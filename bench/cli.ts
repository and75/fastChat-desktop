// Banco di prova dei ruoli, da riga di comando. Uso: npm run bench -- --role prompt.it --models gemma4:e4b
// Si esegue sul computer dove gira Ollama. Vedi bench/README.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { passRate } from './checks'
import { createClaude, describeAnthropicError, hasAnthropicKey } from './claude'
import { BenchError } from './harness'
import { createJudge } from './judge'
import { buildReport } from './report'
import { runVariant } from './run'
import type { BenchCase, CaseResult, RunOptions } from './types'
import { loadBaseline, loadVariant, saveVariant } from './variant'

const repo = resolve(import.meta.dirname, '..')

const HELP = `Banco di prova dei ruoli di FastChat

  npm run bench -- [opzioni]

  --role <chiave>       ruolo da provare, come il file in roles/ (predefinito: prompt.it)
  --models <a,b>        modelli di Ollama, separati da virgola (predefinito: quello consigliato dal ruolo)
  --cases <id,id>       solo questi casi (predefinito: tutti)
  --reps <n>            ripetizioni di ogni caso (predefinito: 1)
  --think <role|on|off> ragionamento: come lo fissa il ruolo, sempre acceso, sempre spento (predefinito: role)
  --num-ctx <n>         memoria della conversazione in token (predefinito: 16384)
  --variant <cartella>  prova una variante salvata invece dei testi del repository
  --judge-model <id>    modello Anthropic che giudica le risposte (predefinito: claude-opus-5-5)
  --no-judge            solo misure e controlli a regole fisse, anche se c'è una chiave Anthropic
  --url <url>           indirizzo di Ollama (predefinito: OLLAMA_URL o http://127.0.0.1:11434)
  --out <cartella>      dove scrivere i risultati (predefinito: bench/runs/<data>); se esiste, riprende
  --dry-run             elenca cosa verrebbe eseguito, senza chiamare nulla
  --help                questo testo
`

function fail(message: string): never {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** I casi di un ruolo (bench/cases/<ruolo>.json), filtrati per id se richiesto. */
export function loadCases(role: string, only?: string[]): BenchCase[] {
  const path = join(repo, 'bench', 'cases', `${role}.json`)
  if (!existsSync(path)) throw new BenchError(`Non ci sono casi di prova per il ruolo ${role} (manca bench/cases/${role}.json)`)
  const cases = JSON.parse(readFileSync(path, 'utf8')) as BenchCase[]
  const unknown = (only ?? []).filter((id) => !cases.some((c) => c.id === id))
  if (unknown.length) throw new BenchError(`Casi sconosciuti: ${unknown.join(', ')}. Disponibili: ${cases.map((c) => c.id).join(', ')}`)
  return only?.length ? cases.filter((c) => only.includes(c.id)) : cases
}

const readResults = (path: string): CaseResult[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CaseResult) : [])

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      role: { type: 'string', default: 'prompt.it' },
      models: { type: 'string' },
      cases: { type: 'string' },
      reps: { type: 'string', default: '1' },
      think: { type: 'string', default: 'role' },
      'num-ctx': { type: 'string', default: '16384' },
      variant: { type: 'string' },
      'judge-model': { type: 'string', default: 'claude-opus-5-5' },
      'no-judge': { type: 'boolean', default: false },
      url: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) return void console.log(HELP)
  if (!['role', 'on', 'off'].includes(values.think)) fail(`--think vuole role, on oppure off (ricevuto: ${values.think})`)
  const reps = Number(values.reps)
  const numCtx = Number(values['num-ctx'])
  if (!Number.isInteger(reps) || reps < 1) fail('--reps vuole un numero intero, almeno 1')
  if (!Number.isInteger(numCtx) || numCtx < 2048) fail('--num-ctx vuole un numero intero, almeno 2048')

  const role = values.role
  const variant = values.variant ? loadVariant(resolve(values.variant)) : loadBaseline(role)
  const cases = loadCases(role, values.cases?.split(',').map((s) => s.trim()).filter(Boolean))
  const models = values.models?.split(',').map((s) => s.trim()).filter(Boolean) ?? (variant.role.mind?.model ? [variant.role.mind.model] : [])
  if (models.length === 0) fail('Indica almeno un modello con --models: il ruolo non ne consiglia uno.')
  const options: RunOptions = { ollamaUrl: values.url ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', models, reps, think: values.think as RunOptions['think'], numCtx }

  const total = models.length * reps * cases.length
  console.log(`Ruolo ${role} · variante «${variant.name}» · ${cases.length} casi × ${models.length} modelli × ${reps} ripetizioni = ${total} esecuzioni`)
  console.log(`Ollama: ${options.ollamaUrl} · ragionamento: ${options.think} · memoria: ${numCtx}`)
  const judging = !values['no-judge'] && hasAnthropicKey()
  console.log(judging ? `Giudice: ${values['judge-model']} (richieste, istruzioni del ruolo e risposte dei modelli vengono inviate ad Anthropic)` : values['no-judge'] ? 'Giudice: disattivato' : 'Giudice: nessuno — manca ANTHROPIC_API_KEY; eseguo solo misure e controlli a regole fisse')
  if (values['dry-run']) {
    for (const c of cases) console.log(`  ${c.split === 'train' ? 'lavoro   ' : 'controllo'}  ${c.id.padEnd(22)} atteso: ${c.expect.padEnd(9)} ${c.request.slice(0, 70)}`)
    console.log(`\nStima: da due a tre minuti per esecuzione con un modello a circa 10 token al secondo, quindi ${Math.round((total * 2.5) / 6) / 10} ore circa.`)
    return
  }

  const startedAt = new Date().toISOString()
  const out = values.out ? resolve(values.out) : join(repo, 'bench', 'runs', startedAt.replace(/[:.]/g, '-').slice(0, 19))
  mkdirSync(out, { recursive: true })
  saveVariant(join(out, 'variants', variant.name), variant)
  const resultsPath = join(out, 'results.jsonl')
  const done = readResults(resultsPath)
  if (done.length) console.log(`Riprendo da ${out}: ${done.length} esecuzioni già fatte.`)

  const claude = judging ? createClaude(values['judge-model']) : null
  const judge = claude ? createJudge(claude.ask) : null
  let judgeFailure: string | null = null
  const results = await runVariant(variant, cases, options, {
    done,
    // Un errore del giudice (chiave, rete) non ferma le prove: il caso resta senza voto e lo si dice una volta.
    judge: judge
      ? async (result, v) => {
          if (judgeFailure) return null
          try {
            return await judge(result, v)
          } catch (err) {
            judgeFailure = describeAnthropicError(err)
            console.error(`Giudice non disponibile: ${judgeFailure}. Proseguo senza voti.`)
            return null
          }
        }
      : undefined,
    onResult(result, progress) {
      appendFileSync(resultsPath, JSON.stringify(result) + '\n')
      const ms = result.turns.reduce((n, t) => n + (t.measures.totalMs ?? 0), 0)
      const failed = result.checks.filter((c) => !c.pass).map((c) => c.id)
      console.log(`[${progress.index}/${progress.total}] ${result.model} · ${result.case.id} · ${Math.round(ms / 1000)} s · controlli ${Math.round(passRate(result.checks) * 100)}%${failed.length ? ` (falliti: ${failed.join(', ')})` : ''}${result.verdict ? ` · giudice ${result.verdict.mean}/5` : ''}`)
    }
  })

  writeFileSync(join(out, 'report.md'), buildReport({ role, startedAt, options: { models, reps, think: options.think, numCtx, judge: claude && !judgeFailure ? claude.model : null, rounds: 0 }, results, notes: [] }))
  if (claude) console.log(`Anthropic: ${claude.usage.calls} richieste, ${claude.usage.input} token in ingresso, ${claude.usage.output} in uscita`)
  console.log(`\nRapporto: ${join(out, 'report.md')}`)
}

main().catch((err: unknown) => fail(err instanceof BenchError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)))
