import { useEffect, useState } from 'react'
import { analyzeCall, CALL_LABELS } from '@shared/context'
import { formatElapsed } from '@shared/format'
import { SUMMARY } from '@shared/prompt'
import { RESERVE_SHARE } from '@shared/settings'
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

const int = (n: number): string => Math.round(n).toLocaleString('it-IT')
const pct = (n: number, total: number | null): string =>
  total ? ((n / total) * 100).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : ''
const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

  if (calls.length === 0) {
    return (
      <p className="text-sm text-zinc-500" data-testid="context-empty">
        Nessuna chiamata ancora. Qui compare, per ogni richiesta a Ollama (risposta, riassunto, titolo, memoria), quanto contesto
        viene inviato e quanto ne occupa davvero.
      </p>
    )
  }

  const index = Math.max(0, selected ? calls.findIndex((c) => c.id === selected) : 0)
  const call = calls[index]
  const a = analyzeCall(call)
  const ctx = call.numCtx
  // Scala della barra: num_ctx, o per gli embedding il massimo tra inviato e letto.
  const scale = ctx ?? Math.max(a.sent, call.promptEvalCount ?? 0, 1)
  const go = (i: number): void => setSelected(i === 0 ? null : (calls[i]?.id ?? null))
  const extra = call.promptEvalCount != null ? Math.max(0, call.promptEvalCount - a.sent) : 0

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="context-monitor">
      <p className="text-xs text-zinc-500">
        Cosa è stato inviato a Ollama e quanto ha occupato davvero. Le voci sono stime dell'app; i valori «consumato» li conta Ollama.
      </p>

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
