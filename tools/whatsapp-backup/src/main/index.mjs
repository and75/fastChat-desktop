// Processo principale dell'app Electron: finestra, dialoghi e orchestrazione del backup.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as android from './core/android.mjs'
import * as idevice from './core/idevice.mjs'
import { backupStamp } from './core/backup.mjs'
import { exportHtml } from './core/export.mjs'
import { findTool, ToolMissingError } from './core/tools.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'Backup WhatsApp',
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.removeMenu()
  win.loadFile(join(here, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())

const send = (channel, payload) => win?.webContents.send(channel, payload)
const progress = (msg) => send('progress', typeof msg === 'string' ? { text: msg } : msg)

/** Avvolge un handler IPC così gli errori arrivano al renderer come { error } leggibile. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err.message, kind: err.constructor?.name }
    }
  })
}

// --- ambiente: quali strumenti esterni ci sono ---
handle('env:check', () => ({
  adb: Boolean(findTool('adb')),
  idevice: Boolean(findTool('idevice_id') && findTool('idevicebackup2')),
  platform: process.platform
}))

// --- scelta della cartella di destinazione ---
handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

handle('open-path', (p) => shell.openPath(p))
handle('show-item', (p) => shell.showItemInFolder(p))

// --- rilevamento dispositivi ---
handle('ios:devices', () => idevice.listDevices())
handle('android:devices', () => android.listDevices())
handle('android:apps', (serial) => android.detectApps(serial))
handle('android:backups', (serial, root) => android.listDatabaseBackups(serial, root))

// --- backup iPhone ---
handle('ios:backup', async (opts) => {
  const dest = join(opts.outDir, `whatsapp-iphone-${backupStamp(new Date())}`)
  await mkdir(dest, { recursive: true })
  const res = await idevice.backupWhatsApp({
    udid: opts.udid,
    outDir: dest,
    password: opts.password || undefined,
    appId: opts.appId || undefined,
    media: opts.media !== false,
    keepRaw: opts.keepRaw !== false,
    onProgress: progress
  })
  let exported = null
  if (opts.exportHtml && res.databases?.length) {
    progress({ phase: 'export', text: 'Creazione dell’export leggibile…' })
    const chatDb = res.databases.find((d) => /ChatStorage\.sqlite$/.test(d))
    if (chatDb) exported = await exportHtml(chatDb, join(dest, 'export-html'), `iPhone · ${backupStamp(new Date())}`)
  }
  return { dest, ...res, exported }
})

// --- backup Android ---
handle('android:backup', async (opts) => {
  const dest = join(opts.outDir, `whatsapp-android-${backupStamp(new Date())}`)
  await mkdir(dest, { recursive: true })
  progress({ phase: 'backup', text: 'Copia del database dal telefono…' })
  const db = await android.backupDatabase(opts.serial, opts.backup, dest, opts.key || undefined, { onProgress: (t) => progress({ phase: 'backup', text: t }) })

  if (opts.media !== false && opts.root) {
    progress({ phase: 'media', text: 'Copia dei media (può volerci parecchio)…' })
    await android.backupMedia(opts.serial, opts.root, dest, { onLine: (l) => progress({ phase: 'media', text: l.trim() }) })
  }
  await android.writeManifest(opts.serial, dest, { app: opts.appId, databaseCifrato: db.dbName, decifrato: Boolean(db.decryptedPath) })

  let exported = null
  if (opts.exportHtml && db.decryptedPath) {
    progress({ phase: 'export', text: 'Creazione dell’export leggibile…' })
    exported = await exportHtml(db.decryptedPath, join(dest, 'export-html'), `Android · ${backupStamp(new Date())}`)
  }
  return { dest, ...db, exported }
})

// errori non gestiti → log, niente crash silenzioso
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err))
export { ToolMissingError }
