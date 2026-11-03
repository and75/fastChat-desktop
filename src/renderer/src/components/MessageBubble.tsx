import type { Message } from '@shared/types'
import { Markdown } from './Markdown'

interface Props {
  role: Message['role']
  content: string
  /** Statistiche mostrate sotto le risposte salvate. */
  meta?: Pick<Message, 'model' | 'evalCount' | 'durationMs'>
  streaming?: boolean
  actions?: React.ReactNode
}

function formatMeta(meta: NonNullable<Props['meta']>): string {
  const parts: string[] = []
  if (meta.model) parts.push(meta.model)
  if (meta.evalCount != null) parts.push(`${meta.evalCount} token`)
  if (meta.durationMs != null) parts.push(`${(meta.durationMs / 1000).toFixed(1)} s`)
  if (meta.evalCount && meta.durationMs) parts.push(`${((meta.evalCount / meta.durationMs) * 1000).toFixed(1)} tok/s`)
  return parts.join(' · ')
}

export function MessageBubble({ role, content, meta, streaming, actions }: Props): React.JSX.Element {
  if (role === 'user') {
    return (
      <div className="flex justify-end" data-testid="message-user">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-white">
          {content}
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col gap-1" data-testid={streaming ? 'message-streaming' : 'message-assistant'}>
      <div className="max-w-full text-zinc-900 dark:text-zinc-100">
        {content ? <Markdown text={content} /> : streaming ? <span className="text-zinc-400">…</span> : null}
        {streaming && content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-zinc-400 align-middle" />}
      </div>
      {!streaming && (
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          {meta && <span>{formatMeta(meta)}</span>}
          {actions}
        </div>
      )}
    </div>
  )
}
