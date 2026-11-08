// Lingue dell'interfaccia. Dizionari tipizzati: `it` è il riferimento, le altre lingue devono avere le stesse
// chiavi (lo controlla TypeScript). Lo stesso modulo serve main (errori, prompt) e renderer (interfaccia).
import { en } from './en'
import { it, type Key } from './it'

export type { Key }
export type Locale = 'it' | 'en'
/** Scelta dell'utente: automatica (lingua del sistema) o una lingua precisa. */
export type LanguageSetting = 'auto' | Locale

export const LOCALES: Locale[] = ['it', 'en']
export const LANGUAGE_SETTINGS: LanguageSetting[] = ['auto', 'it', 'en']

const DICTS: Record<Locale, Record<Key, string>> = { it, en }
/** Tag BCP 47 per Intl (numeri, date, plurali). */
const TAGS: Record<Locale, string> = { it: 'it-IT', en: 'en-US' }

let current: Locale = 'it'
const listeners = new Set<() => void>()

export const getLocale = (): Locale => current
export const localeTag = (): string => TAGS[current]

export function setLocale(locale: Locale): void {
  if (locale === current) return
  current = locale
  for (const fn of listeners) fn()
}

/** Notifica a ogni cambio di lingua (per il renderer: useSyncExternalStore). */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Lingua effettiva: quella scelta, o dalla lingua del sistema (italiano se è italiano, altrimenti inglese). */
export function resolveLocale(setting: LanguageSetting | null | undefined, systemLocale: string | null | undefined): Locale {
  if (setting && setting !== 'auto') return setting
  return (systemLocale ?? '').toLowerCase().startsWith('it') ? 'it' : 'en'
}

type Params = Record<string, string | number>

function fill(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

/** Testo nella lingua attiva, con i segnaposto `{nome}` sostituiti. */
export function t(key: Key, params?: Params): string {
  return fill(DICTS[current][key] ?? it[key] ?? key, params)
}

/** Chiavi con varianti di plurale: `chiave_one` e `chiave_other`. */
type PluralOf<K> = K extends `${infer Base}_other` ? Base : never
export type PluralKey = PluralOf<Key>

/** Testo al singolare o al plurale secondo `count` (disponibile anche come `{count}`). */
export function tn(key: PluralKey, count: number, params?: Params): string {
  const form = new Intl.PluralRules(TAGS[current]).select(count) === 'one' ? 'one' : 'other'
  return t(`${key}_${form}` as Key, { count: count.toLocaleString(TAGS[current]), ...params })
}

/** Numero con il separatore delle migliaia anche a 4 cifre (4.096 / 4,096). */
export const fmtInt = (n: number): string => Math.round(n).toLocaleString(TAGS[current], { useGrouping: 'always' } as Intl.NumberFormatOptions)
/** Numero con decimali nella lingua attiva. */
export const fmtNum = (n: number, digits = 1, minDigits = 0): string =>
  n.toLocaleString(TAGS[current], { minimumFractionDigits: minDigits, maximumFractionDigits: digits })
/** Ora HH:MM. */
export const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString(TAGS[current], { hour: '2-digit', minute: '2-digit' })
