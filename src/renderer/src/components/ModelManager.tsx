import { useEffect, useState } from 'react'
import type { ModelSetting, OllamaModel } from '@shared/types'
import { useModels } from '../store/useModels'

const ALL_LAYERS = 999

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB`

/** Descrizione breve di num_gpu. */
export function describeNumGpu(numGpu: number | null): string {
  if (numGpu == null) return 'Automatico'
  if (numGpu === 0) return 'Solo CPU'
  if (numGpu >= ALL_LAYERS) return 'Tutto su GPU'
  return `${numGpu} layer su GPU`
}

/** Il test va (ri)fatto: mai fatto, oppure il modello è stato aggiornato dopo il test. */
export function needsBenchmark(model: OllamaModel | undefined, setting: ModelSetting | undefined): 'new' | 'updated' | null {
  if (!model) return null
  if (!setting?.benchmarkedAt) return setting?.dismissed ? null : 'new'
  if (setting.digest && model.digest && setting.digest !== model.digest) return 'updated'
  return null
}

/** Selettore dell'esecuzione: Automatico, Solo CPU, Tutto su GPU, oppure un numero di layer. */
export function NumGpuSelect({ model, compact = false }: { model: string; compact?: boolean }): React.JSX.Element {
  const setting = useModels((s) => s.modelSettings[model])
  const setModelSetting = useModels((s) => s.setModelSetting)
  const value = setting?.numGpu ?? null
  const mode = value == null ? 'auto' : value === 0 ? 'cpu' : value >= ALL_LAYERS ? 'gpu' : 'layers'
  const [layers, setLayers] = useState(mode === 'layers' ? String(value) : '')
  useEffect(() => setLayers(mode === 'layers' ? String(value) : ''), [mode, value])

  return (
    <span className="flex items-center gap-2">
      <select
        aria-label={`Esecuzione di ${model}`}
        className={'rounded border border-zinc-300 bg-white px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-900 ' + (compact ? 'w-36 text-xs' : 'text-sm')}
        value={mode}
        onChange={(e) => {
          const m = e.target.value
          const next = m === 'auto' ? null : m === 'cpu' ? 0 : m === 'gpu' ? ALL_LAYERS : Number(layers) || 16
          void setModelSetting(model, { numGpu: next })
        }}
        data-testid="num-gpu-select"
      >
        <option value="auto">{compact ? 'Automatico' : 'Automatico (decide Ollama)'}</option>
        <option value="cpu">Solo CPU</option>
        <option value="gpu">Tutto su GPU</option>
        <option value="layers">Layer su GPU…</option>
      </select>
      {mode === 'layers' && (
        <input
          type="number"
          min={1}
          max={998}
          aria-label="Layer su GPU"
          className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          value={layers}
          onChange={(e) => setLayers(e.target.value)}
          onBlur={() => {
            const n = Number(layers)
            if (Number.isFinite(n) && n > 0) void setModelSetting(model, { numGpu: n })
          }}
        />
      )}
    </span>
  )
}

/** Risultati del test CPU/GPU di un modello. */
export function BenchmarkTable({ setting }: { setting: ModelSetting }): React.JSX.Element | null {
  if (!setting.benchmark?.length) return null
  const fmt = (n: number | null): string => (n == null ? '—' : n.toLocaleString('it-IT', { maximumFractionDigits: 1 }))
  return (
    <table className="mt-1 w-full text-xs" data-testid="benchmark-table">
      <thead className="text-zinc-500">
        <tr>
          <th className="text-left font-normal">Configurazione</th>
          <th className="text-right font-normal">Scrittura tok/s</th>
          <th className="text-right font-normal">Lettura tok/s</th>
          <th className="text-right font-normal">In GPU</th>
        </tr>
      </thead>
      <tbody>
        {setting.benchmark.map((r) => (
          <tr key={r.label} className={r.numGpu === setting.numGpu ? 'font-medium text-brand-700 dark:text-brand-300' : ''}>
            <td>
              {r.label}
              {r.numGpu === setting.numGpu ? ' ✓' : ''}
            </td>
            <td className="text-right tabular-nums">{r.error ? 'errore' : fmt(r.evalTps)}</td>
            <td className="text-right tabular-nums">{r.error ? '' : fmt(r.promptTps)}</td>
            <td className="text-right tabular-nums">{r.vramShare == null ? '—' : `${Math.round(r.vramShare * 100)}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Avanzamento del test, o pulsante per avviarlo. */
export function BenchmarkButton({ model, label = 'Esegui test CPU/GPU' }: { model: string; label?: string }): React.JSX.Element {
  const progress = useModels((s) => s.benchmarks[model])
  const benchmark = useModels((s) => s.benchmark)
  const [error, setError] = useState<string | null>(null)
  if (progress) {
    return (
      <span role="status" className="text-xs text-brand-700 dark:text-brand-300" data-testid="benchmark-progress">
        Test {Math.max(1, progress.step)}/{progress.steps}: {progress.label}…
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-0.5">
      <button
        type="button"
        className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        title="Prova solo CPU, tutto su GPU e metà dei layer con la stessa domanda, misura la velocità e sceglie la più veloce (1–2 minuti)"
        onClick={() => {
          setError(null)
          void benchmark(model).then(setError)
        }}
        data-testid="benchmark-run"
      >
        {label}
      </button>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </span>
  )
}

/** Impostazioni → Modelli: elenco, esecuzione per modello, test, download ed eliminazione. */
export function ModelManager(): React.JSX.Element {
  const { models, modelSettings, pulls, pull, removeModel } = useModels()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const downloading = Object.values(pulls)

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="model-manager">
      <EmbeddingModelField />
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          const n = name.trim()
          if (!n) return
          setError(null)
          setName('')
          void pull(n).then(setError)
        }}
      >
        <span className="font-medium">Scarica un modello</span>
        <div className="flex gap-2">
          <input
            aria-label="Nome del modello da scaricare"
            placeholder="es. qwen3:8b, gemma3:12b"
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="rounded-lg border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Scarica
          </button>
        </div>
        <span className="text-xs text-zinc-500">Nomi dalla libreria di Ollama (ollama.com/library). Dopo il download, conviene fare il test CPU/GPU.</span>
        {downloading.map((p) => (
          <span key={p.model} className="text-xs text-brand-700 dark:text-brand-300" data-testid="pull-progress">
            {p.model}: {p.status}
            {p.total ? ` · ${Math.round(((p.completed ?? 0) / p.total) * 100)}%` : ''}
          </span>
        ))}
        {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
      </form>

      <ul className="flex flex-col gap-3" aria-label="Modelli installati">
        {models.map((m) => {
          const setting = modelSettings[m.name]
          const need = needsBenchmark(m, setting)
          return (
            <li key={m.name} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" data-testid="model-row">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-zinc-500">
                  {[m.parameterSize, m.quantization, gb(m.size)].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-500">Esecuzione</span>
                <NumGpuSelect model={m.name} />
                <BenchmarkButton model={m.name} label={setting?.benchmarkedAt ? 'Ripeti il test' : 'Esegui test CPU/GPU'} />
                <button
                  type="button"
                  className="ml-auto text-xs text-red-700 hover:underline dark:text-red-400"
                  onClick={() => {
                    if (window.confirm(`Eliminare ${m.name} da Ollama? Il file del modello viene cancellato dal disco.`)) void removeModel(m.name).then(setError)
                  }}
                >
                  Elimina
                </button>
              </div>
              {need === 'updated' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Modello aggiornato dopo il test: conviene ripeterlo.</p>}
              {setting?.benchmarkedAt && setting.gpuAvailable === false && (
                <p className="mt-1 text-xs text-zinc-500">Ollama non usa la GPU per questo modello (driver o Vulkan non attivi): va tutto in CPU.</p>
              )}
              {setting && <BenchmarkTable setting={setting} />}
            </li>
          )
        })}
        {models.length === 0 && <li className="text-zinc-500">Nessun modello installato.</li>}
      </ul>
    </div>
  )
}

/** Modello per la memoria delle conversazioni (embedding). */
function EmbeddingModelField(): React.JSX.Element {
  const { settings, models, saveSettings, pull, pulls } = useModels()
  const current = settings?.embeddingModel ?? 'embeddinggemma'
  const [draft, setDraft] = useState(current)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(current), [current])
  const installed = models.some((m) => m.name === current || m.name === `${current}:latest`)
  const progress = pulls[current]
  return (
    <div className="flex flex-col gap-1" data-testid="embedding-model">
      <span className="font-medium">Modello per la memoria delle conversazioni</span>
      <div className="flex gap-2">
        <input
          aria-label="Modello di embedding"
          list="embedding-models"
          className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim()
            if (v && v !== current) void saveSettings({ embeddingModel: v }).then(setError)
          }}
        />
        <datalist id="embedding-models">
          {['embeddinggemma', 'bge-m3', ...models.map((m) => m.name)].map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {!installed && (
          <button
            type="button"
            disabled={!!progress}
            className="rounded-lg border border-zinc-300 px-3 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => void pull(current).then(setError)}
          >
            {progress ? 'Scarico…' : 'Scarica'}
          </button>
        )}
      </div>
      <span className="text-xs text-zinc-500">
        {installed ? 'Installato. ' : 'Non installato: scaricalo per usare la memoria. '}
        Serve un modello multilingue (embeddinggemma è leggero; bge-m3 più preciso e più pesante). Cambiandolo, l'indice delle conversazioni si rifà.
      </span>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </div>
  )
}
