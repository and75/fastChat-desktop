// Backup di WhatsApp da iPhone via USB, con il servizio di backup ufficiale di Apple (libimobiledevice).
//
// Nessun software viene installato sul telefono: il backup è scritto sul PC.
// L'unico segno lato device è il «Autorizza questo computer» (pairing) alla prima connessione.
// Il DB chat (ChatStorage.sqlite) sta nel container condiviso dell'app, incluso nel backup.
// Se il backup cifrato è già attivo sull'iPhone serve la sua password; l'app non cambia quell'impostazione.
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { extractWhatsApp, findApp, openBackup, PasswordRequiredError } from './backup.mjs'
import { idevicePath, run } from './tools.mjs'

/** iPhone/iPad collegati via USB e in trust. */
export async function listDevices() {
  const { stdout } = await run(idevicePath('idevice_id'), ['-l'])
  const udids = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const devices = []
  for (const udid of udids) {
    const info = await deviceInfo(udid)
    devices.push({ udid, ...info })
  }
  return devices
}

async function deviceInfo(udid) {
  const read = async (key) => {
    const { stdout, code } = await run(idevicePath('ideviceinfo'), ['-u', udid, '-k', key])
    return code === 0 ? stdout.trim() : ''
  }
  const name = (await read('DeviceName')) || 'iPhone'
  const version = await read('ProductVersion')
  // se non in trust, ideviceinfo fallisce: lo segnaliamo come non pronto.
  return { name, iosVersion: version, ready: Boolean(version) }
}

/**
 * Crea (o aggiorna) un backup del dispositivo nella cartella indicata.
 * Il primo è completo; i successivi sono incrementali e veloci (stessa cartella).
 * @returns {string} cartella del backup (contiene la sottocartella <udid>)
 */
export async function runDeviceBackup(udid, backupRoot, { password, onProgress } = {}) {
  const args = ['-u', udid, 'backup', backupRoot]
  if (password) args.unshift('--password', password) // solo per leggere un backup cifrato esistente
  await new Promise((resolve, reject) => {
    const child = spawn(idevicePath('idevicebackup2'), args, { windowsHide: true })
    let err = ''
    const handle = (buf) => {
      const text = buf.toString()
      const pct = /(\d+(?:\.\d+)?)%/.exec(text)
      onProgress?.({ text: text.trim(), percent: pct ? Number(pct[1]) : null })
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', (d) => {
      err += d
      handle(d)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else if (/not paired|pairing|Trust/i.test(err)) reject(new NotTrustedError())
      else reject(new Error(err.trim() || `idevicebackup2: codice ${code}`))
    })
  })
  return join(backupRoot, udid)
}

export class NotTrustedError extends Error {
  constructor() {
    super('Il computer non è autorizzato sull’iPhone. Sblocca il telefono e tocca «Autorizza».')
  }
}

/**
 * Backup completo di WhatsApp da iPhone: crea il backup, estrae DB e media, pulisce il grezzo.
 * @param {object} opts
 * @param {string} opts.udid
 * @param {string} opts.outDir      cartella finale del backup
 * @param {string} [opts.password]  password del backup cifrato (se attivo)
 * @param {string} [opts.appId]     'whatsapp' | 'business' (auto se omesso)
 * @param {boolean}[opts.media]     copia anche i media (default true)
 * @param {boolean}[opts.keepRaw]   conserva il backup iTunes grezzo per aggiornamenti veloci (default true)
 */
export async function backupWhatsApp({ udid, outDir, password, appId, media = true, keepRaw = true, onProgress }) {
  const rawRoot = join(outDir, '_backup_iphone')
  onProgress?.({ phase: 'backup', text: 'Backup dell’iPhone in corso (il primo è il più lungo)…' })
  const backupDir = await runDeviceBackup(udid, rawRoot, {
    password,
    onProgress: (p) => onProgress?.({ phase: 'backup', ...p })
  })

  onProgress?.({ phase: 'estrazione', text: 'Lettura del backup…' })
  const backup = await openBackup(backupDir, password)
  try {
    const app = findApp(backup, appId)
    if (!app) throw new Error('Nel backup non c’è un database di WhatsApp.')
    const result = await extractWhatsApp(backup, app, outDir, {
      media,
      onProgress: (done, total) => onProgress?.({ phase: 'estrazione', text: `File ${done}/${total}`, done, total })
    })
    if (!keepRaw) await rm(rawRoot, { recursive: true, force: true }).catch(() => {})
    return { app, ...result }
  } finally {
    await backup.close()
  }
}

export { PasswordRequiredError }
