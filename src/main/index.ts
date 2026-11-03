import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { openDatabase, runMigrations, type DbHandle } from './db/client'
import { getSettings } from './db/repo'
import { registerIpc } from './ipc'
import { createOllamaClient } from './ollama'

// Per i test end-to-end: dati isolati in una cartella temporanea.
if (process.env.FASTCHAT_USER_DATA) app.setPath('userData', process.env.FASTCHAT_USER_DATA)

let dbHandle: DbHandle | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: 'FastChat',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Nessuna finestra secondaria: i link esterni (http/https) si aprono nel browser di sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Il renderer non può navigare altrove rispetto alla pagina dell'app.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

async function bootstrap(): Promise<void> {
  const dbPath = join(app.getPath('userData'), 'chats.db')
  dbHandle = openDatabase(dbPath)
  await runMigrations(dbHandle, join(app.getAppPath(), 'drizzle'))

  const settings = await getSettings(dbHandle.db)
  let ollamaUrl = process.env.OLLAMA_URL || settings.ollamaUrl
  const ollama = createOllamaClient(() => ollamaUrl)

  registerIpc({
    db: dbHandle.db,
    ollama,
    setOllamaUrl: (url) => {
      ollamaUrl = url
    }
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.fastchat.desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  await bootstrap()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  dbHandle?.close()
  dbHandle = null
})
