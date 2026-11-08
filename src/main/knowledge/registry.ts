// Registro dei plugin della base di conoscenza: chi legge cosa. Il renderer non conosce i plugin, chiede al
// registro estensioni ed etichette.
import { t } from '@shared/i18n'
import type { DocumentRef, KnowledgeSourceInfo } from '@shared/types'
import { SourceError, type KnowledgeSource } from './source'

export interface SourceRegistry {
  /** Registra un plugin; id duplicato = errore (un plugin esterno non può sostituirne uno integrato). */
  register(source: KnowledgeSource): void
  all(): KnowledgeSource[]
  get(id: string): KnowledgeSource | null
  /** Il primo plugin che sa leggere il riferimento, altrimenti errore «formato non supportato». */
  sourceFor(ref: DocumentRef): KnowledgeSource
  /** Estensioni lette da almeno un plugin `file`, per il dialog e il drag&drop. */
  extensions(): string[]
  /** I plugin come li vede il renderer, con le etichette nella lingua attiva. */
  describe(): KnowledgeSourceInfo[]
}

export function createRegistry(initial: ReadonlyArray<KnowledgeSource> = []): SourceRegistry {
  const sources = new Map<string, KnowledgeSource>()
  const registry: SourceRegistry = {
    register(source) {
      if (!/^[a-z][a-z0-9-]*$/.test(source.id)) throw new Error(`Id del plugin non valido: ${source.id}`)
      if (sources.has(source.id)) throw new Error(`Plugin già registrato: ${source.id}`)
      sources.set(source.id, source)
    },
    all: () => [...sources.values()],
    get: (id) => sources.get(id) ?? null,
    sourceFor(ref) {
      // Un documento di una sorgente collegata lo legge il suo plugin, anche se altri saprebbero leggerlo.
      if (ref.kind === 'remote') {
        const own = sources.get(ref.sourceId)
        if (own?.canHandle(ref)) return own
      }
      const found = [...sources.values()].find((s) => s.canHandle(ref))
      if (!found) throw new SourceError('unsupported', t('err.knowledge.unsupported', { name: ref.kind === 'file' ? ref.path.split(/[\\/]/).pop() ?? ref.path : ref.uri }))
      return found
    },
    extensions: () => [...new Set([...sources.values()].flatMap((s) => (s.kind === 'file' ? (s.extensions ?? []) : [])))].sort(),
    describe: () =>
      [...sources.values()].map((s) => ({
        id: s.id,
        label: t(s.labelKey),
        kind: s.kind,
        extensions: s.kind === 'file' ? [...(s.extensions ?? [])] : [],
        configFields: (s.configFields ?? []).map((f) => ({
          key: f.key,
          label: t(f.labelKey),
          type: f.type,
          required: f.required,
          ...(f.placeholderKey ? { placeholder: t(f.placeholderKey) } : {})
        }))
      }))
  }
  for (const s of initial) registry.register(s)
  return registry
}
