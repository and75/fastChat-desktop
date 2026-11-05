import { computeContextUsage, DEFAULT_CHARS_PER_TOKEN, formatTokensK } from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
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
  // Stessa memoria che il main invia a Ollama come num_ctx; la riserva è num_predict.
  const effective = resolveSettings(conversation, caps)
  const usage = computeContextUsage({ brief: conversation, messages: all, numCtx: effective.numCtx })
  const pct = Math.round(usage.ratio * 100)
  const reservePct = Math.round((effective.numPredict / effective.numCtx) * 100)
  // Lo storico viene tagliato quando non sta nello spazio che resta oltre la riserva.
  const over = usage.ratio > 1 - effective.numPredict / effective.numCtx
  const fmt = (n: number): string => n.toLocaleString('it-IT', { useGrouping: 'always' })
  const title =
    `${usage.estimated ? 'Circa ' : ''}${fmt(usage.used)} token usati su ${fmt(usage.total)} disponibili` +
    (usage.estimated
      ? ` (stima a ${usage.charsPerToken.toLocaleString('it-IT')} caratteri per token${usage.charsPerToken === DEFAULT_CHARS_PER_TOKEN ? '' : ', misurati su questa conversazione'}; il conteggio esatto arriva da Ollama dopo la risposta)`
      : ' (conteggio di Ollama: prompt + risposta)') +
    `. Riserva per la risposta: ${fmt(effective.numPredict)} token` +
    (over ? '. Oltre lo spazio disponibile, i messaggi più vecchi non vengono inviati.' : '')

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
        {/* Riserva per la risposta: zona tratteggiata in fondo alla barra. */}
        <span
          className="absolute inset-y-0 right-0 bg-zinc-300/70 dark:bg-zinc-600/70"
          style={{ width: `${Math.min(100, reservePct)}%` }}
          data-testid="context-reserve"
        />
        <span
          className={'absolute inset-y-0 left-0 rounded-full ' + (over ? 'bg-brand-700 dark:bg-brand-400' : 'bg-brand-500')}
          style={{ width: `${Math.min(100, Math.max(usage.used > 0 ? 3 : 0, pct))}%` }}
        />
      </span>
    </span>
  )
}
