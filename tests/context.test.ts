import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatService } from '../src/main/chat'
import { callInput, createContextLog } from '../src/main/contextLog'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addContextCall, addMessage, CONTEXT_CALLS_KEPT, createConversation, listContextCalls, listMessages, updateConversation } from '../src/main/db/repo'
import { createMemory } from '../src/main/memory'
import { createOllamaClient } from '../src/main/ollama'
import { createSummarizer } from '../src/main/summary'
import { analyzeCall, chatParts } from '../src/shared/context'
import type { ContextCall } from '../src/shared/types'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

describe('monitor del contesto: funzioni pure', () => {
  it('chatParts: istruzioni senza lo stile, storico e domanda separati, voci vuote omesse', () => {
    const style = '# Stile della risposta\nConciso.'
    const parts = chatParts({
      base: `# Ruolo\nGuida turistica\n\n${style}`,
      style,
      summary: '',
      memory: '',
      memoryCount: 0,
      messages: [
        { role: 'user', content: 'a'.repeat(40) },
        { role: 'assistant', content: 'b'.repeat(80) },
        { role: 'user', content: 'c'.repeat(20) }
      ],
      cpt: 4
    })
    expect(parts.map((p) => p.key)).toEqual(['instructions', 'style', 'history', 'question'])
    expect(parts.find((p) => p.key === 'history')).toMatchObject({ tokens: 14 + 24, count: 2 })
    expect(parts.find((p) => p.key === 'question')?.tokens).toBe(9)
  })

  it('analyzeCall: scarto, occupato, troncamento e prompt letto molto meno', () => {
    const parts = [{ key: 'history' as const, label: 'Storico', tokens: 1000 }]
    expect(analyzeCall({ parts, numCtx: 4096, promptEvalCount: 1100, evalCount: 200 })).toMatchObject({
      sent: 1000,
      occupied: 1300,
      delta: 100,
      deltaShare: 0.1,
      truncated: false,
      readLess: false
    })
    // stima oltre num_ctx: troncato
    expect(analyzeCall({ parts, numCtx: 800, promptEvalCount: 800, evalCount: 0 }).truncated).toBe(true)
    // letto molto meno ma entrava: cache o stima sbagliata
    expect(analyzeCall({ parts, numCtx: 4096, promptEvalCount: 300, evalCount: 0 })).toMatchObject({ truncated: false, readLess: true })
    // niente conteggi da Ollama
    expect(analyzeCall({ parts, numCtx: 4096, promptEvalCount: null, evalCount: null })).toMatchObject({ occupied: null, delta: null })
  })
})

describe('monitor del contesto: registro', () => {
  let fake: FakeOllama
  let h: DbHandle
  beforeAll(async () => {
    fake = await startFakeOllama([
      { name: 'chat', capabilities: ['completion'], contextLength: 8192, parameters: 'num_ctx 2048', chunks: [{ content: 'Risposta breve.' }] },
      { name: 'embeddinggemma:latest', capabilities: ['embedding'] }
    ])
  })
  afterAll(() => fake.close())
  beforeEach(async () => {
    h = openDatabase(':memory:')
    await runMigrations(h, resolve(__dirname, '../drizzle'))
  })
  afterEach(() => h.close())

  it('tiene solo le ultime chiamate, dalla più recente', async () => {
    const conv = await createConversation(h.db, { model: 'chat' })
    const start = { conversationId: conv.id, kind: 'chat' as const, model: 'chat', numCtx: 2048, parts: [] }
    for (let i = 0; i < CONTEXT_CALLS_KEPT + 5; i++) await addContextCall(h.db, callInput({ ...start, note: String(i) }, null))
    const calls = await listContextCalls(h.db, conv.id)
    expect(calls).toHaveLength(CONTEXT_CALLS_KEPT)
    expect(calls[0].note).toBe(String(CONTEXT_CALLS_KEPT + 4))
  })

  it('chat con riassunto e memoria: risposta, ricerca e indicizzazione registrate con voci e conteggi di Ollama', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const notified: ContextCall[] = []
    const contextLog = createContextLog(h.db, (c) => notified.push(c))
    const memory = createMemory({ db: h.db, ollama, contextLog })
    const chat = createChatService({ db: h.db, ollama, memory, contextLog, emit: () => undefined })
    const conv = await createConversation(h.db, { model: 'chat', numCtx: 2048, style: 'concise' })
    for (const [role, content] of [
      ['user', 'Il budget massimo del viaggio è ottocento euro per persona, ricordalo'],
      ['assistant', 'Ricordato: ottocento euro per persona.'],
      ['user', 'Preferisco il treno ai voli interni'],
      ['assistant', 'Allora treno tra Lisbona e Porto.']
    ] as const)
      await addMessage(h.db, { conversationId: conv.id, role, content })
    const msgs = await listMessages(h.db, conv.id)
    await updateConversation(h.db, conv.id, { summary: 'Viaggio in Portogallo.', summaryUpTo: msgs[1].id, summaryUpdatedAt: Date.now() })

    const sent = await chat.send({}, conv.id, 'Quanti euro di budget per persona?')
    await chat.wait(sent.streamId)
    const calls = await listContextCalls(h.db, conv.id)
    expect(calls.map((c) => c.kind).sort()).toEqual(['chat', 'embed-index', 'embed-query'])
    expect(notified).toHaveLength(3)

    const answer = calls.find((c) => c.kind === 'chat')!
    expect(answer.parts.map((p) => p.key)).toEqual(['style', 'summary', 'memory', 'history', 'question'])
    expect(answer.parts.find((p) => p.key === 'history')?.count).toBe(2)
    expect(answer).toMatchObject({ model: 'chat', numCtx: 2048, droppedMessages: 0, doneReason: 'stop', aborted: false, error: null })
    expect(answer.promptEvalCount).toBeGreaterThan(0)
    expect(answer.evalCount).toBeGreaterThan(0)

    const query = calls.find((c) => c.kind === 'embed-query')!
    expect(query).toMatchObject({ numCtx: null, model: 'embeddinggemma', loadMs: 1, durationMs: 2 })
    expect(query.parts[0]).toMatchObject({ key: 'texts', count: 1 })
    expect(query.promptEvalCount).toBeGreaterThan(0)
  })

  it('riassunto ed errori di Ollama registrati', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const contextLog = createContextLog(h.db)
    const s = createSummarizer({ db: h.db, ollama, contextLog })
    const conv = await createConversation(h.db, { model: 'chat', numCtx: 2048 })
    for (let i = 0; i < 4; i++) await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: `Messaggio ${i} `.repeat(20) })
    expect((await s.summarize(conv.id, true)).outcome).toBe('updated')
    const [summary] = await listContextCalls(h.db, conv.id)
    expect(summary.kind).toBe('summary')
    expect(summary.parts.map((p) => p.key)).toEqual(['instructions', 'transcript'])
    expect(summary.parts[1].count).toBe(2)

    const missing = await createConversation(h.db, { model: 'manca' })
    const chat = createChatService({ db: h.db, ollama, contextLog, emit: () => undefined })
    const sent = await chat.send({}, missing.id, 'Ciao')
    await chat.wait(sent.streamId)
    const [failed] = await listContextCalls(h.db, missing.id)
    expect(failed.kind).toBe('chat')
    expect(failed.error).toBeTruthy()
    expect(failed.promptEvalCount).toBeNull()
  })
})
