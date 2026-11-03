import { memo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { useCopy } from './CopyButton'
import { CheckIcon, CopyIcon } from './icons'

/** Blocco di codice con pulsante «Copia» in alto a destra (visibile al passaggio del mouse o col focus). */
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, copy] = useCopy()
  // Si copia il testo reso (senza l'evidenziazione), cioè il codice così com'è.
  const text = (): string => (pre.current?.querySelector('code') ?? pre.current)?.textContent?.replace(/\n$/, '') ?? ''
  return (
    <div className="group/code relative">
      <pre ref={pre}>{children}</pre>
      <button
        type="button"
        aria-label={copied ? 'Codice copiato' : 'Copia il codice'}
        onClick={() => void copy(text())}
        className={
          'absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-zinc-800/90 px-2 py-1 text-xs text-zinc-200 opacity-0 transition-opacity hover:bg-zinc-700 focus-visible:opacity-100 group-hover/code:opacity-100 ' +
          (copied ? 'opacity-100' : '')
        }
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        {copied ? 'Copiato' : 'Copia'}
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
