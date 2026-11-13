import { useEffect, useState } from 'react'
import { fmtInt, getLocale, t, tn } from '@shared/i18n'
import { KNOWLEDGE } from '@shared/knowledge'
import { DEFAULT_CHARS_PER_TOKEN } from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import { BASE_PURPOSES, KNOWLEDGE_SHARES, type BasePurpose, type Conversation, type KnowledgeBaseInfo, type KnowledgeDocument } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { useKnowledge } from '../store/useKnowledge'
import { useModels } from '../store/useModels'
import { definitionOf, findRole, roleName, useRoles } from '../store/useRoles'
import { BookOpenIcon, FileTextIcon, PinIcon, PlusIcon, RegenerateIcon, TrashIcon } from './icons'
import { ConnectForm, ConnectionRow } from './KnowledgeConnections'
import { Switch } from './ModelSettings'

/** Interruttore «Usa la base di conoscenza»: impostazione della conversazione, valida per ogni domanda salvo il bottone libro. */
export function KnowledgePill({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const on = conversation.knowledge
  return (
    <div data-testid="knowledge-pill" data-on={on}>
      <Switch label={t('knowledge.pill')} checked={on} title={t('knowledge.pill.title')} color="bg-brand-600" onChange={(knowledge) => void update(conversation.id, { knowledge })} />
    </div>
  )
}

/** Quota della memoria per i documenti: 25 / 50 / 75% di num_ctx. Il resto va a storico, riassunto e memoria. */
function ShareControl({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const current = conversation.knowledgeShare ?? KNOWLEDGE.budgetShare
  return (
    <div className="flex flex-col gap-1" data-testid="knowledge-share">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300" title={t('knowledge.share.title')}>
          {t('knowledge.share.label')}
        </span>
        <div role="radiogroup" aria-label={t('knowledge.share.label')} className="flex rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
          {KNOWLEDGE_SHARES.map((share, i) => (
            <button
              key={share}
              type="button"
              role="radio"
              aria-checked={current === share}
              onClick={() => void update(conversation.id, { knowledgeShare: share })}
              className={
                'px-2.5 py-1 ' +
                (i > 0 ? 'border-l border-zinc-300 dark:border-zinc-700 ' : '') +
                (current === share ? 'bg-brand-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')
              }
              data-testid={`knowledge-share-${Math.round(share * 100)}`}
            >
              {Math.round(share * 100)}%
            </button>
          ))}
        </div>
      </div>
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{t(`knowledge.share.${Math.round(current * 100)}` as 'knowledge.share.25')}</span>
    </div>
  )
}

const fmtBytes = (n: number | null): string => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function DocumentRow({ ownerId, doc, readOnly = false }: { ownerId: string; doc: KnowledgeDocument; readOnly?: boolean }): React.JSX.Element {
  const progress = useKnowledge((s) => s.progress[doc.id])
  const remove = useKnowledge((s) => s.remove)
  const reindex = useKnowledge((s) => s.reindex)
  const pin = useKnowledge((s) => s.pin)
  const sources = useKnowledge((s) => s.sources)
  // Durante una risposta i documenti della conversazione non si tolgono (per una base della libreria non c'è stream).
  const busy = useChat((s) => !!s.streams[ownerId])
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
          onClick={() => void pin(ownerId, doc.id, !doc.pinned)}
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
          onClick={() => void reindex(ownerId, doc.id)}
        >
          <RegenerateIcon size={14} />
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          disabled={busy}
          className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-red-700 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-red-300"
          aria-label={t('knowledge.doc.remove', { title: doc.title })}
          title={t('knowledge.doc.remove.title')}
          onClick={() => void remove(ownerId, doc.id)}
          data-testid="knowledge-doc-remove"
        >
          <TrashIcon size={14} />
        </button>
      )}
    </li>
  )
}

/**
 * Documenti di una base (quella di una conversazione o una della libreria): aggiunta da dialog o trascinando i
 * file, sorgenti collegate, elenco con stato, «Intero», rimozione, stato dell'indice e del modello di embedding.
 * `ownerId` è l'id della conversazione o della base. `readOnly`: base installata da un pacchetto, non si
 * aggiungono né si tolgono documenti.
 */
export function KnowledgeDocuments({ ownerId, readOnly = false }: { ownerId: string; readOnly?: boolean }): React.JSX.Element {
  const status = useKnowledge((s) => s.status[ownerId])
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
  const [over, setOver] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  /** Sorgente collegata in configurazione (form aperto). */
  const [connecting, setConnecting] = useState<string | null>(null)
  const connected = sources.filter((s) => s.kind === 'connected')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(ownerId), [ownerId, settings?.embeddingModel, pulling])

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
    void addFiles(ownerId, paths)
  }

  const statusText = !status
    ? t('knowledge.status.reading')
    : docs.length === 0
      ? t('knowledge.status.empty')
      : !status.modelInstalled
        ? t('knowledge.status.missing', { model })
        : tn('knowledge.status.chunks', status.chunks, { docs: tn('knowledge.status.docs', docs.length) }) + (status.pending ? t('knowledge.status.pending', { n: status.pending }) : '') + t('knowledge.status.with', { model })

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-documents">
      {!readOnly && (
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
          onClick={() => void pickFiles(ownerId)}
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
      )}

      {connecting && sources.find((s) => s.id === connecting) && (
        <ConnectForm ownerId={ownerId} source={sources.find((s) => s.id === connecting)!} onDone={() => setConnecting(null)} />
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
            <DocumentRow key={d.id} ownerId={ownerId} doc={d} readOnly={readOnly} />
          ))}
          {connections.map((c) => {
            const own = docs.filter((d) => d.connectionId === c.id)
            return (
              <li key={c.id} className="flex flex-col gap-1.5">
                <ul className="contents">
                  <ConnectionRow ownerId={ownerId} connection={c} documents={own.length} />
                </ul>
                {own.length > 0 && (
                  <ul className="ml-3 flex flex-col gap-1.5 border-l-2 border-brand-100 pl-2 dark:border-brand-900">
                    {own.map((d) => (
                      <DocumentRow key={d.id} ownerId={ownerId} doc={d} readOnly={readOnly} />
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
      {status && docs.length > 0 && !status.modelInstalled && (
        <button
          type="button"
          disabled={!!pulling}
          className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          onClick={() => void pull(model).then((e) => (e ? setPullError(e) : load(ownerId)))}
          data-testid="knowledge-download"
        >
          {pulling ? t('longMemory.downloading', { model, pct: pulling.total ? `${Math.round(((pulling.completed ?? 0) / pulling.total) * 100)}%` : '' }) : t('longMemory.download', { model })}
        </button>
      )}
      {pullError && <span className="text-xs text-red-700 dark:text-red-300">{pullError}</span>}
    </div>
  )
}

/** Avviso «serve il modello X» con il download: la base dichiara un modello di embedding che in Ollama manca. */
export function ModelMissing({ model }: { model: string }): React.JSX.Element {
  const pull = useModels((s) => s.pull)
  const pulling = useModels((s) => s.pulls[model])
  const loadBases = useKnowledge((s) => s.loadBases)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400" data-testid="knowledge-model-missing">
      <span>{t('knowledge.model.missing', { model })}</span>
      <button
        type="button"
        disabled={!!pulling && !pulling.done}
        className="rounded border border-amber-400 px-1.5 py-0.5 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-950/40"
        onClick={() => void pull(model).then((e) => (e ? setError(e) : loadBases()))}
      >
        {pulling && !pulling.done ? t('longMemory.downloading', { model, pct: pulling.total ? `${Math.round(((pulling.completed ?? 0) / pulling.total) * 100)}%` : '' }) : t('longMemory.download', { model })}
      </button>
      {error && <span className="text-red-700 dark:text-red-300">{error}</span>}
    </div>
  )
}

/** Numeri di una base: «3 documenti», con i pronti se non lo sono tutti. */
/** Il titolo di una base nella lingua dell'interfaccia: i pacchetti portano i titoli tradotti, le basi dell'utente il loro nome. */
export const baseTitle = (b: Pick<KnowledgeBaseInfo, 'name' | 'meta'>): string => b.meta?.i18n?.[getLocale()]?.name ?? b.name

export const baseDetail = (b: KnowledgeBaseInfo): string =>
  tn('knowledge.status.docs', b.documents) + (b.ready < b.documents ? ` · ${t('knowledge.base.ready', { n: b.ready })}` : '')

/** Id dei pacchetti delle basi che il ruolo della conversazione porta con sé. */
function useRoleBaseIds(conversation: Conversation): Set<string> {
  const roles = useRoles((s) => s.roles)
  return new Set((definitionOf(roles, conversation).bases ?? []).map((b) => b.id))
}

/**
 * Basi del ruolo: fanno parte del ruolo, in sola lettura e senza «Scollega». Se una base richiesta non è
 * installata lo si dice, senza bloccare nulla.
 */
function RoleBases({ conversation }: { conversation: Conversation }): React.JSX.Element | null {
  const linked = useKnowledge((s) => s.status[conversation.id]?.linked ?? EMPTY)
  const role = useRoles((s) => findRole(s.roles, conversation))
  const health = useRoles((s) => s.health[conversation.id])
  const checkHealth = useRoles((s) => s.checkHealth)
  const ids = useRoleBaseIds(conversation)
  const names = new Map((role?.definition.bases ?? []).map((b) => [b.id, b.name ?? b.id]))
  const refreshStatus = useKnowledge((s) => s.load)
  // Le basi installate dopo la creazione della conversazione vengono collegate dal controllo: poi si rilegge lo stato.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void checkHealth(conversation.id).then(() => refreshStatus(conversation.id)), [conversation.id, conversation.roleId])
  const own = linked.filter((b) => b.packageId && ids.has(b.packageId))
  const missing = health?.missingBases ?? []
  if (!role || (own.length === 0 && missing.length === 0)) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="role-bases">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('role.bases.title')}</span>
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{t('role.bases.hint', { role: roleName(role) })}</span>
      {own.map((b) => (
        <div key={b.id} className="flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-2 text-sm dark:border-brand-900 dark:bg-brand-950/40" data-testid="role-base">
          <BookOpenIcon size={16} className="mt-0.5 shrink-0 text-brand-700 dark:text-brand-300" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-zinc-800 dark:text-zinc-200">{baseTitle(b)}</div>
            <div className="truncate text-xs text-zinc-500">
              {t(`knowledge.purpose.${b.purpose ?? 'documents'}`)} · {baseDetail(b)}
            </div>
            {!b.modelInstalled && <ModelMissing model={b.model} />}
          </div>
        </div>
      ))}
      {missing.map((id) => (
        <p key={id} className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-snug text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="role-base-missing">
          {t('role.bases.missing', { id: names.get(id) ?? id })}
        </p>
      ))}
    </div>
  )
}

/** Basi della libreria collegate alla conversazione: elenco con «Scollega» e scelta di una base da collegare. */
function LinkedBases({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const roleBases = useRoleBaseIds(conversation)
  // Le basi del ruolo stanno a parte, in sola lettura.
  const all = useKnowledge((s) => s.status[conversation.id]?.linked ?? EMPTY)
  const linked = all.filter((b) => !(b.packageId && roleBases.has(b.packageId)))
  const bases = useKnowledge((s) => s.bases)
  const loadBases = useKnowledge((s) => s.loadBases)
  const link = useKnowledge((s) => s.link)
  const unlink = useKnowledge((s) => s.unlink)
  const setPurpose = useKnowledge((s) => s.setPurpose)
  const busy = useChat((s) => !!s.streams[conversation.id])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void loadBases(), [conversation.id])
  const available = bases.filter((b) => !all.some((l) => l.id === b.id))
  return (
    <div className="flex flex-col gap-1.5" data-testid="knowledge-linked">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('knowledge.linked.title')}</span>
      {linked.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {linked.map((b) => (
            <li key={b.id} className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 px-2.5 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950/20" data-testid="knowledge-linked-base">
              <BookOpenIcon size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-800 dark:text-zinc-200">{baseTitle(b)}</div>
                <div className="truncate text-xs text-zinc-500">{baseDetail(b)}</div>
                {!b.modelInstalled && <ModelMissing model={b.model} />}
                {/* A cosa serve la base in questa conversazione: documenti su cui rispondere (con il bottone libro),
                    oppure tecniche o esempi del ruolo, sempre attivi e senza fonti. */}
                <select
                  value={b.purpose ?? 'documents'}
                  disabled={busy}
                  aria-label={t('knowledge.purpose.label', { name: baseTitle(b) })}
                  onChange={(e) => void setPurpose(conversation.id, b.id, e.target.value as BasePurpose)}
                  className="mt-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                  data-testid="knowledge-purpose"
                >
                  {BASE_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {t(`knowledge.purpose.${p}`)}
                    </option>
                  ))}
                </select>
                {b.purpose && b.purpose !== 'documents' && <div className="mt-0.5 text-xs text-zinc-500">{t(`knowledge.purpose.hint.${b.purpose}`)}</div>}
              </div>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label={t('knowledge.linked.unlink', { name: baseTitle(b) })}
                title={t('knowledge.linked.unlink', { name: baseTitle(b) })}
                onClick={() => void unlink(conversation.id, b.id)}
                data-testid="knowledge-unlink"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 ? (
        <select
          value=""
          disabled={busy}
          aria-label={t('knowledge.linked.add')}
          onChange={(e) => e.target.value && void link(conversation.id, e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          data-testid="knowledge-link-select"
        >
          <option value="">{t('knowledge.linked.add')}</option>
          {available.map((b) => (
            <option key={b.id} value={b.id}>
              {baseTitle(b)} ({baseDetail(b)})
            </option>
          ))}
        </select>
      ) : null}
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{bases.length === 0 ? t('knowledge.linked.empty') : t('knowledge.linked.hint')}</span>
    </div>
  )
}

const EMPTY: KnowledgeBaseInfo[] = []

/**
 * Scheda «Conoscenza» della conversazione: la pill, lo spazio per i documenti, i documenti della conversazione,
 * le basi collegate e se tutto insieme sta nella memoria.
 */
export function KnowledgePanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const status = useKnowledge((s) => s.status[conversation.id])
  const caps = useModels((s) => s.capabilities[conversation.model])

  // Stanno nella memoria? La quota di num_ctx riservata ai documenti contro i token stimati dei pezzi pronti
  // (documenti della conversazione e delle basi collegate).
  const numCtx = resolveSettings(conversation, caps ?? null).numCtx
  const share = conversation.knowledgeShare ?? KNOWLEDGE.budgetShare
  const budgetTokens = Math.floor(numCtx * share)
  const docTokens = status ? Math.ceil(status.totalChars / DEFAULT_CHARS_PER_TOKEN) : 0
  const pinnedTokens = status ? Math.ceil(status.pinnedChars / DEFAULT_CHARS_PER_TOKEN) : 0
  const fitText = !status || docTokens === 0
    ? null
    : docTokens <= budgetTokens
      ? t('knowledge.fit.whole', { tokens: fmtInt(docTokens), budget: fmtInt(budgetTokens), share: Math.round(share * 100) })
      : t('knowledge.fit.excerpts', { tokens: fmtInt(docTokens), budget: fmtInt(budgetTokens), share: Math.round(share * 100), needed: fmtInt(Math.ceil(docTokens / share / 1024) * 1024) })
  const pinnedOver = !!status && pinnedTokens > budgetTokens

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-panel">
      <RoleBases conversation={conversation} />
      <KnowledgePill conversation={conversation} />
      <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{t('knowledge.intro')}</p>
      <ShareControl conversation={conversation} />

      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('knowledge.own.title')}</span>
      <KnowledgeDocuments ownerId={conversation.id} />

      <LinkedBases conversation={conversation} />

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
      <p className="text-xs leading-snug text-zinc-400">{t('knowledge.hint')}</p>
    </div>
  )
}
