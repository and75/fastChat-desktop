import { useRef, useState } from 'react'
import { fmtInt, t, type Key } from '@shared/i18n'
import { CONTEXT_ORDERS, orderLayout, reminderApplies, resolveContext, type ContextBlock } from '@shared/compose'
import { KNOWLEDGE } from '@shared/knowledge'
import { DEFAULT_CHARS_PER_TOKEN } from '@shared/prompt'
import { RESERVE_SHARE, resolveSettings } from '@shared/settings'
import { DEFAULT_CONTEXT_SETTINGS, type ContextOrder, type ContextSettings } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { useModels } from '../store/useModels'

/** Colore di ogni blocco: gli stessi del monitor del contesto. */
const BLOCK: Record<ContextBlock, string> = {
  instructions: 'bg-brand-700 text-white',
  situation: 'bg-brand-400 text-white',
  summary: 'bg-fuchsia-400 text-white',
  memory: 'bg-sky-500 text-white',
  behavior: 'bg-teal-500 text-white',
  examples: 'bg-lime-500 text-white',
  knowledge: 'bg-emerald-500 text-white',
  reminder: 'bg-rose-400 text-white',
  history: 'bg-brand-200 text-brand-900',
  question: 'bg-amber-500 text-white'
}

const pct = (share: number): number => Math.round(share * 100)
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
/** Quota disegnata per le istruzioni: è solo una proporzione indicativa, non si regola da qui. */
const INSTRUCTIONS_SHARE = 6
/** Memoria usata per l'esempio quando non c'è una conversazione aperta con un modello. */
const FALLBACK_CTX = 8192

function Segmented<T extends string>({ value, options, onChange, disabled, testid }: { value: T; options: Array<{ value: T; label: string }>; onChange(v: T): void; disabled?: boolean; testid: string }): React.JSX.Element {
  return (
    <div role="radiogroup" className={'inline-flex w-fit overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700 ' + (disabled ? 'opacity-50' : '')} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={'px-3 py-1.5 text-sm ' + (value === o.value ? 'bg-brand-600 font-medium text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}
          data-testid={`${testid}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Una scheda con il disegno di dove finiscono i blocchi con quell'ordine. */
function OrderCard({ order, reminder, active, locked, onPick }: { order: ContextOrder; reminder: boolean; active: boolean; locked: boolean; onPick(): void }): React.JSX.Element {
  const layout = orderLayout(order, reminder)
  // Compatto: ogni posto su una riga, con i blocchi come etichette affiancate.
  const slot = (name: 'system' | 'conversation' | 'user', blocks: ContextBlock[]): React.JSX.Element => (
    <div className="flex items-start gap-1.5 border-t border-dashed border-zinc-200 py-1 first:border-t-0 dark:border-zinc-800" data-slot={name}>
      <span className="w-[5.7rem] shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{t(`settings.context.slot.${name}` as Key)}</span>
      <span className="flex min-w-0 flex-wrap gap-0.5">
        {blocks.map((b) => (
          <span key={b} className={'rounded px-1.5 py-px text-[10.5px] leading-4 ' + BLOCK[b]} data-block={b}>
            {t(`settings.context.block.${b}` as Key)}
          </span>
        ))}
      </span>
    </div>
  )
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={locked}
      onClick={onPick}
      className={
        'flex flex-col rounded-xl border-2 px-2.5 py-2 text-left ' +
        (active ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100 dark:bg-brand-950/30 dark:ring-brand-900' : 'border-zinc-200 dark:border-zinc-800 ' + (locked ? 'opacity-60' : 'hover:border-brand-300'))
      }
      data-testid={`context-order-${order}`}
    >
      <span className="text-[13px] font-semibold leading-tight">{t(`settings.context.card.${order}` as Key)}</span>
      <span className="mb-1 text-[11px] text-zinc-500">{t(`settings.context.card.${order}.sub` as Key)}</span>
      {slot('system', layout.system)}
      {slot('conversation', layout.conversation)}
      {slot('user', layout.user)}
      <span className={'mt-auto pt-1 text-[11px] ' + (layout.reuse === 'none' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')}>
        {layout.reuse === 'none' ? '↻ ' : '✓ '}
        {t(`settings.context.reuse.${layout.reuse}` as Key)}
      </span>
    </button>
  )
}

/**
 * Impostazioni → Contesto: l'ordine dei blocchi inviati al modello (schede con il disegno), il promemoria del
 * ruolo, e la divisione della memoria (barra con i bordi da trascinare).
 */
export function ContextSettingsPanel(): React.JSX.Element {
  const settings = useModels((s) => s.settings)
  const saveSettings = useModels((s) => s.saveSettings)
  const capabilities = useModels((s) => s.capabilities)
  const conv = useConversations((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)
  const initial = settings?.context ?? DEFAULT_CONTEXT_SETTINGS
  const [draft, setDraft] = useState<ContextSettings>(initial)
  // Quote in punti percentuali interi: la barra le tiene sempre a somma 100.
  const [behavior, setBehavior] = useState(() => pct(initial.shares.behavior))
  const [examples, setExamples] = useState(() => pct(initial.shares.examples))
  const [situation, setSituation] = useState(() => pct(initial.situationShare))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const documents = 100 - behavior - examples

  const effective = resolveContext(draft)
  const auto = draft.order === 'auto'
  const touch = (): void => setSaved(false)
  const change = (patch: Partial<ContextSettings>): void => {
    setDraft({ ...draft, ...patch })
    touch()
  }

  // Esempio in token: la memoria della conversazione aperta, se ha un modello.
  const numCtx = conv?.model ? resolveSettings(conv, capabilities[conv.model] ?? null).numCtx : FALLBACK_CTX
  const knowledgeShare = pct(conv?.knowledgeShare ?? KNOWLEDGE.budgetShare)
  const reserve = pct(RESERVE_SHARE)
  const history = Math.max(0, 100 - INSTRUCTIONS_SHARE - situation - knowledgeShare - reserve)
  const tokensOf = (ofKnowledge: number): number => Math.round((numCtx * knowledgeShare * ofKnowledge) / 10000)
  const situationTokens = Math.round((numCtx * situation) / 100)

  /** Larghezze della barra, in percentuale della memoria. */
  const widths = { behavior: (knowledgeShare * behavior) / 100, examples: (knowledgeShare * examples) / 100, documents: (knowledgeShare * documents) / 100 }

  const setHandle = (handle: 'situation' | 'behavior' | 'examples', value: number): void => {
    if (handle === 'situation') setSituation(clamp(Math.round(value), 1, 25))
    // Il confine tra comportamento ed esempi sposta questi due; quello tra esempi e documenti, gli ultimi due.
    else if (handle === 'behavior') {
      const next = clamp(Math.round(value / 5) * 5, 0, behavior + examples)
      setExamples(behavior + examples - next)
      setBehavior(next)
    } else setExamples(clamp(Math.round(value / 5) * 5, 0, 100 - behavior))
    touch()
  }

  /** Trascinamento di un bordo: la posizione del puntatore sulla barra diventa una quota. */
  const drag = (handle: 'situation' | 'behavior' | 'examples') => (e: React.PointerEvent<HTMLSpanElement>): void => {
    const el = bar.current
    if (!el) return
    e.preventDefault()
    const move = (ev: PointerEvent): void => {
      const rect = el.getBoundingClientRect()
      const at = clamp(((ev.clientX - rect.left) / rect.width) * 100, 0, 100)
      if (handle === 'situation') setHandle('situation', at - INSTRUCTIONS_SHARE)
      else {
        // Posizione dentro lo spazio della conoscenza, in punti su 100.
        const inside = ((at - INSTRUCTIONS_SHARE - situation) / knowledgeShare) * 100
        setHandle(handle, handle === 'behavior' ? inside : inside - behavior)
      }
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  const handle = (name: 'situation' | 'behavior' | 'examples', value: number, min: number, max: number, step: number): React.JSX.Element => (
    <span
      role="slider"
      tabIndex={0}
      aria-label={t(`settings.context.handle.${name}` as Key)}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={drag(name)}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0
        if (!d) return
        e.preventDefault()
        setHandle(name, value + d)
      }}
      className="absolute -right-1.5 bottom-1.5 top-1.5 z-10 w-3 cursor-ew-resize touch-none rounded-full border-2 border-zinc-600 bg-white focus-visible:outline-2 focus-visible:outline-brand-500"
      data-testid={`context-handle-${name}`}
    />
  )

  const segment = (className: string, width: number, label: string, child?: React.JSX.Element): React.JSX.Element => (
    <div className={'relative flex min-w-0 items-center justify-center whitespace-nowrap text-[11px] ' + className} style={{ width: `${width}%` }}>
      <span className="overflow-hidden text-ellipsis px-1">{width >= 5 ? label : ''}</span>
      {child}
    </div>
  )

  const save = async (): Promise<void> => {
    setError(null)
    const context: ContextSettings = { ...draft, shares: { behavior: behavior / 100, examples: examples / 100, documents: documents / 100 }, situationShare: situation / 100 }
    const err = await saveSettings({ context })
    if (err) setError(err)
    else setSaved(true)
  }
  const reset = (): void => {
    const d = DEFAULT_CONTEXT_SETTINGS
    setDraft(d)
    setBehavior(pct(d.shares.behavior))
    setExamples(pct(d.shares.examples))
    setSituation(pct(d.situationShare))
    touch()
  }

  const legend: Array<{ key: string; dot: string; title: string; lines: string[] }> = [
    { key: 'situation', dot: 'bg-brand-400', title: `${t('settings.context.block.situation')} · ${situation}%`, lines: [t('settings.context.legend.tokens', { tokens: fmtInt(situationTokens) }), t('settings.context.legend.chars', { chars: fmtInt(situationTokens * DEFAULT_CHARS_PER_TOKEN) })] },
    { key: 'behavior', dot: 'bg-teal-500', title: `${t('settings.context.block.behavior')} · ${behavior}%`, lines: [t('settings.context.legend.tokens', { tokens: fmtInt(tokensOf(behavior)) }), t('settings.context.legend.always')] },
    { key: 'examples', dot: 'bg-lime-500', title: `${t('settings.context.block.examples')} · ${examples}%`, lines: [t('settings.context.legend.tokens', { tokens: fmtInt(tokensOf(examples)) }), t('settings.context.legend.always')] },
    { key: 'documents', dot: 'bg-emerald-500', title: `${t('settings.context.block.knowledge')} · ${documents}%`, lines: [t('settings.context.legend.tokens', { tokens: fmtInt(tokensOf(documents)) }), t('settings.context.legend.book')] }
  ]

  return (
    <form
      className="flex flex-col gap-3 text-sm"
      data-testid="context-settings"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1" title={t('settings.context.mode.hint')}>
          <span className="font-medium">{t('settings.context.order')}</span>
          <Segmented
            testid="context-mode"
            value={auto ? 'auto' : 'manual'}
            options={[
              { value: 'auto', label: t('settings.context.mode.auto') },
              { value: 'manual', label: t('settings.context.mode.manual') }
            ]}
            onChange={(v) => change({ order: v === 'auto' ? 'auto' : effective.order })}
          />
        </div>
        <div className="flex flex-col gap-1" title={t('settings.context.reminder.hint')}>
          <span className="font-medium">{t('settings.context.reminder')}</span>
          <Segmented
            testid="context-reminder"
            value={draft.reminder}
            disabled={!reminderApplies(effective.order)}
            options={[
              { value: 'auto', label: t('settings.context.reminder.auto') },
              { value: 'on', label: t('settings.context.reminder.on') },
              { value: 'off', label: t('settings.context.reminder.off') }
            ]}
            onChange={(v) => change({ reminder: v })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" data-testid="context-orders" data-order={effective.order}>
        {CONTEXT_ORDERS.map((o) => (
          <OrderCard key={o} order={o} reminder={draft.reminder === 'on' && reminderApplies(o)} active={effective.order === o} locked={auto} onPick={() => change({ order: o })} />
        ))}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t('settings.context.memory')}</span>
          <span className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300" data-testid="context-example">
            {conv?.model ? t('settings.context.memory.example', { model: conv.model, tokens: fmtInt(numCtx) }) : t('settings.context.memory.exampleNone', { tokens: fmtInt(numCtx) })}
          </span>
        </div>
        <div ref={bar} className="flex h-8 select-none rounded-lg border border-zinc-200 text-white dark:border-zinc-800" data-testid="context-bar">
          {segment('rounded-l-lg bg-brand-700', INSTRUCTIONS_SHARE, t('settings.context.bar.instructions'))}
          {segment('bg-brand-400', situation, t('settings.context.bar.situation'), handle('situation', situation, 1, 25, 1))}
          {segment('bg-teal-500', widths.behavior, t('settings.context.block.behavior'), handle('behavior', behavior, 0, behavior + examples, 5))}
          {segment('bg-lime-500', widths.examples, t('settings.context.block.examples'), handle('examples', examples, 0, 100 - behavior, 5))}
          {segment('bg-emerald-500', widths.documents, t('settings.context.block.knowledge'))}
          {segment('bg-brand-200 text-brand-900', history, t('settings.context.bar.history'))}
          {segment('rounded-r-lg bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', reserve, t('settings.context.bar.reserve'))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4" title={t('settings.context.memory.spare')}>
          {legend.map((l) => (
            <div key={l.key} className="text-xs leading-snug" data-testid={`context-legend-${l.key}`}>
              <div className="font-semibold">
                <i className={`mr-1.5 inline-block h-2 w-2 rounded-sm ${l.dot}`} />
                {l.title}
              </div>
              <div className="text-zinc-600 dark:text-zinc-400">{l.lines.join(' · ')}</div>
            </div>
          ))}
        </div>
        <span className="text-xs text-zinc-500">{t('settings.context.memory.hint', { share: knowledgeShare })}</span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="context-settings-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="text-xs text-brand-700 dark:text-brand-400" data-testid="context-settings-saved">
            {t('settings.context.saved')}
          </span>
        )}
        <button type="button" onClick={reset} className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800" data-testid="context-reset">
          {t('settings.context.reset')}
        </button>
        <button type="submit" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
          {t('common.save')}
        </button>
      </div>
    </form>
  )
}
