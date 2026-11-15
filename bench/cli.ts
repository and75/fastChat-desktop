// Banco di prova dei ruoli, da riga di comando. Uso: npm run bench -- --role prompt.it --models gemma4:e4b
// Si esegue sul computer dove gira Ollama. Vedi bench/README.md.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { passRate } from './checks'
import { createClaude, describeAnthropicError, hasAnthropicKey } from './claude'
import { BenchError } from './harness'
import { proposeVariant } from './improve'
import { createJudge } from './judge'
import { runLoop } from './loop'
import { fetchSources, loadSources, sourceList } from './sources'
import { buildReport } from './report'
import { runVariant } from './run'
import type { BenchCase, CaseResult, RunOptions, Variant } from './types'
import { loadBaseline, loadVariant, repoFiles, saveVariant } from './variant'

const repo = resolve(import.meta.dirname, '..')

const HELP = `Banco di prova dei ruoli di FastChat

  npm run bench -- [opzioni]

  --role <chiave>       ruolo da provare, come il file in roles/ (predefinito: prompt.it)
  --models <a,b>        modelli di Ollama, separati da virgola (predefinito: quello consigliato dal ruolo)
  --cases <id,id>       solo questi casi (predefinito: tutti)
  --reps <n>            ripetizioni di ogni caso (predefinito: 1)
  --think <role|on|off> ragionamento: come lo fissa il ruolo, sempre acceso, sempre spento (predefinito: role)
  --num-ctx <n>         memoria della conversazione in token (predefinito: 16384)
  --gpu <auto|off>      auto: decide Ollama; off: GPU bloccata, tutto su CPU (predefinito: auto)
  --variant <cartella>  prova una variante salvata invece dei testi del repository
  --judge-model <id>    modello Anthropic che giudica le risposte (predefinito: claude-opus-5-5)
  --no-judge            solo misure e controlli a regole fisse, anche se c'è una chiave Anthropic
  --rounds <n>          giri di «correggi e riprova» dopo la prima misura (predefinito: 0, cioè solo misura)
  --apply <cartella>    copia nel repository la variante migliore di un giro già fatto, e termina
  --fetch-sources       scarica (o aggiorna) le fonti che il correttore consulta, e termina
  --no-sources          il correttore lavora senza le fonti
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

/** Copia nel repository i testi della variante migliore di un giro: ruolo e documenti modificabili. */
function applyBest(runDir: string): void {
  const marker = join(runDir, 'best.json')
  if (!existsSync(marker)) fail(`In ${runDir} non c'è una variante da applicare (manca best.json).`)
  const { role, variant: name } = JSON.parse(readFileSync(marker, 'utf8')) as { role: string; variant: string }
  const variant = loadVariant(join(runDir, 'variants', name))
  const files = repoFiles(role, variant.role)
  writeFileSync(join(repo, files.role), JSON.stringify(variant.role, null, 2) + '\n')
  console.log(`Scritto ${files.role}`)
  for (const [id, path] of Object.entries(files.bases)) {
    writeFileSync(join(repo, path), variant.bases[id].files[0].text)
    console.log(`Scritto ${path}`)
  }
  console.log(`\nVariante «${name}» applicata ai sorgenti. Restano da fare a mano: rilettura, altre lingue, npm run packs:build, test.`)
}

/** La differenza tra due varianti salvate, come la mostrerebbe git; '' se git non c'è o non ci sono differenze. */
function diffVariants(a: string, b: string): string {
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return ''
  } catch (err) {
    // git diff --no-index esce con 1 quando ci sono differenze: l'uscita è la differenza.
    return typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : ''
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      role: { type: 'string', default: 'prompt.it' },
      models: { type: 'string' },
      cases: { type: 'string' },
      reps: { type: 'string', default: '1' },
      think: { type: 'string', default: 'role' },
      'num-ctx': { type: 'string', default: '16384' },
      gpu: { type: 'string', default: 'auto' },
      variant: { type: 'string' },
      'judge-model': { type: 'string', default: 'claude-opus-5-5' },
      'no-judge': { type: 'boolean', default: false },
      rounds: { type: 'string', default: '0' },
      apply: { type: 'string' },
      'fetch-sources': { type: 'boolean', default: false },
      'no-sources': { type: 'boolean', default: false },
      url: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) return void console.log(HELP)
  if (values.apply) return applyBest(resolve(values.apply))
  if (values['fetch-sources']) {
    console.log('Scarico le fonti del correttore in bench/sources-cache/ (cartella ignorata da git):')
    const fetched = await fetchSources((line) => console.log(line))
    if (fetched.some((f) => !f.ok)) process.exitCode = 1
    return
  }
  if (!['role', 'on', 'off'].includes(values.think)) fail(`--think vuole role, on oppure off (ricevuto: ${values.think})`)
  if (!['auto', 'off'].includes(values.gpu)) fail(`--gpu vuole auto oppure off (ricevuto: ${values.gpu})`)
  const reps = Number(values.reps)
  const numCtx = Number(values['num-ctx'])
  const rounds = Number(values.rounds)
  if (!Number.isInteger(reps) || reps < 1) fail('--reps vuole un numero intero, almeno 1')
  if (!Number.isInteger(numCtx) || numCtx < 2048) fail('--num-ctx vuole un numero intero, almeno 2048')
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10) fail('--rounds vuole un numero intero tra 0 e 10')

  const role = values.role
  const baseline = values.variant ? loadVariant(resolve(values.variant)) : loadBaseline(role)
  const cases = loadCases(role, values.cases?.split(',').map((s) => s.trim()).filter(Boolean))
  const models = values.models?.split(',').map((s) => s.trim()).filter(Boolean) ?? (baseline.role.mind?.model ? [baseline.role.mind.model] : [])
  if (models.length === 0) fail('Indica almeno un modello con --models: il ruolo non ne consiglia uno.')
  const options: RunOptions = { ollamaUrl: values.url ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', models, reps, think: values.think as RunOptions['think'], numCtx, gpu: values.gpu as RunOptions['gpu'] }

  const perVariant = models.length * reps * cases.length
  const tests = models.length * reps * cases.filter((c) => c.split === 'test').length
  const total = perVariant + (rounds > 0 ? tests + rounds * perVariant : 0)
  console.log(`Ruolo ${role} · variante «${baseline.name}» · ${cases.length} casi × ${models.length} modelli × ${reps} ripetizioni = ${perVariant} esecuzioni per variante`)
  console.log(`Ollama: ${options.ollamaUrl} · ragionamento: ${options.think} · memoria: ${numCtx} · GPU: ${options.gpu === 'off' ? 'bloccata, solo CPU' : 'decide Ollama'}`)
  const judging = !values['no-judge'] && hasAnthropicKey()
  console.log(judging ? `Giudice: ${values['judge-model']} (richieste, istruzioni del ruolo e risposte dei modelli vengono inviate ad Anthropic)` : values['no-judge'] ? 'Giudice: disattivato' : 'Giudice: nessuno — manca ANTHROPIC_API_KEY; eseguo solo misure e controlli a regole fisse')
  if (rounds > 0 && !judging) fail('Il ciclo di correzione (--rounds) ha bisogno di Claude: imposta ANTHROPIC_API_KEY e non usare --no-judge.')
  if (rounds > 0) console.log(`Correzione: fino a ${rounds} giri; in tutto al massimo ${total} esecuzioni.`)
  // Le fonti del correttore: quelle già scaricate; se mancano, si scaricano ora (un errore non ferma il ciclo).
  let sources = rounds > 0 && !values['no-sources'] ? loadSources() : []
  if (rounds > 0 && !values['no-sources'] && !values['dry-run'] && sources.length < sourceList().length) {
    console.log('Scarico le fonti del correttore:')
    await fetchSources((line) => console.log(line))
    sources = loadSources()
  }
  if (rounds > 0) console.log(values['no-sources'] ? 'Fonti del correttore: nessuna (--no-sources)' : `Fonti del correttore: ${sources.length} di ${sourceList().length}, ${Math.round(sources.reduce((n, s) => n + s.text.length, 0) / 1000)} mila caratteri`)
  if (values['dry-run']) {
    for (const c of cases) console.log(`  ${c.split === 'train' ? 'lavoro   ' : 'controllo'}  ${c.id.padEnd(22)} atteso: ${c.expect.padEnd(9)} ${c.request.slice(0, 70)}`)
    console.log(`\nStima: da due a tre minuti per esecuzione con un modello a circa 10 token al secondo, quindi ${(Math.round((total * 2.5) / 6) / 10).toString().replace('.', ',')} ore circa.`)
    return
  }

  const startedAt = new Date().toISOString()
  const out = values.out ? resolve(values.out) : join(repo, 'bench', 'runs', startedAt.replace(/[:.]/g, '-').slice(0, 19))
  mkdirSync(out, { recursive: true })
  const variantDir = (name: string): string => join(out, 'variants', name)
  saveVariant(variantDir(baseline.name), baseline)
  const resultsPath = join(out, 'results.jsonl')
  const done = readResults(resultsPath)
  if (done.length) console.log(`Riprendo da ${out}: ${done.length} esecuzioni già fatte.`)

  const claude = judging ? createClaude(values['judge-model']) : null
  const judge = claude ? createJudge(claude.ask) : null
  let judgeFailure: string | null = null
  let executed = 0

  const run = (variant: Variant, subset: BenchCase[]): Promise<CaseResult[]> =>
    runVariant(variant, subset, options, {
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
      onResult(result) {
        appendFileSync(resultsPath, JSON.stringify(result) + '\n')
        executed++
        const ms = result.turns.reduce((n, t) => n + (t.measures.totalMs ?? 0), 0)
        const failed = result.checks.filter((c) => !c.pass).map((c) => c.id)
        console.log(`[${executed + done.length}/${total}] ${result.variant} · ${result.model} · ${result.case.id} · ${Math.round(ms / 1000)} s · controlli ${Math.round(passRate(result.checks) * 100)}%${failed.length ? ` (falliti: ${failed.join(', ')})` : ''}${result.verdict ? ` · giudice ${result.verdict.mean}/5` : ''}`)
      }
    })

  const outcome = await runLoop(baseline, cases, options, rounds, {
    run,
    log: (line) => console.log(line),
    onVariant: (variant) => saveVariant(variantDir(variant.name), variant),
    async propose(best, results, name, history) {
      // Ripresa: una variante già proposta in un giro precedente si rilegge, non si richiede di nuovo.
      const saved = join(variantDir(name), 'proposal.json')
      if (existsSync(saved)) {
        const { changes, diagnosis, documentNotes, examples } = JSON.parse(readFileSync(saved, 'utf8')) as { changes: string[]; diagnosis: string; documentNotes?: string[]; examples?: Array<{ title: string; source: string }> }
        return { changes, diagnosis, documentNotes, examples, outcome: { variant: loadVariant(variantDir(name)) } }
      }
      try {
        const proposed = await proposeVariant(claude!.ask, best, results, name, history, sources)
        if (!proposed) return null
        const examples = proposed.proposal.examples.map((e) => ({ title: e.title, source: e.source }))
        if ('variant' in proposed.outcome) {
          saveVariant(variantDir(name), proposed.outcome.variant)
          writeFileSync(saved, JSON.stringify({ changes: proposed.proposal.changes, diagnosis: proposed.proposal.diagnosis, documentNotes: proposed.proposal.documentNotes, examples }, null, 2) + '\n')
        }
        return { changes: proposed.proposal.changes, diagnosis: proposed.proposal.diagnosis, documentNotes: proposed.proposal.documentNotes, examples, outcome: proposed.outcome }
      } catch (err) {
        console.error(`Correttore non disponibile: ${describeAnthropicError(err)}`)
        return null
      }
    }
  })

  const notes = [...outcome.notes]
  if (outcome.best !== baseline) {
    writeFileSync(join(out, 'best.json'), JSON.stringify({ role, variant: outcome.best.name }, null, 2) + '\n')
    const diff = diffVariants(variantDir(baseline.name), variantDir(outcome.best.name))
    if (diff) writeFileSync(join(out, 'proposal.diff'), diff)
    notes.push(`Per portare la variante migliore nei sorgenti del repository: npm run bench -- --apply ${out}${diff ? ' (le differenze sono in proposal.diff)' : ''}`)
  }
  writeFileSync(join(out, 'report.md'), buildReport({ role, startedAt, options: { models, reps, think: options.think, numCtx, gpu: options.gpu, judge: claude && !judgeFailure ? claude.model : null, rounds }, results: outcome.results, notes }))
  if (claude) console.log(`Anthropic: ${claude.usage.calls} richieste, ${claude.usage.input} token in ingresso, ${claude.usage.output} in uscita`)
  for (const note of notes) console.log(`- ${note}`)
  console.log(`\nRapporto: ${join(out, 'report.md')}`)
}

main().catch((err: unknown) => fail(err instanceof BenchError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)))
