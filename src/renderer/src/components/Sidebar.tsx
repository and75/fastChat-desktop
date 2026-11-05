import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { useTemplates } from '../store/useTemplates'
import { IconButton } from './IconButton'
import { AppLogo, ChevronDownIcon, PanelLeftIcon, PlusIcon, SettingsIcon } from './icons'
import { isMac } from './WindowControls'

/** Elenco dei template: un clic crea una conversazione con quel brief e quelle impostazioni. */
function TemplateMenu({ onDone }: { onDone(): void }): React.JSX.Element {
  const { templates, refresh, remove } = useTemplates()
  const create = useConversations((s) => s.create)
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div
      data-testid="template-menu"
      className="flex flex-col gap-0.5 rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      {templates.length === 0 && (
        <p className="px-2 py-2 text-zinc-500">Nessun template. Usa «Salva come template» nel pannello del brief.</p>
      )}
      {templates.map((t) => (
        <div key={t.id} className="group flex items-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <button
            type="button"
            className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
            title={[t.role, t.goals].filter(Boolean).join(' · ') || t.name}
            onClick={() => {
              onDone()
              void create(t.id)
            }}
          >
            {t.name}
          </button>
          <button
            type="button"
            aria-label={`Elimina il template ${t.name}`}
            className="hidden px-2 text-zinc-400 hover:text-red-600 group-hover:block"
            onClick={() => {
              if (window.confirm(`Eliminare il template "${t.name}"?`)) void remove(t.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

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
          className="min-w-0 flex-1 rounded border border-brand-500 bg-white px-1 dark:bg-zinc-900"
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
          {streaming && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-500" />}
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

/** «Nuova conversazione» in stile outline, con la freccia dei preset (template) attaccata. */
function NewConversationButton(): React.JSX.Element {
  const create = useConversations((s) => s.create)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // Il menu dei preset si chiude con clic fuori o Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const part =
    'flex items-center justify-center text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:outline-none dark:text-brand-300 dark:hover:bg-brand-950/60 dark:focus-visible:bg-brand-950/60'

  return (
    <div ref={root} className="relative">
      <div className="flex overflow-hidden rounded-lg border border-brand-600 dark:border-brand-500">
        <button
          type="button"
          data-testid="new-conversation"
          onClick={() => void create()}
          className={part + ' flex-1 gap-2 whitespace-nowrap px-3 py-2'}
        >
          <PlusIcon size={16} />
          Nuova conversazione
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Nuova da template"
          title="Nuova conversazione da un preset"
          onClick={() => setOpen((o) => !o)}
          className={part + ' border-l border-brand-600 px-2.5 dark:border-brand-500 ' + (open ? 'bg-brand-50 dark:bg-brand-950/60' : '')}
        >
          <ChevronDownIcon size={16} className={'transition-transform ' + (open ? 'rotate-180' : '')} />
        </button>
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5">
          <TemplateMenu onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

const COLLAPSED_KEY = 'fastchat.sidebarCollapsed'

/** Stato aperta/chiusa della barra laterale, ricordato anche dopo il riavvio. */
function useCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = (v: boolean): void => {
    setCollapsed(v)
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0')
    } catch {
      /* storage non disponibile: vale solo per questa sessione */
    }
  }
  return [collapsed, set]
}

/** Barra laterale chiusa: striscia con logo, pulsante per riaprire, nuova conversazione e impostazioni. */
function CollapsedRail({ onExpand, onOpenSettings }: { onExpand(): void; onOpenSettings(): void }): React.JSX.Element {
  const create = useConversations((s) => s.create)
  return (
    <aside
      aria-label="Barra laterale"
      data-collapsed="true"
      className={
        'flex shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 pb-3 dark:border-zinc-800 dark:bg-zinc-950 ' +
        (isMac ? 'w-20' : 'w-16')
      }
    >
      {/* Blocco del logo (zona di trascinamento); su macOS sotto i semafori. */}
      <div className={'drag flex w-full flex-col items-center gap-3 pb-4 ' + (isMac ? 'pt-11' : 'pt-4')}>
        <AppLogo size={30} />
        <IconButton tooltip="Apri la barra laterale" tooltipPlacement="right" aria-expanded={false} onClick={onExpand}>
          <PanelLeftIcon size={18} />
        </IconButton>
      </div>
      <IconButton tooltip="Nuova conversazione" tooltipPlacement="right" data-testid="new-conversation-rail" onClick={() => void create()}>
        <PlusIcon size={18} />
      </IconButton>
      <div className="flex-1" />
      <IconButton tooltip="Impostazioni" tooltipPlacement="right" onClick={onOpenSettings}>
        <SettingsIcon size={18} />
      </IconButton>
    </aside>
  )
}

export function Sidebar({ onOpenSettings }: { onOpenSettings(): void }): React.JSX.Element {
  const [collapsed, setCollapsed] = useCollapsed()
  if (collapsed) return <CollapsedRail onExpand={() => setCollapsed(false)} onOpenSettings={onOpenSettings} />
  return <ExpandedSidebar onCollapse={() => setCollapsed(true)} onOpenSettings={onOpenSettings} />
}

function ExpandedSidebar({ onOpenSettings, onCollapse }: { onOpenSettings(): void; onCollapse(): void }): React.JSX.Element {
  const { conversations, activeId, search, showArchived, setSearch, setShowArchived } = useConversations()
  const [query, setQuery] = useState(search)

  // Ricerca con debounce.
  useEffect(() => {
    const t = setTimeout(() => {
      if (query !== useConversations.getState().search) setSearch(query)
    }, 200)
    return () => clearTimeout(t)
  }, [query, setSearch])

  return (
    <aside
      aria-label="Barra laterale"
      className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {/* Logo e nome dell'app, pulsante di chiusura a destra; zona di trascinamento. Su macOS lascia spazio ai semafori. */}
      <div className={'drag flex items-center gap-2.5 pb-6 pt-4 ' + (isMac ? 'pl-[88px] pr-3' : 'pl-4 pr-3')}>
        <AppLogo size={30} />
        <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight" data-testid="app-name">
          FastChat
        </span>
        <IconButton tooltip="Chiudi la barra laterale" tooltipPlacement="bottom-end" aria-expanded={true} onClick={onCollapse}>
          <PanelLeftIcon size={18} />
        </IconButton>
      </div>

      <div className="px-3 pb-6">
        <NewConversationButton />
      </div>

      <section aria-labelledby="sidebar-conversations" className="flex min-h-0 flex-1 flex-col">
        <h2
          id="sidebar-conversations"
          className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
        >
          Conversazioni
        </h2>
        <div className="px-3 pb-3">
          <input
            type="search"
            aria-label="Cerca conversazioni"
            placeholder="Cerca…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-3" aria-label="Conversazioni">
          {conversations.map((c) => (
            <Item key={c.id} conv={c} active={c.id === activeId} />
          ))}
          {conversations.length === 0 && (
            <li className="px-2 py-4 text-center text-sm text-zinc-500">
              {search ? 'Nessun risultato' : showArchived ? 'Nessuna conversazione archiviata' : 'Nessuna conversazione'}
            </li>
          )}
        </ul>
      </section>

      <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        <label className="flex items-center gap-2 whitespace-nowrap">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Mostra archiviate
        </label>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Impostazioni"
          className="rounded px-2 py-1 text-base hover:bg-zinc-200 dark:hover:bg-zinc-800"
          title="Impostazioni"
        >
          ⚙
        </button>
      </div>
    </aside>
  )
}
