// Memoria della conversazione (RAG sulla storia della chat): funzioni pure per dividere i messaggi in pezzi,
// confrontare gli embedding, scegliere gli estratti e scriverli nel system prompt.
import { t } from './i18n'
import type { MessageRole } from './types'

export const MEMORY = {
  /** Lunghezza massima di un pezzo, in caratteri (~400 token). */
  chunkChars: 1600,
  /** Quanta domanda accompagna ogni pezzo di risposta, per dargli contesto. */
  questionChars: 300,
  /** Messaggi dell'utente più corti di così non diventano un pezzo a sé ("ok", "grazie"). */
  minUserChars: 40,
  /** Estratti al massimo per risposta. */
  topK: 4,
  /** Somiglianza minima, e minima rispetto al migliore: meglio nessun estratto che uno a caso. */
  minScore: 0.3,
  relativeScore: 0.75,
  /** Le frasi dell'utente pesano di più di quelle del modello (che possono essere sbagliate). */
  userBoost: 1.1,
  /** Quota massima della memoria (num_ctx) per gli estratti. */
  budgetShare: 0.12
} as const

export interface ChunkSource {
  id: string
  role: MessageRole
  content: string
}

export interface ChunkDraft {
  messageId: string
  role: MessageRole
  part: number
  text: string
}

/** Divide un testo per paragrafi in blocchi di al massimo `max` caratteri (un paragrafo troppo lungo viene tagliato). */
export function splitParagraphs(text: string, max: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  let current = ''
  for (const p of paragraphs) {
    const pieces = p.length > max ? (p.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) ?? []) : [p]
    for (const piece of pieces) {
      if (current && current.length + 2 + piece.length > max) {
        out.push(current)
        current = ''
      }
      current = current ? `${current}\n\n${piece}` : piece
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * Pezzi da indicizzare. Ogni risposta viene divisa per paragrafi e ogni pezzo porta con sé l'inizio della
 * domanda, così ha senso anche da solo. Le domande abbastanza lunghe diventano anche un pezzo a sé:
 * è lì che stanno i fatti detti dall'utente.
 */
export function buildChunks(messages: ReadonlyArray<ChunkSource>): ChunkDraft[] {
  const out: ChunkDraft[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const text = m.content.trim()
    if (!text) continue
    if (m.role === 'user') {
      if (text.length >= MEMORY.minUserChars) {
        splitParagraphs(text, MEMORY.chunkChars).forEach((piece, part) => out.push({ messageId: m.id, role: 'user', part, text: t('memory.chunk.user', { text: piece }) }))
      }
      continue
    }
    const question = messages[i - 1]?.role === 'user' ? messages[i - 1].content.trim() : ''
    const q = question.length > MEMORY.questionChars ? `${question.slice(0, MEMORY.questionChars)}…` : question
    const head = q ? t('memory.chunk.question', { q }) : ''
    splitParagraphs(text, MEMORY.chunkChars - head.length).forEach((piece, part) =>
      out.push({ messageId: m.id, role: 'assistant', part, text: head + t('memory.chunk.answer', { text: piece }) })
    )
  }
  return out
}

/** Similarità del coseno tra due vettori (0 se uno è nullo). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

export const toBuffer = (v: ArrayLike<number>): Buffer => Buffer.from(new Float32Array(Array.from(v)).buffer)
export const fromBuffer = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

export interface StoredChunk {
  id: string
  messageId: string
  role: MessageRole
  text: string
  embedding: ArrayLike<number>
}

export interface Picked extends StoredChunk {
  score: number
}

/**
 * Estratti più pertinenti alla domanda: sopra la soglia assoluta e vicini al migliore, le frasi dell'utente
 * favorite, al massimo `topK` e dentro `maxChars`. Un messaggio contribuisce con un solo pezzo.
 */
export function pickChunks(query: ArrayLike<number>, chunks: ReadonlyArray<StoredChunk>, maxChars: number, topK: number = MEMORY.topK): Picked[] {
  const scored = chunks
    .map((c) => ({ ...c, score: cosine(query, c.embedding) * (c.role === 'user' ? MEMORY.userBoost : 1) }))
    .filter((c) => c.score >= MEMORY.minScore)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  const floor = scored[0].score * MEMORY.relativeScore
  const out: Picked[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const c of scored) {
    if (out.length >= topK || c.score < floor) break
    if (seen.has(c.messageId)) continue
    if (chars + c.text.length > maxChars) continue
    seen.add(c.messageId)
    chars += c.text.length
    out.push(c)
  }
  return out
}

/** Testo da cui calcolare l'embedding della domanda: la domanda più la fine della risposta precedente (per "e quello?"). */
export function memoryQuery(question: string, previousAnswer: string | null | undefined): string {
  const tail = previousAnswer ? previousAnswer.trim().slice(-500) : ''
  return tail ? t('memory.query', { question: question.trim(), tail }) : question.trim()
}

/**
 * Sezione del system prompt con gli estratti, in ordine cronologico, ciascuno con la sua posizione e chi l'ha
 * detto. Avverte il modello che il riassunto e i messaggi recenti valgono di più: un estratto vecchio può
 * contenere qualcosa che poi è stato corretto.
 */
export function buildMemorySection(picked: ReadonlyArray<{ text: string; role: MessageRole; position: number }>, total: number): string {
  if (picked.length === 0) return ''
  const items = [...picked]
    .sort((a, b) => a.position - b.position)
    .map((p) => t('memory.section.item', { position: p.position, total, who: p.role === 'user' ? t('memory.who.user') : t('memory.who.assistant'), text: p.text }))
  return [t('memory.section.heading'), t('memory.section.intro'), ...items].join('\n\n')
}
