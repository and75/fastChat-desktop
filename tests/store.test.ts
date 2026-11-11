import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, listDocuments } from '../src/main/db/repo'
import { createEmbedder } from '../src/main/embedder'
import { createKnowledge } from '../src/main/knowledge'
import { writePack } from '../src/main/knowledge/pack'
import { createBuiltinRegistry } from '../src/main/knowledge/sources'
import { createOllamaClient } from '../src/main/ollama'
import { createStore } from '../src/main/store'
import { setLocale } from '../src/shared/i18n'
import { compareVersions, localize, parseCatalog, storeEntries, STORE_CATEGORIES, type StoreCatalog } from '../src/shared/store'
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

  it('stati: installato, aggiornamento, installabile, presto; i pacchetti seguono le basi che contengono', () => {
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
        { id: 'b.solo-identita', type: 'bundle', name: 'B3', summary: '', version: '1.0.0', contains: ['i.identita'] }
      ]
    }
    const entries = storeEntries(catalog, new Map([['k.builtin', '1'], ['k.vecchia', '1.5.0']]))
    expect(entries.map((e) => [e.id, e.state, e.removable])).toEqual([
      ['k.builtin', 'installed', false],
      ['k.nuova', 'available', false],
      ['k.vecchia', 'update', true],
      ['k.senza-file', 'soon', false],
      ['i.identita', 'soon', false],
      ['p.plugin', 'soon', false],
      ['b.misto', 'available', false],
      ['b.fatto', 'installed', false],
      ['b.solo-identita', 'soon', false]
    ])
    expect(entries[2].installedVersion).toBe('1.5.0')
  })

  it('il catalogo incluso nell\'app è valido, ha le quattro categorie con i titoli nelle tre lingue, e i file hanno l\'impronta dichiarata', () => {
    const catalog = parseCatalog(JSON.parse(readFileSync(join(repoStore, 'catalog.json'), 'utf8')))
    expect(new Set(catalog.items.map((i) => i.type))).toEqual(new Set(STORE_CATEGORIES))
    for (const item of catalog.items) {
      for (const field of [item.name, item.summary]) expect(Object.keys(field as object).sort()).toEqual(['en', 'fr', 'it'])
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
      'it.fastchat.tutor-prompt': 'soon',
      'it.fastchat.sito-web': 'soon',
      'it.fastchat.kit-prompt': 'available'
    })
    expect(view.items[0]).toMatchObject({ removable: false, builtin: true })
    // installa la base: fidata perché inclusa nell'app, indicizzata con il modello dell'utente
    view = await store.install('it.fastchat.prompt')
    expect(state()['it.fastchat.prompt']).toBe('installed')
    expect(state()['it.fastchat.kit-prompt']).toBe('installed')
    const base = (await knowledge.installedPacks()).get('it.fastchat.prompt')!
    expect(base).toMatchObject({ name: 'Scrivere buoni prompt', origin: 'package' })
    expect(base.meta).toMatchObject({ trust: 'builtin', i18n: { en: { name: 'Writing good prompts' } } })
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
    await expect(store.install('it.fastchat.tutor-prompt')).rejects.toThrow(/non è ancora installabile/)
    await expect(store.install('nope.nope')).rejects.toThrow(/non trovata/)
    await expect(store.remove('app.fastchat.guida')).rejects.toThrow(/non trovata/)
    // rimozione: sparisce anche dalla conversazione
    view = await store.remove('it.fastchat.prompt')
    expect(state()['it.fastchat.prompt']).toBe('available')
    expect((await knowledge.status(conv)).linked).toEqual([])
  })

  it('un pacchetto installa le basi che contiene', async () => {
    const { knowledge, store } = services()
    const view = await store.install('it.fastchat.kit-prompt')
    expect(view.items.find((i) => i.id === 'it.fastchat.prompt')!.state).toBe('installed')
    expect([...(await knowledge.installedPacks()).keys()]).toEqual(['it.fastchat.prompt'])
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

    it('repository che non risponde: catalogo locale, con il motivo', async () => {
      const { store } = services()
      const view = await store.catalog()
      expect(view.source).toBe('local')
      expect(view.error).toMatch(/non risponde \(HTTP 404\)/)
      expect(view.items.some((i) => i.id === 'app.fastchat.guida')).toBe(true)
    })
  })
})
