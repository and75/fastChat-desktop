// Pacchetti (.fcpack): il formato con cui una base di conoscenza si esporta, si installa e, più avanti, si
// distribuisce dallo store. È uno zip con:
//   manifest.json   cosa contiene, versione, modello di embedding dichiarato, impronta di ogni file
//   knowledge.json  documenti e pezzi (il testo c'è sempre: serve per le fonti e la ricerca a parole)
//   vectors.bin     vettori dei pezzi (float32, nell'ordine dei pezzi), se il pacchetto li porta
//   signature.json  firma Ed25519 del manifest (che a sua volta fissa l'impronta degli altri file)
// Un pacchetto con i vettori dichiara il modello con cui sono calcolati: per usarlo serve quel modello.
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import JSZip from 'jszip'
import { t } from '@shared/i18n'
import type { PackManifest, PackTrust } from '@shared/types'

export const PACK_FORMAT = 'fastchat-pack'
export const PACK_FORMAT_VERSION = 1
export const PACK_EXTENSION = 'fcpack'

/** Limiti di un pacchetto, per non caricare in memoria file fuori misura. */
export const PACK_LIMITS = { bytes: 512 * 1024 * 1024, documents: 5000, chunks: 200_000 } as const

export interface PackDocument {
  title: string
  /** Tipo di documento d'origine (pdf, docx…), solo informativo. */
  source?: string
  pinned?: boolean
  chunks: Array<{ locator: string | null; text: string }>
}

export interface PackKnowledge {
  documents: PackDocument[]
}

export interface PackContent {
  manifest: PackManifest
  knowledge: PackKnowledge | null
  /** Vettori di tutti i pezzi, uno dopo l'altro (lunghezza = pezzi × dimensioni); null per i pacchetti di solo testo. */
  vectors: Float32Array | null
  trust: PackTrust
}

/** Chi firma: l'id della chiave (per trovarla tra quelle note) e la chiave privata in formato PEM. */
export interface PackSigner {
  keyId: string
  privateKey: string
}

/** Chiavi pubbliche riconosciute (PEM), per id. */
export type TrustedKeys = Record<string, string>

export class PackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackError'
  }
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export const validPackId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{2,80}$/.test(id)

/** Id di pacchetto da un nome libero: minuscole, cifre e trattini. */
export const slugify = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'base'

export interface WritePackInput {
  manifest: Omit<PackManifest, 'format' | 'formatVersion' | 'files' | 'documents' | 'chunks'>
  knowledge?: PackKnowledge
  vectors?: Float32Array | null
  signer?: PackSigner
}

/** Costruisce il file del pacchetto. Il manifest riporta l'impronta di ogni file; se c'è chi firma, firma il manifest. */
export async function writePack({ manifest, knowledge, vectors, signer }: WritePackInput): Promise<Buffer> {
  if (!validPackId(manifest.id)) throw new PackError(t('err.pack.badId'))
  const zip = new JSZip()
  const files: Record<string, string> = {}
  const add = (name: string, data: Uint8Array): void => {
    files[name] = sha256(data)
    zip.file(name, data)
  }
  let chunks = 0
  if (knowledge) {
    chunks = knowledge.documents.reduce((n, d) => n + d.chunks.length, 0)
    add('knowledge.json', Buffer.from(JSON.stringify(knowledge), 'utf8'))
  }
  if (vectors) {
    const dims = manifest.embedding?.dimensions ?? 0
    if (!manifest.embedding || dims <= 0 || vectors.length !== chunks * dims) throw new PackError(t('err.pack.badVectors'))
    add('vectors.bin', new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength))
  }
  const full: PackManifest = {
    ...manifest,
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    ...(knowledge ? { documents: knowledge.documents.length, chunks } : {}),
    files
  }
  const manifestBytes = Buffer.from(JSON.stringify(full, null, 2), 'utf8')
  zip.file('manifest.json', manifestBytes)
  if (signer) {
    const signature = cryptoSign(null, manifestBytes, createPrivateKey(signer.privateKey)).toString('base64')
    zip.file('signature.json', JSON.stringify({ algorithm: 'ed25519', keyId: signer.keyId, signature }))
  }
  // I vettori sono numeri quasi casuali: comprimerli costa tempo e non rende.
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

/** Solo il manifest e la fiducia, senza caricare documenti e vettori (per mostrare cosa si sta per installare). */
export async function readPack(data: Uint8Array, trusted: TrustedKeys = {}): Promise<PackContent> {
  if (data.byteLength > PACK_LIMITS.bytes) throw new PackError(t('err.pack.tooBig'))
  const zip = await JSZip.loadAsync(data).catch(() => {
    throw new PackError(t('err.pack.invalid'))
  })
  const entry = async (name: string): Promise<Uint8Array | null> => (zip.file(name) ? zip.file(name)!.async('uint8array') : null)
  const manifestBytes = await entry('manifest.json')
  if (!manifestBytes) throw new PackError(t('err.pack.invalid'))
  let manifest: PackManifest
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as PackManifest
  } catch {
    throw new PackError(t('err.pack.invalid'))
  }
  if (manifest?.format !== PACK_FORMAT || !validPackId(manifest.id) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !manifest.files) {
    throw new PackError(t('err.pack.invalid'))
  }
  if (manifest.formatVersion > PACK_FORMAT_VERSION) throw new PackError(t('err.pack.newer'))

  // Ogni file deve avere l'impronta scritta nel manifest: così la firma del manifest copre tutto il contenuto.
  const contents = new Map<string, Uint8Array>()
  for (const [name, hash] of Object.entries(manifest.files)) {
    const bytes = await entry(name)
    if (!bytes || sha256(bytes) !== hash) throw new PackError(t('err.pack.tampered'))
    contents.set(name, bytes)
  }

  let trust: PackTrust = 'unsigned'
  const signatureBytes = await entry('signature.json')
  if (signatureBytes) {
    let sig: { keyId?: string; signature?: string }
    try {
      sig = JSON.parse(Buffer.from(signatureBytes).toString('utf8'))
    } catch {
      throw new PackError(t('err.pack.tampered'))
    }
    const key = sig.keyId ? trusted[sig.keyId] : undefined
    if (!key) trust = 'unknown'
    else {
      const ok = cryptoVerify(null, manifestBytes, createPublicKey(key), Buffer.from(sig.signature ?? '', 'base64'))
      // Firmato con una chiave nota ma la firma non torna: il pacchetto è stato alterato.
      if (!ok) throw new PackError(t('err.pack.tampered'))
      trust = 'verified'
    }
  }

  let knowledge: PackKnowledge | null = null
  const knowledgeBytes = contents.get('knowledge.json')
  if (knowledgeBytes) {
    try {
      knowledge = JSON.parse(Buffer.from(knowledgeBytes).toString('utf8')) as PackKnowledge
    } catch {
      throw new PackError(t('err.pack.invalid'))
    }
    const docs = knowledge?.documents
    const wellFormed =
      Array.isArray(docs) &&
      docs.length <= PACK_LIMITS.documents &&
      docs.every((d) => typeof d?.title === 'string' && Array.isArray(d.chunks) && d.chunks.every((c) => typeof c?.text === 'string' && (c.locator === null || typeof c.locator === 'string')))
    if (!wellFormed) throw new PackError(t('err.pack.invalid'))
  }
  const chunkCount = knowledge?.documents.reduce((n, d) => n + d.chunks.length, 0) ?? 0
  if (chunkCount > PACK_LIMITS.chunks) throw new PackError(t('err.pack.tooBig'))

  let vectors: Float32Array | null = null
  const vectorBytes = contents.get('vectors.bin')
  if (vectorBytes) {
    const dims = manifest.embedding?.dimensions ?? 0
    if (!manifest.embedding?.model || dims <= 0 || vectorBytes.byteLength !== chunkCount * dims * 4) throw new PackError(t('err.pack.badVectors'))
    // Copia allineata: il buffer dello zip può iniziare a un offset non multiplo di 4.
    vectors = new Float32Array(vectorBytes.slice().buffer)
  } else if (manifest.embedding) {
    throw new PackError(t('err.pack.badVectors'))
  }
  return { manifest, knowledge, vectors, trust }
}
