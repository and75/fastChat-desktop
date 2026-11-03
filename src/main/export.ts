import { buildSystemPrompt, formatPlan } from '@shared/prompt'
import type { Conversation, Message, Plan } from '@shared/types'

export type ExportFormat = 'md' | 'json'

export interface ExportData {
  conversation: Conversation
  messages: Message[]
  plans: Plan[]
}

const PLAN_STATUS: Record<Plan['status'], string> = {
  proposed: 'proposto',
  approved: 'approvato',
  rejected: 'annullato',
  executed: 'eseguito'
}

const iso = (ts: number): string => new Date(ts).toISOString()

/** Esporta in Markdown: intestazione, brief, impostazioni, poi i messaggi con piani e ragionamento. */
export function toMarkdown({ conversation: c, messages, plans }: ExportData): string {
  const out: string[] = [`# ${c.title}`, '']
  out.push(
    `- Modello: ${c.model || '—'}`,
    `- Temperatura: ${c.temperature}`,
    `- Ragionamento: ${c.think ? 'sì' : 'no'}`,
    `- Plan mode: ${c.planMode ? 'sì' : 'no'}`,
    `- Creata: ${iso(c.createdAt)}`,
    `- Aggiornata: ${iso(c.updatedAt)}`,
    ''
  )

  const brief = buildSystemPrompt(c)
  if (brief) {
    // Le sezioni del brief scendono di due livelli, sotto "## Brief".
    out.push('## Brief', '', brief.replace(/^# /gm, '### '), '')
  }

  out.push('## Conversazione', '')
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(`### Utente · ${iso(m.createdAt)}`, '', m.content, '')
      for (const p of plans.filter((p) => p.userMessageId === m.id)) {
        out.push(`#### Piano (${PLAN_STATUS[p.status]})`, '', formatPlan(p.steps), '')
      }
    } else {
      out.push(`### Assistente${m.model ? ` (${m.model})` : ''} · ${iso(m.createdAt)}`, '')
      if (m.thinking) {
        out.push('<details>', '<summary>Ragionamento</summary>', '', m.thinking.trim(), '', '</details>', '')
      }
      out.push(m.content, '')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export function toJson(data: ExportData): string {
  return JSON.stringify({ format: 'fastchat-conversation', version: 1, exportedAt: new Date().toISOString(), ...data }, null, 2)
}

/** Nome file suggerito: titolo ripulito dai caratteri non ammessi nei nomi di file. */
export function suggestedFileName(title: string, format: ExportFormat): string {
  const base =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'conversazione'
  return `${base}.${format}`
}
