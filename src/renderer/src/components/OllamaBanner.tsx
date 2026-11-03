import { useEffect, useState } from 'react'
import { useModels } from '../store/useModels'

/** Mostrato quando Ollama non risponde: permette di riprovare o cambiare URL. */
export function OllamaBanner(): React.JSX.Element | null {
  const { status, error, settings, refresh, setOllamaUrl } = useModels()
  const [url, setUrl] = useState(settings?.ollamaUrl ?? '')

  useEffect(() => {
    if (settings) setUrl(settings.ollamaUrl)
  }, [settings])

  if (status !== 'error') return null

  return (
    <div
      role="alert"
      data-testid="ollama-banner"
      className="flex flex-wrap items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
    >
      <span className="font-medium">Ollama non risponde.</span>
      <span className="text-amber-800 dark:text-amber-200">{error}</span>
      <form
        className="ml-auto flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (url && url !== settings?.ollamaUrl) void setOllamaUrl(url)
          else void refresh()
        }}
      >
        <input
          aria-label="URL di Ollama"
          className="w-64 rounded border border-amber-300 bg-white px-2 py-1 text-zinc-900 dark:border-amber-700 dark:bg-zinc-900 dark:text-zinc-100"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="rounded bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700">
          Riprova
        </button>
      </form>
    </div>
  )
}
