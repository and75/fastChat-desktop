import { useEffect, useState } from 'react'
import { fmtInt, t, tn } from '@shared/i18n'
import { KNOWLEDGE } from '@shared/knowledge'
import { DEFAULT_CHARS_PER_TOKEN } from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import type { Conversation, KnowledgeDocument } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { useKnowledge } from '../store/useKnowledge'
import { useModels } from '../store/useModels'
import { BookOpenIcon, FileTextIcon, PinIcon, PlusIcon, RegenerateIcon, TrashIcon } from './icons'
import { ConnectForm, ConnectionRow } from './KnowledgeConnections'

/** Pill «Usa la base di conoscenza»: impostazione della conversazione, valida per ogni domanda salvo il bottone libro. */
export function KnowledgePill({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const on = conversation.knowledge
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={t('knowledge.pill.title')}
      onClick={() => void update(conversation.id, { knowledge: !on })}
      className={
        'inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ' +
        (on
          ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700 dark:border-brand-500 dark:bg-brand-500 dark:hover:bg-brand-600'
          : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800')
      }
      data-testid="knowledge-pill"
    >
      <BookOpenIcon size={15} />
      <span>{t('knowledge.pill')}</span>
      <span className={'text-xs ' + (on ? 'text-brand-100' : 'text-zinc-400')}>{on ? t('state.on') : t('state.off')}</span>
    </button>
  )
}

const fmtBytes = (n: number | null): string => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function DocumentRow({ conversation, doc }: { conversation: Conversation; doc: KnowledgeDocument }): React.JSX.Element {
  const progress = useKnowledge((s) => s.progress[doc.id])
  const remove = useKnowledge((s) => s.remove)
  const reindex = useKnowledge((s) => s.reindex)
  const pin = useKnowledge((s) => s.pin)
  const sources = useKnowledge((s) => s.sources)
  const busy = useChat((s) => !!s.streams[conversation.id])
  // Per i documenti di una sorgente collegata conta il tipo di file (PDF, Word…), non la connessione.
  const path = doc.ref.kind === 'file' ? doc.ref.path : doc.ref.uri
  const ext = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  const reader = sources.find((s) => s.kind === 'file' && s.extensions.includes(ext)) ?? sources.find((s) => s.id === doc.source)
  const sourceLabel = reader?.label ?? doc.source
  const detail =
    doc.status === 'ready'
      ? [sourceLabel, fmtBytes(doc.bytes), tn('knowledge.doc.chunks', doc.chunkCount), doc.pinned ? t('knowledge.doc.pinned') : ''].filter(Boolean).join(' · ')
      : doc.status === 'indexing'
        ? progress?.total
          ? t('knowledge.doc.indexing.progress', { done: fmtInt(progress.done), total: fmtInt(progress.total) })
          : t('knowledge.doc.indexing')
        : doc.status === 'pending'
          ? t('knowledge.doc.pending')
          : doc.error ?? t('knowledge.doc.error')
  return (
    <li className="flex items-start gap-2 rounded-lg border border-zinc-200 px-2.5 py-2 text-sm dark:border-zinc-800" data-testid="knowledge-doc" data-status={doc.status}>
      <FileTextIcon size={16} className={'mt-0.5 shrink-0 ' + (doc.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-400')} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={doc.ref.kind === 'file' ? doc.ref.path : doc.ref.uri}>
          {doc.title}
        </div>
        <div className={'truncate text-xs ' + (doc.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-zinc-500')} title={detail}>
          {doc.status === 'indexing' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 align-middle" />}
          {detail}
        </div>
      </div>
      {doc.status === 'ready' && (
        <button
          type="button"
          aria-pressed={doc.pinned}
          className={
            'shrink-0 rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 ' +
            (doc.pinned ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200')
          }
          aria-label={t('knowledge.doc.pin')}
          title={t('knowledge.doc.pin.title')}
          onClick={() => void pin(conversation.id, doc.id, !doc.pinned)}
          data-testid="knowledge-doc-pin"
        >
          <PinIcon size={14} />
        </button>
      )}
      {doc.status === 'error' && (
        <button
          type="button"
          className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          aria-label={t('knowledge.doc.retry')}
          title={t('knowledge.doc.retry')}
          onClick={() => void reindex(conversation.id, doc.id)}
        >
          <RegenerateIcon size={14} />
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-red-700 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-red-300"
        aria-label={t('knowledge.doc.remove', { title: doc.title })}
        title={t('knowledge.doc.remove.title')}
        onClick={() => void remove(conversation.id, doc.id)}
        data-testid="knowledge-doc-remove"
      >
        <TrashIcon size={14} />
      </button>
    </li>
  )
}

/**
 * Scheda «Base di conoscenza»: la pill, i documenti della conversazione (aggiunta da dialog o trascinando
 * i file), lo stato dell'indice e del modello di embedding.
 */
export function KnowledgePanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const status = useKnowledge((s) => s.status[conversation.id])
  const load = useKnowledge((s) => s.load)
  const pickFiles = useKnowledge((s) => s.pickFiles)
  const addFiles = useKnowledge((s) => s.addFiles)
  const error = useKnowledge((s) => s.error)
  const clearError = useKnowledge((s) => s.clearError)
  const busy = useKnowledge((s) => s.busy)
  const sources = useKnowledge((s) => s.sources)
  const settings = useModels((s) => s.settings)
  const pull = useModels((s) => s.pull)
  const pulling = useModels((s) => (settings ? s.pulls[settings.embeddingModel] : undefined))
  const caps = useModels((s) => s.capabilities[conversation.model])
  const [over, setOver] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  /** Sorgente collegata in configurazione (form aperto). */
  const [connecting, setConnecting] = useState<string | null>(null)
  const connected = sources.filter((s) => s.kind === 'connected')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(conversation.id), [conversation.id, settings?.embeddingModel, pulling])

  const model = status?.model ?? settings?.embeddingModel ?? 'embeddinggemma'
  const docs = status?.documents ?? []
  const connections = status?.connections ?? []
  const loose = docs.filter((d) => !d.connectionId)
  const extensions = [...new Set(sources.flatMap((s) => s.extensions))]

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.knowledge.pathForFile(f))
      .filter(Boolean)
    void addFiles(conversation.id, paths)
  }

  // Stanno nella memoria? Il quarto di num_ctx riservato ai documenti contro i token stimati dei pezzi pronti.
  const numCtx = resolveSettings(conversation, caps ?? null).numCtx
  const budgetTokens = Math.floor(numCtx * KNOWLEDGE.budgetShare)
  const docTokens = status ? Math.ceil(status.totalChars / DEFAULT_CHARS_PER_TOKEN) : 0
  const pinnedTokens = status ? Math.ceil(status.pinnedChars / DEFAULT_CHARS_PER_TOKEN) : 0
  const fitText = !status || docTokens === 0
    ? null
    : docTokens <= budgetTokens
      ? t('knowledge.fit.whole', { tokens: fmtInt(docTokens), budget: fmtInt(budgetTokens) })
      : t('knowledge.fit.excerpts', { tokens: fmtInt(docTokens), budget: fmtInt(budgetTokens), needed: fmtInt(Math.ceil(docTokens / KNOWLEDGE.budgetShare / 1024) * 1024) })
  const pinnedOver = !!status && pinnedTokens > budgetTokens

  const statusText = !status
    ? t('knowledge.status.reading')
    : docs.length === 0
      ? t('knowledge.status.empty')
      : !status.modelInstalled
        ? t('knowledge.status.missing', { model })
        : tn('knowledge.status.chunks', status.chunks, { docs: tn('knowledge.status.docs', docs.length) }) + (status.pending ? t('knowledge.status.pending', { n: status.pending }) : '') + t('knowledge.status.with', { model })

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-panel">
      <KnowledgePill conversation={conversation} />
      <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{t('knowledge.intro')}</p>

      <div
        className={
          'flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-center text-sm transition-colors ' +
          (over ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30' : 'border-zinc-300 dark:border-zinc-700')
        }
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="knowledge-dropzone"
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void pickFiles(conversation.id)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          data-testid="knowledge-add"
        >
          <PlusIcon size={15} />
          {t('knowledge.add')}
        </button>
        <span className="text-xs text-zinc-500">{t('knowledge.drop')}</span>
        {extensions.length > 0 && <span className="text-[11px] text-zinc-400">{extensions.map((e) => `.${e}`).join(' ')}</span>}
        {connected.length > 0 && (
          <div className="mt-1 flex flex-wrap justify-center gap-1.5">
            {connected.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy}
                onClick={() => setConnecting(s.id)}
                className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
                data-testid={`knowledge-connect-${s.id}`}
              >
                {t('knowledge.connect.button', { source: s.label })}
              </button>
            ))}
          </div>
        )}
      </div>

      {connecting && sources.find((s) => s.id === connecting) && (
        <ConnectForm conversation={conversation} source={sources.find((s) => s.id === connecting)!} onDone={() => setConnecting(null)} />
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label={t('common.close')} onClick={clearError}>
            ✕
          </button>
        </div>
      )}

      {docs.length + connections.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={t('knowledge.documents')} data-testid="knowledge-docs">
          {loose.map((d) => (
            <DocumentRow key={d.id} conversation={conversation} doc={d} />
          ))}
          {connections.map((c) => {
            const own = docs.filter((d) => d.connectionId === c.id)
            return (
              <li key={c.id} className="flex flex-col gap-1.5">
                <ul className="contents">
                  <ConnectionRow conversation={conversation} connection={c} documents={own.length} />
                </ul>
                {own.length > 0 && (
                  <ul className="ml-3 flex flex-col gap-1.5 border-l-2 border-brand-100 pl-2 dark:border-brand-900">
                    {own.map((d) => (
                      <DocumentRow key={d.id} conversation={conversation} doc={d} />
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400" data-testid="knowledge-status">
        {statusText}
      </span>
      {fitText && (
        <span className={'text-xs leading-snug ' + (docTokens <= budgetTokens ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400')} data-testid="knowledge-fit" data-whole={docTokens <= budgetTokens}>
          {fitText}
        </span>
      )}
      {pinnedOver && (
        <span className="text-xs leading-snug text-amber-700 dark:text-amber-400" data-testid="knowledge-pinned-over">
          {t('knowledge.fit.pinnedOver', { tokens: fmtInt(pinnedTokens) })}
        </span>
      )}
      {status && docs.length > 0 && !status.modelInstalled && (
        <button
          type="button"
          disabled={!!pulling}
          className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          onClick={() => void pull(model).then((e) => (e ? setPullError(e) : load(conversation.id)))}
          data-testid="knowledge-download"
        >
          {pulling ? t('longMemory.downloading', { model, pct: pulling.total ? `${Math.round(((pulling.completed ?? 0) / pulling.total) * 100)}%` : '' }) : t('longMemory.download', { model })}
        </button>
      )}
      {pullError && <span className="text-xs text-red-700 dark:text-red-300">{pullError}</span>}
      <p className="text-xs leading-snug text-zinc-400">{t('knowledge.hint')}</p>
    </div>
  )
}
