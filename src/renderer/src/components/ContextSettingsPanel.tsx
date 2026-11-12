import { useState } from 'react'
import { t, type Key } from '@shared/i18n'
import { CONTEXT_ORDERS } from '@shared/compose'
import { BASE_PURPOSES, DEFAULT_CONTEXT_SETTINGS, type BasePurpose, type ContextSettings } from '@shared/types'
import { useModels } from '../store/useModels'

const pct = (share: number): number => Math.round(share * 100)

/**
 * Impostazioni → Contesto: ordine dei blocchi inviati al modello, promemoria del ruolo, quote della conoscenza.
 * Serve a provare le disposizioni; il monitor del contesto registra per ogni chiamata ordine e tempi.
 */
export function ContextSettingsPanel(): React.JSX.Element {
  const settings = useModels((s) => s.settings)
  const saveSettings = useModels((s) => s.saveSettings)
  const [draft, setDraft] = useState<ContextSettings>(() => settings?.context ?? DEFAULT_CONTEXT_SETTINGS)
  const [shares, setShares] = useState<Record<BasePurpose, number>>(() => ({ behavior: pct(draft.shares.behavior), examples: pct(draft.shares.examples), documents: pct(draft.shares.documents) }))
  const [situation, setSituation] = useState(() => pct(draft.situationShare))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const total = shares.behavior + shares.examples + shares.documents
  const field = 'rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900'

  const change = (patch: Partial<ContextSettings>): void => {
    setDraft({ ...draft, ...patch })
    setSaved(false)
  }
  const save = async (): Promise<void> => {
    setError(null)
    const context: ContextSettings = { ...draft, shares: { behavior: shares.behavior / 100, examples: shares.examples / 100, documents: shares.documents / 100 }, situationShare: situation / 100 }
    const err = await saveSettings({ context })
    if (err) setError(err)
    else setSaved(true)
  }

  return (
    <form
      className="flex flex-col gap-4 text-sm"
      data-testid="context-settings"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <p className="text-zinc-600 dark:text-zinc-300">{t('settings.context.intro')}</p>

      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('settings.context.order')}</span>
        <select className={field} value={draft.order} onChange={(e) => change({ order: e.target.value as ContextSettings['order'] })} data-testid="context-order">
          {(['auto', ...CONTEXT_ORDERS] as const).map((o) => (
            <option key={o} value={o}>
              {t(`settings.context.order.${o}` as Key)}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">{t(`settings.context.order.hint.${draft.order}` as Key)}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('settings.context.reminder')}</span>
        <select className={field} value={draft.reminder} onChange={(e) => change({ reminder: e.target.value as ContextSettings['reminder'] })} data-testid="context-reminder">
          {(['auto', 'on', 'off'] as const).map((o) => (
            <option key={o} value={o}>
              {t(`settings.context.reminder.${o}` as Key)}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">{t('settings.context.reminder.hint')}</span>
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">{t('settings.context.shares')}</legend>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {BASE_PURPOSES.map((p) => (
            <label key={p} className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-300">
              {t(`knowledge.purpose.${p}` as Key)}
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                className={field + ' text-sm text-zinc-900 dark:text-zinc-100'}
                value={shares[p]}
                onChange={(e) => {
                  setShares({ ...shares, [p]: Number(e.target.value) })
                  setSaved(false)
                }}
                data-testid={`context-share-${p}`}
              />
            </label>
          ))}
        </div>
        <span className={'text-xs ' + (total === 100 ? 'text-zinc-500' : 'text-red-700 dark:text-red-400')} data-testid="context-shares-total">
          {t('settings.context.shares.hint', { total })}
        </span>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('settings.context.situation')}</span>
        <input
          type="number"
          min={1}
          max={25}
          className={field + ' w-28'}
          value={situation}
          onChange={(e) => {
            setSituation(Number(e.target.value))
            setSaved(false)
          }}
          data-testid="context-situation"
        />
        <span className="text-xs text-zinc-500">{t('settings.context.situation.hint')}</span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="context-settings-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="text-xs text-brand-700 dark:text-brand-400" data-testid="context-settings-saved">
            {t('settings.context.saved')}
          </span>
        )}
        <button type="submit" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
          {t('common.save')}
        </button>
      </div>
    </form>
  )
}
