// Plugin integrati. Per aggiungerne uno: un file in questa cartella che esporta un `KnowledgeSource`, una
// riga qui, la chiave i18n dell'etichetta nelle tre lingue, un test con una fixture.
import type { KnowledgeSource } from '../source'
import { textSource } from './text'

export const BUILTIN_SOURCES: KnowledgeSource[] = [textSource]
