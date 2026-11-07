import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatService } from '../src/main/chat'
import { callInput, createContextLog } from '../src/main/contextLog'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addContextCall, addMessage, CONTEXT_CALLS_KEPT, createConversation, listContextCalls, listMessages, updateConversation } from '../src/main/db/repo'
import { createMemory } from '../src/main/memory'
import { createOllamaClient } from '../src/main/ollama'
import { createSummarizer } from '../src/main/summary'
import { analyzeCall, chatParts, reconcile } from '../src/shared/context'
import { computeContextUsage, estimateTokens, splitTokens } from '../src/shared/prompt'
import type { ContextCall } from '../src/shared/types'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

describe('monitor del contesto: funzioni pure', () => {
  it('chatParts: il system prompt diviso tra le sue sezioni (somma esatta), storico e domanda separati, voci vuote omesse', () => {
    const instructions = '# Ruolo\nGuida turistica'
    const style = '# Stile della risposta\nConciso.'
    const summary = '# Riassunto della conversazione finora\nViaggio.'
    const system = `${instructions}\n\n${style}\n\n${summary}`
    const parts = chatParts({
      system,
      instructions,
      style,
      summary,
      memory: '',
      summaryCount: 4,
      memoryCount: 0,
      messages: [
        { role: 'user', content: 'a'.repeat(40) },
        { role: 'assistant', content: 'b'.repeat(80) },
        { role: 'user', content: 'c'.repeat(20) }
      ],
      cpt: 4
    })
    expect(parts.map((p) => p.key)).toEqual(['instructions', 'style', 'summary', 'history', 'question'])
    expect(parts.slice(0, 3).reduce((n, p) => n + p.tokens, 0)).toBe(estimateTokens(system, 4))
    expect(parts.find((p) => p.key === 'summary')?.count).toBe(4)
    expect(parts.find((p) => p.key === 'history')).toMatchObject({ tokens: 14 + 24, count: 2 })
    expect(parts.find((p) => p.key === 'question')?.tokens).toBe(9)
  })

  it('splitTokens: proporzionale ai caratteri, somma esatta', () => {
    expect(splitTokens(10, ['aaa', '', 'aaaaaaa'])).toEqual([3, 0, 7])
    expect(splitTokens(7, ['a', 'a', 'a']).reduce((x, y) => x + y)).toBe(7)
    expect(splitTokens(5, ['', ''])).toEqual([0, 0])
  })

  it('stato del contesto: le voci più lo scarto danno il totale del contatore, con stima e con conteggi di Ollama', () => {
    const u = (id: string, content: string, createdAt = 1) => ({ id, role: 'user' as const, content, createdAt })
    const r = (id: string, content: string, promptEvalCount: number | null, evalCount: number | null, createdAt = 2) => ({ id, role: 'assistant' as const, content, promptEvalCount, evalCount, createdAt })
    const brief = { role: 'Guida', context: '', goals: '', constraints: '' }
    // stima: nessun conteggio
    const est = computeContextUsage({ brief, style: 'concise', messages: [u('1', 'x'.repeat(100))], numCtx: 1024 })
    expect(est.source).toBe('no-count')
    expect(est.adjustment).toBe(0)
    expect(est.parts.reduce((n, p) => n + p.tokens, 0)).toBe(est.used)
    expect(est.parts.map((p) => p.key)).toEqual(['instructions', 'style', 'history'])
    // conteggi di Ollama: lo scarto chiude il conto
    const real = computeContextUsage({ brief, style: 'concise', messages: [u('1', 'x'.repeat(100)), r('2', 'y'.repeat(100), 90, 30)], numCtx: 1024 })
    expect(real.source).toBe('ollama')
    expect(real.used).toBe(120)
    expect(real.parts.reduce((n, p) => n + p.tokens, 0) + real.adjustment).toBe(120)
    // riassunto più recente dell'ultima risposta: torna la stima, e si dice perché
    const after = computeContextUsage({
      brief,
      messages: [u('1', 'x'.repeat(100)), r('2', 'y'.repeat(100), 90, 30), u('3', 'z'.repeat(50), 3), r('4', 'w'.repeat(50), 120, 20, 4)],
      numCtx: 1024,
      summary: 'Riassunto.',
      summaryUpTo: '2',
      summaryUpdatedAt: 5
    })
    expect(after).toMatchObject({ source: 'summary-changed', adjustment: 0 })
    expect(after.parts.find((p) => p.key === 'summary')?.count).toBe(2)
    expect(after.parts.find((p) => p.key === 'history')?.count).toBe(2)
  })

  it('reconcile: la somma delle differenze è la differenza dei totali', () => {
    const call = {
      numCtx: 1024,
      promptEvalCount: 712,
      evalCount: 42,
      parts: [
        { key: 'style' as const, label: 'Stile della risposta', tokens: 90 },
        { key: 'summary' as const, label: 'Riassunto', tokens: 115, count: 6 },
        { key: 'memory' as const, label: 'Estratti della memoria', tokens: 183, count: 1 },
        { key: 'history' as const, label: 'Storico', tokens: 280, count: 6 },
        { key: 'question' as const, label: 'Domanda', tokens: 15 }
      ]
    }
    const now = {
      used: 279,
      adjustment: 0,
      parts: [
        { key: 'style' as const, label: 'Stile della risposta', tokens: 90 },
        { key: 'summary' as const, label: 'Riassunto', tokens: 129, count: 12 },
        { key: 'history' as const, label: 'Storico', tokens: 60, count: 2 }
      ]
    }
    const r = reconcile(call, now)
    expect(r.thenTotal).toBe(754)
    expect(r.nowTotal).toBe(279)
    expect(r.rows.reduce((n, x) => n + x.delta, 0)).toBe(279 - 754)
    expect(r.rows.map((x) => x.key)).toEqual(['style', 'summary', 'memory', 'history', 'question', 'answer', 'ollama'])
    expect(r.rows.find((x) => x.key === 'memory')).toMatchObject({ then: 183, now: null, delta: -183 })
    expect(r.rows.find((x) => x.key === 'ollama')).toMatchObject({ then: 29, now: null, delta: -29 })
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
