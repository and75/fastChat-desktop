import { useEffect, useRef, useState } from 'react'
import { buildSystemPrompt } from '@shared/prompt'
import type { Brief, Conversation } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { useTemplates } from '../store/useTemplates'
import { registerPendingSave } from '../store/pendingSaves'
import { BrainIcon, IdCardIcon } from './icons'
import { ModelSettings } from './ModelSettings'

const FIELDS: Array<{ key: keyof Brief; label: string; placeholder: string; rows: number }> = [
  { key: 'role', label: 'Ruolo', placeholder: 'Es. Sei un revisore di codice TypeScript esperto.', rows: 2 },
  { key: 'context', label: 'Contesto', placeholder: 'Progetto, pubblico, informazioni di sfondo…', rows: 4 },
  { key: 'goals', label: 'Obiettivi', placeholder: 'Cosa deve ottenere questa conversazione.', rows: 3 },
  { key: 'constraints', label: 'Vincoli', placeholder: 'Es. Rispondi sempre in italiano, massimo 5 frasi.', rows: 3 }
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
            setName(conversation.title === 'Nuova conversazione' ? '' : conversation.title)
          }}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Salva come template
        </button>
        {saved && <span className="text-brand-700 dark:text-brand-400">Template salvato</span>}
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
        aria-label="Nome del template"
        placeholder="Nome del template"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error && <span className="text-red-700 dark:text-red-400">{error}</span>}
      <div className="flex gap-2">
        <button type="submit" disabled={!name.trim()} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-40">
          Salva
        </button>
        <button type="button" onClick={() => setName(null)} className="rounded-lg px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          Annulla
        </button>
      </div>
    </form>
  )
}

type PanelTab = 'model' | 'brief'
const TAB_KEY = 'fastchat.panelTab'

/** Scheda del pannello, ricordata tra una conversazione e l'altra e dopo il riavvio. */
function usePanelTab(): [PanelTab, (t: PanelTab) => void] {
  const [tab, setTab] = useState<PanelTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'model' ? 'model' : 'brief'
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

  const tabs: Array<{ id: PanelTab; label: string; icon: React.ReactNode; filled?: boolean }> = [
    { id: 'model', label: 'Modello', icon: <BrainIcon /> },
    { id: 'brief', label: 'Brief', icon: <IdCardIcon />, filled: preview !== '' }
  ]

  return (
    <aside
      id="conversation-panel"
      className="flex w-80 shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800"
      data-testid="brief-panel"
    >
      <div
        role="tablist"
        aria-label="Pannello della conversazione"
        className="flex shrink-0 border-b border-zinc-200 px-2 dark:border-zinc-800"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const next = tab === 'model' ? 'brief' : 'model'
          setTab(next)
          document.getElementById(`panel-tab-${next}`)?.focus()
        }}
      >
        {tabs.map((t) => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`panel-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`panel-${t.id}`}
              aria-label={t.filled ? `${t.label} (compilato)` : t.label}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={
                '-mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ' +
                (active
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200')
              }
            >
              {t.icon}
              <span>{t.label}</span>
              {t.filled && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-500" data-testid="brief-filled" />}
            </button>
          )
        })}
      </div>

      {/* Entrambe le schede restano montate: salvataggi in sospeso e stato locale non si perdono. */}
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
          <p className="text-xs text-zinc-500">Inviato al modello come system prompt.</p>
          <span className="text-xs text-zinc-400" data-testid="brief-status">
            {saved ? 'Salvato' : 'Modifiche…'}
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{f.label}</span>
              <textarea
                rows={f.rows}
                value={draft[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => change(f.key, e.target.value)}
                onBlur={() => void flush()}
                className="resize-y rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          ))}
        </div>
        <SaveAsTemplate conversation={conversation} beforeSave={flush} />
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-zinc-500">Anteprima system prompt</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900" data-testid="system-preview">
            {preview || '(vuoto: nessun system prompt)'}
          </pre>
        </details>
      </div>
    </aside>
  )
}
