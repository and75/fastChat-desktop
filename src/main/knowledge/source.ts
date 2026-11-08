// Contratto dei plugin della base di conoscenza. Un plugin sa leggere un tipo di sorgente e ne restituisce
// il testo a sezioni; tutto il resto (pezzi, embedding, archivio, ricerca, prompt, interfaccia) è del nucleo.
//
// Due famiglie:
// - `file`: l'utente aggiunge file (dialog, drag&drop); il plugin dichiara le estensioni che legge.
// - `connected`: il plugin si collega a una sorgente configurata dall'utente (cartella, sito, servizio),
//   elenca lui i documenti (`list`) e li legge uno per uno (`extract`). «Aggiorna» richiama `list` e
//   confronta le versioni.
import type { Key } from '@shared/i18n'
import type { ConfigField, DocumentRef } from '@shared/types'

export type { DocumentRef }

export interface ExtractedDocument {
  /** Titolo da mostrare (nome del file, titolo dai metadati). */
  title: string
  /** Testo a sezioni (una per pagina, per capitolo, o una sola), ciascuna con un locatore se noto. */
  sections: Array<{ text: string; locator: string | null }>
  /** Versione del contenuto (etag, data, hash): se cambia al refresh, il documento si reindicizza. */
  version?: string
  meta?: Record<string, string>
}

/** Un documento che una sorgente collegata offre, prima di leggerlo. */
export interface ListedDocument {
  ref: DocumentRef
  title: string
  version?: string
  bytes?: number
}

/** Configurazione di una connessione: i valori dei campi dichiarati dal plugin. */
export type SourceConfig = Record<string, string>

/** Campo di configurazione: come `ConfigField`, ma con la chiave di traduzione al posto del testo. */
export interface SourceConfigField extends Omit<ConfigField, 'label' | 'placeholder'> {
  labelKey: Key
  placeholderKey?: Key
}

export interface KnowledgeSource {
  /** Univoco: 'text', 'pdf', 'docx', 'folder', … Viene salvato sui documenti. */
  id: string
  labelKey: Key
  kind: 'file' | 'connected'
  /** Estensioni lette (minuscole, senza punto). Solo per `kind: 'file'`. */
  extensions?: string[]
  /** Campi da chiedere all'utente. Solo per `kind: 'connected'`. */
  configFields?: SourceConfigField[]
  /** Elenco dei documenti disponibili nella sorgente. Solo per `kind: 'connected'`. */
  list?(config: SourceConfig, signal: AbortSignal): Promise<ListedDocument[]>
  canHandle(ref: DocumentRef): boolean
  extract(ref: DocumentRef, config: SourceConfig, signal: AbortSignal): Promise<ExtractedDocument>
}

/** Estensione di un percorso, minuscola e senza punto ('' se manca). */
export const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Nome del file senza estensione, per il titolo. */
export const baseName = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Vero se il riferimento è un file con una delle estensioni indicate. */
export const isFileWithExtension = (ref: DocumentRef, extensions: ReadonlyArray<string>): boolean =>
  ref.kind === 'file' && extensions.includes(extensionOf(ref.path))

/** Errore di un plugin con un messaggio già tradotto per l'utente. */
export class SourceError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'empty' | 'tooBig' | 'tooLong' | 'read',
    message: string
  ) {
    super(message)
    this.name = 'SourceError'
  }
}
