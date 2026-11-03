import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useModels } from '../store/useModels'

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; count: number } | { state: 'error'; message: string }

/** Impostazioni generali: URL di Ollama, tema, modello predefinito per le nuove conversazioni. */
export function SettingsDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const { settings, models, saveSettings } = useModels()
  const [draft, setDraft] = useState<AppSettings>(() => settings ?? { ollamaUrl: '', theme: 'system', defaultModel: null })
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  /** Verifica l'URL senza salvarlo. */
  const verify = async (): Promise<void> => {
    setCheck({ state: 'checking' })
    const res = await window.api.models.check(draft.ollamaUrl)
    setCheck(res.ok ? { state: 'ok', count: res.data.length } : { state: 'error', message: res.error })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    const err = await saveSettings(draft)
    setSaving(false)
    if (err) setError(err)
    else onClose()
  }

  const field = 'rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900'

  return (
    <dialog
      ref={dialog}
      aria-label="Impostazioni"
      data-testid="settings-dialog"
      onClose={onClose}
      className="m-auto w-[28rem] max-w-[90vw] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2 className="text-lg font-semibold">Impostazioni</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">URL di Ollama</span>
          <div className="flex gap-2">
            <input
              type="url"
              required
              className={field + ' flex-1'}
              value={draft.ollamaUrl}
              onChange={(e) => {
                setDraft({ ...draft, ollamaUrl: e.target.value })
                setCheck({ state: 'idle' })
              }}
            />
            <button
              type="button"
              onClick={() => void verify()}
              disabled={check.state === 'checking'}
              className="rounded-lg border border-zinc-300 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Verifica
            </button>
          </div>
          <span className="text-xs" data-testid="settings-check">
            {check.state === 'checking' && <span className="text-zinc-500">Verifica in corso…</span>}
            {check.state === 'ok' && (
              <span className="text-green-700 dark:text-green-400">
                Connesso · {check.count} {check.count === 1 ? 'modello' : 'modelli'}
              </span>
            )}
            {check.state === 'error' && <span className="text-red-700 dark:text-red-400">{check.message}</span>}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Tema</span>
          <select
            className={field}
            value={draft.theme}
            onChange={(e) => setDraft({ ...draft, theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="system">Come il sistema</option>
            <option value="light">Chiaro</option>
            <option value="dark">Scuro</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Modello predefinito</span>
          <select
            className={field}
            value={draft.defaultModel ?? ''}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value || null })}
          >
            <option value="">Nessuno</option>
            {draft.defaultModel && !models.some((m) => m.name === draft.defaultModel) && (
              <option value={draft.defaultModel}>{draft.defaultModel} (non installato)</option>
            )}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">Usato per le nuove conversazioni.</span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Annulla
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Salva
          </button>
        </div>
      </form>
    </dialog>
  )
}
