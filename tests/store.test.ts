import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, getRole, listDocuments, listRoles } from '../src/main/db/repo'
import { createEmbedder } from '../src/main/embedder'
import { createKnowledge } from '../src/main/knowledge'
import { writePack } from '../src/main/knowledge/pack'
import { createBuiltinRegistry } from '../src/main/knowledge/sources'
import { createOllamaClient } from '../src/main/ollama'
import { createStore } from '../src/main/store'
import { setLocale } from '../src/shared/i18n'
import { compareVersions, localize, matchesQuery, parseCatalog, storeEntries, storeGroups, storeLanguages, STORE_CATEGORIES, type StoreCatalog, type StoreItem } from '../src/shared/store'
import type { Role } from '../src/shared/roles'
import { fakeEmbedding, startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const repoStore = resolve(__dirname, '../store')

describe('store: catalogo e stati', () => {
  it('categorie nell\'ordine dello store; testi nella lingua dell\'interfaccia con ripiego', () => {
    expect(STORE_CATEGORIES).toEqual(['identity', 'knowledge', 'plugin', 'bundle'])
    expect(localize({ it: 'Guida', en: 'Guide', fr: 'Guide FR' }, 'fr')).toBe('Guide FR')
    expect(localize({ it: 'Guida', en: 'Guide' }, 'fr')).toBe('Guida')
    expect(localize({ en: 'Guide' }, 'it')).toBe('Guide')
    expect(localize('Uguale', 'en')).toBe('Uguale')
    expect(localize(undefined, 'it')).toBe('')
  })

  it('confronto di versioni: numerico, e contenuto diverso a parità di numero vale come aggiornamento', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0+aaa', '1.0.0+aaa')).toBe(0)
    expect(compareVersions('1.0.0+bbb', '1.0.0+aaa')).toBeGreaterThan(0)
  })

  it('parseCatalog scarta le voci malformate; un catalogo che non lo è viene rifiutato', () => {
    const c = parseCatalog({ version: 1, updatedAt: 'x', items: [{ id: 'a.b.c', type: 'knowledge', name: 'A', version: '1' }, { id: 'NO', type: 'knowledge', name: 'B', version: '1' }, { id: 'a.b.d', type: 'altro', name: 'C', version: '1' }, null] })
    expect(c.items.map((i) => i.id)).toEqual(['a.b.c'])
    expect(() => parseCatalog({ items: 'no' })).toThrow()
  })

  it('stati: installato, aggiornamento, installabile, presto; basi e ruoli si installano, i pacchetti seguono ciò che contengono', () => {
    const catalog: StoreCatalog = {
      version: 1,
      updatedAt: '',
      items: [
        { id: 'k.builtin', type: 'knowledge', name: 'G', summary: '', version: '9', builtin: true },
        { id: 'k.nuova', type: 'knowledge', name: 'N', summary: '', version: '1.0.0', file: 'n.fcpack' },
        { id: 'k.vecchia', type: 'knowledge', name: 'V', summary: '', version: '2.0.0', file: 'v.fcpack' },
        { id: 'k.senza-file', type: 'knowledge', name: 'S', summary: '', version: '1.0.0' },
        { id: 'i.identita', type: 'identity', name: 'I', summary: '', version: '1.0.0', file: 'i.fcpack' },
        { id: 'p.plugin', type: 'plugin', name: 'P', summary: '', version: '1.0.0' },
        { id: 'b.misto', type: 'bundle', name: 'B', summary: '', version: '1.0.0', contains: ['i.identita', 'k.nuova'] },
        { id: 'b.fatto', type: 'bundle', name: 'B2', summary: '', version: '1.0.0', contains: ['k.builtin', 'i.identita'] },
        { id: 'b.solo-identita', type: 'bundle', name: 'B3', summary: '', version: '1.0.0', contains: ['i.identita'] },
        { id: 'b.solo-plugin', type: 'bundle', name: 'B4', summary: '', version: '1.0.0', contains: ['p.plugin'] },
        { id: 'i.app', type: 'identity', name: 'IA', summary: '', version: '1.0.0', builtin: true },
        { id: 'i.vecchia', type: 'identity', name: 'IV', summary: '', version: '2.0.0', file: 'iv.fcpack' }
      ]
    }
    const entries = storeEntries(catalog, new Map([['k.builtin', '1'], ['k.vecchia', '1.5.0'], ['i.app', '1.0.0'], ['i.vecchia', '1.0.0']]))
    expect(entries.map((e) => [e.id, e.state, e.removable])).toEqual([
      ['k.builtin', 'installed', false],
      ['k.nuova', 'available', false],
      ['k.vecchia', 'update', true],
      ['k.senza-file', 'soon', false],
      ['i.identita', 'available', false],
      ['p.plugin', 'soon', false],
      ['b.misto', 'available', false],
      ['b.fatto', 'available', false],
      ['b.solo-identita', 'available', false],
      ['b.solo-plugin', 'soon', false],
      // un ruolo integrato nell'app non si rimuove; uno installato dallo Store sì, e si aggiorna
      ['i.app', 'installed', false],
      ['i.vecchia', 'update', true]
    ])
    expect(entries[2].installedVersion).toBe('1.5.0')
  })

  it('il catalogo incluso nell\'app è valido: basi e plugin con i titoli nelle tre lingue, ruoli nella loro lingua con il gruppo, file con l\'impronta dichiarata', () => {
    const catalog = parseCatalog(JSON.parse(readFileSync(join(repoStore, 'catalog.json'), 'utf8')))
    expect(new Set(catalog.items.map((i) => i.type))).toEqual(new Set(['knowledge', 'identity', 'plugin']))
    for (const item of catalog.items) {
      // un ruolo è scritto in una lingua: titolo e descrizione sono quelli, non tradotti
      if (item.type === 'identity') expect(item).toMatchObject({ builtin: true, language: 'it', group: expect.stringMatching(/^app\.fastchat\.ruolo\./), name: expect.any(String) })
      else for (const field of [item.name, item.summary]) expect(Object.keys(field as object).sort()).toEqual(['en', 'fr', 'it'])
      if (item.file) expect(createHash('sha256').update(readFileSync(join(repoStore, item.file))).digest('hex')).toBe(item.sha256)
    }
    expect(catalog.items.find((i) => i.id === 'app.fastchat.guida')).toMatchObject({ builtin: true, type: 'knowledge' })
  })
})

describe('store: installazione', () => {
  let fake: FakeOllama
  let h: DbHandle
  let dir: string
  let url = ''
  beforeAll(async () => {
    fake = await startFakeOllama([{ name: 'chat', capabilities: ['completion'] }, { name: 'embeddinggemma:latest', capabilities: ['embedding'] }])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    dir = mkdtempSync(join(tmpdir(), 'fastchat-store-'))
    url = ''
    setLocale('it')
  })
  afterEach(() => {
    h.close()
    rmSync(dir, { recursive: true, force: true })
    setLocale('it')
  })

  const services = (localDir = repoStore, trustedKeys = {}) => {
    const ollama = createOllamaClient(() => fake.url)
    const knowledge = createKnowledge({ db: h.db, embedder: createEmbedder({ db: h.db, ollama }), registry: createBuiltinRegistry(), packsDir: join(dir, 'packs'), trustedKeys })
    const store = createStore({ knowledge, getUrl: async () => url, localDir, downloadsDir: join(dir, 'downloads') })
    return { knowledge, store }
  }

  it('catalogo locale: la Guida integrata risulta installata; si installa una base, la si collega, la si toglie', async () => {
    const { knowledge, store } = services()
    await knowledge.installBuiltin(resolve(__dirname, '../packs'))
    let view = await store.catalog()
    expect(view).toMatchObject({ source: 'local', url: '', error: null })
    const state = () => Object.fromEntries(view.items.map((i) => [i.id, i.state]))
    expect(state()).toEqual({
      'app.fastchat.guida': 'installed',
      'it.fastchat.prompt': 'available',
      // i ruoli in bozza inclusi nell'app
      'app.fastchat.ruolo.assistente.it': 'installed',
      'app.fastchat.ruolo.prompt.it': 'installed',
      'it.fastchat.sito-web': 'soon'
    })
    expect(view.items.find((i) => i.id === 'app.fastchat.ruolo.prompt.it')).toMatchObject({ removable: false, builtin: true })
    await expect(store.remove('app.fastchat.ruolo.prompt.it')).rejects.toThrow(/non trovata/)
    expect(await store.owns('app.fastchat.ruolo.prompt.it')).toBe(true)
    expect(view.items[0]).toMatchObject({ removable: false, builtin: true })
    // installa la base: fidata perché inclusa nell'app, indicizzata con il modello dell'utente
    view = await store.install('it.fastchat.prompt')
    expect(state()['it.fastchat.prompt']).toBe('installed')
    const base = (await knowledge.installedPacks()).get('it.fastchat.prompt')!
    expect(base).toMatchObject({ name: 'Scrivere buoni prompt', origin: 'package' })
    expect(base.meta).toMatchObject({ trust: 'builtin', i18n: { en: { name: 'Writing good prompts' } } })
    // è dello Store: entra ed esce da lì, anche se arriva un file con lo stesso id
    expect(base.meta?.store).toBe(true)
    expect(await store.owns('it.fastchat.prompt')).toBe(true)
    expect(await store.owns('app.fastchat.guida')).toBe(true)
    expect(await store.owns('local.mio-archivio')).toBe(false)
    await knowledge.wait(base.id)
    expect((await listDocuments(h.db, base.id)).map((d) => d.status)).toEqual(['ready'])
    // collegata: le fonti portano il nome della base nella lingua dell'interfaccia
    const conv = await createConversation(h.db, { model: 'chat' })
    await knowledge.link(conv, base.id)
    const q = 'Come indicare il formato della risposta?'
    setLocale('en')
    const found = await knowledge.recall(conv, { text: q, vector: async () => fakeEmbedding(q) }, 4000, 4)
    expect(found.refs[0].base).toBe('Writing good prompts')
    setLocale('it')
    // voci non installabili, voci inesistenti
    await expect(store.install('it.fastchat.sito-web')).rejects.toThrow(/non è ancora installabile/)
    await expect(store.install('nope.nope')).rejects.toThrow(/non trovata/)
    await expect(store.remove('app.fastchat.guida')).rejects.toThrow(/non trovata/)
    // la Guida integrata non si elimina nemmeno dalla libreria; una base installata dallo store sì
    await expect(knowledge.removeBase((await knowledge.installedPacks()).get('app.fastchat.guida')!.id)).rejects.toThrow(/non si elimina/)
    // rimozione: sparisce anche dalla conversazione
    view = await store.remove('it.fastchat.prompt')
    expect(state()['it.fastchat.prompt']).toBe('available')
    expect((await knowledge.status(conv)).linked).toEqual([])
  })

  // ---------------------------------------------------------------- ruoli nello Store (passo 2.6)

  const TECNICHE = 'kb.tecniche'
  const ESEMPI_IT = 'kb.esempi.it'
  const roleIt: Role = { instructions: 'Sei un esperto di prompt.', bases: [{ id: TECNICHE, purpose: 'behavior' }, { id: ESEMPI_IT, purpose: 'examples' }] }
  const roleFr: Role = { instructions: 'Tu es un expert en prompts.', bases: [{ id: TECNICHE, purpose: 'behavior' }] }
  const doc = (text: string) => ({ documents: [{ title: 'Doc', chunks: [{ locator: null, text }] }] })
  const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

  /** Un catalogo locale di prova: un ruolo in due lingue (stesso gruppo), le loro basi, un pacchetto che li riunisce. */
  async function roleCatalog(): Promise<string> {
    const local = join(dir, 'catalogo')
    mkdirSync(join(local, 'items'), { recursive: true })
    const items: StoreItem[] = []
    const add = (item: Omit<StoreItem, 'file' | 'sha256'>, pack: Buffer): void => {
      const file = `items/${item.id}.fcpack`
      writeFileSync(join(local, file), pack)
      items.push({ ...item, file, sha256: sha256(pack) })
    }
    const pack = (id: string, name: string) => writePack({ manifest: { id, type: 'knowledge', name, version: '1.0.0', createdAt: 0 }, knowledge: doc(name) })
    const role = (id: string, name: string, language: string, definition: Role) =>
      writePack({ manifest: { id, type: 'identity', group: 'r.prompt', language, name, version: '1.0.0', createdAt: 0 }, role: definition })
    add({ id: TECNICHE, type: 'knowledge', name: 'Tecniche', summary: '', version: '1.0.0', language: 'it' }, await pack(TECNICHE, 'Tecniche'))
    add({ id: ESEMPI_IT, type: 'knowledge', name: 'Esempi', summary: '', version: '1.0.0', language: 'it' }, await pack(ESEMPI_IT, 'Esempi'))
    add({ id: 'r.prompt.it', type: 'identity', group: 'r.prompt', language: 'it', name: 'Esperto di prompt', summary: 'Scrive e migliora i prompt.', version: '1.0.0', requires: [TECNICHE, ESEMPI_IT] }, await role('r.prompt.it', 'Esperto di prompt', 'it', roleIt))
    add({ id: 'r.prompt.fr', type: 'identity', group: 'r.prompt', language: 'fr', name: 'Expert en prompts', summary: 'Écrit et améliore les prompts.', version: '1.0.0', requires: [TECNICHE] }, await role('r.prompt.fr', 'Expert en prompts', 'fr', roleFr))
    items.push({ id: 'r.tutor', type: 'identity', language: 'it', name: 'Tutor', summary: 'Spiega passo per passo.', version: '1.0.0' })
    items.push({ id: 'b.kit', type: 'bundle', name: 'Kit', summary: '', version: '1.0.0', contains: ['r.prompt.fr', TECNICHE] })
    writeFileSync(join(local, 'catalog.json'), JSON.stringify({ version: 1, updatedAt: '2026-11-13', items }))
    return local
  }

  it('varianti per lingua: una scheda per gruppo; la ricerca guarda tutte le lingue; il filtro per lingua', async () => {
    const { store } = services(await roleCatalog())
    const { items } = await store.catalog()
    const groups = (filter: Partial<Parameters<typeof storeGroups>[1]> = {}) => storeGroups(items, { type: 'identity', locale: 'it', ...filter })
    // tre voci di tipo ruolo, due schede: il ruolo in due lingue è una scheda sola
    expect(groups().map((g) => [g.key, g.variants.map((v) => v.id), g.preferred.id])).toEqual([
      ['r.prompt', ['r.prompt.it', 'r.prompt.fr'], 'r.prompt.it'],
      ['r.tutor', ['r.tutor'], 'r.tutor']
    ])
    // preselezionata la lingua dell'interfaccia, se c'è; altrimenti la prima
    expect(groups({ locale: 'fr' })[0].preferred.id).toBe('r.prompt.fr')
    expect(groups({ locale: 'en' })[0].preferred.id).toBe('r.prompt.it')
    // «prompts» compare solo nella variante francese: la scheda si trova lo stesso, e si sa dove
    const found = groups({ query: 'prompts' })
    expect(found.map((g) => g.key)).toEqual(['r.prompt'])
    expect(found[0].preferred.id).toBe('r.prompt.it')
    expect(found[0].matched.map((v) => v.id)).toEqual(['r.prompt.fr'])
    expect(groups({ query: 'passo per passo' }).map((g) => g.key)).toEqual(['r.tutor'])
    expect(groups({ query: 'nulla di simile' })).toEqual([])
    // filtro: solo ciò che è disponibile in quella lingua, con quella variante preselezionata
    expect(storeLanguages(items, 'identity')).toEqual(['it', 'fr'])
    expect(storeLanguages(items, 'plugin')).toEqual([])
    expect(groups({ language: 'fr' }).map((g) => [g.key, g.preferred.id])).toEqual([['r.prompt', 'r.prompt.fr']])
    expect(groups({ language: 'it' }).map((g) => g.key)).toEqual(['r.prompt', 'r.tutor'])
    expect(groups({ language: 'fr', query: 'esperto' }).map((g) => g.preferred.id)).toEqual(['r.prompt.fr'])
    // vale anche per le basi; i titoli per lingua dell'interfaccia si cercano tutti
    expect(storeGroups(items, { type: 'knowledge', locale: 'it', language: 'fr' })).toEqual([])
    expect(matchesQuery({ id: 'x.y.z', type: 'knowledge', name: { it: 'Guida', en: 'Guide' }, summary: { fr: 'Comment ça marche' }, version: '1' }, 'COMMENT')).toBe(true)
  })

  it('ruolo dallo Store: si installa con le basi che richiede, prese dal catalogo; si installa un\'altra lingua; si rimuove', async () => {
    const { knowledge, store } = services(await roleCatalog())
    const state = (view: Awaited<ReturnType<typeof store.catalog>>) => Object.fromEntries(view.items.map((i) => [i.id, [i.state, i.removable]]))
    let view = await store.catalog()
    expect(state(view)['r.prompt.it']).toEqual(['available', false])
    // senza file nel catalogo non è installabile
    expect(state(view)['r.tutor']).toEqual(['soon', false])
    await expect(store.install('r.tutor')).rejects.toThrow(/non è ancora installabile/)

    view = await store.install('r.prompt.it')
    expect(state(view)).toMatchObject({ 'r.prompt.it': ['installed', true], 'r.prompt.fr': ['available', false], [TECNICHE]: ['installed', true], [ESEMPI_IT]: ['installed', true] })
    const role = (await getRole(h.db, 'r.prompt.it'))!
    expect(role).toMatchObject({ name: 'Esperto di prompt', language: 'it', group: 'r.prompt', origin: 'package', definition: roleIt, meta: { store: true } })
    expect([...(await knowledge.installedPacks()).values()].map((b) => [b.packageId, b.meta?.forRole, b.meta?.store]).sort()).toEqual([
      [ESEMPI_IT, true, true],
      [TECNICHE, true, true]
    ])
    // è dello Store: un file con lo stesso id non lo sovrascrive (lo decide chi importa, con `owns`)
    expect(await store.owns('r.prompt.it')).toBe(true)
    expect(await store.owns('r.prompt.fr')).toBe(true)
    expect(await store.owns('r.mio')).toBe(false)
    // una scheda sola, ora con la variante installata preselezionata anche se l'interfaccia è in francese
    expect(storeGroups(view.items, { type: 'identity', locale: 'fr' })[0].preferred.id).toBe('r.prompt.it')

    // l'altra lingua: le due varianti convivono, e condividono le tecniche
    view = await store.install('r.prompt.fr')
    expect((await listRoles(h.db)).map((r) => r.id).sort()).toEqual(['r.prompt.fr', 'r.prompt.it'])
    expect((await knowledge.installedPacks()).size).toBe(2)

    // rimozione: gli esempi italiani se ne vanno con il ruolo italiano, le tecniche restano per il francese
    view = await store.remove('r.prompt.it')
    expect(state(view)).toMatchObject({ 'r.prompt.it': ['available', false], 'r.prompt.fr': ['installed', true], [TECNICHE]: ['installed', true], [ESEMPI_IT]: ['available', false] })
    view = await store.remove('r.prompt.fr')
    expect(state(view)).toMatchObject({ 'r.prompt.fr': ['available', false], [TECNICHE]: ['available', false] })
    expect(await listRoles(h.db)).toEqual([])
    await expect(store.remove('r.prompt.fr')).rejects.toThrow(/non trovata/)
  })

  it('un pacchetto installa le basi e i ruoli che contiene', async () => {
    const { knowledge, store } = services(await roleCatalog())
    let view = await store.catalog()
    expect(view.items.find((i) => i.id === 'b.kit')!.state).toBe('available')
    view = await store.install('b.kit')
    expect(view.items.find((i) => i.id === 'b.kit')!.state).toBe('installed')
    expect((await listRoles(h.db)).map((r) => r.id)).toEqual(['r.prompt.fr'])
    // la base del pacchetto è stata installata per conto suo, prima del ruolo: non è «del ruolo» e resta
    expect([...(await knowledge.installedPacks()).values()].map((b) => [b.packageId, b.meta?.forRole])).toEqual([[TECNICHE, undefined]])
    await store.remove('r.prompt.fr')
    expect([...(await knowledge.installedPacks()).keys()]).toEqual([TECNICHE])
  })

  describe('repository remoto', () => {
    let server: Server
    let files: Record<string, Buffer | string>
    let requests: string[]
    beforeEach(async () => {
      files = {}
      requests = []
      server = createServer((req, res) => {
        requests.push(req.url ?? '')
        const body = files[decodeURIComponent((req.url ?? '').slice(1))]
        if (body === undefined) {
          res.writeHead(404)
          return res.end()
        }
        res.writeHead(200)
        res.end(body)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    })
    afterEach(() => new Promise<void>((r) => server.close(() => r())))

    const knowledgeDoc = { documents: [{ title: 'Remoto', chunks: [{ locator: null, text: 'contenuto remoto firmato' }] }] }
    const vectors = new Float32Array(fakeEmbedding('contenuto remoto firmato'))
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    const publish = (pack: Buffer, extra: Record<string, unknown> = {}): void => {
      files['items/r.base/1.0.0.fcpack'] = pack
      files['catalog.json'] = JSON.stringify({ version: 1, updatedAt: '2026-11-11', items: [{ id: 'r.base', type: 'knowledge', name: { it: 'Remota', en: 'Remote' }, summary: '', version: '1.0.0', file: 'items/r.base/1.0.0.fcpack', sha256: sha(pack), ...extra }] })
    }

    it('legge il catalogo dal repository; installa solo pacchetti con firma riconosciuta e impronta giusta', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const signer = { keyId: 'store', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
      const manifest = { id: 'r.base', type: 'knowledge' as const, name: 'Remota', version: '1.0.0', createdAt: 0, embedding: { model: 'embeddinggemma', dimensions: 64 } }
      const signed = await writePack({ manifest, knowledge: knowledgeDoc, vectors, signer })
      publish(signed)
      const { knowledge, store } = services(repoStore, { store: publicKey.export({ type: 'spki', format: 'pem' }) as string })
      let view = await store.catalog()
      expect(view).toMatchObject({ source: 'remote', error: null, updatedAt: '2026-11-11' })
      expect(view.items.map((i) => [i.id, i.state])).toEqual([['r.base', 'available']])
      view = await store.install('r.base')
      expect(requests).toContain('/items/r.base/1.0.0.fcpack')
      expect(view.items[0]).toMatchObject({ state: 'installed', installedVersion: '1.0.0', removable: true })
      expect((await knowledge.installedPacks()).get('r.base')!.meta?.trust).toBe('verified')
      // nuova versione nel catalogo: aggiornamento disponibile
      files['catalog.json'] = (files['catalog.json'] as string).replace('"version":"1.0.0"', '"version":"1.1.0"')
      expect((await store.catalog()).items[0].state).toBe('update')
      // impronta che non corrisponde: non si installa
      publish(signed, { sha256: 'f'.repeat(64) })
      await expect(store.install('r.base')).rejects.toThrow(/non corrisponde all'impronta/)
      // senza firma riconosciuta: non si installa dal repository
      publish(await writePack({ manifest: { ...manifest, version: '1.2.0' }, knowledge: knowledgeDoc, vectors }))
      await expect(store.install('r.base')).rejects.toThrow(/conferma esplicita|firma/)
    })

    it('dal repository un ruolo si installa solo con firma riconosciuta, come le sue basi', async () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const signer = { keyId: 'store', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
      const roleManifest = { id: 'r.remoto', type: 'identity' as const, language: 'it', name: 'Remoto', version: '1.0.0', createdAt: 0 }
      const definition: Role = { instructions: 'Sei remoto.', bases: [{ id: 'r.base', purpose: 'behavior' }] }
      const baseManifest = { id: 'r.base', type: 'knowledge' as const, name: 'Remota', version: '1.0.0', createdAt: 0, embedding: { model: 'embeddinggemma', dimensions: 64 } }
      const put = async (signedRole: boolean, signedBase: boolean): Promise<void> => {
        const rolePack = await writePack({ manifest: roleManifest, role: definition, ...(signedRole ? { signer } : {}) })
        const basePack = await writePack({ manifest: baseManifest, knowledge: knowledgeDoc, vectors, ...(signedBase ? { signer } : {}) })
        files['items/r.remoto.fcpack'] = rolePack
        files['items/r.base.fcpack'] = basePack
        files['catalog.json'] = JSON.stringify({
          version: 1,
          updatedAt: '2026-11-13',
          items: [
            { id: 'r.remoto', type: 'identity', language: 'it', name: 'Remoto', summary: '', version: '1.0.0', file: 'items/r.remoto.fcpack', sha256: sha(rolePack), requires: ['r.base'] },
            { id: 'r.base', type: 'knowledge', name: 'Remota', summary: '', version: '1.0.0', file: 'items/r.base.fcpack', sha256: sha(basePack) }
          ]
        })
      }
      const { knowledge, store } = services(repoStore, { store: publicKey.export({ type: 'spki', format: 'pem' }) as string })
      // ruolo senza firma: non entra
      await put(false, true)
      await expect(store.install('r.remoto')).rejects.toThrow(/conferma esplicita|firma/)
      expect(await listRoles(h.db)).toEqual([])
      // ruolo firmato, base no: il ruolo entra, la base resta fuori (il ruolo funziona senza)
      await put(true, false)
      let view = await store.install('r.remoto')
      expect(view.items.map((i) => [i.id, i.state])).toEqual([['r.remoto', 'installed'], ['r.base', 'available']])
      expect((await getRole(h.db, 'r.remoto'))!.meta).toEqual({ trust: 'verified', store: true })
      // tutto firmato: arriva anche la base
      await put(true, true)
      await store.remove('r.remoto')
      view = await store.install('r.remoto')
      expect(view.items.map((i) => [i.id, i.state])).toEqual([['r.remoto', 'installed'], ['r.base', 'installed']])
      expect((await knowledge.installedPacks()).get('r.base')!.meta).toMatchObject({ trust: 'verified', forRole: true, store: true })
    })

    it('repository che non risponde: catalogo locale, con il motivo', async () => {
      const { store } = services()
      const view = await store.catalog()
      expect(view.source).toBe('local')
      expect(view.error).toMatch(/non risponde \(HTTP 404\)/)
      expect(view.items.some((i) => i.id === 'app.fastchat.guida')).toBe(true)
    })
  })
})
