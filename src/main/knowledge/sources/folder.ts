// Plugin «cartella» (sorgente collegata): elenca i file leggibili di una cartella del disco, anche nelle
// sottocartelle, e li legge con il plugin giusto. «Aggiorna» confronta data e dimensione di ogni file.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { DocumentRef } from '@shared/types'
import type { SourceRegistry } from '../registry'
import { baseName, extensionOf, SourceError, type KnowledgeSource, type ListedDocument } from '../source'

/** Profondità massima e numero massimo di file, per non indicizzare mezzo disco per sbaglio. */
export const FOLDER_LIMITS = { depth: 4, files: 500 } as const

/** Cartelle che non contengono documenti dell'utente. */
const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'out', 'build'])

export async function listFolder(root: string, extensions: ReadonlyArray<string>, signal?: AbortSignal): Promise<ListedDocument[]> {
  const out: ListedDocument[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (signal?.aborted || out.length >= FOLDER_LIMITS.files) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= FOLDER_LIMITS.files) return
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < FOLDER_LIMITS.depth) await walk(path, depth + 1)
        continue
      }
      if (!e.isFile() || !extensions.includes(extensionOf(e.name))) continue
      const info = await stat(path).catch(() => null)
      if (!info) continue
      out.push({
        ref: { kind: 'remote', sourceId: 'folder', uri: path, version: `${info.mtimeMs}:${info.size}` },
        title: baseName(e.name),
        version: `${info.mtimeMs}:${info.size}`,
        bytes: info.size
      })
    }
  }
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new SourceError('read', t('err.knowledge.notFolder', { path: root }))
  await walk(root, 0)
  return out
}

/** Il plugin ha bisogno del registro: per sapere quali file sono leggibili e a chi delegarli. */
export function createFolderSource(registry: SourceRegistry): KnowledgeSource {
  const fileRef = (ref: DocumentRef): DocumentRef => (ref.kind === 'remote' ? { kind: 'file', path: ref.uri } : ref)
  return {
    id: 'folder',
    labelKey: 'knowledge.source.folder',
    kind: 'connected',
    configFields: [{ key: 'path', labelKey: 'knowledge.folder.path', type: 'folder', required: true }],
    list: (config, signal) => listFolder(config.path ?? '', registry.extensions(), signal),
    canHandle: (ref) => ref.kind === 'remote' && ref.sourceId === 'folder',
    async extract(ref, config, signal) {
      const file = fileRef(ref)
      const source = registry.sourceFor(file)
      const doc = await source.extract(file, config, signal)
      const info = file.kind === 'file' ? await stat(file.path).catch(() => null) : null
      return { ...doc, version: info ? `${info.mtimeMs}:${info.size}` : doc.version }
    }
  }
}
