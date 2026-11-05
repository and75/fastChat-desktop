import { computeContextUsage, formatTokensK } from '@shared/prompt'
import { resolveNumCtx } from '@shared/settings'
import { useChat } from '../store/useChat'
import { useModels } from '../store/useModels'

/** Uso della memoria della conversazione: «Contesto 3,2k / 8,2k · 40%» con barretta. */
export function ContextMeter(): React.JSX.Element | null {
  const conversation = useChat((s) => s.conversation)
  const messages = useChat((s) => s.messages)
  const live = useChat((s) => (s.conversation ? s.streams[s.conversation.id] : undefined))
  const caps = useModels((s) => (conversation ? s.capabilities[conversation.model] : undefined))
  if (!conversation) return null

  // Durante lo streaming conta anche la risposta che sta arrivando.
  const all = live?.kind === 'chat' && live.content ? [...messages, { role: 'assistant' as const, content: live.content }] : messages
  // Stessa memoria che il main invia a Ollama come num_ctx.
  const usage = computeContextUsage({ brief: conversation, messages: all, numCtx: resolveNumCtx(conversation, caps) })
  const pct = Math.round(usage.ratio * 100)
  const over = usage.ratio > 1
  const fmt = (n: number): string => n.toLocaleString('it-IT', { useGrouping: 'always' })
  const title =
    `${usage.estimated ? 'Circa ' : ''}${fmt(usage.used)} token usati su ${fmt(usage.total)} disponibili` +
    (usage.estimated ? ' (stima: il conteggio esatto arriva da Ollama dopo la risposta)' : ' (conteggio di Ollama: prompt + risposta)') +
    (over ? '. Oltre il limite, i messaggi più vecchi non vengono inviati.' : '')

  return (
    <span className="flex items-center gap-2" title={title} data-testid="context-usage">
      <span className="tabular-nums">
        Contesto {usage.estimated ? '≈' : ''}
        {formatTokensK(usage.used)} / {formatTokensK(usage.total)} · {over ? '>100' : pct}%
      </span>
      <span
        aria-hidden
        className="relative h-1.5 w-14 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <span
          className={'absolute inset-y-0 left-0 rounded-full ' + (usage.ratio >= 0.9 ? 'bg-brand-700 dark:bg-brand-400' : 'bg-brand-500')}
          style={{ width: `${Math.min(100, Math.max(usage.used > 0 ? 3 : 0, pct))}%` }}
        />
      </span>
    </span>
  )
}
