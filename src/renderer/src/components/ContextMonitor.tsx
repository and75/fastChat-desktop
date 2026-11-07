import { useEffect, useState } from 'react'
import { analyzeCall, CALL_LABELS, reconcile, type ReconcileRow } from '@shared/context'
import { formatElapsed } from '@shared/format'
import { DEFAULT_CHARS_PER_TOKEN, SUMMARY, type ContextUsage } from '@shared/prompt'
import { MEMORY } from '@shared/memory'
import { RESERVE_SHARE } from '@shared/settings'
import { useContextUsage } from './ContextMeter'
import type { ContextCall, ContextPart, Conversation } from '@shared/types'

/** Colore di ogni voce (barra e tabella). */
const COLORS: Record<ContextPart['key'], string> = {
  instructions: 'bg-brand-700',
  style: 'bg-brand-500',
  summary: 'bg-fuchsia-400',
  memory: 'bg-sky-500',
  history: 'bg-brand-200 dark:bg-brand-400',
  question: 'bg-amber-500',
  transcript: 'bg-brand-200 dark:bg-brand-400',
  texts: 'bg-sky-500'
}

const int = (n: number): string => Math.round(n).toLocaleString('it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions)
const pct = (n: number, total: number | null): string =>
  total ? ((n / total) * 100).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : ''
const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
const speed = (tokens: number | null, ms: number | null): string =>
  tokens && ms ? ` · ${(tokens / (ms / 1000)).toLocaleString('it-IT', { maximumFractionDigits: 1 })} tok/s` : ''

/** Etichetta della chiamata nel selettore. */
const callLabel = (c: ContextCall): string => `${CALL_LABELS[c.kind]}${c.note ? ` (${c.note})` : ''} · ${hhmmss(c.createdAt)}`

/**
 * Scheda «Contesto»: per ogni chiamata a Ollama della conversazione, cosa è stato inviato (stima dell'app,
 * voce per voce) e quanto ha occupato davvero (conteggi di Ollama), con i tempi.
 */
export function ContextMonitor({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const [calls, setCalls] = useState<ContextCall[]>([])
  /** Id della chiamata scelta; null = segui l'ultima. */
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setCalls([])
    setSelected(null)
    void window.api.context.calls(conversation.id).then((r) => alive && r.ok && setCalls(r.data))
    const off = window.api.context.onCall((call) => {
      if (call.conversationId === conversation.id) setCalls((list) => [call, ...list.filter((c) => c.id !== call.id)].slice(0, 50))
    })
    return () => {
      alive = false
      off()
    }
  }, [conversation.id])

  const lastAnswer = calls.find((c) => (c.kind === 'chat' || c.kind === 'execute' || c.kind === 'plan') && !c.error)
  const last = calls[0]
  return (
    <section className="flex flex-col gap-1.5 border-t border-zinc-200 pt-3 text-xs dark:border-zinc-800" aria-label="Stato del contesto" data-testid="context-monitor">
      <ContextState conversation={conversation} lastAnswer={lastAnswer ?? null} />
      <details className="group/calls" data-testid="context-calls">
        <summary className="cursor-pointer list-none text-brand-700 dark:text-brand-300 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block transition-transform group-open/calls:rotate-90">▸</span> Chiamate a Ollama
          {calls.length > 0 && (
            <span className="text-zinc-500">
              {' '}· {calls.length}, ultima {hhmm(last.createdAt)}
            </span>
          )}
        </summary>
        <div className="pt-2">
          {calls.length === 0 ? (
            <p className="text-zinc-500" data-testid="context-empty">
              Nessuna chiamata ancora. Qui compare, per ogni richiesta a Ollama (risposta, riassunto, titolo, memoria), quanto contesto
              viene inviato e quanto ne occupa davvero.
            </p>
          ) : (
            <CallDetail calls={calls} selected={selected} setSelected={setSelected} />
          )}
        </div>
      </details>
    </section>
  )
}

/** Dettaglio di una chiamata: inviato per voce, consumato secondo Ollama, tempi. */
function CallDetail({
  calls,
  selected,
  setSelected
}: {
  calls: ContextCall[]
  selected: string | null
  setSelected: (id: string | null) => void
}): React.JSX.Element {

  const index = Math.max(0, selected ? calls.findIndex((c) => c.id === selected) : 0)
  const call = calls[index]
  const a = analyzeCall(call)
  const ctx = call.numCtx
  // Scala della barra: num_ctx, o per gli embedding il massimo tra inviato e letto.
  const scale = ctx ?? Math.max(a.sent, call.promptEvalCount ?? 0, 1)
  const go = (i: number): void => setSelected(i === 0 ? null : (calls[i]?.id ?? null))
  const extra = call.promptEvalCount != null ? Math.max(0, call.promptEvalCount - a.sent) : 0

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="context-call">
      <p className="text-zinc-500">Cosa è stato inviato a Ollama e quanto ha occupato davvero. Le voci sono stime dell'app; i valori «consumato» li conta Ollama.</p>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Chiamata precedente"
          disabled={index >= calls.length - 1}
          onClick={() => go(index + 1)}
          className="rounded border border-zinc-300 px-1.5 text-xs disabled:opacity-40 dark:border-zinc-700"
        >
          ‹
        </button>
        <select
          aria-label="Chiamata"
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          value={call.id}
          onChange={(e) => go(calls.findIndex((c) => c.id === e.target.value))}
          data-testid="context-call-select"
        >
          {calls.map((c) => (
            <option key={c.id} value={c.id}>
              {callLabel(c)}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Chiamata successiva"
          disabled={index === 0}
          onClick={() => go(index - 1)}
          className="rounded border border-zinc-300 px-1.5 text-xs disabled:opacity-40 dark:border-zinc-700"
        >
          ›
        </button>
      </div>
      <p className="-mt-2 text-xs text-zinc-500">
        Chiamata {calls.length - index} di {calls.length} · {call.model}
        {ctx ? ` · num_ctx ${int(ctx)}` : ' · contesto predefinito del modello'}
        {index === 0 ? ' · ultima' : ''}
      </p>

      <div>
        <div className="relative flex h-3.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden>
          {call.parts.map((p) => (
            <span key={p.key + p.label} className={COLORS[p.key]} style={{ width: `${(p.tokens / scale) * 100}%` }} />
          ))}
          {extra > 0 && <span className="bg-amber-300/60" style={{ width: `${(extra / scale) * 100}%` }} />}
          {call.evalCount != null && <span className="bg-emerald-500" style={{ width: `${(call.evalCount / scale) * 100}%` }} />}
          {ctx && (
            <>
              <i className="absolute inset-y-0 w-px bg-zinc-900 dark:bg-zinc-100" style={{ left: `${SUMMARY.trigger * 100}%` }} />
              <i className="absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${(1 - RESERVE_SHARE) * 100}%` }} />
            </>
          )}
        </div>
        {ctx && (
          <div className="relative mt-0.5 h-3 text-[10px] text-zinc-400">
            <span className="absolute -translate-x-full pr-1" style={{ left: `${SUMMARY.trigger * 100}%` }}>
              riassunto 70%
            </span>
            <span className="absolute pl-1" style={{ left: `${(1 - RESERVE_SHARE) * 100}%` }}>
              riserva
            </span>
          </div>
        )}
      </div>

      <table className="w-full text-xs" data-testid="context-sent">
        <thead className="text-zinc-500">
          <tr>
            <th className="text-left font-normal">Inviato (stima)</th>
            <th className="text-right font-normal">token</th>
            {ctx && <th className="w-12 text-right font-normal">% ctx</th>}
          </tr>
        </thead>
        <tbody>
          {call.parts.map((p) => (
            <tr key={p.key + p.label}>
              <td className="py-0.5">
                <i className={`mr-1.5 inline-block h-2 w-2 rounded-sm ${COLORS[p.key]}`} />
                {p.label}
                {p.count != null && <span className="text-zinc-500"> ({p.count})</span>}
              </td>
              <td className="text-right tabular-nums">{int(p.tokens)}</td>
              {ctx && <td className="text-right tabular-nums text-zinc-500">{pct(p.tokens, ctx)}</td>}
            </tr>
          ))}
          <tr className="border-t border-zinc-200 font-semibold dark:border-zinc-800">
            <td className="pt-1">Totale inviato</td>
            <td className="pt-1 text-right tabular-nums">≈ {int(a.sent)}</td>
            {ctx && <td className="pt-1 text-right tabular-nums">{pct(a.sent, ctx)}</td>}
          </tr>
        </tbody>
      </table>
      {call.droppedMessages > 0 && (
        <p className="-mt-2 text-xs text-zinc-500">
          {call.droppedMessages === 1 ? '1 messaggio non riassunto è rimasto fuori' : `${call.droppedMessages} messaggi non riassunti sono rimasti fuori`}: non
          entravano nella memoria.
        </p>
      )}

      <table className="w-full text-xs" data-testid="context-consumed">
        <thead>
          <tr>
            <th colSpan={ctx ? 3 : 2} className="pb-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
              Consumato (da Ollama)
            </th>
          </tr>
        </thead>
        <tbody>
          {call.error ? (
            <tr>
              <td colSpan={3} className="text-red-700 dark:text-red-400">
                Chiamata fallita: {call.error}
              </td>
            </tr>
          ) : call.promptEvalCount == null ? (
            <tr>
              <td colSpan={3} className="text-zinc-500">
                {call.aborted ? 'Interrotta prima della fine: Ollama non ha mandato i conteggi.' : 'Ollama non ha mandato i conteggi.'}
              </td>
            </tr>
          ) : (
            <>
              <tr>
                <td className="py-0.5">
                  <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-amber-300" />
                  Prompt letto <span className="text-zinc-400">prompt_eval_count</span>
                </td>
                <td className="text-right tabular-nums">{int(call.promptEvalCount)}</td>
                {ctx && <td className="w-12 text-right tabular-nums text-zinc-500">{pct(call.promptEvalCount, ctx)}</td>}
              </tr>
              <tr className="text-zinc-500">
                <td className="py-0.5 pl-3.5">Scarto rispetto alla stima</td>
                <td className="text-right tabular-nums">
                  {a.delta! > 0 ? '+' : ''}
                  {int(a.delta!)}
                </td>
                {ctx && (
                  <td className="text-right tabular-nums">
                    {a.deltaShare != null ? `${a.deltaShare > 0 ? '+' : ''}${Math.round(a.deltaShare * 100)}%` : ''}
                  </td>
                )}
              </tr>
              {call.evalCount != null && (
                <tr>
                  <td className="py-0.5">
                    <i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-500" />
                    Risposta <span className="text-zinc-400">eval_count</span>
                  </td>
                  <td className="text-right tabular-nums">{int(call.evalCount)}</td>
                  {ctx && <td className="text-right tabular-nums text-zinc-500">{pct(call.evalCount, ctx)}</td>}
                </tr>
              )}
              <tr className="border-t border-zinc-200 font-semibold dark:border-zinc-800">
                <td className="pt-1">Occupato</td>
                <td className="pt-1 text-right tabular-nums">{int(a.occupied!)}</td>
                {ctx && <td className="pt-1 text-right tabular-nums">{pct(a.occupied!, ctx)}</td>}
              </tr>
              {ctx && (
                <tr className="text-zinc-500">
                  <td>Libero</td>
                  <td className="text-right tabular-nums">{int(Math.max(0, ctx - a.occupied!))}</td>
                  <td className="text-right tabular-nums">{pct(Math.max(0, ctx - a.occupied!), ctx)}</td>
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>

      {(call.loadMs != null || call.promptEvalMs != null || call.evalMs != null || call.durationMs != null) && (
        <table className="w-full text-xs" data-testid="context-times">
          <thead>
            <tr>
              <th colSpan={2} className="pb-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                Tempi
              </th>
            </tr>
          </thead>
          <tbody>
            {call.loadMs != null && (
              <tr>
                <td>Caricamento del modello</td>
                <td className="text-right tabular-nums">{formatElapsed(call.loadMs)}</td>
              </tr>
            )}
            {call.promptEvalMs != null && (
              <tr>
                <td>Lettura del prompt</td>
                <td className="text-right tabular-nums">
                  {formatElapsed(call.promptEvalMs)}
                  {speed(call.promptEvalCount, call.promptEvalMs)}
                </td>
              </tr>
            )}
            {call.evalMs != null && (
              <tr>
                <td>Scrittura della risposta</td>
                <td className="text-right tabular-nums">
                  {formatElapsed(call.evalMs)}
                  {speed(call.evalCount, call.evalMs)}
                </td>
              </tr>
            )}
            {call.durationMs != null && (
              <tr className="text-zinc-500">
                <td>Totale</td>
                <td className="text-right tabular-nums">{formatElapsed(call.durationMs)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {a.truncated && (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Il prompt non entrava in num_ctx: Ollama l'ha <b>troncato</b> (ha letto {int(call.promptEvalCount ?? 0)} token contro {int(a.sent)} stimati).
          La parte iniziale può essere andata persa.
        </p>
      )}
      {a.readLess && (
        <p className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Ollama ha letto molto meno della stima: probabilmente ha riusato la parte del prompt già in memoria (cache) e conta solo i
          token nuovi.
        </p>
      )}
      {call.doneReason === 'length' && <p className="text-xs text-amber-700 dark:text-amber-400">Risposta fermata al limite di token.</p>}
    </div>
  )
}

/** Come è stato calcolato il numero del contatore. */
function sourceText(usage: ContextUsage): string {
  const cpt = `${usage.charsPerToken.toLocaleString('it-IT')} caratteri per token${usage.charsPerToken === DEFAULT_CHARS_PER_TOKEN ? ' (valore predefinito)' : ', misurati sulla conversazione'}`
  switch (usage.source) {
    case 'ollama':
      return `Conteggio di Ollama dell'ultima risposta (prompt + risposta)${usage.estimated ? ', più la stima dei messaggi successivi' : ''}. Le voci sono stime: la differenza è lo scarto di Ollama.`
    case 'summary-changed':
      return `Stima con ${cpt}. I conteggi di Ollama dell'ultima risposta non valgono più: il riassunto è cambiato dopo.`
    case 'cache':
      return `Stima con ${cpt}. Il conteggio di Ollama dell'ultima risposta era troppo basso (cache dei prompt): non attendibile.`
    default:
      return `Stima con ${cpt}: Ollama non ha ancora dato conteggi per questi messaggi.`
  }
}

/** Nota sotto una riga della riconciliazione. */
function rowNote(row: ReconcileRow, rows: ReconcileRow[]): string | null {
  const summary = rows.find((r) => r.key === 'summary')
  const entered = (summary?.nowCount ?? 0) - (summary?.thenCount ?? 0)
  switch (row.key) {
    case 'summary':
      if (row.then == null) return `creato dopo la risposta: copre ${row.nowCount} messaggi`
      if (row.now == null) return 'non più in vigore'
      return entered > 0 ? `aggiornato dopo la risposta: copre ${row.nowCount} messaggi invece di ${row.thenCount}` : null
    case 'memory':
      return row.now == null ? 'si scelgono di nuovo a ogni domanda: non contano finché non si invia' : null
    case 'history': {
      const notes = []
      if (entered > 0) notes.push(`${entered} messaggi entrati nel riassunto`)
      if (rows.some((r) => r.key === 'question' || r.key === 'answer')) notes.push('domanda e risposta ora fanno parte dello storico')
      return notes.length ? notes.join('; ') : null
    }
    case 'ollama':
      return 'prompt letto da Ollama meno la stima delle voci'
    default:
      return null
  }
}

/**
 * «Stato del contesto»: lo stesso numero del contatore in basso, con le voci, come è stato calcolato e il
 * confronto con l'ultima risposta (perché i due numeri non coincidono).
 */
function ContextState({ conversation, lastAnswer }: { conversation: Conversation; lastAnswer: ContextCall | null }): React.JSX.Element | null {
  const usage = useContextUsage()
  if (!usage) return null
  const ctx = usage.total
  const pctOf = (n: number): string => `${Math.round((n / ctx) * 100)}%`
  const memoryRoom =
    conversation.longMemory && conversation.summary
      ? Math.max(0, Math.min(Math.floor(ctx * MEMORY.budgetShare), ctx - Math.floor(ctx * RESERVE_SHARE) - usage.used))
      : 0
  const rec = lastAnswer ? reconcile(lastAnswer, usage) : null
  const cell = (n: number | null, count?: number): string => (n == null ? '—' : `${int(n)}${count != null ? ` (${count})` : ''}`)
  const signed = (n: number): string => (n > 0 ? `+${int(n)}` : n < 0 ? `−${int(-n)}` : '0')

  return (
    <div className="flex flex-col gap-1.5" data-testid="context-state">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Stato del contesto</h3>
        <span className="text-[13px] font-semibold tabular-nums" data-testid="context-state-total">
          {usage.estimated ? '≈ ' : ''}
          {int(usage.used)} / {int(ctx)} · {pctOf(usage.used)}
        </span>
      </div>
      <div className="relative flex h-2.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden>
        {usage.parts.map((p) => (
          <span key={p.key} className={COLORS[p.key]} style={{ width: `${(Math.max(0, p.tokens) / ctx) * 100}%` }} />
        ))}
        {usage.adjustment > 0 && <span className="bg-amber-300/60" style={{ width: `${(usage.adjustment / ctx) * 100}%` }} />}
        <i className="absolute inset-y-0 w-px bg-zinc-900 dark:bg-zinc-100" style={{ left: `${SUMMARY.trigger * 100}%` }} />
        <i className="absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${(1 - RESERVE_SHARE) * 100}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5" data-testid="context-state-parts">
        {usage.parts.map((p) => (
          <span key={p.key}>
            <i className={`mr-1 inline-block h-2 w-2 rounded-sm ${COLORS[p.key]}`} />
            {p.key === 'instructions' ? 'Istruzioni' : p.key === 'style' ? 'Stile' : p.label}
            {p.key === 'history' && p.count != null ? ` (${p.count})` : ''} {int(p.tokens)}
          </span>
        ))}
        {usage.adjustment !== 0 && (
          <span>
            <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-300" />
            Scarto di Ollama {signed(usage.adjustment)}
          </span>
        )}
      </div>
      <details className="group/calc" data-testid="context-reconcile">
        <summary className="cursor-pointer list-none text-brand-700 dark:text-brand-300 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block transition-transform group-open/calc:rotate-90">▸</span> Dettaglio del calcolo
          {rec && (
            <span className="text-zinc-500 tabular-nums">
              {' '}· {int(rec.thenTotal)} → {int(rec.nowTotal)}
            </span>
          )}
        </summary>
        <div className="flex flex-col gap-1.5 pt-1.5">
          <p className="text-zinc-500" data-testid="context-state-source">
            {sourceText(usage)}{' '}
            {conversation.autoSummary
              ? `Il riassunto scatta oltre ${int(ctx * SUMMARY.trigger)} (${Math.round(SUMMARY.trigger * 100)}%); `
              : ''}
            {int(Math.floor(ctx * RESERVE_SHARE))} ({Math.round(RESERVE_SHARE * 100)}%) restano liberi per la risposta.
          </p>
          <p className="text-zinc-400">
            Alla prossima domanda si aggiungono la domanda{memoryRoom > 0 ? ` e gli estratti della memoria (fino a ${int(memoryRoom)})` : ''}.
          </p>
          {rec && (
            <table className="mt-0.5 w-full">
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left font-normal">Voce</th>
                  <th className="text-right font-normal">Risposta {lastAnswer ? hhmm(lastAnswer.createdAt) : ''}</th>
                  <th className="text-right font-normal">Ora</th>
                  <th className="w-12 text-right font-normal">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rec.rows.map((r) => {
                  const note = rowNote(r, rec.rows)
                  return <FragmentRow key={r.key} row={r} note={note} cell={cell} signed={signed} />
                })}
                <tr className="border-t border-zinc-200 font-semibold dark:border-zinc-800">
                  <td className="pt-1">Totale</td>
                  <td className="pt-1 text-right tabular-nums">{int(rec.thenTotal)}</td>
                  <td className="pt-1 text-right tabular-nums">{int(rec.nowTotal)}</td>
                  <td className="pt-1 text-right tabular-nums">{signed(rec.nowTotal - rec.thenTotal)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </details>
    </div>
  )
}

function FragmentRow({
  row,
  note,
  cell,
  signed
}: {
  row: ReconcileRow
  note: string | null
  cell: (n: number | null, count?: number) => string
  signed: (n: number) => string
}): React.JSX.Element {
  return (
    <>
      <tr>
        <td className="pt-0.5">{row.label}</td>
        <td className="text-right tabular-nums">{row.key === 'ollama' && row.then != null ? signed(row.then) : cell(row.then, row.key === 'history' ? row.thenCount : undefined)}</td>
        <td className="text-right tabular-nums">{row.key === 'ollama' && row.now != null ? signed(row.now) : cell(row.now, row.key === 'history' ? row.nowCount : undefined)}</td>
        <td className="text-right tabular-nums">{signed(row.delta)}</td>
      </tr>
      {note && (
        <tr>
          <td colSpan={4} className="pb-0.5 pl-2 text-[10.5px] text-zinc-500">
            {note}
          </td>
        </tr>
      )}
    </>
  )
}
