// Store: il catalogo di ciò che si può installare (basi di conoscenza, ruoli, plugin, pacchetti che ne
// riuniscono più d'uno) e lo stato di ogni voce rispetto a ciò che l'app ha già. Funzioni pure, condivise tra
// main (legge il catalogo, installa) e renderer (mostra).
import type { Locale } from './i18n'
import type { KnowledgeBase, RoleRecord } from './types'

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
  /** Lega le varianti della stessa voce in lingue diverse: nello Store sono una scheda sola. */
  group?: string
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
 * - soon: nel catalogo, ma l'app non sa ancora installarla (plugin) o il file non c'è.
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
 * Lo stato di ogni voce. `installed` dice quale versione di ogni pacchetto è installata (per id): basi e ruoli.
 * Si installano le basi di conoscenza e i ruoli; un pacchetto è installabile se contiene almeno una voce
 * installabile, e risulta installato quando lo sono tutte.
 */
const INSTALLABLE: StoreItemType[] = ['knowledge', 'identity']

export function storeEntries(catalog: StoreCatalog, installed: ReadonlyMap<string, string | null>): StoreEntry[] {
  const byId = new Map(catalog.items.map((i) => [i.id, i]))
  const single = (item: StoreItem): StoreState => {
    if (!INSTALLABLE.includes(item.type)) return 'soon'
    if (installed.has(item.id)) {
      const have = installed.get(item.id)
      return item.builtin || !have || compareVersions(item.version, have) <= 0 ? 'installed' : item.file ? 'update' : 'installed'
    }
    return item.file ? 'available' : 'soon'
  }
  return catalog.items.map((item) => {
    let state = single(item)
    if (item.type === 'bundle') {
      const parts = (item.contains ?? []).map((id) => byId.get(id)).filter((x): x is StoreItem => !!x && INSTALLABLE.includes(x.type))
      const states = parts.map(single)
      state = parts.length === 0 || states.every((s) => s === 'soon') ? 'soon' : states.every((s) => s === 'installed') ? 'installed' : states.some((s) => s === 'available') ? 'available' : 'update'
    }
    return { ...item, state, installedVersion: installed.get(item.id) ?? null, removable: INSTALLABLE.includes(item.type) && installed.has(item.id) && !item.builtin }
  })
}

/** Una base gestita dallo Store: installata da lì o integrata nell'app. Si aggiorna e si rimuove solo dallo Store. */
export const isStoreBase = (base: Pick<KnowledgeBase, 'origin' | 'meta'>): boolean => base.origin === 'package' && (base.meta?.store === true || base.meta?.trust === 'builtin')

/** Un ruolo gestito dallo Store: installato da lì o integrato nell'app. */
export const isStoreRole = (role: Pick<RoleRecord, 'origin' | 'meta'>): boolean => role.origin === 'builtin' || role.meta?.store === true

// ---------------------------------------------------------------- varianti per lingua, ricerca, filtro

/** Una scheda dello Store: una voce, o le varianti della stessa voce in lingue diverse. */
export interface StoreGroup {
  /** Il gruppo dichiarato dalle voci, o l'id di una voce senza varianti. */
  key: string
  /** Tutte le varianti, nell'ordine del catalogo. */
  variants: StoreEntry[]
  /** La variante da mostrare all'apertura. */
  preferred: StoreEntry
  /** Varianti in cui la ricerca ha trovato il testo (tutte, se non si sta cercando). */
  matched: StoreEntry[]
}

export interface StoreFilter {
  type: StoreItemType
  /** Testo cercato in titolo, descrizione e autore di tutte le varianti, in tutte le lingue. */
  query?: string
  /** Solo le voci disponibili in questa lingua; assente o '' = tutte. */
  language?: string | null
  /** Lingua dell'interfaccia: la variante preselezionata, se c'è. */
  locale: Locale
}

const texts = (value: Localized | undefined): string[] => (!value ? [] : typeof value === 'string' ? [value] : Object.values(value).filter((v): v is string => typeof v === 'string'))

/** Il testo cercato compare in questa voce? Si guarda in tutte le lingue in cui titolo e descrizione sono scritti. */
export function matchesQuery(item: StoreItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [...texts(item.name), ...texts(item.summary), item.author ?? ''].some((text) => text.toLowerCase().includes(needle))
}

/** Lingue dei contenuti di una categoria, per il filtro: nell'ordine in cui compaiono nel catalogo. */
export function storeLanguages(items: ReadonlyArray<StoreItem>, type: StoreItemType): string[] {
  return [...new Set(items.filter((i) => i.type === type && i.language).map((i) => i.language!.toLowerCase()))]
}

/**
 * Le schede di una categoria (D33): una per gruppo, con le varianti per lingua. La ricerca guarda tutte le
 * varianti (cercando «prompts» si trova anche il ruolo scritto in italiano, se la variante francese lo contiene);
 * il filtro tiene i gruppi che hanno la lingua scelta. Preselezionata: la lingua del filtro, poi una variante
 * già installata, poi quella dell'interfaccia, poi la prima.
 */
export function storeGroups(items: ReadonlyArray<StoreEntry>, filter: StoreFilter): StoreGroup[] {
  const language = filter.language?.toLowerCase() || null
  const groups = new Map<string, StoreEntry[]>()
  for (const item of items) {
    if (item.type !== filter.type) continue
    const key = item.group ?? item.id
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const out: StoreGroup[] = []
  for (const [key, variants] of groups) {
    const inLanguage = language ? variants.filter((v) => v.language?.toLowerCase() === language) : variants
    if (inLanguage.length === 0) continue
    const matched = variants.filter((v) => matchesQuery(v, filter.query ?? ''))
    if (matched.length === 0) continue
    const installed = (v: StoreEntry): boolean => v.state === 'installed' || v.state === 'update'
    const preferred =
      (language ? inLanguage[0] : undefined) ??
      variants.find(installed) ??
      variants.find((v) => v.language?.toLowerCase() === filter.locale) ??
      variants[0]
    out.push({ key, variants, preferred, matched })
  }
  return out
}
