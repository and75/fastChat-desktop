import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { OllamaEnvInfo } from '@shared/api'
import { useModels } from '../store/useModels'

/** Etichetta e spiegazione di una variabile: il main manda un id (`vulkan`, `flash`, `kv`, `maxLoaded`). */
const envLabel = (id: string): string => t(`env.${id as 'vulkan' | 'flash' | 'kv' | 'maxLoaded'}`)
const envDesc = (id: string): string => t(`env.${id as 'vulkan' | 'flash' | 'kv' | 'maxLoaded'}.desc`)
/** Le opzioni arrivano dal main con un id (`unset`, `on`, `off`…) o con il valore stesso (f16, 1, 2…). */
const envOption = (label: string): string => (label in OPTION_KEYS ? t(OPTION_KEYS[label as keyof typeof OPTION_KEYS]) : label)
const OPTION_KEYS = { unset: 'env.unset', on: 'env.on', off: 'env.off', 'unset-f16': 'env.unsetF16', 'unset-auto': 'env.unsetAuto' } as const

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

  if (!info) return <p className="text-sm text-zinc-500">{t('env.loading')}</p>

  const changed = info.vars.filter((v) => (draft[v.name] ?? null) !== (info.values[v.name] ?? null))

  const apply = async (): Promise<void> => {
    const values = Object.fromEntries(info.vars.map((v) => [v.name, draft[v.name] ?? null]))
    if (info.canApply && !window.confirm(t('env.confirm'))) return
    setState({ kind: 'working' })
    const res = await window.api.ollamaEnv.apply(values)
    if (!res.ok) return setState({ kind: 'error', text: res.error })
    if (!res.data.applied) return setState({ kind: 'done', text: t('env.runCommands'), commands: res.data.commands })
    setInfo({ ...info, values })
    const m = useModels.getState()
    await Promise.all([refresh(), m.loadSystem(), m.loadModelSettings(), window.api.settings.get().then((r) => r.ok && useModels.setState({ settings: r.data }))])
    setState({
      kind: res.data.restarted ? 'done' : 'error',
      text: res.data.restarted ? t('env.restarted') : t('env.notResponding')
    })
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="ollama-env">
      <p className="text-xs text-zinc-500">
        {t('env.readAtStart')}
        {info.canApply ? t('env.canApply') : t('env.cannotApply')}
      </p>
      {info.vars.map((v) => (
        <label key={v.name} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{envLabel(v.label)}</span>
            <code className="text-[11px] text-zinc-400">{v.name}</code>
          </span>
          <select
            aria-label={envLabel(v.label)}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            value={draft[v.name] ?? ''}
            onChange={(e) => setDraft({ ...draft, [v.name]: e.target.value === '' ? null : e.target.value })}
          >
            {v.options.map((o) => (
              <option key={o.label} value={o.value ?? ''}>
                {envOption(o.label)}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">{envDesc(v.label)}</span>
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
          {info.canApply ? t('env.apply') : t('env.showCommands')}
        </button>
        {state.kind === 'working' && <span className="text-xs text-zinc-500">{t('env.restarting')}</span>}
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
      <p className="text-xs text-zinc-500">{t('env.afterVulkan')}</p>
    </div>
  )
}
