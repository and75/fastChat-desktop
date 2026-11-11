// Store: il catalogo di ciò che si può installare (basi di conoscenza, identità, plugin, pacchetti che ne
// riuniscono più d'uno) e lo stato di ogni voce rispetto a ciò che l'app ha già. Funzioni pure, condivise tra
// main (legge il catalogo, installa) e renderer (mostra).
import type { Locale } from './i18n'

export type StoreItemType = 'identity' | 'knowledge' | 'plugin' | 'bundle'
/** Le categorie dello store, nell'ordine in cui si mostrano. */
export const STORE_CATEGORIES: StoreItemType[] = ['identity', 'knowledge', 'plugin', 'bundle']

/** Un testo del catalogo: uguale per tutti, oppure per lingua dell'interfaccia. */
export type Localized = string | Partial<Record<Locale, string>>

/** Una voce del catalogo, come la pubblica il repository. */
export interface StoreItem {
  id: string
  type: StoreItemType
  name: Localized
  summary: Localized
  version: string
  author?: string
  /** Lingua del contenuto. */
  language?: string
  price?: number
  /** Dimensione del file, in byte. */
  size?: number
  /** Modello di embedding con cui sono calcolati i vettori (basi); assente = solo testo. */
  embedding?: { model: string; dimensions: number } | null
  /** Modello di chat consigliato o richiesto (identità). */
  model?: { name: string; required?: boolean }
  /** Voci che devono essere installate insieme a questa. */
  requires?: string[]
  /** Voci contenute (pacchetti). */
  contains?: string[]
  /** Percorso del file nel repository e sua impronta SHA-256; assente = non ancora disponibile. */
  file?: string
  sha256?: string
  /** Integrata nell'app: già installata, non si rimuove. */
  builtin?: boolean
}

export interface StoreCatalog {
  version: number
  updatedAt: string
  items: StoreItem[]
}

/**
 * - installed: c'è, alla versione del catalogo (o più nuova);
 * - update: c'è, ma il catalogo ne ha una più recente;
 * - available: si può installare ora;
 * - soon: nel catalogo, ma l'app non sa ancora installarla (identità, plugin) o il file non c'è.
 */
export type StoreState = 'installed' | 'update' | 'available' | 'soon'

/** Una voce con il suo stato su questa installazione. */
export interface StoreEntry extends StoreItem {
  state: StoreState
  installedVersion: string | null
  /** Si può togliere da qui (installata e non integrata). */
  removable: boolean
}

/** Il catalogo come lo riceve il renderer. */
export interface StoreView {
  /** Da dove viene: il repository configurato, o il catalogo incluso nell'app. */
  source: 'remote' | 'local'
  url: string
  /** Perché si sta mostrando il catalogo locale pur avendo un repository configurato. */
  error: string | null
  updatedAt: string
  items: StoreEntry[]
}

/** Il testo nella lingua dell'interfaccia; se manca, italiano, inglese, poi la prima disponibile. */
export function localize(value: Localized | undefined | null, locale: Locale): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value[locale] ?? value.it ?? value.en ?? Object.values(value)[0] ?? ''
}

/** Confronto di versioni «1.2.3» (la parte dopo «+» non conta): negativo se a < b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('+')[0].split('.').map((x) => parseInt(x, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  // Stessa versione numerica ma contenuto diverso (impronta dopo «+»): vale come aggiornamento.
  return a === b ? 0 : (a.split('+')[1] ?? '') === (b.split('+')[1] ?? '') ? 0 : 1
}

/** Il catalogo è ben formato? Scarta ciò che non lo è, senza far fallire tutto per una voce sbagliata. */
export function parseCatalog(raw: unknown): StoreCatalog {
  const c = raw as Partial<StoreCatalog> | null
  if (!c || typeof c !== 'object' || !Array.isArray(c.items)) throw new Error('catalog')
  const text = (v: unknown): boolean => typeof v === 'string' || (!!v && typeof v === 'object')
  const items = c.items.filter(
    (i): i is StoreItem =>
      !!i && typeof i.id === 'string' && /^[a-z0-9][a-z0-9._-]{2,80}$/.test(i.id) && STORE_CATEGORIES.includes(i.type) && text(i.name) && typeof i.version === 'string'
  )
  return { version: Number(c.version) || 1, updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '', items }
}

/**
 * Lo stato di ogni voce. `installed` dice quale versione di ogni pacchetto è installata (per id).
 * Oggi si installano le basi di conoscenza; un pacchetto è installabile se contiene almeno una base
 * installabile, e risulta installato quando lo sono tutte le sue basi.
 */
export function storeEntries(catalog: StoreCatalog, installed: ReadonlyMap<string, string | null>): StoreEntry[] {
  const byId = new Map(catalog.items.map((i) => [i.id, i]))
  const single = (item: StoreItem): StoreState => {
    if (item.type !== 'knowledge') return 'soon'
    if (installed.has(item.id)) {
      const have = installed.get(item.id)
      return item.builtin || !have || compareVersions(item.version, have) <= 0 ? 'installed' : item.file ? 'update' : 'installed'
    }
    return item.file ? 'available' : 'soon'
  }
  return catalog.items.map((item) => {
    let state = single(item)
    if (item.type === 'bundle') {
      const parts = (item.contains ?? []).map((id) => byId.get(id)).filter((x): x is StoreItem => !!x && x.type === 'knowledge')
      const states = parts.map(single)
      state = parts.length === 0 || states.every((s) => s === 'soon') ? 'soon' : states.every((s) => s === 'installed') ? 'installed' : states.some((s) => s === 'available') ? 'available' : 'update'
    }
    return { ...item, state, installedVersion: installed.get(item.id) ?? null, removable: item.type === 'knowledge' && installed.has(item.id) && !item.builtin }
  })
}
