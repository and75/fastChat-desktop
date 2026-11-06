import { useEffect, useState } from 'react'
import type { OllamaEnvInfo } from '@shared/api'
import { useModels } from '../store/useModels'

/**
 * Impostazioni → Ollama: variabili d'ambiente del server. Su Windows (Ollama locale) l'app le salva e
 * riavvia Ollama; altrove mostra i comandi da copiare.
 */
export function OllamaEnvPanel(): React.JSX.Element {
  const [info, setInfo] = useState<OllamaEnvInfo | null>(null)
  const [draft, setDraft] = useState<Record<string, string | null>>({})
  const [state, setState] = useState<{ kind: 'idle' | 'working' | 'done' | 'error'; text?: string; commands?: string }>({ kind: 'idle' })
  const refresh = useModels((s) => s.refresh)

  useEffect(() => {
    void window.api.ollamaEnv.get().then((res) => {
      if (!res.ok) return setState({ kind: 'error', text: res.error })
      setInfo(res.data)
      setDraft(res.data.values)
    })
  }, [])

  if (!info) return <p className="text-sm text-zinc-500">Lettura delle impostazioni di Ollama…</p>

  const changed = info.vars.filter((v) => (draft[v.name] ?? null) !== (info.values[v.name] ?? null))

  const apply = async (): Promise<void> => {
    const values = Object.fromEntries(info.vars.map((v) => [v.name, draft[v.name] ?? null]))
    if (info.canApply && !window.confirm('Ollama verrà chiuso e riaperto con le nuove impostazioni. Le risposte in corso si interrompono. Procedere?')) return
    setState({ kind: 'working' })
    const res = await window.api.ollamaEnv.apply(values)
    if (!res.ok) return setState({ kind: 'error', text: res.error })
    if (!res.data.applied) return setState({ kind: 'done', text: 'Esegui questi comandi, poi riavvia Ollama:', commands: res.data.commands })
    setInfo({ ...info, values })
    const m = useModels.getState()
    await Promise.all([refresh(), m.loadSystem(), m.loadModelSettings(), window.api.settings.get().then((r) => r.ok && useModels.setState({ settings: r.data }))])
    setState({
      kind: res.data.restarted ? 'done' : 'error',
      text: res.data.restarted ? 'Impostazioni salvate, Ollama riavviato.' : 'Impostazioni salvate, ma Ollama non risponde: avvialo a mano.'
    })
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="ollama-env">
      <p className="text-xs text-zinc-500">
        Ollama legge queste impostazioni solo all'avvio.{' '}
        {info.canApply
          ? 'L\'app le salva come variabili dell\'utente di Windows e riavvia Ollama.'
          : 'Su questo sistema l\'app non può applicarle da sola: ti mostra i comandi da eseguire.'}
      </p>
      {info.vars.map((v) => (
        <label key={v.name} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{v.label}</span>
            <code className="text-[11px] text-zinc-400">{v.name}</code>
          </span>
          <select
            aria-label={v.label}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            value={draft[v.name] ?? ''}
            onChange={(e) => setDraft({ ...draft, [v.name]: e.target.value === '' ? null : e.target.value })}
          >
            {v.options.map((o) => (
              <option key={o.label} value={o.value ?? ''}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">{v.description}</span>
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={state.kind === 'working' || (info.canApply && changed.length === 0)}
          onClick={() => void apply()}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="ollama-env-apply"
        >
          {info.canApply ? 'Applica e riavvia Ollama' : 'Mostra i comandi'}
        </button>
        {state.kind === 'working' && <span className="text-xs text-zinc-500">Riavvio di Ollama…</span>}
      </div>
      {state.text && (
        <p role="status" className={'text-xs ' + (state.kind === 'error' ? 'text-red-700 dark:text-red-400' : 'text-brand-700 dark:text-brand-300')}>
          {state.text}
        </p>
      )}
      {state.commands && (
        <pre className="whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900" data-testid="ollama-env-commands">
          {state.commands}
        </pre>
      )}
      <p className="text-xs text-zinc-500">Dopo aver attivato Vulkan, ripeti il test CPU/GPU dei modelli nella scheda «Modelli».</p>
    </div>
  )
}
