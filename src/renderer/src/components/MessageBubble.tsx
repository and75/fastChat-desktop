import { formatFullDate, formatMessageDate } from '@shared/format'
import { t, tn } from '@shared/i18n'
import { sourceLabel } from '@shared/knowledge'
import type { KnowledgeRef, MemoryRef, Message } from '@shared/types'
import { BookOpenIcon } from './icons'
import { Markdown } from './Markdown'
import { WaitingIndicator } from './Loader'
import { ThinkingBlock } from './ThinkingBlock'

interface Props {
  role: Message['role']
  content: string
  thinking?: string | null
  /** Statistiche mostrate sotto le risposte salvate. */
  meta?: Pick<Message, 'model' | 'evalCount' | 'durationMs'>
  streaming?: boolean
  /** Durante lo streaming: i messaggi più vecchi vengono riassunti prima della risposta. */
  summarizing?: boolean
  /** Durante lo streaming: si cercano estratti nella conversazione prima della risposta. */
  remembering?: boolean
  /** Durante lo streaming: si cercano estratti nei documenti prima della risposta. */
  searching?: boolean
  /** Estratti della conversazione forniti al modello per questa risposta. */
  memoryRefs?: MemoryRef[] | null
  /** Estratti dei documenti (fonti) forniti al modello per questa risposta. */
  knowledgeRefs?: KnowledgeRef[] | null
  /** Sulla domanda: la scelta del bottone libro (true/false), o null se valeva l'impostazione della conversazione. */
  knowledge?: boolean | null
  /** Data del messaggio (mostrata sotto i messaggi dell'utente). */
  createdAt?: number
  /** Inizio della richiesta in corso (solo durante lo streaming). */
  startedAt?: number
  actions?: React.ReactNode
  /** La risposta è stata fermata da Ollama al limite di token (contesto esaurito). */
  truncated?: boolean
  /** Identificativo per la cronologia (attributo `data-message-id`). */
  anchorId?: string
}

function formatMeta(meta: NonNullable<Props['meta']>): string {
  const parts: string[] = []
  if (meta.model) parts.push(meta.model)
  if (meta.evalCount != null) parts.push(t('message.tokens', { count: meta.evalCount }))
  if (meta.durationMs != null) parts.push(`${(meta.durationMs / 1000).toFixed(1)} s`)
  if (meta.evalCount && meta.durationMs) parts.push(`${((meta.evalCount / meta.durationMs) * 1000).toFixed(1)} tok/s`)
  return parts.join(' · ')
}

export function MessageBubble({
  role,
  content,
  thinking,
  meta,
  streaming,
  summarizing = false,
  remembering = false,
  searching = false,
  memoryRefs = null,
  knowledgeRefs = null,
  knowledge = null,
  startedAt,
  createdAt,
  actions,
  truncated = false,
  anchorId
}: Props): React.JSX.Element {
  if (role === 'user') {
    return (
      <div className="flex scroll-mt-4 flex-col items-end gap-1" data-testid="message-user" data-message-id={anchorId}>
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-white">
          {content}
        </div>
        {(createdAt != null || knowledge != null) && (
          <span className="flex items-center gap-1.5 px-1 text-xs text-zinc-400">
            {knowledge != null && (
              <span
                className={'inline-flex items-center gap-0.5 ' + (knowledge ? 'text-brand-600 dark:text-brand-400' : 'line-through')}
                title={knowledge ? t('message.knowledge.on') : t('message.knowledge.off')}
                data-testid="message-knowledge"
                data-on={knowledge}
              >
                <BookOpenIcon size={12} />
              </span>
            )}
            {createdAt != null && (
              <time
                dateTime={new Date(createdAt).toISOString()}
                title={formatFullDate(createdAt)}
                data-testid="message-date"
              >
                {formatMessageDate(createdAt)}
              </time>
            )}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className="group flex scroll-mt-4 flex-col gap-2"
      data-testid={streaming ? 'message-streaming' : 'message-assistant'}
      data-message-id={anchorId}
    >
      {/* Durante lo streaming il ragionamento resta aperto finché non inizia la risposta. */}
      {thinking && <ThinkingBlock text={thinking} live={!!streaming && !content} startedAt={startedAt} />}
      <div className="max-w-full text-zinc-900 dark:text-zinc-100">
        {content ? (
          <Markdown text={content} />
        ) : streaming && !thinking ? (
          <WaitingIndicator since={startedAt} label={summarizing ? t('message.summarizing') : searching ? t('message.searching') : remembering ? t('message.remembering') : undefined} />
        ) : null}
        {streaming && content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-zinc-400 align-middle" />}
      </div>
      {!streaming && knowledgeRefs && knowledgeRefs.length > 0 && <KnowledgeRefs refs={knowledgeRefs} />}
      {!streaming && memoryRefs && memoryRefs.length > 0 && <MemoryRefs refs={memoryRefs} />}
      {!streaming && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          {meta && <span>{formatMeta(meta)}</span>}
          {truncated && (
            <span
              className="text-amber-700 dark:text-amber-400"
              title={t('message.truncated.title')}
              data-testid="truncated-note"
            >
              {t('message.truncated')}
            </span>
          )}
          {actions}
        </div>
      )}
    </div>
  )
}

/** Testo dell'estratto senza i prefissi «Domanda/Risposta/Utente» (in entrambe le lingue: i pezzi restano nella lingua in cui sono stati indicizzati). */
function excerptBody(excerpt: string): string {
  const m = excerpt.match(/\n(Risposta|Answer|Réponse) ?: ([\s\S]*)$/)
  if (m) return m[2]
  return excerpt.replace(/^(Utente|User|Utilisateur|Risposta|Answer|Réponse) ?: /, '')
}

/** Estratti della conversazione usati per la risposta: chiusi di default, ognuno salta al messaggio originale. */
function MemoryRefs({ refs }: { refs: MemoryRef[] }): React.JSX.Element {
  const jump = (id: string): void =>
    document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <details className="text-xs text-zinc-500" data-testid="memory-refs">
      <summary className="cursor-pointer select-none">
        {tn('message.usedExcerpts', refs.length)}
      </summary>
      <ul className="mt-1 flex flex-col gap-1.5 border-l-2 border-brand-200 pl-3 dark:border-brand-900">
        {refs.map((r) => (
          <li key={`${r.messageId}-${r.position}`}>
            <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => jump(r.messageId)}>
              {t('message.ref', { position: r.position, who: r.role === 'user' ? t('role.you') : t('role.assistant') })}
            </button>{' '}
            <span className="tabular-nums text-zinc-400">({Math.round(r.score * 100)}%)</span>
            <span className="block truncate text-zinc-500" title={r.excerpt}>
              {excerptBody(r.excerpt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Fonti: estratti dei documenti usati per la risposta, con titolo e posizione nel documento. */
function KnowledgeRefs({ refs }: { refs: KnowledgeRef[] }): React.JSX.Element {
  return (
    <details className="text-xs text-zinc-500" data-testid="knowledge-refs">
      <summary className="cursor-pointer select-none">
        <span className="inline-flex items-center gap-1 align-middle">
          <BookOpenIcon size={12} />
          {tn('message.sources', refs.length)}
        </span>
      </summary>
      <ul className="mt-1 flex flex-col gap-1.5 border-l-2 border-emerald-200 pl-3 dark:border-emerald-900">
        {refs.map((r, i) => (
          <li key={`${r.documentId}-${i}`}>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{sourceLabel(r.title, r.locator)}</span>{' '}
            <span className="tabular-nums text-zinc-400">({Math.round(r.score * 100)}%)</span>
            <span className="block truncate text-zinc-500" title={r.excerpt}>
              {r.excerpt}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
