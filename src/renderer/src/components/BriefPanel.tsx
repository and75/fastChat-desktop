import { useEffect, useRef, useState } from 'react'
import { buildSystemPrompt } from '@shared/prompt'
import type { Brief, Conversation } from '@shared/types'
import { useConversations } from '../store/useConversations'
import { ModelSettings } from './ModelSettings'

const FIELDS: Array<{ key: keyof Brief; label: string; placeholder: string; rows: number }> = [
  { key: 'role', label: 'Ruolo', placeholder: 'Es. Sei un revisore di codice TypeScript esperto.', rows: 2 },
  { key: 'context', label: 'Contesto', placeholder: 'Progetto, pubblico, informazioni di sfondo…', rows: 4 },
  { key: 'goals', label: 'Obiettivi', placeholder: 'Cosa deve ottenere questa conversazione.', rows: 3 },
  { key: 'constraints', label: 'Vincoli', placeholder: 'Es. Rispondi sempre in italiano, massimo 5 frasi.', rows: 3 }
]

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

  const flush = (): void => {
    clearTimeout(timer.current)
    const patch = dirty.current
    dirty.current = {}
    if (Object.keys(patch).length === 0) return
    void update(convId, patch).then(() => setSaved(true))
  }

  // Cambio conversazione: salva le modifiche in sospeso della precedente e ricarica il brief.
  useEffect(() => {
    setDraft(pickBrief(conversation))
    setSaved(true)
    return flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  const change = (key: keyof Brief, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }))
    dirty.current[key] = value
    setSaved(false)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }

  const preview = buildSystemPrompt(draft)

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800" data-testid="brief-panel">
      <h2 className="mb-3 font-semibold">Modello</h2>
      <ModelSettings conversation={conversation} />
      <hr className="my-4 border-zinc-200 dark:border-zinc-800" />
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">Brief</h2>
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
              onBlur={flush}
              className="resize-y rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        ))}
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-zinc-500">Anteprima system prompt</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900" data-testid="system-preview">
          {preview || '(vuoto: nessun system prompt)'}
        </pre>
      </details>
    </aside>
  )
}
