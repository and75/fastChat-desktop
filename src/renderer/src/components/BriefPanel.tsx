import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { buildSystemPrompt } from '@shared/prompt'
import { DEFAULT_TITLE, type Brief, type Conversation } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { useTemplates } from '../store/useTemplates'
import { registerPendingSave } from '../store/pendingSaves'
import { useKnowledge } from '../store/useKnowledge'
import { BookOpenIcon, BrainIcon, IdCardIcon } from './icons'
import { KnowledgePanel } from './KnowledgePanel'
import { ModelSettings, PlanModeToggle } from './ModelSettings'

const FIELDS: Array<{ key: keyof Brief; rows: number }> = [
  { key: 'role', rows: 2 },
  { key: 'context', rows: 4 },
  { key: 'goals', rows: 3 },
  { key: 'constraints', rows: 3 }
]

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

type PanelTab = 'model' | 'brief' | 'knowledge'
const PANEL_TABS: PanelTab[] = ['model', 'brief', 'knowledge']
const TAB_KEY = 'fastchat.panelTab'

/** Scheda del pannello, ricordata tra una conversazione e l'altra e dopo il riavvio. */
function usePanelTab(): [PanelTab, (t: PanelTab) => void] {
  const [tab, setTab] = useState<PanelTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY) as PanelTab | null
      return saved && PANEL_TABS.includes(saved) ? saved : 'brief'
    } catch {
      return 'brief'
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

const pickBrief = (c: Conversation): Brief => ({
  role: c.role,
  context: c.context,
  goals: c.goals,
  constraints: c.constraints
})

/** Pannello del brief: le modifiche si salvano da sole (debounce) e valgono dal messaggio successivo. */
export function BriefPanel({ conversation }: { conversation: Conversation }): React.JSX.Element {
  const update = useConversations((s) => s.update)
  const [draft, setDraft] = useState<Brief>(() => pickBrief(conversation))
  const [saved, setSaved] = useState(true)
  const dirty = useRef<Partial<Brief>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const convId = conversation.id

  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const flush = async (): Promise<void> => {
    clearTimeout(timer.current)
    const patch = dirty.current
    dirty.current = {}
    if (Object.keys(patch).length === 0) return
    await update(convId, patch)
    setSaved(true)
  }
  flushRef.current = flush

  // Cambio conversazione: salva le modifiche in sospeso della precedente e ricarica il brief.
  useEffect(() => {
    setDraft(pickBrief(conversation))
    setSaved(true)
    // Le modifiche al brief vanno scritte anche prima di un invio immediato.
    const unregister = registerPendingSave(() => flushRef.current())
    return () => {
      unregister()
      void flushRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  const change = (key: keyof Brief, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    dirty.current[key] = value
    setSaved(false)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }

  const preview = buildSystemPrompt(draft, conversation.style)
  const [tab, setTab] = usePanelTab()
  const documents = useKnowledge((s) => s.status[conversation.id]?.documents.length ?? 0)

  const tabs: Array<{ id: PanelTab; label: string; icon: React.ReactNode; filled?: boolean }> = [
    { id: 'model', label: t('brief.tab.model'), icon: <BrainIcon /> },
    { id: 'brief', label: t('brief.tab.brief'), icon: <IdCardIcon />, filled: preview !== '' },
    { id: 'knowledge', label: t('brief.tab.knowledge'), icon: <BookOpenIcon />, filled: documents > 0 }
  ]

  return (
    <aside
      id="conversation-panel"
      className="flex w-80 shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800"
      data-testid="brief-panel"
    >
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
                '-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors ' +
                (active
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')
              }
            >
              {tab_.icon}
              <span className="truncate">{tab_.label}</span>
              {tab_.filled && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-500" data-testid="brief-filled" />}
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
        <ModelSettings conversation={conversation} />
      </div>

      <div
        role="tabpanel"
        id="panel-brief"
        aria-labelledby="panel-tab-brief"
        hidden={tab !== 'brief'}
        className="relative min-h-0 flex-1 overflow-y-auto p-4"
      >
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-xs text-zinc-500">{t('brief.sentAsSystem')}</p>
          <span className="text-xs text-zinc-400" data-testid="brief-status">
            {saved ? t('brief.saved') : t('brief.saving')}
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{t(`brief.${f.key}`)}</span>
              <textarea
                rows={f.rows}
                value={draft[f.key]}
                placeholder={t(`brief.${f.key}.placeholder`)}
                onChange={(e) => change(f.key, e.target.value)}
                onBlur={() => void flush()}
                className="resize-y rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <PlanModeToggle conversation={conversation} />
          <span className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
            {t('brief.planMode.hint')}
          </span>
        </div>
        <SaveAsTemplate conversation={conversation} beforeSave={flush} />
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-zinc-500">{t('brief.preview')}</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900" data-testid="system-preview">
            {preview || t('brief.preview.empty')}
          </pre>
        </details>
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
