// Genera i pacchetti integrati nell'app (cartella packs/): ciò che FastChat sa di suo appena installata.
// Uso: node scripts/build-packs.mjs
//
// Sono pacchetti di solo testo: all'installazione i documenti vengono indicizzati con il modello di embedding
// dell'utente. Per distribuirli con i vettori già calcolati (modello dichiarato nel manifest) si installa il
// pacchetto nell'app, si copia la base nella libreria e la si esporta: l'esportazione porta i vettori.
// Il formato è quello di src/main/knowledge/pack.ts (un test verifica che questi file si leggano con quel codice).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function build({ id, name, description, language, documents, file, i18n, dir = 'packs' }) {
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
    ...(i18n ? { i18n } : {}),
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
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  const out = join(root, dir, typeof file === 'function' ? file(version) : file)
  mkdirSync(resolve(out, '..'), { recursive: true })
  writeFileSync(out, data)
  console.log(`${out.slice(root.length + 1)}: ${manifest.documents} documenti, ${manifest.chunks} pezzi, versione ${version}`)
  return { version, sha256: sha(data), size: data.length, path: out.slice(join(root, dir).length + 1).replaceAll('\\', '/') }
}

const guida = await build({
  id: 'app.fastchat.guida',
  file: 'fastchat-guida.fcpack',
  name: 'Guida di FastChat',
  description: 'Come funziona FastChat: funzionalità, basi di conoscenza, plugin, architettura.',
  language: 'it',
  documents: [
    { title: 'FastChat', path: 'README.md' },
    { title: 'Basi di conoscenza', path: 'docs/base-di-conoscenza.md' }
  ],
  // Titoli nella lingua dell'interfaccia (il contenuto resta nella lingua del pacchetto).
  i18n: {
    en: { name: 'FastChat Guide', description: 'How FastChat works: features, knowledge bases, plugins, architecture.' },
    fr: { name: 'Guide de FastChat', description: 'Comment fonctionne FastChat : fonctionnalités, bases de connaissances, plugins, architecture.' }
  }
})

// ---------------------------------------------------------------- catalogo locale dello store
// Finché il repository remoto non esiste, lo store legge questo catalogo incluso nell'app (cartella store/),
// con lo stesso formato che avrà quello remoto. Le voci «identity», «plugin» e parte dei «bundle» sono esempi:
// si vedono ma non si installano ancora.

// Le versioni precedenti dei file dello store non servono più.
rmSync(join(root, 'store', 'items'), { recursive: true, force: true })

const prompt = await build({
  dir: 'store',
  id: 'it.fastchat.prompt',
  file: (version) => `items/it.fastchat.prompt/${version}.fcpack`,
  name: 'Scrivere buoni prompt',
  description: 'Indicazioni pratiche per ottenere risposte migliori da un modello locale.',
  language: 'it',
  documents: [{ title: 'Scrivere buoni prompt', path: 'store/sources/prompt.md' }],
  i18n: {
    en: { name: 'Writing good prompts', description: 'Practical advice for getting better answers from a local model.' },
    fr: { name: 'Écrire de bons prompts', description: 'Conseils pratiques pour obtenir de meilleures réponses d’un modèle local.' }
  }
})

const catalog = {
  version: 1,
  updatedAt: '2026-11-11',
  items: [
    {
      id: 'app.fastchat.guida',
      type: 'knowledge',
      builtin: true,
      version: guida.version,
      author: 'FastChat',
      language: 'it',
      price: 0,
      name: { it: 'Guida di FastChat', en: 'FastChat Guide', fr: 'Guide de FastChat' },
      summary: {
        it: 'Come funziona l’app: basi di conoscenza, plugin, impostazioni.',
        en: 'How the app works: knowledge bases, plugins, settings.',
        fr: 'Comment fonctionne l’application : bases de connaissances, plugins, paramètres.'
      }
    },
    {
      id: 'it.fastchat.prompt',
      type: 'knowledge',
      version: prompt.version,
      author: 'FastChat',
      language: 'it',
      price: 0,
      size: prompt.size,
      file: prompt.path,
      sha256: prompt.sha256,
      name: { it: 'Scrivere buoni prompt', en: 'Writing good prompts', fr: 'Écrire de bons prompts' },
      summary: {
        it: 'Indicazioni pratiche per ottenere risposte migliori da un modello locale.',
        en: 'Practical advice for getting better answers from a local model.',
        fr: 'Conseils pratiques pour obtenir de meilleures réponses d’un modèle local.'
      }
    },
    {
      id: 'it.fastchat.tutor-prompt',
      type: 'identity',
      version: '1.0.0',
      author: 'FastChat',
      language: 'it',
      price: 0,
      model: { name: 'gemma3:12b', required: false },
      requires: ['it.fastchat.prompt'],
      name: { it: 'Tutor dei prompt', en: 'Prompt tutor', fr: 'Tuteur de prompts' },
      summary: {
        it: 'Rilegge i tuoi prompt e propone come migliorarli, con esempi.',
        en: 'Reviews your prompts and suggests improvements, with examples.',
        fr: 'Relit vos prompts et propose des améliorations, avec des exemples.'
      }
    },
    {
      id: 'it.fastchat.sito-web',
      type: 'plugin',
      version: '0.9.0',
      author: 'FastChat',
      price: 0,
      name: { it: 'Sito web', en: 'Website', fr: 'Site web' },
      summary: {
        it: 'Collega le pagine di un sito come base di conoscenza.',
        en: 'Connects the pages of a website as a knowledge base.',
        fr: 'Connecte les pages d’un site comme base de connaissances.'
      }
    },
    {
      id: 'it.fastchat.kit-prompt',
      type: 'bundle',
      version: '1.0.0',
      author: 'FastChat',
      language: 'it',
      price: 0,
      contains: ['it.fastchat.tutor-prompt', 'it.fastchat.prompt'],
      name: { it: 'Kit dei prompt', en: 'Prompt kit', fr: 'Kit de prompts' },
      summary: {
        it: 'L’identità «Tutor dei prompt» con la base «Scrivere buoni prompt».',
        en: 'The “Prompt tutor” identity with the “Writing good prompts” base.',
        fr: 'L’identité « Tuteur de prompts » avec la base « Écrire de bons prompts ».'
      }
    }
  ]
}
writeFileSync(join(root, 'store', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log(`store/catalog.json: ${catalog.items.length} voci`)
