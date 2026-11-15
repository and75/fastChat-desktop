import { isValidElement, memo, useRef } from 'react'
import { t } from '@shared/i18n'
import ReactMarkdown, { type Components } from 'react-markdown'
import { normalizeMath } from '@shared/math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { useCopy } from './CopyButton'
import { CheckIcon, CopyIcon } from './icons'

/** Linguaggi di un blocco che contiene testo, non codice: le righe lunghe vanno a capo. */
const PROSE = new Set(['text', 'txt', 'plaintext', 'plain', 'none', 'markdown', 'md', 'prompt'])

/**
 * Un blocco senza linguaggio (o dichiarato come testo) contiene di solito prosa: un prompt, una lettera, un
 * messaggio da copiare. Lì le righe vanno a capo; il codice vero conserva le sue righe e scorre in orizzontale.
 */
function isProse(children: React.ReactNode): boolean {
  const code = Array.isArray(children) ? children.find((c) => isValidElement(c)) : children
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : ''
  const language = /language-([\w+-]+)/.exec(className)?.[1]?.toLowerCase()
  return !language || PROSE.has(language)
}

/** Blocco di codice con pulsante «Copia» in alto a destra (visibile al passaggio del mouse o col focus). */
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, copy] = useCopy()
  // Si copia il testo reso (senza l'evidenziazione), cioè il codice così com'è.
  const text = (): string => (pre.current?.querySelector('code') ?? pre.current)?.textContent?.replace(/\n$/, '') ?? ''
  return (
    <div className="group/code relative">
      <pre ref={pre} data-wrap={isProse(children) ? '' : undefined}>
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? t('copy.codeDone') : t('copy.code')}
        onClick={() => void copy(text())}
        className={
          'absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-zinc-800/90 px-2 py-1 text-xs text-zinc-200 opacity-0 transition-opacity hover:bg-zinc-700 focus-visible:opacity-100 group-hover/code:opacity-100 ' +
          (copied ? 'opacity-100' : '')
        }
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        {copied ? t('copy.copied') : t('copy.copy')}
      </button>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // I link si aprono nel browser di sistema (il main intercetta le nuove finestre).
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

// Formule LaTeX ($…$, $$…$$, \(…\), \[…\]): una formula sbagliata resta come testo, senza errori rossi.
const KATEX: [typeof rehypeKatex, { throwOnError: boolean; strict: boolean; errorColor: string }] = [rehypeKatex, { throwOnError: false, strict: false, errorColor: 'currentColor' }]

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, KATEX]} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
})
