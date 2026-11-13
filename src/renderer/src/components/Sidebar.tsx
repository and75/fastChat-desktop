import { useEffect, useRef, useState } from 'react'
import { displayTitle, localeTag, t, tn } from '@shared/i18n'
import type { Conversation } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { findRole, languageTag, roleDescription, roleName, useRoles } from '../store/useRoles'
import { useTemplates } from '../store/useTemplates'
import { IconButton } from './IconButton'
import { AppLogo, ChevronDownIcon, PanelLeftIcon, PlusIcon, SettingsIcon, StoreIcon } from './icons'
import { isMac } from './WindowControls'

/**
 * «Parla con un…»: i ruoli installati, poi i template. Un clic crea una conversazione con quel ruolo, o con il
 * ruolo, le scelte e la situazione salvati nel template.
 */
function RoleMenu({ onDone, onOpenStore }: { onDone(): void; onOpenStore(): void }): React.JSX.Element {
  const { templates, refresh, remove } = useTemplates()
  const roles = useRoles((s) => s.roles)
  const refreshRoles = useRoles((s) => s.refresh)
  const create = useConversations((s) => s.create)
  useEffect(() => {
    void refresh()
    void refreshRoles()
  }, [refresh, refreshRoles])

  const heading = 'px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400'
  const row = 'rounded hover:bg-brand-50 focus-within:bg-brand-50 dark:hover:bg-brand-950/60 dark:focus-within:bg-brand-950/60'

  return (
    <div
      role="menu"
      data-testid="role-menu"
      className="flex max-h-[70vh] w-72 flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <p className={heading}>{t('role.talkTo')}</p>
      {roles.map((role) => {
        const tag = languageTag(roles, role)
        return (
          <button
            key={role.id}
            type="button"
            role="menuitem"
            data-testid="role-option"
            data-role={role.id}
            className={row + ' flex flex-col px-2 py-1.5 text-left focus:outline-none'}
            onClick={() => {
              onDone()
              void create({ roleId: role.id })
            }}
          >
            <span className="flex items-center justify-between gap-2 font-medium">
              <span className="truncate">{roleName(role)}</span>
              {tag && <span className="shrink-0 rounded border border-zinc-300 px-1 text-[10.5px] font-medium text-zinc-500 dark:border-zinc-600">{tag}</span>}
            </span>
            {roleDescription(role) && <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{roleDescription(role)}</span>}
          </button>
        )
      })}

      <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
      <p className={heading}>{t('role.templates')}</p>
      {templates.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-500">{t('sidebar.noTemplates')}</p>}
      {templates.map((tpl) => {
        const role = findRole(roles, tpl)
        const choices = Object.keys(tpl.roleParams ?? {}).length
        return (
          <div key={tpl.id} className={row + ' group flex items-center'} data-testid="template-option">
            <button
              type="button"
              role="menuitem"
              className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left focus:outline-none"
              onClick={() => {
                onDone()
                void create({ templateId: tpl.id })
              }}
            >
              <span className="truncate font-medium">{tpl.name}</span>
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {[roleName(role), choices > 0 ? tn('role.choices', choices) : null, tpl.situation?.trim() ? t('role.template.situation') : null].filter(Boolean).join(' · ')}
              </span>
            </button>
            <button
              type="button"
              aria-label={t('sidebar.deleteTemplate', { name: tpl.name })}
              className="hidden px-2 text-zinc-400 hover:text-red-600 group-hover:block"
              onClick={() => {
                if (window.confirm(t('sidebar.deleteTemplate.confirm', { name: tpl.name }))) void remove(tpl.id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}

      <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
      <button
        type="button"
        role="menuitem"
        data-testid="role-menu-store"
        className={row + ' px-2 py-1.5 text-left font-medium text-brand-700 focus:outline-none dark:text-brand-300'}
        onClick={() => {
          onDone()
          onOpenStore()
        }}
      >
        {t('role.moreInStore')}
      </button>
    </div>
  )
}

function formatWhen(ts: number): string {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString()
    ? new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit' }).format(d)
    : new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short' }).format(d)
}

function Item({ conv, active }: { conv: Conversation; active: boolean }): React.JSX.Element {
  const { select, update, remove } = useConversations()
  const streaming = useChat((s) => !!s.streams[conv.id])
  const role = useRoles((s) => findRole(s.roles, conv))
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
          aria-label={t('sidebar.conversationTitle')}
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
          title={displayTitle(conv.title)}
        >
          {streaming && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-500" />}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{displayTitle(conv.title)}</span>
            {/* Con chi si parla: solo quando non è il Generalista, per non appesantire l'elenco. */}
            {role && (
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400" data-testid="conversation-role">
                {roleName(role)}
              </span>
            )}
          </span>
        </button>
      )}
      {!editing && (
        <>
          <span className="shrink-0 text-xs text-zinc-400 group-hover:hidden">{formatWhen(conv.updatedAt)}</span>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
            <button type="button" className={btn} title={t('sidebar.rename')} onClick={() => setEditing(true)}>
              ✎
            </button>
            <button
              type="button"
              className={btn}
              title={conv.archived ? t('sidebar.restore') : t('sidebar.archive')}
              onClick={() => void update(conv.id, { archived: !conv.archived })}
            >
              {conv.archived ? '↩' : '⤓'}
            </button>
            <button
              type="button"
              className={btn}
              title={t('sidebar.delete')}
              onClick={() => {
                if (window.confirm(t('sidebar.delete.confirm', { title: conv.title }))) void remove(conv.id)
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

/** «Nuova conversazione» in stile outline (Generalista), con la freccia di «Parla con un…» attaccata. */
function NewConversationButton({ onOpenStore }: { onOpenStore(): void }): React.JSX.Element {
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
          {t('sidebar.new')}
        </button>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('role.talkTo')}
          title={t('role.talkTo.title')}
          data-testid="role-menu-open"
          onClick={() => setOpen((o) => !o)}
          className={part + ' border-l border-brand-600 px-2.5 dark:border-brand-500 ' + (open ? 'bg-brand-50 dark:bg-brand-950/60' : '')}
        >
          <ChevronDownIcon size={16} className={'transition-transform ' + (open ? 'rotate-180' : '')} />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5">
          <RoleMenu onDone={() => setOpen(false)} onOpenStore={onOpenStore} />
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
function CollapsedRail({ onExpand, onOpenSettings, onOpenStore }: { onExpand(): void; onOpenSettings(): void; onOpenStore(): void }): React.JSX.Element {
  const create = useConversations((s) => s.create)
  return (
    <aside
      aria-label={t('sidebar.label')}
      data-collapsed="true"
      className={
        'flex shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 pb-3 dark:border-zinc-800 dark:bg-zinc-950 ' +
        (isMac ? 'w-20' : 'w-16')
      }
    >
      {/* Blocco del logo (zona di trascinamento); su macOS sotto i semafori. */}
      {/* Prima riga alta come la topbar (h-12): logo allineato al titolo. Su macOS ospita i semafori e il logo scende. */}
      <div className="drag flex w-full flex-col items-center gap-3 pb-4">
        {isMac && <div className="h-12 w-full shrink-0" />}
        <div className={'flex h-12 w-full shrink-0 items-center justify-center ' + (isMac ? '-mt-3' : '')}>
          <AppLogo size={30} />
        </div>
        <IconButton tooltip={t('sidebar.open')} tooltipPlacement="right" aria-expanded={false} onClick={onExpand}>
          <PanelLeftIcon size={18} />
        </IconButton>
      </div>
      <IconButton tooltip={t('sidebar.new')} tooltipPlacement="right" data-testid="new-conversation-rail" onClick={() => void create()}>
        <PlusIcon size={18} />
      </IconButton>
      <div className="flex-1" />
      <IconButton tooltip={t('store.title')} tooltipPlacement="right" data-testid="store-open-rail" onClick={onOpenStore}>
        <StoreIcon size={18} />
      </IconButton>
      <IconButton tooltip={t('settings.title')} tooltipPlacement="right" onClick={onOpenSettings}>
        <SettingsIcon size={18} />
      </IconButton>
    </aside>
  )
}

export function Sidebar({ onOpenSettings, onOpenStore }: { onOpenSettings(): void; onOpenStore(): void }): React.JSX.Element {
  const [collapsed, setCollapsed] = useCollapsed()
  if (collapsed) return <CollapsedRail onExpand={() => setCollapsed(false)} onOpenSettings={onOpenSettings} onOpenStore={onOpenStore} />
  return <ExpandedSidebar onCollapse={() => setCollapsed(true)} onOpenSettings={onOpenSettings} onOpenStore={onOpenStore} />
}

function ExpandedSidebar({ onOpenSettings, onOpenStore, onCollapse }: { onOpenSettings(): void; onOpenStore(): void; onCollapse(): void }): React.JSX.Element {
  const { conversations, activeId, search, showArchived, setSearch, setShowArchived } = useConversations()
  const [query, setQuery] = useState(search)

  // Ricerca con debounce.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query !== useConversations.getState().search) setSearch(query)
    }, 200)
    return () => clearTimeout(timer)
  }, [query, setSearch])

  return (
    <aside
      aria-label={t('sidebar.label')}
      className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {/* Logo e nome dell'app, pulsante di chiusura a destra; zona di trascinamento. Su macOS lascia spazio ai semafori. */}
      {/* Alta come la topbar (h-12) e centrata in verticale: logo e titolo della conversazione sulla stessa linea. */}
      <div className={'drag flex h-12 shrink-0 items-center gap-2.5 ' + (isMac ? 'pl-[88px] pr-3' : 'pl-4 pr-3')}>
        <AppLogo size={30} />
        <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight" data-testid="app-name">
          FastChat
        </span>
        <IconButton tooltip={t('sidebar.close')} tooltipPlacement="bottom-end" aria-expanded={true} onClick={onCollapse}>
          <PanelLeftIcon size={18} />
        </IconButton>
      </div>

      <div className="px-3 pb-6 pt-4">
        <NewConversationButton onOpenStore={onOpenStore} />
      </div>

      <section aria-labelledby="sidebar-conversations" className="flex min-h-0 flex-1 flex-col">
        <h2
          id="sidebar-conversations"
          className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
        >
          {t('sidebar.conversations')}
        </h2>
        <div className="px-3 pb-3">
          <input
            type="search"
            aria-label={t('sidebar.search')}
            placeholder={t('sidebar.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <ul className="relative flex-1 space-y-1 overflow-y-auto px-2 pb-3" aria-label={t('sidebar.conversations')}>
          {conversations.map((c) => (
            <Item key={c.id} conv={c} active={c.id === activeId} />
          ))}
          {conversations.length === 0 && (
            <li className="px-2 py-4 text-center text-sm text-zinc-500">
              {search ? t('sidebar.noResults') : showArchived ? t('sidebar.noArchived') : t('sidebar.noConversations')}
            </li>
          )}
        </ul>
      </section>

      {/* Store: sopra la riga in fondo (archiviate, impostazioni). */}
      <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={onOpenStore}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
          data-testid="store-open"
        >
          <StoreIcon size={16} />
          {t('store.title')}
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
        <label className="flex items-center gap-2 whitespace-nowrap">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t('sidebar.showArchived')}
        </label>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('settings.title')}
          className="rounded px-2 py-1 text-base hover:bg-zinc-200 dark:hover:bg-zinc-800"
          title={t('settings.title')}
        >
          ⚙
        </button>
      </div>
    </aside>
  )
}
