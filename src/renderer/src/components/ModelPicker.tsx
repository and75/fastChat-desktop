import { useEffect } from 'react'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { useModels } from '../store/useModels'

function formatSize(bytes: number): string {
  if (!bytes) return ''
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * Selettore del modello. Con una conversazione aperta cambia il modello di quella conversazione
 * (e lo ricorda come predefinito per le nuove); altrimenti imposta solo il predefinito.
 */
export function ModelPicker(): React.JSX.Element {
  const { models, selected: defaultModel, status, capabilities, select, refresh, loadCapabilities } = useModels()
  const conversation = useChat((s) => s.conversation)
  const update = useConversations((s) => s.update)

  const value = conversation ? conversation.model : defaultModel
  const caps = value ? capabilities[value] : undefined
  const current = models.find((m) => m.name === value)
  const missing = !!value && status === 'ready' && !current

  useEffect(() => {
    if (value) void loadCapabilities(value)
  }, [value, loadCapabilities])

  const onChange = (name: string): void => {
    void select(name)
    if (conversation) void update(conversation.id, { model: name })
  }

  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="model-picker">
      <label htmlFor="model-select" className="text-sm text-zinc-500">
        Modello
      </label>
      <select
        id="model-select"
        className="w-48 min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        value={value ?? ''}
        title={current ? [current.name, current.parameterSize, current.quantization, formatSize(current.size)].filter(Boolean).join(' · ') : undefined}
        disabled={status !== 'ready' || models.length === 0}
        onChange={(e) => onChange(e.target.value)}
      >
        {(!value || missing) && (
          <option value={value ?? ''} disabled>
            {status === 'loading' ? 'Caricamento…' : missing ? `${value} (non installato)` : 'Scegli un modello'}
          </option>
        )}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>

      {current && (
        <span className="hidden whitespace-nowrap text-xs text-zinc-500 2xl:inline">
          {[current.parameterSize, current.quantization, formatSize(current.size)].filter(Boolean).join(' · ')}
        </span>
      )}

      {caps && (
        <span
          data-testid="thinking-capability"
          className={
            'whitespace-nowrap rounded-full px-2 py-0.5 text-xs ' +
            (caps.thinking
              ? 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
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
