import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatService } from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addMessage, createConversation, getConversation, listChunks, listMessages, saveModelSetting, setSettings, updateConversation } from '../src/main/db/repo'
import { createMemory, memoryBudget } from '../src/main/memory'
import { createOllamaClient } from '../src/main/ollama'
import { buildChunks, buildMemorySection, cosine, fromBuffer, memoryQuery, pickChunks, splitParagraphs, toBuffer } from '../src/shared/memory'
import type { StreamEvent } from '../src/shared/types'
import { fakeEmbedding, startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

describe('memoria: funzioni pure', () => {
  it('splitParagraphs: blocchi per paragrafi entro il limite, paragrafi lunghi tagliati', () => {
    expect(splitParagraphs('uno\n\ndue\n\ntre', 8)).toEqual(['uno\n\ndue', 'tre'])
    expect(splitParagraphs('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  it('buildChunks: la risposta porta con sé la domanda; le domande lunghe sono anche un pezzo a sé; "ok" no', () => {
    const chunks = buildChunks([
      { id: 'u1', role: 'user', content: 'Il mio budget per il viaggio in Portogallo è di 800 euro' },
      { id: 'a1', role: 'assistant', content: 'Primo paragrafo.\n\nSecondo paragrafo.' },
      { id: 'u2', role: 'user', content: 'ok' },
      { id: 'a2', role: 'assistant', content: 'Bene.' }
    ])
    expect(chunks.map((c) => [c.messageId, c.role])).toEqual([
      ['u1', 'user'],
      ['a1', 'assistant'],
      ['a2', 'assistant']
    ])
    expect(chunks[1].text).toBe('Domanda: Il mio budget per il viaggio in Portogallo è di 800 euro\nRisposta: Primo paragrafo.\n\nSecondo paragrafo.')
    expect(chunks[2].text).toBe('Domanda: ok\nRisposta: Bene.')
    // risposta lunga: più pezzi, ciascuno con la domanda
    const long = buildChunks([{ id: 'q', role: 'user', content: 'Spiega' }, { id: 'a', role: 'assistant', content: Array.from({ length: 10 }, (_, i) => `Paragrafo ${i} ` + 'x'.repeat(300)).join('\n\n') }])
    expect(long.length).toBeGreaterThan(1)
    expect(long.every((c) => c.text.startsWith('Domanda: Spiega\nRisposta: ') && c.text.length <= 1600)).toBe(true)
  })

  it('cosine, toBuffer/fromBuffer', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([0, 0], [1, 0])).toBe(0)
    expect(Array.from(fromBuffer(toBuffer([0.5, -1, 2])))).toEqual([0.5, -1, 2])
  })

  it('pickChunks: soglia assoluta e relativa, frasi dell\'utente favorite, un pezzo per messaggio, budget', () => {
    const c = (id: string, messageId: string, role: 'user' | 'assistant', embedding: number[]) => ({ id, messageId, role, text: id.repeat(10), embedding })
    const q = [1, 0, 0]
    const chunks = [
      c('a', 'm1', 'assistant', [0.9, 0.1, 0]),
      c('b', 'm1', 'assistant', [0.8, 0.2, 0]), // stesso messaggio di a: escluso
      c('u', 'm2', 'user', [0.85, 0.15, 0]), // utente: ×1,1 → primo
      c('z', 'm3', 'assistant', [0, 0, 1]) // non pertinente
    ]
    expect(pickChunks(q, chunks, 1000).map((p) => p.id)).toEqual(['u', 'a'])
    // budget: ci sta un solo pezzo (10 caratteri)
    expect(pickChunks(q, chunks, 15).map((p) => p.id)).toEqual(['u'])
    // niente sopra la soglia: nessun estratto
    expect(pickChunks([0, 1, 0], [c('a', 'm1', 'assistant', [1, 0, 0])], 1000)).toEqual([])
  })

  it('memoryQuery e buildMemorySection: ordine cronologico, posizione, avvertenza sulle correzioni', () => {
    expect(memoryQuery(' e quello? ', 'x'.repeat(600))).toBe(`e quello?\n\nContesto: ${'x'.repeat(500)}`)
    expect(memoryQuery('domanda', null)).toBe('domanda')
    const s = buildMemorySection(
      [
        { text: 'Risposta: dopo', role: 'assistant', position: 7 },
        { text: 'Utente: prima', role: 'user', position: 2 }
      ],
      30
    )
    expect(s).toMatch(/^# Dalla conversazione precedente\n\n.*valgono il riassunto e i messaggi recenti/)
    expect(s.indexOf('[messaggio 2 di 30 · utente]')).toBeLessThan(s.indexOf('[messaggio 7 di 30 · assistente]'))
    expect(buildMemorySection([], 30)).toBe('')
  })

  it('memoryBudget: al massimo il 12% e solo lo spazio rimasto', () => {
    expect(memoryBudget(4096, 819, 1000)).toBe(491)
    expect(memoryBudget(4096, 819, 3200)).toBe(77)
    expect(memoryBudget(4096, 819, 4000)).toBe(0)
  })
})

describe('memoria: indicizzazione e recupero', () => {
  let fake: FakeOllama
  let h: DbHandle
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 2048', chunks: [{ content: 'Riassunto breve.' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
  })
  afterEach(() => h.close())

  /** Conversazione già riassunta fino al messaggio 6, con un dettaglio preciso all'inizio. */
  async function summarized(model = 'chat') {
    const conv = await createConversation(h.db, { model, numCtx: 2048 })
    const texts = [
      ['user', 'Organizziamo il viaggio in Portogallo: il budget massimo è ottocento euro per persona'],
      ['assistant', 'Perfetto, con ottocento euro per persona possiamo stare a Lisbona e Porto.'],
      ['user', 'Preferisco treni ai voli interni, e niente ostelli'],
      ['assistant', 'Allora treno Lisbona Porto e alberghi tre stelle.'],
      ['user', 'Parliamo di cucina: cosa mangiare a Porto?'],
      ['assistant', 'A Porto: francesinha, tripas, vinho verde.'],
      ['user', 'E i musei di Lisbona?'],
      ['assistant', 'Gulbenkian e Museu do Azulejo.']
    ] as const
    for (const [role, content] of texts) await addMessage(h.db, { conversationId: conv.id, role, content })
    const msgs = await listMessages(h.db, conv.id)
    return updateConversation(h.db, conv.id, { summary: 'Viaggio in Portogallo, cucina e musei.', summaryUpTo: msgs[5].id, summaryUpdatedAt: Date.now() })
  }

  it('indicizza solo i messaggi coperti dal riassunto, una volta sola', async () => {
    const memory = createMemory({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await summarized()
    const added = await memory.index(conv)
    const chunks = await listChunks(h.db, conv.id, 'embeddinggemma')
    expect(added).toBe(chunks.length)
    const msgs = await listMessages(h.db, conv.id)
    const covered = new Set(msgs.slice(0, 6).map((m) => m.id))
    expect(chunks.every((c) => covered.has(c.messageId))).toBe(true)
    expect(await memory.index(conv)).toBe(0)
    expect(fromBuffer(chunks[0].embedding)).toHaveLength(64)
  })

  it('niente riassunto o memoria spenta: niente indice, niente estratti', async () => {
    const memory = createMemory({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await createConversation(h.db, { model: 'chat' })
    await addMessage(h.db, { conversationId: conv.id, role: 'user', content: 'Una domanda abbastanza lunga da diventare un pezzo' })
    expect(await memory.index(conv)).toBe(0)
    expect(await memory.recall(conv, 500)).toEqual({ section: '', refs: [] })
    const off = await updateConversation(h.db, (await summarized()).id, { longMemory: false })
    expect(await memory.recall(off, 500)).toEqual({ section: '', refs: [] })
  })

  it('recupera il dettaglio giusto per la domanda; gli embedding seguono la CPU del modello di chat', async () => {
    await saveModelSetting(h.db, 'chat', { numGpu: 0 })
    const memory = createMemory({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await summarized()
    await addMessage(h.db, { conversationId: conv.id, role: 'user', content: 'Quanti euro di budget avevamo per persona?' })
    const before = fake.requests.length
    const r = await memory.recall(conv, 500)
    expect(r.refs.length).toBeGreaterThan(0)
    expect(r.refs[0]).toMatchObject({ position: 1, role: 'user' })
    expect(r.section).toContain('ottocento euro per persona')
    const embeds = fake.requests.slice(before).filter((q) => q.path === '/api/embed').map((q) => q.body as { options?: { num_gpu?: number } })
    expect(embeds.length).toBeGreaterThan(1) // indicizzazione + domanda
    expect(embeds.every((b) => b.options?.num_gpu === 0)).toBe(true)
  })

  it('modello di embedding cambiato: i pezzi del vecchio modello vengono rifatti', async () => {
    const memory = createMemory({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await summarized()
    await memory.index(conv)
    await setSettings(h.db, { embeddingModel: 'embeddinggemma:latest' })
    const added = await memory.index(conv)
    expect(added).toBeGreaterThan(0)
    expect(await listChunks(h.db, conv.id, 'embeddinggemma')).toHaveLength(0)
  })

  it('modello di embedding non installato: lo stato lo dice, la risposta parte comunque senza estratti', async () => {
    await setSettings(h.db, { embeddingModel: 'manca' })
    const ollama = createOllamaClient(() => fake.url)
    const memory = createMemory({ db: h.db, ollama })
    const conv = await summarized()
    expect(await memory.status(conv)).toMatchObject({ modelInstalled: false, chunks: 0 })
    const chat = createChatService({ db: h.db, ollama, memory, emit: () => undefined })
    await addMessage(h.db, { conversationId: conv.id, role: 'user', content: 'x' })
    const sent = await chat.send({}, conv.id, 'Budget?')
    await chat.wait(sent.streamId)
    const last = (await listMessages(h.db, conv.id)).at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.memoryRefs).toBeNull()
  })

  it('chat: «Cerco nella conversazione», estratti nel system prompt dopo il riassunto, riferimenti salvati sulla risposta', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const memory = createMemory({ db: h.db, ollama })
    const events: StreamEvent[] = []
    const chat = createChatService({ db: h.db, ollama, memory, emit: (_t, e) => events.push(e) })
    const conv = await summarized()
    const sent = await chat.send({}, conv.id, 'Ricordami il budget in euro per persona del viaggio')
    await chat.wait(sent.streamId)
    expect(events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)[0]).toBe('remembering')
    const body = fake.requests.filter((q) => q.path === '/api/chat').at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    const system = body.messages[0].content
    expect(system.indexOf('# Riassunto della conversazione finora')).toBeLessThan(system.indexOf('# Dalla conversazione precedente'))
    expect(system).toContain('ottocento euro per persona')
    // i messaggi recenti (non riassunti) restano per intero e non diventano estratti
    expect(system).not.toContain('Gulbenkian')
    const answer = (await listMessages(h.db, conv.id)).at(-1)!
    expect(answer.memoryRefs?.[0]).toMatchObject({ position: 1, role: 'user' })
    expect(answer.memoryRefs?.[0].excerpt).toContain('ottocento')
  })

  it('fakeEmbedding: testi con parole in comune sono simili', () => {
    expect(cosine(fakeEmbedding('budget viaggio Portogallo'), fakeEmbedding('il budget del viaggio'))).toBeGreaterThan(0.5)
    expect(cosine(fakeEmbedding('budget viaggio'), fakeEmbedding('musei Lisbona'))).toBeLessThan(0.3)
  })

  it('memoria dopo il riassunto in sottofondo: i messaggi appena riassunti vengono indicizzati', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const memory = createMemory({ db: h.db, ollama })
    const conv = await summarized()
    expect(await listChunks(h.db, conv.id, 'embeddinggemma')).toHaveLength(0)
    await memory.indexQuietly((await getConversation(h.db, conv.id))!)
    expect((await listChunks(h.db, conv.id, 'embeddinggemma')).length).toBeGreaterThan(0)
  })
})
