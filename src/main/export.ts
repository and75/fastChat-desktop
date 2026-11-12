import { briefToSituation, formatPlan } from '@shared/prompt'
import { sourceLabel } from '@shared/knowledge'
import { t } from '@shared/i18n'
import type { Conversation, KnowledgeDocument, Message, Plan } from '@shared/types'

export type ExportFormat = 'md' | 'json'

export interface ExportData {
  conversation: Conversation
  messages: Message[]
  plans: Plan[]
  /** Documenti della base di conoscenza (assenti nelle esportazioni precedenti). */
  documents?: KnowledgeDocument[]
}

const planStatus = (s: Plan['status']): string => t(`md.status.${s}`)

const iso = (ts: number): string => new Date(ts).toISOString()

/** Esporta in Markdown: intestazione, brief, impostazioni, poi i messaggi con piani e ragionamento. */
export function toMarkdown({ conversation: c, messages, plans, documents = [] }: ExportData): string {
  const out: string[] = [`# ${c.title}`, '']
  out.push(
    `- ${t('md.model')}: ${c.model || '—'}`,
    `- ${t('md.temperature')}: ${c.temperature}`,
    `- ${t('md.reasoning')}: ${c.think ? t('md.yes') : t('md.no')}`,
    `- ${t('md.planMode')}: ${c.planMode ? t('md.yes') : t('md.no')}`,
    `- ${t('md.created')}: ${iso(c.createdAt)}`,
    `- ${t('md.updated')}: ${iso(c.updatedAt)}`,
    ''
  )

  // La situazione; per le conversazioni nate con il Brief sono i suoi quattro campi con i loro titoli.
  const brief = c.situation ?? briefToSituation(c)
  if (brief) {
    // Le sezioni del brief scendono di due livelli, sotto "## Brief".
    out.push(`## ${t('md.brief')}`, '', brief.replace(/^# /gm, '### '), '')
  }

  if (c.summary) out.push(`## ${t('md.summary')}`, '', c.summary, '')

  if (documents.length) {
    out.push(`## ${t('md.knowledge')}`, '')
    for (const d of documents) out.push(`- ${d.title} (${d.ref.kind === 'file' ? d.ref.path : d.ref.uri})${d.status === 'ready' ? '' : ` — ${d.status}`}`)
    out.push('')
  }

  out.push(`## ${t('md.conversation')}`, '')
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(`### ${t('md.user')} · ${iso(m.createdAt)}${m.knowledge == null ? '' : ` · ${t('md.knowledge')}: ${m.knowledge ? t('md.yes') : t('md.no')}`}`, '', m.content, '')
      for (const p of plans.filter((p) => p.userMessageId === m.id)) {
        out.push(`#### ${t('md.plan', { status: planStatus(p.status) })}`, '', formatPlan(p.steps), '')
      }
    } else {
      out.push(`### ${t('md.assistant')}${m.model ? ` (${m.model})` : ''} · ${iso(m.createdAt)}`, '')
      if (m.thinking) {
        out.push('<details>', `<summary>${t('md.reasoning')}</summary>`, '', m.thinking.trim(), '', '</details>', '')
      }
      out.push(m.content, '')
      if (m.knowledgeRefs?.length) {
        out.push(`${t('md.sources')}:`, ...m.knowledgeRefs.map((r) => `- ${sourceLabel(r.title, r.locator)}${r.base ? ` (${r.base})` : ''}`), '')
      }
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
      .slice(0, 80) || t('export.defaultName')
  return `${base}.${format}`
}
