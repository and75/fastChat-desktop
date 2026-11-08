import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { formatElapsed } from '@shared/format'

/** Secondi trascorsi da `since`, aggiornati 10 volte al secondo. */
export function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [since])
  return since == null ? 0 : Math.max(0, now - since)
}

/** Tre punti che pulsano in sequenza (fermi se il sistema chiede di ridurre il movimento). */
export function TypingDots({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <span aria-hidden className={'inline-flex items-center gap-1 ' + className}>
      <span className="loader-dot" />
      <span className="loader-dot [animation-delay:160ms]" />
      <span className="loader-dot [animation-delay:320ms]" />
    </span>
  )
}

/** Tempo trascorso, da affiancare a un'etichetta di attesa. */
export function Elapsed({ since }: { since: number | undefined }): React.JSX.Element | null {
  const ms = useElapsed(since)
  if (since == null) return null
  return (
    <span className="tabular-nums text-zinc-400 dark:text-zinc-500" data-testid="elapsed">
      {formatElapsed(ms)}
    </span>
  )
}

/** In attesa del primo token: caricamento del modello ed elaborazione del prompt. */
export function WaitingIndicator({ since, label }: { since: number | undefined; label?: string }): React.JSX.Element {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400" data-testid="waiting-indicator">
      <TypingDots />
      <span>{label ?? t('waiting.default')}</span>
      <span aria-hidden>·</span>
      <Elapsed since={since} />
    </span>
  )
}
