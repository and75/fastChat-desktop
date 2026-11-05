import { forwardRef, useId } from 'react'

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Testo del tooltip; è anche il nome accessibile del pulsante. */
  tooltip: string
  /** Nasconde il tooltip (es. mentre il menu del pulsante è aperto). */
  hideTooltip?: boolean
  active?: boolean
  /** Dove si apre il tooltip: sotto allineato a destra (topbar) o a destra (striscia della barra laterale). */
  tooltipPlacement?: 'bottom-end' | 'bottom-start' | 'right'
}

/**
 * Pulsante con sola icona e tooltip (al passaggio del mouse o con il focus da tastiera).
 * Il tooltip si apre sotto, allineato a destra: questi pulsanti stanno sul bordo destro della topbar.
 */
const PLACEMENT = {
  'bottom-end': 'right-0 top-full mt-1.5',
  'bottom-start': 'left-0 top-full mt-1.5',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2'
} as const

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { tooltip, hideTooltip = false, active = false, tooltipPlacement = 'bottom-end', className = '', children, ...rest },
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
          'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-brand-500 ' +
          (active
            ? 'bg-brand-50 text-brand-600 hover:bg-brand-100 dark:bg-brand-950/60 dark:text-brand-300 dark:hover:bg-brand-900/60 '
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
          'pointer-events-none absolute z-50 whitespace-nowrap ' +
          PLACEMENT[tooltipPlacement] +
          '  rounded-md bg-zinc-900 px-2 py-1 text-xs text-white opacity-0 shadow-md transition-opacity delay-300 dark:bg-zinc-100 dark:text-zinc-900 ' +
          (hideTooltip ? '' : 'group-hover/tt:opacity-100 group-has-[:focus-visible]/tt:opacity-100')
        }
      >
        {tooltip}
      </span>
    </span>
  )
})
