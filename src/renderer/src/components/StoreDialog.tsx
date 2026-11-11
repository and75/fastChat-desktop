import { useEffect, useMemo, useRef, useState } from 'react'
import { getLocale, t, type Key } from '@shared/i18n'
import { localize, STORE_CATEGORIES, type StoreEntry, type StoreItemType, type StoreState, type StoreView } from '@shared/store'
import { useKnowledge } from '../store/useKnowledge'
import { BookOpenIcon, IdCardIcon, PackageIcon, PuzzleIcon } from './icons'

const ICONS: Record<StoreItemType, (p: { size?: number; className?: string }) => React.JSX.Element> = {
  identity: IdCardIcon,
  knowledge: BookOpenIcon,
  plugin: PuzzleIcon,
  bundle: PackageIcon
}

const BADGE: Record<StoreState, string> = {
  installed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  update: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  available: 'bg-brand-100 text-brand-800 dark:bg-brand-950/60 dark:text-brand-300',
  soon: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
}

const fmtSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`)

function StateBadge({ state }: { state: StoreState }): React.JSX.Element {
  return (
    <span className={'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + BADGE[state]} data-testid="store-item-state" data-state={state}>
      {t(`store.state.${state}` as Key)}
    </span>
  )
}

/** Una voce dello store: titolo e descrizione nella lingua dell'interfaccia, requisiti, stato, azione. */
function StoreCard({ item, all, busy, onInstall, onRemove }: { item: StoreEntry; all: Map<string, StoreEntry>; busy: boolean; onInstall(): void; onRemove(): void }): React.JSX.Element {
  const locale = getLocale()
  const Icon = ICONS[item.type]
  const related = (ids: string[] | undefined): StoreEntry[] => (ids ?? []).map((id) => all.get(id)).filter((x): x is StoreEntry => !!x)
  const contains = related(item.contains)
  const requires = related(item.requires)
  const details = [
    item.author,
    `v${item.version.split('+')[0]}`,
    item.language ? t('store.language', { language: item.language.toUpperCase() }) : null,
    item.size ? fmtSize(item.size) : null,
    item.price ? `${item.price.toFixed(2)} €` : t('store.free')
  ].filter(Boolean)
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800" data-testid="store-item" data-id={item.id}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold" data-testid="store-item-name">
              {localize(item.name, locale)}
            </h3>
            <StateBadge state={item.state} />
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{localize(item.summary, locale)}</p>
          <p className="mt-1 text-xs text-zinc-500">{details.join(' · ')}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {(item.state === 'available' || item.state === 'update') && (
            <button
              type="button"
              disabled={busy}
              onClick={onInstall}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="store-item-install"
            >
              {busy ? t('store.working') : t(item.state === 'update' ? 'store.update' : 'store.install')}
            </button>
          )}
          {item.removable && (
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-red-700 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
              data-testid="store-item-remove"
            >
              {t('store.remove')}
            </button>
          )}
        </div>
      </div>

      {(contains.length > 0 || requires.length > 0) && (
        <div className="flex flex-col gap-1 rounded-lg bg-zinc-50 px-2.5 py-2 text-sm dark:bg-zinc-900/60">
          {[
            { label: t('store.contains'), list: contains },
            { label: t('store.requires'), list: requires }
          ].map(
            ({ label, list }) =>
              list.length > 0 && (
                <div key={label}>
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
                  <ul className="mt-1 flex flex-col gap-1">
                    {list.map((c) => (
                      <li key={c.id} className="flex items-center gap-2" data-testid="store-item-part">
                        <span className="min-w-0 flex-1 truncate">
                          {localize(c.name, locale)} <span className="text-xs text-zinc-500">· {t(`store.category.${c.type}` as Key)}</span>
                        </span>
                        <StateBadge state={c.state} />
                      </li>
                    ))}
                  </ul>
                </div>
              )
          )}
        </div>
      )}

      <p className="text-xs leading-snug text-zinc-500">
        {item.type === 'knowledge' && (item.embedding ? t('store.vectors', { model: item.embedding.model }) : t('store.textOnly'))}
        {item.type === 'identity' && item.model && t(item.model.required ? 'store.model.required' : 'store.model.recommended', { model: item.model.name })}
        {item.builtin && ` ${t('store.builtin')}.`}
        {item.state === 'update' && item.installedVersion && ` ${t('store.installedVersion', { version: item.installedVersion.split('+')[0] })}.`}
        {item.type === 'knowledge' && item.state !== 'available' && item.state !== 'soon' && ` ${t('store.installed.hint')}`}
        {(item.type === 'identity' || item.type === 'plugin') && ` ${t('store.soon.hint')}`}
      </p>
    </li>
  )
}

/** Lo store: una finestra sopra la chat, divisa in categorie. Mostra il catalogo e ciò che è già installato. */
export function StoreDialog({ onClose }: { onClose(): void }): React.JSX.Element {
  const [view, setView] = useState<StoreView | null>(null)
  const [tab, setTab] = useState<StoreItemType>('knowledge')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const locale = getLocale()

  const load = async (): Promise<void> => {
    setError(null)
    const res = await window.api.store.catalog()
    if (res.ok) setView(res.data)
    else setError(res.error)
  }
  useEffect(() => {
    dialog.current?.showModal()
    void load()
  }, [])

  /** Installa o rimuove, poi allinea libreria e conversazioni aperte. */
  const act = async (id: string, action: 'install' | 'remove'): Promise<void> => {
    setBusy(id)
    setError(null)
    const res = await window.api.store[action](id)
    setBusy(null)
    if (!res.ok) return setError(res.error)
    setView(res.data)
    const knowledge = useKnowledge.getState()
    void knowledge.loadBases()
    for (const key of Object.keys(knowledge.status)) void knowledge.load(key)
  }

  const all = useMemo(() => new Map((view?.items ?? []).map((i) => [i.id, i])), [view])
  const needle = query.trim().toLowerCase()
  const shown = (view?.items ?? []).filter(
    (i) => i.type === tab && (!needle || `${localize(i.name, locale)} ${localize(i.summary, locale)} ${i.author ?? ''}`.toLowerCase().includes(needle))
  )
  const count = (type: StoreItemType): number => (view?.items ?? []).filter((i) => i.type === type).length

  return (
    <dialog
      ref={dialog}
      aria-label={t('store.title')}
      data-testid="store-dialog"
      onClose={onClose}
      className="m-auto w-[46rem] max-w-[94vw] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <div className="flex items-center gap-4 border-b border-zinc-200 px-5 pt-5 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">{t('store.title')}</h2>
        <div role="tablist" aria-label={t('store.categories')} className="flex gap-1">
          {STORE_CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`store-tab-${id}`}
              className={
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ' +
                (tab === id ? 'border-brand-600 font-medium text-brand-700 dark:text-brand-300' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
              }
            >
              {t(`store.category.${id}` as Key)}
              {view && <span className="ml-1 text-xs text-zinc-400">{count(id)}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-5">
        <input
          type="search"
          aria-label={t('store.search')}
          placeholder={t('store.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          data-testid="store-search"
        />

        {(error ?? view?.error) && (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="store-error">
            {error ?? view?.error}
          </p>
        )}

        {!view ? (
          !error && <p className="py-6 text-center text-sm text-zinc-500">{t('store.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500" data-testid="store-empty">
            {needle ? t('store.noResults', { query: query.trim() }) : t('store.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="store-items">
            {shown.map((item) => (
              <StoreCard key={item.id} item={item} all={all} busy={busy === item.id} onInstall={() => void act(item.id, 'install')} onRemove={() => void act(item.id, 'remove')} />
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1 text-xs text-zinc-500">
          <span className="min-w-0 flex-1 truncate" data-testid="store-source">
            {view && (view.source === 'remote' ? t('store.source.remote', { url: view.url }) : t('store.source.local'))}
            {view?.updatedAt ? ` · ${t('store.updatedAt', { date: view.updatedAt })}` : ''}
          </span>
          <button type="button" onClick={() => void load()} className="rounded-lg px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" data-testid="store-refresh">
            {t('store.refresh')}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-900 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800">
            {t('common.close')}
          </button>
        </div>
      </div>
    </dialog>
  )
}
