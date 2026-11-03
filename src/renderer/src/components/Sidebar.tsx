import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' })

function formatWhen(ts: number): string {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dateFmt.format(d)
}

function Item({ conv, active }: { conv: Conversation; active: boolean }): React.JSX.Element {
  const { select, update, remove } = useConversations()
  const streaming = useChat((s) => !!s.streams[conv.id])
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conv.title)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    if (title.trim() && title !== conv.title) void update(conv.id, { title })
    else setTitle(conv.title)
  }

  const btn = 'rounded px-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100'

  return (
    <li
      data-testid="conversation-item"
      className={
        'group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ' +
        (active ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900')
      }
    >
      {editing ? (
        <input
          ref={input}
          aria-label="Titolo conversazione"
          className="min-w-0 flex-1 rounded border border-blue-500 bg-white px-1 dark:bg-zinc-900"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setTitle(conv.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => void select(conv.id)}
          onDoubleClick={() => setEditing(true)}
          title={conv.title}
        >
          {streaming && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />}
          <span className="truncate">{conv.title}</span>
        </button>
      )}
      {!editing && (
        <>
          <span className="shrink-0 text-xs text-zinc-400 group-hover:hidden">{formatWhen(conv.updatedAt)}</span>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <button type="button" className={btn} title="Rinomina" onClick={() => setEditing(true)}>
              ✎
            </button>
            <button
              type="button"
              className={btn}
              title={conv.archived ? 'Ripristina' : 'Archivia'}
              onClick={() => void update(conv.id, { archived: !conv.archived })}
            >
              {conv.archived ? '↩' : '⤓'}
            </button>
            <button
              type="button"
              className={btn}
              title="Elimina"
              onClick={() => {
                if (window.confirm(`Eliminare "${conv.title}" e tutti i suoi messaggi?`)) void remove(conv.id)
              }}
            >
              🗑
            </button>
          </span>
        </>
      )}
    </li>
  )
}

export function Sidebar(): React.JSX.Element {
  const { conversations, activeId, search, showArchived, setSearch, setShowArchived, create } = useConversations()
  const [query, setQuery] = useState(search)

  // Ricerca con debounce.
  useEffect(() => {
    const t = setTimeout(() => {
      if (query !== useConversations.getState().search) setSearch(query)
    }, 200)
    return () => clearTimeout(t)
  }, [query, setSearch])

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-2 p-3">
        <button
          type="button"
          onClick={() => void create()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Nuova conversazione
        </button>
        <input
          type="search"
          aria-label="Cerca conversazioni"
          placeholder="Cerca…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2" aria-label="Conversazioni">
        {conversations.map((c) => (
          <Item key={c.id} conv={c} active={c.id === activeId} />
        ))}
        {conversations.length === 0 && (
          <li className="px-2 py-4 text-center text-sm text-zinc-500">
            {search ? 'Nessun risultato' : showArchived ? 'Nessuna conversazione archiviata' : 'Nessuna conversazione'}
          </li>
        )}
      </ul>
      <label className="flex items-center gap-2 border-t border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        Mostra archiviate
      </label>
    </aside>
  )
}
