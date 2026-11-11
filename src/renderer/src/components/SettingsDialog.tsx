import { useEffect, useRef, useState } from 'react'
import { t, tn } from '@shared/i18n'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { useModels } from '../store/useModels'
import { KnowledgeLibrary } from './KnowledgeLibrary'
import { ModelManager } from './ModelManager'
import { OllamaEnvPanel } from './OllamaEnvPanel'

type SettingsTab = 'general' | 'models' | 'ollama' | 'knowledge'
const TABS: SettingsTab[] = ['general', 'models', 'ollama', 'knowledge']

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; count: number } | { state: 'error'; message: string }

/** Impostazioni generali: URL di Ollama, tema, modello predefinito per le nuove conversazioni. */
export function SettingsDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const { settings, models, saveSettings } = useModels()
  const [draft, setDraft] = useState<AppSettings>(() => settings ?? { ...DEFAULT_SETTINGS, ollamaUrl: '' })
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('general')
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
      aria-label={t('settings.title')}
      data-testid="settings-dialog"
      onClose={onClose}
      className="m-auto w-[40rem] max-w-[92vw] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <div className="flex items-center gap-4 border-b border-zinc-200 px-5 pt-5 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
        <div role="tablist" aria-label={t('settings.sections')} className="flex gap-1">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={
                '-mb-px border-b-2 px-3 py-2 text-sm ' +
                (tab === id ? 'border-brand-600 font-medium text-brand-700 dark:text-brand-300' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
              }
            >
              {t(`settings.tab.${id}`)}
            </button>
          ))}
        </div>
      </div>
      {tab !== 'general' && (
        <div className="max-h-[70vh] overflow-y-auto p-5">
          {tab === 'models' ? <ModelManager /> : tab === 'ollama' ? <OllamaEnvPanel /> : <KnowledgeLibrary />}
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
      <form
        method="dialog"
        className={'flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-5 ' + (tab === 'general' ? '' : 'hidden')}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('settings.language')}</span>
          <select className={field} value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value as AppSettings['language'] })} data-testid="settings-language">
            <option value="auto">{t('settings.language.auto')}</option>
            <option value="it">{t('settings.language.it')}</option>
            <option value="en">{t('settings.language.en')}</option>
            <option value="fr">{t('settings.language.fr')}</option>
          </select>
          <span className="text-xs text-zinc-500">{t('settings.language.hint')}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('settings.ollamaUrl')}</span>
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
              {t('settings.verify')}
            </button>
          </div>
          <span className="text-xs" data-testid="settings-check">
            {check.state === 'checking' && <span className="text-zinc-500">{t('settings.verifying')}</span>}
            {check.state === 'ok' && <span className="text-brand-700 dark:text-brand-400">{tn('settings.connected', check.count)}</span>}
            {check.state === 'error' && <span className="text-red-700 dark:text-red-400">{check.message}</span>}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('settings.theme')}</span>
          <select
            className={field}
            value={draft.theme}
            onChange={(e) => setDraft({ ...draft, theme: e.target.value as AppSettings['theme'] })}
            data-testid="settings-theme"
          >
            <option value="system">{t('settings.theme.system')}</option>
            <option value="light">{t('settings.theme.light')}</option>
            <option value="dark">{t('settings.theme.dark')}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('settings.defaultModel')}</span>
          <select
            className={field}
            value={draft.defaultModel ?? ''}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value || null })}
          >
            <option value="">{t('common.none')}</option>
            {draft.defaultModel && !models.some((m) => m.name === draft.defaultModel) && (
              <option value={draft.defaultModel}>{t('settings.notInstalled', { model: draft.defaultModel })}</option>
            )}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-zinc-500">{t('settings.defaultModel.hint')}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('settings.kvCache')}</span>
          <select
            className={field}
            value={draft.kvCacheType}
            onChange={(e) => setDraft({ ...draft, kvCacheType: e.target.value as AppSettings['kvCacheType'] })}
          >
            <option value="f16">{t('settings.kvCache.f16')}</option>
            <option value="q8_0">{t('settings.kvCache.q8')}</option>
            <option value="q4_0">{t('settings.kvCache.q4')}</option>
          </select>
          <span className="text-xs text-zinc-500">{t('settings.kvCache.hint')}</span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
