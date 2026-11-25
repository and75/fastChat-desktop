// Ponte sicuro main↔renderer: espone solo `window.api`, niente accesso diretto a Node dal renderer.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', {
  env: () => invoke('env:check'),
  pickFolder: () => invoke('pick-folder'),
  openPath: (p) => invoke('open-path', p),
  showItem: (p) => invoke('show-item', p),

  iosDevices: () => invoke('ios:devices'),
  iosBackup: (opts) => invoke('ios:backup', opts),

  androidDevices: () => invoke('android:devices'),
  androidApps: (serial) => invoke('android:apps', serial),
  androidBackups: (serial, root) => invoke('android:backups', serial, root),
  androidBackup: (opts) => invoke('android:backup', opts),

  // avanzamento del backup; restituisce la funzione per annullare l'ascolto
  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('progress', listener)
    return () => ipcRenderer.removeListener('progress', listener)
  }
})
