// Test CPU/GPU per modello: la stessa richiesta con configurazioni diverse di num_gpu, misurando la velocità
import { t } from '@shared/i18n'
// reale (tempi restituiti da Ollama) e dove è finito davvero il modello (/api/ps).
import { MIN_NUM_CTX } from '@shared/settings'
import type { BenchmarkRun, ContextRun, ModelCapabilities } from '@shared/types'
import type { ChatRequest, OllamaClient } from './ollama'

/** Testo fisso (~300 token) per misurare anche la lettura del prompt. */
const BENCH_TEXT =
  'La memoria di un modello linguistico locale è condivisa tra i pesi del modello e la cache del contesto. ' +
  'Quando la conversazione cresce, la cache occupa sempre più spazio, e il sistema deve decidere se tenere ' +
  'il modello sulla scheda grafica, sul processore o dividerlo tra i due. Ogni scelta ha costi diversi: la ' +
  'scheda grafica è veloce nei calcoli in parallelo ma ha poca memoria, il processore ha accesso a tutta la ' +
  'memoria di sistema ma calcola più lentamente, e la divisione tra i due aggiunge il costo dei trasferimenti. '

export const BENCH_PROMPT = `${BENCH_TEXT.repeat(3)}\n\nRiassumi il testo qui sopra in tre frasi.`

/** Valore di num_gpu per "tutto su GPU": Ollama lo limita al numero di layer del modello. */
export const ALL_LAYERS = 999

/** Memoria (num_ctx) della prima fase del test: piccola, per confrontare CPU e GPU a parità di condizioni. */
export const BENCH_NUM_CTX = 2048
/** Con una memoria più grande la velocità di scrittura può calare al massimo di questa quota… */
export const CTX_MAX_SLOWDOWN = 0.15
/** …e la quota del modello in GPU al massimo di questa: oltre, Ollama lo sta spostando sulla CPU. */
export const CTX_MAX_GPU_DROP = 0.05

export interface BenchmarkResult {
  runs: BenchmarkRun[]
  /** num_gpu della configurazione più veloce nella scrittura. */
  best: number
  gpuAvailable: boolean
  /** Seconda fase: la configurazione scelta provata con memorie crescenti, fino alla prima che rallenta. */
  contextRuns: ContextRun[]
  /** Tetto consigliato per la memoria; null se la seconda fase non si è potuta fare. */
  ctxLimit: number | null
}

/** Le memorie da provare: potenze di due sopra quella della prima fase, fino al massimo indicato. */
export function contextLadder(maxCtx: number | null | undefined): number[] {
  const out: number[] = []
  for (let n = BENCH_NUM_CTX * 2; maxCtx != null && n <= maxCtx; n *= 2) out.push(n)
  return out
}

/** Una memoria «regge» se la scrittura non rallenta oltre la soglia e il modello non scivola fuori dalla GPU. */
export function contextHolds(baseline: Pick<BenchmarkRun, 'evalTps' | 'vramShare'>, run: Pick<ContextRun, 'evalTps' | 'vramShare' | 'error'>): boolean {
  if (run.error || run.evalTps == null || baseline.evalTps == null) return false
  if (run.evalTps < baseline.evalTps * (1 - CTX_MAX_SLOWDOWN)) return false
  return baseline.vramShare == null || run.vramShare == null || run.vramShare >= baseline.vramShare - CTX_MAX_GPU_DROP
}

/**
 * Il tetto della memoria, dalle prove della seconda fase. Se una memoria non regge, il tetto sta un gradino
 * sotto l'ultima che reggeva: è l'abbattimento di sicurezza, perché durante l'uso la memoria della macchina
 * serve anche ad altro. Se reggono tutte, il tetto è la più grande provata (cioè nessuna riduzione). Mai sotto
 * `floor`, la memoria minima consigliata per il modello. null senza prove.
 */
export function pickCtxLimit(runs: ContextRun[], floor: number = MIN_NUM_CTX): number | null {
  if (runs.length === 0) return null
  const failed = runs.findIndex((r) => !r.ok)
  if (failed < 0) return runs.at(-1)!.numCtx
  const lastGood = failed > 0 ? runs[failed - 1].numCtx : BENCH_NUM_CTX
  return Math.max(floor, MIN_NUM_CTX, lastGood / 2)
}

/** Configurazioni da provare: solo CPU, tutto su GPU, e metà dei layer se il numero è noto. */
export function benchmarkConfigs(caps: ModelCapabilities | null): Array<{ label: string; numGpu: number }> {
  const configs = [
    { label: 'cpu', numGpu: 0 },
    { label: 'gpu', numGpu: ALL_LAYERS }
  ]
  const layers = caps?.layers ?? null
  if (layers && layers >= 4) configs.push({ label: `half:${Math.floor(layers / 2)}`, numGpu: Math.floor(layers / 2) })
  return configs
}

const tps = (count: number | null, ms: number | null): number | null =>
  count && ms && ms > 0 ? Math.round((count / ms) * 1000 * 10) / 10 : null

/** Sceglie la configurazione più veloce nella scrittura; a parità (entro il 5%) la CPU, che non occupa la GPU. */
export function pickBest(runs: BenchmarkRun[], gpuAvailable: boolean): number {
  const valid = runs.filter((r) => r.evalTps != null && !r.error && (r.numGpu === 0 || gpuAvailable))
  if (valid.length === 0) return 0
  const cpu = valid.find((r) => r.numGpu === 0)
  const fastest = valid.reduce((a, b) => (b.evalTps! > a.evalTps! ? b : a))
  if (cpu && fastest.numGpu !== 0 && fastest.evalTps! <= cpu.evalTps! * 1.05) return 0
  return fastest.numGpu
}

export async function runBenchmark(
  ollama: OllamaClient,
  model: string,
  caps: ModelCapabilities | null,
  onStep: (step: number, steps: number, label: string) => void,
  signal?: AbortSignal,
  /** `maxCtx`: fin dove provare la memoria (di norma quella che l'app suggerirebbe); `minCtx`: sotto cui il tetto non scende. */
  context: { maxCtx?: number | null; minCtx?: number } = {}
): Promise<BenchmarkResult> {
  const configs = benchmarkConfigs(caps)
  const ladder = contextLadder(context.maxCtx)
  const steps = configs.length + ladder.length
  const shareOf = async (): Promise<number | null> => {
    const loaded = (await ollama.loadedModels().catch(() => [])).find((m) => m.name === model)
    return loaded && loaded.size > 0 ? Math.round((loaded.sizeVram / loaded.size) * 100) / 100 : null
  }
  const requestFor = (numGpu: number, numCtx: number): ChatRequest => {
    const request: ChatRequest = { model, messages: [{ role: 'user', content: BENCH_PROMPT }], options: { num_gpu: numGpu, num_ctx: numCtx, num_predict: 96, temperature: 0, seed: 42 } }
    if (caps?.thinking) request.think = false
    return request
  }
  const runs: BenchmarkRun[] = []
  let gpuAvailable = false
  for (let i = 0; i < configs.length; i++) {
    const { label, numGpu } = configs[i]
    // Senza GPU utilizzabile la divisione a metà è inutile.
    if (i === 2 && !gpuAvailable) break
    onStep(i + 1, steps, label)
    try {
      const r = await ollama.chatStream(requestFor(numGpu, BENCH_NUM_CTX), {}, signal)
      if (r.aborted) throw new Error(t('err.benchAborted'))
      const vramShare = await shareOf()
      if (numGpu > 0 && vramShare != null && vramShare > 0) gpuAvailable = true
      runs.push({ label, numGpu, promptTps: tps(r.promptEvalCount, r.promptEvalMs), evalTps: tps(r.evalCount, r.evalMs), loadMs: r.loadMs, vramShare })
    } catch (err) {
      if (signal?.aborted) throw err
      runs.push({ label, numGpu, promptTps: null, evalTps: null, loadMs: null, vramShare: null, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const best = pickBest(runs, gpuAvailable)

  // Seconda fase: la configurazione scelta, con memorie crescenti. Ci si ferma alla prima che non regge: oltre
  // quel punto la velocità non torna, e caricare memorie ancora più grandi costerebbe solo tempo.
  const baseline = runs.find((r) => r.numGpu === best && !r.error && r.evalTps != null)
  const contextRuns: ContextRun[] = []
  for (let i = 0; baseline && i < ladder.length; i++) {
    const numCtx = ladder[i]
    onStep(configs.length + i + 1, steps, `ctx:${numCtx}`)
    let run: ContextRun
    try {
      const r = await ollama.chatStream(requestFor(best, numCtx), {}, signal)
      if (r.aborted) throw new Error(t('err.benchAborted'))
      const measured = { numCtx, promptTps: tps(r.promptEvalCount, r.promptEvalMs), evalTps: tps(r.evalCount, r.evalMs), loadMs: r.loadMs, vramShare: await shareOf() }
      run = { ...measured, ok: contextHolds(baseline, measured) }
    } catch (err) {
      if (signal?.aborted) throw err
      run = { numCtx, promptTps: null, evalTps: null, loadMs: null, vramShare: null, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    contextRuns.push(run)
    if (!run.ok) break
  }
  return { runs, best, gpuAvailable, contextRuns, ctxLimit: pickCtxLimit(contextRuns, context.minCtx) }
}
