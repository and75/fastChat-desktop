import { useEffect, useState } from 'react'
import { BriefPanel } from './components/BriefPanel'
import { ChatView } from './components/ChatView'
import { ModelPicker } from './components/ModelPicker'
import { OllamaBanner } from './components/OllamaBanner'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { useChat } from './store/useChat'
import { useConversations } from './store/useConversations'
import { useModels } from './store/useModels'

/** Esporta la conversazione aperta in Markdown o JSON (il main chiede dove salvare). */
function ExportMenu({ conversationId }: { conversationId: string }): React.JSX.Element {
  const [status, setStatus] = useState<string | null>(null)
  const run = async (format: 'md' | 'json'): Promise<void> => {
    const res = await window.api.conversations.export(conversationId, format)
    if (!res.ok) setStatus(`Errore: ${res.error}`)
    else if (res.data) setStatus(`Salvata in ${res.data}`)
    else setStatus(null)
  }
  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(null), 6000)
    return () => clearTimeout(t)
  }, [status])

  const btn = 'rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
  return (
    <div className="flex items-center gap-1">
      {status && (
        <span className="max-w-64 truncate text-xs text-zinc-500" title={status} data-testid="export-status">
          {status}
        </span>
      )}
      <span className="whitespace-nowrap text-sm text-zinc-400">Esporta</span>
      <button type="button" className={btn} onClick={() => void run('md')} title="Esporta in Markdown">
        .md
      </button>
      <button type="button" className={btn} onClick={() => void run('json')} title="Esporta in JSON">
        .json
      </button>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const initModels = useModels((s) => s.init)
  const theme = useModels((s) => s.settings?.theme ?? 'system')
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
    return () => {
      offStream()
      offUpdated()
    }
  }, [initModels])

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
    <div className="flex h-full">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold" title={conversation?.title}>
            {conversation?.title ?? 'FastChat'}
          </h1>
          <ModelPicker />
          {conversation && (
            <div className="shrink-0">
              <ExportMenu conversationId={conversation.id} />
            </div>
          )}
          {conversation && (
            <button
              type="button"
              aria-pressed={briefOpen}
              onClick={() => setBriefOpen((v) => !v)}
              className="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {briefOpen ? 'Nascondi pannello' : 'Impostazioni e brief'}
            </button>
          )}
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
