import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { MessageBubble } from './MessageBubble'

function Composer({ disabled, streaming }: { disabled: boolean; streaming: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  const send = useChat((s) => s.send)
  const abort = useChat((s) => s.abort)
  const conversationId = useChat((s) => s.conversation?.id)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [conversationId])

  // Altezza automatica fino a ~10 righe.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

  const submit = async (): Promise<void> => {
    if (disabled || streaming || !text.trim()) return
    const value = text
    setText('')
    if (!(await send(value))) setText(value)
  }

  return (
    <form
      className="border-t border-zinc-200 p-3 dark:border-zinc-800"
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
          placeholder={disabled ? 'Seleziona un modello per iniziare' : 'Scrivi un messaggio… (Invio per inviare, Maiusc+Invio per andare a capo)'}
          className="max-h-60 flex-1 resize-none bg-transparent px-1 py-1 outline-none disabled:cursor-not-allowed"
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
            Invia
          </button>
        )}
      </div>
    </form>
  )
}

export function ChatView(): React.JSX.Element {
  const { conversation, messages, streams, error, regenerate, clearError } = useChat()
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
            <MessageBubble
              key={m.id}
              role={m.role}
              content={m.content}
              meta={m.role === 'assistant' ? m : undefined}
              actions={
                canRegenerate && m === last && m.role === 'assistant' ? (
                  <button type="button" className="hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => void regenerate()}>
                    ↻ Rigenera
                  </button>
                ) : undefined
              }
            />
          ))}
          {live && <MessageBubble role="assistant" content={live.content} streaming />}
          {error && (
            <div
              role="alert"
              data-testid="chat-error"
              className="flex items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              <span className="flex-1">{error}</span>
              {last?.role === 'user' && (
                <button type="button" className="font-medium underline" onClick={() => void regenerate()}>
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
