import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { displayTitle, getLocale, resolveLocale, setLocale, subscribeLocale, t } from '@shared/i18n'
import { BriefPanel } from './components/BriefPanel'
import { ChatView } from './components/ChatView'
import { IconButton } from './components/IconButton'
import { DownloadIcon, PanelRightIcon } from './components/icons'
import { ModelPicker } from './components/ModelPicker'
import { OllamaBanner } from './components/OllamaBanner'
import { SettingsDialog } from './components/SettingsDialog'
import { WindowControls } from './components/WindowControls'
import { Sidebar } from './components/Sidebar'
import { useChat } from './store/useChat'
import { useConversations } from './store/useConversations'
import { useKnowledge } from './store/useKnowledge'
import { useModels } from './store/useModels'

/** Esporta la conversazione aperta: icona download con menu a tendina Markdown / JSON. */
function ExportMenu({ conversationId }: { conversationId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  const run = async (format: 'md' | 'json'): Promise<void> => {
    setOpen(false)
    const res = await window.api.conversations.export(conversationId, format)
    if (!res.ok) setStatus(t('export.error', { error: res.error }))
    else if (res.data) setStatus(t('export.savedTo', { path: res.data }))
    else setStatus(null)
  }

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 6000)
    return () => clearTimeout(timer)
  }, [status])

  // Chiusura con clic fuori o Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item =
    'flex w-full items-center justify-between gap-6 rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none dark:hover:bg-zinc-800 dark:focus:bg-zinc-800'

  return (
    <div ref={root} className="relative flex items-center gap-2">
      {status && (
        <span className="max-w-64 truncate text-xs text-zinc-500" title={status} data-testid="export-status">
          {status}
        </span>
      )}
      <IconButton
        ref={button}
        tooltip={t('export.title')}
        hideTooltip={open}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <DownloadIcon size={18} />
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label={t('export.title')}
          className="absolute right-0 top-full z-50 mt-1.5 min-w-48 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button type="button" role="menuitem" autoFocus className={item} onClick={() => void run('md')}>
            Markdown <span className="text-xs text-zinc-400">.md</span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => void run('json')}>
            JSON <span className="text-xs text-zinc-400">.json</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const initModels = useModels((s) => s.init)
  const theme = useModels((s) => s.settings?.theme ?? 'system')
  const language = useModels((s) => s.settings?.language ?? 'auto')
  // Al cambio di lingua l'intera interfaccia si rimonta (key sulla radice): niente testi vecchi in giro.
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  const conversation = useChat((s) => s.conversation)
  const [briefOpen, setBriefOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void initModels()
    void useConversations.getState().refresh()
    // Un solo listener per tipo di evento, per tutta la vita della finestra.
    const offStream = window.api.chat.onStream((event) => {
      useChat.getState().handleStream(event)
      // A fine risposta la conversazione è salita in cima: riallineiamo la lista.
      if (event.type === 'done' || event.type === 'error') void useConversations.getState().refresh()
    })
    // Conversazioni modificate dal main, es. titolo generato dopo il primo scambio.
    const offUpdated = window.api.conversations.onUpdated((conv) => {
      useConversations.getState().upsertLocal(conv)
      useChat.getState().replaceConversation(conv)
    })
    // Base di conoscenza: plugin disponibili e avanzamento dell'indicizzazione dei documenti.
    void useKnowledge.getState().init()
    const offKnowledge = window.api.knowledge.onProgress((p) => useKnowledge.getState().handleProgress(p))
    return () => {
      offStream()
      offUpdated()
      offKnowledge()
    }
  }, [initModels])

  useEffect(() => {
    setLocale(resolveLocale(language, window.api.system.locale))
  }, [language])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return (
    <div className="flex h-full" key={locale}>
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      {/* overflow-hidden: con la finestra stretta la colonna si restringe (gli elementi della topbar vengono
          tagliati) invece di allargare il documento oltre la finestra. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* La topbar fa da barra del titolo: si trascina per spostare la finestra. */}
        {/* Altezza fissa (TOPBAR_HEIGHT, h-12): la stessa del blocco del logo, così i contenuti sono allineati. */}
        <header className="drag flex h-12 shrink-0 items-center gap-4 border-b border-zinc-200 pl-4 pr-2 dark:border-zinc-800">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={conversation ? displayTitle(conversation.title) : undefined}>
            {conversation ? displayTitle(conversation.title) : t('app.name')}
          </h1>
          <ModelPicker />
          {conversation && (
            <div className="flex shrink-0 items-center gap-1">
              <ExportMenu conversationId={conversation.id} />
              <IconButton
                tooltip={briefOpen ? t('topbar.hidePanel') : t('topbar.showPanel')}
                aria-pressed={briefOpen}
                aria-controls="conversation-panel"
                active={briefOpen}
                onClick={() => setBriefOpen((v) => !v)}
              >
                <PanelRightIcon size={18} />
              </IconButton>
            </div>
          )}
          <WindowControls />
        </header>
        <OllamaBanner />
        <div className="flex min-h-0 flex-1">
          <ChatView />
          {conversation && briefOpen && <BriefPanel key={conversation.id} conversation={conversation} />}
        </div>
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
