// Plugin «testo»: file di testo semplice e Markdown. Il Markdown viene diviso ai titoli, così ogni pezzo
// porta con sé la sezione da cui viene.
import { readFile } from 'node:fs/promises'
import { t } from '@shared/i18n'
import { normalizeText, splitMarkdownSections } from '@shared/knowledge'
import { baseName, extensionOf, isFileWithExtension, SourceError, type KnowledgeSource } from '../source'

const MARKDOWN = ['md', 'markdown', 'mdx']
const PLAIN = ['txt', 'text', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm']

export const textSource: KnowledgeSource = {
  id: 'text',
  labelKey: 'knowledge.source.text',
  kind: 'file',
  extensions: [...MARKDOWN, ...PLAIN],
  canHandle: (ref) => isFileWithExtension(ref, [...MARKDOWN, ...PLAIN]),
  async extract(ref) {
    if (ref.kind !== 'file') throw new SourceError('unsupported', t('err.knowledge.unsupported', { name: ref.uri }))
    const raw = await readFile(ref.path, 'utf8').catch((err: unknown) => {
      throw new SourceError('read', t('err.knowledge.read', { name: baseName(ref.path), error: err instanceof Error ? err.message : String(err) }))
    })
    // Il BOM di Windows non è testo.
    const text = normalizeText(raw.replace(/^﻿/, ''))
    const title = baseName(ref.path)
    const ext = extensionOf(ref.path)
    const sections = MARKDOWN.includes(ext) ? splitMarkdownSections(text) : text ? [{ text, locator: null }] : []
    return { title, sections }
  }
}
