// Il ruolo nella vita di una conversazione (passo 2.5): la mente impostata dal ruolo, la scelta delle opzioni,
// i ritocchi manuali, il cambio di ruolo, il riassunto portato in una nuova conversazione.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addMessage, createBase, createTemplateFromConversation, ensureRoles, getConversation, listLinkedBases, listLinkPurposes, saveRole, updateBase, updateConversation } from '../src/main/db/repo'
import { createRoleSession } from '../src/main/roleSession'
import { parseRole, type Role } from '../src/shared/roles'
import { GENERALIST_ROLE_ID, type Conversation } from '../src/shared/types'

let h: DbHandle
beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
  await ensureRoles(h.db)
})
afterEach(() => h.close())

const load = (name: string): Role => parseRole(JSON.parse(readFileSync(resolve(__dirname, 'fixtures/roles', name), 'utf8')))
const PROMPT = 'ruolo.prompt'
const ASSISTENTE = 'ruolo.assistente'
const install = (id: string, definition: Role, language = 'it') => saveRole(h.db, { id, packageId: id, group: null, language, name: id, description: '', version: '1', definition, origin: 'package' })

/** Valori suggeriti per modello, come li darebbe la calibrazione. */
const SUGGESTED: Record<string, { temperature: number; topP: number; numCtx: number }> = {
  'llama3.2:3b': { temperature: 0.8, topP: 0.9, numCtx: 4096 },
  'gemma4:e4b': { temperature: 1, topP: 0.95, numCtx: 8192 },
  'gemma4:12b': { temperature: 1, topP: 0.95, numCtx: 16384 }
}
const linked: string[] = []
const session = (opts: { installed?: string[]; summarize?: (id: string) => Promise<unknown> } = {}) =>
  createRoleSession({
    db: h.db,
    knowledge: {
      linkDefaults: async () => undefined,
      linkRole: async (conv: Conversation) => {
        linked.push(conv.roleId ?? '')
        return []
      }
    },
    initialModel: async () => 'llama3.2:3b',
    suggest: async (model) => SUGGESTED[model] ?? {},
    modelInstalled: async (name) => (opts.installed ?? ['llama3.2:3b', 'gemma4:e4b']).includes(name),
    summarize: opts.summarize
  })

describe('nuova conversazione', () => {
  it('senza scelta è il Generalista: valori suggeriti per il modello, nient\'altro', async () => {
    const conv = await session().create()
    expect(conv).toMatchObject({ roleId: GENERALIST_ROLE_ID, model: 'llama3.2:3b', temperature: 0.8, topP: 0.9, numCtx: 4096, think: false, style: 'normal', knowledge: true, roleParams: null, mindOverrides: null })
    expect(await session().create({ roleId: GENERALIST_ROLE_ID })).toMatchObject({ roleId: GENERALIST_ROLE_ID, temperature: 0.8 })
  })

  it('con un ruolo: modello consigliato se installato, mente del ruolo con i predefiniti delle opzioni', async () => {
    await install(ASSISTENTE, load('assistente.it.json'))
    const conv = await session().create({ roleId: ASSISTENTE })
    // base del ruolo: temperatura 0,2, ragionamento spento, documenti accesi; «Passo-passo» (predefinita) porta lo stile a Normale
    expect(conv).toMatchObject({ roleId: ASSISTENTE, model: 'gemma4:e4b', temperature: 0.2, think: false, style: 'normal', knowledge: true, topP: 0.95, numCtx: 8192 })
    expect(linked.at(-1)).toBe(ASSISTENTE)
    await expect(session().create({ roleId: 'manca' })).rejects.toThrow(/Ruolo non trovato/)
  })

  it('modello consigliato non installato: resta quello predefinito; il profilo del modello in uso conta', async () => {
    await install(PROMPT, load('prompt.it.json'))
    // gemma4:12b non c'è: si usa llama3.2:3b, che ha un profilo senza valori di mente
    const conv = await session().create({ roleId: PROMPT })
    expect(conv).toMatchObject({ model: 'llama3.2:3b', temperature: 0.3, think: true, style: 'normal', knowledge: false, numCtx: 4096 })
    // con gemma4:12b installato: profilo gemma4:* (temperatura 0,4), ma «Asciutto» la governa → 0,3
    const big = await session({ installed: ['gemma4:12b'] }).create({ roleId: PROMPT })
    expect(big).toMatchObject({ model: 'gemma4:12b', temperature: 0.3, numCtx: 16384 })
  })

  it('da un template: ruolo, scelte, ritocchi e situazione tornano; ciò che il template ha salvato vince', async () => {
    await install(PROMPT, load('prompt.it.json'))
    const s = session()
    const src = await s.create({ roleId: PROMPT })
    await s.choose(src.id, 'stile', 'dettagliato')
    await s.update(src.id, { temperature: 0.45, situation: 'Classifico email' })
    const tpl = await createTemplateFromConversation(h.db, src.id, 'Email')
    const conv = await s.create({ templateId: tpl.id })
    expect(conv).toMatchObject({ roleId: PROMPT, roleParams: { stile: 'dettagliato' }, mindOverrides: { temperature: 0.45 }, temperature: 0.45, situation: 'Classifico email', think: true })
  })
})

describe('scelta di un\'opzione', () => {
  it('aggiorna le scelte e la mente; le opzioni che non toccano la mente la lasciano com\'è', async () => {
    await install(PROMPT, load('prompt.it.json'))
    const s = session()
    const conv = await s.create({ roleId: PROMPT })
    const a = await s.choose(conv.id, 'stile', 'dettagliato')
    expect(a).toMatchObject({ temperature: 0.6, roleParams: { stile: 'dettagliato', risultato: 'spiegato' } })
    const b = await s.choose(conv.id, 'risultato', 'solo')
    // D37: lo stile (lunghezza) cambia, la temperatura no
    expect(b).toMatchObject({ style: 'concise', temperature: 0.6 })
    const c = await s.choose(conv.id, 'tecniche', ['passi', 'ruolo'])
    expect(c).toMatchObject({ temperature: 0.6, style: 'concise', roleParams: { tecniche: ['ruolo', 'passi'] } })
  })

  it('vince l\'ultima azione: il ritocco a mano resta finché non cambia l\'opzione che governa quel valore', async () => {
    await install(PROMPT, load('prompt.it.json'))
    const s = session()
    const conv = await s.create({ roleId: PROMPT })
    // a mano: temperatura 0,5 e stile Esteso
    const tweaked = await s.update(conv.id, { temperature: 0.5, style: 'extended' })
    expect(tweaked).toMatchObject({ temperature: 0.5, style: 'extended', mindOverrides: { temperature: 0.5, style: 'extended' } })
    // un'altra opzione: i ritocchi restano
    expect(await s.choose(conv.id, 'destinatario', 'esperto')).toMatchObject({ temperature: 0.5, style: 'extended' })
    // l'opzione che governa la temperatura: il ritocco sulla temperatura decade, quello sullo stile no
    expect(await s.choose(conv.id, 'stile', 'dettagliato')).toMatchObject({ temperature: 0.6, style: 'extended', mindOverrides: { style: 'extended' } })
    // l'opzione che governa lo stile: decade anche quello
    const last = await s.choose(conv.id, 'risultato', 'solo')
    expect(last).toMatchObject({ temperature: 0.6, style: 'concise' })
    expect(last.mindOverrides).toEqual({})
  })

  it('un\'impostazione che nessuno fissa più torna al valore suggerito per il modello', async () => {
    const role: Role = {
      instructions: 'Sei un tutor.',
      parameters: [
        { id: 'fantasia', section: 'style', label: 'Fantasia', type: 'single', default: 'normale', options: [{ id: 'normale', label: 'Normale' }, { id: 'alta', label: 'Alta', mind: { temperature: 1.4, think: true } }] }
      ]
    }
    await install('tutor', role)
    const s = session()
    const conv = await s.create({ roleId: 'tutor' })
    expect(conv).toMatchObject({ temperature: 0.8, think: false })
    expect(await s.choose(conv.id, 'fantasia', 'alta')).toMatchObject({ temperature: 1.4, think: true })
    expect(await s.choose(conv.id, 'fantasia', 'normale')).toMatchObject({ temperature: 0.8, think: false })
  })

  it('rifiuta parametri e opzioni che il ruolo non ha', async () => {
    await install(PROMPT, load('prompt.it.json'))
    const s = session()
    const conv = await s.create({ roleId: PROMPT })
    await expect(s.choose(conv.id, 'sparito', 'x')).rejects.toThrow(/Parametro del ruolo non trovato/)
    await expect(s.choose(conv.id, 'stile', 'barocco')).rejects.toThrow(/Opzione non valida/)
    await expect(s.choose(conv.id, 'stile', ['asciutto'])).rejects.toThrow(/Opzione non valida/)
    await expect(s.choose(conv.id, 'tecniche', 'ruolo')).rejects.toThrow(/Opzione non valida/)
    const plain = await s.create()
    await expect(s.choose(plain.id, 'stile', 'asciutto')).rejects.toThrow(/Parametro del ruolo non trovato/)
  })
})

describe('ritocchi manuali, modello, valori suggeriti', () => {
  it('Generalista: nessun ritocco registrato, il comportamento è quello di sempre', async () => {
    const s = session()
    const conv = await s.create()
    const u = await s.update(conv.id, { temperature: 0.3, title: 'Prova' })
    expect(u).toMatchObject({ temperature: 0.3, title: 'Prova', mindOverrides: null })
    // cambio modello: valori suggeriti per il nuovo modello
    expect(await s.update(conv.id, { model: 'gemma4:e4b' })).toMatchObject({ model: 'gemma4:e4b', temperature: 1, numCtx: 8192 })
  })

  it('cambio modello con un ruolo: valori suggeriti, poi la mente del ruolo con il profilo, poi i ritocchi', async () => {
    const role: Role = { instructions: 'Sei un tutor.', mind: { temperature: 0.6 }, profiles: [{ models: ['gemma4:*'], verified: true, mind: { temperature: 0.4, think: true } }] }
    await install('tutor', role)
    const s = session()
    const conv = await s.create({ roleId: 'tutor' })
    expect(conv).toMatchObject({ model: 'llama3.2:3b', temperature: 0.6, think: false, numCtx: 4096 })
    expect(await s.update(conv.id, { model: 'gemma4:e4b' })).toMatchObject({ temperature: 0.4, think: true, numCtx: 8192 })
    await s.update(conv.id, { numCtx: 2048 })
    expect(await s.update(conv.id, { model: 'llama3.2:3b' })).toMatchObject({ temperature: 0.6, numCtx: 2048, mindOverrides: { numCtx: 2048 } })
  })

  it('«Tutti i valori suggeriti»: tornano i valori del modello, o quelli del ruolo dove li fissa; i ritocchi su quei valori decadono', async () => {
    await install(PROMPT, load('prompt.it.json'))
    const s = session()
    const conv = await s.create({ roleId: PROMPT })
    await s.update(conv.id, { temperature: 1.2, topP: 0.5, style: 'extended' })
    const c = await s.calibrate(conv.id)
    expect(c).toMatchObject({ temperature: 0.3, topP: 0.9, numCtx: 4096, style: 'extended', mindOverrides: { style: 'extended' } })
    const plain = await s.create()
    await s.update(plain.id, { temperature: 0.1 })
    expect(await s.calibrate(plain.id)).toMatchObject({ temperature: 0.8, mindOverrides: null })
  })
})

describe('cambio di ruolo', () => {
  it('a conversazione vuota: il ruolo cambia; scelte, ritocchi e mente ripartono; la situazione resta', async () => {
    await install(PROMPT, load('prompt.it.json'))
    await install(ASSISTENTE, load('assistente.it.json'))
    const s = session()
    const conv = await s.create({ roleId: PROMPT })
    await s.choose(conv.id, 'stile', 'dettagliato')
    await s.update(conv.id, { style: 'extended', situation: 'Contesto mio' })
    const next = await s.setRole(conv.id, ASSISTENTE)
    expect(next).toMatchObject({ roleId: ASSISTENTE, model: 'gemma4:e4b', roleParams: null, mindOverrides: null, temperature: 0.2, think: false, style: 'normal', knowledge: true, situation: 'Contesto mio' })
    // ritorno al Generalista: nulla del ruolo resta nella mente
    const plain = await s.setRole(conv.id, GENERALIST_ROLE_ID)
    expect(plain).toMatchObject({ roleId: GENERALIST_ROLE_ID, temperature: 1, think: false, style: 'normal', situation: 'Contesto mio' })
    await expect(s.setRole(conv.id, 'manca')).rejects.toThrow(/Ruolo non trovato/)
  })

  it('le basi del ruolo precedente si scollegano, salvo quelle che anche il nuovo richiede', async () => {
    const base = async (pkg: string) => (await updateBase(h.db, (await createBase(h.db, { name: pkg, origin: 'package' })).id, { packageId: pkg }))!
    const [a, b, mine] = [await base('kb.a'), await base('kb.b'), await base('kb.mia')]
    await install('uno', { instructions: 'Uno.', bases: [{ id: 'kb.a', purpose: 'behavior' }, { id: 'kb.b', purpose: 'examples' }] })
    await install('due', { instructions: 'Due.', bases: [{ id: 'kb.b', purpose: 'behavior' }] })
    const { createKnowledge } = await import('../src/main/knowledge')
    const { createBuiltinRegistry } = await import('../src/main/knowledge/sources')
    const knowledge = createKnowledge({ db: h.db, embedder: {} as never, registry: createBuiltinRegistry() })
    const s = createRoleSession({ db: h.db, knowledge, initialModel: async () => 'llama3.2:3b', suggest: async () => ({}), modelInstalled: async () => false })
    const conv = await s.create({ roleId: 'uno' })
    await knowledge.link(conv, mine.id)
    const names = async () => (await listLinkedBases(h.db, conv.id)).map((x) => x.packageId).sort()
    expect(await names()).toEqual(['kb.a', 'kb.b', 'kb.mia'])
    await s.setRole(conv.id, 'due')
    expect(await names()).toEqual(['kb.b', 'kb.mia'])
    expect((await listLinkPurposes(h.db, conv.id)).get(b.id)).toBe('behavior')
    await s.setRole(conv.id, GENERALIST_ROLE_ID)
    expect(await names()).toEqual(['kb.mia'])
    expect(a.id).not.toBe(b.id)
  })

  it('a conversazione avviata non si cambia: si apre una nuova conversazione, che può partire dal riassunto', async () => {
    await install(ASSISTENTE, load('assistente.it.json'))
    const s = session()
    const conv = await s.create()
    await addMessage(h.db, { conversationId: conv.id, role: 'user', content: 'Parto per Lisbona a maggio' })
    await addMessage(h.db, { conversationId: conv.id, role: 'assistant', content: 'Bene: quattro notti bastano.' })
    await expect(s.setRole(conv.id, ASSISTENTE)).rejects.toThrow(/solo a conversazione vuota/)

    // senza riassunto (Ollama spento): si portano gli ultimi messaggi
    const carried = await s.create({ roleId: ASSISTENTE, carryFrom: conv.id })
    expect(carried).toMatchObject({ roleId: ASSISTENTE, summary: 'Utente: Parto per Lisbona a maggio\n\nAssistente: Bene: quattro notti bastano.', summaryUpTo: null })

    // con il riassunto aggiornato: riassunto + i messaggi che non copre
    const first = (await import('../src/main/db/repo')).listMessages
    const msgs = await first(h.db, conv.id)
    const withSummary = session({ summarize: async (id) => updateConversation(h.db, id, { summary: 'Viaggio a Lisbona a maggio.', summaryUpTo: msgs[0].id }) })
    const again = await withSummary.create({ roleId: ASSISTENTE, carryFrom: conv.id })
    expect(again.summary).toBe('Viaggio a Lisbona a maggio.\n\nAssistente: Bene: quattro notti bastano.')
    // da zero: nessun riassunto
    expect((await s.create({ roleId: ASSISTENTE })).summary).toBeNull()
    // la conversazione di partenza non cambia ruolo
    expect((await getConversation(h.db, conv.id))!.roleId).toBe(GENERALIST_ROLE_ID)
    // una conversazione vuota non porta nulla
    expect((await s.create({ roleId: ASSISTENTE, carryFrom: (await s.create()).id })).summary).toBeNull()
  })
})
