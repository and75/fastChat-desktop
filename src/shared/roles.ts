// Il ruolo come dato (docs/ruoli.md §3, docs/ruoli-piano.md passo 2.1). Funzioni pure, senza dipendenze dal main:
// validazione della definizione, istruzioni dalle scelte, calcolo della mente, profilo per il modello in uso.
// Qui un «ruolo» è il contenuto di `role.json`; nome, lingua e gruppo stanno nel manifesto del pacchetto.
import { reminderApplies, CONTEXT_ORDERS } from './compose'
import { BASE_PURPOSES, DEFAULT_CONTEXT_SETTINGS, RESPONSE_STYLES, type BasePurpose, type ContextOrder, type ContextSettings, type ResponseStyle } from './types'

// ---------------------------------------------------------------- tipi

/** Le quattro sezioni fisse dei parametri, nell'ordine in cui le frasi entrano nelle istruzioni. */
export type RoleSection = 'identity' | 'style' | 'rules' | 'method'
export const ROLE_SECTIONS: RoleSection[] = ['identity', 'style', 'rules', 'method']

export type RoleParameterType = 'single' | 'multi' | 'toggle'
export const ROLE_PARAMETER_TYPES: RoleParameterType[] = ['single', 'multi', 'toggle']

/** Impostazioni del modello che un'opzione può modificare. Le basi e il modello non sono tra queste (D15). */
export interface RoleMindSettings {
  temperature?: number
  topP?: number
  think?: boolean
  planMode?: boolean
  /** Stile (lunghezza) della risposta. */
  style?: ResponseStyle
  numCtx?: number
}
export type RoleMindKey = keyof RoleMindSettings
export const ROLE_MIND_KEYS: RoleMindKey[] = ['temperature', 'topP', 'think', 'planMode', 'style', 'numCtx']

/** Valori che un profilo può sostituire: le impostazioni, più il valore di partenza della pill dei documenti. */
export interface RoleProfileMind extends RoleMindSettings {
  knowledge?: boolean
}

/** Mente di partenza del ruolo: tutto ciò che può sostituire un profilo, più il modello consigliato. */
export interface RoleMind extends RoleProfileMind {
  model?: string
}

export interface RoleOption {
  id: string
  label: string
  /** Frase che entra nelle istruzioni quando l'opzione è scelta. Può mancare (es. lo stato spento di un sì/no). */
  instruction?: string
  mind?: RoleMindSettings
}

export interface RoleParameter {
  id: string
  section: RoleSection
  /** Etichetta facoltativa del tipo di vincolo (pubblico, formato, tono…): non crea intestazioni. */
  kind?: string
  label: string
  type: RoleParameterType
  options: RoleOption[]
  /** Opzione preselezionata; un elenco per la scelta multipla (anche vuoto o assente). */
  default?: string | string[]
}

export interface RoleBase {
  id: string
  purpose: BasePurpose
}

export interface RoleProfileContext {
  order?: ContextOrder
  reminder?: boolean
  shares?: ContextSettings['shares']
}

export interface RoleProfile {
  /** Nomi o famiglie di modelli: `gemma4:e4b`, `gemma4:*`. */
  models: string[]
  verified?: boolean
  mind?: RoleProfileMind
  context?: RoleProfileContext
}

export interface Role {
  /** Testo fisso del ruolo. Vuoto per il Generalista. */
  instructions?: string
  /** Riga breve da ripetere accanto alla domanda (promemoria). */
  reminder?: string
  mind?: RoleMind
  parameters?: RoleParameter[]
  bases?: RoleBase[]
  profiles?: RoleProfile[]
}

/** Scelte dell'utente: id del parametro → id dell'opzione (o elenco, per la scelta multipla). */
export type RoleChoices = Record<string, string | string[]>

/** Il Generalista: nessuna istruzione, nessun parametro, nessuna base. È l'app senza ruoli. */
export const GENERALIST_ROLE: Role = {}

// ---------------------------------------------------------------- validazione

/** Un difetto della definizione: codice stabile e punto del ruolo in cui si trova. */
export interface RoleIssue {
  code:
    | 'role.shape'
    | 'instructions.type'
    | 'reminder.type'
    | 'mind.key'
    | 'mind.value'
    | 'parameter.shape'
    | 'parameter.id'
    | 'parameter.duplicate'
    | 'parameter.section'
    | 'parameter.type'
    | 'parameter.label'
    | 'option.none'
    | 'option.shape'
    | 'option.id'
    | 'option.duplicate'
    | 'option.label'
    | 'option.instruction'
    | 'toggle.options'
    | 'default.missing'
    | 'default.unknown'
    | 'default.type'
    | 'mind.conflict'
    | 'mind.multi'
    | 'mind.styleTemperature'
    | 'base.shape'
    | 'base.duplicate'
    | 'base.purpose'
    | 'profile.shape'
    | 'profile.models'
    | 'profile.duplicate'
    | 'profile.order'
    | 'profile.reminder'
    | 'profile.shares'
  at: string
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const MIND_CHECKS: Record<RoleMindKey | 'knowledge' | 'model', (v: unknown) => boolean> = {
  temperature: (v) => isNumber(v) && v >= 0 && v <= 2,
  topP: (v) => isNumber(v) && v > 0 && v <= 1,
  think: (v) => typeof v === 'boolean',
  planMode: (v) => typeof v === 'boolean',
  style: (v) => RESPONSE_STYLES.includes(v as ResponseStyle),
  numCtx: (v) => isNumber(v) && Number.isInteger(v) && v > 0,
  knowledge: (v) => typeof v === 'boolean',
  model: isText
}

function checkMind(raw: unknown, allowed: ReadonlyArray<string>, at: string, issues: RoleIssue[]): void {
  if (raw === undefined) return
  if (!isObject(raw)) {
    issues.push({ code: 'mind.value', at })
    return
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) issues.push({ code: 'mind.key', at: `${at}.${key}` })
    else if (!MIND_CHECKS[key as keyof typeof MIND_CHECKS](value)) issues.push({ code: 'mind.value', at: `${at}.${key}` })
  }
}

const mindKeysOf = (option: unknown): RoleMindKey[] =>
  isObject(option) && isObject(option.mind) ? ROLE_MIND_KEYS.filter((key) => (option.mind as Record<string, unknown>)[key] !== undefined) : []

const validShares = (raw: unknown): boolean => {
  if (!isObject(raw)) return false
  const values = [raw.behavior, raw.examples, raw.documents]
  return values.every((v) => isNumber(v) && v >= 0 && v <= 1) && Math.abs((values as number[]).reduce((a, b) => a + b, 0) - 1) < 0.005
}

/** Un nome di modello o una famiglia con «*»: niente spazi, almeno un carattere che non sia l'asterisco. */
const validPattern = (v: unknown): v is string => isText(v) && !/\s/.test(v) && v.replace(/\*/g, '').length > 0

/**
 * Controlla una definizione di ruolo letta da un pacchetto. Elenco vuoto = ruolo valido.
 * Regole: sezioni e tipi ammessi, id unici, predefiniti coerenti, al massimo un parametro per impostazione della
 * mente (D12), lunghezza della risposta e temperatura mai governate dallo stesso parametro (D37).
 */
export function validateRole(raw: unknown): RoleIssue[] {
  const issues: RoleIssue[] = []
  if (!isObject(raw)) return [{ code: 'role.shape', at: 'role' }]

  if (raw.instructions !== undefined && typeof raw.instructions !== 'string') issues.push({ code: 'instructions.type', at: 'instructions' })
  if (raw.reminder !== undefined && typeof raw.reminder !== 'string') issues.push({ code: 'reminder.type', at: 'reminder' })
  checkMind(raw.mind, [...ROLE_MIND_KEYS, 'knowledge', 'model'], 'mind', issues)

  // Parametri
  const parameters = raw.parameters === undefined ? [] : raw.parameters
  if (!Array.isArray(parameters)) issues.push({ code: 'parameter.shape', at: 'parameters' })
  const seenParams = new Set<string>()
  /** Impostazione della mente → parametri che la toccano. */
  const owners = new Map<RoleMindKey, string[]>()
  for (const [index, p] of (Array.isArray(parameters) ? parameters : []).entries()) {
    const at = `parameters[${isObject(p) && isText(p.id) ? p.id : index}]`
    if (!isObject(p)) {
      issues.push({ code: 'parameter.shape', at })
      continue
    }
    if (!isText(p.id)) issues.push({ code: 'parameter.id', at })
    else if (seenParams.has(p.id)) issues.push({ code: 'parameter.duplicate', at })
    else seenParams.add(p.id)
    if (!ROLE_SECTIONS.includes(p.section as RoleSection)) issues.push({ code: 'parameter.section', at })
    if (!isText(p.label)) issues.push({ code: 'parameter.label', at })
    const typeOk = ROLE_PARAMETER_TYPES.includes(p.type as RoleParameterType)
    if (!typeOk) issues.push({ code: 'parameter.type', at })

    // Opzioni
    const options = Array.isArray(p.options) ? p.options : []
    if (options.length === 0) issues.push({ code: 'option.none', at })
    const ids = new Set<string>()
    for (const [i, o] of options.entries()) {
      const oat = `${at}.options[${isObject(o) && isText(o.id) ? o.id : i}]`
      if (!isObject(o)) {
        issues.push({ code: 'option.shape', at: oat })
        continue
      }
      if (!isText(o.id)) issues.push({ code: 'option.id', at: oat })
      else if (ids.has(o.id)) issues.push({ code: 'option.duplicate', at: oat })
      else ids.add(o.id)
      if (!isText(o.label)) issues.push({ code: 'option.label', at: oat })
      if (o.instruction !== undefined && typeof o.instruction !== 'string') issues.push({ code: 'option.instruction', at: oat })
      checkMind(o.mind, ROLE_MIND_KEYS, `${oat}.mind`, issues)
    }
    if (p.type === 'toggle' && !(ids.size === 2 && ids.has('on') && ids.has('off') && options.length === 2)) issues.push({ code: 'toggle.options', at })

    // Predefinito
    if (typeOk && p.type === 'multi') {
      if (p.default !== undefined && !(Array.isArray(p.default) && p.default.every((d) => typeof d === 'string'))) issues.push({ code: 'default.type', at })
      else if (Array.isArray(p.default) && (p.default.some((d) => !ids.has(d)) || new Set(p.default).size !== p.default.length)) issues.push({ code: 'default.unknown', at })
    } else if (typeOk) {
      if (p.default === undefined) issues.push({ code: 'default.missing', at })
      else if (typeof p.default !== 'string') issues.push({ code: 'default.type', at })
      else if (!ids.has(p.default)) issues.push({ code: 'default.unknown', at })
    }

    // Mente: chi tocca cosa
    const touched = new Set<RoleMindKey>()
    for (const key of ROLE_MIND_KEYS) {
      const count = options.filter((o) => mindKeysOf(o).includes(key)).length
      if (count === 0) continue
      touched.add(key)
      // In una scelta multipla più opzioni possono essere attive insieme: una sola può toccare l'impostazione.
      if (p.type === 'multi' && count > 1) issues.push({ code: 'mind.multi', at: `${at}.${key}` })
      owners.set(key, [...(owners.get(key) ?? []), at])
    }
    // D37: la temperatura resta indipendente dalla lunghezza della risposta.
    if (touched.has('style') && touched.has('temperature')) issues.push({ code: 'mind.styleTemperature', at })
  }
  for (const [key, list] of owners) for (const at of list.slice(1)) issues.push({ code: 'mind.conflict', at: `${at}.${key}` })

  // Basi
  const bases = raw.bases === undefined ? [] : raw.bases
  if (!Array.isArray(bases)) issues.push({ code: 'base.shape', at: 'bases' })
  const seenBases = new Set<string>()
  for (const [index, b] of (Array.isArray(bases) ? bases : []).entries()) {
    const at = `bases[${index}]`
    if (!isObject(b) || !isText(b.id)) {
      issues.push({ code: 'base.shape', at })
      continue
    }
    if (seenBases.has(b.id)) issues.push({ code: 'base.duplicate', at })
    seenBases.add(b.id)
    if (!BASE_PURPOSES.includes(b.purpose as BasePurpose)) issues.push({ code: 'base.purpose', at })
  }

  // Profili
  const profiles = raw.profiles === undefined ? [] : raw.profiles
  if (!Array.isArray(profiles)) issues.push({ code: 'profile.shape', at: 'profiles' })
  const seenModels = new Set<string>()
  for (const [index, pr] of (Array.isArray(profiles) ? profiles : []).entries()) {
    const at = `profiles[${index}]`
    if (!isObject(pr)) {
      issues.push({ code: 'profile.shape', at })
      continue
    }
    if (!Array.isArray(pr.models) || pr.models.length === 0 || !pr.models.every(validPattern)) issues.push({ code: 'profile.models', at })
    else
      for (const m of pr.models as string[]) {
        const key = m.toLowerCase()
        if (seenModels.has(key)) issues.push({ code: 'profile.duplicate', at: `${at}.${m}` })
        seenModels.add(key)
      }
    if (pr.verified !== undefined && typeof pr.verified !== 'boolean') issues.push({ code: 'profile.shape', at })
    checkMind(pr.mind, [...ROLE_MIND_KEYS, 'knowledge'], `${at}.mind`, issues)
    if (pr.context !== undefined) {
      if (!isObject(pr.context)) issues.push({ code: 'profile.shape', at })
      else {
        if (pr.context.order !== undefined && !CONTEXT_ORDERS.includes(pr.context.order as ContextOrder)) issues.push({ code: 'profile.order', at })
        if (pr.context.reminder !== undefined && typeof pr.context.reminder !== 'boolean') issues.push({ code: 'profile.reminder', at })
        if (pr.context.shares !== undefined && !validShares(pr.context.shares)) issues.push({ code: 'profile.shares', at })
      }
    }
  }
  return issues
}

/** Restituisce il ruolo tipizzato, o lancia con l'elenco dei difetti (per chi installa o costruisce un pacchetto). */
export function parseRole(raw: unknown): Role {
  const issues = validateRole(raw)
  if (issues.length > 0) throw new Error(`Ruolo non valido: ${issues.map((i) => `${i.code} (${i.at})`).join(', ')}`)
  return raw as Role
}

// ---------------------------------------------------------------- scelte

const parametersOf = (role: Role): RoleParameter[] => role.parameters ?? []

/** Parametri nell'ordine delle sezioni; dentro la sezione, nell'ordine della definizione. */
export function orderedParameters(role: Role): RoleParameter[] {
  return ROLE_SECTIONS.flatMap((section) => parametersOf(role).filter((p) => p.section === section))
}

/**
 * Scelte complete e valide: ciò che manca prende il predefinito, ciò che non esiste più nel ruolo si scarta.
 * Serve quando il ruolo viene aggiornato dopo che la conversazione ha salvato le sue scelte.
 */
export function resolveChoices(role: Role, choices?: RoleChoices | null): RoleChoices {
  const out: RoleChoices = {}
  for (const p of parametersOf(role)) {
    const ids = p.options.map((o) => o.id)
    const chosen = choices?.[p.id]
    if (p.type === 'multi') {
      const list = Array.isArray(chosen) ? chosen : Array.isArray(p.default) ? p.default : []
      out[p.id] = ids.filter((id) => list.includes(id))
    } else {
      out[p.id] = typeof chosen === 'string' && ids.includes(chosen) ? chosen : (p.default as string)
    }
  }
  return out
}

/** Le opzioni attive di un parametro, nell'ordine della definizione. */
function activeOptions(parameter: RoleParameter, resolved: RoleChoices): RoleOption[] {
  const chosen = resolved[parameter.id]
  return parameter.options.filter((o) => (Array.isArray(chosen) ? chosen.includes(o.id) : chosen === o.id))
}

// ---------------------------------------------------------------- istruzioni

/**
 * Istruzioni del ruolo: testo fisso, poi una riga per ogni opzione scelta, nell'ordine delle sezioni e dei
 * parametri. '' per il Generalista.
 */
export function roleInstructions(role: Role, choices?: RoleChoices | null): string {
  const resolved = resolveChoices(role, choices)
  const phrases = orderedParameters(role).flatMap((p) => activeOptions(p, resolved).map((o) => o.instruction ?? ''))
  return [role.instructions ?? '', ...phrases]
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------- profili

const specificity = (pattern: string): number => (pattern.includes('*') ? pattern.replace(/\*/g, '').length : Number.MAX_SAFE_INTEGER)

function matches(pattern: string, model: string): boolean {
  const source = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(model.toLowerCase())
}

/**
 * Profilo del ruolo per il modello in uso: vince il più specifico (`gemma4:e4b` su `gemma4:*`), a parità il primo.
 * `verified` è falso anche quando non c'è alcun profilo: l'interfaccia mostra «non verificato con questo modello».
 */
export function pickProfile(role: Role, model: string | null | undefined): { profile: RoleProfile | null; verified: boolean } {
  let best: { profile: RoleProfile; score: number } | null = null
  if (model)
    for (const profile of role.profiles ?? [])
      for (const pattern of profile.models) {
        if (!matches(pattern, model)) continue
        const score = specificity(pattern)
        if (!best || score > best.score) best = { profile, score }
      }
  return { profile: best?.profile ?? null, verified: best?.profile.verified === true }
}

// ---------------------------------------------------------------- mente

export interface RoleMindInput {
  choices?: RoleChoices | null
  /** Modello in uso, per il profilo. */
  model?: string | null
  /** Ritocchi manuali dell'utente. */
  overrides?: RoleProfileMind | null
}

const defined = <T extends object>(values: T | null | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(values ?? {}).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>

/**
 * Mente effettiva (D13): valori base del ruolo → profilo per il modello → opzioni scelte → ritocchi manuali.
 * Contiene solo ciò che il ruolo o l'utente fissano: ciò che manca resta al predefinito dell'app e del modello.
 */
export function roleMind(role: Role, input: RoleMindInput = {}): RoleMind {
  const resolved = resolveChoices(role, input.choices)
  const fromOptions: RoleMindSettings = {}
  for (const p of parametersOf(role)) for (const o of activeOptions(p, resolved)) Object.assign(fromOptions, defined(o.mind))
  return { ...defined(role.mind), ...defined(pickProfile(role, input.model).profile?.mind), ...fromOptions, ...defined(input.overrides) }
}

/** Le impostazioni della mente governate da un parametro (almeno una sua opzione le tocca). */
export function governedSettings(role: Role, parameterId: string): RoleMindKey[] {
  const parameter = parametersOf(role).find((p) => p.id === parameterId)
  return parameter ? ROLE_MIND_KEYS.filter((key) => parameter.options.some((o) => o.mind?.[key] !== undefined)) : []
}

/**
 * «Vince l'ultima azione»: quando l'utente cambia la scelta di un parametro, i ritocchi manuali sulle impostazioni
 * che quel parametro governa decadono. Gli altri restano.
 */
export function releaseOverrides<T extends RoleProfileMind>(role: Role, overrides: T | null | undefined, parameterId: string): T {
  const governed = governedSettings(role, parameterId) as string[]
  return Object.fromEntries(Object.entries(overrides ?? {}).filter(([key]) => !governed.includes(key))) as T
}

// ---------------------------------------------------------------- composizione del contesto

const sameShares = (a: ContextSettings['shares'], b: ContextSettings['shares']): boolean =>
  a.behavior === b.behavior && a.examples === b.examples && a.documents === b.documents

/**
 * Composizione effettiva per una chiamata (D29): scelta forzata nelle Impostazioni → profilo del ruolo per il
 * modello → predefiniti dell'app (ordine A, niente promemoria). Senza profilo il risultato è quello di
 * `resolveContext`. Le quote non hanno ancora il valore «Automatico»: valgono quelle del profilo finché nelle
 * Impostazioni restano le predefinite.
 */
export function roleContext(
  settings: ContextSettings | null | undefined,
  profile?: RoleProfile | null
): { order: ContextOrder; reminder: boolean; shares: ContextSettings['shares'] } {
  const s = settings ?? DEFAULT_CONTEXT_SETTINGS
  const ctx = profile?.context
  const order = s.order !== 'auto' ? s.order : (ctx?.order ?? 'A')
  const reminder = s.reminder !== 'auto' ? s.reminder === 'on' : ctx?.reminder === true
  const shares = ctx?.shares && sameShares(s.shares, DEFAULT_CONTEXT_SETTINGS.shares) ? ctx.shares : s.shares
  return { order, reminder: reminder && reminderApplies(order), shares }
}
