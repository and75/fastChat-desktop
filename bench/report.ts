// Il rapporto del banco di prova: numeri per variante e modello, poi i casi uno per uno con ciò che non va.
import { passRate } from './checks'
import type { CaseResult } from './types'

const mean = (values: number[]): number | null => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
const sum = (values: Array<number | null>): number => values.reduce<number>((a, b) => a + (b ?? 0), 0)
const num = (value: number | null, digits = 1): string => (value == null ? '—' : value.toFixed(digits).replace('.', ','))
const seconds = (ms: number | null): string => (ms == null ? '—' : `${Math.round(ms / 1000)} s`)
const percent = (value: number | null): string => (value == null ? '—' : `${Math.round(value * 100)}%`)

export interface Summary {
  variant: string
  model: string
  split: 'train' | 'test' | 'all'
  cases: number
  /** Quota media di controlli superati. */
  checks: number | null
  /** Voto medio del giudice (1–5), se c'è. */
  score: number | null
  /** Tempo medio per caso (tutte le battute), ms. */
  totalMs: number | null
  tokensPerSecond: number | null
  /** Quota dei token generati spesa in ragionamento. */
  thinkingShare: number | null
  promptTokens: number | null
  errors: number
}

/** Le misure aggregate di un gruppo di risultati. */
export function summarize(results: CaseResult[], variant: string, model: string, split: Summary['split']): Summary {
  const rows = results.filter((r) => r.variant === variant && r.model === model && (split === 'all' || r.case.split === split))
  const ok = rows.filter((r) => !r.error)
  const turns = ok.flatMap((r) => r.turns)
  const output = sum(turns.map((t) => t.measures.outputTokens))
  return {
    variant,
    model,
    split,
    cases: rows.length,
    checks: mean(ok.map((r) => passRate(r.checks))),
    score: mean(ok.flatMap((r) => (r.verdict ? [r.verdict.mean] : []))),
    totalMs: mean(ok.map((r) => sum(r.turns.map((t) => t.measures.totalMs)))),
    tokensPerSecond: mean(turns.flatMap((t) => (t.measures.tokensPerSecond == null ? [] : [t.measures.tokensPerSecond]))),
    thinkingShare: output ? sum(turns.map((t) => t.measures.thinkingTokens)) / output : null,
    promptTokens: mean(turns.flatMap((t) => (t.measures.promptTokens == null ? [] : [t.measures.promptTokens]))),
    errors: rows.length - ok.length
  }
}

/** Il numero con cui si confrontano due varianti: il voto del giudice se c'è, altrimenti i controlli superati. */
export const headline = (s: Summary): number | null => (s.score != null ? s.score / 5 : s.checks)

const pairs = (results: CaseResult[]): Array<[string, string]> => [...new Set(results.map((r) => `${r.variant}\u0000${r.model}`))].map((k) => k.split('\u0000') as [string, string])

function table(results: CaseResult[], split: Summary['split']): string {
  const rows = pairs(results).map(([variant, model]) => summarize(results, variant, model, split)).filter((s) => s.cases > 0)
  if (rows.length === 0) return '_Nessun caso._\n'
  const lines = ['| Variante | Modello | Casi | Controlli superati | Voto del giudice | Tempo per caso | Token/s | Ragionamento | Prompt (token) | Errori |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const s of rows) lines.push(`| ${s.variant} | ${s.model} | ${s.cases} | ${percent(s.checks)} | ${s.score == null ? '—' : `${num(s.score)} / 5`} | ${seconds(s.totalMs)} | ${num(s.tokensPerSecond)} | ${percent(s.thinkingShare)} | ${s.promptTokens == null ? '—' : Math.round(s.promptTokens)} | ${s.errors} |`)
  return lines.join('\n') + '\n'
}

function caseSection(r: CaseResult): string {
  const out: string[] = [`### ${r.case.id} · ${r.model} · ${r.variant}${r.rep > 1 ? ` · ripetizione ${r.rep}` : ''}`, '']
  out.push(`- Gruppo: ${r.case.split === 'train' ? 'di lavoro' : 'di controllo'} · atteso: ${r.case.expect}${r.case.note ? ` · ${r.case.note}` : ''}`)
  out.push(`- Scelte: ${Object.entries(r.choices).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ')}`)
  out.push(`- Impostazioni: ragionamento ${r.settings.think ? 'acceso' : 'spento'}, memoria ${r.settings.numCtx ?? '—'}, temperatura ${r.settings.temperature ?? '—'}`)
  if (r.error) out.push(`- **Errore**: ${r.error}`)
  const failed = r.checks.filter((c) => !c.pass)
  out.push(`- Controlli: ${r.checks.length - failed.length}/${r.checks.length} superati${failed.length ? ` — falliti: ${failed.map((c) => `**${c.id}** (${c.detail})`).join('; ')}` : ''}`)
  if (r.verdict) {
    out.push(`- Giudice: **${num(r.verdict.mean)} / 5** — ${r.verdict.scores.map((s) => `${s.criterion} ${s.score}`).join(', ')}`)
    for (const p of r.verdict.problems) out.push(`  - ${p}`)
  }
  for (const [i, t] of r.turns.entries()) {
    const m = t.measures
    out.push('', `**Battuta ${i + 1}** — ${seconds(m.totalMs)} (lettura del prompt ${seconds(m.promptEvalMs)}, generazione ${seconds(m.evalMs)}), ${m.promptTokens ?? '—'} token letti, ${m.outputTokens ?? '—'} generati di cui ${m.thinkingTokens ?? '—'} di ragionamento, ${num(m.tokensPerSecond)} token/s`, '', `> ${t.user.replaceAll('\n', '\n> ')}`, '')
    out.push(t.error ? `_Errore: ${t.error}_` : t.answer.trim() || '_Risposta vuota._')
  }
  return out.join('\n') + '\n'
}

export interface ReportInput {
  role: string
  startedAt: string
  options: { models: string[]; reps: number; think: string; numCtx: number; judge: string | null; rounds: number }
  results: CaseResult[]
  /** Racconto del ciclo: quale variante è stata tenuta e perché. */
  notes: string[]
}

/** Il rapporto in Markdown: da leggere e da condividere. */
export function buildReport(input: ReportInput): string {
  const { results } = input
  const out: string[] = [`# Banco di prova · ${input.role}`, '']
  out.push(`- Avviato: ${input.startedAt}`)
  out.push(`- Modelli: ${input.options.models.join(', ')} · ripetizioni: ${input.options.reps} · ragionamento: ${input.options.think} · memoria: ${input.options.numCtx}`)
  out.push(`- Giudice: ${input.options.judge ?? 'nessuno (solo misure e controlli a regole fisse)'} · giri di correzione: ${input.options.rounds}`)
  if (input.notes.length) out.push('', '## Esito', '', ...input.notes.map((n) => `- ${n}`))
  out.push('', '## Casi di controllo', '', 'Il confronto tra varianti si fa su questi: il correttore non li ha mai visti.', '', table(results, 'test'))
  out.push('## Casi di lavoro', '', table(results, 'train'))
  out.push('## Casi uno per uno', '')
  for (const r of results) out.push(caseSection(r))
  return out.join('\n')
}
