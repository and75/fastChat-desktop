// Store: legge il catalogo dal repository configurato (o, finché non esiste, da quello incluso nell'app),
// dice cosa è già installato, scarica e installa i pacchetti.
//
// API del repository (sola lettura):
//   GET {url}/catalog.json          il catalogo (vedi StoreCatalog)
//   GET {url}/{item.file}           il pacchetto (.fcpack) di una voce
// I pacchetti del repository devono avere una firma riconosciuta e l'impronta dichiarata nel catalogo; quelli
// del catalogo incluso nell'app sono fidati perché fanno parte dell'installazione.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import { parseCatalog, storeEntries, type StoreCatalog, type StoreItem, type StoreView } from '@shared/store'
import type { Knowledge } from './knowledge'
import { PACK_EXTENSION } from './knowledge/pack'

export interface StoreDeps {
  knowledge: Knowledge
  /** Indirizzo del repository; vuoto = catalogo locale. */
  getUrl(): Promise<string>
  /** Cartella del catalogo incluso nell'app (catalog.json e i file delle voci). */
  localDir: string
  /** Dove scrivere i pacchetti scaricati prima di installarli. */
  downloadsDir: string
  fetchImpl?: typeof fetch
}

const TIMEOUT_MS = 15_000

export function createStore({ knowledge, getUrl, localDir, downloadsDir, fetchImpl = fetch }: StoreDeps) {
  const base = (url: string): string => url.replace(/\/+$/, '')

  async function remote(url: string, path: string): Promise<Response> {
    const res = await fetchImpl(`${base(url)}/${path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }

  const localCatalog = async (): Promise<StoreCatalog> => parseCatalog(JSON.parse(await readFile(join(localDir, 'catalog.json'), 'utf8')))

  /** Il catalogo e da dove viene: se il repository configurato non risponde si mostra quello locale, dicendo perché. */
  async function load(): Promise<{ catalog: StoreCatalog; source: 'remote' | 'local'; url: string; error: string | null }> {
    const url = (await getUrl()).trim()
    if (!url) return { catalog: await localCatalog(), source: 'local', url: '', error: null }
    try {
      return { catalog: parseCatalog(await (await remote(url, 'catalog.json')).json()), source: 'remote', url, error: null }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { catalog: await localCatalog(), source: 'local', url, error: t('err.store.unreachable', { url, reason }) }
    }
  }

  async function catalog(): Promise<StoreView> {
    const { catalog, source, url, error } = await load()
    const installed = new Map([...(await knowledge.installedPacks())].map(([id, b]) => [id, b.version]))
    return { source, url, error, updatedAt: catalog.updatedAt, items: storeEntries(catalog, installed) }
  }

  /** Scarica (o legge) il pacchetto di una base, ne controlla l'impronta e lo installa. */
  async function installKnowledge(item: StoreItem, source: 'remote' | 'local', url: string): Promise<void> {
    if (!item.file) throw new Error(t('err.store.notAvailable'))
    const data = source === 'remote' ? Buffer.from(await (await remote(url, item.file)).arrayBuffer()) : await readFile(join(localDir, ...item.file.split('/')))
    if (item.sha256 && createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(t('err.store.checksum'))
    await mkdir(downloadsDir, { recursive: true })
    const path = join(downloadsDir, `${item.id}.${PACK_EXTENSION}`)
    await writeFile(path, data)
    // Dal repository: solo pacchetti con firma riconosciuta. Dal catalogo dell'app: fidati come l'app.
    await knowledge.installPack(path, source === 'local' ? { builtin: true } : {})
  }

  /** Installa (o aggiorna) una voce; di un pacchetto, le basi che contiene. */
  async function install(id: string): Promise<StoreView> {
    const { catalog: c, source, url } = await load()
    const byId = new Map(c.items.map((i) => [i.id, i]))
    const item = byId.get(id)
    if (!item) throw new Error(t('err.store.notFound'))
    const parts = item.type === 'bundle' ? (item.contains ?? []).map((x) => byId.get(x)).filter((x): x is StoreItem => !!x && x.type === 'knowledge' && !!x.file) : [item]
    if (parts.length === 0 || parts.some((p) => p.type !== 'knowledge')) throw new Error(t('err.store.notAvailable'))
    for (const part of parts) await installKnowledge(part, source, url)
    return catalog()
  }

  /** Toglie una base installata dallo store (non quelle integrate nell'app). */
  async function remove(id: string): Promise<StoreView> {
    const { catalog: c } = await load()
    const item = c.items.find((i) => i.id === id)
    const base = (await knowledge.installedPacks()).get(id)
    if (!item || !base || item.builtin) throw new Error(t('err.store.notFound'))
    await knowledge.removeBase(base.id)
    return catalog()
  }

  return { catalog, install, remove }
}

export type Store = ReturnType<typeof createStore>
