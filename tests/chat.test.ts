import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildChatMessages, buildOptions, createChatService } from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, listMessages, updateConversation } from '../src/main/db/repo'
import { createOllamaClient } from '../src/main/ollama'
import type { Conversation, StreamEvent } from '../src/shared/types'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

let fake: FakeOllama
let h: DbHandle
let events: StreamEvent[]
const target = {}

beforeAll(async () => {
  fake = await startFakeOllama([
    { name: 'qwen3', capabilities: ['completion', 'thinking'] },
    { name: 'llama3.2', capabilities: ['completion'] },
    { name: 'slow', capabilities: ['completion'], delayMs: 20, chunks: Array.from({ length: 40 }, (_, i) => ({ content: `${i} ` })) }
  ])
})
afterAll(() => fake.close())

beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
  events = []
})
afterEach(() => h.close())

const service = () =>
  createChatService({ db: h.db, ollama: createOllamaClient(() => fake.url), emit: (_t, e) => events.push(e) })

const lastChatBody = () =>
  fake.requests.filter((r) => r.path === '/api/chat').at(-1)?.body as {
    messages: Array<{ role: string; content: string }>
    think?: boolean
    options: Record<string, unknown>
  }

describe('buildOptions / buildChatMessages', () => {
  const conv = {
    temperature: 0.3,
    topP: null,
    numCtx: 4096,
    seed: 7,
    role: 'Sei un tutor',
    context: '',
    goals: '',
    constraints: 'Solo italiano'
  } as Conversation

  it('opzioni: solo i valori impostati', () => {
    expect(buildOptions(conv)).toEqual({ temperature: 0.3, num_ctx: 4096, seed: 7 })
  })

  it('brief come primo messaggio system, poi lo storico', () => {
    const msgs = buildChatMessages(conv, [
      { role: 'user', content: 'ciao' } as never,
      { role: 'assistant', content: 'salve' } as never
    ])
    expect(msgs).toEqual([
      { role: 'system', content: '# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano' },
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'salve' }
    ])
  })

  it('senza brief non c\'è messaggio system', () => {
    const msgs = buildChatMessages({ ...conv, role: '', constraints: '' }, [{ role: 'user', content: 'x' } as never])
    expect(msgs).toEqual([{ role: 'user', content: 'x' }])
  })
})

describe('chat service', () => {
  it('send: salva utente, invia brief + storico, emette lo stream e salva la risposta', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', constraints: 'Rispondi in rima', temperature: 1.1 })
    const chat = service()
    const { streamId, userMessage } = await chat.send(target, conv.id, '  ciao  ')
    expect(userMessage?.content).toBe('ciao')
    await chat.wait(streamId)

    const body = lastChatBody()
    expect(body.messages).toEqual([
      { role: 'system', content: '# Vincoli\nRispondi in rima' },
      { role: 'user', content: 'ciao' }
    ])
    expect(body.options).toEqual({ temperature: 1.1 })
    // llama3.2 non supporta il ragionamento: il parametro think non va inviato
    expect(body).not.toHaveProperty('think')

    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'done'])
    expect(events.every((e) => e.streamId === streamId && e.conversationId === conv.id)).toBe(true)
    const done = events.at(-1)!
    expect(done.message).toMatchObject({ role: 'assistant', content: 'Ciao mondo!', evalCount: 42, durationMs: 1500, model: 'llama3.2' })

    const saved = await listMessages(h.db, conv.id)
    expect(saved.map((m) => [m.role, m.content])).toEqual([
      ['user', 'ciao'],
      ['assistant', 'Ciao mondo!']
    ])
  })

  it('il secondo turno include lo storico precedente', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.send(target, conv.id, 'uno')).streamId)
    await chat.wait((await chat.send(target, conv.id, 'due')).streamId)
    expect(lastChatBody().messages.map((m) => m.content)).toEqual(['uno', 'Ciao mondo!', 'due'])
  })

  it('modello con ragionamento: think segue la conversazione e il thinking viene salvato', async () => {
    const conv = await createConversation(h.db, { model: 'qwen3', think: true })
    const chat = service()
    await chat.wait((await chat.send(target, conv.id, 'pensa')).streamId)
    expect(lastChatBody().think).toBe(true)
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.delta)).toEqual(['Ci penso. '])
    expect(events.at(-1)?.message?.thinking).toBe('Ci penso. ')

    await updateConversation(h.db, conv.id, { think: false })
    await chat.wait((await chat.send(target, conv.id, 'non pensare')).streamId)
    expect(lastChatBody().think).toBe(false)
  })

  it('abort: salva il parziale e segnala aborted', async () => {
    const conv = await createConversation(h.db, { model: 'slow' })
    const chat = service()
    const { streamId } = await chat.send(target, conv.id, 'lungo')
    await new Promise((r) => setTimeout(r, 90))
    expect(chat.abort(streamId)).toBe(true)
    await chat.wait(streamId)
    const done = events.at(-1)!
    expect(done).toMatchObject({ type: 'done', aborted: true })
    expect(done.message?.content.startsWith('0 1 ')).toBe(true)
    expect(chat.abort(streamId)).toBe(false)
  })

  it('una sola risposta alla volta per conversazione', async () => {
    const conv = await createConversation(h.db, { model: 'slow' })
    const chat = service()
    const { streamId } = await chat.send(target, conv.id, 'a')
    await expect(chat.send(target, conv.id, 'b')).rejects.toThrow('già in corso')
    chat.abort(streamId)
    await chat.wait(streamId)
  })

  it('errori: modello mancante, messaggio vuoto, modello sconosciuto a Ollama', async () => {
    const chat = service()
    const noModel = await createConversation(h.db, {})
    await expect(chat.send(target, noModel.id, 'x')).rejects.toThrow('Seleziona un modello')
    const conv = await createConversation(h.db, { model: 'inesistente' })
    await expect(chat.send(target, conv.id, '   ')).rejects.toThrow('vuoto')

    const { streamId } = await chat.send(target, conv.id, 'x')
    await chat.wait(streamId)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(events.at(-1)?.error).toContain('not found')
    // il messaggio utente resta, così si può rigenerare
    expect((await listMessages(h.db, conv.id)).map((m) => m.role)).toEqual(['user'])
  })

  it('regenerate: sostituisce l\'ultima risposta', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.send(target, conv.id, 'ciao')).streamId)
    const before = await listMessages(h.db, conv.id)

    const { streamId, userMessage } = await chat.regenerate(target, conv.id)
    expect(userMessage).toBeUndefined()
    await chat.wait(streamId)
    expect(lastChatBody().messages.map((m) => m.content)).toEqual(['ciao'])

    const after = await listMessages(h.db, conv.id)
    expect(after).toHaveLength(2)
    expect(after[1].id).not.toBe(before[1].id)
  })

  it('regenerate senza messaggi → errore', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    await expect(service().regenerate(target, conv.id)).rejects.toThrow('Niente da rigenerare')
  })
})
