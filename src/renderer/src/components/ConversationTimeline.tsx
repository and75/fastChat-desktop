import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { excerpt, formatMessageDate, timelinePositions } from '@shared/format'
import type { Message } from '@shared/types'

export interface TimelineItem {
  /** Uguale all'attributo `data-message-id` del messaggio nella conversazione. */
  id: string
  role: Message['role']
  content: string
  createdAt?: number
  /** Risposta in arrivo (pallino che pulsa). */
  live?: boolean
}

interface Props {
  items: TimelineItem[]
  /** Area che scorre e contiene i messaggi. */
  scroller: React.RefObject<HTMLDivElement | null>
}

/** Distanza minima tra due pallini, in px. */
const MIN_GAP = 14

interface Layout {
  /** Posizione di ogni pallino dall'alto della linea, in px. */
  positions: number[]
  /** La conversazione è più lunga dello schermo: solo allora la cronologia serve. */
  scrollable: boolean
}

/** Tooltip centrato sul pallino; vicino agli estremi della linea si allinea per non uscire dalla colonna. */
function tipAlign(pos: number, height: number): string {
  if (pos < 48) return '-translate-y-3'
  if (pos > height - 48) return '-translate-y-[calc(100%-0.75rem)]'
  return '-translate-y-1/2'
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Cronologia della conversazione: linea verticale a tutta altezza con un pallino per messaggio,
 * all'altezza in cui il messaggio compare (con una distanza minima tra pallini vicini).
 * Pieni i messaggi dell'utente, vuoti quelli dell'assistente; evidenziato quello in lettura.
 * Passandoci sopra si vede un estratto, con un clic si salta al messaggio.
 */
export function ConversationTimeline({ items, scroller }: Props): React.JSX.Element | null {
  const rail = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>({
    positions: [],
    scrollable: false
  })
  const [active, setActive] = useState(-1)
  const [hover, setHover] = useState<number | null>(null)
  const frame = useRef(0)

  const anchors = useCallback((): (HTMLElement | null)[] => {
    const el = scroller.current
    return items.map((it) => el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(it.id)}"]`) ?? null)
  }, [items, scroller])

  /** Inizio di ogni messaggio in px dall'inizio del contenuto che scorre. */
  const offsets = useCallback((): number[] => {
    const el = scroller.current
    if (!el) return []
    const top = el.getBoundingClientRect().top - el.scrollTop
    return anchors().map((a) => (a ? a.getBoundingClientRect().top - top : 0))
  }, [anchors, scroller])

  /** Messaggio in lettura: l'ultimo che inizia sopra il primo quarto dello schermo (in fondo: l'ultimo). */
  const updateActive = useCallback(() => {
    const el = scroller.current
    if (!el || items.length === 0) return setActive(-1)
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) return setActive(items.length - 1)
    const line = el.scrollTop + el.clientHeight * 0.25
    const offs = offsets()
    let idx = 0
    for (let i = 0; i < offs.length; i++) if (offs[i] <= line) idx = i
    setActive(idx)
  }, [items.length, offsets, scroller])

  const measure = useCallback(() => {
    const el = scroller.current
    const height = rail.current?.clientHeight ?? 0
    if (!el) return
    const scrollable = el.scrollHeight > el.clientHeight + 1 && items.length >= 2
    const total = Math.max(el.scrollHeight, 1)
    const positions = timelinePositions(
      offsets().map((o) => o / total),
      height,
      MIN_GAP
    )
    // stesso layout → stesso oggetto: niente render (e niente ciclo con useLayoutEffect)
    setLayout((prev) =>
      prev.scrollable === scrollable &&
      prev.positions.length === positions.length &&
      prev.positions.every((p, i) => Math.abs(p - positions[i]) < 0.5)
        ? prev
        : { positions, scrollable }
    )
    updateActive()
  }, [items.length, offsets, scroller, updateActive])

  // Ricalcolo quando cambiano i messaggi o le altezze (streaming, ragionamento aperto, finestra).
  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const schedule = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(measure)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    if (rail.current) ro.observe(rail.current)
    const onScroll = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(updateActive)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame.current)
    }
  }, [measure, updateActive, scroller])

  const jump = (i: number): void => {
    anchors()[i]?.scrollIntoView({
      behavior: reducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    })
  }

  const visible = layout.scrollable && layout.positions.length === items.length
  const tip = hover != null && visible ? items[hover] : null

  return (
    <nav
      aria-label="Cronologia della conversazione"
      data-testid="timeline"
      // nascosta (ma misurabile) finché la conversazione non è più lunga dello schermo
      className={'absolute bottom-4 right-3 top-4 w-4 ' + (visible ? '' : 'invisible')}
    >
      <div ref={rail} className="relative h-full">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-zinc-300 dark:bg-zinc-700"
        />
        {visible &&
          items.map((it, i) => {
            const user = it.role === 'user'
            const label = `Messaggio ${i + 1} di ${items.length}, ${user ? 'tu' : 'assistente'}: ${excerpt(it.content, 80) || '…'}`
            return (
              <button
                key={it.id}
                type="button"
                aria-label={label}
                aria-current={i === active ? 'true' : undefined}
                data-testid="timeline-dot"
                data-role={it.role}
                className="group/dot absolute left-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus:outline-none"
                style={{ top: layout.positions[i] }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h) => (h === i ? null : h))}
                onClick={() => jump(i)}
              >
                <span
                  aria-hidden="true"
                  className={
                    'block h-2.5 w-2.5 rounded-full transition-transform group-hover/dot:scale-[1.35] group-focus-visible/dot:scale-[1.35] ' +
                    (user
                      ? 'bg-brand-600 dark:bg-brand-400 '
                      : 'border-2 border-brand-600 bg-white dark:border-brand-400 dark:bg-zinc-950 ') +
                    (i === active ? 'ring-4 ring-brand-500/30 ' : '') +
                    (it.live ? 'animate-pulse' : '')
                  }
                />
              </button>
            )
          })}
        {tip && hover != null && (
          <div
            role="tooltip"
            data-testid="timeline-tooltip"
            className={
              'pointer-events-none absolute right-6 z-50 w-64 rounded-lg bg-zinc-900 px-3 py-2 text-xs leading-snug text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900 ' +
              tipAlign(layout.positions[hover], rail.current?.clientHeight ?? 0)
            }
            style={{ top: layout.positions[hover] }}
          >
            <span className="mb-0.5 block text-[11px] opacity-70">
              {tip.role === 'user' ? 'Tu' : 'Assistente'}
              {tip.live ? ' · in corso' : tip.createdAt != null ? ` · ${formatMessageDate(tip.createdAt)}` : ''}
            </span>
            {excerpt(tip.content) || '…'}
          </div>
        )}
      </div>
    </nav>
  )
}
