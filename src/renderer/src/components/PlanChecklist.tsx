import { useState } from 'react'
import { t, tn } from '@shared/i18n'
import type { Plan, PlanStatus, PlanStep } from '@shared/types'
import { useChat } from '../store/useChat'
import { Elapsed, TypingDots } from './Loader'
import { ThinkingBlock } from './ThinkingBlock'

const statusLabel = (s: PlanStatus): string => t(`plan.status.${s}`)

type KeyedStep = PlanStep & { key: number }
let nextKey = 1

const iconBtn =
  'rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-700 dark:hover:text-zinc-100'

/** Checklist del piano proposto: si modifica, si riordina, poi si approva (ed esegue), si rigenera o si annulla. */
export function PlanChecklist({ plan, busy }: { plan: Plan; busy: boolean }): React.JSX.Element {
  const { approvePlan, regeneratePlan, rejectPlan } = useChat()
  // Ogni passo ha una chiave stabile: riordinando, React non confonde i campi in modifica.
  const [steps, setSteps] = useState<KeyedStep[]>(() => plan.steps.map((s) => ({ ...s, key: nextKey++ })))
  const valid = steps.some((s) => s.title.trim())

  const edit = (i: number, patch: Partial<PlanStep>): void =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i: number, delta: number): void =>
    setSteps((list) => {
      const next = [...list]
      const [item] = next.splice(i, 1)
      next.splice(i + delta, 0, item)
      return next
    })
  const remove = (i: number): void => setSteps((list) => list.filter((_, j) => j !== i))

  return (
    <section
      aria-label={t('plan.proposed')}
      data-testid="plan-checklist"
      className="rounded-xl border border-brand-300 bg-brand-50/60 p-3 dark:border-brand-800/70 dark:bg-brand-950/20"
    >
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold text-brand-900 dark:text-brand-200">{t('plan.proposed')}</h3>
        <span className="text-xs text-brand-800/70 dark:text-brand-300/70">{t('plan.editHint')}</span>
      </header>

      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li
            key={step.key}
            data-testid="plan-step"
            className="flex gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <span className="mt-1 w-5 shrink-0 text-right text-sm font-semibold text-zinc-400">{i + 1}.</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                aria-label={t('plan.stepTitle', { n: i + 1 })}
                value={step.title}
                placeholder={t('plan.stepTitle.placeholder')}
                disabled={busy}
                onChange={(e) => edit(i, { title: e.target.value })}
                className="rounded border border-transparent bg-transparent px-1 font-medium hover:border-zinc-200 focus:border-brand-500 focus:outline-none dark:hover:border-zinc-700"
              />
              <textarea
                aria-label={t('plan.stepDetail', { n: i + 1 })}
                value={step.detail}
                placeholder={t('plan.stepDetail.placeholder')}
                rows={Math.max(1, Math.ceil(step.detail.length / 70))}
                disabled={busy}
                onChange={(e) => edit(i, { detail: e.target.value })}
                className="resize-none rounded border border-transparent bg-transparent px-1 text-sm text-zinc-600 hover:border-zinc-200 focus:border-brand-500 focus:outline-none dark:text-zinc-400 dark:hover:border-zinc-700"
              />
            </div>
            <div className="flex shrink-0 flex-col items-center text-sm">
              <button type="button" className={iconBtn} title={t('plan.moveUp')} aria-label={t('plan.moveUp.step', { n: i + 1 })} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                className={iconBtn}
                title={t('plan.moveDown')}
                aria-label={t('plan.moveDown.step', { n: i + 1 })}
                disabled={busy || i === steps.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button type="button" className={iconBtn} title={t('plan.removeStep')} aria-label={t('plan.removeStep.step', { n: i + 1 })} disabled={busy} onClick={() => remove(i)}>
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>

      <button
        type="button"
        disabled={busy || steps.length >= 20}
        onClick={() => setSteps((list) => [...list, { title: '', detail: '', key: nextKey++ }])}
        className="mt-2 text-sm text-brand-900 hover:underline disabled:opacity-40 dark:text-brand-200"
      >
        {t('plan.addStep')}
      </button>

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() =>
            void approvePlan(
              plan.id,
              steps.filter((s) => s.title.trim()).map(({ title, detail }) => ({ title, detail }))
            )
          }
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {plan.status === 'approved' ? t('plan.execute') : t('plan.approveExecute')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void regeneratePlan()}
          className="rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-200 disabled:opacity-40 dark:hover:bg-zinc-800"
        >
          {t('plan.regenerate')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void rejectPlan(plan.id)}
          className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {t('plan.cancel')}
        </button>
      </footer>
    </section>
  )
}

/** Piano già concluso (eseguito o annullato): riepilogo richiudibile. */
export function PlanSummary({ plan }: { plan: Plan }): React.JSX.Element {
  return (
    <details data-testid="plan-summary" className="rounded-lg border border-zinc-200 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
        {tn('plan.summary', plan.steps.length)}<span data-testid="plan-status">{statusLabel(plan.status)}</span>
      </summary>
      <ol className="list-decimal space-y-1 border-t border-zinc-200 py-2 pl-9 pr-3 dark:border-zinc-800">
        {plan.steps.map((s, i) => (
          <li key={i}>
            <span className="font-medium">{s.title}</span>
            {s.detail && <span className="text-zinc-500"> — {s.detail}</span>}
          </li>
        ))}
      </ol>
    </details>
  )
}

/** Mentre il modello prepara il piano: ragionamento (se c'è) e conteggio dei passi già arrivati. */
export function PlanLoading({
  thinking,
  content,
  startedAt,
  summarizing = false
}: {
  thinking: string
  content: string
  startedAt?: number
  /** I messaggi più vecchi vengono riassunti prima del piano. */
  summarizing?: boolean
}): React.JSX.Element {
  const found = (content.match(/"title"\s*:/g) ?? []).length
  return (
    <div className="flex flex-col gap-2" data-testid="plan-loading">
      {thinking && <ThinkingBlock text={thinking} live={!content} startedAt={startedAt} />}
      <div role="status" className="flex items-center gap-2 text-sm text-brand-800 dark:text-brand-300">
        <TypingDots />
        <span>
          {summarizing ? t('plan.loading.summarizing') : t('plan.loading')}
          {found > 0 && tn('plan.steps', found)}
        </span>
        <span aria-hidden>·</span>
        <Elapsed since={startedAt} />
      </div>
    </div>
  )
}
