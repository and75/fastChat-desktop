// Il ruolo nella scheda «Modello»: con chi si parla, come cambiarlo, e i suoi parametri nelle quattro sezioni
// fisse (docs/ruoli.md §3.2). Ogni scelta aggiorna le istruzioni per il modello e, se l'opzione lo dichiara,
// la mente.
import { useEffect, useRef, useState } from 'react'
import { fmtInt, fmtNum, t } from '@shared/i18n'
import { orderedParameters, pickProfile, resolveChoices, ROLE_SECTIONS, type RoleMindSettings, type RoleOption, type RoleParameter } from '@shared/roles'
import { GENERALIST_ROLE_ID, type Conversation, type RoleRecord } from '@shared/types'
import { useChat } from '../store/useChat'
import { useConversations } from '../store/useConversations'
import { definitionOf, findRole, languageTag, roleDescription, roleName, useRoles } from '../store/useRoles'
import { DialogClose } from './IconButton'

/** Ciò che un'opzione fa alla mente, in parole: «imposta la temperatura a 0,3». */
export function describeEffect(mind: RoleMindSettings | undefined): string {
  if (!mind) return ''
  const parts: string[] = []
  if (mind.temperature !== undefined) parts.push(t('role.effect.temperature', { value: fmtNum(mind.temperature, 2) }))
  if (mind.topP !== undefined) parts.push(t('role.effect.topP', { value: fmtNum(mind.topP, 2) }))
  if (mind.style !== undefined) parts.push(t('role.effect.style', { value: t(`style.${mind.style}`) }))
  if (mind.think !== undefined) parts.push(t(mind.think ? 'role.effect.think.on' : 'role.effect.think.off'))
  if (mind.planMode !== undefined) parts.push(t(mind.planMode ? 'role.effect.plan.on' : 'role.effect.plan.off'))
  if (mind.numCtx !== undefined) parts.push(t('role.effect.numCtx', { value: fmtInt(mind.numCtx) }))
  return parts.join(' · ')
}

const selectClass = 'w-full min-w-0 rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-[13px] dark:border-zinc-700 dark:bg-zinc-900'

function Parameter({ parameter, chosen, onChoose }: { parameter: RoleParameter; chosen: string | string[]; onChoose(value: string | string[]): void }): React.JSX.Element {
  const active = parameter.options.filter((o) => (Array.isArray(chosen) ? chosen.includes(o.id) : chosen === o.id))
  const effect = active.map((o) => describeEffect(o.mind)).filter(Boolean).join(' · ')
  const note = effect && (
    <span className="col-start-2 -mt-1 text-[11.5px] text-brand-700 dark:text-brand-300" data-testid="role-effect">
      {effect}
    </span>
  )

  if (parameter.type === 'multi') {
    const list = Array.isArray(chosen) ? chosen : []
    const toggle = (o: RoleOption): void => onChoose(list.includes(o.id) ? list.filter((id) => id !== o.id) : [...list, o.id])
    return (
      <div className="flex flex-col gap-1.5" role="group" aria-label={parameter.label} data-testid="role-parameter" data-parameter={parameter.id}>
        <span className="text-[13px] text-zinc-700 dark:text-zinc-300">{parameter.label}</span>
        <div className="flex flex-wrap gap-1.5">
          {parameter.options.map((o) => {
            const on = list.includes(o.id)
            return (
              <button
                key={o.id}
                type="button"
                aria-pressed={on}
                title={describeEffect(o.mind) || undefined}
                onClick={() => toggle(o)}
                className={
                  'rounded-full border px-2.5 py-0.5 text-xs transition-colors ' +
                  (on
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800')
                }
              >
                {o.label}
              </button>
            )
          })}
        </div>
        {effect && (
          <span className="text-[11.5px] text-brand-700 dark:text-brand-300" data-testid="role-effect">
            {effect}
          </span>
        )}
      </div>
    )
  }

  if (parameter.type === 'toggle') {
    const on = chosen === 'on'
    return (
      <div className="grid grid-cols-[minmax(0,7.5rem)_1fr] items-center gap-x-2 gap-y-1.5" data-testid="role-parameter" data-parameter={parameter.id}>
        <span className="text-[13px] text-zinc-700 dark:text-zinc-300">{parameter.label}</span>
        <label className="relative flex cursor-pointer items-center justify-end">
          <input type="checkbox" role="switch" aria-label={parameter.label} className="peer sr-only" checked={on} onChange={(e) => onChoose(e.target.checked ? 'on' : 'off')} />
          <span aria-hidden className={'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 ' + (on ? 'bg-brand-600' : 'bg-zinc-300 dark:bg-zinc-700')}>
            <span className={'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ' + (on ? 'left-4.5' : 'left-0.5')} />
          </span>
        </label>
        {note}
      </div>
    )
  }

  return (
    <label className="grid grid-cols-[minmax(0,7.5rem)_1fr] items-center gap-x-2 gap-y-1.5" data-testid="role-parameter" data-parameter={parameter.id}>
      <span className="text-[13px] text-zinc-700 dark:text-zinc-300">{parameter.label}</span>
      <select aria-label={parameter.label} className={selectClass} value={typeof chosen === 'string' ? chosen : ''} onChange={(e) => onChoose(e.target.value)}>
        {parameter.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {note}
    </label>
  )
}

/**
 * Cambio di ruolo a conversazione avviata (D23): il ruolo non si cambia, si apre una nuova conversazione con il
 * nuovo ruolo, che può partire dal riassunto di questa.
 */
function RoleChangeDialog({ conversation, current, target, onClose }: { conversation: Conversation; current: string; target: RoleRecord; onClose(): void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const create = useConversations((s) => s.create)
  const messages = useChat((s) => s.messages.length)
  const [carry, setCarry] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const name = roleName(target)

  const option = (value: boolean, title: string, hint: string): React.JSX.Element => (
    <label
      className={
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ' +
        (carry === value ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/40' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900')
      }
    >
      <input type="radio" name="role-change" className="mt-1 accent-brand-600" checked={carry === value} onChange={() => setCarry(value)} />
      <span className="flex flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{hint}</span>
      </span>
    </label>
  )

  return (
    <dialog
      ref={dialog}
      aria-label={t('role.change.title')}
      data-testid="role-change-dialog"
      onClose={onClose}
      className="m-auto w-[32rem] max-w-[92vw] rounded-xl border border-zinc-200 bg-white p-0 text-sm text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start gap-3">
          <h2 className="text-base font-semibold">{t('role.change.title')}</h2>
          <DialogClose onClose={onClose} />
        </div>
        <p className="leading-relaxed text-zinc-600 dark:text-zinc-300">{t('role.change.body', { current, target: name })}</p>
        {option(true, t('role.change.carry'), t('role.change.carry.hint', { count: messages }))}
        {option(false, t('role.change.fresh'), t('role.change.fresh.hint'))}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="role-change-confirm"
            className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-60"
            onClick={async () => {
              setBusy(true)
              const ok = await create({ roleId: target.id, ...(carry ? { carryFrom: conversation.id } : {}) })
              setBusy(false)
              if (ok) onClose()
            }}
          >
            {busy && carry ? t('role.change.summarizing') : t('role.change.confirm', { target: name })}
          </button>
        </div>
      </div>
    </dialog>
  )
}

/** Con chi si parla, e come cambiarlo. */
function RoleCard({ conversation, role, missing }: { conversation: Conversation; role: RoleRecord | null; missing: boolean }): React.JSX.Element {
  const roles = useRoles((s) => s.roles)
  const setRole = useRoles((s) => s.setRole)
  const started = useChat((s) => s.messages.length > 0)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<RoleRecord | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const currentId = role?.id ?? (missing ? conversation.roleId : GENERALIST_ROLE_ID)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (next: RoleRecord): void => {
    setOpen(false)
    // A conversazione vuota il ruolo cambia subito; altrimenti si propone una nuova conversazione.
    if (started) setTarget(next)
    else void setRole(conversation.id, next.id)
  }

  return (
    <div ref={root} className="relative rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 dark:border-brand-900 dark:bg-brand-950/40" data-testid="role-card">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-semibold leading-snug" data-testid="role-name">
          {roleName(role)}
        </span>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="role-change"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {t('role.change')}
        </button>
      </div>
      <p className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">{roleDescription(role)}</p>
      {open && (
        <div role="menu" data-testid="role-picker" className="absolute inset-x-0 top-full z-40 mt-1 flex max-h-72 flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {roles
            .filter((r) => r.id !== currentId)
            .map((r) => {
              const tag = languageTag(roles, r)
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  data-role={r.id}
                  onClick={() => pick(r)}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-brand-50 focus:bg-brand-50 focus:outline-none dark:hover:bg-brand-950/60 dark:focus:bg-brand-950/60"
                >
                  <span className="truncate">{roleName(r)}</span>
                  {tag && <span className="shrink-0 rounded border border-zinc-300 px-1 text-[10.5px] text-zinc-500 dark:border-zinc-600">{tag}</span>}
                </button>
              )
            })}
          {roles.length <= 1 && <p className="px-2 py-1.5 text-xs text-zinc-500">{t('role.noOthers')}</p>}
        </div>
      )}
      {target && <RoleChangeDialog conversation={conversation} current={roleName(role)} target={target} onClose={() => setTarget(null)} />}
    </div>
  )
}

const warnClass = 'rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs leading-snug text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'

/** Ruolo della conversazione e suoi parametri. Per il Generalista resta solo l'intestazione. */
export function RolePanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const roles = useRoles((s) => s.roles)
  const loaded = useRoles((s) => s.roles.length > 0)
  const refresh = useRoles((s) => s.refresh)
  const choose = useRoles((s) => s.choose)
  const error = useRoles((s) => s.error)
  const role = findRole(roles, conversation)
  const definition = definitionOf(roles, conversation)
  const missing = loaded && !role && !!conversation.roleId && conversation.roleId !== GENERALIST_ROLE_ID

  useEffect(() => {
    void refresh()
  }, [refresh])

  const choices = resolveChoices(definition, conversation.roleParams)
  const parameters = orderedParameters(definition)
  const { verified } = pickProfile(definition, conversation.model)
  const recommended = definition.mind?.model

  return (
    <section className="mb-3 flex flex-col gap-2.5" aria-label={t('role.section')} data-testid="role-panel">
      <RoleCard conversation={conversation} role={role} missing={missing} />
      {missing && (
        <p className={warnClass} data-testid="role-missing">
          {t('role.missing')}
        </p>
      )}
      {role && !verified && conversation.model && (
        <p className={warnClass} data-testid="role-unverified">
          {t('role.unverified', { model: conversation.model })}
          {recommended && recommended !== conversation.model ? ' ' + t('role.recommended', { model: recommended }) : ''}
        </p>
      )}
      {error && <p className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      {ROLE_SECTIONS.map((section) => {
        const own = parameters.filter((p) => p.section === section)
        if (own.length === 0) return null
        return (
          <div key={section} className="flex flex-col gap-2 border-t border-zinc-200 pt-2.5 dark:border-zinc-800" data-testid="role-section" data-section={section}>
            <h3 className="text-[13px] font-semibold">{t(`role.section.${section}`)}</h3>
            {own.map((p) => (
              <Parameter key={p.id} parameter={p} chosen={choices[p.id]} onChoose={(value) => void choose(conversation.id, p.id, value)} />
            ))}
          </div>
        )
      })}
    </section>
  )
}
