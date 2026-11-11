import { useEffect, useState } from 'react'
import { t, tn } from '@shared/i18n'
import type { KnowledgeBaseInfo } from '@shared/types'
import { useKnowledge } from '../store/useKnowledge'
import { BookOpenIcon, TrashIcon } from './icons'
import { baseDetail, KnowledgeDocuments } from './KnowledgePanel'

/** Una base aperta: nome modificabile, eliminazione con conferma, documenti. */
function BaseEditor({ base, onRemoved }: { base: KnowledgeBaseInfo; onRemoved(): void }): React.JSX.Element {
  const renameBase = useKnowledge((s) => s.renameBase)
  const removeBase = useKnowledge((s) => s.removeBase)
  const [name, setName] = useState(base.name)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setName(base.name), [base.id, base.name])
  const commit = (): void => {
    const clean = name.trim()
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
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            data-testid="library-base-name"
          />
        </label>
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
      <KnowledgeDocuments ownerId={base.id} />
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
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
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
      </form>

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
                <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {baseDetail(b)}
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
