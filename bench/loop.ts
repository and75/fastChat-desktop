// Il ciclo «valuta, corregge e riprova»: si misura la variante di partenza, poi a ogni giro Claude propone una
// variante leggendo i soli casi di lavoro; la si prova e la si tiene soltanto se migliora sui casi di controllo
// più di quanto la stessa variante oscilli da sola tra due esecuzioni.
import { headline, summarize } from './report'
import type { BenchCase, CaseResult, RunOptions, Variant } from './types'

export interface LoopDeps {
  /** Esegue una variante su tutti i casi indicati (e la giudica, se c'è un giudice). */
  run(variant: Variant, cases: BenchCase[]): Promise<CaseResult[]>
  /** Chiede la variante successiva; null se il correttore non risponde. */
  propose(best: Variant, results: CaseResult[], name: string, history: string[]): Promise<{ changes: string[]; diagnosis: string; documentNotes?: string[]; outcome: { variant: Variant } | { rejected: string } } | null>
  /** Una variante accettata come candidata: da salvare su disco prima di provarla. */
  onVariant?(variant: Variant): void | Promise<void>
  log?(line: string): void
}

export interface LoopOutcome {
  results: CaseResult[]
  best: Variant
  /** Il racconto del ciclo, una riga per fatto: finisce nel rapporto. */
  notes: string[]
}

/** Differenza minima, sul numero di confronto (0–1), sotto la quale due varianti si considerano pari. */
export const MIN_GAIN = 0.03

/** Il numero di confronto di una variante su un gruppo di casi: media tra i modelli (voto del giudice, o controlli). */
export function scoreOf(results: CaseResult[], variant: string, models: string[], split: 'train' | 'test'): number | null {
  const values = models.map((model) => headline(summarize(results, variant, model, split))).filter((v): v is number => v != null)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

const pct = (value: number | null): string => (value == null ? '—' : `${Math.round(value * 100)}%`)

export async function runLoop(baseline: Variant, cases: BenchCase[], options: Pick<RunOptions, 'models'>, rounds: number, deps: LoopDeps): Promise<LoopOutcome> {
  const log = deps.log ?? (() => undefined)
  const notes: string[] = []
  const results: CaseResult[] = []
  const test = cases.filter((c) => c.split === 'test')

  results.push(...(await deps.run(baseline, cases)))
  let best = baseline
  let bestScore = scoreOf(results, baseline.name, options.models, 'test')
  notes.push(`Variante di partenza «${baseline.name}»: ${pct(bestScore)} sui casi di controllo, ${pct(scoreOf(results, baseline.name, options.models, 'train'))} sui casi di lavoro.`)
  if (rounds <= 0) return { results, best, notes }
  if (test.length === 0 || bestScore == null) {
    notes.push('Nessun caso di controllo valutabile: senza un confronto il ciclo di correzione non parte.')
    return { results, best, notes }
  }

  // Il rumore: la stessa variante, eseguita di nuovo sui casi di controllo. Un miglioramento conta solo oltre.
  const again: Variant = { ...baseline, name: `${baseline.name}-bis` }
  results.push(...(await deps.run(again, test)))
  const repeat = scoreOf(results, again.name, options.models, 'test')
  const noise = repeat == null ? 0 : Math.abs(repeat - bestScore)
  const threshold = Math.max(noise, MIN_GAIN)
  notes.push(`Stessa variante eseguita due volte sui casi di controllo: ${pct(bestScore)} e ${pct(repeat)}. Un miglioramento conta se supera ${Math.round(threshold * 100)} punti.`)

  const history: string[] = []
  for (let round = 1; round <= rounds; round++) {
    const name = `giro-${round}`
    log(`Giro ${round}/${rounds}: chiedo una correzione…`)
    const proposed = await deps.propose(best, results, name, history)
    if (!proposed) {
      notes.push(`Giro ${round}: il correttore non ha risposto. Ciclo interrotto.`)
      break
    }
    for (const note of proposed.documentNotes ?? []) notes.push(`Giro ${round}, segnalazione sui documenti (non applicata, da valutare a mano): ${note}`)
    if ('rejected' in proposed.outcome) {
      notes.push(`Giro ${round}: proposta scartata prima della prova (${proposed.outcome.rejected}). Diagnosi: ${proposed.diagnosis}`)
      history.push(`Proposta non accettabile (${proposed.outcome.rejected}).`)
      continue
    }
    const candidate = proposed.outcome.variant
    await deps.onVariant?.(candidate)
    results.push(...(await deps.run(candidate, cases)))
    const score = scoreOf(results, candidate.name, options.models, 'test')
    const kept = score != null && score > bestScore + threshold
    const changes = proposed.changes.join(' ')
    notes.push(`Giro ${round}, variante «${name}»: ${pct(score)} sui casi di controllo contro ${pct(bestScore)} — ${kept ? '**tenuta**' : 'scartata'}. Diagnosi: ${proposed.diagnosis} Modifiche: ${changes}`)
    history.push(`${changes} → ${kept ? 'ha migliorato i casi di controllo, tenuta' : 'non ha migliorato i casi di controllo, scartata'}.`)
    if (kept) {
      best = candidate
      bestScore = score
    }
  }
  notes.push(best === baseline ? 'Esito: nessuna variante ha fatto meglio di quella di partenza sui casi di controllo. I testi del repository restano i migliori.' : `Esito: la variante migliore è «${best.name}» (${pct(bestScore)} sui casi di controllo).`)
  return { results, best, notes }
}
