import { useEffect, useState } from 'react'
import { fmtNum, t } from '@shared/i18n'
import type { ModelSetting, OllamaModel } from '@shared/types'
import { useModels } from '../store/useModels'

const ALL_LAYERS = 999

const gb = (bytes: number): string => `${fmtNum(bytes / 1024 ** 3, 1)} GB`

/** Descrizione breve di num_gpu. */
export function describeNumGpu(numGpu: number | null): string {
  if (numGpu == null) return t('gpu.auto')
  if (numGpu === 0) return t('gpu.cpu')
  if (numGpu >= ALL_LAYERS) return t('gpu.gpu')
  return t('gpu.layers', { n: numGpu })
}

/** Etichetta di una configurazione del test: le chiamate salvate hanno una chiave (`cpu`, `gpu`, `half:N`), quelle vecchie il testo. */
export function benchLabel(r: { label: string; numGpu?: number | null }): string {
  if (r.label === 'cpu') return t('bench.label.cpu')
  if (r.label === 'gpu') return t('bench.label.gpu')
  if (r.label.startsWith('half:')) return t('bench.label.half', { n: r.label.slice(5) })
  if (r.label === 'prepare') return t('bench.step.prepare')
  return r.label
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
        aria-label={t('gpu.execOf', { model })}
        className={'rounded border border-zinc-300 bg-white px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-900 ' + (compact ? 'w-36 text-xs' : 'text-sm')}
        value={mode}
        onChange={(e) => {
          const m = e.target.value
          const next = m === 'auto' ? null : m === 'cpu' ? 0 : m === 'gpu' ? ALL_LAYERS : Number(layers) || 16
          void setModelSetting(model, { numGpu: next })
        }}
        data-testid="num-gpu-select"
      >
        <option value="auto">{compact ? t('gpu.auto') : t('gpu.autoLong')}</option>
        <option value="cpu">{t('gpu.cpu')}</option>
        <option value="gpu">{t('gpu.gpu')}</option>
        <option value="layers">{t('gpu.layersOption')}</option>
      </select>
      {mode === 'layers' && (
        <input
          type="number"
          min={1}
          max={998}
          aria-label={t('gpu.layersLabel')}
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
  const fmt = (n: number | null): string => (n == null ? '—' : fmtNum(n, 1))
  return (
    <table className="mt-1 w-full text-xs" data-testid="benchmark-table">
      <thead className="text-zinc-500">
        <tr>
          <th className="text-left font-normal">{t('bench.config')}</th>
          <th className="text-right font-normal">{t('bench.write')}</th>
          <th className="text-right font-normal">{t('bench.read')}</th>
          <th className="text-right font-normal">{t('bench.inGpu')}</th>
        </tr>
      </thead>
      <tbody>
        {setting.benchmark.map((r) => (
          <tr key={r.label} className={r.numGpu === setting.numGpu ? 'font-medium text-brand-700 dark:text-brand-300' : ''}>
            <td>
              {benchLabel(r)}
              {r.numGpu === setting.numGpu ? ' ✓' : ''}
            </td>
            <td className="text-right tabular-nums">{r.error ? t('bench.error') : fmt(r.evalTps)}</td>
            <td className="text-right tabular-nums">{r.error ? '' : fmt(r.promptTps)}</td>
            <td className="text-right tabular-nums">{r.vramShare == null ? '—' : `${Math.round(r.vramShare * 100)}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Avanzamento del test, o pulsante per avviarlo. */
export function BenchmarkButton({ model, label }: { model: string; label?: string }): React.JSX.Element {
  const progress = useModels((s) => s.benchmarks[model])
  const benchmark = useModels((s) => s.benchmark)
  const [error, setError] = useState<string | null>(null)
  if (progress) {
    return (
      <span role="status" className="text-xs text-brand-700 dark:text-brand-300" data-testid="benchmark-progress">
        {t('bench.progress', { step: Math.max(1, progress.step), steps: progress.steps, label: benchLabel(progress) })}
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-0.5">
      <button
        type="button"
        className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        title={t('bench.title')}
        onClick={() => {
          setError(null)
          void benchmark(model).then(setError)
        }}
        data-testid="benchmark-run"
      >
        {label ?? t('bench.run')}
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
        <span className="font-medium">{t('models.download')}</span>
        <div className="flex gap-2">
          <input
            aria-label={t('models.downloadName')}
            placeholder={t('models.downloadPlaceholder')}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="rounded-lg border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            {t('models.downloadButton')}
          </button>
        </div>
        <span className="text-xs text-zinc-500">{t('models.downloadHint')}</span>
        {downloading.map((p) => (
          <span key={p.model} className="text-xs text-brand-700 dark:text-brand-300" data-testid="pull-progress">
            {p.model}: {p.status}
            {p.total ? ` · ${Math.round(((p.completed ?? 0) / p.total) * 100)}%` : ''}
          </span>
        ))}
        {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
      </form>

      <ul className="flex flex-col gap-3" aria-label={t('models.installed')}>
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
                <span className="text-xs text-zinc-500">{t('models.execution')}</span>
                <NumGpuSelect model={m.name} />
                <BenchmarkButton model={m.name} label={setting?.benchmarkedAt ? t('bench.repeat') : t('bench.run')} />
                <button
                  type="button"
                  className="ml-auto text-xs text-red-700 hover:underline dark:text-red-400"
                  onClick={() => {
                    if (window.confirm(t('models.delete.confirm', { model: m.name }))) void removeModel(m.name).then(setError)
                  }}
                >
                  {t('models.delete')}
                </button>
              </div>
              {need === 'updated' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('models.updatedAfterTest')}</p>}
              {setting?.benchmarkedAt && setting.gpuAvailable === false && (
                <p className="mt-1 text-xs text-zinc-500">{t('models.noGpu')}</p>
              )}
              {setting && <BenchmarkTable setting={setting} />}
            </li>
          )
        })}
        {models.length === 0 && <li className="text-zinc-500">{t('models.none')}</li>}
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
      <span className="font-medium">{t('embedding.title')}</span>
      <div className="flex gap-2">
        <input
          aria-label={t('embedding.label')}
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
            {progress ? t('embedding.downloading') : t('embedding.download')}
          </button>
        )}
      </div>
      <span className="text-xs text-zinc-500">
        {installed ? t('embedding.installed') : t('embedding.notInstalled')}
        {t('embedding.hint')}
      </span>
      {error && <span className="text-xs text-red-700 dark:text-red-400">{error}</span>}
    </div>
  )
}
