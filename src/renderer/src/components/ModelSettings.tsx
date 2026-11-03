import { useEffect, useId, useRef, useState } from 'react'
import { OLLAMA_DEFAULTS, type Conversation, type ConversationPatch } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { useModels } from '../store/useModels'
import { registerPendingSave } from '../store/pendingSaves'

/** Salvataggio con debounce, per slider e campi numerici. Viene scritto comunque prima di ogni invio. */
function useDebouncedPatch(convId: string, delay = 300): (patch: ConversationPatch) => void {
  const update = useConversations((s) => s.update)
  const pending = useRef<ConversationPatch>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flushRef = useRef<() => Promise<void>>(async () => undefined)

  flushRef.current = async () => {
    clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length) await update(convId, patch)
  }

  useEffect(() => {
    const unregister = registerPendingSave(() => flushRef.current())
    // Alla chiusura del pannello o al cambio conversazione non si perde nulla.
    return () => {
      unregister()
      void flushRef.current()
    }
  }, [convId])

  return (patch) => {
    Object.assign(pending.current, patch)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flushRef.current(), delay)
  }
}

function Switch(props: {
  label: string
  checked: boolean
  disabled?: boolean
  title: string
  compact?: boolean
  color: string
  onChange(v: boolean): void
}): React.JSX.Element {
  const { label, checked, disabled = false, title, compact = false, color, onChange } = props
  return (
    <label
      title={title}
      className={
        'flex select-none items-center gap-2 ' +
        (compact ? 'text-xs ' : 'text-sm ') +
        (disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')
      }
    >
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={
          'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 ' +
          (checked ? color : 'bg-zinc-300 dark:bg-zinc-700')
        }
      >
        <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ' + (checked ? 'left-4.5' : 'left-0.5')} />
      </span>
      <span>{label}</span>
    </label>
  )
}

/** Interruttore del ragionamento: disabilitato se il modello non ha la capability "thinking". */
export function ThinkToggle({ conversation, compact = false }: { conversation: Conversation; compact?: boolean }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const caps = useModels((s) => s.capabilities[conversation.model])
  const supported = caps?.thinking === true
  const title = !conversation.model
    ? 'Nessun modello selezionato'
    : !caps
      ? 'Verifica delle capacità del modello…'
      : supported
        ? 'Il modello ragiona prima di rispondere (più lento, spesso più accurato)'
        : `${conversation.model} non supporta il ragionamento`

  return (
    <Switch
      label="Ragionamento"
      checked={supported && conversation.think}
      disabled={!supported}
      title={title}
      compact={compact}
      color="bg-violet-600"
      onChange={(think) => void update(conversation.id, { think })}
    />
  )
}

/** Plan mode: il modello propone prima un piano, che l'utente approva o modifica. */
export function PlanModeToggle({ conversation, compact = false }: { conversation: Conversation; compact?: boolean }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  return (
    <Switch
      label="Plan mode"
      checked={conversation.planMode}
      title="Prima il piano, poi l'esecuzione: il modello propone i passi, tu li approvi o li modifichi"
      compact={compact}
      color="bg-amber-500"
      onChange={(planMode) => void update(conversation.id, { planMode })}
    />
  )
}

function NumberField(props: {
  label: string
  /** Spiegazione in linguaggio semplice, sempre visibile sotto il campo. */
  description: string
  /** Nome del parametro in Ollama, mostrato in piccolo per chi lo conosce. */
  technical: string
  /** Indicazione breve a destra dell'etichetta (es. l'intervallo ammesso). */
  hint?: string
  /** Nota dinamica sotto il campo (es. la conversione in parole). */
  note?: string | null
  value: number | null
  placeholder: string
  step?: number
  min?: number
  max?: number
  onChange(v: number | null): void
}): React.JSX.Element {
  const [text, setText] = useState(props.value == null ? '' : String(props.value))
  const focused = useRef(false)
  const descId = useId()
  // Riallinea al valore salvato (es. limitato dal main), ma mai mentre l'utente sta scrivendo.
  useEffect(() => {
    if (!focused.current) setText(props.value == null ? '' : String(props.value))
  }, [props.value])

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{props.label}</span>
        <code className="text-[11px] text-zinc-400" title="Nome del parametro in Ollama">
          {props.technical}
        </code>
      </span>
      <span id={descId} className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        {props.description}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          aria-label={props.label}
          aria-describedby={descId}
          step={props.step}
          min={props.min}
          max={props.max}
          value={text}
          placeholder={props.placeholder}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false
            setText(props.value == null ? '' : String(props.value))
          }}
          onChange={(e) => {
            setText(e.target.value)
            const n = e.target.value === '' ? null : Number(e.target.value)
            if (n === null || Number.isFinite(n)) props.onChange(n)
          }}
        />
        {props.hint && <span className="shrink-0 text-xs text-zinc-400">{props.hint}</span>}
      </div>
      {props.note && <span className="text-xs text-zinc-500">{props.note}</span>}
    </div>
  )
}

// Separatore delle migliaia anche a 4 cifre (4.096 come 32.768), per coerenza tra i valori.
const fmt = (n: number): string => n.toLocaleString('it-IT', { useGrouping: 'always' })

/** Un token è circa ¾ di parola: conversione indicativa per chi non conosce i token. */
const approxWords = (tokens: number): string => `≈ ${fmt(Math.round((tokens * 0.75) / 100) * 100)} parole`

/**
 * Cursore per un parametro facoltativo: "Automatico" (null) usa il valore del modello, mostrato come
 * posizione del cursore; muovendolo si fissa un valore; "Automatico" lo ripristina.
 * Con `steps` il cursore scorre su un elenco di valori (es. potenze di 2), altrimenti su min/max/step.
 */
function OptionalSlider(props: {
  label: string
  technical: string
  description: string
  value: number | null
  /** Valore effettivo quando è automatico (predefinito del modello o di Ollama). */
  autoValue: number
  /** Da dove viene il valore automatico, es. "consigliato dal modello". */
  autoSource: string
  format(v: number): string
  /** Nota aggiuntiva sul valore, es. "≈ 6.100 parole". */
  extra?(v: number): string | null
  steps?: number[]
  min?: number
  max?: number
  step?: number
  onChange(v: number | null): void
}): React.JSX.Element {
  const [local, setLocal] = useState(props.value)
  const descId = useId()
  const current = local ?? props.autoValue
  const extra = props.extra?.(current)
  const valueText = (local == null ? `Automatico, ${props.format(current)}` : props.format(current)) + (extra ? ` (${extra})` : '')

  // Con un elenco di valori il cursore lavora sugli indici.
  const indexed = !!props.steps
  const steps = props.steps ?? []
  const nearest = (v: number): number =>
    steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0)
  const min = indexed ? 0 : (props.min ?? 0)
  const max = indexed ? steps.length - 1 : (props.max ?? 1)
  const pos = indexed ? nearest(current) : Math.min(max, Math.max(min, current))

  const set = (v: number | null): void => {
    setLocal(v)
    props.onChange(v)
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{props.label}</span>
        <code className="text-[11px] text-zinc-400" title="Nome del parametro in Ollama">
          {props.technical}
        </code>
      </span>
      <span id={descId} className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        {props.description}
      </span>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="tabular-nums" data-testid={`${props.technical}-value`}>
          {local == null ? (
            <span className="text-zinc-500">
              Automatico · {props.format(current)} <span className="text-xs">({props.autoSource})</span>
            </span>
          ) : (
            <span className="font-medium">{props.format(current)}</span>
          )}
          {extra && <span className="ml-1 text-xs text-zinc-500">{extra}</span>}
        </span>
        {local != null && (
          <button
            type="button"
            onClick={() => set(null)}
            aria-label={`Torna al valore automatico: ${props.label}`}
            className="shrink-0 rounded px-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950"
          >
            ↺ Automatico
          </button>
        )}
      </div>
      <input
        type="range"
        aria-label={props.label}
        aria-describedby={descId}
        aria-valuetext={valueText}
        min={min}
        max={max}
        step={indexed ? 1 : props.step}
        value={pos}
        className={'accent-blue-600 ' + (local == null ? 'opacity-60' : '')}
        onChange={(e) => {
          const raw = Number(e.target.value)
          set(indexed ? steps[raw] : raw)
        }}
      />
      <span className="flex justify-between text-xs text-zinc-400">
        <span>{props.format(indexed ? steps[0] : min)}</span>
        <span>{props.format(indexed ? steps[steps.length - 1] : max)}</span>
      </span>
    </div>
  )
}

/** Valori del cursore della memoria: potenze di 2 da 1.024 al massimo del modello (incluso). */
export function contextSteps(max: number): number[] {
  const steps: number[] = []
  for (let v = 1024; v < max; v *= 2) steps.push(v)
  steps.push(max)
  return steps
}

/** Massimo usato se il modello non dichiara la lunghezza del contesto. */
const FALLBACK_MAX_CTX = 32768

/** Impostazioni del modello per la conversazione: temperatura, ragionamento e parametri avanzati. */
export function ModelSettings({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const save = useDebouncedPatch(conversation.id)
  const caps = useModels((s) => s.capabilities[conversation.model])
  const [temperature, setTemperature] = useState(conversation.temperature)
  // Lo slider è la fonte di verità mentre si trascina: si riallinea solo cambiando conversazione.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTemperature(conversation.temperature), [conversation.id])

  const advancedSet = conversation.topP != null || conversation.numCtx != null || conversation.seed != null
  const ctxSteps = contextSteps(caps?.contextLength ?? FALLBACK_MAX_CTX)

  return (
    <section className="flex flex-col gap-3" aria-label="Impostazioni del modello" data-testid="model-settings">
      <label className="flex flex-col gap-1 text-sm">
        <span className="flex items-baseline justify-between">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Temperatura</span>
          <span className="tabular-nums text-zinc-500" data-testid="temperature-value">
            {temperature.toFixed(2)}
          </span>
        </span>
        <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
          Quanto le risposte possono essere fantasiose. Bassa per fatti e codice, alta per idee e testi creativi.
          {caps?.defaults.temperature != null && (
            <> Il modello consiglia {caps.defaults.temperature.toLocaleString('it-IT')}.</>
          )}
        </span>
        <input
          type="range"
          aria-label="Temperatura"
          min={0}
          max={2}
          step={0.05}
          value={temperature}
          className="accent-blue-600"
          onChange={(e) => {
            const v = Number(e.target.value)
            setTemperature(v)
            save({ temperature: v })
          }}
        />
        <span className="flex justify-between text-xs text-zinc-400">
          <span>precisa</span>
          <span>creativa</span>
        </span>
      </label>

      <ThinkToggle conversation={conversation} />
      <PlanModeToggle conversation={conversation} />

      <details className="text-sm" open={advancedSet}>
        <summary className="cursor-pointer text-zinc-500">Impostazioni avanzate</summary>
        <p className="mt-1 text-xs text-zinc-500">
          Facoltative: lasciale vuote e il modello usa i suoi valori consigliati.
        </p>
        <div className="mt-3 flex flex-col gap-4">
          <OptionalSlider
            label="Varietà delle parole"
            technical="top_p"
            description="Quante parole alternative il modello considera a ogni passo. Più a sinistra: risposte più prevedibili e ripetitive; più a destra: più varie."
            value={conversation.topP}
            autoValue={caps?.defaults.topP ?? OLLAMA_DEFAULTS.topP}
            autoSource={caps?.defaults.topP != null ? 'consigliato dal modello' : 'predefinito di Ollama'}
            min={0.05}
            max={1}
            step={0.05}
            format={(v) => v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            onChange={(v) => save({ topP: v })}
          />
          <OptionalSlider
            label="Memoria della conversazione"
            technical="num_ctx"
            description={
              'Quanto testo il modello tiene a mente, in token (circa ¾ di parola ciascuno). Più a destra: ricorda messaggi più vecchi, ma usa più memoria ed è più lento.' +
              (caps?.contextLength ? '' : ' Il massimo di questo modello non è noto.')
            }
            value={conversation.numCtx}
            autoValue={caps?.defaults.numCtx ?? OLLAMA_DEFAULTS.numCtx}
            autoSource={caps?.defaults.numCtx != null ? 'consigliato dal modello' : 'predefinito di Ollama'}
            steps={ctxSteps}
            format={(v) => `${fmt(v)} token`}
            extra={approxWords}
            onChange={(v) => save({ numCtx: v })}
          />
          <NumberField
            label="Risposte ripetibili"
            technical="seed"
            description="Con un numero qualsiasi, la stessa domanda dà sempre la stessa risposta: utile per confrontare. Vuoto: ogni risposta è diversa."
            step={1}
            value={conversation.seed}
            placeholder="vuoto = sempre diverse"
            onChange={(v) => save({ seed: v })}
          />
        </div>
      </details>
    </section>
  )
}
