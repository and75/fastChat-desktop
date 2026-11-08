import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, listContextCalls, listDocuments, listKnowledgeChunks, saveModelSetting, setSettings } from '../src/main/db/repo'
import { createEmbedder } from '../src/main/embedder'
import { createContextLog } from '../src/main/contextLog'
import { createKnowledge, hashFile } from '../src/main/knowledge'
import { createRegistry } from '../src/main/knowledge/registry'
import { SourceError, type KnowledgeSource } from '../src/main/knowledge/source'
import { BUILTIN_SOURCES } from '../src/main/knowledge/sources'
import { textSource } from '../src/main/knowledge/sources/text'
import { createOllamaClient } from '../src/main/ollama'
import { buildDocumentChunks, buildKnowledgeSection, knowledgeBudget, normalizeText, pickDocumentChunks, splitMarkdownSections, toKnowledgeRefs } from '../src/shared/knowledge'
import { fromBuffer } from '../src/shared/memory'
import type { Conversation, KnowledgeProgress } from '../src/shared/types'
import { fakeEmbedding, startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const fixtures = resolve(__dirname, 'fixtures')

describe('base di conoscenza: funzioni pure', () => {
  it('normalizeText: fine riga, spazi in coda, righe vuote multiple', () => {
    expect(normalizeText('a  \r\nb\r\n\r\n\r\n\r\nc\n')).toBe('a\nb\n\nc')
  })

  it('splitMarkdownSections: sezioni ai titoli con la catena dei titoli come locatore; i # nei blocchi di codice non contano', () => {
    const s = splitMarkdownSections('Intro.\n\n# Manuale\n\nTesto.\n\n## Installazione\n\nPassi.\n\n### Windows\n\nWin.\n\n## Uso\n\n```\n# non titolo\n```\n\nAvvia.')
    expect(s.map((x) => x.locator)).toEqual([null, 'Manuale', 'Manuale › Installazione', 'Manuale › Installazione › Windows', 'Manuale › Uso'])
    expect(s[0].text).toBe('Intro.')
    expect(s[4].text).toBe('```\n# non titolo\n```\n\nAvvia.')
    expect(splitMarkdownSections('')).toEqual([])
  })

  it('buildDocumentChunks: pezzi per sezione entro il limite, locatore ereditato, numerazione per documento', () => {
    const chunks = buildDocumentChunks(
      [
        { text: 'a'.repeat(30) + '\n\n' + 'b'.repeat(30), locator: 'p. 1' },
        { text: '   ', locator: 'p. 2' },
        { text: 'c'.repeat(10), locator: null }
      ],
      40
    )
    expect(chunks).toEqual([
      { part: 0, locator: 'p. 1', text: 'a'.repeat(30) },
      { part: 1, locator: 'p. 1', text: 'b'.repeat(30) },
      { part: 2, locator: null, text: 'c'.repeat(10) }
    ])
  })

  it('pickDocumentChunks: soglie, al massimo due per documento, budget in caratteri', () => {
    const c = (id: string, documentId: string, embedding: number[]) => ({ id, documentId, title: documentId, locator: null, text: id.repeat(10), embedding })
    const q = [1, 0, 0]
    const chunks = [c('a', 'd1', [0.95, 0.05, 0]), c('b', 'd1', [0.9, 0.1, 0]), c('c', 'd1', [0.85, 0.15, 0]), c('d', 'd2', [0.8, 0.2, 0]), c('z', 'd3', [0, 0, 1])]
    expect(pickDocumentChunks(q, chunks, 1000).map((p) => p.id)).toEqual(['a', 'b', 'd'])
    expect(pickDocumentChunks(q, chunks, 15).map((p) => p.id)).toEqual(['a'])
    expect(pickDocumentChunks([0, 1, 0], chunks, 1000)).toEqual([])
  })

  it('buildKnowledgeSection e toKnowledgeRefs: fonte con locatore, ordine per documento e posizione, refs per punteggio', () => {
    const picked = [
      { id: '2', documentId: 'd2', title: 'Rapporto', locator: 'p. 3', part: 0, text: 'Secondo.', embedding: [], score: 0.9 },
      { id: '1', documentId: 'd1', title: 'Manuale', locator: null, part: 5, text: 'Primo.', embedding: [], score: 0.5 },
      { id: '0', documentId: 'd1', title: 'Manuale', locator: 'Uso', part: 2, text: 'Zero.', embedding: [], score: 0.7 }
    ]
    const s = buildKnowledgeSection(picked)
    expect(s.startsWith('# Base di conoscenza\n\n')).toBe(true)
    expect(s).toContain('[Manuale, Uso]\nZero.')
    expect(s).toContain('[Rapporto, p. 3]\nSecondo.')
    expect(s.indexOf('[Manuale, Uso]')).toBeLessThan(s.indexOf('[Manuale]\nPrimo.'))
    expect(s.indexOf('[Manuale]\nPrimo.')).toBeLessThan(s.indexOf('[Rapporto, p. 3]'))
    expect(buildKnowledgeSection([])).toBe('')
    expect(toKnowledgeRefs(picked).map((r) => [r.documentId, r.score, r.locator])).toEqual([
      ['d2', 0.9, 'p. 3'],
      ['d1', 0.7, 'Uso'],
      ['d1', 0.5, null]
    ])
  })

  it('knowledgeBudget: al massimo il 25% e solo lo spazio rimasto', () => {
    expect(knowledgeBudget(4096, 819, 1000)).toBe(1024)
    expect(knowledgeBudget(4096, 819, 3000)).toBe(277)
    expect(knowledgeBudget(4096, 819, 4000)).toBe(0)
  })
})

describe('base di conoscenza: registro e plugin', () => {
  it('registro: sceglie il plugin dall\'estensione, rifiuta id doppi o non validi, descrive i plugin per il renderer', () => {
    const reg = createRegistry(BUILTIN_SOURCES)
    expect(reg.sourceFor({ kind: 'file', path: '/x/Note.MD' }).id).toBe('text')
    expect(() => reg.sourceFor({ kind: 'file', path: '/x/foto.png' })).toThrow(/Formato non supportato: foto.png/)
    expect(() => reg.register(textSource)).toThrow(/già registrato/)
    expect(() => reg.register({ ...textSource, id: 'Bad Id' })).toThrow(/non valido/)
    expect(reg.extensions()).toContain('md')
    const info = reg.describe()
    expect(info[0]).toMatchObject({ id: 'text', label: 'Testo e Markdown', kind: 'file' })
    expect(info[0].extensions).toContain('txt')
  })

  it('registro: un documento remoto lo legge il suo plugin; i plugin collegati espongono i campi di configurazione', () => {
    const remote: KnowledgeSource = {
      id: 'site',
      labelKey: 'knowledge.source.text',
      kind: 'connected',
      configFields: [{ key: 'url', labelKey: 'common.save', type: 'text', required: true }],
      list: async () => [],
      canHandle: (ref) => ref.kind === 'remote' && ref.sourceId === 'site',
      extract: async () => ({ title: 'x', sections: [] })
    }
    const reg = createRegistry([textSource, remote])
    expect(reg.sourceFor({ kind: 'remote', sourceId: 'site', uri: 'https://x/y.txt' }).id).toBe('site')
    expect(reg.extensions()).not.toContain(undefined)
    expect(reg.describe()[1]).toMatchObject({ id: 'site', kind: 'connected', extensions: [], configFields: [{ key: 'url', label: 'Salva', type: 'text', required: true }] })
  })

  it('plugin testo: txt in una sezione, md ai titoli, file vuoto (solo BOM) senza sezioni, file assente in errore', async () => {
    const signal = new AbortController().signal
    const txt = await textSource.extract({ kind: 'file', path: join(fixtures, 'relazione.txt') }, {}, signal)
    expect(txt.title).toBe('relazione')
    expect(txt.sections).toHaveLength(1)
    expect(txt.sections[0].text).toMatch(/^Relazione annuale 2026\n\nIl fatturato/)
    const md = await textSource.extract({ kind: 'file', path: join(fixtures, 'manuale.md') }, {}, signal)
    expect(md.sections.map((s) => s.locator)).toEqual(['Manuale', 'Manuale › Installazione', 'Manuale › Installazione › Windows', 'Manuale › Uso'])
    const empty = await textSource.extract({ kind: 'file', path: join(fixtures, 'vuoto.txt') }, {}, signal)
    expect(empty.sections).toEqual([])
    await expect(textSource.extract({ kind: 'file', path: join(fixtures, 'manca.txt') }, {}, signal)).rejects.toBeInstanceOf(SourceError)
  })
})

describe('base di conoscenza: servizio', () => {
  let fake: FakeOllama
  let h: DbHandle
  let progress: KnowledgeProgress[]
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192 },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] },
      { name: 'other-embed', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    progress = []
  })
  afterEach(() => h.close())

  function service() {
    const ollama = createOllamaClient(() => fake.url)
    const contextLog = createContextLog(h.db)
    const embedder = createEmbedder({ db: h.db, ollama, contextLog })
    return createKnowledge({ db: h.db, embedder, registry: createRegistry(BUILTIN_SOURCES), onProgress: (p) => progress.push(p) })
  }

  it('aggiunge un file, lo indicizza in sottofondo con avanzamento, registra la chiamata nel monitor', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    const [doc] = await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    expect(doc).toMatchObject({ status: 'pending', source: 'text', title: 'relazione', bytes: 195 })
    expect(doc.hash).toBe(await hashFile(join(fixtures, 'relazione.txt')))
    await k.wait(conv.id)
    const [ready] = await listDocuments(h.db, conv.id)
    expect(ready).toMatchObject({ status: 'ready', chunkCount: 1, error: null })
    expect(ready.chars).toBeGreaterThan(100)
    expect(ready.indexedAt).not.toBeNull()
    const chunks = await listKnowledgeChunks(h.db, [doc.id], 'embeddinggemma')
    expect(chunks).toHaveLength(1)
    expect(fromBuffer(chunks[0].embedding)).toHaveLength(64)
    expect(progress.map((p) => p.status)).toEqual(['indexing', 'indexing', 'ready'])
    expect(progress.at(-1)).toMatchObject({ documentId: doc.id, done: 1, total: 1 })
    const calls = await listContextCalls(h.db, conv.id)
    expect(calls.map((c) => c.kind)).toEqual(['embed-doc'])
    expect(calls[0].note).toBe('relazione')
    expect(calls[0].parts[0]).toMatchObject({ key: 'texts', label: 'texts.doc', count: 1 })
  })

  it('lo stesso file non si aggiunge due volte; file assente o formato ignoto danno errore prima di salvare', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    const first = await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    const again = await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    expect(again[0].id).toBe(first[0].id)
    expect(await listDocuments(h.db, conv.id)).toHaveLength(1)
    await expect(k.addFiles(conv, [join(fixtures, 'manca.txt')])).rejects.toThrow(/Impossibile leggere manca.txt/)
    await expect(k.addFiles(conv, [join(fixtures, 'foto.png')])).rejects.toThrow(/Formato non supportato/)
    expect(await listDocuments(h.db, conv.id)).toHaveLength(1)
    await k.wait(conv.id)
  })

  it('un file senza testo finisce in errore con il motivo; reindicizza riparte da zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-kb-'))
    try {
      const path = join(dir, 'note.txt')
      writeFileSync(path, '')
      const k = service()
      const conv = await createConversation(h.db, { model: 'chat' })
      const [doc] = await k.addFiles(conv, [path])
      await k.wait(conv.id)
      expect((await listDocuments(h.db, conv.id))[0]).toMatchObject({ status: 'error', error: 'Nessun testo estraibile da note' })
      expect(await k.hasReady(conv.id)).toBe(false)
      writeFileSync(path, 'Adesso il file ha un contenuto vero e proprio.')
      await k.reindex(conv, doc.id)
      await k.wait(conv.id)
      expect((await listDocuments(h.db, conv.id))[0]).toMatchObject({ status: 'ready', chunkCount: 1, error: null })
      expect(await k.hasReady(conv.id)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recupera gli estratti pertinenti con fonte e locatore; niente estratti se nulla è pertinente o il budget è minimo', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.addFiles(conv, [join(fixtures, 'relazione.txt'), join(fixtures, 'manuale.md')])
    await k.wait(conv.id)
    const query = fakeEmbedding('Quante persone ha assunto la sede di Torino?')
    const found = await k.recall(conv, query, 800, 4)
    expect(found.refs.length).toBeGreaterThan(0)
    expect(found.refs[0]).toMatchObject({ title: 'relazione', locator: null })
    expect(found.refs[0].excerpt).toContain('Torino')
    expect(found.section).toContain('# Base di conoscenza')
    expect(found.section).toContain('[relazione]\n')
    const install = await k.recall(conv, fakeEmbedding('Come usare il programma di installazione su Windows?'), 800, 4)
    expect(install.refs[0]).toMatchObject({ title: 'manuale', locator: 'Manuale › Installazione › Windows' })
    expect(install.section).toContain('[manuale, Manuale › Installazione › Windows]')
    expect(await k.recall(conv, fakeEmbedding('zzzz qqqq'), 800, 4)).toEqual({ section: '', refs: [] })
    expect(await k.recall(conv, query, 10, 4)).toEqual({ section: '', refs: [] })
  })

  it('stato: documenti, pezzi, da indicizzare, modello installato; rimozione a cascata dei pezzi', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    const [doc] = await k.addFiles(conv, [join(fixtures, 'manuale.md')])
    await k.wait(conv.id)
    const s = await k.status(conv)
    expect(s).toMatchObject({ chunks: 4, pending: 0, model: 'embeddinggemma', modelInstalled: true })
    expect(s.documents).toHaveLength(1)
    expect(s.connections).toEqual([])
    await k.remove(conv, doc.id)
    expect(await listKnowledgeChunks(h.db, [doc.id], 'embeddinggemma')).toEqual([])
    expect((await k.status(conv)).documents).toEqual([])
    await expect(k.remove(conv, doc.id)).rejects.toThrow(/Documento non trovato/)
  })

  it('cambio del modello di embedding: i documenti risultano da indicizzare, ensureModel li rifà; gli embedding seguono la CPU della chat', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    await saveModelSetting(h.db, 'chat', { numGpu: 0 })
    const [doc] = await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await k.wait(conv.id)
    const embed = fake.requests.filter((r) => r.path === '/api/embed')
    expect((embed.at(-1)!.body as { options?: { num_gpu?: number } }).options).toEqual({ num_gpu: 0 })
    await setSettings(h.db, { embeddingModel: 'other-embed' })
    expect(await k.status(conv)).toMatchObject({ chunks: 0, pending: 1, model: 'other-embed' })
    expect(await k.hasReady(conv.id)).toBe(false)
    await k.ensureModel(conv)
    await k.wait(conv.id)
    expect(await k.status(conv)).toMatchObject({ chunks: 1, pending: 0 })
    expect(await listKnowledgeChunks(h.db, [doc.id], 'other-embed')).toHaveLength(1)
    // i pezzi del modello precedente non servono più
    expect(await listKnowledgeChunks(h.db, [doc.id], 'embeddinggemma')).toEqual([])
  })

  it('modello di embedding mancante: il documento resta in errore e lo stato lo dice', async () => {
    const k = service()
    await setSettings(h.db, { embeddingModel: 'nope' })
    const conv: Conversation = await createConversation(h.db, { model: 'chat' })
    await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await k.wait(conv.id)
    const s = await k.status(conv)
    expect(s.modelInstalled).toBe(false)
    expect(s.documents[0].status).toBe('error')
    expect(s.documents[0].error).toMatch(/not found/)
  })
})
