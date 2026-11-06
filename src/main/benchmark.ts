// Test CPU/GPU per modello: la stessa richiesta con configurazioni diverse di num_gpu, misurando la velocità
// reale (tempi restituiti da Ollama) e dove è finito davvero il modello (/api/ps).
import type { BenchmarkRun, ModelCapabilities } from '@shared/types'
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

export interface BenchmarkResult {
  runs: BenchmarkRun[]
  /** num_gpu della configurazione più veloce nella scrittura. */
  best: number
  gpuAvailable: boolean
}

/** Configurazioni da provare: solo CPU, tutto su GPU, e metà dei layer se il numero è noto. */
export function benchmarkConfigs(caps: ModelCapabilities | null): Array<{ label: string; numGpu: number }> {
  const configs = [
    { label: 'Solo CPU', numGpu: 0 },
    { label: 'Tutto su GPU', numGpu: ALL_LAYERS }
  ]
  const layers = caps?.layers ?? null
  if (layers && layers >= 4) configs.push({ label: `Metà su GPU (${Math.floor(layers / 2)} layer)`, numGpu: Math.floor(layers / 2) })
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
  signal?: AbortSignal
): Promise<BenchmarkResult> {
  const configs = benchmarkConfigs(caps)
  const runs: BenchmarkRun[] = []
  let gpuAvailable = false
  for (let i = 0; i < configs.length; i++) {
    const { label, numGpu } = configs[i]
    // Senza GPU utilizzabile la divisione a metà è inutile.
    if (i === 2 && !gpuAvailable) break
    onStep(i + 1, configs.length, label)
    const request: ChatRequest = {
      model,
      messages: [{ role: 'user', content: BENCH_PROMPT }],
      options: { num_gpu: numGpu, num_ctx: 2048, num_predict: 96, temperature: 0, seed: 42 }
    }
    if (caps?.thinking) request.think = false
    try {
      const r = await ollama.chatStream(request, {}, signal)
      if (r.aborted) throw new Error('Test interrotto')
      const loaded = (await ollama.loadedModels().catch(() => [])).find((m) => m.name === model)
      const vramShare = loaded && loaded.size > 0 ? Math.round((loaded.sizeVram / loaded.size) * 100) / 100 : null
      if (numGpu > 0 && vramShare != null && vramShare > 0) gpuAvailable = true
      runs.push({ label, numGpu, promptTps: tps(r.promptEvalCount, r.promptEvalMs), evalTps: tps(r.evalCount, r.evalMs), loadMs: r.loadMs, vramShare })
    } catch (err) {
      if (signal?.aborted) throw err
      runs.push({ label, numGpu, promptTps: null, evalTps: null, loadMs: null, vramShare: null, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { runs, best: pickBest(runs, gpuAvailable), gpuAvailable }
}
