import { useEffect, useState } from 'react'
import { getLocale, t, tn } from '@shared/i18n'
import type { KnowledgeBaseInfo, PackInspection } from '@shared/types'
import { useKnowledge } from '../store/useKnowledge'
import { BookOpenIcon, TrashIcon } from './icons'
import { baseDetail, baseTitle, KnowledgeDocuments, ModelMissing } from './KnowledgePanel'

/** Una base aperta: nome modificabile, eliminazione con conferma, documenti. */
function BaseEditor({ base, onRemoved }: { base: KnowledgeBaseInfo; onRemoved(): void }): React.JSX.Element {
  const renameBase = useKnowledge((s) => s.renameBase)
  const removeBase = useKnowledge((s) => s.removeBase)
  const setAutoLink = useKnowledge((s) => s.setAutoLink)
  const exportBase = useKnowledge((s) => s.exportBase)
  // Il nome di un pacchetto non si modifica: si mostra nella lingua dell'interfaccia.
  const shown = base.origin === 'package' ? baseTitle(base) : base.name
  const [name, setName] = useState(shown)
  const [confirming, setConfirming] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const fromPack = base.origin === 'package'
  const trust = base.meta?.trust
  useEffect(() => setName(shown), [base.id, shown])
  const commit = (): void => {
    const clean = name.trim()
    if (fromPack) return
    if (clean && clean !== base.name) void renameBase(base.id, clean)
    else setName(base.name)
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800" data-testid="library-base-editor">
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="text-xs text-zinc-500">{t('knowledge.library.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
            readOnly={fromPack}
            className={'rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900 ' + (fromPack ? 'text-zinc-500' : '')}
            data-testid="library-base-name"
          />
        </label>
        {!fromPack && (
          <button
            type="button"
            onClick={() => void exportBase(base.id).then(setExported)}
            title={t('pack.export.title')}
            className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            data-testid="library-base-export"
          >
            {t('pack.export')}
          </button>
        )}
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-red-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            data-testid="library-base-delete"
          >
            <TrashIcon size={14} />
            {t('knowledge.library.delete')}
          </button>
        )}
      </div>
      {confirming && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-2.5 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <span className="min-w-0 flex-1">
            {base.conversations > 0 ? tn('knowledge.library.delete.confirm', base.conversations) : t('knowledge.library.delete.confirmNone')}
          </span>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
            onClick={() => void removeBase(base.id).then(onRemoved)}
            data-testid="library-base-delete-confirm"
          >
            {t('knowledge.library.delete.yes')}
          </button>
          <button type="button" className="rounded-lg px-2.5 py-1 hover:bg-red-100 dark:hover:bg-red-900/40" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      {exported && (
        <span className="truncate text-xs text-brand-700 dark:text-brand-400" title={exported} data-testid="library-exported">
          {t('pack.exported', { path: exported })}
        </span>
      )}
      {fromPack && (
        <p className="text-xs leading-snug text-zinc-500" data-testid="library-base-pack">
          {t('pack.from', { id: base.packageId ?? '', version: base.version ?? '' })}
          {base.meta?.author ? ` · ${base.meta.author}` : ''}
          {' · '}
          <span className={trust === 'verified' || trust === 'builtin' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>{t(`pack.trust.${trust ?? 'unsigned'}`)}</span>
          {base.description ? <span className="mt-1 block">{base.description}</span> : null}
        </p>
      )}
      <p className="text-xs leading-snug text-zinc-500" data-testid="library-base-model">
        {base.embeddingModel ? t('pack.model.fixed', { model: base.model }) : t('pack.model.settings', { model: base.model })}
      </p>
      {!base.modelInstalled && base.documents > 0 && <ModelMissing model={base.model} />}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={base.autoLink} onChange={(e) => void setAutoLink(base.id, e.target.checked)} data-testid="library-base-autolink" />
        <span>{t('knowledge.library.autoLink')}</span>
      </label>
      <KnowledgeDocuments ownerId={base.id} readOnly={fromPack} />
    </div>
  )
}

const trustClass = (trust: PackInspection['trust']): string => (trust === 'verified' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')

/** Un pacchetto scelto ma non ancora installato: cosa contiene, con che modello è fatto, se la firma è riconosciuta. */
function PackPreview({ pack, onDone }: { pack: PackInspection; onDone(installed: boolean): void }): React.JSX.Element {
  const installPack = useKnowledge((s) => s.installPack)
  const busy = useKnowledge((s) => s.busy)
  const m = pack.manifest
  const supported = m.type === 'knowledge'
  const trusted = pack.trust === 'verified'
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-brand-300 bg-brand-50/60 p-3 text-sm dark:border-brand-800 dark:bg-brand-950/20" data-testid="pack-preview">
      <div className="font-medium">
        {m.i18n?.[getLocale()]?.name ?? m.name} <span className="font-normal text-zinc-500">v{m.version}</span>
      </div>
      {(m.i18n?.[getLocale()]?.description ?? m.description) && <p className="text-xs text-zinc-600 dark:text-zinc-300">{m.i18n?.[getLocale()]?.description ?? m.description}</p>}
      <ul className="flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-300">
        <li>{t('pack.preview.content', { docs: m.documents ?? 0, chunks: m.chunks ?? 0 })}{m.author ? ` · ${m.author}` : ''}</li>
        <li>
          {m.embedding ? t('pack.preview.model', { model: m.embedding.model }) : t('pack.preview.textOnly')}
          {m.embedding && !pack.modelInstalled ? <span className="text-amber-700 dark:text-amber-400"> {t('pack.preview.modelMissing')}</span> : null}
        </li>
        <li className={trustClass(pack.trust)}>{t(`pack.trust.${pack.trust}`)}{trusted ? '' : ` ${t('pack.preview.untrusted')}`}</li>
        {pack.installedVersion && <li>{t('pack.preview.update', { version: pack.installedVersion })}</li>}
        {!supported && <li className="text-red-700 dark:text-red-300">{t('err.pack.unsupported', { type: m.type })}</li>}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !supported}
          className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          onClick={() => void installPack(pack.path, !trusted).then((ok) => ok && onDone(true))}
          data-testid="pack-install"
        >
          {pack.installedVersion ? t('pack.update') : trusted ? t('pack.install') : t('pack.installAnyway')}
        </button>
        <button type="button" className="rounded-lg px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => onDone(false)}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

/**
 * Libreria delle basi di conoscenza (Impostazioni → Conoscenza): basi riutilizzabili, con i loro documenti, da
 * collegare alle conversazioni dalla scheda «Conoscenza».
 */
export function KnowledgeLibrary(): React.JSX.Element {
  const bases = useKnowledge((s) => s.bases)
  const loadBases = useKnowledge((s) => s.loadBases)
  const createBase = useKnowledge((s) => s.createBase)
  const pickPack = useKnowledge((s) => s.pickPack)
  const error = useKnowledge((s) => s.error)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pack, setPack] = useState<PackInspection | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void loadBases(), [])
  const open = bases.find((b) => b.id === selected) ?? null

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-library">
      <p className="text-sm text-zinc-500">{t('knowledge.library.intro')}</p>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const base = await createBase(name)
          if (base) {
            setName('')
            setSelected(base.id)
          }
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('knowledge.library.new')}
          aria-label={t('knowledge.library.new')}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          data-testid="library-new-name"
        />
        <button type="submit" disabled={!name.trim()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40" data-testid="library-create">
          {t('knowledge.library.create')}
        </button>
        <button
          type="button"
          onClick={() => void pickPack().then(setPack)}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          data-testid="library-import"
        >
          {t('pack.import')}
        </button>
      </form>

      {pack && (
        <PackPreview
          pack={pack}
          onDone={() => {
            setPack(null)
            void loadBases()
          }}
        />
      )}
      {error && !selected && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {bases.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('knowledge.library.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="library-bases">
          {bases.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                aria-expanded={selected === b.id}
                onClick={() => setSelected(selected === b.id ? null : b.id)}
                className={
                  'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm ' +
                  (selected === b.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900')
                }
                data-testid="library-base"
              >
                <BookOpenIcon size={16} className="shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate font-medium">{baseTitle(b)}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {b.origin === 'package' ? `${t('knowledge.source.package')} · ` : ''}
                  {baseDetail(b)}
                  {!b.modelInstalled && b.documents > 0 ? ` · ${t('knowledge.model.missingShort')}` : ''}
                  {b.conversations > 0 ? ` · ${tn('knowledge.library.used', b.conversations)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <BaseEditor key={open.id} base={open} onRemoved={() => setSelected(null)} />}
    </div>
  )
}
