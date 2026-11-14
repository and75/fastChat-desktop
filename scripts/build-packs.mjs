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

async function build({ id, group, name, description, language, documents, file, i18n, dir = 'packs' }) {
  const knowledge = { documents: documents.map((d) => ({ title: d.title, source: 'md', chunks: chunksOf(readFileSync(join(root, d.path), 'utf8')) })) }
  const knowledgeBytes = Buffer.from(JSON.stringify(knowledge), 'utf8')
  // La versione segue il contenuto: se i documenti cambiano, l'app aggiorna la base al prossimo avvio.
  const version = `1.0.0+${sha(knowledgeBytes).slice(0, 8)}`
  const manifest = {
    id,
    type: 'knowledge',
    ...(group ? { group } : {}),
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

/** Il file di una voce dello Store: una cartella per id, un file per versione. */
const storeFile = (id) => (version) => `items/${id}/${version}.fcpack`

// Le versioni precedenti dei file dello store non servono più.
rmSync(join(root, 'store', 'items'), { recursive: true, force: true })

// ---------------------------------------------------------------- Guida di FastChat
// Tre documenti, uguali nelle tre lingue: presentazione dell'app, basi di conoscenza, manuale d'uso.
// L'italiana è integrata nell'app (packs/); la francese e l'inglese si installano dallo Store.
const GUIDE = 'app.fastchat.guida'
const guideText = {
  it: { name: 'Guida di FastChat', description: "Come funziona FastChat: uso dell'app, ruoli, basi di conoscenza, Store." },
  en: { name: 'FastChat Guide', description: 'How FastChat works: using the app, roles, knowledge bases, Store.' },
  fr: { name: 'Guide de FastChat', description: "Comment fonctionne FastChat : utilisation de l'application, rôles, bases de connaissances, Store." }
}
// Titoli nella lingua dell'interfaccia (il contenuto resta nella lingua del pacchetto).
const others = (texts, language) => Object.fromEntries(Object.entries(texts).filter(([l]) => l !== language))
const guides = {
  it: await build({
    id: GUIDE,
    group: GUIDE,
    file: 'fastchat-guida.fcpack',
    ...guideText.it,
    language: 'it',
    documents: [
      { title: 'FastChat', path: 'README.md' },
      { title: 'Basi di conoscenza', path: 'docs/base-di-conoscenza.md' },
      { title: "Manuale d'uso", path: 'store/sources/manuale.it.md' }
    ],
    i18n: others(guideText, 'it')
  }),
  fr: await build({
    dir: 'store',
    id: `${GUIDE}.fr`,
    group: GUIDE,
    file: storeFile(`${GUIDE}.fr`),
    ...guideText.fr,
    language: 'fr',
    documents: [
      { title: 'FastChat', path: 'docs/fr/README.md' },
      { title: 'Bases de connaissances', path: 'docs/fr/base-de-connaissances.md' },
      { title: "Manuel d'utilisation", path: 'store/sources/manuale.fr.md' }
    ],
    i18n: others(guideText, 'fr')
  }),
  en: await build({
    dir: 'store',
    id: `${GUIDE}.en`,
    group: GUIDE,
    file: storeFile(`${GUIDE}.en`),
    ...guideText.en,
    language: 'en',
    documents: [
      { title: 'FastChat', path: 'docs/en/README.md' },
      { title: 'Knowledge bases', path: 'docs/en/knowledge-base.md' },
      { title: 'User manual', path: 'store/sources/manuale.en.md' }
    ],
    i18n: others(guideText, 'en')
  })
}

// ---------------------------------------------------------------- basi dei ruoli
// Tecniche ed esempi che un ruolo porta con sé (docs/ruoli.md §7). Ogni base è scritta in una lingua, quella del
// ruolo che la richiede: le italiane sono integrate nell'app, le francesi stanno nello Store accanto ai ruoli.
const ROLE_BASES = [
  {
    key: 'assistente',
    source: 'assistente-comportamento',
    name: { it: "Come rispondere a una domanda d'uso", en: 'How to answer a usage question', fr: "Comment répondre à une question d'utilisation" },
    summary: {
      it: "Regole dell'Assistente di FastChat per rispondere a domande sull'uso dell'app.",
      en: 'Rules the FastChat Assistant follows when answering questions about using the app.',
      fr: "Règles de l'Assistant de FastChat pour répondre aux questions sur l'utilisation de l'application."
    }
  },
  {
    key: 'prompt-tecniche',
    source: 'prompt-tecniche',
    name: { it: 'Tecniche di prompt', en: 'Prompt techniques', fr: 'Techniques de prompt' },
    summary: {
      it: "Le tecniche che l'Esperto di prompt engineering applica quando scrive un prompt.",
      en: 'The techniques the Prompt engineering expert applies when writing a prompt.',
      fr: "Les techniques que l'Expert en prompt engineering applique quand il écrit un prompt."
    }
  },
  {
    key: 'prompt-esempi',
    source: 'prompt-esempi',
    name: { it: 'Prompt deboli e migliorati', en: 'Weak and improved prompts', fr: 'Prompts faibles et améliorés' },
    summary: {
      it: "Esempi di prompt riscritti, che l'Esperto di prompt engineering imita.",
      en: 'Examples of rewritten prompts, which the Prompt engineering expert imitates.',
      fr: "Exemples de prompts réécrits, que l'Expert en prompt engineering imite."
    }
  }
]
const roleBases = []
for (const base of ROLE_BASES) {
  for (const language of ['it', 'fr']) {
    const id = `app.fastchat.kb.${base.key}.${language}`
    const builtin = language === 'it'
    const built = await build({
      dir: builtin ? 'packs' : 'store',
      id,
      file: builtin ? `kb-${base.key}-${language}.fcpack` : storeFile(id),
      name: base.name[language],
      description: base.summary[language],
      language,
      documents: [{ title: base.name[language], path: `store/sources/${base.source}.${language}.md` }],
      i18n: Object.fromEntries(Object.keys(base.name).filter((l) => l !== language).map((l) => [l, { name: base.name[l], description: base.summary[l] }]))
    })
    roleBases.push({ id, language, builtin, built, name: base.name, summary: base.summary })
  }
}

// ---------------------------------------------------------------- ruoli
// Un ruolo è un pacchetto di tipo «identity» con role.json (docs/ruoli.md §3.4). Le definizioni stanno in roles/,
// una per lingua. I ruoli italiani sono integrati nell'app; quelli francesi si installano dallo Store, con le
// loro basi. L'app li controlla alla lettura (un test verifica questi file).
async function buildRole({ id, group, name, description, language, source, file, dir = 'packs' }) {
  const definition = JSON.parse(readFileSync(join(root, source), 'utf8'))
  const roleBytes = Buffer.from(JSON.stringify(definition, null, 2), 'utf8')
  const version = `1.0.0+${sha(roleBytes).slice(0, 8)}`
  const manifest = {
    id,
    type: 'identity',
    group,
    name,
    version,
    description,
    author: 'FastChat',
    language,
    license: 'MIT',
    createdAt: 0,
    format: 'fastchat-pack',
    formatVersion: 1,
    files: { 'role.json': sha(roleBytes) }
  }
  const zip = new JSZip()
  const date = new Date('2026-01-01T00:00:00Z')
  zip.file('role.json', roleBytes, { date })
  zip.file('manifest.json', JSON.stringify(manifest, null, 2), { date })
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  const out = join(root, dir, typeof file === 'function' ? file(version) : file)
  mkdirSync(resolve(out, '..'), { recursive: true })
  writeFileSync(out, data)
  console.log(`${out.slice(root.length + 1)}: ruolo «${name}», versione ${version}`)
  return {
    version,
    sha256: sha(data),
    size: data.length,
    path: out.slice(join(root, dir).length + 1).replaceAll('\\', '/'),
    model: definition.mind?.model,
    requires: (definition.bases ?? []).map((b) => b.id)
  }
}

const ROLES = [
  {
    key: 'assistente',
    it: { name: 'Assistente di FastChat', description: "Risponde a domande sull'uso dell'app." },
    fr: { name: 'Assistant de FastChat', description: "Répond aux questions sur l'utilisation de l'application." }
  },
  {
    key: 'prompt',
    it: { name: 'Esperto di prompt engineering', description: 'Scrive e migliora i prompt per modelli locali.' },
    fr: { name: 'Expert en prompt engineering', description: 'Écrit et améliore les prompts pour les modèles locaux.' }
  }
]
const roles = []
for (const role of ROLES) {
  for (const language of ['it', 'fr']) {
    const id = `app.fastchat.ruolo.${role.key}.${language}`
    const builtin = language === 'it'
    const built = await buildRole({
      dir: builtin ? 'packs' : 'store',
      id,
      group: `app.fastchat.ruolo.${role.key}`,
      file: builtin ? `ruolo-${role.key}-${language}.fcpack` : storeFile(id),
      ...role[language],
      language,
      source: `roles/${role.key}.${language}.json`
    })
    roles.push({ id, group: `app.fastchat.ruolo.${role.key}`, language, builtin, built, ...role[language] })
  }
}

// ---------------------------------------------------------------- catalogo locale dello store
// Finché il repository remoto non esiste, lo store legge questo catalogo incluso nell'app (cartella store/),
// con lo stesso formato che avrà quello remoto. Le voci `builtin` sono integrate nell'app (cartella packs/); le
// altre hanno il file in store/items/. La voce «plugin» è un esempio: si vede ma non si installa ancora.
const prompt = await build({
  dir: 'store',
  id: 'it.fastchat.prompt',
  file: storeFile('it.fastchat.prompt'),
  name: 'Scrivere buoni prompt',
  description: 'Indicazioni pratiche per ottenere risposte migliori da un modello locale.',
  language: 'it',
  documents: [{ title: 'Scrivere buoni prompt', path: 'store/sources/prompt.md' }],
  i18n: {
    en: { name: 'Writing good prompts', description: 'Practical advice for getting better answers from a local model.' },
    fr: { name: 'Écrire de bons prompts', description: 'Conseils pratiques pour obtenir de meilleures réponses d’un modèle local.' }
  }
})

/** Dove sta il file di una voce: niente per ciò che è integrato nell'app. */
const fileOf = (built, builtin) => (builtin ? { builtin: true } : { size: built.size, file: built.path, sha256: built.sha256 })
const guideName = Object.fromEntries(Object.entries(guideText).map(([l, x]) => [l, x.name]))
const guideSummary = Object.fromEntries(Object.entries(guideText).map(([l, x]) => [l, x.description]))

const catalog = {
  version: 1,
  updatedAt: '2026-11-13',
  items: [
    ...['it', 'fr', 'en'].map((language) => ({
      id: language === 'it' ? GUIDE : `${GUIDE}.${language}`,
      type: 'knowledge',
      group: GUIDE,
      version: guides[language].version,
      author: 'FastChat',
      language,
      price: 0,
      ...fileOf(guides[language], language === 'it'),
      name: guideName,
      summary: guideSummary
    })),
    {
      id: 'it.fastchat.prompt',
      type: 'knowledge',
      version: prompt.version,
      author: 'FastChat',
      language: 'it',
      price: 0,
      ...fileOf(prompt, false),
      name: { it: 'Scrivere buoni prompt', en: 'Writing good prompts', fr: 'Écrire de bons prompts' },
      summary: {
        it: 'Indicazioni pratiche per ottenere risposte migliori da un modello locale.',
        en: 'Practical advice for getting better answers from a local model.',
        fr: 'Conseils pratiques pour obtenir de meilleures réponses d’un modèle local.'
      }
    },
    // Le basi dei ruoli: si installano con il ruolo, lo Store non le mostra come schede a sé (`forRole`).
    ...roleBases.map((base) => ({
      id: base.id,
      type: 'knowledge',
      forRole: true,
      version: base.built.version,
      author: 'FastChat',
      language: base.language,
      price: 0,
      ...fileOf(base.built, base.builtin),
      name: base.name,
      summary: base.summary
    })),
    ...roles.map((role) => ({
      id: role.id,
      type: 'identity',
      group: role.group,
      version: role.built.version,
      author: 'FastChat',
      language: role.language,
      price: 0,
      ...fileOf(role.built, role.builtin),
      ...(role.built.model ? { model: { name: role.built.model, required: false } } : {}),
      requires: role.built.requires,
      name: role.name,
      summary: role.description
    })),
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
    }
  ]
}
writeFileSync(join(root, 'store', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log(`store/catalog.json: ${catalog.items.length} voci`)
