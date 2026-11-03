import { useModels } from '../store/useModels'

function formatSize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function ModelPicker(): React.JSX.Element {
  const { models, selected, status, capabilities, select, refresh } = useModels()
  const caps = selected ? capabilities[selected] : undefined
  const current = models.find((m) => m.name === selected)

  return (
    <div className="flex items-center gap-2" data-testid="model-picker">
      <label htmlFor="model-select" className="text-sm text-zinc-500">
        Modello
      </label>
      <select
        id="model-select"
        className="min-w-48 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        value={selected ?? ''}
        disabled={status !== 'ready' || models.length === 0}
        onChange={(e) => void select(e.target.value)}
      >
        {models.length === 0 && <option value="">{status === 'loading' ? 'Caricamento…' : 'Nessun modello'}</option>}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>

      {current && (
        <span className="text-xs text-zinc-500">
          {[current.parameterSize, current.quantization, formatSize(current.size)].filter(Boolean).join(' · ')}
        </span>
      )}

      {caps && (
        <span
          data-testid="thinking-capability"
          className={
            'rounded-full px-2 py-0.5 text-xs ' +
            (caps.thinking
              ? 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')
          }
          title={caps.capabilities.join(', ')}
        >
          {caps.thinking ? 'ragionamento' : 'senza ragionamento'}
        </span>
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        title="Aggiorna elenco modelli"
      >
        ↻
      </button>
    </div>
  )
}
