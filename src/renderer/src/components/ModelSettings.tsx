import { useEffect, useId, useRef, useState } from 'react'
import { STYLE_INSTRUCTIONS, STYLE_LABELS } from '@shared/prompt'
import { describeSuggestion, maxNumCtx, minNumCtx, resolveSettings, suggestNumCtx, suggestSettings } from '@shared/settings'
import { RESPONSE_STYLES, type Conversation, type ConversationPatch, type MemoryStatus, type ResponseStyle } from '@shared/types'
import { useChat } from '../store/useChat'
import { ContextMonitor } from './ContextMonitor'
import { BenchmarkButton, needsBenchmark, NumGpuSelect } from './ModelManager'
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
  const track = (
    <span
      aria-hidden
      className={
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 ' +
        (checked ? color : 'bg-zinc-300 dark:bg-zinc-700')
      }
    >
      <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ' + (checked ? 'left-4.5' : 'left-0.5')} />
    </span>
  )
  return (
    <label
      title={title}
      className={
        // Nel pannello: etichetta a sinistra, interruttore allineato al bordo destro.
        // Compatto (sotto il campo di scrittura): interruttore e testo affiancati.
        // relative: l'input nascosto (sr-only, position absolute) resta dentro il pannello che scorre,
        // altrimenti il documento si allunga fin dove starebbe l'input e la finestra può scorrere.
        'relative flex select-none items-center gap-2 ' +
        (compact ? 'text-xs ' : 'w-full justify-between text-sm ') +
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
      {compact ? (
        <>
          {track}
          <span>{label}</span>
        </>
      ) : (
        <>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
          {track}
        </>
      )}
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
      color="bg-brand-600"
      onChange={(think) => void update(conversation.id, { think })}
    />
  )
}

/**
 * «Dove gira»: esecuzione del modello (CPU/GPU) in una riga, sempre visibile in cima al pannello. È configurata
 * per modello e vale per tutte le conversazioni che lo usano. Per un modello mai testato (o aggiornato dopo il
 * test) propone il test, senza bloccare.
 */
export function ExecutionRow({ model }: { model: string }): React.JSX.Element | null {
  const setting = useModels((s) => s.modelSettings[model])
  const info = useModels((s) => s.models.find((m) => m.name === model))
  const setModelSetting = useModels((s) => s.setModelSetting)
  if (!model) return null
  const need = needsBenchmark(info, setting)
  const tps = (r: { evalTps: number | null } | undefined): string | null =>
    r?.evalTps != null ? r.evalTps.toLocaleString('it-IT', { maximumFractionDigits: 1 }) : null
  const best = tps(setting?.benchmark?.find((r) => r.numGpu === setting.numGpu))
  const cpu = tps(setting?.benchmark?.find((r) => r.numGpu === 0))
  const gpu = tps(setting?.benchmark?.find((r) => r.numGpu != null && r.numGpu >= 999))
  return (
    <div className="flex flex-col gap-1 pb-3 text-sm" data-testid="execution-row">
      <div className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[13px] font-semibold">Dove gira</span>
          <span className="rounded border border-zinc-200 px-1 text-[10.5px] text-zinc-500 dark:border-zinc-700" title="Vale per questo modello in tutte le conversazioni">
            per modello
          </span>
        </span>
        <span className="flex min-w-0 items-center justify-end gap-1.5 whitespace-nowrap text-xs text-zinc-500 tabular-nums">
          <NumGpuSelect model={model} compact />
          {best && <span>{best} tok/s</span>}
        </span>
      </div>
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        {model}, CPU o GPU in tutte le conversazioni.
        {cpu || gpu ? ` Dal test: ${[cpu && `${cpu} token/s in CPU`, gpu && `${gpu} in GPU`].filter(Boolean).join(', ')}.` : ''}{' '}
        <code className="text-[11px] text-zinc-400" title="Nome del parametro in Ollama">
          num_gpu
        </code>
      </span>
      {need && (
        <div className="mt-1 flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/40" data-testid="benchmark-notice">
          <span>
            {need === 'new'
              ? 'Modello nuovo: un test di 1–2 minuti dice se va più veloce in CPU o in GPU su questa macchina.'
              : 'Modello aggiornato dopo il test: conviene ripeterlo.'}
          </span>
          <span className="flex items-center gap-3">
            <BenchmarkButton model={model} />
            {need === 'new' && (
              <button type="button" className="text-zinc-500 hover:underline" onClick={() => void setModelSetting(model, { dismissed: true })}>
                Non chiedere più
              </button>
            )}
          </span>
        </div>
      )}
      {setting?.benchmarkedAt && !need && setting.gpuAvailable === false && (
        <span className="text-xs text-zinc-500">Ollama non usa la GPU per questo modello: va tutto in CPU.</span>
      )}
    </div>
  )
}

const STYLE_HINTS: Record<ResponseStyle, string> = {
  essential: 'Solo la risposta: niente premesse, riepiloghi o esempi. Per domande secche; su problemi complessi meglio «Conciso».',
  concise: 'Dritto al punto, un esempio al massimo. Buon compromesso per l\'uso quotidiano.',
  normal: 'Nessuna istruzione: il modello scrive come è abituato.',
  extended: 'Completo: contesto, alternative, esempi, avvertenze.'
}

/**
 * Stile della risposta: quattro livelli dal più sintetico al più esteso. Ogni livello è un'istruzione nel
 * system prompt (sezione «Stile della risposta»), non un limite di token: cambia quanto il modello decide di
 * dire, non lo ferma a metà frase, e dice di non sacrificare la precisione.
 */
export function StyleControl({ conversation, compact = false }: { conversation: Conversation; compact?: boolean }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const set = (style: ResponseStyle): void => {
    if (style !== conversation.style) void update(conversation.id, { style })
  }
  if (compact) {
    return (
      <label className="flex items-center gap-1" title={STYLE_HINTS[conversation.style]}>
        <span>Stile</span>
        <select
          aria-label="Stile della risposta"
          className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700"
          value={conversation.style}
          onChange={(e) => set(e.target.value as ResponseStyle)}
          data-testid="composer-style"
        >
          {RESPONSE_STYLES.map((st) => (
            <option key={st} value={st}>
              {STYLE_LABELS[st]}
            </option>
          ))}
        </select>
      </label>
    )
  }
  const instruction = STYLE_INSTRUCTIONS[conversation.style]
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="style-control">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Stile della risposta</span>
        <code className="text-[11px] text-zinc-400" title="Diventa una sezione del system prompt">
          system prompt
        </code>
      </span>
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        Quanto il modello scrive, dal più sintetico al più esteso. È un'istruzione nel system prompt, non un limite di token: riduce la verbosità senza fermare la risposta a metà, e chiede di non sacrificare la precisione.
      </span>
      <div role="radiogroup" aria-label="Stile della risposta" className="mt-1 grid grid-cols-4 overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700">
        {RESPONSE_STYLES.map((st) => (
          <button
            key={st}
            type="button"
            role="radio"
            aria-checked={conversation.style === st}
            title={STYLE_HINTS[st]}
            className={
              'px-1 py-1.5 transition-colors ' +
              (conversation.style === st
                ? 'bg-brand-600 font-medium text-white'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')
            }
            onClick={() => set(st)}
          >
            {STYLE_LABELS[st]}
          </button>
        ))}
      </div>
      <span className="text-xs text-zinc-500" data-testid="style-hint">
        {STYLE_HINTS[conversation.style]}
      </span>
      {instruction && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Istruzione inviata al modello</summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 dark:bg-zinc-900">{instruction}</p>
        </details>
      )}
    </div>
  )
}

/** Riassunto automatico: interruttore e stato; il testo e le azioni stanno nella scheda nel flusso dei messaggi. */
export function SummaryPanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const summarize = useConversations((s) => s.summarize)
  const messages = useChat((s) => s.messages)
  const busy = useChat((s) => !!s.streams[conversation.id])
  const [working, setWorking] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  // Un avviso vale per lo stato in cui è nato: cambiata conversazione o riassunto, sparisce.
  useEffect(() => setFeedback(null), [conversation.id, conversation.summaryUpdatedAt])

  const covered = conversation.summary && conversation.summaryUpTo ? messages.findIndex((m) => m.id === conversation.summaryUpTo) + 1 : 0

  const run = async (): Promise<void> => {
    setWorking(true)
    setFeedback(null)
    const before = useConversations.getState().error
    const ok = await summarize(conversation.id)
    if (!ok) {
      const err = useConversations.getState().error
      setFeedback(err && err !== before ? err : 'Riassunto non riuscito')
      useConversations.setState({ error: before })
    }
    setWorking(false)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="summary-panel">
      <Switch
        label="Riassunto automatico"
        checked={conversation.autoSummary}
        title="Quando i messaggi non stanno più nella memoria, prima della risposta i più vecchi vengono riassunti dal modello e il riassunto prende il loro posto nel system prompt"
        color="bg-brand-600"
        onChange={(autoSummary) => void update(conversation.id, { autoSummary })}
      />
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        {conversation.summary
          ? `Riassunto in vigore: copre ${covered > 0 ? `i primi ${covered} messaggi` : 'i messaggi più vecchi'}` +
            (conversation.summaryUpdatedAt ? `, aggiornato alle ${new Date(conversation.summaryUpdatedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : '') +
            '. Lo trovi nella conversazione, al confine con i messaggi inviati per intero.'
          : 'Nessun riassunto: tutti i messaggi vengono inviati per intero (finché stanno nella memoria).'}
      </span>
      <div className="flex flex-wrap gap-2 text-xs">
        {conversation.summary ? (
          <button
            type="button"
            className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            onClick={() => document.querySelector('[data-testid="summary-card"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            data-testid="summary-goto"
          >
            Vai al riassunto
          </button>
        ) : (
          <button
            type="button"
            className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            disabled={working || busy || messages.length < 3}
            title="Riassume subito i messaggi più vecchi, lasciando per intero l'ultimo scambio"
            onClick={() => void run()}
            data-testid="summary-now"
          >
            {working ? 'Riassumo…' : 'Riassumi ora'}
          </button>
        )}
      </div>
      {feedback && <span className="text-xs text-red-700 dark:text-red-300">{feedback}</span>}
    </div>
  )
}

/**
 * Memoria della conversazione (RAG): dopo il primo riassunto, prima di ogni risposta si cercano nei messaggi
 * riassunti gli estratti più pertinenti alla domanda e si aggiungono al system prompt.
 */
export function MemoryPanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const settings = useModels((s) => s.settings)
  const pull = useModels((s) => s.pull)
  const pulling = useModels((s) => (settings ? s.pulls[settings.embeddingModel] : undefined))
  const messagesCount = useChat((s) => s.messages.length)
  const busy = useChat((s) => !!s.streams[conversation.id])
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const load = async (): Promise<void> => {
    const res = await window.api.memory.status(conversation.id)
    if (res.ok) setStatus(res.data)
  }
  // Si aggiorna quando cambiano riassunto, messaggi o fine di una risposta.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [conversation.id, conversation.summaryUpTo, messagesCount, busy, settings?.embeddingModel, pulling])

  const model = settings?.embeddingModel ?? 'embeddinggemma'
  const text = !conversation.longMemory
    ? 'Spenta: dopo il riassunto il modello vede solo il riassunto e i messaggi recenti.'
    : !conversation.summary
      ? 'Si attiva dopo il primo riassunto: fino ad allora tutti i messaggi sono già nel prompt.'
      : status && !status.modelInstalled
        ? `Serve il modello di embedding ${model}, non installato.`
        : status
          ? `${status.chunks} ${status.chunks === 1 ? 'pezzo indicizzato' : 'pezzi indicizzati'}${status.pending ? `, ${status.pending} da indicizzare` : ''} con ${model}.`
          : 'Lettura dello stato…'

  return (
    <div className="flex flex-col gap-2" data-testid="memory-panel">
      <Switch
        label="Memoria a lungo termine"
        checked={conversation.longMemory}
        title="Dopo il primo riassunto, prima di ogni risposta cerca nei messaggi riassunti gli estratti più pertinenti alla domanda e li fornisce al modello"
        color="bg-brand-600"
        onChange={(longMemory) => void update(conversation.id, { longMemory })}
      />
      <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400" data-testid="memory-status">
        {text}
      </span>
      {conversation.longMemory && status && !status.modelInstalled && (
        <button
          type="button"
          disabled={!!pulling}
          className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          onClick={() => void pull(model).then((e) => (e ? setError(e) : load()))}
          data-testid="memory-download"
        >
          {pulling ? `Scarico ${model}… ${pulling.total ? `${Math.round(((pulling.completed ?? 0) / pulling.total) * 100)}%` : ''}` : `Scarica ${model}`}
        </button>
      )}
      {conversation.longMemory && conversation.summary && status?.modelInstalled && (
        <button
          type="button"
          disabled={working || busy}
          className="self-start rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          title="Rifà l'indice da zero (es. dopo aver cambiato il modello di embedding)"
          onClick={() => {
            setWorking(true)
            setError(null)
            void window.api.memory.rebuild(conversation.id).then((res) => {
              setWorking(false)
              if (res.ok) setStatus(res.data)
              else setError(res.error)
            })
          }}
          data-testid="memory-rebuild"
        >
          {working ? 'Indicizzo…' : 'Ricostruisci l\'indice'}
        </button>
      )}
      {conversation.longMemory && (
        <span className="text-xs text-zinc-400">
          Consigliato: in Impostazioni → Ollama, «Modelli caricati insieme» almeno 2, altrimenti Ollama ricarica il modello di chat a ogni ricerca.
        </span>
      )}
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
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
      color="bg-brand-500"
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
 * Cursore di un parametro del modello. Il valore è sempre quello configurato nella conversazione
 * (ciò che va a Ollama). Se c'è un valore suggerito diverso, "↺ Suggerito" lo ripristina.
 * Con `steps` il cursore scorre su un elenco di valori (es. potenze di 2), altrimenti su min/max/step.
 */
function SettingSlider(props: {
  label: string
  technical: string
  description: string
  value: number
  /** Valore suggerito per modello e macchina, se noto. */
  suggested: number | null
  /** Da dove viene il suggerimento, es. "consigliato dal modello". */
  suggestedSource?: string
  format(v: number): string
  /** Nota aggiuntiva sul valore, es. "≈ 6.100 parole". */
  extra?(v: number): string | null
  steps?: number[]
  min?: number
  max?: number
  step?: number
  /** Etichette agli estremi del cursore; di default i valori formattati. */
  ends?: [string, string]
  /** Avviso sul valore attuale (es. sotto il minimo consigliato): il cursore diventa rosso. */
  warning?(v: number): string | null
  onChange(v: number): void
}): React.JSX.Element {
  const [local, setLocal] = useState(props.value)
  // Il cursore è la fonte di verità mentre si trascina; si riallinea quando il valore cambia da fuori
  // (cambio modello, "Suggerito", altra conversazione).
  useEffect(() => setLocal(props.value), [props.value])
  const descId = useId()
  const extra = props.extra?.(local)
  const valueText = props.format(local) + (extra ? ` (${extra})` : '')

  // Con un elenco di valori il cursore lavora sugli indici.
  const indexed = !!props.steps
  const steps = props.steps ?? []
  const nearest = (v: number): number =>
    steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0)
  const min = indexed ? 0 : (props.min ?? 0)
  const max = indexed ? steps.length - 1 : (props.max ?? 1)
  const pos = indexed ? nearest(local) : Math.min(max, Math.max(min, local))

  const set = (v: number): void => {
    setLocal(v)
    props.onChange(v)
  }
  const isSuggested = props.suggested != null && props.suggested === local
  const warning = props.warning?.(local) ?? null

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
          <span className="font-medium">{props.format(local)}</span>
          {extra && <span className="text-xs text-zinc-500"> {extra}</span>}
          {isSuggested && props.suggestedSource && <span className="text-xs text-zinc-500"> ({props.suggestedSource})</span>}
        </span>
        {props.suggested != null && !isSuggested && (
          <button
            type="button"
            onClick={() => set(props.suggested!)}
            title={`Torna al valore suggerito: ${props.format(props.suggested)}` + (props.suggestedSource ? ` (${props.suggestedSource})` : '')}
            aria-label={`Torna al valore suggerito: ${props.label}`}
            className="shrink-0 rounded px-1.5 text-xs text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950"
          >
            ↺ Suggerito {props.format(props.suggested)}
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
        className={warning ? 'accent-red-600' : 'accent-brand-600'}
        data-warning={warning ? 'true' : undefined}
        onChange={(e) => {
          const raw = Number(e.target.value)
          set(indexed ? steps[raw] : raw)
        }}
      />
      {warning && (
        <span role="alert" className="text-xs font-medium text-red-700 dark:text-red-400" data-testid={`${props.technical}-warning`}>
          {warning}
        </span>
      )}
      <span className="flex justify-between text-xs text-zinc-400">
        <span>{props.ends?.[0] ?? props.format(indexed ? steps[0] : min)}</span>
        <span>{props.ends?.[1] ?? props.format(indexed ? steps[steps.length - 1] : max)}</span>
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

const SOURCE_MODEL = 'consigliato dal modello'
const SOURCE_OLLAMA = 'predefinito di Ollama'
const SOURCE_MACHINE = 'calcolato per questa macchina'

const GROUP_KEY = 'fastchat.modelGroups'

/** Gruppi aperti, ricordati tra una conversazione e l'altra e dopo il riavvio (chiusi di default). */
function readOpenGroups(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GROUP_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/**
 * Gruppo richiudibile del pannello. Chiuso mostra i valori correnti in una riga; aperto, i controlli con
 * le loro spiegazioni. Lo stato aperto/chiuso si ricorda.
 */
function Group({ id, title, badge, summary, children }: { id: string; title: string; badge?: string; summary: string; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(() => readOpenGroups()[id] === true)
  return (
    <details
      className="group border-t border-zinc-200 dark:border-zinc-800"
      data-group={id}
      open={open}
      onToggle={(e) => {
        const o = e.currentTarget.open
        setOpen(o)
        try {
          localStorage.setItem(GROUP_KEY, JSON.stringify({ ...readOpenGroups(), [id]: o }))
        } catch {
          /* storage non disponibile: la scelta vale solo per questa sessione */
        }
      }}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[14px_1fr] items-baseline gap-x-2 py-2.5 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block text-[11px] text-zinc-400 transition-transform group-open:rotate-90">▶</span>
        <span className="flex items-baseline gap-1.5 text-[13px] font-semibold">
          {title}
          {badge && <span className="rounded border border-zinc-200 px-1 text-[10.5px] font-normal text-zinc-500 dark:border-zinc-700">{badge}</span>}
        </span>
        {!open && (
          <span className="col-start-2 text-[11.5px] text-zinc-500 tabular-nums" data-testid={`group-${id}-summary`}>
            {summary}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-4 pb-4 pl-[22px]">{children}</div>
    </details>
  )
}

/**
 * Pannello Modello. In cima, fisso, «Dove gira»; poi tre gruppi richiudibili nell'ordine in cui si interviene:
 * come sceglie le parole, come risponde, cosa ricorda; in fondo, sempre visibile, lo stato del contesto con
 * il dettaglio del calcolo e le chiamate a Ollama.
 */
export function ModelSettings({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const save = useDebouncedPatch(conversation.id)
  const calibrate = useConversations((s) => s.calibrate)
  const caps = useModels((s) => s.capabilities[conversation.model])
  const system = useModels((s) => s.system)
  const modelBytes = useModels((s) => s.models.find((m) => m.name === conversation.model)?.size ?? null)
  const messages = useChat((s) => s.messages)

  // Stessi calcoli del main: ciò che si mostra come "suggerito" è ciò che la calibrazione scriverebbe.
  const effective = resolveSettings(conversation, caps)
  const input = { system, modelBytes, caps: caps ?? null }
  const suggested = suggestSettings(input)
  const machineCtx = suggestNumCtx(input)
  const ctxSteps = contextSteps(maxNumCtx(caps))
  const minCtx = minNumCtx(caps)
  const allSuggested =
    effective.temperature === suggested.temperature && effective.topP === suggested.topP && effective.numCtx === suggested.numCtx

  const thinkSupported = caps?.thinking === true
  const covered = conversation.summary && conversation.summaryUpTo ? messages.findIndex((m) => m.id === conversation.summaryUpTo) + 1 : 0
  const wordsSummary = `temperatura ${effective.temperature.toFixed(2)} · varietà ${effective.topP.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · seed ${conversation.seed ?? 'casuale'}`
  const answerSummary = `${STYLE_LABELS[conversation.style]} · ragionamento ${!caps ? '…' : !thinkSupported ? 'non disponibile' : conversation.think ? 'attivo' : 'spento'} · plan mode ${conversation.planMode ? 'attivo' : 'spento'}`
  const memorySummary =
    `${fmt(effective.numCtx)} token · riassunto ${conversation.summary ? `attivo (${covered > 0 ? `${covered} messaggi` : 'in vigore'})` : conversation.autoSummary ? 'automatico' : 'spento'}` +
    ` · memoria lunga ${conversation.longMemory ? 'attiva' : 'spenta'}`

  return (
    <section className="flex flex-col" aria-label="Impostazioni del modello" data-testid="model-settings">
      <ExecutionRow model={conversation.model} />

      <Group id="words" title="Come sceglie le parole" summary={wordsSummary}>
        <SettingSlider
          label="Temperatura"
          technical="temperature"
          description="Quanto le risposte possono essere fantasiose. Bassa per fatti e codice, alta per idee e testi creativi."
          value={effective.temperature}
          suggested={suggested.temperature}
          suggestedSource={caps?.defaults.temperature != null ? SOURCE_MODEL : SOURCE_OLLAMA}
          min={0}
          max={2}
          step={0.05}
          format={(v) => v.toFixed(2)}
          ends={['precisa', 'creativa']}
          onChange={(v) => save({ temperature: v })}
        />
        <SettingSlider
          label="Varietà delle parole"
          technical="top_p"
          description="Quante parole alternative il modello considera a ogni passo. Più a sinistra: risposte più prevedibili e ripetitive; più a destra: più varie."
          value={effective.topP}
          suggested={suggested.topP}
          suggestedSource={caps?.defaults.topP != null ? SOURCE_MODEL : SOURCE_OLLAMA}
          min={0.05}
          max={1}
          step={0.05}
          format={(v) => v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          onChange={(v) => save({ topP: v })}
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
        {!allSuggested && (
          <button
            type="button"
            onClick={() => void calibrate(conversation.id)}
            className="self-start rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="Riporta temperatura, varietà e memoria ai valori suggeriti per questo modello e questa macchina"
          >
            ↺ Tutti i valori suggeriti
          </button>
        )}
      </Group>

      <Group id="answer" title="Come risponde" summary={answerSummary}>
        <StyleControl conversation={conversation} />
        <div className="flex flex-col gap-1">
          <ThinkToggle conversation={conversation} />
          <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
            {!conversation.model
              ? 'Nessun modello selezionato.'
              : !caps
                ? 'Verifica delle capacità del modello…'
                : thinkSupported
                  ? 'Il modello ragiona prima di rispondere: più lento, spesso più accurato.'
                  : `${conversation.model} non supporta il ragionamento.`}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <PlanModeToggle conversation={conversation} />
          <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">Prima il piano, poi l'esecuzione: il modello propone i passi, tu li approvi o li modifichi.</span>
        </div>
      </Group>

      <Group id="memory" title="Cosa ricorda" summary={memorySummary}>
        <SettingSlider
          label="Memoria della conversazione"
          technical="num_ctx"
          description={
            'Quanto testo il modello tiene a mente, in token (circa ¾ di parola ciascuno). Più a destra: ricorda messaggi più vecchi, ma usa più memoria ed è più lento. ' +
            describeSuggestion(input) +
            (caps?.contextLength ? '' : ' Il massimo di questo modello non è noto.')
          }
          value={effective.numCtx}
          suggested={suggested.numCtx}
          suggestedSource={machineCtx != null ? SOURCE_MACHINE : caps?.defaults.numCtx != null ? SOURCE_MODEL : SOURCE_OLLAMA}
          steps={ctxSteps}
          format={(v) => `${fmt(v)} token`}
          extra={approxWords}
          warning={(v) =>
            v < minCtx
              ? `Sotto il minimo per questo modello (${fmt(minCtx)} token, predefinito di Ollama): le risposte possono interrompersi e il riassunto perde dettagli.`
              : null
          }
          onChange={(v) => save({ numCtx: v })}
        />
        <SummaryPanel conversation={conversation} />
        <MemoryPanel conversation={conversation} />
      </Group>

      <ContextMonitor conversation={conversation} />
    </section>
  )
}
