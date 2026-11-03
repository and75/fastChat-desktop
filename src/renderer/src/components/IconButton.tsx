import { forwardRef, useId } from 'react'

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Testo del tooltip; è anche il nome accessibile del pulsante. */
  tooltip: string
  /** Nasconde il tooltip (es. mentre il menu del pulsante è aperto). */
  hideTooltip?: boolean
  active?: boolean
}

/**
 * Pulsante con sola icona e tooltip (al passaggio del mouse o con il focus da tastiera).
 * Il tooltip si apre sotto, allineato a destra: questi pulsanti stanno sul bordo destro della topbar.
 */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { tooltip, hideTooltip = false, active = false, className = '', children, ...rest },
  ref
) {
  const tipId = useId()
  return (
    <span className="group/tt relative inline-flex">
      <button
        ref={ref}
        type="button"
        aria-label={tooltip}
        aria-describedby={tipId}
        className={
          'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ' +
          (active
            ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60 '
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ') +
          className
        }
        {...rest}
      >
        {children}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={
          'pointer-events-none absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs text-white opacity-0 shadow-md transition-opacity delay-300 dark:bg-zinc-100 dark:text-zinc-900 ' +
          (hideTooltip ? '' : 'group-hover/tt:opacity-100 group-has-[:focus-visible]/tt:opacity-100')
        }
      >
        {tooltip}
      </span>
    </span>
  )
})
