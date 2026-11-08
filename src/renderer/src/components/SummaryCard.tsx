import { useEffect, useState } from 'react'
import { fmtTime, t, tn } from '@shared/i18n'
import { summaryPreview } from '@shared/format'
import type { Conversation } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'

/**
 * Scheda del riassunto automatico, nel flusso dei messaggi al confine tra la parte riassunta (sopra) e
 * quella inviata per intero (sotto). Chiusa mostra la prima riga; aperta, il testo modificabile.
 */
export function SummaryCard({ conversation, covered }: { conversation: Conversation; covered: number }): React.JSX.Element | null {
  const update = useConversations((s) => s.update)
  const summarize = useConversations((s) => s.summarize)
  const busy = useChat((s) => !!s.streams[conversation.id])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(conversation.summary ?? '')
  const [working, setWorking] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(conversation.summary ?? ''), [conversation.id, conversation.summary])
  if (!conversation.summary) return null

  const firstLine = summaryPreview(conversation.summary)
  const refresh = async (): Promise<void> => {
    setWorking(true)
    setFeedback(null)
    const before = useConversations.getState().error
    const ok = await summarize(conversation.id)
    if (!ok) {
      const err = useConversations.getState().error
      setFeedback(err && err !== before ? err : t('summary.failed'))
      useConversations.setState({ error: before })
    }
    setWorking(false)
  }

  return (
    <section
      aria-label={t('summary.card')}
      data-testid="summary-card"
      data-message-id="summary"
      className="scroll-mt-4 rounded-xl border border-dashed border-brand-300 bg-brand-50/60 px-4 py-3 text-sm dark:border-brand-800 dark:bg-brand-950/40"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-brand-800 dark:text-brand-300">
          {t('summary.card')}
          <span className="ml-2 text-xs font-normal text-zinc-500">
            {tn('summary.covers', covered)}
            {conversation.summaryUpdatedAt ? t('summary.updatedAt', { time: fmtTime(conversation.summaryUpdatedAt) }) : ''}
          </span>
        </span>
        <span className="flex gap-2 text-xs">
          <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => setOpen((o) => !o)} data-testid="summary-toggle">
            {open ? t('summary.hide') : t('summary.showEdit')}
          </button>
          <button
            type="button"
            className="text-brand-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-300"
            disabled={working || busy}
            title={t('summary.refresh.title')}
            onClick={() => void refresh()}
            data-testid="summary-refresh"
          >
            {working ? t('summary.refreshing') : t('summary.refresh')}
          </button>
          <button
            type="button"
            className="text-red-700 hover:underline dark:text-red-300"
            title={t('summary.delete.title')}
            onClick={() => void update(conversation.id, { summary: null })}
            data-testid="summary-clear"
          >
            {t('summary.delete')}
          </button>
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {t('summary.explain')}
      </p>
      {!open && (
        <p className="mt-1 truncate text-zinc-700 dark:text-zinc-300" title={conversation.summary} data-testid="summary-preview">
          {firstLine}
        </p>
      )}
      {open && (
        <textarea
          aria-label={t('summary.text')}
          rows={8}
          value={draft}
          className="mt-2 w-full resize-y rounded-lg border border-zinc-300 bg-white p-2 text-xs leading-snug dark:border-zinc-700 dark:bg-zinc-900"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() !== (conversation.summary ?? '')) void update(conversation.id, { summary: draft })
          }}
          data-testid="summary-text"
        />
      )}
      {feedback && <span className="mt-1 block text-xs text-red-700 dark:text-red-300">{feedback}</span>}
    </section>
  )
}
