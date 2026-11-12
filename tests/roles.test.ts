// Il ruolo come dato (passo 2.1): validazione, istruzioni, mente, profili. I due ruoli di base sono scritti come
// JSON di prova in tests/fixtures/roles e devono produrre gli esempi di calibrazione di docs/ruoli.md §7.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveContext } from '../src/shared/compose'
import {
  GENERALIST_ROLE,
  governedSettings,
  orderedParameters,
  parseRole,
  pickProfile,
  releaseOverrides,
  resolveChoices,
  roleContext,
  roleInstructions,
  roleMind,
  rolePrompt,
  roleReminderText,
  situationLimit,
  validateRole,
  type Role
} from '../src/shared/roles'
import { buildSystemPrompt, computeContextUsage } from '../src/shared/prompt'
import { DEFAULT_CONTEXT_SETTINGS, type ContextSettings } from '../src/shared/types'

const load = (name: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/roles', name), 'utf8'))
const assistente = parseRole(load('assistente.it.json'))
const prompt = parseRole(load('prompt.it.json'))

const codes = (raw: unknown): string[] => validateRole(raw).map((i) => i.code)
/** Un ruolo minimo valido con un parametro, da guastare un pezzo per volta. */
const withParameter = (patch: Record<string, unknown>): unknown => ({
  parameters: [
    {
      id: 'p',
      section: 'style',
      label: 'P',
      type: 'single',
      default: 'a',
      options: [
        { id: 'a', label: 'A', instruction: 'Frase A.' },
        { id: 'b', label: 'B', instruction: 'Frase B.' }
      ],
      ...patch
    }
  ]
})

describe('validazione', () => {
  it('accetta i ruoli di base e il Generalista', () => {
    expect(validateRole(load('assistente.it.json'))).toEqual([])
    expect(validateRole(load('prompt.it.json'))).toEqual([])
    expect(validateRole(GENERALIST_ROLE)).toEqual([])
    expect(validateRole(withParameter({}))).toEqual([])
  })

  it('rifiuta ciò che non è un ruolo', () => {
    expect(codes(null)).toEqual(['role.shape'])
    expect(codes([])).toEqual(['role.shape'])
    expect(codes({ instructions: 3 })).toEqual(['instructions.type'])
    expect(codes({ parameters: {} })).toEqual(['parameter.shape'])
    expect(() => parseRole({ parameters: {} })).toThrow(/parameter\.shape/)
  })

  it('sezioni, tipi, etichette e id', () => {
    expect(codes(withParameter({ section: 'tono' }))).toEqual(['parameter.section'])
    expect(codes(withParameter({ type: 'slider' }))).toEqual(['parameter.type'])
    expect(codes(withParameter({ label: ' ' }))).toEqual(['parameter.label'])
    expect(codes(withParameter({ id: '' }))).toEqual(['parameter.id'])
    const two = withParameter({}) as { parameters: unknown[] }
    expect(codes({ parameters: [two.parameters[0], two.parameters[0]] })).toEqual(['parameter.duplicate'])
  })

  it('opzioni', () => {
    expect(codes(withParameter({ options: [] }))).toEqual(['option.none', 'default.unknown'])
    expect(codes(withParameter({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A2' }] }))).toEqual(['option.duplicate'])
    expect(codes(withParameter({ options: [{ id: 'a' }] }))).toEqual(['option.label'])
    expect(codes(withParameter({ options: [{ id: 'a', label: 'A', instruction: 1 }] }))).toEqual(['option.instruction'])
  })

  it('predefiniti coerenti con le opzioni', () => {
    expect(codes(withParameter({ default: undefined }))).toEqual(['default.missing'])
    expect(codes(withParameter({ default: 'z' }))).toEqual(['default.unknown'])
    expect(codes(withParameter({ default: ['a'] }))).toEqual(['default.type'])
    expect(codes(withParameter({ type: 'multi', default: 'a' }))).toEqual(['default.type'])
    expect(codes(withParameter({ type: 'multi', default: ['a', 'z'] }))).toEqual(['default.unknown'])
    // La scelta multipla può partire vuota.
    expect(codes(withParameter({ type: 'multi', default: undefined }))).toEqual([])
    expect(codes(withParameter({ type: 'multi', default: [] }))).toEqual([])
  })

  it('un sì/no ha esattamente le opzioni on e off', () => {
    expect(codes(withParameter({ type: 'toggle' }))).toEqual(['toggle.options'])
    const toggle = { type: 'toggle', default: 'off', options: [{ id: 'on', label: 'Sì', instruction: 'Fallo.' }, { id: 'off', label: 'No' }] }
    expect(codes(withParameter(toggle))).toEqual([])
  })

  it('valori della mente: solo impostazioni note e valori ammessi', () => {
    const option = (mind: unknown): unknown => withParameter({ options: [{ id: 'a', label: 'A', mind }, { id: 'b', label: 'B' }] })
    expect(codes(option({ temperature: 0.3, style: 'essential', think: false }))).toEqual(['mind.styleTemperature'])
    expect(codes(option({ temperature: 3 }))).toEqual(['mind.value'])
    expect(codes(option({ style: 'sintetico' }))).toEqual(['mind.value'])
    expect(codes(option({ numCtx: 0.5 }))).toEqual(['mind.value'])
    // D15: un'opzione non accende le basi e non cambia modello.
    expect(codes(option({ knowledge: true }))).toEqual(['mind.key'])
    expect(codes(option({ model: 'gemma4:e4b' }))).toEqual(['mind.key'])
    expect(codes({ mind: { model: 'gemma4:e4b', knowledge: true, temperature: 0.2 } })).toEqual([])
    expect(codes({ mind: { seed: 1 } })).toEqual(['mind.key'])
  })

  it('D12: al massimo un parametro per impostazione della mente', () => {
    const p = (id: string, mind: unknown, type = 'single'): unknown => ({
      id,
      section: 'style',
      label: id,
      type,
      default: type === 'multi' ? [] : 'a',
      options: [
        { id: 'a', label: 'A', mind },
        { id: 'b', label: 'B', mind }
      ]
    })
    // Le alternative di una scelta singola possono toccare la stessa impostazione.
    expect(codes({ parameters: [p('uno', { temperature: 0.3 })] })).toEqual([])
    expect(codes({ parameters: [p('uno', { temperature: 0.3 }), p('due', { think: true })] })).toEqual([])
    expect(validateRole({ parameters: [p('uno', { temperature: 0.3 }), p('due', { temperature: 0.6 })] })).toEqual([
      { code: 'mind.conflict', at: 'parameters[due].temperature' }
    ])
    // In una scelta multipla due opzioni possono essere attive insieme.
    expect(codes({ parameters: [p('uno', { temperature: 0.3 }, 'multi')] })).toEqual(['mind.multi'])
  })

  it('D37: lunghezza della risposta e temperatura mai nello stesso parametro', () => {
    const options = [
      { id: 'a', label: 'A', mind: { style: 'essential' } },
      { id: 'b', label: 'B', mind: { temperature: 0.2 } }
    ]
    expect(validateRole(withParameter({ options }))).toEqual([{ code: 'mind.styleTemperature', at: 'parameters[p]' }])
  })

  it('basi e profili', () => {
    expect(codes({ bases: [{ id: 'x', purpose: 'behavior' }, { id: 'x', purpose: 'examples' }] })).toEqual(['base.duplicate'])
    expect(codes({ bases: [{ id: 'x', purpose: 'manuale' }] })).toEqual(['base.purpose'])
    expect(codes({ bases: [{ purpose: 'behavior' }] })).toEqual(['base.shape'])
    expect(codes({ profiles: [{ models: [] }] })).toEqual(['profile.models'])
    expect(codes({ profiles: [{ models: ['*'] }] })).toEqual(['profile.models'])
    expect(codes({ profiles: [{ models: ['gemma4:*'] }, { models: ['Gemma4:*'] }] })).toEqual(['profile.duplicate'])
    expect(codes({ profiles: [{ models: ['gemma4:*'], context: { order: 'D' } }] })).toEqual(['profile.order'])
    expect(codes({ profiles: [{ models: ['gemma4:*'], context: { reminder: 'on' } }] })).toEqual(['profile.reminder'])
    expect(codes({ profiles: [{ models: ['gemma4:*'], context: { shares: { behavior: 0.5, examples: 0.5, documents: 0.5 } } }] })).toEqual(['profile.shares'])
    expect(codes({ profiles: [{ models: ['gemma4:*'], mind: { model: 'altro' } }] })).toEqual(['mind.key'])
  })
})

describe('scelte', () => {
  it('ciò che manca prende il predefinito', () => {
    expect(resolveChoices(assistente)).toEqual({
      scopo: 'fare',
      livello: 'primo',
      formato: 'passi',
      percorso: 'on',
      argomenti: ['basi'],
      lacuna: 'dichiara'
    })
  })

  it('scarta ciò che il ruolo non conosce più e tiene l\'ordine delle opzioni', () => {
    const resolved = resolveChoices(assistente, { scopo: 'sparita', argomenti: ['store', 'sparita', 'basi'], altro: 'x' })
    expect(resolved.scopo).toBe('fare')
    expect(resolved.argomenti).toEqual(['basi', 'store'])
    expect(resolved).not.toHaveProperty('altro')
    // Una scelta multipla svuotata dall'utente resta vuota: non torna al predefinito.
    expect(resolveChoices(assistente, { argomenti: [] }).argomenti).toEqual([])
  })

  it('i parametri seguono l\'ordine delle sezioni', () => {
    const role: Role = {
      parameters: [
        { id: 'm', section: 'method', label: 'M', type: 'single', default: 'a', options: [{ id: 'a', label: 'A', instruction: 'Metodo.' }] },
        { id: 'i', section: 'identity', label: 'I', type: 'single', default: 'a', options: [{ id: 'a', label: 'A', instruction: 'Identità.' }] }
      ]
    }
    expect(orderedParameters(role).map((p) => p.id)).toEqual(['i', 'm'])
    expect(roleInstructions(role)).toBe('Identità.\nMetodo.')
  })
})

describe('istruzioni (docs/ruoli.md §7)', () => {
  it('Generalista: nessuna istruzione', () => {
    expect(roleInstructions(GENERALIST_ROLE)).toBe('')
    expect(roleMind(GENERALIST_ROLE)).toEqual({})
  })

  it('Assistente di FastChat: esempio di calibrazione', () => {
    const choices = { scopo: 'fare', livello: 'esperto', formato: 'breve', percorso: 'on', argomenti: ['modelli'], lacuna: 'dichiara' }
    expect(roleInstructions(assistente, choices)).toBe(
      [
        "Sei l'assistente di FastChat. Rispondi solo a domande sull'uso dell'app, usando la documentazione fornita. Usa i nomi esatti di schede e pulsanti. Se una funzione non esiste, dillo.",
        "Guida l'utente a compiere l'azione.",
        'Vai dritto al punto, senza concetti di base.',
        'Rispondi in una o due frasi.',
        'Indica sempre il percorso: finestra → scheda → pulsante.',
        "Quando è pertinente, indica l'effetto su memoria e velocità.",
        'Se la documentazione non copre la domanda, dillo e non inventare.'
      ].join('\n')
    )
    expect(roleMind(assistente, { choices })).toEqual({ model: 'gemma4:e4b', temperature: 0.2, think: false, style: 'essential', knowledge: true })
  })

  it('Assistente di FastChat: un sì/no spento non aggiunge frasi', () => {
    const text = roleInstructions(assistente, { percorso: 'off' })
    expect(text).not.toContain('percorso')
    expect(text.split('\n')).toHaveLength(6)
  })

  it('Esperto di prompt engineering: esempio di calibrazione', () => {
    const choices = {
      specializzazione: 'piccoli',
      intervento: 'spiega',
      destinatario: 'esperto',
      risultato: 'solo',
      stile: 'asciutto',
      tecniche: ['passi', 'formato'],
      metodo: 'subito'
    }
    expect(roleInstructions(prompt, choices)).toBe(
      [
        "Sei un esperto di prompt engineering per modelli linguistici. Lavori sui prompt dell'utente: non esegui il compito che il prompt descrive.",
        'Scrivi per modelli piccoli: una istruzione per riga, niente premesse.',
        'Non riscrivere: elenca i problemi in ordine di gravità.',
        'Usa pure i termini tecnici del prompt engineering.',
        'Restituisci solo il risultato richiesto, senza commenti.',
        'Usa frasi brevi e imperative.',
        'Quando scrivi o riscrivi un prompt, specifica il formato esatto della risposta.',
        'Quando scrivi o riscrivi un prompt, chiedi al modello di procedere per passi numerati.',
        'Rispondi direttamente.'
      ].join('\n')
    )
    expect(roleMind(prompt, { choices })).toEqual({ model: 'gemma4:12b', temperature: 0.3, think: true, style: 'concise', knowledge: false })
  })
})

describe('mente (D13)', () => {
  it('valori base, poi le opzioni scelte', () => {
    expect(roleMind(prompt)).toMatchObject({ temperature: 0.3, style: 'normal' })
    expect(roleMind(prompt, { choices: { stile: 'dettagliato' } }).temperature).toBe(0.6)
  })

  it('la temperatura non dipende dalla lunghezza della risposta', () => {
    const short = roleMind(prompt, { choices: { risultato: 'solo' } })
    const long = roleMind(prompt, { choices: { risultato: 'spiegato' } })
    expect([short.style, long.style]).toEqual(['concise', 'normal'])
    expect(short.temperature).toBe(long.temperature)
  })

  it('i ritocchi manuali vincono sulle opzioni', () => {
    const mind = roleMind(prompt, { choices: { stile: 'asciutto' }, overrides: { temperature: 0.5, knowledge: true } })
    expect(mind).toMatchObject({ temperature: 0.5, knowledge: true, style: 'normal' })
  })

  it('vince l\'ultima azione: cambiare un\'opzione fa decadere il ritocco su ciò che governa', () => {
    expect(governedSettings(prompt, 'stile')).toEqual(['temperature'])
    expect(governedSettings(prompt, 'tecniche')).toEqual([])
    const overrides = { temperature: 0.5, style: 'extended' as const }
    const after = releaseOverrides(prompt, overrides, 'stile')
    expect(after).toEqual({ style: 'extended' })
    expect(roleMind(prompt, { choices: { stile: 'dettagliato' }, overrides: after })).toMatchObject({ temperature: 0.6, style: 'extended' })
    // Un parametro che non governa nulla non tocca i ritocchi.
    expect(releaseOverrides(prompt, overrides, 'tecniche')).toEqual(overrides)
    expect(releaseOverrides(prompt, null, 'stile')).toEqual({})
  })

  it('il profilo del modello sostituisce i valori base, non le opzioni', () => {
    // gemma4:* porta temperatura 0,4, ma l'opzione «Asciutto» la governa.
    expect(roleMind(prompt, { model: 'gemma4:12b' }).temperature).toBe(0.3)
    // gemma4:e4b spegne il ragionamento, ma l'opzione «Risponde subito» lo governa.
    expect(roleMind(prompt, { model: 'gemma4:e4b' }).think).toBe(true)
    const role: Role = { mind: { temperature: 0.6, think: true }, profiles: [{ models: ['gemma4:*'], mind: { temperature: 0.4 } }] }
    expect(roleMind(role, { model: 'gemma4:e4b' })).toEqual({ temperature: 0.4, think: true })
    expect(roleMind(role, { model: 'llama3.2:3b' })).toEqual({ temperature: 0.6, think: true })
  })
})

describe('profili (D28, D29)', () => {
  it('vince il più specifico', () => {
    expect(pickProfile(prompt, 'gemma4:12b')).toMatchObject({ profile: { models: ['gemma4:*'] }, verified: true })
    expect(pickProfile(prompt, 'gemma4:e4b')).toMatchObject({ profile: { models: ['gemma4:e4b'] }, verified: false })
    expect(pickProfile(prompt, 'GEMMA4:E4B').profile?.models).toEqual(['gemma4:e4b'])
    expect(pickProfile(prompt, 'qwen3:8b').profile?.context?.order).toBe('A')
  })

  it('modello senza profilo: nessun profilo, non verificato', () => {
    expect(pickProfile(prompt, 'mistral:7b')).toEqual({ profile: null, verified: false })
    expect(pickProfile(prompt, 'gemma4')).toEqual({ profile: null, verified: false })
    expect(pickProfile(prompt, null)).toEqual({ profile: null, verified: false })
    expect(pickProfile(GENERALIST_ROLE, 'gemma4:e4b')).toEqual({ profile: null, verified: false })
  })

  it('senza profilo la composizione è quella di oggi', () => {
    const forced: ContextSettings = { ...DEFAULT_CONTEXT_SETTINGS, order: 'B', reminder: 'on' }
    for (const settings of [DEFAULT_CONTEXT_SETTINGS, forced, null]) expect(roleContext(settings, null)).toEqual(resolveContext(settings))
    expect(roleContext(DEFAULT_CONTEXT_SETTINGS)).toEqual({ order: 'A', reminder: false, shares: DEFAULT_CONTEXT_SETTINGS.shares })
  })

  it('«Automatico» lascia decidere il profilo', () => {
    const { profile } = pickProfile(prompt, 'gemma4:12b')
    expect(roleContext(DEFAULT_CONTEXT_SETTINGS, profile)).toEqual({ order: 'B', reminder: true, shares: { behavior: 0.25, examples: 0.25, documents: 0.5 } })
  })

  it('una scelta esplicita nelle Impostazioni vince sul profilo', () => {
    const { profile } = pickProfile(prompt, 'gemma4:12b')
    const shares = { behavior: 0.1, examples: 0.1, documents: 0.8 }
    expect(roleContext({ ...DEFAULT_CONTEXT_SETTINGS, order: 'A', reminder: 'off', shares }, profile)).toEqual({ order: 'A', reminder: false, shares })
    // Con l'ordine C il promemoria non si applica, chiunque lo chieda.
    expect(roleContext({ ...DEFAULT_CONTEXT_SETTINGS, order: 'C' }, profile).reminder).toBe(false)
  })
})

describe('il ruolo nel prompt (passo 2.3)', () => {
  it('istruzioni, poi la situazione con il suo titolo, poi lo stile', () => {
    const p = rolePrompt(assistente, { roleParams: { formato: 'breve' }, situation: '  Uso la versione 0.1.22  ', style: 'essential' })
    expect(p.instructions).toBe(roleInstructions(assistente, { formato: 'breve' }))
    expect(p.situation).toBe('# Situazione\nUso la versione 0.1.22')
    expect(p.system).toMatch(new RegExp(`^${p.instructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n\n# Situazione\nUso la versione 0\\.1\\.22\n\n# Stile della risposta\nRispondi nel modo più breve possibile`))
    // Senza situazione non resta un titolo vuoto.
    expect(rolePrompt(assistente, { roleParams: null, situation: ' ' })).toMatchObject({ situation: '', system: roleInstructions(assistente) })
  })

  it('Generalista: la situazione senza titolo; una riga non convertita vale il suo Brief', () => {
    expect(rolePrompt(GENERALIST_ROLE, { roleParams: null, situation: 'Contesto mio' })).toEqual({ instructions: '', situation: 'Contesto mio', system: 'Contesto mio' })
    expect(rolePrompt(GENERALIST_ROLE, { roleParams: null, situation: '' }).system).toBe('')
    const brief = { role: 'Sei un tutor', context: '', goals: 'Spiegare', constraints: '' }
    expect(rolePrompt(GENERALIST_ROLE, { roleParams: null, situation: null, ...brief, style: 'concise' }).system).toBe(buildSystemPrompt(brief, 'concise'))
    // Una volta convertita, il Brief non conta più.
    expect(rolePrompt(GENERALIST_ROLE, { roleParams: null, situation: 'Altro', ...brief }).system).toBe('Altro')
  })

  it('promemoria: il campo del ruolo, o la prima frase delle istruzioni', () => {
    expect(roleReminderText(assistente)).toBe("Sei l'assistente di FastChat.")
    expect(roleReminderText({ ...assistente, reminder: '  Assistente di FastChat: solo uso dell\'app  ' })).toBe("Assistente di FastChat: solo uso dell'app")
    expect(roleReminderText({ instructions: 'Sei un tutor paziente\nSpiega con esempi.' })).toBe('Sei un tutor paziente')
    expect(roleReminderText({ instructions: 'Usa la versione 0.1.22 dell\'app. Poi rispondi.' })).toBe("Usa la versione 0.1.22 dell'app.")
    expect(roleReminderText(GENERALIST_ROLE)).toBe('')
  })

  it('limite della situazione: una quota della memoria, in caratteri (D21)', () => {
    expect(situationLimit(8192)).toBe(1638)
    expect(situationLimit(8192, 0.05, 4)).toBe(1638)
    expect(situationLimit(4096, 0.1, 3.5)).toBe(1433)
    expect(situationLimit(0)).toBe(0)
  })

  it('indicatore del contesto: istruzioni e situazione sono voci distinte', () => {
    const base = { brief: { role: 'Vecchio', context: '', goals: '', constraints: '' }, messages: [], numCtx: 4096 }
    expect(computeContextUsage({ ...base, instructions: 'Sei un tutor.', situation: 'Lezione' }).parts.map((p) => p.key)).toEqual(['instructions', 'situation'])
    expect(computeContextUsage({ ...base, situation: 'Lezione' }).parts.map((p) => p.key)).toEqual(['situation'])
    // Senza situazione (riga non convertita) si stima dal Brief, come prima.
    expect(computeContextUsage(base).parts.map((p) => p.key)).toEqual(['instructions'])
  })
})
