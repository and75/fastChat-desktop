import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatService } from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, getBase, getRole, listDocuments, listKnowledgeChunks, listMessages, listRoles, setSettings, updateConversation } from '../src/main/db/repo'
import { createEmbedder } from '../src/main/embedder'
import { createKnowledge } from '../src/main/knowledge'
import { readPack, slugify, validPackId, writePack, type PackSigner } from '../src/main/knowledge/pack'
import { createBuiltinRegistry } from '../src/main/knowledge/sources'
import { createOllamaClient } from '../src/main/ollama'
import { GENERALIST_ROLE_ID } from '../src/shared/types'
import { resolveChoices, type Role } from '../src/shared/roles'
import { fakeEmbedding, startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const fixtures = resolve(__dirname, 'fixtures')

function keys(keyId: string): { signer: PackSigner; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    signer: { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string
  }
}

const knowledge = { documents: [{ title: 'Uno', chunks: [{ locator: 'p. 1', text: 'primo pezzo' }, { locator: null, text: 'secondo pezzo' }] }] }
const manifest = { id: 'test.pacchetto', type: 'knowledge' as const, name: 'Prova', version: '1.2.0', createdAt: 1 }

describe('pacchetti: formato, firma, integrità', () => {
  it('id validi e slug dai nomi', () => {
    expect(validPackId('it.fastchat.guida')).toBe(true)
    expect(validPackId('No Spazi')).toBe(false)
    expect(validPackId('ab')).toBe(false)
    expect(slugify('Normativa IVA è qui!')).toBe('normativa-iva-e-qui')
    expect(slugify('***')).toBe('base')
  })

  it('con i vettori: andata e ritorno, il manifest dichiara modello, dimensioni, conteggi e impronte', async () => {
    const vectors = new Float32Array([1, 0, 0, 0, 1, 0])
    const data = await writePack({ manifest: { ...manifest, embedding: { model: 'embeddinggemma', dimensions: 3, digest: 'abc' } }, knowledge, vectors })
    const pack = await readPack(data)
    expect(pack.manifest).toMatchObject({ format: 'fastchat-pack', formatVersion: 1, id: 'test.pacchetto', documents: 1, chunks: 2, embedding: { model: 'embeddinggemma', dimensions: 3, digest: 'abc' } })
    expect(Object.keys(pack.manifest.files).sort()).toEqual(['knowledge.json', 'vectors.bin'])
    expect(pack.knowledge).toEqual(knowledge)
    expect(Array.from(pack.vectors!)).toEqual([1, 0, 0, 0, 1, 0])
    expect(pack.trust).toBe('unsigned')
    // vettori che non corrispondono ai pezzi: non si scrive
    await expect(writePack({ manifest: { ...manifest, embedding: { model: 'm', dimensions: 3 } }, knowledge, vectors: new Float32Array(5) })).rejects.toThrow(/non corrispondono/)
    await expect(writePack({ manifest: { ...manifest, id: 'No' }, knowledge })).rejects.toThrow(/Id del pacchetto/)
  })

  it('firma: verificato con la chiave nota, «sconosciuta» con un\'altra, senza firma «non firmato»', async () => {
    const a = keys('editore')
    const b = keys('altro')
    const signed = await writePack({ manifest, knowledge, signer: a.signer })
    expect((await readPack(signed, { editore: a.publicKey })).trust).toBe('verified')
    expect((await readPack(signed, { altro: b.publicKey })).trust).toBe('unknown')
    expect((await readPack(signed)).trust).toBe('unknown')
    expect((await readPack(await writePack({ manifest, knowledge }), { editore: a.publicKey })).trust).toBe('unsigned')
    // firmato da una chiave diversa da quella registrata con quell'id: alterato
    const forged = await writePack({ manifest, knowledge, signer: { keyId: 'editore', privateKey: b.signer.privateKey } })
    await expect(readPack(forged, { editore: a.publicKey })).rejects.toThrow(/alterato/)
  })

  it('manomissioni: file cambiato, manifest cambiato dopo la firma, file che non è un pacchetto', async () => {
    const a = keys('editore')
    const signed = await writePack({ manifest, knowledge, signer: a.signer })
    // contenuto cambiato: l'impronta nel manifest non torna
    const zip = await JSZip.loadAsync(signed)
    zip.file('knowledge.json', JSON.stringify({ documents: [{ title: 'Altro', chunks: [{ locator: null, text: 'iniettato' }] }] }))
    await expect(readPack(await zip.generateAsync({ type: 'nodebuffer' }), { editore: a.publicKey })).rejects.toThrow(/alterato/)
    // manifest riscritto con la nuova impronta: la firma non torna
    const zip2 = await JSZip.loadAsync(signed)
    const m = JSON.parse(await zip2.file('manifest.json')!.async('string'))
    m.name = 'Nome cambiato'
    zip2.file('manifest.json', JSON.stringify(m))
    await expect(readPack(await zip2.generateAsync({ type: 'nodebuffer' }), { editore: a.publicKey })).rejects.toThrow(/alterato/)
    await expect(readPack(Buffer.from('non uno zip'))).rejects.toThrow(/non è un pacchetto/)
    const empty = new JSZip()
    empty.file('altro.txt', 'x')
    await expect(readPack(await empty.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/non è un pacchetto/)
    // versione del formato più nuova dell'app
    const zip3 = await JSZip.loadAsync(await writePack({ manifest, knowledge }))
    const m3 = JSON.parse(await zip3.file('manifest.json')!.async('string'))
    m3.formatVersion = 99
    zip3.file('manifest.json', JSON.stringify(m3))
    await expect(readPack(await zip3.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/versione più recente/)
  })
})

describe('pacchetti integrati nell\'app', () => {
  it('la Guida di FastChat (packs/) si legge con il lettore dell\'app: solo testo, pezzi entro il limite, con locatori', async () => {
    const pack = await readPack(readFileSync(resolve(__dirname, '../packs/fastchat-guida.fcpack')))
    expect(pack.manifest).toMatchObject({ id: 'app.fastchat.guida', type: 'knowledge', name: 'Guida di FastChat', language: 'it' })
    expect(pack.manifest.version).toMatch(/^1\.0\.0\+[0-9a-f]{8}$/)
    expect(pack.manifest.embedding).toBeUndefined()
    expect(pack.vectors).toBeNull()
    const docs = pack.knowledge!.documents
    expect(docs.map((d) => d.title)).toEqual(['FastChat', 'Basi di conoscenza'])
    const chunks = docs.flatMap((d) => d.chunks)
    expect(chunks.length).toBeGreaterThan(10)
    expect(chunks.every((c) => c.text.length > 0 && c.text.length <= 1600)).toBe(true)
    expect(chunks.some((c) => c.locator?.includes('Scelta del contenuto'))).toBe(true)
  })
  it('i ruoli in bozza (packs/) si leggono con il lettore dell\'app e rispettano le regole dei ruoli', async () => {
    for (const [file, id, base] of [
      ['ruolo-assistente-it.fcpack', 'app.fastchat.ruolo.assistente.it', 'app.fastchat.guida'],
      ['ruolo-prompt-it.fcpack', 'app.fastchat.ruolo.prompt.it', 'it.fastchat.prompt']
    ]) {
      const pack = await readPack(readFileSync(resolve(__dirname, '../packs', file)))
      expect(pack.manifest).toMatchObject({ id, type: 'identity', language: 'it' })
      expect(pack.manifest.name).toMatch(/\(bozza\)$/)
      expect(pack.role!.parameters!.length).toBeGreaterThan(4)
      expect(pack.role!.bases).toEqual([expect.objectContaining({ id: base })])
    }
  })
})


describe('pacchetti: esporta, installa, modello dichiarato', () => {
  let fake: FakeOllama
  let h: DbHandle
  let dir: string
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 4096', chunks: [{ content: 'Ok.' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'], digest: 'digest-gemma' },
      { name: 'altro-embed', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    dir = mkdtempSync(join(tmpdir(), 'fastchat-pack-'))
  })
  afterEach(() => {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const service = (db = h.db, extra: Partial<Parameters<typeof createKnowledge>[0]> = {}) => {
    const ollama = createOllamaClient(() => fake.url)
    const embedder = createEmbedder({ db, ollama })
    return createKnowledge({ db, embedder, registry: createBuiltinRegistry(), packsDir: join(dir, 'installati'), ...extra })
  }
  const embeds = () => fake.requests.filter((r) => r.path === '/api/embed').map((r) => r.body as { model: string; input: string[] })

  /** Una base con due documenti, esportata come pacchetto con i vettori. */
  async function exported(signer?: PackSigner) {
    const k = service()
    const base = await k.createBase('Archivio aziendale')
    await k.addFiles(base, [join(fixtures, 'relazione.txt'), join(fixtures, 'manuale.md')])
    await k.wait(base.id)
    const doc = (await listDocuments(h.db, base.id))[1]
    await k.setPinned(base, doc.id, true)
    const out = await k.exportBase(base.id, { author: 'Andrea', signer })
    const path = join(dir, out.fileName)
    writeFileSync(path, out.data)
    return { k, base, path, out }
  }

  it('esporta: il pacchetto dichiara il modello di embedding con dimensioni e impronta, e porta testo e vettori', async () => {
    const { out, base, k } = await exported()
    expect(out.fileName).toBe('archivio-aziendale-1.0.0.fcpack')
    const pack = await readPack(out.data)
    expect(pack.manifest).toMatchObject({
      id: `local.archivio-aziendale-${base.id.slice(0, 8)}`,
      type: 'knowledge',
      name: 'Archivio aziendale',
      version: '1.0.0',
      author: 'Andrea',
      documents: 2,
      chunks: 5,
      embedding: { model: 'embeddinggemma', dimensions: 64, digest: 'digest-gemma' }
    })
    expect(pack.knowledge!.documents.map((d) => [d.title, d.source, d.pinned, d.chunks.length])).toEqual([['relazione', 'txt', undefined, 1], ['manuale', 'md', true, 4]])
    expect(pack.knowledge!.documents[1].chunks[2].locator).toBe('Manuale › Installazione › Windows')
    expect(pack.vectors).toHaveLength(5 * 64)
    // si esportano solo le basi locali pronte
    const empty = await k.createBase('Vuota')
    await expect(k.exportBase(empty.id)).rejects.toThrow(/non ha documenti/)
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await expect(k.exportBase((await k.status(conv)).baseId!)).rejects.toThrow(/non trovata/)
  })

  it('installa su un\'altra macchina: nessun embedding da calcolare, base di sola lettura con il modello fissato, risposte con le fonti', async () => {
    const { path } = await exported()
    const other = openDatabase(':memory:')
    await runMigrations(other, resolve(__dirname, '../drizzle'))
    try {
      const k = service(other.db)
      const seen = await k.inspectPack(path)
      expect(seen).toMatchObject({ trust: 'unsigned', installedVersion: null, modelInstalled: true })
      expect(seen.manifest.name).toBe('Archivio aziendale')
      // senza firma riconosciuta serve la conferma esplicita
      await expect(k.installPack(path)).rejects.toThrow(/conferma esplicita/)
      const before = embeds().length
      const base = await k.installPack(path, { allowUntrusted: true })
      expect(embeds().length).toBe(before)
      expect(base).toMatchObject({ name: 'Archivio aziendale', origin: 'package', version: '1.0.0', embeddingModel: 'embeddinggemma', model: 'embeddinggemma', modelInstalled: true, documents: 2, ready: 2 })
      expect(base.meta).toMatchObject({ author: 'Andrea', dimensions: 64, digest: 'digest-gemma', trust: 'unsigned' })
      expect(base.packageId).toMatch(/^local\.archivio-aziendale-/)
      const docs = await listDocuments(other.db, base.id)
      expect(docs.map((d) => [d.title, d.status, d.source, d.chunkCount, d.pinned])).toEqual([['relazione', 'ready', 'package', 1, false], ['manuale', 'ready', 'package', 4, true]])
      expect(await listKnowledgeChunks(other.db, docs.map((d) => d.id), 'embeddinggemma')).toHaveLength(5)
      // una copia del pacchetto resta tra quelli installati
      expect(readFileSync(join(dir, 'installati', `${base.packageId}.fcpack`)).length).toBeGreaterThan(100)
      // sola lettura
      await expect(k.addFiles(base, [join(fixtures, 'relazione.txt')])).rejects.toThrow(/viene da un pacchetto/)
      await expect(k.remove(base, docs[0].id)).rejects.toThrow(/viene da un pacchetto/)
      await expect(k.connect(base, 'folder', { path: dir })).rejects.toThrow(/viene da un pacchetto/)
      await expect(k.exportBase(base.id)).rejects.toThrow(/solo le basi della libreria create qui/)

      // collegata a una conversazione: i vettori del pacchetto servono la ricerca (budget stretto → estratti)
      const conv = await createConversation(other.db, { model: 'chat' })
      await k.link(conv, base.id)
      const q = 'Come usare il programma di installazione su Windows?'
      const asked: string[] = []
      const found = await k.recall(conv, { text: q, vector: async (m) => (asked.push(m), fakeEmbedding(q)) }, 100, 4)
      expect(asked).toEqual(['embeddinggemma'])
      // il manuale è «intero» nel pacchetto: va completo, con il nome della base; il resto non entra nel budget
      expect(found.refs.map((r) => [r.title, r.whole, r.base])).toEqual([['manuale', true, 'Archivio aziendale']])
      // e la chat risponde citando la base
      const ollama = createOllamaClient(() => fake.url)
      const chat = createChatService({ db: other.db, ollama, knowledge: k, embedder: k.embedder, emit: () => undefined })
      const sent = await chat.send({}, conv.id, 'Quante persone ha assunto la sede di Torino?')
      await chat.wait(sent.streamId)
      expect((await listMessages(other.db, conv.id)).at(-1)!.knowledgeRefs?.map((r) => r.base)).toEqual(['Archivio aziendale', 'Archivio aziendale'])

      // nuova versione dello stesso pacchetto: stessa base (resta collegata), contenuto sostituito
      const pack = await readPack(readFileSync(path))
      const v2 = await writePack({ manifest: { ...pack.manifest, version: '2.0.0', name: 'Archivio 2026' }, knowledge: { documents: [pack.knowledge!.documents[0]] }, vectors: pack.vectors!.slice(0, 64) })
      const path2 = join(dir, 'v2.fcpack')
      writeFileSync(path2, v2)
      expect((await k.inspectPack(path2)).installedVersion).toBe('1.0.0')
      const updated = await k.installPack(path2, { allowUntrusted: true })
      expect(updated).toMatchObject({ id: base.id, name: 'Archivio 2026', version: '2.0.0', documents: 1, ready: 1, conversations: 1 })
      expect((await k.status(conv)).linked.map((l) => l.name)).toEqual(['Archivio 2026'])
    } finally {
      other.close()
    }
  })

  it('firma riconosciuta: si installa senza conferma; la fiducia resta scritta sulla base', async () => {
    const editor = keys('fastchat')
    const { path } = await exported(editor.signer)
    const k = service(h.db, { trustedKeys: { fastchat: editor.publicKey } })
    expect((await k.inspectPack(path)).trust).toBe('verified')
    const base = await k.installPack(path)
    expect(base.meta?.trust).toBe('verified')
    // integrato nell'app: fidato anche senza firma
    const plain = join(dir, 'plain.fcpack')
    writeFileSync(plain, await writePack({ manifest: { ...manifest, id: 'app.integrato' }, knowledge }))
    expect((await service().installPack(plain, { builtin: true })).meta?.trust).toBe('builtin')
  })

  it('modello dichiarato non installato: la base si installa ma non è usabile finché il modello manca; il cambio delle Impostazioni non la tocca', async () => {
    const vectors = new Float32Array(2 * 64)
    vectors.set(fakeEmbedding('primo pezzo'), 0)
    vectors.set(fakeEmbedding('secondo pezzo'), 64)
    const path = join(dir, 'raro.fcpack')
    writeFileSync(path, await writePack({ manifest: { ...manifest, embedding: { model: 'modello-raro', dimensions: 64 } }, knowledge, vectors }))
    const k = service()
    expect((await k.inspectPack(path)).modelInstalled).toBe(false)
    const base = await k.installPack(path, { allowUntrusted: true })
    expect(base).toMatchObject({ model: 'modello-raro', modelInstalled: false, documents: 1, ready: 1 })
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.link(conv, base.id)
    expect(await k.hasReady(conv.id)).toBe(false)
    expect((await k.status(conv)).ready).toBe(0)
    expect((await k.status(conv)).linked[0]).toMatchObject({ modelInstalled: false, model: 'modello-raro' })
    // cambiare il modello delle Impostazioni non reindicizza una base con il modello dichiarato
    await setSettings(h.db, { embeddingModel: 'altro-embed' })
    const before = embeds().length
    await k.ensureModel(conv)
    await k.wait(conv.id)
    expect(embeds().length).toBe(before)
    expect((await getBase(h.db, base.id))!.embeddingModel).toBe('modello-raro')
  })

  it('basi con modelli diversi nella stessa conversazione: la domanda diventa vettore una volta per modello, i punteggi si uniscono', async () => {
    // pacchetto fatto con «altro-embed», documenti della conversazione con embeddinggemma
    const texts = Array.from({ length: 6 }, (_, i) => `Capitolo ${i}: le penali contrattuali per ritardo valgono ${i} per cento al giorno secondo la clausola ${i}.`)
    const vectors = new Float32Array(texts.length * 64)
    texts.forEach((x, i) => vectors.set(fakeEmbedding(x), i * 64))
    const path = join(dir, 'penali.fcpack')
    writeFileSync(path, await writePack({ manifest: { ...manifest, id: 'test.penali', name: 'Penali', embedding: { model: 'altro-embed', dimensions: 64 } }, knowledge: { documents: texts.map((text, i) => ({ title: `Capitolo ${i}`, chunks: [{ locator: null, text }] })) }, vectors }))
    const k = service()
    const base = await k.installPack(path, { allowUntrusted: true })
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.link(conv, base.id)
    await k.addFiles(conv, [join(fixtures, 'manuale.md')])
    await k.wait(conv.id)
    const q = 'Quali penali contrattuali per ritardo prevede la clausola, e come si fa la installazione su Windows?'
    const asked: string[] = []
    const found = await k.recall(conv, { text: q, vector: async (m) => (asked.push(m), fakeEmbedding(q)) }, 120, 4)
    expect(asked.sort()).toEqual(['altro-embed', 'embeddinggemma'])
    const titles = found.refs.map((r) => r.title)
    expect(titles.some((x) => x.startsWith('Capitolo'))).toBe(true)
    expect(titles).toContain('manuale')
    // nella chat: due richieste di embedding della domanda, una per modello
    const ollama = createOllamaClient(() => fake.url)
    const chat = createChatService({ db: h.db, ollama, knowledge: k, embedder: k.embedder, emit: () => undefined })
    // memoria piccola e un quarto ai documenti: non stanno per intero, servono gli estratti
    const conv2 = await createConversation(h.db, { model: 'chat', numCtx: 512, knowledgeShare: 0.25 })
    await k.link(conv2, base.id)
    await k.addFiles(conv2, [join(fixtures, 'manuale.md')])
    await k.wait(conv2.id)
    const before = embeds().length
    const sent = await chat.send({}, conv2.id, q)
    await chat.wait(sent.streamId)
    expect(embeds().slice(before).map((e) => e.model).sort()).toEqual(['altro-embed', 'embeddinggemma'])
  })

  it('pacchetto di solo testo: si indicizza con il modello dell\'utente; se il modello manca aspetta, e riparte quando arriva', async () => {
    const path = join(dir, 'testo.fcpack')
    writeFileSync(path, await writePack({ manifest: { ...manifest, id: 'test.testo', name: 'Solo testo' }, knowledge }))
    await setSettings(h.db, { embeddingModel: 'non-ancora' })
    const k = service()
    const base = await k.installPack(path, { builtin: true })
    await k.wait(base.id)
    expect(base).toMatchObject({ embeddingModel: null, model: 'non-ancora', modelInstalled: false })
    expect((await listDocuments(h.db, base.id)).map((d) => d.status)).toEqual(['pending'])
    // il modello arriva (qui: si torna a uno installato): i documenti in attesa si indicizzano
    await setSettings(h.db, { embeddingModel: 'embeddinggemma' })
    await k.resumePending()
    await k.wait(base.id)
    const docs = await listDocuments(h.db, base.id)
    expect(docs.map((d) => [d.title, d.status, d.chunkCount])).toEqual([['Uno', 'ready', 2]])
    const chunks = await listKnowledgeChunks(h.db, [docs[0].id], 'embeddinggemma')
    expect(chunks.map((c) => c.locator).sort()).toEqual([null, 'p. 1'])
    // segue le Impostazioni: cambiando modello si reindicizza dal pacchetto salvato
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.link(conv, base.id)
    await setSettings(h.db, { embeddingModel: 'altro-embed' })
    await k.ensureModel(conv)
    await k.wait(conv.id)
    expect(await listKnowledgeChunks(h.db, [docs[0].id], 'altro-embed')).toHaveLength(2)
  })

  it('pacchetti integrati: installati all\'avvio, aggiornati solo se la versione cambia; «collega alle nuove conversazioni»', async () => {
    const builtin = join(dir, 'packs')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(builtin)
    writeFileSync(join(builtin, 'guida.fcpack'), await writePack({ manifest: { ...manifest, id: 'app.guida', name: 'Guida' }, knowledge }))
    writeFileSync(join(builtin, 'rotto.fcpack'), 'non uno zip')
    const k = service()
    await k.installBuiltin(builtin)
    await k.installBuiltin(builtin)
    let bases = await k.listBases()
    expect(bases.map((b) => [b.name, b.version, b.meta?.trust])).toEqual([['Guida', '1.2.0', 'builtin']])
    await k.wait(bases[0].id)
    const firstDoc = (await listDocuments(h.db, bases[0].id))[0].id
    await k.installBuiltin(builtin) // stessa versione: non reinstalla
    expect((await listDocuments(h.db, bases[0].id))[0].id).toBe(firstDoc)
    writeFileSync(join(builtin, 'guida.fcpack'), await writePack({ manifest: { ...manifest, id: 'app.guida', name: 'Guida', version: '1.3.0' }, knowledge }))
    await k.installBuiltin(builtin)
    bases = await k.listBases()
    expect(bases.map((b) => b.version)).toEqual(['1.3.0'])
    await k.wait(bases[0].id)
    // collega alle nuove conversazioni
    await k.renameBase(bases[0].id, { autoLink: true })
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.linkDefaults(conv)
    expect((await k.status(conv)).linked.map((l) => l.name)).toEqual(['Guida'])
    await k.renameBase(bases[0].id, { autoLink: false })
    const conv2 = await createConversation(h.db, { model: 'chat' })
    await k.linkDefaults(conv2)
    expect((await k.status(conv2)).linked).toEqual([])
  })

  // ---------------------------------------------------------------- ruoli (docs/ruoli-piano.md, passo 2.4)

  const promptRole = JSON.parse(readFileSync(join(fixtures, 'roles', 'prompt.it.json'), 'utf8')) as Role
  const roleManifest = { id: 'app.fastchat.ruolo.prompt.it', group: 'app.fastchat.ruolo.prompt', language: 'it', type: 'identity' as const, name: 'Esperto di prompt engineering', description: 'Scrive e migliora i prompt.', version: '1.0.0', createdAt: 1 }
  const TECNICHE = 'app.fastchat.kb.prompt-tecniche.it'
  const ESEMPI = 'app.fastchat.kb.prompt-esempi.it'
  const basePack = (id: string, name: string, version = '1.0.0') => writePack({ manifest: { ...manifest, id, name, version }, knowledge })
  /** Scrive in una cartella il pacchetto del ruolo e, se richiesti, quelli delle sue basi. */
  async function roleFolder(name: string, opts: { bases?: string[]; role?: Role; manifest?: Partial<typeof roleManifest>; signer?: PackSigner } = {}): Promise<string> {
    const { mkdirSync } = await import('node:fs')
    const folder = join(dir, name)
    mkdirSync(folder, { recursive: true })
    for (const id of opts.bases ?? []) writeFileSync(join(folder, `${id}.fcpack`), await basePack(id, id === TECNICHE ? 'Tecniche di prompt' : 'Esempi di prompt'))
    const path = join(folder, 'ruolo.fcpack')
    writeFileSync(path, await writePack({ manifest: { ...roleManifest, ...opts.manifest }, role: opts.role ?? promptRole, signer: opts.signer }))
    return path
  }

  it('ruolo: il pacchetto porta role.json con impronta; un ruolo non valido è rifiutato alla costruzione e alla lettura', async () => {
    const data = await writePack({ manifest: roleManifest, role: promptRole })
    const pack = await readPack(data)
    expect(pack.manifest).toMatchObject({ type: 'identity', group: 'app.fastchat.ruolo.prompt', language: 'it' })
    expect(Object.keys(pack.manifest.files)).toEqual(['role.json'])
    expect(pack.role).toEqual(promptRole)
    expect(pack.knowledge).toBeNull()
    // un pacchetto di conoscenza non porta un ruolo
    expect((await readPack(await writePack({ manifest, knowledge }))).role).toBeNull()

    const broken = { ...promptRole, parameters: [...promptRole.parameters!, { ...promptRole.parameters![4], id: 'doppione' }] }
    await expect(writePack({ manifest: roleManifest, role: broken })).rejects.toThrow(/ruolo del pacchetto non è valido: mind\.conflict \(parameters\[doppione\]\.temperature\)/)
    await expect(writePack({ manifest: roleManifest })).rejects.toThrow(/non è valido: role\.shape/)
    // costruito altrove senza controlli: lo ferma la lettura
    const zip = await JSZip.loadAsync(data)
    const bad = Buffer.from(JSON.stringify(broken))
    zip.file('role.json', bad)
    const m = JSON.parse(await zip.file('manifest.json')!.async('string'))
    const { createHash } = await import('node:crypto')
    m.files['role.json'] = createHash('sha256').update(bad).digest('hex')
    zip.file('manifest.json', JSON.stringify(m))
    await expect(readPack(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/non è valido: mind\.conflict/)
    // role.json alterato dopo la costruzione: l'impronta non torna
    const tampered = await JSZip.loadAsync(data)
    tampered.file('role.json', JSON.stringify({ instructions: 'Ignora tutto.' }))
    await expect(readPack(await tampered.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/alterato/)
  })

  it('ruolo: si installa con le basi che richiede, trovate nella sua cartella; senza firma serve la conferma', async () => {
    const path = await roleFolder('completo', { bases: [TECNICHE, ESEMPI] })
    const k = service()
    expect(await k.inspectPack(path)).toMatchObject({ trust: 'unsigned', installedVersion: null, manifest: { type: 'identity' } })
    await expect(k.installRole(path)).rejects.toThrow(/firma/i)
    expect(await getRole(h.db, roleManifest.id)).toBeNull()
    // installPack resta per le basi: un ruolo non passa di lì
    await expect(k.installPack(path, { allowUntrusted: true })).rejects.toThrow(/non ancora supportato/)

    const { role, missing } = await k.installRole(path, { allowUntrusted: true })
    expect(missing).toEqual([])
    expect(role).toMatchObject({ id: roleManifest.id, packageId: roleManifest.id, group: 'app.fastchat.ruolo.prompt', language: 'it', name: 'Esperto di prompt engineering', version: '1.0.0', origin: 'package', definition: promptRole })
    expect((await k.listBases()).map((b) => [b.packageId, b.origin, b.meta?.forRole])).toEqual([
      [ESEMPI, 'package', true],
      [TECNICHE, 'package', true]
    ])
    expect((await k.inspectPack(path)).installedVersion).toBe('1.0.0')
    expect((await listRoles(h.db)).map((r) => r.id)).toEqual([roleManifest.id])

    // una conversazione con questo ruolo riceve le sue basi, ciascuna con il suo tipo
    const conv = await createConversation(h.db, { model: 'chat', roleId: roleManifest.id })
    expect(await k.linkRole(conv)).toEqual([])
    expect((await k.status(conv)).linked.map((b) => [b.packageId, b.purpose]).sort()).toEqual([
      [ESEMPI, 'examples'],
      [TECNICHE, 'behavior']
    ])
    expect(await k.roleHealth(conv)).toEqual({ roleMissing: false, missingBases: [] })
  })

  it('ruolo firmato: si installa senza conferma; le basi senza firma riconosciuta restano fuori e sono segnalate', async () => {
    const editor = keys('fastchat')
    const path = await roleFolder('firmato', { bases: [TECNICHE], signer: editor.signer })
    const k = service(h.db, { trustedKeys: { fastchat: editor.publicKey } })
    const { missing } = await k.installRole(path)
    // la base c'è nella cartella ma non è firmata: senza conferma non entra; l'altra non c'è proprio
    expect(missing).toEqual([TECNICHE, ESEMPI])
    expect(await k.listBases()).toEqual([])
  })

  it('base mancante: il ruolo si installa comunque; l\'avviso sparisce quando la base arriva, e la conversazione la riceve', async () => {
    const path = await roleFolder('parziale', { bases: [TECNICHE] })
    const k = service()
    expect((await k.installRole(path, { allowUntrusted: true })).missing).toEqual([ESEMPI])
    const conv = await createConversation(h.db, { model: 'chat', roleId: roleManifest.id })
    expect(await k.roleHealth(conv)).toEqual({ roleMissing: false, missingBases: [ESEMPI] })
    expect((await k.status(conv)).linked.map((b) => b.packageId)).toEqual([TECNICHE])
    // la base arriva dopo, come un normale pacchetto
    const late = join(dir, 'esempi.fcpack')
    writeFileSync(late, await basePack(ESEMPI, 'Esempi di prompt'))
    await k.installPack(late, { allowUntrusted: true })
    expect(await k.roleHealth(conv)).toEqual({ roleMissing: false, missingBases: [] })
    expect((await k.status(conv)).linked.map((b) => [b.packageId, b.purpose]).sort()).toEqual([
      [ESEMPI, 'examples'],
      [TECNICHE, 'behavior']
    ])
    // il Generalista non ha nulla da segnalare
    expect(await k.roleHealth(await createConversation(h.db, { model: 'chat' }))).toEqual({ roleMissing: false, missingBases: [] })
  })

  it('aggiornamento: la versione nuova sostituisce la definizione; le scelte che il ruolo non conosce più tornano al predefinito', async () => {
    const k = service()
    await k.installRole(await roleFolder('v1', { bases: [TECNICHE, ESEMPI] }), { allowUntrusted: true })
    const conv = await createConversation(h.db, { model: 'chat', roleId: roleManifest.id, roleParams: { stile: 'dettagliato', intervento: 'spiega' } })
    const next: Role = { ...promptRole, parameters: promptRole.parameters!.map((p) => (p.id === 'intervento' ? { ...p, options: p.options.filter((o) => o.id !== 'spiega') } : p)) }
    const { role, missing } = await k.installRole(await roleFolder('v2', { role: next, manifest: { version: '1.1.0' } }), { allowUntrusted: true })
    expect(missing).toEqual([])
    expect(role).toMatchObject({ version: '1.1.0', definition: next })
    expect(await listRoles(h.db)).toHaveLength(1)
    expect((await k.listBases()).length).toBe(2)
    const saved = (await updateConversation(h.db, conv.id, {})).roleParams
    expect(saved).toEqual({ stile: 'dettagliato', intervento: 'spiega' })
    expect(resolveChoices(role.definition, saved)).toMatchObject({ stile: 'dettagliato', intervento: 'migliora' })
  })

  it('rimozione: le basi arrivate con il ruolo se ne vanno solo se nessun altro ruolo le richiede; la conversazione resta', async () => {
    const k = service()
    await k.installRole(await roleFolder('uno', { bases: [TECNICHE, ESEMPI] }), { allowUntrusted: true })
    // un secondo ruolo che condivide le tecniche
    const other: Role = { instructions: 'Sei un revisore di prompt.', bases: [{ id: TECNICHE, purpose: 'behavior' }] }
    await k.installRole(await roleFolder('due', { role: other, manifest: { id: 'test.ruolo.revisore', name: 'Revisore' } }), { allowUntrusted: true })
    // una base installata per conto proprio, che un ruolo richiede: non è «del ruolo»
    const own = join(dir, 'mia.fcpack')
    writeFileSync(own, await basePack('test.mia', 'Mia'))
    await k.installPack(own, { allowUntrusted: true })
    const third: Role = { instructions: 'Sei un archivista.', bases: [{ id: 'test.mia', purpose: 'documents' }] }
    await k.installRole(await roleFolder('tre', { role: third, manifest: { id: 'test.ruolo.archivista', name: 'Archivista' } }), { allowUntrusted: true })

    const conv = await createConversation(h.db, { model: 'chat', roleId: roleManifest.id, situation: 'Lavoro su un prompt' })
    await k.linkRole(conv)
    expect(await k.removeRole(roleManifest.id)).toEqual({ removedBases: [ESEMPI] })
    expect((await k.listBases()).map((b) => b.packageId).sort()).toEqual([TECNICHE, 'test.mia'])
    // la conversazione resta, con la sua situazione; l'app sa dire che il ruolo non c'è più
    expect(await k.roleHealth((await updateConversation(h.db, conv.id, {}))!)).toEqual({ roleMissing: true, missingBases: [] })
    expect((await k.status(conv)).linked.map((b) => b.packageId)).toEqual([TECNICHE])

    expect(await k.removeRole('test.ruolo.revisore')).toEqual({ removedBases: [TECNICHE] })
    expect(await k.removeRole('test.ruolo.archivista')).toEqual({ removedBases: [] })
    expect((await k.listBases()).map((b) => b.packageId)).toEqual(['test.mia'])
    await expect(k.removeRole('test.ruolo.archivista')).rejects.toThrow(/Ruolo non trovato/)
  })

  it('ruoli integrati: installati all\'avvio dopo le basi, aggiornati solo se la versione cambia, non rimovibili; il Generalista non si sostituisce', async () => {
    const { mkdirSync } = await import('node:fs')
    const builtin = join(dir, 'packs')
    mkdirSync(builtin)
    // in ordine alfabetico il ruolo viene prima delle sue basi: l'app installa comunque prima le basi
    writeFileSync(join(builtin, 'a-ruolo.fcpack'), await writePack({ manifest: roleManifest, role: promptRole }))
    writeFileSync(join(builtin, 'b-tecniche.fcpack'), await basePack(TECNICHE, 'Tecniche di prompt'))
    writeFileSync(join(builtin, 'c-esempi.fcpack'), await basePack(ESEMPI, 'Esempi di prompt'))
    writeFileSync(join(builtin, 'd-finto-generalista.fcpack'), await writePack({ manifest: { ...roleManifest, id: GENERALIST_ROLE_ID }, role: { instructions: 'Non sono il Generalista.' } }))
    const k = service()
    await k.installBuiltin(builtin)
    expect((await listRoles(h.db)).map((r) => [r.id, r.origin, r.version])).toEqual([[roleManifest.id, 'builtin', '1.0.0']])
    // le basi sono quelle dell'app, non «del ruolo»: restano anche senza di lui
    expect((await k.listBases()).map((b) => [b.packageId, b.meta?.trust, b.meta?.forRole])).toEqual([
      [ESEMPI, 'builtin', undefined],
      [TECNICHE, 'builtin', undefined]
    ])
    await expect(k.removeRole(roleManifest.id)).rejects.toThrow(/integrato nell'app non si elimina/)
    const before = (await getRole(h.db, roleManifest.id))!.createdAt
    await k.installBuiltin(builtin)
    expect((await getRole(h.db, roleManifest.id))!.createdAt).toBe(before)
    writeFileSync(join(builtin, 'a-ruolo.fcpack'), await writePack({ manifest: { ...roleManifest, version: '1.1.0' }, role: { ...promptRole, instructions: 'Sei un esperto di prompt.' } }))
    await k.installBuiltin(builtin)
    expect(await getRole(h.db, roleManifest.id)).toMatchObject({ version: '1.1.0', definition: { instructions: 'Sei un esperto di prompt.' } })
  })
})
