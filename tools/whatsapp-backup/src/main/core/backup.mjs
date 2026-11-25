// Backup locali di iPhone (iTunes, Apple Devices, Finder, idevicebackup2): ricerca, apertura, estrazione.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { decryptFile, unlockKeybag, unwrapClassedKey } from './keybag.mjs'
import { parsePlist } from './plist.mjs'

export const APPS = {
  whatsapp: { label: 'WhatsApp', bundle: 'net.whatsapp.WhatsApp', domain: 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared' },
  business: {
    label: 'WhatsApp Business',
    bundle: 'net.whatsapp.WhatsAppSMB',
    domain: 'AppDomainGroup-group.net.whatsapp.WhatsAppSMB.shared'
  }
}

export class PasswordRequiredError extends Error {
  constructor() {
    super('Il backup è cifrato: serve la password scelta in iTunes/Finder.')
  }
}

/** Cartelle in cui i programmi di Apple salvano i backup, per sistema operativo. */
export function defaultBackupRoots(env = process.env, platform = process.platform) {
  const home = homedir()
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      join(appData, 'Apple Computer', 'MobileSync', 'Backup'),
      join(home, 'Apple', 'MobileSync', 'Backup'),
      join(appData, 'Apple', 'MobileSync', 'Backup')
    ]
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'MobileSync', 'Backup')]
  return []
}

async function readManifestPlist(dir) {
  const plist = parsePlist(await readFile(join(dir, 'Manifest.plist')))
  const apps = Object.keys(plist.Applications ?? {})
  return {
    path: dir,
    deviceName: plist.Lockdown?.DeviceName ?? 'iPhone',
    iosVersion: plist.Lockdown?.ProductVersion ?? '',
    date: plist.Date instanceof Date ? plist.Date : null,
    encrypted: plist.IsEncrypted === true,
    apps: Object.keys(APPS).filter((id) => apps.includes(APPS[id].bundle)),
    keybag: plist.BackupKeyBag,
    manifestKey: plist.ManifestKey
  }
}

/** Un backup è una cartella con Manifest.plist; `root` può essere il backup stesso o la cartella che ne contiene. */
export async function listBackups(roots) {
  const found = []
  for (const root of roots) {
    const candidates = [root]
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(root, entry.name))
      }
    } catch {
      continue
    }
    for (const dir of candidates) {
      try {
        found.push(await readManifestPlist(dir))
      } catch {
        // non è un backup
      }
    }
  }
  return found.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
}

/** Apre l'indice del backup (Manifest.db), decifrandolo se serve. Chiudere con `close()`. */
export async function openBackup(dir, password) {
  const info = await readManifestPlist(dir)
  let classKeys = null
  if (info.encrypted) {
    if (!password) throw new PasswordRequiredError()
    classKeys = unlockKeybag(info.keybag, password)
  }
  // L'indice elenca tutti i file del telefono: la copia di lavoro sta in una cartella temporanea, poi si cancella.
  const tmp = await mkdtemp(join(tmpdir(), 'wa-backup-'))
  try {
    const manifestDb = join(tmp, 'Manifest.db')
    if (classKeys) {
      await decryptFile(join(dir, 'Manifest.db'), manifestDb, unwrapClassedKey(classKeys, info.manifestKey))
    } else {
      await copyFile(join(dir, 'Manifest.db'), manifestDb)
    }
    const db = new Database(manifestDb, { readonly: true, fileMustExist: true })
    return {
      info,
      classKeys,
      db,
      async close() {
        db.close()
        await rm(tmp, { recursive: true, force: true })
      }
    }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true })
    throw err
  }
}

/** Quale WhatsApp c'è nel backup: quello chiesto, altrimenti il primo che ha un database delle chat. */
export function findApp(backup, wanted) {
  const has = backup.db.prepare("SELECT 1 FROM Files WHERE domain = ? AND relativePath = 'ChatStorage.sqlite'")
  const ids = wanted ? [wanted] : Object.keys(APPS)
  return ids.find((id) => has.get(APPS[id].domain)) ?? null
}

function fileRecord(blob) {
  const plist = parsePlist(Buffer.from(blob))
  const objects = plist.$objects
  const top = objects[plist.$top.root.value]
  let key = top.EncryptionKey ? objects[top.EncryptionKey.value] : null
  if (key && !Buffer.isBuffer(key)) key = key['NS.data']
  return { size: Number(top.Size ?? 0), protectionClass: top.ProtectionClass, key, modified: top.LastModified }
}

const DB_FILE = /^[^/]+\.sqlite(-wal|-shm)?$/

/** Nome sicuro su ogni sistema: niente risalite di cartella, niente caratteri vietati da Windows. */
export function safeRelativePath(relativePath) {
  const parts = relativePath
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => p.replace(/[<>:"|?*\\\u0000-\u001f]/g, '_').replace(/[. ]+$/, '_'))
  return parts.length ? join(...parts) : null
}

/** Etichetta della copia: data del backup dell'iPhone, in ora locale. */
export function backupStamp(date) {
  const d = date ?? new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * Copia i file di WhatsApp dal backup alla cartella di destinazione.
 * Database in `db/<data>/`, il resto in `files/` (solo i file nuovi o cambiati).
 */
export async function extractWhatsApp(backup, appId, outDir, { media = true, all = false, onProgress } = {}) {
  const rows = backup.db
    .prepare('SELECT fileID, relativePath, file FROM Files WHERE domain = ? AND flags = 1 ORDER BY relativePath')
    .all(APPS[appId].domain)
  const dbDir = join(outDir, 'db', backupStamp(backup.info.date))
  const result = { dbDir, databases: [], copied: 0, skipped: 0, bytes: 0, missing: [] }

  const wanted = rows.filter((row) => {
    if (DB_FILE.test(row.relativePath)) return true
    if (all) return true
    return media && row.relativePath.startsWith('Message/Media/')
  })

  let done = 0
  for (const row of wanted) {
    onProgress?.(++done, wanted.length)
    const isDb = DB_FILE.test(row.relativePath)
    const safe = safeRelativePath(row.relativePath)
    if (!safe) continue
    const dest = isDb ? join(dbDir, safe) : join(outDir, 'files', safe)
    const record = fileRecord(row.file)

    if (!isDb) {
      const existing = await stat(dest).catch(() => null)
      if (existing?.isFile() && existing.size === record.size) {
        result.skipped++
        continue
      }
    }
    const src = join(backup.info.path, row.fileID.slice(0, 2), row.fileID)
    if (!(await stat(src).catch(() => null))) {
      result.missing.push(row.relativePath)
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    if (backup.classKeys && record.key) {
      const key = unwrapClassedKey(backup.classKeys, record.key, record.protectionClass)
      await decryptFile(src, dest, key, record.size)
    } else {
      await copyFile(src, dest)
    }
    if (record.modified) await utimes(dest, new Date(), new Date(record.modified * 1000)).catch(() => {})
    result.copied++
    result.bytes += record.size
    if (isDb) result.databases.push(dest)
  }
  return result
}
