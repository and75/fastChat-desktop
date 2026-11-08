// Plugin «Word»: .docx letto con mammoth (puro JS) e diviso ai titoli (Titolo 1-6), come il Markdown.
import { t } from '@shared/i18n'
import { splitMarkdownSections } from '@shared/knowledge'
import { baseName, isFileWithExtension, SourceError, type KnowledgeSource } from '../source'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return ENTITIES[code.toLowerCase()] ?? m
  })

/**
 * HTML semplice di mammoth → testo in stile Markdown: titoli come `#`, paragrafi separati da una riga vuota,
 * voci di elenco con «- », celle di tabella separate da tabulazioni. Poi si divide ai titoli.
 */
export function htmlToMarkdown(html: string): string {
  const text = html
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  return decode(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const docxSource: KnowledgeSource = {
  id: 'docx',
  labelKey: 'knowledge.source.docx',
  kind: 'file',
  extensions: ['docx'],
  canHandle: (ref) => isFileWithExtension(ref, ['docx']),
  async extract(ref) {
    if (ref.kind !== 'file') throw new SourceError('unsupported', t('err.knowledge.unsupported', { name: ref.uri }))
    const name = baseName(ref.path)
    const fail = (err: unknown): never => {
      throw new SourceError('read', t('err.knowledge.read', { name, error: err instanceof Error ? err.message : String(err) }))
    }
    const mammoth = (await import('mammoth').catch(fail)) as { convertToHtml(input: { path: string }): Promise<{ value: string }> } & { default?: { convertToHtml(input: { path: string }): Promise<{ value: string }> } }
    const convert = mammoth.convertToHtml ?? mammoth.default?.convertToHtml
    if (!convert) fail(new Error('mammoth'))
    const result = await convert!({ path: ref.path }).catch(fail)
    const markdown = htmlToMarkdown(result.value)
    return { title: name, sections: splitMarkdownSections(markdown) }
  }
}
