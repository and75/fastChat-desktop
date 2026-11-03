import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import {
  addMessage,
  createConversation,
  getConversation,
  getSettings,
  listConversations,
  listMessages,
  removeConversation,
  removeMessage,
  setSettings,
  updateConversation
} from '../src/main/db/repo'
import { conversations, messages } from '../src/main/db/schema'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { eq } from 'drizzle-orm'

let h: DbHandle

beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
})

afterEach(() => h.close())

describe('migrazioni', () => {
  it('creano tutte le tabelle', () => {
    const rows = h.raw
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name")
      .all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual(['brief_templates', 'conversations', 'messages', 'plans', 'settings'])
  })

  it('sono idempotenti', async () => {
    await expect(runMigrations(h, resolve(__dirname, '../drizzle'))).resolves.toBeUndefined()
  })
})

describe('settings', () => {
  it('restituisce i default se vuoto', async () => {
    expect(await getSettings(h.db)).toEqual(DEFAULT_SETTINGS)
  })

  it('salva e aggiorna (upsert), ignorando chiavi sconosciute', async () => {
    await setSettings(h.db, { ollamaUrl: 'http://localhost:9999', defaultModel: 'qwen3' })
    const after = await setSettings(h.db, { defaultModel: 'llama3.2', ...({ bogus: 1 } as object) })
    expect(after).toEqual({ ...DEFAULT_SETTINGS, ollamaUrl: 'http://localhost:9999', defaultModel: 'llama3.2' })
    const keys = h.raw.prepare('select key from settings order by key').all() as Array<{ key: string }>
    expect(keys.map((k) => k.key)).toEqual(['defaultModel', 'ollamaUrl'])
  })
})

describe('conversazioni e messaggi', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('crea con i default e un id univoco', async () => {
    const a = await createConversation(h.db, { model: 'qwen3' })
    const b = await createConversation(h.db)
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ model: 'qwen3', title: 'Nuova conversazione', temperature: 0.7, think: false, archived: false })
    expect(b.model).toBe('')
  })

  it('lista ordinata per updated_at, e un nuovo messaggio porta la conversazione in cima', async () => {
    const a = await createConversation(h.db, { title: 'A' })
    await sleep(3)
    const b = await createConversation(h.db, { title: 'B' })
    expect((await listConversations(h.db)).map((c) => c.title)).toEqual(['B', 'A'])
    await sleep(3)
    await addMessage(h.db, { conversationId: a.id, role: 'user', content: 'ciao' })
    expect((await listConversations(h.db)).map((c) => c.title)).toEqual(['A', 'B'])
    expect(b).toBeTruthy()
  })

  it('ricerca su titolo e contenuto dei messaggi, con caratteri speciali', async () => {
    const a = await createConversation(h.db, { title: 'Ricette' })
    const b = await createConversation(h.db, { title: 'Lavoro' })
    await addMessage(h.db, { conversationId: b.id, role: 'user', content: 'sconto del 50% sul piano' })
    expect((await listConversations(h.db, { search: 'ricet' })).map((c) => c.id)).toEqual([a.id])
    expect((await listConversations(h.db, { search: 'piano' })).map((c) => c.id)).toEqual([b.id])
    expect((await listConversations(h.db, { search: '50%' })).map((c) => c.id)).toEqual([b.id])
    expect(await listConversations(h.db, { search: '%' })).toHaveLength(1)
    expect(await listConversations(h.db, { search: '_' })).toHaveLength(0)
  })

  it('archiviate separate dalle attive', async () => {
    const a = await createConversation(h.db, { title: 'A' })
    await updateConversation(h.db, a.id, { archived: true })
    expect(await listConversations(h.db)).toHaveLength(0)
    expect((await listConversations(h.db, { archived: true })).map((c) => c.id)).toEqual([a.id])
  })

  it('update: solo campi ammessi, temperatura limitata, titolo ripulito', async () => {
    const a = await createConversation(h.db)
    const up = await updateConversation(h.db, a.id, {
      role: 'Sei un tutor',
      temperature: 5,
      title: '   ',
      ...({ id: 'hack', createdAt: 0 } as object)
    })
    expect(up).toMatchObject({ id: a.id, role: 'Sei un tutor', temperature: 2, title: 'Nuova conversazione' })
    expect(up.createdAt).toBe(a.createdAt)
    await expect(updateConversation(h.db, 'nope', { title: 'x' })).rejects.toThrow('non trovata')
  })

  it('parametri del modello: limiti, interi, null = default di Ollama', async () => {
    const a = await createConversation(h.db)
    let up = await updateConversation(h.db, a.id, { topP: 1.5, numCtx: 4096.6, seed: 42, temperature: -1 })
    expect(up).toMatchObject({ topP: 1, numCtx: 4097, seed: 42, temperature: 0 })
    up = await updateConversation(h.db, a.id, { topP: null, numCtx: 10, seed: null })
    expect(up).toMatchObject({ topP: null, numCtx: 256, seed: null })
    up = await updateConversation(h.db, a.id, { numCtx: Number.NaN as number, think: 'si' as unknown as boolean })
    expect(up).toMatchObject({ numCtx: null, think: false })
    up = await updateConversation(h.db, a.id, { think: true })
    expect(up.think).toBe(true)
  })

  it('messaggi in ordine di inserimento e rimozione', async () => {
    const a = await createConversation(h.db)
    const m1 = await addMessage(h.db, { conversationId: a.id, role: 'user', content: '1' })
    await addMessage(h.db, { conversationId: a.id, role: 'assistant', content: '2', thinking: '', evalCount: 3 })
    await addMessage(h.db, { conversationId: a.id, role: 'user', content: '3' })
    const all = await listMessages(h.db, a.id)
    expect(all.map((m) => m.content)).toEqual(['1', '2', '3'])
    expect(all[1]).toMatchObject({ thinking: null, evalCount: 3 })
    await removeMessage(h.db, m1.id)
    expect((await listMessages(h.db, a.id)).map((m) => m.content)).toEqual(['2', '3'])
    await removeConversation(h.db, a.id)
    expect(await getConversation(h.db, a.id)).toBeNull()
  })
})

describe('schema via Drizzle su node:sqlite', () => {
  it('default, booleani e cascade sui messaggi', async () => {
    await h.db.insert(conversations).values({ id: 'c1', model: 'qwen3' })
    const [conv] = await h.db.select().from(conversations).where(eq(conversations.id, 'c1'))
    expect(conv).toMatchObject({ title: 'Nuova conversazione', temperature: 0.7, think: false, planMode: false, archived: false })
    expect(conv.createdAt).toBeGreaterThan(1_700_000_000_000)

    await h.db.update(conversations).set({ think: true }).where(eq(conversations.id, 'c1'))
    const one = await h.db.query.conversations.findFirst({ where: eq(conversations.id, 'c1') })
    expect(one?.think).toBe(true)

    await h.db.insert(messages).values({ id: 'm1', conversationId: 'c1', role: 'user', content: 'ciao' })
    await h.db.delete(conversations).where(eq(conversations.id, 'c1'))
    expect(await h.db.select().from(messages)).toEqual([])
  })
})
