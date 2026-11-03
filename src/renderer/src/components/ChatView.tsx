import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { MessageBubble } from './MessageBubble'
import { PlanModeToggle, ThinkToggle } from './ModelSettings'
import { PlanChecklist, PlanLoading, PlanSummary } from './PlanChecklist'

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

  const placeholder = disabled
    ? 'Seleziona un modello per iniziare'
    : conversation?.planMode
      ? 'Descrivi la richiesta: il modello proporrà prima un piano…'
      : 'Scrivi un messaggio… (Maiusc+Invio per andare a capo)'

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
      <div className="flex items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 focus-within:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          aria-label="Messaggio"
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
        {streaming ? (
          <button
            type="button"
            onClick={() => void abort()}
            className="rounded-lg bg-zinc-200 px-3 py-1.5 text-sm font-medium hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600"
          >
            Interrompi
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {conversation?.planMode ? 'Pianifica' : 'Invia'}
          </button>
        )}
      </div>
      {conversation && (
        <div className="mt-2 flex items-center gap-4 px-1 text-xs text-zinc-500">
          <ThinkToggle conversation={conversation} compact />
          <PlanModeToggle conversation={conversation} compact />
          <span data-testid="composer-temperature">Temperatura {conversation.temperature.toFixed(2)}</span>
        </div>
      )}
    </form>
  )
}

export function ChatView(): React.JSX.Element {
  const { conversation, messages, plans, streams, error, regenerate, retry, clearError } = useChat()
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

  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500">
        <p>Nessuna conversazione selezionata.</p>
        <button
          type="button"
          onClick={() => void create()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Nuova conversazione
        </button>
      </div>
    )
  }

  const last = messages.at(-1)
  const canRegenerate = !live && !!last

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6" data-testid="messages">
          {messages.length === 0 && !live && (
            <p className="text-center text-sm text-zinc-500">
              Scrivi il primo messaggio. Il brief nel pannello a destra viene inviato come system prompt.
            </p>
          )}
          {messages.map((m) => (
            <Fragment key={m.id}>
              <MessageBubble
                role={m.role}
                content={m.content}
                thinking={m.thinking}
                meta={m.role === 'assistant' ? m : undefined}
                actions={
                  canRegenerate && m === last && m.role === 'assistant' ? (
                    <button
                      type="button"
                      className="hover:text-zinc-700 dark:hover:text-zinc-200"
                      onClick={() => void regenerate()}
                    >
                      ↻ Rigenera
                    </button>
                  ) : undefined
                }
              />
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
          {live?.kind === 'plan' && <PlanLoading thinking={live.thinking} content={live.content} />}
          {live?.kind === 'chat' && (
            <MessageBubble role="assistant" content={live.content} thinking={live.thinking} streaming />
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
                  Riprova
                </button>
              )}
              <button type="button" aria-label="Chiudi" onClick={clearError}>
                ✕
              </button>
            </div>
          )}
        </div>
      </div>
      <Composer disabled={!conversation.model} streaming={!!live} />
    </div>
  )
}
