import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator'
import * as schema from './schema'

export type Db = SqliteRemoteDatabase<typeof schema>

export interface DbHandle {
  db: Db
  raw: DatabaseSync
  close(): void
}

type Method = 'run' | 'all' | 'values' | 'get'

/**
 * Apre il database con il modulo SQLite integrato in Node/Electron (`node:sqlite`)
 * e lo collega a Drizzle tramite il driver `sqlite-proxy`.
 * Nessun modulo nativo da ricompilare per Electron.
 *
 * @param path percorso del file, oppure ':memory:' (test)
 */
export function openDatabase(path: string): DbHandle {
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

  const exec = (sql: string, params: unknown[], method: Method): { rows: unknown[] } => {
    const stmt = raw.prepare(sql)
    const args = params as SQLInputValue[]
    if (method === 'run') {
      stmt.run(...args)
      return { rows: [] }
    }
    // Drizzle si aspetta righe come array di valori, nell'ordine delle colonne selezionate.
    stmt.setReturnArrays(true)
    if (method === 'get') {
      return { rows: (stmt.get(...args) as unknown[] | undefined) ?? [] }
    }
    return { rows: stmt.all(...args) as unknown[] }
  }

  const db = drizzle(
    async (sql, params, method) => exec(sql, params, method),
    async (queries) => {
      raw.exec('BEGIN')
      try {
        const out = queries.map((q) => exec(q.sql, q.params, q.method))
        raw.exec('COMMIT')
        return out
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    { schema }
  )

  return { db, raw, close: () => raw.close() }
}

/** Applica le migrazioni generate da drizzle-kit (cartella ./drizzle). */
export async function runMigrations(handle: DbHandle, migrationsFolder: string): Promise<void> {
  // Alcune migrazioni ricostruiscono una tabella (crea la nuova, copia, elimina la vecchia): con le chiavi
  // esterne attive l'eliminazione cancellerebbe a cascata le righe collegate. Come indica SQLite, si
  // disattivano fuori dalla transazione e alla fine si verifica che non ci siano riferimenti rotti.
  handle.raw.exec('PRAGMA foreign_keys = OFF')
  try {
    await applyMigrations(handle, migrationsFolder)
    const broken = handle.raw.prepare('PRAGMA foreign_key_check').all()
    if (broken.length) throw new Error(`Migrazione: ${broken.length} riferimenti non validi`)
  } finally {
    handle.raw.exec('PRAGMA foreign_keys = ON')
  }
}

async function applyMigrations(handle: DbHandle, migrationsFolder: string): Promise<void> {
  await migrate(
    handle.db,
    async (queries) => {
      handle.raw.exec('BEGIN')
      try {
        for (const q of queries) handle.raw.exec(q)
        handle.raw.exec('COMMIT')
      } catch (err) {
        handle.raw.exec('ROLLBACK')
        throw err
      }
    },
    { migrationsFolder }
  )
}
