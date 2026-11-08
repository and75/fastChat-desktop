import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { CheckIcon, CopyIcon } from './icons'

/** Copia negli appunti con conferma «Copiato» per qualche istante. */
export function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async (text: string): Promise<void> => {
    const res = await window.api.clipboard.writeText(text)
    if (res.ok) setCopied(true)
  }
  return [copied, copy]
}

/** Azione «Copia» sotto una risposta (stesso stile di «Rigenera»). */
export function CopyAction({ text }: { text: string }): React.JSX.Element {
  const [copied, copy] = useCopy()
  return (
    <button
      type="button"
      aria-label={copied ? t('copy.answerDone') : t('copy.answer')}
      onClick={() => void copy(text)}
      className={
        'inline-flex items-center gap-1 ' +
        (copied ? 'text-brand-600 dark:text-brand-400' : 'hover:text-zinc-700 dark:hover:text-zinc-200')
      }
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      {copied ? t('copy.copied') : t('copy.copy')}
    </button>
  )
}
