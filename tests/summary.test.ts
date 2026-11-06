import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatService } from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addMessage, createConversation, getConversation, listMessages, updateConversation } from '../src/main/db/repo'
import { createOllamaClient } from '../src/main/ollama'
import { createSummarizer } from '../src/main/summary'
import type { Conversation, StreamEvent } from '../src/shared/types'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

let fake: FakeOllama
let h: DbHandle

beforeAll(async () => {
  fake = await startFakeOllama([
    // 2048 di contesto: riserva 1024, ~1000 token per lo storico
    { name: 'mini', capabilities: ['completion', 'thinking'], contextLength: 2048, parameters: 'num_ctx 2048', chunks: [{ content: 'Breve.' }] }
  ])
})
afterAll(() => fake.close())
beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
})
afterEach(() => h.close())

const firstContent = (r: { path: string; body: unknown }): string =>
  r.path === '/api/chat' ? ((r.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '') : ''
const summaryRequests = () => fake.requests.filter((r) => firstContent(r).startsWith("Sei l'archivista"))
const chatRequests = () =>
  fake.requests.filter((r) => r.path === '/api/chat' && !firstContent(r).startsWith("Sei l'archivista") && !firstContent(r).startsWith('Genera un titolo'))

/** Conversazione con messaggi lunghi già scambiati (400 caratteri = ~104 token l'uno). */
async function seeded(count: number): Promise<Conversation> {
  const conv = await createConversation(h.db, { model: 'mini', numCtx: 2048, role: 'Tutor' })
  for (let i = 0; i < count; i++) {
    await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `${i} ` + 'x'.repeat(398) })
  }
  return conv
}

describe('summarizer', () => {
  it('sotto la soglia non riassume; con force sì, lasciando l\'ultimo scambio per intero', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await seeded(4) // 4 × 104 = 416 su ~1000 → ~41%, sotto il 70%
    expect((await s.summarize(conv.id)).outcome).toBe('not-needed')
    expect(summaryRequests()).toHaveLength(0)

    const r = await s.summarize(conv.id, true)
    expect(r.outcome).toBe('updated')
    const msgs = await listMessages(h.db, conv.id)
    expect(r.conversation).toMatchObject({ summary: 'Breve.', summaryUpTo: msgs[1].id })
    expect(r.conversation?.summaryUpdatedAt).toBeGreaterThan(0)

    // richiesta: prompt dell'archivista, trascrizione dei messaggi coperti, niente ragionamento, stesso num_ctx
    const req = summaryRequests().at(-1)!.body as { messages: Array<{ role: string; content: string }>; think?: boolean; options: Record<string, unknown> }
    expect(req.messages[1].content).toMatch(/^Messaggi:\nUtente: 0 x+\n\nAssistente: 1 x+$/)
    expect(req.think).toBe(false)
    // riassunto proporzionato alla memoria: (2048 − 1024) ÷ 4 = 256 token
    expect(req.options).toMatchObject({ num_ctx: 2048, num_predict: 256, temperature: 0.2 })
  })

  it('sopra la soglia riassume in modo incrementale (riassunto precedente + nuovi messaggi)', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await seeded(8) // 832 token > 70% di ~1000
    expect((await s.summarize(conv.id)).outcome).toBe('updated')
    const msgs = await listMessages(h.db, conv.id)
    const first = (await getConversation(h.db, conv.id))!
    expect(first.summaryUpTo).toBe(msgs[5].id) // tiene gli ultimi 2 (sotto il 40% di ~1000)

    for (let i = 8; i < 14; i++) {
      await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `${i} ` + 'x'.repeat(398) })
    }
    expect((await s.summarize(conv.id)).outcome).toBe('updated')
    const req = summaryRequests().at(-1)!.body as { messages: Array<{ content: string }> }
    expect(req.messages[1].content.startsWith('Riassunto finora:\nBreve.\n\nNuovi messaggi:\n')).toBe(true)
    expect(req.messages[1].content).toMatch(/Nuovi messaggi:\nUtente: 6 /)
    expect((await getConversation(h.db, conv.id))!.summaryUpTo).toBe((await listMessages(h.db, conv.id))[11].id)
  })

  it('spento: non riassume (ma il comando manuale sì); riassunto disallineato → riparte da zero', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await seeded(8)
    await updateConversation(h.db, conv.id, { autoSummary: false })
    expect((await s.summarize(conv.id)).outcome).toBe('disabled')
    expect((await s.summarize(conv.id, true)).outcome).toBe('updated')

    await updateConversation(h.db, conv.id, { autoSummary: true, summaryUpTo: 'sparito' })
    expect((await s.summarize(conv.id)).outcome).toBe('updated')
    const req = summaryRequests().at(-1)!.body as { messages: Array<{ content: string }> }
    expect(req.messages[1].content.startsWith('Messaggi:\n')).toBe(true) // niente "Riassunto finora"
  })

  it('Ollama non risponde: failed, niente salvato', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => 'http://127.0.0.1:1') })
    const conv = await seeded(8)
    expect((await s.summarize(conv.id)).outcome).toBe('failed')
    expect((await getConversation(h.db, conv.id))!.summary).toBeNull()
  })
})

describe('chat con riassunto', () => {
  it('dopo la risposta il riassunto si aggiorna e la richiesta successiva lo usa al posto dei messaggi vecchi', async () => {
    const events: StreamEvent[] = []
    const updated: Conversation[] = []
    const ollama = createOllamaClient(() => fake.url)
    const chat = createChatService({
      db: h.db,
      ollama,
      summarizer: createSummarizer({ db: h.db, ollama }),
      emit: (_t, e) => events.push(e),
      onConversationUpdated: (_t, c) => updated.push(c)
    })
    const conv = await seeded(7) // 7 messaggi, l'ultimo è una risposta; la domanda nuova porta oltre la soglia
    await chat.wait((await chat.send({}, conv.id, 'domanda ' + 'y'.repeat(392))).streamId)

    // il riassunto avviene PRIMA della risposta (evento 'summarizing'), così la risposta ha la riserva intera
    expect(events.map((e) => e.type)).toEqual(['summarizing', 'content', 'done'])
    const after = (await getConversation(h.db, conv.id))!
    expect(after.summary).toBe('Breve.')
    expect(updated.some((c) => c.summary === 'Breve.')).toBe(true)
    // la richiesta della risposta porta già il riassunto e solo i messaggi non coperti
    const first = chatRequests().at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    expect(first.messages[0].content).toContain('# Riassunto della conversazione finora\nBreve.')
    expect(first.messages.filter((m) => m.role !== 'system')).toHaveLength(2) // m6 e la domanda
    const msgs = await listMessages(h.db, conv.id)
    // copre m0–m5: restano m6, la domanda nuova e la risposta (sotto il 40% dello spazio)
    expect(after.summaryUpTo).toBe(msgs[5].id)

    await chat.wait((await chat.send({}, conv.id, 'ancora')).streamId)
    const body = chatRequests().at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '# Ruolo\nTutor\n\n# Riassunto della conversazione finora\nBreve.' })
    // dopo il system: solo i messaggi non coperti (m6 è una domanda, quindi resta)
    expect(body.messages.slice(1).map((m) => m.content.slice(0, 7))).toEqual(['6 xxxxx', 'domanda', 'Breve.', 'ancora'])
  })

  it('con il riassunto spento la richiesta porta tutto lo storico (tagliato)', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const chat = createChatService({ db: h.db, ollama, summarizer: createSummarizer({ db: h.db, ollama }), emit: () => undefined })
    const conv = await seeded(7)
    await updateConversation(h.db, conv.id, { autoSummary: false })
    await chat.wait((await chat.send({}, conv.id, 'domanda')).streamId)
    expect((await getConversation(h.db, conv.id))!.summary).toBeNull()
    const body = chatRequests().at(-1)!.body as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0].content).toBe('# Ruolo\nTutor')
  })
})

describe('riassunto a blocchi con memoria piccola (caso reale)', () => {
  it('1024 token, risposte da ~6.000 caratteri: copre tutto, nessuna richiesta sfora num_ctx', async () => {
    const fake2 = await startFakeOllama([{ name: 'tiny', capabilities: ['completion'], contextLength: 32768, parameters: 'num_ctx 4096', chunks: [{ content: 'Sintesi.' }] }])
    try {
      const ollama = createOllamaClient(() => fake2.url)
      const s = createSummarizer({ db: h.db, ollama })
      const conv = await createConversation(h.db, { model: 'tiny', numCtx: 1024, style: 'extended' })
      await addMessage(h.db, { conversationId: conv.id, role: 'user', content: "Parlami dell'amore!" })
      await addMessage(h.db, { conversationId: conv.id, role: 'assistant', content: 'A'.repeat(6200), evalCount: 1809 })
      await addMessage(h.db, { conversationId: conv.id, role: 'user', content: "Parlami dell'amore romantico" })
      await addMessage(h.db, { conversationId: conv.id, role: 'assistant', content: 'B'.repeat(5900), evalCount: 1750 })
      const r = await s.summarize(conv.id, true)
      expect(r.outcome).toBe('updated')
      const msgs = await listMessages(h.db, conv.id)
      expect(r.conversation?.summaryUpTo).toBe(msgs[3].id) // tutti e 4

      const reqs = fake2.requests.filter((q) => q.path === '/api/chat').map((q) => q.body as { messages: Array<{ content: string }>; options: { num_ctx: number; num_predict: number } })
      expect(reqs.length).toBeGreaterThan(3) // più blocchi, uno dopo l'altro
      const sent = reqs.map((q) => q.messages[1].content).join('\n')
      // tutto il testo delle due risposte è stato letto, niente tagliato
      expect((sent.match(/A/g) ?? []).length).toBeGreaterThanOrEqual(6200)
      expect((sent.match(/B/g) ?? []).length).toBeGreaterThanOrEqual(5900)
      // ogni richiesta (prompt + testo + riassunto da scrivere) sta nei 1024 token (3,4 caratteri per token)
      for (const q of reqs) {
        const chars = q.messages.reduce((n, m) => n + m.content.length, 0)
        expect(Math.ceil(chars / 3.4) + q.options.num_predict).toBeLessThanOrEqual(1024)
        expect(q.options.num_predict).toBe(128)
      }
      // dal secondo blocco in poi il riassunto precedente viene aggiornato
      expect(reqs[1].messages[1].content.startsWith('Riassunto finora:\nSintesi.')).toBe(true)
    } finally {
      await fake2.close()
    }
  })
})

describe('caso v0.1.13: riassunto in corso quando arriva la domanda', () => {
  it('la domanda aspetta il riassunto in corso e parte con il riassunto aggiornato', async () => {
    // modello lento (~300 ms per richiesta): il riassunto in sottofondo è ancora in corso quando arriva la domanda
    const slow = await startFakeOllama([{ name: 'lento', capabilities: ['completion'], contextLength: 2048, parameters: 'num_ctx 2048', startDelayMs: 300, chunks: [{ content: 'Breve.' }] }])
    try {
      const ollama = createOllamaClient(() => slow.url)
      const events: StreamEvent[] = []
      const summarizer = createSummarizer({ db: h.db, ollama })
      const chat = createChatService({ db: h.db, ollama, summarizer, emit: (_t, e) => events.push(e) })
      const conv = await createConversation(h.db, { model: 'lento', numCtx: 2048, role: 'Tutor' })
      for (let i = 0; i < 8; i++) {
        await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `${i} ` + 'x'.repeat(398) })
      }
      // come dopo una risposta: riassunto in sottofondo, lento
      const background = summarizer.summarize(conv.id)
      await new Promise((r) => setTimeout(r, 50))
      expect(summarizer.isSummarizing(conv.id)).toBe(true)

      // la domanda arriva mentre il riassunto è in corso: deve aspettarlo (evento 'summarizing')
      const sent = await chat.send({}, conv.id, 'domanda')
      await chat.wait(sent.streamId)
      await background
      expect(events.filter((e) => e.streamId === sent.streamId).map((e) => e.type)[0]).toBe('summarizing')
      const req = slow.requests
        .filter((r) => r.path === '/api/chat' && !firstContent(r).startsWith("Sei l'archivista") && !firstContent(r).startsWith('Genera un titolo'))
        .at(-1)!.body as { messages: Array<{ content: string }> }
      // …e partire con il riassunto appena fatto, non con lo stato vecchio
      expect(req.messages[0].content).toContain('# Riassunto della conversazione finora\nBreve.')
      expect(req.messages.length).toBeLessThan(10)
    } finally {
      await slow.close()
    }
  })

  it('riassunto tagliato al limite: viene condensato e chiuso su una riga completa', async () => {
    const cut = await startFakeOllama([{ name: 'taglia', capabilities: ['completion'], contextLength: 2048, parameters: 'num_ctx 2048', doneReason: 'length', chunks: [{ content: '- punto uno\n- punto due\n- punto tr' }] }])
    try {
      const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => cut.url) })
      const conv = await createConversation(h.db, { model: 'taglia', numCtx: 2048 })
      for (let i = 0; i < 8; i++) await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) })
      const r = await s.summarize(conv.id, true)
      expect(r.outcome).toBe('updated')
      expect(r.conversation?.summary).toBe('- punto uno\n- punto due')
      const reqs = cut.requests.filter((q) => q.path === '/api/chat').map((q) => (q.body as { messages: Array<{ content: string }> }).messages[1].content)
      expect(reqs.some((c) => c.startsWith('Condensa questo riassunto'))).toBe(true)
    } finally {
      await cut.close()
    }
  })
})
