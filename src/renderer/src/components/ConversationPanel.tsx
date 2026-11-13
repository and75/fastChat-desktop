import { useEffect, useRef, useState } from 'react'
import { fmtInt, t } from '@shared/i18n'
import { buildStyleSection, charsPerToken, situationSection } from '@shared/prompt'
import { roleInstructions, situationLimit } from '@shared/roles'
import { resolveSettings } from '@shared/settings'
import { DEFAULT_CONTEXT_SETTINGS, DEFAULT_TITLE, type Conversation } from '@shared/types'
import { useChat } from '../store/useChat'
import { useModels } from '../store/useModels'
import { definitionOf, useRoles } from '../store/useRoles'
import { useConversations } from '../store/useConversations'
import { useTemplates } from '../store/useTemplates'
import { registerPendingSave } from '../store/pendingSaves'
import { documentCount, useKnowledge } from '../store/useKnowledge'
import { BookOpenIcon, BrainIcon, IdCardIcon } from './icons'
import { KnowledgePanel } from './KnowledgePanel'
import { ModelSettings, PlanModeToggle } from './ModelSettings'
import { RolePanel } from './RolePanel'

/** "Salva come template": nome inline (window.prompt non esiste in Electron). */
function SaveAsTemplate({ conversation, beforeSave }: { conversation: Conversation; beforeSave(): Promise<void> }): React.JSX.Element {
  const saveFrom = useTemplates((s) => s.saveFrom)
  const error = useTemplates((s) => s.error)
  const [name, setName] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (name === null) {
    return (
      <div className="mt-4 flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => {
            setSaved(false)
            setName(conversation.title === DEFAULT_TITLE ? '' : conversation.title)
          }}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {t('brief.saveTemplate')}
        </button>
        {saved && <span className="text-brand-700 dark:text-brand-400">{t('brief.templateSaved')}</span>}
      </div>
    )
  }

  return (
    <form
      className="mt-4 flex flex-col gap-2 text-sm"
      onSubmit={async (e) => {
        e.preventDefault()
        await beforeSave()
        if (await saveFrom(conversation.id, name)) {
          setName(null)
          setSaved(true)
        }
      }}
    >
      <input
        autoFocus
        aria-label={t('brief.templateName')}
        placeholder={t('brief.templateName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error && <span className="text-red-700 dark:text-red-400">{error}</span>}
      <div className="flex gap-2">
        <button type="submit" disabled={!name.trim()} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-40">
          {t('common.save')}
        </button>
        <button type="button" onClick={() => setName(null)} className="rounded-lg px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

type PanelTab = 'model' | 'situation' | 'knowledge'
const PANEL_TABS: PanelTab[] = ['model', 'situation', 'knowledge']
const TAB_KEY = 'fastchat.panelTab'

/** Scheda del pannello, ricordata tra una conversazione e l'altra e dopo il riavvio. */
function usePanelTab(): [PanelTab, (t: PanelTab) => void] {
  const [tab, setTab] = useState<PanelTab>(() => {
    try {
      // «brief» è il nome che la scheda Situazione aveva prima dei ruoli.
      const saved = localStorage.getItem(TAB_KEY)?.replace(/^brief$/, 'situation') as PanelTab | undefined
      return saved && PANEL_TABS.includes(saved) ? saved : 'model'
    } catch {
      return 'model'
    }
  })
  const choose = (t: PanelTab): void => {
    setTab(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* storage non disponibile: la scelta vale solo per questa sessione */
    }
  }
  return [tab, choose]
}

/**
 * Scheda «Situazione»: il contesto di questa conversazione, scritto dall'utente. Si salva da sola (debounce) e
 * vale dal messaggio successivo. Il limite è una quota della memoria del modello (D21): un testo già più lungo
 * resta com'è, ma non si può allungare.
 */
function SituationTab({ conversation, draft, saved, onChange, onFlush }: { conversation: Conversation; draft: string; saved: boolean; onChange(value: string): void; onFlush(): Promise<void> }): React.JSX.Element {
  const caps = useModels((s) => s.capabilities[conversation.model])
  const share = useModels((s) => s.settings?.context?.situationShare ?? DEFAULT_CONTEXT_SETTINGS.situationShare)
  const messages = useChat((s) => s.messages)
  const roles = useRoles((s) => s.roles)
  const limit = situationLimit(resolveSettings(conversation, caps).numCtx, share, charsPerToken(messages))
  const over = draft.length > limit

  const instructions = roleInstructions(definitionOf(roles, conversation), conversation.roleParams)
  const situation = situationSection(draft, !!instructions)
  // Ciò che segue le istruzioni del ruolo nel prompt: la situazione, poi lo stile della risposta.
  const rest = [situation, buildStyleSection(conversation.style)].filter(Boolean).join('\n\n')

  return (
    <>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-xs leading-snug text-zinc-500">{t('situation.intro')}</p>
        <span className="shrink-0 text-xs text-zinc-400" data-testid="situation-status">
          {saved ? t('brief.saved') : t('brief.saving')}
        </span>
      </div>
      <textarea
        rows={8}
        aria-label={t('situation.title')}
        value={draft}
        placeholder={t('situation.placeholder')}
        onChange={(e) => {
          // Oltre il limite si può solo accorciare.
          const next = e.target.value
          if (next.length <= limit || next.length < draft.length) onChange(next)
        }}
        onBlur={() => void onFlush()}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        data-testid="situation-text"
      />
      <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800" aria-hidden>
        <div className={'h-full ' + (over ? 'bg-red-600' : 'bg-brand-600')} style={{ width: `${Math.min(100, limit > 0 ? (draft.length / limit) * 100 : 0)}%` }} />
      </div>
      <div className={'mt-1 flex justify-between text-xs ' + (over ? 'text-red-700 dark:text-red-400' : 'text-zinc-500')}>
        <span data-testid="situation-count">{t('situation.count', { used: fmtInt(draft.length), limit: fmtInt(limit) })}</span>
        <span>{t('situation.share', { share: Math.round(share * 100) })}</span>
      </div>
      {over && (
        <p className="mt-1 text-xs leading-snug text-red-700 dark:text-red-400" data-testid="situation-over">
          {t('situation.over')}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <PlanModeToggle conversation={conversation} />
        <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{t('brief.planMode.hint')}</span>
      </div>
      <SaveAsTemplate conversation={conversation} beforeSave={onFlush} />

      <details className="mt-4 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800" open>
        <summary className="cursor-pointer text-[13px] font-semibold">{t('situation.preview')}</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900" data-testid="system-preview">
          {instructions && <span className="text-brand-700 dark:text-brand-300">{instructions}</span>}
          {instructions && rest ? '\n\n' : ''}
          {rest}
          {!instructions && !rest && t('brief.preview.empty')}
        </pre>
        {instructions && <p className="mt-1 text-xs leading-snug text-zinc-500">{t('situation.preview.hint')}</p>}
      </details>
    </>
  )
}

/** Pannello della conversazione: Modello (ruolo, parametri, mente), Situazione, Conoscenza. */
export function ConversationPanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const [draft, setDraft] = useState<string>(() => conversation.situation ?? '')
  const [saved, setSaved] = useState(true)
  const dirty = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const convId = conversation.id

  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const flush = async (): Promise<void> => {
    clearTimeout(timer.current)
    const situation = dirty.current
    dirty.current = null
    if (situation === null) return
    await update(convId, { situation })
    setSaved(true)
  }
  flushRef.current = flush

  // Cambio conversazione: salva le modifiche in sospeso della precedente e ricarica la situazione.
  useEffect(() => {
    setDraft(conversation.situation ?? '')
    setSaved(true)
    // La situazione va scritta anche prima di un invio immediato.
    const unregister = registerPendingSave(() => flushRef.current())
    return () => {
      unregister()
      void flushRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  const change = (value: string): void => {
    setDraft(value)
    dirty.current = value
    setSaved(false)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }

  const [tab, setTab] = usePanelTab()
  const documents = useKnowledge((s) => documentCount(s.status[conversation.id]))

  const tabs: Array<{ id: PanelTab; label: string; icon: React.ReactNode; filled?: boolean }> = [
    { id: 'model', label: t('brief.tab.model'), icon: <BrainIcon /> },
    { id: 'situation', label: t('situation.title'), icon: <IdCardIcon />, filled: draft.trim() !== '' },
    { id: 'knowledge', label: t('brief.tab.knowledge'), icon: <BookOpenIcon />, filled: documents > 0 }
  ]

  return (
    <aside id="conversation-panel" className="flex w-80 shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800" data-testid="conversation-panel">
      <div
        role="tablist"
        aria-label={t('brief.panel')}
        className="flex shrink-0 border-b border-zinc-200 px-2 dark:border-zinc-800"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const i = PANEL_TABS.indexOf(tab)
          const next = PANEL_TABS[(i + (e.key === 'ArrowRight' ? 1 : PANEL_TABS.length - 1)) % PANEL_TABS.length]
          setTab(next)
          document.getElementById(`panel-tab-${next}`)?.focus()
        }}
      >
        {tabs.map((tab_) => {
          const active = tab === tab_.id
          return (
            <button
              key={tab_.id}
              type="button"
              role="tab"
              id={`panel-tab-${tab_.id}`}
              aria-selected={active}
              aria-controls={`panel-${tab_.id}`}
              aria-label={tab_.filled ? t('brief.tab.filled', { label: tab_.label }) : tab_.label}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(tab_.id)}
              className={
                '-mb-px flex min-w-0 flex-auto items-center justify-center gap-1 border-b-2 px-1 py-2.5 text-[13px] font-medium transition-colors ' +
                (active
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')
              }
            >
              {tab_.icon}
              <span className="truncate">{tab_.label}</span>
              {tab_.filled && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" data-testid="tab-filled" />}
            </button>
          )
        })}
      </div>

      {/* Tutte le schede restano montate: salvataggi in sospeso e stato locale non si perdono. */}
      <div
        role="tabpanel"
        id="panel-model"
        aria-labelledby="panel-tab-model"
        hidden={tab !== 'model'}
        className="relative min-h-0 flex-1 overflow-y-auto p-4"
      >
        <RolePanel conversation={conversation} />
        <ModelSettings conversation={conversation} />
      </div>

      <div
        role="tabpanel"
        id="panel-situation"
        aria-labelledby="panel-tab-situation"
        hidden={tab !== 'situation'}
        className="relative min-h-0 flex-1 overflow-y-auto p-4"
      >
        <SituationTab conversation={conversation} draft={draft} saved={saved} onChange={change} onFlush={flush} />
      </div>

      <div
        role="tabpanel"
        id="panel-knowledge"
        aria-labelledby="panel-tab-knowledge"
        hidden={tab !== 'knowledge'}
        className="relative min-h-0 flex-1 overflow-y-auto p-4"
      >
        <KnowledgePanel conversation={conversation} />
      </div>
    </aside>
  )
}
