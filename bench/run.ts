// Esegue i casi di prova di una variante su uno o più modelli e raccoglie, per ogni caso, le battute, le misure
// e i controlli a regole fisse.
import { runChecks, splitAnswer } from './checks'
import { createBench } from './harness'
import type { BenchCase, CaseResult, RunOptions, Turn, Variant, Verdict } from './types'

export interface RunHooks {
  /** Risultati già presenti (ripresa di un giro interrotto): quei casi non si rieseguono. */
  done?: CaseResult[]
  /** Chiamato a ogni caso concluso: per scrivere results.jsonl man mano e mostrare l'avanzamento. */
  onResult?(result: CaseResult, progress: { index: number; total: number }): void | Promise<void>
  /** Il giudice, se c'è: valuta il caso appena eseguito. */
  judge?(result: CaseResult, variant: Variant): Promise<Verdict | null>
}

const sameRun = (a: CaseResult, variant: string, model: string, rep: number, id: string): boolean => a.variant === variant && a.model === model && a.rep === rep && a.case.id === id

/** Tutti i casi, su tutti i modelli, per il numero di ripetizioni chiesto. Un caso che fallisce non ferma gli altri. */
export async function runVariant(variant: Variant, cases: BenchCase[], options: RunOptions, hooks: RunHooks = {}): Promise<CaseResult[]> {
  const out: CaseResult[] = []
  const total = options.models.length * options.reps * cases.length
  let index = 0
  const bench = await createBench(variant, options)
  try {
    for (const model of options.models) {
      for (let rep = 1; rep <= options.reps; rep++) {
        for (const testCase of cases) {
          index++
          const previous = hooks.done?.find((r) => sameRun(r, variant.name, model, rep, testCase.id))
          if (previous) {
            out.push(previous)
            continue
          }
          const result: CaseResult = { variant: variant.name, model, rep, case: testCase, choices: bench.choices(testCase.choices), settings: { think: false, numCtx: null, temperature: null, gpuShare: null, loadedCtx: null }, turns: [], checks: [], verdict: null, error: null }
          try {
            const conv = await bench.open(model, testCase.choices, options)
            result.settings = { think: conv.think, numCtx: conv.numCtx, temperature: conv.temperature, gpuShare: null, loadedCtx: null }
            const first: Turn = await bench.say(conv, testCase.request)
            result.turns.push(first)
            // Se l'Esperto ha fatto domande e il caso prevede la risposta dell'utente, la conversazione prosegue.
            if (testCase.reply && !first.error && splitAnswer(first.answer).blocks.length === 0) result.turns.push(await bench.say(conv, testCase.reply))
            // Subito dopo la risposta il modello è ancora caricato: Ollama dice quanta parte sta in GPU.
            Object.assign(result.settings, await bench.execution(model))
          } catch (err) {
            result.error = err instanceof Error ? err.message : String(err)
          }
          result.checks = result.error ? [{ id: 'eseguito', pass: false, detail: result.error }] : runChecks(testCase, result.choices, result.turns)
          if (!result.error && hooks.judge) result.verdict = await hooks.judge(result, variant).catch(() => null)
          out.push(result)
          await hooks.onResult?.(result, { index, total })
        }
      }
    }
  } finally {
    bench.close()
  }
  return out
}
