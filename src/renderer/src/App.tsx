import { useEffect, useState } from 'react'
import { BriefPanel } from './components/BriefPanel'
import { ChatView } from './components/ChatView'
import { ModelPicker } from './components/ModelPicker'
import { OllamaBanner } from './components/OllamaBanner'
import { Sidebar } from './components/Sidebar'
import { useChat } from './store/useChat'
import { useConversations } from './store/useConversations'
import { useModels } from './store/useModels'

export default function App(): React.JSX.Element {
  const initModels = useModels((s) => s.init)
  const theme = useModels((s) => s.settings?.theme ?? 'system')
  const conversation = useChat((s) => s.conversation)
  const [briefOpen, setBriefOpen] = useState(true)

  useEffect(() => {
    void initModels()
    void useConversations.getState().refresh()
    // Un solo listener per gli eventi di stream, per tutta la vita della finestra.
    return window.api.chat.onStream((event) => {
      useChat.getState().handleStream(event)
      // A fine risposta la conversazione è salita in cima: riallineiamo la lista.
      if (event.type === 'done' || event.type === 'error') void useConversations.getState().refresh()
    })
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
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <h1 className="truncate text-base font-semibold" title={conversation?.title}>
            {conversation?.title ?? 'FastChat'}
          </h1>
          <ModelPicker />
          {conversation && (
            <button
              type="button"
              aria-pressed={briefOpen}
              onClick={() => setBriefOpen((v) => !v)}
              className="ml-auto rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
    </div>
  )
}
