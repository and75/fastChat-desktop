// Base di conoscenza (RAG sui documenti): funzioni pure per dividere i documenti in pezzi, scegliere gli
// estratti pertinenti, dimensionare il budget e scrivere la sezione del system prompt.
import { t } from './i18n'
import { cosine, splitParagraphs } from './memory'
import type { KnowledgeRef } from './types'

export const KNOWLEDGE = {
  /** Lunghezza massima di un pezzo, in caratteri (~400 token: sta nel contesto dei modelli di embedding). */
  chunkChars: 1600,
  /** Estratti al massimo per risposta, e al massimo per documento (così più documenti hanno voce). */
  topK: 6,
  perDocument: 2,
  /** Somiglianza minima, e minima rispetto al migliore. */
  minScore: 0.3,
  relativeScore: 0.7,
  /** Quota massima della memoria (num_ctx) per gli estratti dei documenti. */
  budgetShare: 0.25,
  /** Limiti di un documento: dimensione del file e caratteri estratti. */
  maxBytes: 25 * 1024 * 1024,
  maxChars: 2_000_000,
  /** Pezzi per richiesta di embedding. */
  embedBatch: 16
} as const

export interface Section {
  text: string
  /** Dove nel documento ("p. 12", titolo della sezione), se noto. */
  locator: string | null
}

export interface DocumentChunkDraft {
  part: number
  locator: string | null
  text: string
}

/**
 * Pezzi da indicizzare: ogni sezione (pagina, capitolo) viene divisa per paragrafi entro `max` caratteri e
 * ogni pezzo eredita il locatore della sezione. Le sezioni vuote spariscono; la numerazione è per documento.
 */
export function buildDocumentChunks(sections: ReadonlyArray<Section>, max: number = KNOWLEDGE.chunkChars): DocumentChunkDraft[] {
  const out: DocumentChunkDraft[] = []
  for (const s of sections) {
    for (const text of splitParagraphs(normalizeText(s.text), max)) {
      out.push({ part: out.length, locator: s.locator?.trim() || null, text })
    }
  }
  return out
}

/** Testo pulito: fine riga uniformi, spazi in fondo alle righe tolti, mai più di una riga vuota di seguito. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Divide un testo Markdown in sezioni ai titoli (# … ######): ogni sezione ha come locatore la catena dei
 * titoli ("Capitolo 1 › Metodo"). Il testo prima del primo titolo è una sezione senza locatore.
 */
export function splitMarkdownSections(text: string): Section[] {
  const out: Section[] = []
  const trail: string[] = []
  let current: string[] = []
  let locator: string | null = null
  const flush = (): void => {
    const body = current.join('\n').trim()
    if (body) out.push({ text: body, locator })
    current = []
  }
  let inFence = false
  for (const line of normalizeText(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!m) {
      current.push(line)
      continue
    }
    flush()
    const level = m[1].length
    trail.length = level - 1
    trail[level - 1] = m[2].trim()
    locator = trail.filter(Boolean).join(' › ')
  }
  flush()
  return out
}

export interface StoredDocumentChunk {
  id: string
  documentId: string
  title: string
  locator: string | null
  text: string
  embedding: ArrayLike<number>
}

export interface PickedDocumentChunk extends StoredDocumentChunk {
  score: number
}

/**
 * Estratti più pertinenti alla domanda: sopra la soglia assoluta e vicini al migliore, al massimo `topK`,
 * al massimo `perDocument` per documento e dentro `maxChars`.
 */
export function pickDocumentChunks(
  query: ArrayLike<number>,
  chunks: ReadonlyArray<StoredDocumentChunk>,
  maxChars: number,
  topK: number = KNOWLEDGE.topK,
  perDocument: number = KNOWLEDGE.perDocument
): PickedDocumentChunk[] {
  const scored = chunks
    .map((c) => ({ ...c, score: cosine(query, c.embedding) }))
    .filter((c) => c.score >= KNOWLEDGE.minScore)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  const floor = scored[0].score * KNOWLEDGE.relativeScore
  const out: PickedDocumentChunk[] = []
  const perDoc = new Map<string, number>()
  let chars = 0
  for (const c of scored) {
    if (out.length >= topK || c.score < floor) break
    if ((perDoc.get(c.documentId) ?? 0) >= perDocument) continue
    if (chars + c.text.length > maxChars) continue
    perDoc.set(c.documentId, (perDoc.get(c.documentId) ?? 0) + 1)
    chars += c.text.length
    out.push(c)
  }
  return out
}

/** Quota della memoria per i documenti: al massimo il 25%, e solo lo spazio che resta sotto la riserva. */
export function knowledgeBudget(numCtx: number, reserveTokens: number, usedTokens: number): number {
  return Math.max(0, Math.min(Math.floor(numCtx * KNOWLEDGE.budgetShare), numCtx - reserveTokens - usedTokens))
}

/** Etichetta di una fonte: «Titolo, p. 12» o solo «Titolo». */
export const sourceLabel = (title: string, locator: string | null | undefined): string => (locator ? `${title}, ${locator}` : title)

/**
 * Sezione del system prompt con gli estratti dei documenti, in ordine di documento e posizione, ciascuno con
 * la sua fonte. Chiede al modello di rispondere dai documenti citando la fonte, e di dirlo quando non c'è.
 */
export function buildKnowledgeSection(picked: ReadonlyArray<{ title: string; locator: string | null; text: string; documentId: string; part?: number }>): string {
  if (picked.length === 0) return ''
  const items = [...picked]
    .sort((a, b) => a.title.localeCompare(b.title) || a.documentId.localeCompare(b.documentId) || (a.part ?? 0) - (b.part ?? 0))
    .map((p) => t('knowledge.section.item', { source: sourceLabel(p.title, p.locator), text: p.text }))
  return [t('knowledge.section.heading'), t('knowledge.section.intro'), ...items].join('\n\n')
}

/** Riferimenti da salvare sul messaggio, in ordine di punteggio. */
export function toKnowledgeRefs(picked: ReadonlyArray<PickedDocumentChunk>): KnowledgeRef[] {
  return [...picked]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ documentId: p.documentId, title: p.title, locator: p.locator, score: Math.round(p.score * 100) / 100, excerpt: p.text.slice(0, 240) }))
}
