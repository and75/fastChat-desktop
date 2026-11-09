// Base di conoscenza (RAG sui documenti): funzioni pure per dividere i documenti in pezzi, scegliere gli
// estratti pertinenti, dimensionare il budget e scrivere la sezione del system prompt.
import { t } from './i18n'
import { cosine, splitParagraphs } from './memory'
import type { KnowledgeRef } from './types'

export const KNOWLEDGE = {
  /** Lunghezza massima di un pezzo, in caratteri (~400 token: sta nel contesto dei modelli di embedding). */
  chunkChars: 1600,
  /** Estratti al massimo per documento quando il budget è piccolo (con budget grande il tetto sale). */
  perDocument: 2,
  /** Punteggio ibrido minimo, e minimo rispetto al migliore. */
  minScore: 0.25,
  relativeScore: 0.5,
  /** Peso delle parole esatte (BM25) rispetto alla somiglianza semantica (coseno) nel punteggio ibrido. */
  bm25Weight: 0.4,
  /** Quota massima predefinita della memoria (num_ctx) per i documenti (regolabile per conversazione). */
  budgetShare: 0.5,
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
  part: number
  text: string
  embedding: ArrayLike<number>
}

export interface PickedDocumentChunk extends StoredDocumentChunk {
  score: number
}

/**
 * Query per la ricerca a parole esatte (FTS5): parole di almeno 3 caratteri e numeri, senza doppioni, ciascuna
 * tra virgolette (la sintassi di FTS5 non deve interpretare nulla), unite con OR. '' se non resta nulla.
 */
export function ftsQuery(text: string): string {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    terms.push(`"${raw}"`)
    if (terms.length >= 32) break
  }
  return terms.join(' OR ')
}

export interface PickOptions {
  /** Punteggio BM25 per pezzo (già positivo: più alto = più pertinente), per la parte a parole esatte. */
  bm25?: ReadonlyMap<string, number>
  /** Estratti al massimo per documento; se assente si calcola dal budget e dal numero di documenti. */
  perDocument?: number
}

/**
 * Punteggio ibrido di ogni pezzo: coseno con la domanda (0–1) e BM25 normalizzato sul migliore (0–1), pesati.
 * Un pezzo che contiene le parole esatte della domanda (un numero di fattura, un nome) sale anche se la
 * somiglianza semantica è bassa.
 */
export function hybridScores(query: ArrayLike<number>, chunks: ReadonlyArray<StoredDocumentChunk>, bm25?: ReadonlyMap<string, number>): Map<string, number> {
  // Parole presenti in tutti i documenti valgono ~0 per BM25: sotto una soglia minima la parte lessicale non conta.
  const best = bm25 && bm25.size ? Math.max(...bm25.values()) : 0
  const w = best > 1e-3 ? KNOWLEDGE.bm25Weight : 0
  const out = new Map<string, number>()
  for (const c of chunks) {
    const semantic = cosine(query, c.embedding)
    const lexical = best > 0 ? (bm25!.get(c.id) ?? 0) / best : 0
    out.set(c.id, (1 - w) * semantic + w * lexical)
  }
  return out
}

/**
 * Estratti più pertinenti alla domanda, finché il budget in caratteri è pieno: sopra la soglia assoluta e vicini
 * al migliore, al massimo `perDocument` per documento. Il tetto per documento cresce con il budget, così una
 * conversazione con un solo documento grande ne riceve più pagine e una con molti documenti ne vede molti.
 */
export function pickDocumentChunks(
  query: ArrayLike<number>,
  chunks: ReadonlyArray<StoredDocumentChunk>,
  maxChars: number,
  options: PickOptions = {}
): PickedDocumentChunk[] {
  const scores = hybridScores(query, chunks, options.bm25)
  const scored = chunks
    .map((c) => ({ ...c, score: scores.get(c.id) ?? 0 }))
    .filter((c) => c.score >= KNOWLEDGE.minScore)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  const docs = new Set(chunks.map((c) => c.documentId)).size || 1
  const perDocument = options.perDocument ?? Math.max(KNOWLEDGE.perDocument, Math.ceil(maxChars / KNOWLEDGE.chunkChars / docs))
  const floor = scored[0].score * KNOWLEDGE.relativeScore
  const out: PickedDocumentChunk[] = []
  const perDoc = new Map<string, number>()
  let chars = 0
  for (const c of scored) {
    if (c.score < floor) break
    if ((perDoc.get(c.documentId) ?? 0) >= perDocument) continue
    if (chars + c.text.length > maxChars) continue
    perDoc.set(c.documentId, (perDoc.get(c.documentId) ?? 0) + 1)
    chars += c.text.length
    out.push(c)
  }
  return out
}

/** Caratteri totali dei pezzi: se stanno nel budget, i documenti vanno al modello per intero. */
export const totalChars = (chunks: ReadonlyArray<{ text: string }>): number => chunks.reduce((n, c) => n + c.text.length, 0)

/** Pezzi dei documenti indicati, per intero e in ordine, finché stanno nel budget (documenti interi: «fissati» o tutti). */
export function wholeDocuments<T extends StoredDocumentChunk>(chunks: ReadonlyArray<T>, documentIds: ReadonlySet<string>, maxChars: number): { picked: T[]; truncated: boolean } {
  const picked: T[] = []
  let chars = 0
  let truncated = false
  const ordered = [...chunks].filter((c) => documentIds.has(c.documentId)).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.part - b.part)
  for (const c of ordered) {
    if (chars + c.text.length > maxChars) {
      truncated = true
      break
    }
    chars += c.text.length
    picked.push(c)
  }
  return { picked, truncated }
}

/** Quota della memoria per i documenti: al massimo `share` (50% predefinito), e solo lo spazio che resta sotto la riserva. */
export function knowledgeBudget(numCtx: number, reserveTokens: number, usedTokens: number, share: number = KNOWLEDGE.budgetShare): number {
  return Math.max(0, Math.min(Math.floor(numCtx * share), numCtx - reserveTokens - usedTokens))
}

/** Etichetta di una fonte: «Titolo, p. 12» o solo «Titolo». */
export const sourceLabel = (title: string, locator: string | null | undefined): string => (locator ? `${title}, ${locator}` : title)

export interface SectionItem {
  title: string
  locator: string | null
  text: string
  documentId: string
  part?: number
  /** Il pezzo fa parte di un documento fornito per intero (non scelto per somiglianza). */
  whole?: boolean
}

/**
 * Sezione del system prompt con i documenti: prima quelli interi (in ordine di documento e posizione), poi gli
 * estratti scelti per la domanda, ciascuno con la sua fonte. L'introduzione dice al modello se ha i documenti
 * completi (può contare e sommare) o solo estratti, e gli chiede di citare la fonte e di dirlo quando manca.
 */
export function buildKnowledgeSection(picked: ReadonlyArray<SectionItem>): string {
  if (picked.length === 0) return ''
  const sort = (a: SectionItem, b: SectionItem): number => a.title.localeCompare(b.title) || a.documentId.localeCompare(b.documentId) || (a.part ?? 0) - (b.part ?? 0)
  const item = (p: SectionItem): string => t('knowledge.section.item', { source: sourceLabel(p.title, p.locator), text: p.text })
  const whole = picked.filter((p) => p.whole).sort(sort)
  const excerpts = picked.filter((p) => !p.whole).sort(sort)
  const wholeDocs = new Set(whole.map((p) => p.documentId)).size
  const parts = [t('knowledge.section.heading')]
  if (whole.length) {
    parts.push(t('knowledge.section.introWhole', { n: wholeDocs }), ...whole.map(item))
    if (excerpts.length) parts.push(t('knowledge.section.introExcerptsAfter'), ...excerpts.map(item))
  } else {
    parts.push(t('knowledge.section.intro'), ...excerpts.map(item))
  }
  return parts.join('\n\n')
}

/**
 * Riferimenti da salvare sul messaggio: un riferimento per ogni documento intero (prima), poi gli estratti in
 * ordine di punteggio.
 */
export function toKnowledgeRefs(whole: ReadonlyArray<SectionItem>, picked: ReadonlyArray<PickedDocumentChunk>): KnowledgeRef[] {
  const docs = new Map<string, SectionItem>()
  for (const p of whole) if (!docs.has(p.documentId) || (p.part ?? 0) < (docs.get(p.documentId)!.part ?? 0)) docs.set(p.documentId, p)
  return [
    ...[...docs.values()].sort((a, b) => a.title.localeCompare(b.title) || a.documentId.localeCompare(b.documentId)).map((p) => ({ documentId: p.documentId, title: p.title, locator: null, score: 1, excerpt: p.text.slice(0, 240), whole: true })),
    ...[...picked].sort((a, b) => b.score - a.score).map((p) => ({ documentId: p.documentId, title: p.title, locator: p.locator, score: Math.round(p.score * 100) / 100, excerpt: p.text.slice(0, 240) }))
  ]
}
