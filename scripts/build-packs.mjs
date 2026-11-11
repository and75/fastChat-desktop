// Genera i pacchetti integrati nell'app (cartella packs/): ciò che FastChat sa di suo appena installata.
// Uso: node scripts/build-packs.mjs
//
// Sono pacchetti di solo testo: all'installazione i documenti vengono indicizzati con il modello di embedding
// dell'utente. Per distribuirli con i vettori già calcolati (modello dichiarato nel manifest) si installa il
// pacchetto nell'app, si copia la base nella libreria e la si esporta: l'esportazione porta i vettori.
// Il formato è quello di src/main/knowledge/pack.ts (un test verifica che questi file si leggano con quel codice).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'

const root = resolve(import.meta.dirname, '..')
const MAX = 1600

/** Markdown → pezzi: una sezione per titolo (locatore = catena dei titoli), poi paragrafi entro MAX caratteri. */
function chunksOf(markdown) {
  const sections = []
  const trail = []
  let locator = null
  let current = []
  let fence = false
  const flush = () => {
    const text = current.join('\n').trim()
    if (text) sections.push({ locator, text })
    current = []
  }
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!m) {
      current.push(line)
      continue
    }
    flush()
    trail.length = m[1].length - 1
    trail[m[1].length - 1] = m[2].trim()
    locator = trail.filter(Boolean).join(' › ')
  }
  flush()
  const out = []
  for (const s of sections) {
    let block = ''
    for (const p of s.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
      for (const piece of p.length > MAX ? p.match(new RegExp(`[\\s\\S]{1,${MAX}}`, 'g')) : [p]) {
        if (block && block.length + 2 + piece.length > MAX) {
          out.push({ locator: s.locator, text: block })
          block = ''
        }
        block = block ? `${block}\n\n${piece}` : piece
      }
    }
    if (block) out.push({ locator: s.locator, text: block })
  }
  return out
}

const sha = (data) => createHash('sha256').update(data).digest('hex')

async function build({ id, name, description, language, documents, file }) {
  const knowledge = { documents: documents.map((d) => ({ title: d.title, source: 'md', chunks: chunksOf(readFileSync(join(root, d.path), 'utf8')) })) }
  const knowledgeBytes = Buffer.from(JSON.stringify(knowledge), 'utf8')
  // La versione segue il contenuto: se i documenti cambiano, l'app aggiorna la base al prossimo avvio.
  const version = `1.0.0+${sha(knowledgeBytes).slice(0, 8)}`
  const manifest = {
    id,
    type: 'knowledge',
    name,
    version,
    description,
    author: 'FastChat',
    language,
    license: 'MIT',
    createdAt: 0,
    format: 'fastchat-pack',
    formatVersion: 1,
    documents: knowledge.documents.length,
    chunks: knowledge.documents.reduce((n, d) => n + d.chunks.length, 0),
    files: { 'knowledge.json': sha(knowledgeBytes) }
  }
  const zip = new JSZip()
  // Data fissa: lo stesso contenuto produce lo stesso file.
  const date = new Date('2026-01-01T00:00:00Z')
  zip.file('knowledge.json', knowledgeBytes, { date })
  zip.file('manifest.json', JSON.stringify(manifest, null, 2), { date })
  mkdirSync(join(root, 'packs'), { recursive: true })
  writeFileSync(join(root, 'packs', file), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }))
  console.log(`${file}: ${manifest.documents} documenti, ${manifest.chunks} pezzi, versione ${version}`)
}

await build({
  id: 'app.fastchat.guida',
  file: 'fastchat-guida.fcpack',
  name: 'Guida di FastChat',
  description: 'Come funziona FastChat: funzionalità, basi di conoscenza, plugin, architettura.',
  language: 'it',
  documents: [
    { title: 'FastChat', path: 'README.md' },
    { title: 'Basi di conoscenza', path: 'docs/base-di-conoscenza.md' }
  ]
})
