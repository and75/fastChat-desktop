import { useState } from 'react'
import { fmtTime, t } from '@shared/i18n'
import type { ConfigField, Conversation, KnowledgeConnection, KnowledgeSourceInfo } from '@shared/types'
import { useChat } from '../store/useChat'
import { useKnowledge } from '../store/useKnowledge'
import { RegenerateIcon, TrashIcon } from './icons'

/**
 * Form di configurazione di una sorgente collegata, disegnato dal nucleo a partire dai campi dichiarati dal
 * plugin: testo, cartella (con il dialog di sistema), segreto (password). Il plugin non ha interfaccia propria.
 */
export function ConnectForm({ conversation, source, onDone }: { conversation: Conversation; source: KnowledgeSourceInfo; onDone(): void }): React.JSX.Element {
  const connect = useKnowledge((s) => s.connect)
  const busy = useKnowledge((s) => s.busy)
  const [values, setValues] = useState<Record<string, string>>({})
  const set = (key: string, value: string): void => setValues((v) => ({ ...v, [key]: value }))
  const complete = source.configFields.every((f) => !f.required || values[f.key]?.trim())

  const field = (f: ConfigField): React.JSX.Element => {
    const input = 'min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'
    if (f.type === 'folder') {
      return (
        <div className="flex gap-2">
          <input readOnly value={values[f.key] ?? ''} placeholder={f.placeholder ?? ''} className={input + ' text-zinc-600 dark:text-zinc-300'} aria-label={f.label} data-testid={`connect-field-${f.key}`} />
          <button
            type="button"
            className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => void window.api.knowledge.pickFolder().then((r) => r.ok && r.data && set(f.key, r.data))}
            data-testid={`connect-pick-${f.key}`}
          >
            {t('knowledge.connect.choose')}
          </button>
        </div>
      )
    }
    return (
      <input
        type={f.type === 'secret' ? 'password' : 'text'}
        value={values[f.key] ?? ''}
        placeholder={f.placeholder ?? ''}
        onChange={(e) => set(f.key, e.target.value)}
        className={input}
        aria-label={f.label}
        autoComplete="off"
        data-testid={`connect-field-${f.key}`}
      />
    )
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800"
      onSubmit={async (e) => {
        e.preventDefault()
        if (await connect(conversation.id, source.id, values)) onDone()
      }}
      data-testid="connect-form"
    >
      <span className="font-medium text-zinc-800 dark:text-zinc-200">{t('knowledge.connect.title', { source: source.label })}</span>
      {source.configFields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">
            {f.label}
            {f.required ? ' *' : ''}
          </span>
          {field(f)}
        </label>
      ))}
      <div className="flex gap-2">
        <button type="submit" disabled={!complete || busy} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-40" data-testid="connect-submit">
          {busy ? t('knowledge.connect.working') : t('knowledge.connect.submit')}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

/** Una sorgente collegata: cosa, quando è stata aggiornata, stato; «Aggiorna» e «Scollega». */
export function ConnectionRow({ conversation, connection, documents }: { conversation: Conversation; connection: KnowledgeConnection; documents: number }): React.JSX.Element {
  const sources = useKnowledge((s) => s.sources)
  const refresh = useKnowledge((s) => s.refresh)
  const disconnect = useKnowledge((s) => s.disconnect)
  const busy = useChat((s) => !!s.streams[conversation.id])
  const source = sources.find((s) => s.id === connection.source)
  const label = source?.label ?? connection.source
  // Il campo principale (il primo) descrive la connessione: la cartella, l'URL…
  const main = source?.configFields[0] ? connection.config[source.configFields[0].key] : ''
  const detail =
    connection.status === 'syncing'
      ? t('knowledge.connection.syncing')
      : connection.status === 'error'
        ? connection.error ?? t('knowledge.doc.error')
        : t('knowledge.connection.synced', { docs: documents, time: connection.lastSyncAt ? fmtTime(connection.lastSyncAt) : '—' })
  return (
    <li className="flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50/50 px-2.5 py-2 text-sm dark:border-brand-900 dark:bg-brand-950/20" data-testid="knowledge-connection" data-status={connection.status}>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={main}>
          {label}
          {main ? <span className="font-normal text-zinc-500"> · {main}</span> : null}
        </div>
        <div className={'truncate text-xs ' + (connection.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-zinc-500')} title={detail}>
          {detail}
        </div>
      </div>
      <button
        type="button"
        disabled={connection.status === 'syncing'}
        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label={t('knowledge.connection.refresh')}
        title={t('knowledge.connection.refresh.title')}
        onClick={() => void refresh(conversation.id, connection.id)}
        data-testid="knowledge-connection-refresh"
      >
        <RegenerateIcon size={14} />
      </button>
      <button
        type="button"
        disabled={busy}
        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-red-700 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-red-300"
        aria-label={t('knowledge.connection.disconnect')}
        title={t('knowledge.connection.disconnect.title')}
        onClick={() => void disconnect(conversation.id, connection.id)}
        data-testid="knowledge-connection-disconnect"
      >
        <TrashIcon size={14} />
      </button>
    </li>
  )
}
