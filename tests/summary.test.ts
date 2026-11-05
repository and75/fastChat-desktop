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
    // 1024 di contesto: con num_predict 256 restano 768 token per lo storico
    { name: 'mini', capabilities: ['completion', 'thinking'], contextLength: 1024, parameters: 'num_ctx 1024', chunks: [{ content: 'Breve.' }] }
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
  const conv = await createConversation(h.db, { model: 'mini', numCtx: 1024, numPredict: 256, role: 'Tutor' })
  for (let i = 0; i < count; i++) {
    await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `${i} ` + 'x'.repeat(398) })
  }
  return conv
}

describe('summarizer', () => {
  it('sotto la soglia non riassume; con force sì, lasciando l\'ultimo scambio per intero', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await seeded(4) // 4 × 104 = 416 su 768 - brief → ~55%, sotto il 70%
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
    expect(req.options).toMatchObject({ num_ctx: 1024, num_predict: 600, temperature: 0.2 })
  })

  it('sopra la soglia riassume in modo incrementale (riassunto precedente + nuovi messaggi)', async () => {
    const s = createSummarizer({ db: h.db, ollama: createOllamaClient(() => fake.url) })
    const conv = await seeded(8) // 832 token > 768
    expect((await s.summarize(conv.id)).outcome).toBe('updated')
    const msgs = await listMessages(h.db, conv.id)
    const first = (await getConversation(h.db, conv.id))!
    expect(first.summaryUpTo).toBe(msgs[5].id) // tiene gli ultimi 2 (sotto il 40% di ~750)

    for (let i = 8; i < 14; i++) {
      await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `${i} ` + 'x'.repeat(398) })
    }
    expect((await s.summarize(conv.id)).outcome).toBe('updated')
    const req = summaryRequests().at(-1)!.body as { messages: Array<{ content: string }> }
    expect(req.messages[1].content.startsWith('Riassunto finora:\nBreve.\n\nNuovi messaggi:\n')).toBe(true)
    // con 1k di contesto la trascrizione sta in ~2.000 caratteri: i 4 messaggi coperti più recenti (8–11)
    expect(req.messages[1].content).toMatch(/Nuovi messaggi:\nUtente: 8 /)
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

    const after = (await getConversation(h.db, conv.id))!
    expect(after.summary).toBe('Breve.')
    expect(updated.some((c) => c.summary === 'Breve.')).toBe(true)
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
