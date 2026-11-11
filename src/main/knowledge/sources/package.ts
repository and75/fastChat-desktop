// Plugin «pacchetto»: rilegge i documenti di un pacchetto di solo testo installato, così vengono indicizzati
// con il modello di embedding dell'utente (e reindicizzati se lo cambia). I pacchetti che portano i vettori
// non passano da qui: i loro pezzi sono già pronti.
import { readFile } from 'node:fs/promises'
import { t } from '@shared/i18n'
import { readPack } from '../pack'
import { SourceError, type KnowledgeSource } from '../source'

/** Riferimento a un documento di un pacchetto: «percorso#indice». */
export const packageUri = (path: string, index: number): string => `${path}#${index}`

export const packageSource: KnowledgeSource = {
  id: 'package',
  labelKey: 'knowledge.source.package',
  kind: 'file',
  extensions: [],
  canHandle: (ref) => ref.kind === 'remote' && ref.sourceId === 'package',
  async extract(ref) {
    if (ref.kind !== 'remote') throw new SourceError('unsupported', t('err.knowledge.unsupported', { name: ref.path }))
    const cut = ref.uri.lastIndexOf('#')
    const path = ref.uri.slice(0, cut)
    const fail = (err: unknown): never => {
      throw new SourceError('read', t('err.knowledge.read', { name: path.split(/[\\/]/).pop() ?? path, error: err instanceof Error ? err.message : String(err) }))
    }
    const content = await readPack(await readFile(path).catch(fail)).catch(fail)
    const doc = content.knowledge?.documents[Number(ref.uri.slice(cut + 1))]
    if (!doc) return fail(new Error('document'))
    return { title: doc.title, sections: doc.chunks.map((c) => ({ text: c.text, locator: c.locator })), version: content.manifest.version }
  }
}
