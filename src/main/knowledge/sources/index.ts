// Plugin integrati. Per aggiungerne uno: un file in questa cartella che esporta un `KnowledgeSource`, una
// riga qui, la chiave i18n dell'etichetta nelle tre lingue, un test con una fixture.
import { createRegistry, type SourceRegistry } from '../registry'
import type { KnowledgeSource } from '../source'
import { docxSource } from './docx'
import { createFolderSource } from './folder'
import { pdfSource } from './pdf'
import { textSource } from './text'

/** Plugin che leggono file. */
export const BUILTIN_SOURCES: KnowledgeSource[] = [textSource, pdfSource, docxSource]

/** Registro con tutti i plugin integrati: i file, poi le sorgenti collegate (che delegano ai primi). */
export function createBuiltinRegistry(): SourceRegistry {
  const registry = createRegistry(BUILTIN_SOURCES)
  registry.register(createFolderSource(registry))
  return registry
}
