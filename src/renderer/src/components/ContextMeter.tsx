import { computeContextUsage, DEFAULT_CHARS_PER_TOKEN, formatTokensK, SUMMARY, type ContextUsage } from '@shared/prompt'
import { fmtInt, fmtNum, t } from '@shared/i18n'
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
    // Fino alla scelta del ruolo nell'interfaccia le conversazioni sono sul Generalista: nessuna istruzione.
    situation: conversation.situation,
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
  const title =
    t('meter.used', { about: usage.estimated ? t('meter.about') : '', used: fmtInt(usage.used), total: fmtInt(usage.total) }) +
    (usage.estimated
      ? t('meter.estimated', { cpt: fmtNum(usage.charsPerToken, 2), measured: usage.charsPerToken === DEFAULT_CHARS_PER_TOKEN ? '' : t('meter.measured') })
      : t('meter.counted')) +
    (conversation.summary ? t('meter.inSummary') : '') +
    (conversation.autoSummary ? t('meter.autoSummary', { pct: Math.round(SUMMARY.trigger * 100) }) : over ? t('meter.noSummary') : '')

  return (
    <span className="flex items-center gap-2" title={title} data-testid="context-usage">
      <span className="tabular-nums">
        {t('meter.label')} {usage.estimated ? '≈' : ''}
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
