import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { getSettings, setSettings } from '../src/main/db/repo'
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
