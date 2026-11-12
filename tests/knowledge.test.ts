import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addMessage, createConversation, getConversationBase, listContextCalls, listDocuments, listKnowledgeChunks, listMessages, saveModelSetting, setSettings, updateConversation } from '../src/main/db/repo'
import { createChatService, wantsKnowledge } from '../src/main/chat'
import { createMemory } from '../src/main/memory'
import { createEmbedder } from '../src/main/embedder'
import { createContextLog } from '../src/main/contextLog'
import { createKnowledge, hashFile } from '../src/main/knowledge'
import { createRegistry } from '../src/main/knowledge/registry'
import { SourceError, type KnowledgeSource } from '../src/main/knowledge/source'
import { BUILTIN_SOURCES } from '../src/main/knowledge/sources'
import { textSource } from '../src/main/knowledge/sources/text'
import { createOllamaClient } from '../src/main/ollama'
import { buildDocumentChunks, buildKnowledgeSection, splitKnowledgeBudget, ftsQuery, hybridScores, knowledgeBudget, normalizeText, pickDocumentChunks, splitMarkdownSections, toKnowledgeRefs, wholeDocuments } from '../src/shared/knowledge'
import { fromBuffer } from '../src/shared/memory'
import type { Conversation, KnowledgeProgress, StreamEvent } from '../src/shared/types'
import { fakeEmbedding, startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

const fixtures = resolve(__dirname, 'fixtures')

/** Documenti della base della conversazione. */
const convDocs = async (db: DbHandle['db'], conversationId: string) => {
  const base = await getConversationBase(db, conversationId)
  return base ? listDocuments(db, base.id) : []
}

describe('base di conoscenza: funzioni pure', () => {
  it('quote dei tre tipi di base: ognuno la sua, lo spazio non usato passa agli altri, prima ai documenti', () => {
    const shares = { behavior: 0.2, examples: 0.2, documents: 0.6 }
    // tutti e tre ne vogliono più della quota: ognuno la sua
    expect(splitKnowledgeBudget(1000, shares, { behavior: 900, examples: 900, documents: 900 })).toEqual({ behavior: 200, examples: 200, documents: 600 })
    // solo documenti: tutto lo spazio è loro (comportamento di sempre)
    expect(splitKnowledgeBudget(1000, shares, { behavior: 0, examples: 0, documents: 5000 })).toEqual({ behavior: 0, examples: 0, documents: 1000 })
    expect(splitKnowledgeBudget(1000, shares, { behavior: 0, examples: 0, documents: 300 })).toEqual({ behavior: 0, examples: 0, documents: 300 })
    // ruolo senza documenti: tecniche ed esempi si dividono lo spazio dei documenti, prima gli esempi
    expect(splitKnowledgeBudget(1000, shares, { behavior: 900, examples: 900, documents: 0 })).toEqual({ behavior: 200, examples: 800, documents: 0 })
    // base di comportamento piccola: ciò che avanza va ai documenti
    expect(splitKnowledgeBudget(1000, shares, { behavior: 50, examples: 0, documents: 5000 })).toEqual({ behavior: 50, examples: 0, documents: 950 })
    expect(splitKnowledgeBudget(0, shares, { behavior: 50, examples: 50, documents: 50 })).toEqual({ behavior: 0, examples: 0, documents: 0 })
  })

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

  it('pickDocumentChunks: soglie, tetto per documento che cresce con il budget, budget in caratteri', () => {
    const c = (id: string, documentId: string, embedding: number[]) => ({ id, documentId, title: documentId, locator: null, part: 0, text: id.repeat(10), embedding })
    const q = [1, 0, 0]
    const chunks = [c('a', 'd1', [0.95, 0.05, 0]), c('b', 'd1', [0.9, 0.1, 0]), c('c', 'd1', [0.85, 0.15, 0]), c('d', 'd2', [0.8, 0.2, 0]), c('z', 'd3', [0, 0, 1])]
    // budget piccolo: due per documento
    expect(pickDocumentChunks(q, chunks, 1000).map((p) => p.id)).toEqual(['a', 'b', 'd'])
    // budget grande (3 documenti, ~6 pezzi): tre per documento, tutto ciò che è pertinente
    expect(pickDocumentChunks(q, chunks, 10_000).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(pickDocumentChunks(q, chunks, 15).map((p) => p.id)).toEqual(['a'])
    expect(pickDocumentChunks([0, 1, 0], chunks, 1000)).toEqual([])
  })

  it('punteggio ibrido: le parole esatte (BM25) fanno salire un pezzo con somiglianza semantica bassa', () => {
    const c = (id: string, embedding: number[], text: string) => ({ id, documentId: 'd', title: 'd', locator: null, part: 0, text, embedding })
    const q = [1, 0, 0]
    const chunks = [c('sem', [0.9, 0.1, 0], 'testo semanticamente vicino'), c('lex', [0.1, 0.9, 0], 'Fattura 2026/017 Rossi')]
    // senza BM25: solo il coseno
    expect(pickDocumentChunks(q, chunks, 1000).map((p) => p.id)).toEqual(['sem'])
    // con BM25 che premia 'lex': entra, e il punteggio è pesato 0,6 coseno + 0,4 parole
    const bm25 = new Map([['lex', 5]])
    const scores = hybridScores(q, chunks, bm25)
    expect(scores.get('lex')).toBeCloseTo(0.6 * (0.1 / Math.hypot(0.1, 0.9)) + 0.4, 5)
    expect(scores.get('sem')).toBeCloseTo(0.6 * (0.9 / Math.hypot(0.9, 0.1)), 5)
    expect(pickDocumentChunks(q, chunks, 1000, { bm25 }).map((p) => p.id)).toEqual(['sem', 'lex'])
  })

  it('ftsQuery: parole di almeno tre lettere e numeri, senza doppioni, tra virgolette, unite con OR', () => {
    expect(ftsQuery('La fattura n. 17 di Rossi, la fattura (Rossi) del 2026!')).toBe('"fattura" OR "17" OR "rossi" OR "del" OR "2026"')
    expect(ftsQuery('a e')).toBe('')
  })

  it('wholeDocuments: i documenti indicati per intero e in ordine, finché stanno nel budget', () => {
    const c = (id: string, documentId: string, part: number) => ({ id, documentId, title: documentId, locator: null, part, text: 'x'.repeat(10), embedding: [] })
    const chunks = [c('b1', 'b', 1), c('a0', 'a', 0), c('b0', 'b', 0), c('a1', 'a', 1), c('z0', 'z', 0)]
    expect(wholeDocuments(chunks, new Set(['a', 'b']), 1000).picked.map((p) => p.id)).toEqual(['a0', 'a1', 'b0', 'b1'])
    const cut = wholeDocuments(chunks, new Set(['a', 'b']), 25)
    expect(cut.picked.map((p) => p.id)).toEqual(['a0', 'a1'])
    expect(cut.truncated).toBe(true)
  })

  it('buildKnowledgeSection e toKnowledgeRefs: fonte con locatore, ordine per documento e posizione, refs per punteggio', () => {
    const picked = [
      { id: '2', documentId: 'd2', title: 'Rapporto', locator: 'p. 3', part: 0, text: 'Secondo.', embedding: [], score: 0.9 },
      { id: '1', documentId: 'd1', title: 'Manuale', locator: null, part: 5, text: 'Primo.', embedding: [], score: 0.5 },
      { id: '0', documentId: 'd1', title: 'Manuale', locator: 'Uso', part: 2, text: 'Zero.', embedding: [], score: 0.7 }
    ]
    const s = buildKnowledgeSection(picked)
    expect(s.startsWith('# Base di conoscenza\n\nEstratti dei documenti')).toBe(true)
    expect(s).toContain('[Manuale, Uso]\nZero.')
    expect(s).toContain('[Rapporto, p. 3]\nSecondo.')
    expect(s.indexOf('[Manuale, Uso]')).toBeLessThan(s.indexOf('[Manuale]\nPrimo.'))
    expect(s.indexOf('[Manuale]\nPrimo.')).toBeLessThan(s.indexOf('[Rapporto, p. 3]'))
    expect(buildKnowledgeSection([])).toBe('')
    expect(toKnowledgeRefs([], picked).map((r) => [r.documentId, r.score, r.locator])).toEqual([
      ['d2', 0.9, 'p. 3'],
      ['d1', 0.7, 'Uso'],
      ['d1', 0.5, null]
    ])
    // documenti interi: introduzione diversa, prima gli interi poi gli estratti; un riferimento per documento intero
    const whole = [
      { documentId: 'w', title: 'Fattura 1', locator: 'p. 1', part: 0, text: 'Intera.', whole: true },
      { documentId: 'w', title: 'Fattura 1', locator: 'p. 2', part: 1, text: 'Seconda pagina.', whole: true }
    ]
    const mixed = buildKnowledgeSection([...picked, ...whole])
    expect(mixed).toMatch(/^# Base di conoscenza\n\nDocumenti forniti dall'utente, riportati per intero \(1 in tutto\)/)
    expect(mixed.indexOf('[Fattura 1, p. 2]')).toBeLessThan(mixed.indexOf('Seguono estratti di altri documenti'))
    expect(mixed.indexOf('Seguono estratti')).toBeLessThan(mixed.indexOf('[Manuale, Uso]'))
    expect(toKnowledgeRefs(whole, picked).slice(0, 2)).toMatchObject([{ documentId: 'w', whole: true, score: 1, locator: null }, { documentId: 'd2' }])
  })

  it('knowledgeBudget: al massimo la quota (50% predefinito, 25/75 a scelta) e solo lo spazio rimasto', () => {
    expect(knowledgeBudget(4096, 819, 1000)).toBe(2048)
    expect(knowledgeBudget(4096, 819, 1000, 0.25)).toBe(1024)
    expect(knowledgeBudget(4096, 819, 1000, 0.75)).toBe(2277)
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
    const [ready] = await convDocs(h.db, conv.id)
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
    expect(await convDocs(h.db, conv.id)).toHaveLength(1)
    await expect(k.addFiles(conv, [join(fixtures, 'manca.txt')])).rejects.toThrow(/Impossibile leggere manca.txt/)
    await expect(k.addFiles(conv, [join(fixtures, 'foto.png')])).rejects.toThrow(/Formato non supportato/)
    expect(await convDocs(h.db, conv.id)).toHaveLength(1)
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
      expect((await convDocs(h.db, conv.id))[0]).toMatchObject({ status: 'error', error: 'Nessun testo estraibile da note' })
      expect(await k.hasReady(conv.id)).toBe(false)
      writeFileSync(path, 'Adesso il file ha un contenuto vero e proprio.')
      await k.reindex(conv, doc.id)
      await k.wait(conv.id)
      expect((await convDocs(h.db, conv.id))[0]).toMatchObject({ status: 'ready', chunkCount: 1, error: null })
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
    // budget da 100 token (400 caratteri): i due documenti insieme non ci stanno → estratti
    const found = await k.recall(conv, { vector: async () => query, text: 'Quante persone ha assunto la sede di Torino?' }, 100, 4)
    expect(found.refs.length).toBeGreaterThan(0)
    expect(found.refs[0]).toMatchObject({ title: 'relazione', locator: null })
    expect(found.refs[0].excerpt).toContain('Torino')
    expect(found.section).toContain('# Base di conoscenza')
    expect(found.section).toContain('[relazione]\n')
    const install = await k.recall(conv, { vector: async () => fakeEmbedding('Come usare il programma di installazione su Windows?'), text: 'Come usare il programma di installazione su Windows?' }, 100, 4)
    expect(install.refs[0]).toMatchObject({ title: 'manuale', locator: 'Manuale › Installazione › Windows' })
    expect(install.section).toContain('[manuale, Manuale › Installazione › Windows]')
    expect(await k.recall(conv, { vector: async () => fakeEmbedding('zzzz qqqq'), text: 'zzzz qqqq' }, 100, 4)).toEqual({ section: '', refs: [] })
    // budget largo: i documenti stanno nella memoria → tutti per intero, un riferimento per documento
    const whole = await k.recall(conv, { vector: async () => fakeEmbedding('zzzz qqqq'), text: 'zzzz qqqq' }, 800, 4)
    expect(whole.section).toContain('riportati per intero (2 in tutto)')
    expect(whole.refs.map((r) => [r.title, r.whole])).toEqual([['manuale', true], ['relazione', true]])
    expect(await k.recall(conv, { vector: async () => query, text: 'x' }, 10, 4)).toEqual({ section: '', refs: [] })
  })

  it('stato: documenti, pezzi, da indicizzare, modello installato; rimozione a cascata dei pezzi', async () => {
    const k = service()
    const conv = await createConversation(h.db, { model: 'chat' })
    const [doc] = await k.addFiles(conv, [join(fixtures, 'manuale.md')])
    await k.wait(conv.id)
    const s = await k.status(conv)
    expect(s).toMatchObject({ chunks: 4, pending: 0, pinnedChars: 0, model: 'embeddinggemma', modelInstalled: true })
    expect(s.totalChars).toBeGreaterThan(100)
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

describe('base di conoscenza: nella chat', () => {
  let fake: FakeOllama
  let h: DbHandle
  let events: StreamEvent[]
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 4096', chunks: [{ content: 'Quattordici persone [relazione].' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    events = []
  })
  afterEach(() => h.close())

  /** Servizi come li collega il main: un embedder condiviso tra memoria, documenti e chat. */
  function services() {
    const ollama = createOllamaClient(() => fake.url)
    const contextLog = createContextLog(h.db)
    const embedder = createEmbedder({ db: h.db, ollama, contextLog })
    const memory = createMemory({ db: h.db, ollama, contextLog, embedder })
    const knowledge = createKnowledge({ db: h.db, embedder, registry: createRegistry(BUILTIN_SOURCES) })
    const chat = createChatService({ db: h.db, ollama, memory, knowledge, embedder, contextLog, emit: (_t, e) => events.push(e) })
    return { knowledge, memory, chat }
  }

  /** La richiesta di chat che risponde alla domanda (non quella del titolo automatico). */
  const chatBodyFor = (question: string) =>
    fake.requests
      .filter((q) => q.path === '/api/chat')
      .map((q) => q.body as { messages: Array<{ role: string; content: string }> })
      .findLast((b) => b.messages.at(-1)?.content === question)!
  const embedQueries = (from: number) => fake.requests.slice(from).filter((q) => q.path === '/api/embed').length

  it('wantsKnowledge: la scelta sulla domanda vince sull\'impostazione della conversazione', () => {
    expect(wantsKnowledge({ knowledge: true }, null)).toBe(true)
    expect(wantsKnowledge({ knowledge: false }, { knowledge: null })).toBe(false)
    expect(wantsKnowledge({ knowledge: true }, { knowledge: false })).toBe(false)
    expect(wantsKnowledge({ knowledge: false }, { knowledge: true })).toBe(true)
  })

  it('pill accesa: «Cerco nei documenti», estratti nel system prompt con la fonte, voce nel monitor, fonti salvate sulla risposta', async () => {
    const { knowledge, chat } = services()
    const conv = await createConversation(h.db, { model: 'chat' })
    await knowledge.addFiles(conv, [join(fixtures, 'relazione.txt'), join(fixtures, 'manuale.md')])
    await knowledge.wait(conv.id)
    const before = fake.requests.length
    const sent = await chat.send({}, conv.id, 'Quante persone ha assunto la sede di Torino?')
    await chat.wait(sent.streamId)
    expect(sent.userMessage?.knowledge).toBeNull()
    const types = events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)
    expect(types[0]).toBe('searching')
    expect(types).not.toContain('remembering')
    const system = chatBodyFor('Quante persone ha assunto la sede di Torino?').messages[0].content
    expect(system).toContain('# Base di conoscenza')
    expect(system).toContain('[relazione]\n')
    expect(system).toContain('Torino')
    // i due documenti stanno nel quarto di memoria: vanno per intero (anche il manuale)
    expect(system).toContain('riportati per intero (2 in tutto)')
    expect(system).toContain('Windows')
    // documenti interi: non serve nemmeno l'embedding della domanda
    expect(embedQueries(before)).toBe(0)
    const calls = (await listContextCalls(h.db, conv.id)).filter((c) => c.kind !== 'title')
    expect(calls[0].kind).toBe('chat')
    expect(calls[0].parts.find((p) => p.key === 'knowledge')).toMatchObject({ label: 'knowledge', count: 2 })
    expect(calls[1].kind).toBe('embed-doc')
    const answer = (await listMessages(h.db, conv.id)).at(-1)!
    expect(answer.role).toBe('assistant')
    expect(answer.knowledgeRefs?.map((r) => [r.title, r.whole])).toEqual([['manuale', true], ['relazione', true]])
    expect(answer.knowledgeRefs?.[1].excerpt).toContain('Relazione annuale')
    expect(answer.memoryRefs).toBeNull()
  })

  it('bottone libro: spento per una domanda con la pill accesa → nessuna ricerca; acceso con la pill spenta → ricerca; «Rigenera» ripete la scelta', async () => {
    const { knowledge, chat } = services()
    let conv = await createConversation(h.db, { model: 'chat' })
    await knowledge.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await knowledge.wait(conv.id)

    let before = fake.requests.length
    let sent = await chat.send({}, conv.id, 'Quante persone ha assunto la sede di Torino?', { knowledge: false })
    await chat.wait(sent.streamId)
    expect(sent.userMessage?.knowledge).toBe(false)
    expect(events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)[0]).toBe('content')
    expect(embedQueries(before)).toBe(0)
    expect(chatBodyFor('Quante persone ha assunto la sede di Torino?').messages[0].role).toBe('user')
    expect((await listMessages(h.db, conv.id)).at(-1)!.knowledgeRefs).toBeNull()

    conv = await updateConversation(h.db, conv.id, { knowledge: false })
    before = fake.requests.length
    sent = await chat.send({}, conv.id, 'Quante persone ha assunto la sede di Torino?', { knowledge: true })
    await chat.wait(sent.streamId)
    expect(sent.userMessage?.knowledge).toBe(true)
    expect(events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)[0]).toBe('searching')
    expect(embedQueries(before)).toBe(0)
    expect(chatBodyFor('Quante persone ha assunto la sede di Torino?').messages[0].content).toContain('# Base di conoscenza')

    // rigenera: la domanda aveva il libro acceso, la pill è spenta → cerca di nuovo
    before = fake.requests.length
    const again = await chat.regenerate({}, conv.id)
    await chat.wait(again.streamId)
    expect(events.filter((e) => e.streamId === again.streamId).map((e) => e.type)[0]).toBe('searching')
    expect(embedQueries(before)).toBe(0)
  })

  it('senza documenti pronti non si cerca, anche con la pill accesa; plan mode salva la scelta sulla domanda', async () => {
    const { chat } = services()
    const conv = await createConversation(h.db, { model: 'chat' })
    const before = fake.requests.length
    const sent = await chat.send({}, conv.id, 'Ciao')
    await chat.wait(sent.streamId)
    expect(events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)[0]).toBe('content')
    expect(embedQueries(before)).toBe(0)
    const plan = await chat.proposePlan({}, conv.id, 'Pianifica', { knowledge: true })
    await chat.wait(plan.streamId)
    expect(plan.userMessage?.knowledge).toBe(true)
  })

  it('documenti e memoria insieme: un solo embedding della domanda, documenti prima della memoria nel budget, entrambe le sezioni nel prompt', async () => {
    const { knowledge, chat } = services()
    const conv0 = await createConversation(h.db, { model: 'chat', numCtx: 4096 })
    const texts = [
      ['user', 'Organizziamo il viaggio in Portogallo: il budget massimo è ottocento euro per persona'],
      ['assistant', 'Perfetto, con ottocento euro per persona possiamo stare a Lisbona e Porto.'],
      ['user', 'Parliamo di cucina: cosa mangiare a Porto?'],
      ['assistant', 'A Porto: francesinha, tripas, vinho verde.']
    ] as const
    for (const [role, content] of texts) await addMessage(h.db, { conversationId: conv0.id, role, content })
    const msgs = await listMessages(h.db, conv0.id)
    const conv = await updateConversation(h.db, conv0.id, { summary: 'Viaggio in Portogallo.', summaryUpTo: msgs[3].id, summaryUpdatedAt: Date.now() })
    await knowledge.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await knowledge.wait(conv.id)
    const before = fake.requests.length
    const sent = await chat.send({}, conv.id, 'Il budget in euro per persona del viaggio basta per le quattordici persone assunte a Torino?')
    await chat.wait(sent.streamId)
    const types = events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['searching', 'remembering'])
    const embeds = fake.requests.slice(before).filter((q) => q.path === '/api/embed')
    // indicizzazione della memoria (1) + domanda (1): la domanda non viene ricalcolata per i documenti
    expect(embeds.filter((q) => ((q.body as { input: string[] }).input ?? []).some((x) => x.includes('budget in euro'))).length).toBe(1)
    const system = chatBodyFor('Il budget in euro per persona del viaggio basta per le quattordici persone assunte a Torino?').messages[0].content
    expect(system.indexOf('# Riassunto della conversazione finora')).toBeLessThan(system.indexOf('# Dalla conversazione precedente'))
    expect(system.indexOf('# Dalla conversazione precedente')).toBeLessThan(system.indexOf('# Base di conoscenza'))
    const answer = (await listMessages(h.db, conv.id)).at(-1)!
    expect(answer.knowledgeRefs?.length).toBeGreaterThan(0)
    expect(answer.memoryRefs?.length).toBeGreaterThan(0)
    const call = (await listContextCalls(h.db, conv.id)).find((c) => c.kind === 'chat')!
    expect(call.parts.map((p) => p.key)).toEqual(['summary', 'memory', 'knowledge', 'question'])
  })
})

describe('base di conoscenza: plugin PDF, Word, cartella e segreti', () => {
  const signal = new AbortController().signal

  it('PDF: una sezione per pagina con «p. N», titolo dal nome del file; scansione senza testo → nessuna sezione', async () => {
    const { pdfSource, pageText } = await import('../src/main/knowledge/sources/pdf')
    expect(pageText([{ str: 'Ciao', hasEOL: false }, { str: 'mondo', hasEOL: true }, { str: 'fine' }])).toBe('Ciao mondo\nfine')
    const doc = await pdfSource.extract({ kind: 'file', path: join(fixtures, 'bilancio.pdf') }, {}, signal)
    expect(doc.title).toBe('bilancio')
    expect(doc.sections.map((s) => s.locator)).toEqual(['p. 1', 'p. 2'])
    expect(doc.sections[0].text).toContain('Genova')
    expect(doc.sections[1].text).toMatch(/^Nota integrativa\n/)
    expect(doc.meta).toEqual({ pages: '2' })
    const scan = await pdfSource.extract({ kind: 'file', path: join(fixtures, 'scansione.pdf') }, {}, signal)
    expect(scan.sections).toEqual([])
    await expect(pdfSource.extract({ kind: 'file', path: join(fixtures, 'relazione.txt') }, {}, signal)).rejects.toBeInstanceOf(SourceError)
  })

  it('Word: diviso ai titoli con la catena come locatore, entità decodificate', async () => {
    const { docxSource, htmlToMarkdown } = await import('../src/main/knowledge/sources/docx')
    expect(htmlToMarkdown('<h1>A &amp; B</h1><p>x</p><ul><li>uno</li><li>due</li></ul><table><tr><td>a</td><td>b</td></tr></table>')).toBe('# A & B\n\nx\n\n- uno\n- due\n\na\tb')
    const doc = await docxSource.extract({ kind: 'file', path: join(fixtures, 'contratto.docx') }, {}, signal)
    expect(doc.title).toBe('contratto')
    expect(doc.sections.map((s) => s.locator)).toEqual(['Contratto di fornitura', 'Contratto di fornitura › Durata', 'Contratto di fornitura › Penali'])
    expect(doc.sections[1].text).toBe('Il contratto dura ventiquattro mesi dalla firma & si rinnova tacitamente.')
    expect(doc.sections[2].text).toContain('Primo punto')
  })

  it('registro integrato: pdf, docx e cartella; la cartella elenca solo i file leggibili, salta nascosti e node_modules', async () => {
    const { createBuiltinRegistry } = await import('../src/main/knowledge/sources')
    const { listFolder } = await import('../src/main/knowledge/sources/folder')
    const reg = createBuiltinRegistry()
    expect(reg.all().map((s) => s.id)).toEqual(['text', 'pdf', 'docx', 'folder', 'package'])
    expect(reg.sourceFor({ kind: 'file', path: '/x/a.PDF' }).id).toBe('pdf')
    expect(reg.sourceFor({ kind: 'file', path: '/x/a.docx' }).id).toBe('docx')
    expect(reg.sourceFor({ kind: 'remote', sourceId: 'folder', uri: '/x/a.txt' }).id).toBe('folder')
    const folderInfo = reg.describe().find((s) => s.id === 'folder')!
    expect(folderInfo).toMatchObject({ kind: 'connected', label: 'Cartella del computer', configFields: [{ key: 'path', type: 'folder', required: true, label: 'Cartella' }] })
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-folder-'))
    try {
      writeFileSync(join(dir, 'b.txt'), 'testo b')
      writeFileSync(join(dir, 'a.md'), '# a\n\ntesto a')
      writeFileSync(join(dir, 'foto.png'), 'x')
      writeFileSync(join(dir, '.nascosto.txt'), 'x')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(dir, 'node_modules'))
      writeFileSync(join(dir, 'node_modules', 'c.txt'), 'x')
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'd.txt'), 'testo d')
      const listed = await listFolder(dir, reg.extensions())
      expect(listed.map((l) => l.title)).toEqual(['a', 'b', 'd'])
      expect(listed[0].ref).toMatchObject({ kind: 'remote', sourceId: 'folder', uri: join(dir, 'a.md') })
      expect(listed[0].version).toMatch(/^\d+(\.\d+)?:\d+$/)
      await expect(listFolder(join(dir, 'manca'), reg.extensions())).rejects.toThrow(/non è una cartella/)
      // extract delega al plugin del file e riporta la versione
      const folder = reg.get('folder')!
      const doc = await folder.extract({ kind: 'remote', sourceId: 'folder', uri: join(dir, 'a.md') }, { path: dir }, signal)
      expect(doc.sections[0].locator).toBe('a')
      expect(doc.version).toBe(listed[0].version)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('segreti: i campi secret si cifrano al salvataggio, si aprono per il plugin, si mascherano per il renderer; i campi obbligatori si controllano', async () => {
    const { sealConfig, openConfig, maskConfig } = await import('../src/main/knowledge/secrets')
    const source: KnowledgeSource = {
      id: 'site',
      labelKey: 'knowledge.source.text',
      kind: 'connected',
      configFields: [
        { key: 'url', labelKey: 'common.save', type: 'text', required: true },
        { key: 'token', labelKey: 'common.save', type: 'secret', required: false }
      ],
      canHandle: () => false,
      extract: async () => ({ title: '', sections: [] })
    }
    const cipher = { encrypt: (s: string) => `E(${s})`, decrypt: (s: string) => s.slice(2, -1) }
    const sealed = sealConfig(source, { url: ' https://x ', token: 'abc', extra: 'no' }, cipher)
    expect(sealed).toEqual({ url: 'https://x', token: 'E(abc)' })
    expect(openConfig(source, sealed, cipher)).toEqual({ url: 'https://x', token: 'abc' })
    expect(maskConfig(source, sealed)).toEqual({ url: 'https://x', token: '••••••' })
    expect(() => sealConfig(source, { token: 'abc' }, cipher)).toThrow(/obbligatorio/)
  })
})

describe('base di conoscenza: sorgente collegata (cartella)', () => {
  let fake: FakeOllama
  let h: DbHandle
  let dir: string
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192 },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    dir = mkdtempSync(join(tmpdir(), 'fastchat-conn-'))
    writeFileSync(join(dir, 'uno.txt'), 'Il primo documento parla di gatti.')
    writeFileSync(join(dir, 'due.md'), '# Due\n\nIl secondo documento parla di cani.')
  })
  afterEach(() => {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function service() {
    const { createBuiltinRegistry } = await import('../src/main/knowledge/sources')
    const ollama = createOllamaClient(() => fake.url)
    const embedder = createEmbedder({ db: h.db, ollama })
    return createKnowledge({ db: h.db, embedder, registry: createBuiltinRegistry() })
  }

  it('collega una cartella: i file vengono indicizzati; «Aggiorna» prende i nuovi, rifà i cambiati, toglie gli spariti; scollega rimuove tutto', async () => {
    const k = await service()
    const conv = await createConversation(h.db, { model: 'chat' })
    const conn = await k.connect(conv, 'folder', { path: dir })
    expect(conn).toMatchObject({ source: 'folder', status: 'ready', config: { path: dir } })
    expect(conn.lastSyncAt).not.toBeNull()
    await k.wait(conv.id)
    let docs = await convDocs(h.db, conv.id)
    expect(docs.map((d) => [d.title, d.status, d.connectionId === conn.id])).toEqual([
      ['due', 'ready', true],
      ['uno', 'ready', true]
    ])
    expect(docs[1].ref).toMatchObject({ kind: 'remote', sourceId: 'folder' })
    expect(await k.hasReady(conv.id)).toBe(true)
    const found = await k.recall(conv, { vector: async () => fakeEmbedding('documento parla gatti'), text: 'documento parla gatti' }, 64, 4)
    expect(found.refs.map((r) => r.title).sort()).toEqual(['due', 'uno'])

    // nuovo file, file cambiato (contenuto diverso → versione diversa), file sparito
    const firstVersion = docs[1].version
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(dir, 'uno.txt'), 'Il primo documento ora parla di conigli, ed è più lungo.')
    writeFileSync(join(dir, 'tre.txt'), 'Il terzo documento parla di pesci.')
    rmSync(join(dir, 'due.md'))
    const again = await k.refresh(conv, conn.id)
    expect(again.status).toBe('ready')
    await k.wait(conv.id)
    docs = await convDocs(h.db, conv.id)
    expect(docs.map((d) => [d.title, d.status])).toEqual([
      ['uno', 'ready'],
      ['tre', 'ready']
    ])
    expect(docs[0].version).not.toBe(firstVersion)
    const chunks = await listKnowledgeChunks(h.db, [docs[0].id], 'embeddinggemma')
    expect(chunks[0].text).toContain('conigli')

    const s = await k.status(conv)
    expect(s.connections).toHaveLength(1)
    await k.disconnect(conv, conn.id)
    expect(await convDocs(h.db, conv.id)).toEqual([])
    expect((await k.status(conv)).connections).toEqual([])
    await expect(k.refresh(conv, conn.id)).rejects.toThrow(/Connessione non trovata/)
  })

  it('cartella inesistente o campo mancante: la connessione finisce in errore o non si crea', async () => {
    const k = await service()
    const conv = await createConversation(h.db, { model: 'chat' })
    await expect(k.connect(conv, 'folder', {})).rejects.toThrow(/obbligatorio/)
    await expect(k.connect(conv, 'nope', { path: dir })).rejects.toThrow(/Sorgente non disponibile/)
    const conn = await k.connect(conv, 'folder', { path: join(dir, 'manca') })
    expect(conn.status).toBe('error')
    expect(conn.error).toMatch(/non è una cartella/)
  })
})

describe('base di conoscenza: parole esatte, documenti interi e «fissa»', () => {
  let fake: FakeOllama
  let h: DbHandle
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 4096', chunks: [{ content: 'Ok.' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
  })
  afterEach(() => h.close())

  async function withInvoices(n: number, numCtx = 4096) {
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-inv-'))
    const paths: string[] = []
    for (let i = 1; i <= n; i++) {
      const p = join(dir, `fattura-${String(i).padStart(2, '0')}.txt`)
      writeFileSync(p, `Fattura numero 2026/${String(i).padStart(3, '0')} emessa dal fornitore ${['Rossi', 'Bianchi', 'Verdi'][i % 3]} Srl per lavori edili.\n\nImporto totale ${i * 100} euro, scadenza il ${i} giugno.`)
      paths.push(p)
    }
    const ollama = createOllamaClient(() => fake.url)
    const embedder = createEmbedder({ db: h.db, ollama })
    const k = createKnowledge({ db: h.db, embedder, registry: createRegistry(BUILTIN_SOURCES) })
    const conv = await createConversation(h.db, { model: 'chat', numCtx })
    await k.addFiles(conv, paths)
    await k.wait(conv.id)
    return { k, conv, dir }
  }

  it('la tabella FTS5 segue i pezzi: ricerca per numero di fattura e nome, con accenti ignorati; cancellando il documento sparisce', async () => {
    const { k, conv, dir } = await withInvoices(5)
    try {
      const docs = await convDocs(h.db, conv.id)
      const ids = docs.map((d) => d.id)
      const { searchKnowledgeChunks } = await import('../src/main/db/repo')
      const hits = await searchKnowledgeChunks(h.db, ids, 'embeddinggemma', ftsQuery('fattura 2026/003'))
      // tutte contengono «fattura»; quella con 003 ha il punteggio più alto
      const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]
      const chunks = await listKnowledgeChunks(h.db, ids, 'embeddinggemma')
      expect(chunks.find((c) => c.id === best[0])!.text).toContain('2026/003')
      expect((await searchKnowledgeChunks(h.db, ids, 'embeddinggemma', '"edilì"')).size).toBe(5)
      expect((await searchKnowledgeChunks(h.db, ids, 'embeddinggemma', '')).size).toBe(0)
      await k.remove(conv, docs[0].id)
      expect((await searchKnowledgeChunks(h.db, ids, 'embeddinggemma', '"fattura"')).size).toBe(4)
      expect(h.raw.prepare("select count(*) n from knowledge_fts where knowledge_fts match 'fattura'").get()).toEqual({ n: 4 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('con il budget stretto la ricerca ibrida trova la fattura per numero anche se la somiglianza semantica è bassa', async () => {
    const { k, conv, dir } = await withInvoices(12)
    try {
      // la domanda condivide poche parole con le fatture (il coseno finto è basso), ma il numero è esatto
      const q = 'Dimmi il totale della 2026/007'
      const found = await k.recall(conv, { vector: async () => fakeEmbedding(q), text: q }, 120, 4)
      expect(found.refs.length).toBeGreaterThan(0)
      expect(found.refs[0].excerpt).toContain('2026/007')
      expect(found.refs.every((r) => !r.whole)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('quaranta fatture che stanno nella memoria: tutte per intero, una fonte per documento; la chat le riceve tutte', async () => {
    // memoria da 8k: il quarto riservato ai documenti (2k token) basta per 40 fatture brevi (~1.500 token)
    const { k, conv, dir } = await withInvoices(40, 8192)
    try {
      const s = await k.status(conv)
      expect(s.documents).toHaveLength(40)
      expect(s.totalChars).toBeGreaterThan(40 * 100)
      const budgetTokens = Math.ceil(s.totalChars / 4) + 10
      const found = await k.recall(conv, { vector: async () => fakeEmbedding('quante fatture'), text: 'quante fatture' }, budgetTokens, 4)
      expect(found.refs).toHaveLength(40)
      expect(found.refs.every((r) => r.whole)).toBe(true)
      expect(found.section).toContain('(40 in tutto)')
      expect((found.section.match(/\[fattura-\d\d\]/g) ?? []).length).toBe(40)
      // nella chat: il quarto della memoria basta → il modello le legge tutte
      const ollama = createOllamaClient(() => fake.url)
      const chat = createChatService({ db: h.db, ollama, knowledge: k, embedder: k.embedder, emit: () => undefined })
      const sent = await chat.send({}, conv.id, 'Quante fatture ci sono e qual è il totale?')
      await chat.wait(sent.streamId)
      const body = fake.requests.filter((q) => q.path === '/api/chat').map((q) => q.body as { messages: Array<{ role: string; content: string }> }).findLast((b) => b.messages.at(-1)?.content.startsWith('Quante fatture'))!
      expect((body.messages[0].content.match(/\[fattura-\d\d\]/g) ?? []).length).toBe(40)
      const answer = (await listMessages(h.db, conv.id)).at(-1)!
      expect(answer.knowledgeRefs).toHaveLength(40)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('documento «intero» (fissato): va per intero prima degli estratti anche quando non ci sta tutto; lo stato ne riporta i caratteri', async () => {
    const { k, conv, dir } = await withInvoices(12)
    try {
      const docs = await convDocs(h.db, conv.id)
      const pinned = await k.setPinned(conv, docs[11].id, true)
      expect(pinned.pinned).toBe(true)
      const s = await k.status(conv)
      expect(s.pinnedChars).toBeGreaterThan(50)
      expect(s.pinnedChars).toBeLessThan(s.totalChars)
      const q = 'Dimmi il totale della 2026/007'
      const found = await k.recall(conv, { vector: async () => fakeEmbedding(q), text: q }, 120, 4)
      expect(found.refs[0]).toMatchObject({ title: 'fattura-12', whole: true })
      expect(found.refs.slice(1).some((r) => r.excerpt.includes('2026/007'))).toBe(true)
      expect(found.section.indexOf('[fattura-12]')).toBeLessThan(found.section.indexOf('Seguono estratti'))
      await expect(k.setPinned(conv, 'nope', true)).rejects.toThrow(/Documento non trovato/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('basi di conoscenza: base della conversazione e basi della libreria collegate', () => {
  let fake: FakeOllama
  let h: DbHandle
  let progress: KnowledgeProgress[]
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 4096', chunks: [{ content: 'Ok.' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
    progress = []
  })
  afterEach(() => h.close())

  function services() {
    const ollama = createOllamaClient(() => fake.url)
    const contextLog = createContextLog(h.db)
    const embedder = createEmbedder({ db: h.db, ollama, contextLog })
    const knowledge = createKnowledge({ db: h.db, embedder, registry: createRegistry(BUILTIN_SOURCES), onProgress: (p) => progress.push(p) })
    const chat = createChatService({ db: h.db, ollama, knowledge, embedder, contextLog, emit: () => undefined })
    return { knowledge, chat }
  }

  it('la base della conversazione nasce al primo documento, non guardando lo stato; sparisce con la conversazione', async () => {
    const { knowledge: k } = services()
    const conv = await createConversation(h.db, { model: 'chat' })
    expect(await k.status(conv)).toMatchObject({ baseId: null, documents: [], linked: [], ready: 0 })
    expect(await getConversationBase(h.db, conv.id)).toBeNull()
    await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await k.wait(conv.id)
    const base = (await getConversationBase(h.db, conv.id))!
    expect(base).toMatchObject({ origin: 'conversation', conversationId: conv.id })
    expect(await k.status(conv)).toMatchObject({ baseId: base.id, ready: 1 })
    expect(progress.at(-1)).toMatchObject({ baseId: base.id, status: 'ready' })
    const { removeConversation } = await import('../src/main/db/repo')
    await removeConversation(h.db, conv.id)
    expect(await listDocuments(h.db, base.id)).toEqual([])
    expect(h.raw.prepare('select count(*) n from knowledge_chunks').get()).toEqual({ n: 0 })
  })

  it('libreria: crea, rinomina, elenca con i numeri; i documenti di una base non finiscono nel monitor di nessuna conversazione', async () => {
    const { knowledge: k } = services()
    await expect(k.createBase('  ')).rejects.toThrow(/ha bisogno di un nome/)
    const base = await k.createBase('Normativa')
    expect(base).toMatchObject({ name: 'Normativa', origin: 'local', documents: 0, ready: 0, conversations: 0 })
    await k.addFiles(base, [join(fixtures, 'manuale.md')])
    await k.wait(base.id)
    expect(await k.status(base)).toMatchObject({ baseId: base.id, chunks: 4, ready: 1, linked: [] })
    const renamed = await k.renameBase(base.id, { name: 'Manuali', description: 'Guide del prodotto' })
    expect(renamed).toMatchObject({ name: 'Manuali', description: 'Guide del prodotto', documents: 1, ready: 1 })
    expect(renamed.chars).toBeGreaterThan(50)
    expect((await k.listBases()).map((b) => b.name)).toEqual(['Manuali'])
    expect(h.raw.prepare('select count(*) n from context_calls').get()).toEqual({ n: 0 })
    // la base di una conversazione non è nella libreria e non si rinomina né si elimina da lì
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await k.wait(conv.id)
    const own = (await getConversationBase(h.db, conv.id))!
    expect((await k.listBases()).map((b) => b.id)).toEqual([base.id])
    await expect(k.removeBase(own.id)).rejects.toThrow(/non trovata/)
    await expect(k.link(conv, own.id)).rejects.toThrow(/non trovata/)
    // owner: dall'id si risale alla conversazione o alla base
    expect(await k.owner(conv.id)).toMatchObject({ id: conv.id, model: 'chat' })
    expect(await k.owner(base.id)).toMatchObject({ id: base.id, origin: 'local' })
    await expect(k.owner('nope')).rejects.toThrow(/non trovata/)
  })

  it('una base collegata a due conversazioni: indicizzata una volta, usata da entrambe insieme ai documenti propri; le fonti dicono la base', async () => {
    const { knowledge: k, chat } = services()
    const base = await k.createBase('Manuali')
    await k.addFiles(base, [join(fixtures, 'manuale.md')])
    await k.wait(base.id)
    const embedsAfterIndex = fake.requests.filter((r) => r.path === '/api/embed').length
    const a = await createConversation(h.db, { model: 'chat', numCtx: 4096 })
    const b = await createConversation(h.db, { model: 'chat', numCtx: 4096 })
    await k.link(a, base.id)
    await k.link(a, base.id) // due volte: nessun doppione
    await k.link(b, base.id)
    await k.addFiles(a, [join(fixtures, 'relazione.txt')])
    await k.wait(a.id)
    // collegare non reindicizza: l'unico embedding in più è il documento di A
    expect(fake.requests.filter((r) => r.path === '/api/embed').length).toBe(embedsAfterIndex + 1)
    expect((await k.listBases())[0]).toMatchObject({ conversations: 2 })

    const sa = await k.status(a)
    expect(sa.documents.map((d) => d.title)).toEqual(['relazione'])
    expect(sa.linked.map((l) => [l.name, l.documents, l.ready])).toEqual([['Manuali', 1, 1]])
    expect(sa.ready).toBe(2)
    expect(sa.totalChars).toBeGreaterThan(sa.linked[0].chars)
    const sb = await k.status(b)
    expect(sb).toMatchObject({ baseId: null, documents: [], ready: 1 })
    expect(await k.hasReady(b.id)).toBe(true)

    // A: i due documenti stanno nella memoria → entrambi interi; la fonte della base collegata porta il suo nome
    const q = { vector: async () => fakeEmbedding('installazione Windows'), text: 'installazione Windows' }
    const ra = await k.recall(a, q, 800, 4)
    expect(ra.refs.map((r) => [r.title, r.base])).toEqual([['manuale', 'Manuali'], ['relazione', undefined]])
    // B vede solo la base collegata
    const rb = await k.recall(b, q, 800, 4)
    expect(rb.refs.map((r) => [r.title, r.base])).toEqual([['manuale', 'Manuali']])
    // nella chat di B la risposta usa il manuale
    const sent = await chat.send({}, b.id, 'Come si installa su Windows?')
    await chat.wait(sent.streamId)
    const answer = (await listMessages(h.db, b.id)).at(-1)!
    expect(answer.knowledgeRefs?.[0]).toMatchObject({ title: 'manuale', base: 'Manuali', whole: true })

    // dalla conversazione non si toccano i documenti della base collegata
    const doc = (await listDocuments(h.db, base.id))[0]
    await expect(k.remove(a, doc.id)).rejects.toThrow(/Documento non trovato/)
    await expect(k.setPinned(a, doc.id, true)).rejects.toThrow(/Documento non trovato/)
    // «Intero» si imposta sulla base e vale per chi la collega
    expect((await k.setPinned(base, doc.id, true)).pinned).toBe(true)
    expect((await k.status(b)).pinnedChars).toBeGreaterThan(0)

    // scollega da B: B non ha più nulla; A continua a usarla
    await k.unlink(b, base.id)
    expect(await k.hasReady(b.id)).toBe(false)
    expect((await k.status(a)).linked).toHaveLength(1)
    // eliminando la base dalla libreria sparisce anche da A, con documenti e pezzi; i documenti di A restano
    await k.removeBase(base.id)
    const after = await k.status(a)
    expect(after.linked).toEqual([])
    expect(after.ready).toBe(1)
    expect(await listKnowledgeChunks(h.db, [doc.id], 'embeddinggemma')).toEqual([])
    expect(await k.listBases()).toEqual([])
  })

  it('tipi di base: comportamento ed esempi entrano sempre e senza fonti, i documenti solo a libro acceso', async () => {
    const { knowledge: k } = services()
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-role-'))
    writeFileSync(join(dir, 'tecniche.md'), 'Rispondi con passi numerati e nomi esatti dei pulsanti.')
    writeFileSync(join(dir, 'esempi.md'), 'Domanda: come creo una base?\nRisposta: 1. Apri Impostazioni. 2. Scegli Conoscenza.')
    const behavior = await k.createBase('Tecniche')
    const examples = await k.createBase('Esempi')
    await k.addFiles(behavior, [join(dir, 'tecniche.md')])
    await k.addFiles(examples, [join(dir, 'esempi.md')])
    await k.wait(behavior.id)
    await k.wait(examples.id)
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.addFiles(conv, [join(fixtures, 'relazione.txt')])
    await k.wait(conv.id)
    await k.link(conv, behavior.id)
    await k.link(conv, examples.id)
    // appena collegate sono «documenti», come ogni base: nulla cambia finché non si sceglie l'uso
    expect((await k.status(conv)).linked.map((b) => b.purpose)).toEqual(['documents', 'documents'])
    expect(await k.hasRole(conv.id)).toBe(false)
    await k.setPurpose(conv, behavior.id, 'behavior')
    await k.setPurpose(conv, examples.id, 'examples')
    await expect(k.setPurpose(conv, behavior.id, 'altro' as never)).rejects.toThrow(/non valido/)
    await expect(k.setPurpose(conv, 'nope', 'behavior')).rejects.toThrow(/non trovata/)
    const st = await k.status(conv)
    expect(st.linked.map((b) => [b.name, b.purpose])).toEqual([['Tecniche', 'behavior'], ['Esempi', 'examples']])
    // «pronti» conta solo i documenti su cui rispondere: è ciò che abilita il bottone libro
    expect(st.ready).toBe(1)
    expect(await k.hasRole(conv.id)).toBe(true)

    const q = { text: 'come si usa?', vector: async () => fakeEmbedding('come si usa?') }
    const all = await k.recallAll(conv, q, { total: 2000, shares: { behavior: 0.2, examples: 0.2, documents: 0.6 }, documents: true }, 4)
    expect(all.behavior).toEqual({ section: '# Come lavorare\n\nTecniche e regole del tuo ruolo. Applicale nella risposta; non citarle e non presentarle come fonti.\n\nRispondi con passi numerati e nomi esatti dei pulsanti.', count: 1 })
    expect(all.examples.section).toBe('# Esempi\n\nEsempi di risposte ben fatte, ciascuno tra i tag <esempio>. Imitane struttura e stile; non copiarne il contenuto e non citarli.\n\n<esempio>\nDomanda: come creo una base?\nRisposta: 1. Apri Impostazioni. 2. Scegli Conoscenza.\n</esempio>')
    expect(all.documents.section).toMatch(/^# Base di conoscenza/)
    // le fonti sono solo quelle dei documenti
    expect(all.documents.refs.map((r) => r.title)).toEqual(['relazione'])
    expect(all.documents.section).not.toContain('passi numerati')
    // libro spento: niente documenti, tecniche ed esempi restano
    const off = await k.recallAll(conv, q, { total: 2000, shares: { behavior: 0.2, examples: 0.2, documents: 0.6 }, documents: false }, 4)
    expect(off.documents).toEqual({ section: '', refs: [] })
    expect(off.behavior.count).toBe(1)
    expect(off.examples.count).toBe(1)
    // recall (solo documenti) non vede le basi del ruolo
    expect((await k.recall(conv, q, 2000, 4)).section).toBe(all.documents.section)
    rmSync(dir, { recursive: true, force: true })
  })

  it('nella chat: tecniche ed esempi nel prompt anche con la base di conoscenza spenta, senza fonti sotto la risposta; voci nel monitor', async () => {
    const { knowledge: k, chat } = services()
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-role-'))
    writeFileSync(join(dir, 'tecniche.md'), 'Rispondi con passi numerati.')
    const behavior = await k.createBase('Tecniche')
    await k.addFiles(behavior, [join(dir, 'tecniche.md')])
    await k.wait(behavior.id)
    const conv = await createConversation(h.db, { model: 'chat', knowledge: false })
    await k.link(conv, behavior.id)
    await k.setPurpose(conv, behavior.id, 'behavior')
    const { streamId } = await chat.send({}, conv.id, 'come creo una base?')
    await chat.wait(streamId)
    const body = fake.requests.filter((r) => r.path === '/api/chat').at(-2)!.body as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '# Come lavorare\n\nTecniche e regole del tuo ruolo. Applicale nella risposta; non citarle e non presentarle come fonti.\n\nRispondi con passi numerati.' })
    const answer = (await listMessages(h.db, conv.id)).at(-1)!
    expect(answer.knowledgeRefs ?? []).toEqual([])
    const call = (await listContextCalls(h.db, conv.id)).find((c) => c.kind === 'chat')!
    expect(call.parts.map((p) => [p.key, p.count])).toEqual([['behavior', 1], ['question', undefined]])
    rmSync(dir, { recursive: true, force: true })
  })

  it('cambio del modello di embedding: ensureModel rifà anche i documenti delle basi collegate', async () => {
    const { knowledge: k } = services()
    const base = await k.createBase('Manuali')
    await k.addFiles(base, [join(fixtures, 'manuale.md')])
    await k.wait(base.id)
    const conv = await createConversation(h.db, { model: 'chat' })
    await k.link(conv, base.id)
    await setSettings(h.db, { embeddingModel: 'embeddinggemma:latest' })
    expect(await k.hasReady(conv.id)).toBe(false)
    await k.ensureModel(conv)
    await k.wait(conv.id)
    expect(await k.hasReady(conv.id)).toBe(true)
  })
})
