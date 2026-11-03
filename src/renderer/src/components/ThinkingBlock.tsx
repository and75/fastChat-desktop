import { useEffect, useRef, useState } from 'react'

interface Props {
  text: string
  /** true mentre il modello sta ancora ragionando (blocco aperto, testo che scorre). */
  live?: boolean
}

const words = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length

/** Ragionamento del modello, separato dalla risposta. Aperto durante lo streaming, poi richiudibile. */
export function ThinkingBlock({ text, live = false }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(live)
  const body = useRef<HTMLDivElement>(null)

  // Quando il ragionamento finisce (inizia la risposta) il blocco si richiude da solo.
  useEffect(() => {
    setOpen(live)
  }, [live])

  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [text, live])

  if (!text) return null

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/60 text-sm dark:border-brand-900/60 dark:bg-brand-950/30" data-testid="thinking-block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-brand-800 dark:text-brand-200"
      >
        <span className={'transition-transform ' + (open ? 'rotate-90' : '')}>▸</span>
        {live ? (
          <span className="flex items-center gap-2">
            Sta ragionando… <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
          </span>
        ) : (
          <span>Ragionamento · {words(text)} parole</span>
        )}
      </button>
      {open && (
        <div
          ref={body}
          data-testid="thinking-text"
          className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-brand-200 px-3 py-2 text-zinc-600 dark:border-brand-900/60 dark:text-zinc-400"
        >
          {text}
        </div>
      )}
    </div>
  )
}
