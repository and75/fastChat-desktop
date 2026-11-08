// Plugin «PDF»: una sezione per pagina («p. N»), testo dal livello testuale del PDF (pdf.js, puro JS).
// Le scansioni senza testo danno un documento vuoto: l'OCR non è previsto.
import { readFile } from 'node:fs/promises'
import { t } from '@shared/i18n'
import { baseName, isFileWithExtension, SourceError, type KnowledgeSource } from '../source'

/** Elemento di testo di pdf.js (solo i campi usati). */
interface TextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfModule {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number
      getMetadata(): Promise<{ info?: { Title?: unknown } } | null>
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: TextItem[] }> }>
    }>
    destroy(): Promise<void>
  }
}

let pdfjs: Promise<PdfModule> | null = null
/** La libreria si carica alla prima richiesta (è grande e serve solo con i PDF). */
const load = (): Promise<PdfModule> => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfModule>)

/** Testo di una pagina: gli elementi si susseguono sulla riga, `hasEOL` chiude la riga. */
export function pageText(items: ReadonlyArray<TextItem>): string {
  let out = ''
  for (const item of items) {
    const s = item.str ?? ''
    if (s) {
      if (out && !out.endsWith('\n') && !out.endsWith(' ') && !s.startsWith(' ')) out += ' '
      out += s
    }
    if (item.hasEOL && !out.endsWith('\n')) out += '\n'
  }
  return out.trim()
}

export const pdfSource: KnowledgeSource = {
  id: 'pdf',
  labelKey: 'knowledge.source.pdf',
  kind: 'file',
  extensions: ['pdf'],
  canHandle: (ref) => isFileWithExtension(ref, ['pdf']),
  async extract(ref, _config, signal) {
    if (ref.kind !== 'file') throw new SourceError('unsupported', t('err.knowledge.unsupported', { name: ref.uri }))
    const name = baseName(ref.path)
    const fail = (err: unknown): never => {
      throw new SourceError('read', t('err.knowledge.read', { name, error: err instanceof Error ? err.message : String(err) }))
    }
    const data = new Uint8Array(await readFile(ref.path).catch(fail))
    const lib = await load().catch(fail)
    const task = lib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 })
    try {
      const doc = await task.promise.catch(fail)
      const meta = await doc.getMetadata().catch(() => null)
      const title = typeof meta?.info?.Title === 'string' && meta.info.Title.trim() ? meta.info.Title.trim() : name
      const sections: Array<{ text: string; locator: string }> = []
      for (let i = 1; i <= doc.numPages; i++) {
        if (signal.aborted) throw new SourceError('read', t('err.knowledge.aborted'))
        const page = await doc.getPage(i).catch(fail)
        const content = await page.getTextContent().catch(fail)
        const text = pageText(content.items)
        if (text) sections.push({ text, locator: t('knowledge.locator.page', { n: i }) })
      }
      return { title, sections, meta: { pages: String(doc.numPages) } }
    } finally {
      await task.destroy().catch(() => undefined)
    }
  }
}
