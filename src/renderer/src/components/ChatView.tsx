import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { readyCount, useKnowledge } from '../store/useKnowledge'
import { ContextMeter } from './ContextMeter'
import { ConversationTimeline, type TimelineItem } from './ConversationTimeline'
import { CopyAction } from './CopyButton'
import { BookOpenIcon, RegenerateIcon } from './icons'

/**
 * Bottone libro: la prossima domanda usa la base di conoscenza? Mostra lo stato effettivo (la pill della
 * conversazione, o la scelta fatta qui) e un clic lo inverte per questa domanda sola.
 */
function KnowledgeButton({ conversation, disabled }: { conversation: { id: string; knowledge: boolean }; disabled: boolean }): React.JSX.Element {
  const next = useChat((s) => s.knowledgeNext)
  const setNext = useChat((s) => s.setKnowledgeNext)
  const ready = useKnowledge((s) => readyCount(s.status[conversation.id]))
  const effective = next ?? conversation.knowledge
  const usable = ready > 0 && !disabled
  const title = !usable
    ? t('chat.knowledge.noDocs')
    : effective
      ? next == null
        ? t('chat.knowledge.on')
        : t('chat.knowledge.onOnce')
      : next == null
        ? t('chat.knowledge.off')
        : t('chat.knowledge.offOnce')
  return (
    <button
      type="button"
      disabled={!usable}
      aria-pressed={usable && effective}
      aria-label={t('chat.knowledge.label')}
      title={title}
      onClick={() => {
        const flipped = !effective
        setNext(flipped === conversation.knowledge ? null : flipped)
      }}
      className={
        'rounded-lg p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30 ' +
        (usable && effective
          ? 'bg-brand-100 text-brand-700 hover:bg-brand-200 dark:bg-brand-900/50 dark:text-brand-300 dark:hover:bg-brand-900'
          : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200')
      }
      data-testid="knowledge-button"
    >
      <BookOpenIcon size={18} />
    </button>
  )
}
import { MessageBubble } from './MessageBubble'
import { PlanModeToggle, ThinkToggle, StyleControl } from './ModelSettings'
import { PlanChecklist, PlanLoading, PlanSummary } from './PlanChecklist'
import { SummaryCard } from './SummaryCard'

function Composer({ disabled, streaming }: { disabled: boolean; streaming: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  const send = useChat((s) => s.send)
  const abort = useChat((s) => s.abort)
  const conversation = useChat((s) => s.conversation)
  const conversationId = conversation?.id
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [conversationId])

  const placeholder = disabled ? t('chat.placeholder.noModel') : conversation?.planMode ? t('chat.placeholder.plan') : t('chat.placeholder')

  /**
   * Altezza del campo: segue il testo fino al 40% della finestra, poi il testo scorre dentro.
   * Da vuoto resta su una riga, anche se il placeholder è più lungo del campo.
   */
  const resize = useCallback((): void => {
    const el = ref.current
    if (!el) return
    if (!el.value) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px'
  }, [])

  useLayoutEffect(resize, [text, conversationId, placeholder, resize])

  // Ricalcolo quando cambia la larghezza (pannello aperto/chiuso, finestra ridimensionata) o il tetto del 40%.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      // Solo i cambi di larghezza: quelli di altezza li causa resize() stesso.
      if (el.clientWidth === lastWidth) return
      lastWidth = el.clientWidth
      resize()
    })
    observer.observe(el)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [resize])

  const submit = async (): Promise<void> => {
    if (disabled || streaming || !text.trim()) return
    const value = text
    setText('')
    if (!(await send(value))) setText(value)
  }

  return (
    <form
      // Stessa colonna dei messaggi (max-w-3xl, px-4), senza linea di separazione.
      className="mx-auto w-full max-w-3xl px-4 pb-3 pt-1"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 focus-within:border-brand-500 dark:border-zinc-700 dark:bg-zinc-900">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          aria-label={t('chat.message')}
          placeholder={placeholder}
          className="max-h-[40vh] flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 outline-none disabled:cursor-not-allowed"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {conversation && <KnowledgeButton conversation={conversation} disabled={disabled || streaming} />}
        {streaming ? (
          <button
            type="button"
            onClick={() => void abort()}
            className="rounded-lg bg-zinc-200 px-3 py-1.5 text-sm font-medium hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
          >
            {t('chat.stop')}
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {conversation?.planMode ? t('chat.plan') : t('chat.send')}
          </button>
        )}
      </div>
      {conversation && (
        <div className="mt-2 flex items-center gap-4 px-1 text-xs text-zinc-500">
          <ThinkToggle conversation={conversation} compact />
          <PlanModeToggle conversation={conversation} compact />
          <span data-testid="composer-temperature">{t('chat.temperature', { value: conversation.temperature.toFixed(2) })}</span>
          <StyleControl conversation={conversation} compact />
          <ContextMeter />
        </div>
      )}
    </form>
  )
}

/** Messaggio inviato da "Continua": la risposta tagliata al limite di token riprende da dove si è fermata. */
export const continuePrompt = (): string => t('chat.continuePrompt')

export function ChatView(): React.JSX.Element {
  const { conversation, messages, plans, streams, error, regenerate, retry, clearError, send } = useChat()
  const create = useConversations((s) => s.create)
  const live = conversation ? streams[conversation.id] : undefined
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Segue il fondo durante lo streaming, a meno che l'utente non sia risalito.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, live?.content, live?.thinking])

  useEffect(() => {
    stick.current = true
  }, [conversation?.id])

  // Un pallino per messaggio nella cronologia, più la risposta in arrivo.
  const liveContent = live?.kind === 'chat' ? live.content : null
  const summaryUpTo = conversation?.summary ? conversation.summaryUpTo : null
  const timeline = useMemo<TimelineItem[]>(() => {
    const coveredUntil = summaryUpTo ? messages.findIndex((m) => m.id === summaryUpTo) : -1
    const items: TimelineItem[] = messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      summarized: i <= coveredUntil
    }))
    if (liveContent != null)
      items.push({
        id: 'live',
        role: 'assistant',
        content: liveContent,
        live: true
      })
    return items
  }, [messages, liveContent, summaryUpTo])

  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500">
        <p>{t('chat.noConversation')}</p>
        <button
          type="button"
          onClick={() => void create()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('sidebar.new')}
        </button>
      </div>
    )
  }

  const last = messages.at(-1)
  const canRegenerate = !live && !!last

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          className="@container relative min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {/* Nelle colonne strette i messaggi lasciano spazio a destra per la cronologia. */}
          <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-6 @max-[52rem]:pr-10" data-testid="messages">
            {messages.length === 0 && !live && (
              <p className="text-center text-sm text-zinc-500">
                {t('chat.firstMessage')}
              </p>
            )}
            {messages.map((m) => (
              <Fragment key={m.id}>
                <MessageBubble
                  anchorId={m.id}
                  role={m.role}
                  content={m.content}
                  thinking={m.thinking}
                  createdAt={m.createdAt}
                  meta={m.role === 'assistant' ? m : undefined}
                  memoryRefs={m.role === 'assistant' ? m.memoryRefs : null}
                  knowledgeRefs={m.role === 'assistant' ? m.knowledgeRefs : null}
                  knowledge={m.role === 'user' ? m.knowledge : null}
                  truncated={m.doneReason === 'length'}
                  actions={
                    m.role === 'assistant' ? (
                      <>
                        {canRegenerate && m === last && m.doneReason === 'length' && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
                            title={t('chat.continue.title')}
                            onClick={() => void send(continuePrompt())}
                            data-testid="continue-answer"
                          >
                            {t('chat.continue')}
                          </button>
                        )}
                        {canRegenerate && m === last && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-200"
                            onClick={() => void regenerate()}
                          >
                            <RegenerateIcon size={13} />
                            {t('chat.regenerate')}
                          </button>
                        )}
                        {m.content && <CopyAction text={m.content} />}
                      </>
                    ) : undefined
                  }
                />
                {/* Confine tra la parte riassunta e quella inviata per intero. */}
                {m.id === summaryUpTo && <SummaryCard conversation={conversation} covered={messages.indexOf(m) + 1} />}
                {plans
                  .filter((p) => p.userMessageId === m.id)
                  .map((p) =>
                    m === last && (p.status === 'proposed' || p.status === 'approved') ? (
                      <PlanChecklist key={p.id} plan={p} busy={!!live} />
                    ) : (
                      <PlanSummary key={p.id} plan={p} />
                    )
                  )}
              </Fragment>
            ))}
            {live?.kind === 'plan' && (
              <PlanLoading thinking={live.thinking} content={live.content} startedAt={live.startedAt} summarizing={live.summarizing} />
            )}
            {live?.kind === 'chat' && (
              <MessageBubble
                anchorId="live"
                role="assistant"
                content={live.content}
                thinking={live.thinking}
                summarizing={live.summarizing}
                remembering={live.remembering}
                searching={live.searching}
                streaming
                startedAt={live.startedAt}
              />
            )}
            {error && (
              <div
                role="alert"
                data-testid="chat-error"
                className="flex items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              >
                <span className="flex-1">{error}</span>
                {last?.role === 'user' && (
                  <button type="button" className="font-medium underline" onClick={() => void retry()}>
                    {t('chat.retry')}
                  </button>
                )}
                <button type="button" aria-label={t('common.close')} onClick={clearError}>
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
        <ConversationTimeline key={conversation.id} items={timeline} scroller={scroller} />
      </div>
      <Composer disabled={!conversation.model} streaming={!!live} />
    </div>
  )
}
