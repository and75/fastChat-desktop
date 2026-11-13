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
import { isStoreBase, isStoreRole } from '@shared/store'
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
    // Basi e ruoli installati, per id del pacchetto.
    const installed = new Map<string, string | null>([...(await knowledge.installedPacks())].map(([id, b]) => [id, b.version]))
    for (const [id, role] of await knowledge.installedRoles()) installed.set(id, role.version)
    return { source, url, error, updatedAt: catalog.updatedAt, items: storeEntries(catalog, installed) }
  }

  /** Scarica (o legge) il pacchetto di una voce, ne controlla l'impronta e lo scrive tra i download: restituisce il percorso. */
  async function fetchPack(item: StoreItem, source: 'remote' | 'local', url: string): Promise<string> {
    if (!item.file) throw new Error(t('err.store.notAvailable'))
    const data = source === 'remote' ? Buffer.from(await (await remote(url, item.file)).arrayBuffer()) : await readFile(join(localDir, ...item.file.split('/')))
    if (item.sha256 && createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(t('err.store.checksum'))
    await mkdir(downloadsDir, { recursive: true })
    const path = join(downloadsDir, `${item.id}.${PACK_EXTENSION}`)
    await writeFile(path, data)
    return path
  }

  // Dal repository: solo pacchetti con firma riconosciuta. Dal catalogo dell'app: fidati come l'app.
  const trustOf = (source: 'remote' | 'local'): { store: true; builtin?: true } => ({ store: true, ...(source === 'local' ? { builtin: true as const } : {}) })

  async function installKnowledge(item: StoreItem, source: 'remote' | 'local', url: string): Promise<void> {
    await knowledge.installPack(await fetchPack(item, source, url), trustOf(source))
  }

  /** Installa un ruolo con le basi che richiede: le cerca nello stesso catalogo da cui arriva il ruolo. */
  async function installRole(item: StoreItem, byId: ReadonlyMap<string, StoreItem>, source: 'remote' | 'local', url: string): Promise<void> {
    const path = await fetchPack(item, source, url)
    await knowledge.installRole(path, {
      ...trustOf(source),
      // Un ruolo scaricato resta rimovibile dallo Store: «integrato» vale solo per ciò che l'app porta con sé.
      builtin: false,
      allowUntrusted: source === 'local',
      findBase: async (baseId) => {
        const base = byId.get(baseId)
        return base && base.type === 'knowledge' && base.file ? fetchPack(base, source, url) : null
      }
    })
  }

  /** Installa (o aggiorna) una voce; di un pacchetto, le basi e i ruoli che contiene. */
  async function install(id: string): Promise<StoreView> {
    const { catalog: c, source, url } = await load()
    const byId = new Map(c.items.map((i) => [i.id, i]))
    const item = byId.get(id)
    if (!item) throw new Error(t('err.store.notFound'))
    const installable = (x: StoreItem | undefined): x is StoreItem => !!x && (x.type === 'knowledge' || x.type === 'identity') && !!x.file
    const parts = item.type === 'bundle' ? (item.contains ?? []).map((x) => byId.get(x)).filter(installable) : [item]
    if (parts.length === 0 || !parts.every(installable)) throw new Error(t('err.store.notAvailable'))
    // Prima le basi: i ruoli le trovano già installate.
    for (const part of parts.filter((p) => p.type === 'knowledge')) await installKnowledge(part, source, url)
    for (const part of parts.filter((p) => p.type === 'identity')) await installRole(part, byId, source, url)
    return catalog()
  }

  /** Toglie una base o un ruolo installati dallo Store (non quelli integrati nell'app). */
  async function remove(id: string): Promise<StoreView> {
    const { catalog: c } = await load()
    const item = c.items.find((i) => i.id === id)
    if (!item || item.builtin) throw new Error(t('err.store.notFound'))
    if (item.type === 'identity') {
      if (!(await knowledge.installedRoles()).has(id)) throw new Error(t('err.store.notFound'))
      await knowledge.removeRole(id)
      return catalog()
    }
    const base = (await knowledge.installedPacks()).get(id)
    if (!base) throw new Error(t('err.store.notFound'))
    await knowledge.removeBase(base.id)
    return catalog()
  }

  /**
   * La voce è dello Store? Lo è se sta nel catalogo, o se la base o il ruolo installati con quell'id vengono da
   * lì (vale anche quando il repository non risponde). Ciò che è dello Store entra ed esce solo dallo Store.
   */
  async function owns(id: string): Promise<boolean> {
    const base = (await knowledge.installedPacks()).get(id)
    if (base && isStoreBase(base)) return true
    const role = (await knowledge.installedRoles()).get(id)
    if (role && isStoreRole(role)) return true
    return (await load()).catalog.items.some((i) => i.id === id)
  }

  return { catalog, install, remove, owns }
}

export type Store = ReturnType<typeof createStore>
