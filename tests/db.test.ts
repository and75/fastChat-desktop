import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import {
  addMessage,
  conversationFromTemplate,
  convertBriefs,
  createConversation,
  ensureGeneralist,
  ensureRoles,
  getRole,
  getTemplate,
  listRoles,
  createTemplateFromConversation,
  getConversation,
  getSettings,
  listConversations,
  listMessages,
  listTemplates,
  removeConversation,
  removeTemplate,
  removeMessage,
  setSettings,
  updateConversation
} from '../src/main/db/repo'
import { conversations, messages } from '../src/main/db/schema'
import { DEFAULT_SETTINGS, GENERALIST_ROLE_ID, RESPONSE_STYLES, type Brief } from '../src/shared/types'
import { briefToSituation, buildStyleSection, buildSystemPrompt } from '../src/shared/prompt'
import { setLocale } from '../src/shared/i18n'
import { roleInstructions, validateRole } from '../src/shared/roles'
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
    expect(rows.map((r) => r.name)).toEqual([
      'brief_templates',
      'context_calls',
      'conversation_bases',
      'conversations',
      'knowledge_bases',
      'knowledge_chunks',
      'knowledge_connections',
      'knowledge_documents',
      'knowledge_fts',
      'knowledge_fts_config',
      'knowledge_fts_data',
      'knowledge_fts_docsize',
      'knowledge_fts_idx',
      'message_chunks',
      'messages',
      'model_settings',
      'plans',
      'roles',
      'settings'
    ])
  })

  it('basi di conoscenza: i documenti di una conversazione passano alla sua base, con pezzi, indice FTS e connessioni intatti', async () => {
    const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    // database fermo alla versione con i documenti legati alla conversazione (migrazioni 0000–0010)
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-mig-kb-'))
    cpSync(resolve(__dirname, '../drizzle'), dir, { recursive: true })
    const journalPath = join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.slice(0, 11)
    writeFileSync(journalPath, JSON.stringify(journal))
    const old = openDatabase(':memory:')
    try {
      await runMigrations(old, dir)
      old.raw.exec(`
        INSERT INTO conversations (id, title, model) VALUES ('c1', 'Con documenti', 'm'), ('c2', 'Senza', 'm');
        INSERT INTO knowledge_connections (id, conversation_id, source, config) VALUES ('k1', 'c1', 'folder', '{"path":"/x"}');
        INSERT INTO knowledge_documents (id, conversation_id, connection_id, source, title, ref, status, chunk_count, pinned)
          VALUES ('d1', 'c1', NULL, 'text', 'Uno', '{"kind":"file","path":"/a.txt"}', 'ready', 2, 1),
                 ('d2', 'c1', 'k1', 'folder', 'Due', '{"kind":"remote","sourceId":"folder","uri":"/x/b.txt"}', 'ready', 1, 0);
        INSERT INTO knowledge_chunks (id, document_id, part, text, model, embedding) VALUES
          ('p1', 'd1', 0, 'fattura rossi', 'e', x'00'), ('p2', 'd1', 1, 'seconda parte', 'e', x'00'), ('p3', 'd2', 0, 'contratto bianchi', 'e', x'00');
      `)
      await runMigrations(old, resolve(__dirname, '../drizzle'))
      const all = (q: string) => old.raw.prepare(q).all() as Array<Record<string, unknown>>
      expect(all('select id, origin, conversation_id from knowledge_bases')).toEqual([{ id: 'kb-c1', origin: 'conversation', conversation_id: 'c1' }])
      expect(all('select id, base_id, connection_id, pinned from knowledge_documents order by id')).toEqual([
        { id: 'd1', base_id: 'kb-c1', connection_id: null, pinned: 1 },
        { id: 'd2', base_id: 'kb-c1', connection_id: 'k1', pinned: 0 }
      ])
      expect(all('select id, base_id from knowledge_connections')).toEqual([{ id: 'k1', base_id: 'kb-c1' }])
      // i pezzi non sono stati cancellati dalla ricostruzione delle tabelle, e l'indice a parole li trova ancora
      expect(all('select count(*) n from knowledge_chunks')).toEqual([{ n: 3 }])
      expect(all("select count(*) n from knowledge_fts where knowledge_fts match 'rossi'")).toEqual([{ n: 1 }])
      expect(all("select name from pragma_table_info('knowledge_documents') where name = 'conversation_id'")).toEqual([])
      // le chiavi esterne sono di nuovo attive: eliminando la conversazione spariscono base, documenti e pezzi
      expect(all('pragma foreign_keys')).toEqual([{ foreign_keys: 1 }])
      old.raw.exec("DELETE FROM conversations WHERE id = 'c1'")
      expect(all('select count(*) n from knowledge_bases')).toEqual([{ n: 0 }])
      expect(all('select count(*) n from knowledge_documents')).toEqual([{ n: 0 }])
      expect(all('select count(*) n from knowledge_chunks')).toEqual([{ n: 0 }])
      expect(all("select count(*) n from knowledge_fts where knowledge_fts match 'rossi'")).toEqual([{ n: 0 }])
    } finally {
      old.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('la seconda migrazione aggiunge prompt_eval_count ai messaggi', () => {
    const cols = h.raw.prepare("select name from pragma_table_info('messages')").all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('prompt_eval_count')
  })

  it('aggiornano un database creato da una versione precedente, senza perdere dati', async () => {
    const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    // cartella di migrazioni "vecchia": solo la prima
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-mig-'))
    cpSync(resolve(__dirname, '../drizzle'), dir, { recursive: true })
    const journalPath = join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.slice(0, 1)
    writeFileSync(journalPath, JSON.stringify(journal))

    const old = openDatabase(':memory:')
    try {
      await runMigrations(old, dir)
      old.raw.exec("insert into conversations (id, model) values ('c1', 'm')")
      old.raw.exec("insert into messages (id, conversation_id, role, content) values ('m1', 'c1', 'user', 'ciao')")
      await runMigrations(old, resolve(__dirname, '../drizzle'))
      const row = old.raw.prepare("select content, prompt_eval_count from messages where id = 'm1'").get() as Record<string, unknown>
      expect(row).toEqual({ content: 'ciao', prompt_eval_count: null })
    } finally {
      old.close()
      rmSync(dir, { recursive: true, force: true })
    }
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
    up = await updateConversation(h.db, a.id, { numCtx: Number.NaN as number, think: 'si' as unknown as boolean, style: 'boh' as never })
    expect(up).toMatchObject({ numCtx: null, think: false, style: 'normal' })
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

describe('template del brief', () => {
  it('salva brief e impostazioni, li applica a una nuova conversazione', async () => {
    const src = await createConversation(h.db, {
      model: 'qwen3',
      role: 'Sei un tutor',
      constraints: 'Solo italiano',
      temperature: 0.2,
      think: true,
      planMode: true,
      seed: 5,
      style: 'concise'
    })
    const t = await createTemplateFromConversation(h.db, src.id, '  Tutor  ')
    expect(t).toMatchObject({ name: 'Tutor', model: 'qwen3', role: 'Sei un tutor', temperature: 0.2, think: true, planMode: true, style: 'concise' })

    const conv = await createConversation(h.db, conversationFromTemplate(t, 'llama3.2'))
    expect(conv).toMatchObject({
      title: 'Nuova conversazione',
      model: 'qwen3',
      style: 'concise',
      role: 'Sei un tutor',
      constraints: 'Solo italiano',
      temperature: 0.2,
      think: true,
      planMode: true,
      seed: null
    })
    // template senza modello: si usa il predefinito
    expect(conversationFromTemplate({ ...t, model: null }, 'llama3.2').model).toBe('llama3.2')
  })

  it('lista ordinata per nome, rimozione, nome obbligatorio', async () => {
    const c = await createConversation(h.db)
    await createTemplateFromConversation(h.db, c.id, 'beta')
    const a = await createTemplateFromConversation(h.db, c.id, 'Alfa')
    expect((await listTemplates(h.db)).map((t) => t.name)).toEqual(['Alfa', 'beta'])
    await removeTemplate(h.db, a.id)
    expect((await listTemplates(h.db)).map((t) => t.name)).toEqual(['beta'])
    await expect(createTemplateFromConversation(h.db, c.id, '  ')).rejects.toThrow('nome')
  })
})

describe('ruoli: dati e conversione dei Brief', () => {
  afterEach(() => setLocale('it'))

  /** Una riga com'era prima dei ruoli: `role_id` nullo, Brief nei quattro campi. */
  const legacy = (table: 'conversations' | 'brief_templates', id: string, brief: Partial<Brief>): void => {
    const extra = table === 'brief_templates' ? { name: id } : {}
    const row = { id, ...extra, ...brief }
    const cols = Object.keys(row)
    h.raw.prepare(`insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`).run(...Object.values(row))
  }
  const full: Brief = { role: 'Sei un tutor', context: 'Lezione di matematica', goals: 'Far capire le frazioni', constraints: 'Solo italiano' }

  it('il Generalista si crea se manca, una volta sola, ed è un ruolo valido senza istruzioni', async () => {
    expect(await listRoles(h.db)).toEqual([])
    const role = await ensureGeneralist(h.db)
    expect(role).toMatchObject({ id: GENERALIST_ROLE_ID, name: 'Generalista', origin: 'builtin', language: null, packageId: null, definition: {} })
    await ensureGeneralist(h.db)
    expect(await listRoles(h.db)).toHaveLength(1)
    expect(validateRole(role.definition)).toEqual([])
    expect(roleInstructions(role.definition)).toBe('')
    expect(await getRole(h.db, 'manca')).toBeNull()
  })

  it('Brief pieno, parziale e vuoto diventano situazione sul Generalista', async () => {
    legacy('conversations', 'pieno', full)
    legacy('conversations', 'parziale', { role: 'Sei un tutor', constraints: '  Solo italiano  ' })
    legacy('conversations', 'vuoto', {})
    expect(await convertBriefs(h.db)).toEqual({ conversations: 3, templates: 0 })

    expect(await getConversation(h.db, 'pieno')).toMatchObject({
      roleId: GENERALIST_ROLE_ID,
      roleParams: null,
      mindOverrides: null,
      situation: '# Ruolo\nSei un tutor\n\n# Contesto\nLezione di matematica\n\n# Obiettivi\nFar capire le frazioni\n\n# Vincoli\nSolo italiano',
      // I vecchi campi restano nel database, intatti.
      ...full
    })
    expect((await getConversation(h.db, 'parziale'))!.situation).toBe('# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano')
    expect(await getConversation(h.db, 'vuoto')).toMatchObject({ roleId: GENERALIST_ROLE_ID, situation: '' })
  })

  it('i template si convertono allo stesso modo', async () => {
    legacy('brief_templates', 'Tutor', full)
    expect(await convertBriefs(h.db)).toEqual({ conversations: 0, templates: 1 })
    const template = (await getTemplate(h.db, 'Tutor'))!
    expect(template).toMatchObject({ roleId: GENERALIST_ROLE_ID, situation: briefToSituation(full), ...full })
    expect(await createConversation(h.db, conversationFromTemplate(template, 'llama3.2'))).toMatchObject({ roleId: GENERALIST_ROLE_ID, situation: briefToSituation(full) })
  })

  it('una volta sola: ciò che è già convertito non si tocca più', async () => {
    legacy('conversations', 'c1', full)
    await convertBriefs(h.db)
    await updateConversation(h.db, 'c1', { situation: 'Riscritta a mano', role: 'Altro' })
    expect(await convertBriefs(h.db)).toEqual({ conversations: 0, templates: 0 })
    expect((await getConversation(h.db, 'c1'))!.situation).toBe('Riscritta a mano')
  })

  it('i titoli sono nella lingua dell\'interfaccia al momento della conversione', async () => {
    setLocale('fr')
    legacy('conversations', 'c1', { role: 'Tu es un tuteur' })
    await convertBriefs(h.db)
    setLocale('it')
    expect((await getConversation(h.db, 'c1'))!.situation).toBe('# Rôle\nTu es un tuteur')
  })

  it('il system prompt di una conversazione convertita è identico a quello di prima', async () => {
    const briefs: Array<Partial<Brief>> = [full, { role: 'Sei un tutor' }, { context: 'Solo contesto\n\ncon due paragrafi' }, { goals: ' ', constraints: 'Breve' }, {}]
    for (const [i, brief] of briefs.entries()) legacy('conversations', `c${i}`, brief)
    await ensureRoles(h.db)
    const generalist = (await getRole(h.db, GENERALIST_ROLE_ID))!
    for (const [i] of briefs.entries()) {
      const conv = (await getConversation(h.db, `c${i}`))!
      for (const style of RESPONSE_STYLES) {
        // Ciò che il passo 2.3 metterà nel sistema: istruzioni del ruolo, situazione, stile.
        const after = [roleInstructions(generalist.definition, conv.roleParams), conv.situation ?? '', buildStyleSection(style)].filter((p) => p.trim()).join('\n\n')
        expect(after).toBe(buildSystemPrompt(conv, style))
      }
    }
  })

  it('le conversazioni nuove nascono sul Generalista; il patch accetta solo valori sensati', async () => {
    const plain = await createConversation(h.db)
    expect(plain).toMatchObject({ roleId: GENERALIST_ROLE_ID, situation: '', roleParams: null, mindOverrides: null })
    const withRole = await createConversation(h.db, { roleId: 'app.fastchat.ruolo.prompt.it', roleParams: { stile: 'asciutto', tecniche: ['ruolo', 3 as unknown as string], rotto: 1 as unknown as string }, situation: 'Lavoro su un prompt' })
    expect(withRole).toMatchObject({ roleId: 'app.fastchat.ruolo.prompt.it', roleParams: { stile: 'asciutto', tecniche: ['ruolo'] }, situation: 'Lavoro su un prompt' })
    const patched = await updateConversation(h.db, plain.id, { roleId: ' ', roleParams: [] as never, mindOverrides: { temperature: 0.5 }, situation: null })
    expect(patched).toMatchObject({ roleId: GENERALIST_ROLE_ID, roleParams: null, mindOverrides: { temperature: 0.5 }, situation: '' })
  })

  it('un template salva ruolo, scelte, ritocchi e situazione', async () => {
    const src = await createConversation(h.db, { roleId: 'r1', roleParams: { stile: 'asciutto' }, mindOverrides: { temperature: 0.5 }, situation: 'Contesto mio' })
    const t = await createTemplateFromConversation(h.db, src.id, 'Mio')
    expect(await getTemplate(h.db, t.id)).toMatchObject({ roleId: 'r1', roleParams: { stile: 'asciutto' }, mindOverrides: { temperature: 0.5 }, situation: 'Contesto mio' })
    expect(conversationFromTemplate(t, 'm')).toMatchObject({ roleId: 'r1', roleParams: { stile: 'asciutto' }, mindOverrides: { temperature: 0.5 }, situation: 'Contesto mio' })
  })

  it('un database della versione 0.1.22 si apre, converte e non perde nulla', async () => {
    const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fastchat-mig-'))
    cpSync(resolve(__dirname, '../drizzle'), dir, { recursive: true })
    const journalPath = join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    // Fino alla 0015: lo schema rilasciato nella 0.1.22.
    journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0016')
    writeFileSync(journalPath, JSON.stringify(journal))

    const old = openDatabase(':memory:')
    try {
      await runMigrations(old, dir)
      old.raw.exec("insert into conversations (id, model, role, goals, style) values ('c1', 'm', 'Sei un tutor', 'Spiegare', 'concise')")
      old.raw.exec("insert into messages (id, conversation_id, role, content) values ('m1', 'c1', 'user', 'ciao')")
      old.raw.exec("insert into brief_templates (id, name, constraints) values ('t1', 'Breve', 'Solo italiano')")
      await runMigrations(old, resolve(__dirname, '../drizzle'))
      await ensureRoles(old.db)
      const conv = (await getConversation(old.db, 'c1'))!
      expect(conv).toMatchObject({ model: 'm', role: 'Sei un tutor', goals: 'Spiegare', style: 'concise', roleId: GENERALIST_ROLE_ID, situation: '# Ruolo\nSei un tutor\n\n# Obiettivi\nSpiegare' })
      expect((await listMessages(old.db, 'c1')).map((m) => m.content)).toEqual(['ciao'])
      expect(await getTemplate(old.db, 't1')).toMatchObject({ constraints: 'Solo italiano', roleId: GENERALIST_ROLE_ID, situation: '# Vincoli\nSolo italiano' })
      expect((await listRoles(old.db)).map((r) => r.id)).toEqual([GENERALIST_ROLE_ID])
    } finally {
      old.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
