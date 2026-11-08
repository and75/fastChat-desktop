import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { Elapsed, TypingDots } from './Loader'

interface Props {
  text: string
  /** true mentre il modello sta ancora ragionando (blocco aperto, testo che scorre). */
  live?: boolean
  /** Inizio della richiesta, per il tempo trascorso mentre ragiona. */
  startedAt?: number
}

const words = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length

/** Ragionamento del modello, separato dalla risposta. Aperto durante lo streaming, poi richiudibile. */
export function ThinkingBlock({ text, live = false, startedAt }: Props): React.JSX.Element | null {
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
            <TypingDots />
            {t('thinking.live')}
            {startedAt != null && (
              <>
                <span aria-hidden>·</span>
                <Elapsed since={startedAt} />
              </>
            )}
          </span>
        ) : (
          <span>{t('thinking.done', { words: words(text) })}</span>
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
