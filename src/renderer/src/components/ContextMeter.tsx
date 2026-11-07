import { computeContextUsage, DEFAULT_CHARS_PER_TOKEN, formatTokensK, SUMMARY, type ContextUsage } from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import { useChat } from '../store/useChat'
import { useModels } from '../store/useModels'

/**
 * Uso attuale della memoria della conversazione aperta: lo stesso calcolo per il contatore in basso e per
 * lo «Stato del contesto» nella scheda Contesto.
 */
export function useContextUsage(): ContextUsage | null {
  const conversation = useChat((s) => s.conversation)
  const messages = useChat((s) => s.messages)
  const live = useChat((s) => (s.conversation ? s.streams[s.conversation.id] : undefined))
  const caps = useModels((s) => (conversation ? s.capabilities[conversation.model] : undefined))
  if (!conversation) return null
  // Durante lo streaming conta anche la risposta che sta arrivando.
  const all = live?.kind === 'chat' && live.content ? [...messages, { role: 'assistant' as const, content: live.content }] : messages
  // Stessa memoria che il main invia a Ollama come num_ctx.
  return computeContextUsage({
    brief: conversation,
    style: conversation.style,
    messages: all,
    numCtx: resolveSettings(conversation, caps).numCtx,
    summary: conversation.summary,
    summaryUpTo: conversation.summaryUpTo,
    summaryUpdatedAt: conversation.summaryUpdatedAt
  })
}

/** Uso della memoria della conversazione: «Contesto 3,2k / 8,2k · 40%» con barretta. */
export function ContextMeter(): React.JSX.Element | null {
  const conversation = useChat((s) => s.conversation)
  const usage = useContextUsage()
  if (!conversation || !usage) return null
  const pct = Math.round(usage.ratio * 100)
  // Oltre la soglia, alla prossima domanda i messaggi più vecchi vengono riassunti prima della risposta.
  const over = usage.ratio > SUMMARY.trigger
  const fmt = (n: number): string => n.toLocaleString('it-IT', { useGrouping: 'always' })
  const title =
    `${usage.estimated ? 'Circa ' : ''}${fmt(usage.used)} token usati su ${fmt(usage.total)} disponibili` +
    (usage.estimated
      ? ` (stima a ${usage.charsPerToken.toLocaleString('it-IT')} caratteri per token${usage.charsPerToken === DEFAULT_CHARS_PER_TOKEN ? '' : ', misurati su questa conversazione'}; il conteggio esatto arriva da Ollama dopo la risposta)`
      : ' (conteggio di Ollama: prompt + risposta)') +
    (conversation.summary ? '. I messaggi più vecchi sono nel riassunto automatico' : '') +
    (conversation.autoSummary
      ? `. Oltre il ${Math.round(SUMMARY.trigger * 100)}% i messaggi più vecchi vengono riassunti prima della risposta.`
      : over
        ? '. Riassunto automatico spento: oltre lo spazio disponibile i messaggi più vecchi non vengono inviati.'
        : '')

  return (
    <span className="flex items-center gap-2" title={title} data-testid="context-usage">
      <span className="tabular-nums">
        Contesto {usage.estimated ? '≈' : ''}
        {formatTokensK(usage.used)} / {formatTokensK(usage.total)} · {pct > 100 ? '>100' : pct}%
      </span>
      <span
        aria-hidden
        className="relative h-1.5 w-14 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        {/* Tacca della soglia del riassunto. */}
        <span className="absolute inset-y-0 w-px bg-zinc-400 dark:bg-zinc-500" style={{ left: `${SUMMARY.trigger * 100}%` }} data-testid="context-threshold" />
        <span
          className={'absolute inset-y-0 left-0 rounded-full ' + (over ? 'bg-brand-700 dark:bg-brand-400' : 'bg-brand-500')}
          style={{ width: `${Math.min(100, Math.max(usage.used > 0 ? 3 : 0, pct))}%` }}
        />
      </span>
    </span>
  )
}
