import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildChatMessages,
  buildOptions,
  cleanTitle,
  createChatService,
  fallbackTitle
} from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { createConversation, getConversation, getPlan, listContextCalls, listMessages, listPlans, removeMessage, saveRole, updateConversation, updatePlan } from '../src/main/db/repo'
import { createContextLog } from '../src/main/contextLog'
import { parseRole } from '../src/shared/roles'
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
    { name: 'small', capabilities: ['completion'], contextLength: 4096, parameters: 'num_ctx 2048' },
    { name: 'slow', capabilities: ['completion'], delayMs: 20, chunks: Array.from({ length: 40 }, (_, i) => ({ content: `${i} ` })) },
    { name: 'badplan', capabilities: ['completion'], plan: 'scusa, non so fare piani' },
    { name: 'cut', capabilities: ['completion'], doneReason: 'length', chunks: [{ content: 'Inizio della risposta' }] }
  ])
})
afterAll(() => fake.close())

beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
  events = []
  updated = []
})
afterEach(() => h.close())

let updated: Conversation[]
const service = () =>
  createChatService({
    db: h.db,
    ollama: createOllamaClient(() => fake.url),
    emit: (_t, e) => events.push(e),
    onConversationUpdated: (_t, c) => updated.push(c)
  })

/** Richiesta di generazione del titolo (dopo il primo scambio). */
const isTitleRequest = (body: unknown) =>
  // Riconosciuta dal tetto di 32 token: il testo della richiesta segue la lingua del ruolo.
  (body as { options?: { num_predict?: number } }).options?.num_predict === 32

const lastChatBody = () =>
  fake.requests.filter((r) => r.path === '/api/chat' && !isTitleRequest(r.body)).at(-1)?.body as {
    messages: Array<{ role: string; content: string }>
    think?: boolean
    format?: unknown
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

  it('opzioni: valori effettivi sempre espliciti, seed solo se impostato', () => {
    // nessun num_predict: la lunghezza della risposta la governa lo stile nel system prompt
    expect(buildOptions(conv)).toEqual({ temperature: 0.3, top_p: 0.9, num_ctx: 4096, seed: 7 })
    expect(buildOptions({ ...conv, seed: null, numCtx: null })).toEqual({ temperature: 0.3, top_p: 0.9, num_ctx: 4096 })
    const caps = { capabilities: [], thinking: false, contextLength: 8192, kvBytesPerToken: null, layers: null, defaults: { temperature: 0.6, topP: 0.95, numCtx: 2048 } }
    // in automatico: consigliati dal modello; la scelta dell'utente non supera il massimo del modello
    expect(buildOptions({ ...conv, seed: null, numCtx: null, topP: null }, caps)).toEqual({ temperature: 0.3, top_p: 0.95, num_ctx: 2048 })
    expect(buildOptions({ ...conv, seed: null, numCtx: 65536 }, caps)).toEqual({ temperature: 0.3, top_p: 0.95, num_ctx: 8192 })
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

  it('lo storico lascia liberi i token di riserva per la risposta (un quarto della memoria)', () => {
    // 4096 di memoria → riserva 1024 → 3072 per lo storico; ogni messaggio da 4000 caratteri costa 1004 token
    const big = (i: number) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000) }) as never
    const history = [big(0), big(1), big(2), big(3), big(4)]
    expect(buildChatMessages({ ...conv, role: '', constraints: '' }, history)).toHaveLength(3)
    // 2048 di memoria → riserva 1024 → 1024: ci sta solo l'ultima domanda
    expect(buildChatMessages({ ...conv, role: '', constraints: '', numCtx: 2048 }, history)).toHaveLength(1)
  })

  it('lo stile della risposta è una sezione del system prompt, dopo il brief', () => {
    const msgs = buildChatMessages({ ...conv, style: 'concise' }, [{ role: 'user', content: 'ciao' } as never])
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toMatch(/^# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano\n\n# Stile della risposta\nVai dritto al punto/)
    // normale: nessuna sezione
    expect(buildChatMessages({ ...conv, style: 'normal' }, [{ role: 'user', content: 'ciao' } as never])[0].content).toBe('# Ruolo\nSei un tutor\n\n# Vincoli\nSolo italiano')
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
    // nessuna scelta esplicita: predefiniti di Ollama, ma sempre inviati (= ciò che l'interfaccia mostra)
    expect(body.options).toEqual({ temperature: 1.1, top_p: 0.9, num_ctx: 4096 })
    // llama3.2 non supporta il ragionamento: il parametro think non va inviato
    expect(body).not.toHaveProperty('think')

    expect(events.map((e) => e.type)).toEqual(['content', 'content', 'done'])
    expect(events.every((e) => e.streamId === streamId && e.conversationId === conv.id)).toBe(true)
    const done = events.at(-1)!
    expect(done.message).toMatchObject({ role: 'assistant', content: 'Ciao mondo!', evalCount: 42, durationMs: 1500, model: 'llama3.2' })
    // i token del prompt riportati da Ollama vengono salvati con la risposta
    expect(done.message?.promptEvalCount).toBeGreaterThan(0)

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

describe('plan mode', () => {
  it('propose → piano salvato come proposed, con format=schema e brief nel system prompt', async () => {
    const conv = await createConversation(h.db, { model: 'qwen3', think: true, constraints: 'Solo italiano', planMode: true })
    const chat = service()
    const { streamId, userMessage } = await chat.proposePlan(target, conv.id, 'Spiegami le frazioni')
    await chat.wait(streamId)

    const body = lastChatBody()
    expect(body.format).toMatchObject({ required: ['steps'] })
    expect(body.messages[0].content).toMatch(/^# Vincoli\nSolo italiano\n\n# Modalità piano/)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Spiegami le frazioni' })

    expect(events.every((e) => e.kind === 'plan')).toBe(true)
    const done = events.at(-1)!
    expect(done.type).toBe('done')
    expect(done.message).toBeUndefined()
    expect(done.plan).toMatchObject({ status: 'proposed', userMessageId: userMessage!.id })
    expect(done.plan!.steps.map((s) => s.title)).toEqual([
      'Capire la richiesta',
      'Raccogliere i punti chiave',
      'Scrivere la risposta'
    ])
    // il piano non finisce nello storico dei messaggi
    expect((await listMessages(h.db, conv.id)).map((m) => m.role)).toEqual(['user'])
  })

  it('execute → risposta che segue il piano modificato, piano executed', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', role: 'Sei un tutor' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Domanda')).streamId)
    const plan = events.at(-1)!.plan!
    await updatePlan(h.db, plan.id, { steps: [{ title: 'Solo questo passo', detail: 'Breve.' }] })

    events = []
    const { streamId, userMessage } = await chat.executePlan(target, plan.id)
    expect(userMessage).toBeUndefined()
    expect((await getPlan(h.db, plan.id))?.status).toBe('approved')
    await chat.wait(streamId)

    const body = lastChatBody()
    expect(body.format).toBeUndefined()
    expect(body.messages[0].content).toBe(
      '# Ruolo\nSei un tutor\n\n# Piano approvato\n' +
        "L'utente ha approvato questo piano per rispondere alla sua ultima richiesta. Seguilo passo per passo, nell'ordine indicato, senza aggiungere né saltare passi. Non ripetere il piano: esegui.\n\n" +
        '1. Solo questo passo — Breve.'
    )
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'Domanda' }])

    const done = events.at(-1)!
    expect(done).toMatchObject({ kind: 'chat', type: 'done' })
    expect(done.message?.content).toBe('Ciao mondo!')
    expect(done.executedPlan).toMatchObject({ id: plan.id, status: 'executed' })
    await expect(chat.executePlan(target, plan.id)).rejects.toThrow('non si può eseguire')
  })

  it('regenerate dopo l\'esecuzione segue ancora il piano', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Domanda')).streamId)
    const plan = events.at(-1)!.plan!
    await chat.wait((await chat.executePlan(target, plan.id)).streamId)
    await chat.wait((await chat.regenerate(target, conv.id)).streamId)
    expect(lastChatBody().messages[0].content).toContain('# Piano approvato')
    expect((await listMessages(h.db, conv.id)).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('riprova dopo un errore di esecuzione: segue il piano approvato', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Domanda')).streamId)
    const plan = events.at(-1)!.plan!
    await updateConversation(h.db, conv.id, { model: 'inesistente' })
    await chat.wait((await chat.executePlan(target, plan.id)).streamId)
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'chat' })
    expect((await getPlan(h.db, plan.id))?.status).toBe('approved')

    await updateConversation(h.db, conv.id, { model: 'llama3.2' })
    await chat.wait((await chat.regenerate(target, conv.id)).streamId)
    expect(lastChatBody().messages[0].content).toContain('# Piano approvato')
    expect(events.at(-1)?.executedPlan).toMatchObject({ id: plan.id, status: 'executed' })
  })

  it('regeneratePlan sostituisce il piano proposto', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Domanda')).streamId)
    const first = events.at(-1)!.plan!
    await chat.wait((await chat.regeneratePlan(target, conv.id)).streamId)
    const plans = await listPlans(h.db, conv.id)
    expect(plans).toHaveLength(1)
    expect(plans[0].id).not.toBe(first.id)
    expect(plans[0].status).toBe('proposed')
  })

  it('risposta non valida → errore, nessun piano; poi si può riprovare', async () => {
    const conv = await createConversation(h.db, { model: 'badplan' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Domanda')).streamId)
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'plan' })
    expect(events.at(-1)?.error).toContain('piano valido')
    expect(await listPlans(h.db, conv.id)).toEqual([])
    await updateConversation(h.db, conv.id, { model: 'llama3.2' })
    await chat.wait((await chat.regeneratePlan(target, conv.id)).streamId)
    expect(await listPlans(h.db, conv.id)).toHaveLength(1)
  })

  it('un piano superato da un nuovo messaggio non si esegue', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'Prima')).streamId)
    const plan = events.at(-1)!.plan!
    await chat.wait((await chat.send(target, conv.id, 'Cambio idea')).streamId)
    await expect(chat.executePlan(target, plan.id)).rejects.toThrow('ultimo messaggio')
  })

  it('transizioni di stato', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    const chat = service()
    await chat.wait((await chat.proposePlan(target, conv.id, 'x')).streamId)
    const plan = events.at(-1)!.plan!
    const rejected = await updatePlan(h.db, plan.id, { status: 'rejected' })
    expect(rejected.status).toBe('rejected')
    await expect(updatePlan(h.db, plan.id, { status: 'approved' })).rejects.toThrow('Transizione non ammessa')
    await expect(updatePlan(h.db, plan.id, { steps: [{ title: 'a', detail: '' }] })).rejects.toThrow('non è più modificabile')
    await expect(chat.executePlan(target, plan.id)).rejects.toThrow('non si può eseguire')
  })
})

describe('titolo automatico', () => {
  it('dopo il primo scambio genera il titolo con il modello (think=false) e lo notifica', async () => {
    const conv = await createConversation(h.db, { model: 'qwen3', think: true })
    const chat = service()
    await chat.wait((await chat.send(target, conv.id, 'Parlami di Roma')).streamId)
    const req = fake.requests.filter((r) => r.path === '/api/chat' && isTitleRequest(r.body)).at(-1)?.body as {
      messages: Array<{ content: string }>
      think?: boolean
      options: Record<string, unknown>
    }
    expect(req.think).toBe(false)
    expect(req.options).toEqual({ temperature: 0.3, top_p: 0.9, num_ctx: 4096, num_predict: 32 })
    // la risposta normale finisce con done_reason 'stop'
    expect(events.find((e) => e.type === 'done')?.message?.doneReason).toBe('stop')
    expect(req.messages[1].content).toContain('Parlami di Roma')
    expect((await getConversation(h.db, conv.id))?.title).toBe('Ciao mondo!')
    expect(updated.map((c) => c.title)).toEqual(['Ciao mondo!'])

    // al secondo scambio non si rigenera
    await chat.wait((await chat.send(target, conv.id, 'Altro')).streamId)
    expect(updated).toHaveLength(1)
  })

  it('non tocca un titolo scelto dall\'utente', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', title: 'Mio titolo' })
    const chat = service()
    await chat.wait((await chat.send(target, conv.id, 'ciao')).streamId)
    expect((await getConversation(h.db, conv.id))?.title).toBe('Mio titolo')
    expect(updated).toEqual([])
  })

  it('se la generazione fallisce usa l\'inizio della domanda', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2' })
    // la risposta arriva dal server finto; quando lo stream è finito Ollama "sparisce"
    let url = fake.url
    const chat = createChatService({
      db: h.db,
      ollama: createOllamaClient(() => url),
      emit: (_t, e) => {
        if (e.type === 'done') url = 'http://127.0.0.1:1'
      }
    })
    await chat.wait((await chat.send(target, conv.id, 'Come si prepara il ragù alla bolognese tradizionale con il latte?')).streamId)
    expect((await getConversation(h.db, conv.id))?.title).toBe('Come si prepara il ragù alla bolognese…')
  })

  it('cleanTitle e fallbackTitle', () => {
    expect(cleanTitle('"Storia di Roma."')).toBe('Storia di Roma')
    expect(cleanTitle('<think>boh</think>\n\n**Titolo:** Viaggio a Lisbona')).toBe('Viaggio a Lisbona')
    expect(cleanTitle('# «Ricette veloci»\nAltro testo')).toBe('Ricette veloci')
    expect(cleanTitle('x '.repeat(50)).length).toBeLessThanOrEqual(61)
    expect(fallbackTitle('\n  Breve  \nsecondo')).toBe('Breve')
    expect(fallbackTitle('   ')).toBe('Nuova conversazione')
  })
})

describe('risposta tagliata al limite di token', () => {
  it('done_reason length viene salvato sul messaggio', async () => {
    const c = await createConversation(h.db, { model: 'cut' })
    const chat = service()
    await chat.wait((await chat.send(target, c.id, 'ciao')).streamId)
    const done = events.find((e) => e.type === 'done')!
    expect(done.message).toMatchObject({ content: 'Inizio della risposta', doneReason: 'length' })
    expect((await listMessages(h.db, c.id)).at(-1)?.doneReason).toBe('length')
  })
})

describe('limiti del modello', () => {
  it('nella richiesta a Ollama num_ctx non supera il massimo del modello', async () => {
    const c = await createConversation(h.db, { model: 'small', numCtx: 65536 })
    const chat = service()
    await chat.wait((await chat.send(target, c.id, 'ciao')).streamId)
    expect(lastChatBody().options.num_ctx).toBe(4096)
  })

  it('in automatico num_ctx è quello consigliato dal modello (Modelfile), e lo storico è tagliato su quello', async () => {
    const c = await createConversation(h.db, { model: 'small' })
    const chat = service()
    await chat.wait((await chat.send(target, c.id, 'ciao')).streamId)
    expect(lastChatBody().options.num_ctx).toBe(2048)
    // anche la richiesta del titolo usa lo stesso num_ctx: Ollama non ricarica il modello
    const title = fake.requests.filter((r) => r.path === '/api/chat' && isTitleRequest(r.body)).at(-1)?.body as { options: Record<string, unknown> }
    expect(title.options).toMatchObject({ num_ctx: 2048, num_predict: 32, temperature: 0.3 })
  })
})

describe('composizione del contesto scelta nelle Impostazioni', () => {
  const withOrder = (order: 'A' | 'B' | 'C', reminder: 'on' | 'off' = 'off') =>
    createChatService({
      db: h.db,
      ollama: createOllamaClient(() => fake.url),
      emit: (_t, e) => events.push(e),
      getContext: async () => ({ order, reminder, shares: { behavior: 0.2, examples: 0.2, documents: 0.6 }, situationShare: 0.05 })
    })
  const ask = async (svc: ReturnType<typeof service>, id: string, text: string): Promise<void> => {
    const { streamId } = await svc.send(target, id, text)
    await svc.wait(streamId)
  }

  /** Un ruolo installato, letto dai JSON di prova. */
  const install = async (id: string, file: string, language: string | null = 'it'): Promise<void> => {
    const definition = parseRole(JSON.parse(readFileSync(resolve(__dirname, 'fixtures/roles', file), 'utf8')))
    await saveRole(h.db, { id, packageId: id, group: null, language, name: id, description: '', version: '1.0.0', definition, origin: 'package' })
  }
  const tutor = { instructions: 'Sei un tutor. Spiega con esempi.' }

  it('B con promemoria: istruzioni del ruolo e situazione nel sistema, il promemoria con la domanda; in database resta il testo dell\'utente', async () => {
    await saveRole(h.db, { id: 'tutor', packageId: null, group: null, language: 'it', name: 'Tutor', description: '', version: null, definition: tutor, origin: 'package' })
    const conv = await createConversation(h.db, { model: 'llama3.2', roleId: 'tutor', situation: 'Lezione di matematica' })
    await ask(withOrder('B', 'on'), conv.id, 'ciao')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: 'Sei un tutor. Spiega con esempi.\n\n# Situazione\nLezione di matematica' },
      // Senza un campo `reminder`, il promemoria è la prima frase delle istruzioni.
      { role: 'user', content: '[Promemoria del ruolo: Sei un tutor.]\n\n# Domanda\nciao' }
    ])
    expect((await listMessages(h.db, conv.id))[0].content).toBe('ciao')
    await saveRole(h.db, { id: 'tutor', packageId: null, group: null, language: 'it', name: 'Tutor', description: '', version: null, definition: { ...tutor, reminder: 'Resta un tutor paziente' }, origin: 'package' })
    await ask(withOrder('B', 'on'), conv.id, 'e poi?')
    expect(lastChatBody().messages.at(-1)!.content).toBe('[Promemoria del ruolo: Resta un tutor paziente]\n\n# Domanda\ne poi?')
  })

  it('C: nel system prompt solo la situazione, le istruzioni del ruolo con la domanda; anche in plan mode', async () => {
    await saveRole(h.db, { id: 'tutor', packageId: null, group: null, language: 'it', name: 'Tutor', description: '', version: null, definition: tutor, origin: 'package' })
    const conv = await createConversation(h.db, { model: 'llama3.2', roleId: 'tutor', situation: 'Lezione di matematica' })
    const svc = withOrder('C')
    await ask(svc, conv.id, 'ciao')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: '# Situazione\nLezione di matematica' },
      { role: 'user', content: 'Sei un tutor. Spiega con esempi.\n\n# Domanda\nciao' }
    ])
    await updateConversation(h.db, conv.id, { planMode: true })
    const { streamId } = await svc.proposePlan(target, conv.id, 'spiegami le frazioni')
    await svc.wait(streamId)
    const plan = lastChatBody()
    expect(plan.format).toBeDefined()
    expect(plan.messages[0]).toEqual({ role: 'system', content: '# Situazione\nLezione di matematica' })
    expect(plan.messages.at(-1)!.content).toMatch(/^Sei un tutor\. Spiega con esempi\.\n\n# Modalità piano[\s\S]*\n\n# Domanda\nspiegami le frazioni$/)
  })

  it('Generalista con un Brief convertito: la situazione senza titolo, nessun promemoria, tutto nel sistema anche con l\'ordine C', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', role: 'Sei un tutor', context: 'Lezione di matematica' })
    const system = { role: 'system', content: '# Ruolo\nSei un tutor\n\n# Contesto\nLezione di matematica' }
    await ask(withOrder('A'), conv.id, 'ciao')
    expect(lastChatBody().messages).toEqual([system, { role: 'user', content: 'ciao' }])
    await removeMessage(h.db, (await listMessages(h.db, conv.id)).at(-1)!.id)
    await ask(withOrder('B', 'on'), conv.id, 'ciao')
    expect(lastChatBody().messages.at(-1)).toEqual({ role: 'user', content: 'ciao' })
    expect(lastChatBody().messages[0]).toEqual(system)
    const other = await createConversation(h.db, { model: 'llama3.2', role: 'Sei un tutor', context: 'Lezione di matematica' })
    await ask(withOrder('C'), other.id, 'ciao')
    expect(lastChatBody().messages).toEqual([system, { role: 'user', content: 'ciao' }])
  })

  it('transitorio: finché c\'è la scheda Brief, la situazione segue i suoi quattro campi; una situazione scritta vince', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', role: 'Sei un tutor' })
    expect((await updateConversation(h.db, conv.id, { role: 'Sei un cuoco', goals: 'Cucinare' })).situation).toBe('# Ruolo\nSei un cuoco\n\n# Obiettivi\nCucinare')
    await ask(service(), conv.id, 'ciao')
    expect(lastChatBody().messages[0]).toEqual({ role: 'system', content: '# Ruolo\nSei un cuoco\n\n# Obiettivi\nCucinare' })
    // Un aggiornamento che non tocca il Brief lascia la situazione com'è.
    await updateConversation(h.db, conv.id, { situation: 'Sto preparando una cena' })
    expect((await updateConversation(h.db, conv.id, { temperature: 0.2 })).situation).toBe('Sto preparando una cena')
    expect((await updateConversation(h.db, conv.id, { role: 'Altro', situation: 'Vince questa' })).situation).toBe('Vince questa')
    await ask(service(), conv.id, 'e ora?')
    expect(lastChatBody().messages[0]).toEqual({ role: 'system', content: 'Vince questa' })
  })

  it('ruolo con parametri: le frasi delle scelte nel prompt, nei tre ordini; stile e piano dopo la situazione', async () => {
    await install('prompt.it', 'prompt.it.json')
    const roleParams = { intervento: 'spiega', destinatario: 'esperto', risultato: 'solo', tecniche: ['formato'] }
    const instructions = [
      "Sei un esperto di prompt engineering per modelli linguistici. Lavori sui prompt dell'utente: non esegui il compito che il prompt descrive.",
      'Scrivi per modelli piccoli: una istruzione per riga, niente premesse.',
      'Non riscrivere: elenca i problemi in ordine di gravità.',
      'Usa pure i termini tecnici del prompt engineering.',
      'Restituisci solo il risultato richiesto, senza commenti.',
      'Usa frasi brevi e imperative.',
      'Quando scrivi o riscrivi un prompt, specifica il formato esatto della risposta.',
      'Rispondi direttamente.'
    ].join('\n')
    const situation = '# Situazione\nClassifico email di assistenza'
    const style = '# Stile della risposta\nRispondi in modo completo: contesto, alternative, esempi, avvertenze e casi limite. Struttura il testo con titoli ed elenchi quando aiuta.'
    const make = () => createConversation(h.db, { model: 'llama3.2', roleId: 'prompt.it', roleParams, situation: 'Classifico email di assistenza', style: 'extended' })

    const a = await make()
    await ask(withOrder('A'), a.id, 'guarda questo prompt')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: [instructions, situation, style].join('\n\n') },
      { role: 'user', content: 'guarda questo prompt' }
    ])
    const b = await make()
    await ask(withOrder('B', 'on'), b.id, 'guarda questo prompt')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: [instructions, situation, style].join('\n\n') },
      { role: 'user', content: '[Promemoria del ruolo: Sei un esperto di prompt engineering per modelli linguistici.]\n\n# Domanda\nguarda questo prompt' }
    ])
    const c = await make()
    await ask(withOrder('C', 'on'), c.id, 'guarda questo prompt')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: situation },
      { role: 'user', content: [instructions, style, '# Domanda\nguarda questo prompt'].join('\n\n') }
    ])
    // Scelte salvate che il ruolo non conosce più: valgono i predefiniti, senza errori.
    await updateConversation(h.db, a.id, { roleParams: { intervento: 'sparita' } })
    await ask(withOrder('A'), a.id, 'ancora')
    expect(lastChatBody().messages[0].content).toContain("Riscrivi il prompt dell'utente mantenendone l'intento.")
  })

  it('un ruolo che non c\'è più vale il Generalista: resta la situazione', async () => {
    const conv = await createConversation(h.db, { model: 'llama3.2', roleId: 'rimosso', situation: 'Contesto mio' })
    await ask(service(), conv.id, 'ciao')
    expect(lastChatBody().messages).toEqual([
      { role: 'system', content: 'Contesto mio' },
      { role: 'user', content: 'ciao' }
    ])
  })

  it('lingua del ruolo: un ruolo francese riceve in francese i testi scritti dall\'app, con l\'interfaccia in italiano', async () => {
    await saveRole(h.db, { id: 'tuteur', packageId: null, group: null, language: 'fr', name: 'Tuteur', description: '', version: null, definition: { instructions: 'Tu es un tuteur.' }, origin: 'package' })
    const conv = await createConversation(h.db, { model: 'llama3.2', roleId: 'tuteur', situation: 'Cours de maths', style: 'extended', planMode: true })
    const svc = withOrder('B', 'on')
    await ask(svc, conv.id, 'bonjour')
    const body = lastChatBody()
    expect(body.messages[0].content).toMatch(/^Tu es un tuteur\.\n\n# Situation\nCours de maths\n\n# Style de la réponse\n/)
    expect(body.messages[0].content).not.toMatch(/Stile della risposta|Situazione/)
    expect(body.messages.at(-1)!.content).toBe('[Rappel du rôle: Tu es un tuteur.]\n\n# Question\nbonjour')
    const { streamId } = await svc.proposePlan(target, conv.id, 'explique les fractions')
    await svc.wait(streamId)
    expect(lastChatBody().messages[0].content).toContain('# Mode plan\n')
    // Gli errori per l'utente restano nella lingua dell'interfaccia, e il Generalista non cambia lingua.
    const plain = await createConversation(h.db, { model: 'llama3.2', style: 'extended' })
    await ask(svc, plain.id, 'ciao')
    expect(lastChatBody().messages[0].content).toMatch(/^# Stile della risposta\n/)
    // Una lingua in cui l'app non sa scrivere: valgono i testi dell'interfaccia.
    await saveRole(h.db, { id: 'tutor.de', packageId: null, group: null, language: 'de', name: 'Tutor', description: '', version: null, definition: { instructions: 'Du bist ein Tutor.' }, origin: 'package' })
    const de = await createConversation(h.db, { model: 'llama3.2', roleId: 'tutor.de', situation: 'Mathe' })
    await ask(svc, de.id, 'hallo')
    expect(lastChatBody().messages[0].content).toBe('Du bist ein Tutor.\n\n# Situazione\nMathe')
  })

  it('due conversazioni insieme, in lingue diverse: ciascuna con i suoi testi', async () => {
    await saveRole(h.db, { id: 'tuteur', packageId: null, group: null, language: 'fr', name: 'Tuteur', description: '', version: null, definition: { instructions: 'Tu es un tuteur.' }, origin: 'package' })
    const fr = await createConversation(h.db, { model: 'slow', roleId: 'tuteur', situation: 'Cours', style: 'extended' })
    const it = await createConversation(h.db, { model: 'slow', situation: 'Lezione', style: 'extended' })
    const svc = service()
    const [x, y] = await Promise.all([svc.send(target, fr.id, 'bonjour'), svc.send(target, it.id, 'ciao')])
    await Promise.all([svc.wait(x.streamId), svc.wait(y.streamId)])
    const systems = fake.requests.filter((r) => r.path === '/api/chat' && !isTitleRequest(r.body)).slice(-2).map((r) => (r.body as { messages: Array<{ content: string }> }).messages[0].content)
    expect(systems.find((s) => s.startsWith('Tu es'))).toMatch(/# Situation\nCours\n\n# Style de la réponse/)
    expect(systems.find((s) => s.startsWith('Lezione'))).toMatch(/^Lezione\n\n# Stile della risposta/)
  })

  it('monitor: istruzioni e situazione sono due voci', async () => {
    await saveRole(h.db, { id: 'tutor', packageId: null, group: null, language: 'it', name: 'Tutor', description: '', version: null, definition: tutor, origin: 'package' })
    const conv = await createConversation(h.db, { model: 'llama3.2', roleId: 'tutor', situation: 'Lezione di matematica', style: 'concise' })
    const log = createContextLog(h.db)
    const svc = createChatService({ db: h.db, ollama: createOllamaClient(() => fake.url), emit: () => undefined, contextLog: log })
    await ask(svc, conv.id, 'ciao')
    const call = (await listContextCalls(h.db, conv.id)).find((c) => c.kind === 'chat')!
    expect(call.parts.map((p) => p.key)).toEqual(['instructions', 'situation', 'style', 'question'])
    // Generalista: il Brief convertito è la situazione, non più le istruzioni.
    const plain = await createConversation(h.db, { model: 'llama3.2', role: 'Sei un tutor' })
    await ask(svc, plain.id, 'ciao')
    expect((await listContextCalls(h.db, plain.id)).find((c) => c.kind === 'chat')!.parts.map((p) => p.key)).toEqual(['situation', 'question'])
  })
})
