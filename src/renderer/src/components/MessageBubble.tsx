import { formatFullDate, formatMessageDate } from '@shared/format'
import type { Message } from '@shared/types'
import { Markdown } from './Markdown'
import { WaitingIndicator } from './Loader'
import { ThinkingBlock } from './ThinkingBlock'

interface Props {
  role: Message['role']
  content: string
  thinking?: string | null
  /** Statistiche mostrate sotto le risposte salvate. */
  meta?: Pick<Message, 'model' | 'evalCount' | 'durationMs'>
  streaming?: boolean
  /** Durante lo streaming: i messaggi più vecchi vengono riassunti prima della risposta. */
  summarizing?: boolean
  /** Data del messaggio (mostrata sotto i messaggi dell'utente). */
  createdAt?: number
  /** Inizio della richiesta in corso (solo durante lo streaming). */
  startedAt?: number
  actions?: React.ReactNode
  /** La risposta è stata fermata da Ollama al limite di token (contesto esaurito). */
  truncated?: boolean
  /** Identificativo per la cronologia (attributo `data-message-id`). */
  anchorId?: string
}

function formatMeta(meta: NonNullable<Props['meta']>): string {
  const parts: string[] = []
  if (meta.model) parts.push(meta.model)
  if (meta.evalCount != null) parts.push(`${meta.evalCount} token`)
  if (meta.durationMs != null) parts.push(`${(meta.durationMs / 1000).toFixed(1)} s`)
  if (meta.evalCount && meta.durationMs) parts.push(`${((meta.evalCount / meta.durationMs) * 1000).toFixed(1)} tok/s`)
  return parts.join(' · ')
}

export function MessageBubble({
  role,
  content,
  thinking,
  meta,
  streaming,
  summarizing = false,
  startedAt,
  createdAt,
  actions,
  truncated = false,
  anchorId
}: Props): React.JSX.Element {
  if (role === 'user') {
    return (
      <div className="flex scroll-mt-4 flex-col items-end gap-1" data-testid="message-user" data-message-id={anchorId}>
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-white">
          {content}
        </div>
        {createdAt != null && (
          <time
            dateTime={new Date(createdAt).toISOString()}
            title={formatFullDate(createdAt)}
            className="px-1 text-xs text-zinc-400"
            data-testid="message-date"
          >
            {formatMessageDate(createdAt)}
          </time>
        )}
      </div>
    )
  }

  return (
    <div
      className="group flex scroll-mt-4 flex-col gap-2"
      data-testid={streaming ? 'message-streaming' : 'message-assistant'}
      data-message-id={anchorId}
    >
      {/* Durante lo streaming il ragionamento resta aperto finché non inizia la risposta. */}
      {thinking && <ThinkingBlock text={thinking} live={!!streaming && !content} startedAt={startedAt} />}
      <div className="max-w-full text-zinc-900 dark:text-zinc-100">
        {content ? (
          <Markdown text={content} />
        ) : streaming && !thinking ? (
          <WaitingIndicator since={startedAt} label={summarizing ? 'Sto riassumendo i messaggi più vecchi' : undefined} />
        ) : null}
        {streaming && content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-zinc-400 align-middle" />}
      </div>
      {!streaming && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          {meta && <span>{formatMeta(meta)}</span>}
          {truncated && (
            <span
              className="text-amber-700 dark:text-amber-400"
              title="Ollama ha fermato la risposta perché la memoria della conversazione è esaurita. Chiedi di continuare, o alza la memoria nel pannello Modello."
              data-testid="truncated-note"
            >
              Risposta interrotta: memoria esaurita
            </span>
          )}
          {actions}
        </div>
      )}
    </div>
  )
}
