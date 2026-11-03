import { useEffect, useId, useRef, useState } from 'react'
import type { Conversation, ConversationPatch } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { useModels } from '../store/useModels'

/** Salvataggio con debounce, per slider e campi numerici. */
function useDebouncedPatch(convId: string, delay = 300): (patch: ConversationPatch) => void {
  const update = useConversations((s) => s.update)
  const pending = useRef<ConversationPatch>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = (): void => {
    clearTimeout(timer.current)
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length) void update(convId, patch)
  }
  // Alla chiusura del pannello o al cambio conversazione non si perde nulla.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, [convId])

  return (patch) => {
    Object.assign(pending.current, patch)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
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

const fmt = (n: number): string => n.toLocaleString('it-IT')

/** Un token è circa ¾ di parola: conversione indicativa per chi non conosce i token. */
const approxWords = (tokens: number): string => `≈ ${fmt(Math.round((tokens * 0.75) / 100) * 100)} parole`

/** Impostazioni del modello per la conversazione: temperatura, ragionamento e parametri avanzati. */
export function ModelSettings({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const save = useDebouncedPatch(conversation.id)
  const caps = useModels((s) => s.capabilities[conversation.model])
  const [temperature, setTemperature] = useState(conversation.temperature)
  // Lo slider è la fonte di verità mentre si trascina: si riallinea solo cambiando conversazione.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTemperature(conversation.temperature), [conversation.id])

  const advancedSet = conversation.topP != null || conversation.numCtx != null || conversation.seed != null

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
          <NumberField
            label="Varietà delle parole"
            technical="top_p"
            description="Quante parole alternative il modello considera a ogni passo. Più basso: risposte più prevedibili e ripetitive; più alto: più varie."
            hint="da 0 a 1"
            min={0}
            max={1}
            step={0.05}
            value={conversation.topP}
            placeholder="automatico"
            onChange={(v) => save({ topP: v })}
          />
          <NumberField
            label="Memoria della conversazione"
            technical="num_ctx"
            description="Quanto testo il modello tiene a mente, misurato in token (circa ¾ di parola ciascuno). Più alto: ricorda messaggi più vecchi, ma usa più memoria ed è più lento."
            hint={caps?.contextLength ? `max ${fmt(caps.contextLength)}` : undefined}
            note={conversation.numCtx ? approxWords(conversation.numCtx) : null}
            min={256}
            max={caps?.contextLength ?? undefined}
            step={1024}
            value={conversation.numCtx}
            placeholder="automatico"
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
