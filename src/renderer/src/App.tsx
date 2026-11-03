import { useEffect } from 'react'
import { ModelPicker } from './components/ModelPicker'
import { OllamaBanner } from './components/OllamaBanner'
import { useModels } from './store/useModels'

export default function App(): React.JSX.Element {
  const init = useModels((s) => s.init)
  const theme = useModels((s) => s.settings?.theme ?? 'system')

  useEffect(() => {
    void init()
  }, [init])

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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h1 className="text-base font-semibold">FastChat</h1>
        <ModelPicker />
      </header>
      <OllamaBanner />
      <main className="flex flex-1 items-center justify-center text-sm text-zinc-500">
        La chat arriva nella fase 2.
      </main>
    </div>
  )
}
