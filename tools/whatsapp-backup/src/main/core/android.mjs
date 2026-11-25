// Backup di WhatsApp da un telefono Android via adb (USB), senza root e senza installare nulla sul telefono.
//
// Cosa si legge, senza root:
//  - i backup cifrati che WhatsApp crea da sé sulla memoria condivisa (msgstore.db.crypt15 + media).
//  - adb li copia: operazione di sola lettura, non modifica il telefono.
// Cosa serve per leggerli: la chiave a 64 cifre (backup crittografato end-to-end) — vedi crypt.mjs.
//
// L'unica modifica lato telefono è l'attivazione del Debug USB da parte dell'utente (reversibile).
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptCrypt15 } from './crypt.mjs'
import { adbPath, run } from './tools.mjs'

export const WA_APPS = {
  whatsapp: { label: 'WhatsApp', pkg: 'com.whatsapp', folder: 'WhatsApp' },
  business: { label: 'WhatsApp Business', pkg: 'com.whatsapp.w4b', folder: 'WhatsApp Business' }
}

// Posizioni possibili della cartella dati sulla memoria condivisa, dalla più recente.
function sharedRoots(app) {
  return [
    `/sdcard/Android/media/${app.pkg}/${app.folder}`, // Android 11+ (scoped storage)
    `/sdcard/${app.folder}` // Android ≤10
  ]
}

const adb = (serial, ...args) => run(adbPath(), serial ? ['-s', serial, ...args] : args)

// Comando shell con percorso quotato per il device (sh di Android), al riparo da spazi.
function shellQuote(path) {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

export async function startServer() {
  await adb(null, 'start-server')
}

/** Dispositivi collegati e pronti (state=device). Esclude unauthorized/offline, ma li segnala. */
export async function listDevices() {
  await startServer()
  const { stdout } = await adb(null, 'devices', '-l')
  const devices = []
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim())
    if (!m) continue
    const [, serial, state, rest] = m
    const model = /model:(\S+)/.exec(rest)?.[1]?.replace(/_/g, ' ')
    devices.push({ serial, state, model: model ?? serial, ready: state === 'device' })
  }
  return devices
}

async function shellExists(serial, path) {
  const { stdout } = await adb(serial, 'shell', `[ -e ${shellQuote(path)} ] && echo yes || echo no`)
  return stdout.trim().endsWith('yes')
}

/** Trova la cartella dati esistente di un'app WhatsApp sul telefono. Null se assente. */
export async function findAppRoot(serial, appId) {
  const app = WA_APPS[appId]
  for (const root of sharedRoots(app)) {
    if (await shellExists(serial, root)) return root
  }
  return null
}

/** Quali app WhatsApp hanno dati sul telefono. */
export async function detectApps(serial) {
  const found = []
  for (const appId of Object.keys(WA_APPS)) {
    const root = await findAppRoot(serial, appId)
    if (root) found.push({ appId, ...WA_APPS[appId], root })
  }
  return found
}

/** Elenca i backup del database in Databases/, dal più recente, con dimensione e data. */
export async function listDatabaseBackups(serial, root) {
  const dir = `${root}/Databases`
  if (!(await shellExists(serial, dir))) return []
  // -1 un nome per riga; poi stat per dimensione e data di modifica.
  const { stdout } = await adb(serial, 'shell', `ls -1 ${shellQuote(dir)}`)
  const names = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => /^msgstore.*\.crypt\d+$/.test(n))
  const out = []
  for (const name of names) {
    const full = `${dir}/${name}`
    const { stdout: s } = await adb(serial, 'shell', `stat -c '%s %Y' ${shellQuote(full)}`)
    const [size, mtime] = s.trim().split(/\s+/)
    out.push({
      name,
      remote: full,
      size: Number(size) || 0,
      modified: mtime ? new Date(Number(mtime) * 1000) : null,
      current: name === 'msgstore.db.crypt15' || name === 'msgstore.db.crypt14'
    })
  }
  // «msgstore.db.cryptNN» (il più recente) in cima, poi i datati decrescenti.
  return out.sort((a, b) => Number(b.current) - Number(a.current) || (b.modified ?? 0) - (a.modified ?? 0))
}

/** Dimensione totale (byte) di un albero sul telefono, per la barra di avanzamento. */
export async function remoteSize(serial, path) {
  const { stdout } = await adb(serial, 'shell', `du -s -b ${shellQuote(path)} 2>/dev/null || echo 0`)
  return Number(stdout.trim().split(/\s+/)[0]) || 0
}

/** Copia un file/cartella dal telefono al PC. `adb pull` è di sola lettura sul device. */
export async function pull(serial, remote, localDir, { onLine } = {}) {
  await mkdir(localDir, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(), ['-s', serial, 'pull', '-a', remote, localDir], { windowsHide: true })
    let err = ''
    child.stdout.on('data', (d) => onLine?.(d.toString()))
    child.stderr.on('data', (d) => {
      err += d
      onLine?.(d.toString())
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `adb pull: codice ${code}`))))
  })
}

/**
 * Copia il database di WhatsApp e, se è dato il parametro key, lo decifra in msgstore.db leggibile.
 * @returns {{ encryptedPath: string, decryptedPath: string|null, dbName: string }}
 */
export async function backupDatabase(serial, backup, outDir, key, { onProgress } = {}) {
  await mkdir(outDir, { recursive: true })
  const encryptedPath = join(outDir, backup.name)
  await pull(serial, backup.remote, outDir, { onLine: () => onProgress?.('copia del database') })

  let decryptedPath = null
  if (key && backup.name.endsWith('.crypt15')) {
    onProgress?.('decifratura')
    const db = decryptCrypt15(await readFile(encryptedPath), key)
    decryptedPath = join(outDir, 'msgstore.db')
    await writeFile(decryptedPath, db)
  }
  return { encryptedPath, decryptedPath, dbName: backup.name }
}

/** Copia la cartella Media (foto, audio, documenti) sul PC. Solo lettura sul telefono. */
export async function backupMedia(serial, root, outDir, { onLine } = {}) {
  const mediaDir = `${root}/Media`
  const dest = join(outDir, 'Media')
  await rm(dest, { recursive: true, force: true }).catch(() => {})
  await pull(serial, mediaDir, outDir, { onLine })
  return dest
}

/** Scrive un file-indice con la provenienza del backup (per sapere da dove e quando viene). */
export async function writeManifest(serial, outDir, extra = {}) {
  const info = {
    sorgente: 'Android (adb)',
    serial,
    data: new Date().toISOString(),
    ...extra
  }
  await writeFile(join(outDir, 'backup-info.json'), JSON.stringify(info, null, 2))
  return info
}
