// Logica dell'interfaccia: rilevamento dispositivi, scelta cartella, avvio del backup e avanzamento.
const $ = (id) => document.getElementById(id)
const state = { tab: 'iphone', outDir: null, ios: null, android: null }

// --- tab ---
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === tab.dataset.tab))
    state.tab = tab.dataset.tab
    refreshStart()
  })
}

function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000)
}

// --- ambiente ---
;(async () => {
  const { data } = await window.api.env()
  if (!data) return
  if (!data.idevice) {
    $('ios-device').innerHTML =
      '<span class="err">Strumenti iPhone non trovati.</span> Serve libimobiledevice accanto all’app (cartella <code>resources/bin</code>).'
  }
  if (!data.adb) {
    $('and-device').innerHTML =
      '<span class="err">adb non trovato.</span> Servono gli Android Platform Tools accanto all’app (cartella <code>resources/bin</code>).'
  }
})()

// --- cartella di destinazione ---
$('pick').addEventListener('click', async () => {
  const { data } = await window.api.pickFolder()
  if (data) {
    state.outDir = data
    $('out-dir').textContent = data
    $('out-dir').title = data
    refreshStart()
  }
})

// --- rilevamento iPhone ---
$('ios-detect').addEventListener('click', async () => {
  $('ios-device').textContent = 'Ricerca in corso…'
  const { ok, data, error } = await window.api.iosDevices()
  if (!ok) return setDeviceError('ios-device', error)
  const ready = data.find((d) => d.ready) || data[0]
  if (!ready) {
    $('ios-device').innerHTML = '<span class="err">Nessun iPhone collegato.</span> Controlla il cavo e sblocca il telefono.'
    state.ios = null
  } else if (!ready.ready) {
    $('ios-device').innerHTML = `<span class="err">${ready.name} collegato ma non autorizzato.</span> Tocca «Autorizza» sul telefono e riprova.`
    state.ios = null
  } else {
    state.ios = ready
    $('ios-device').innerHTML = `<span class="ok">✓ ${ready.name}</span> · iOS ${ready.iosVersion}`
  }
  refreshStart()
})

// --- rilevamento Android ---
$('and-detect').addEventListener('click', async () => {
  $('and-device').textContent = 'Ricerca in corso…'
  const res = await window.api.androidDevices()
  if (!res.ok) return setDeviceError('and-device', res.error)
  const ready = res.data.find((d) => d.ready)
  const any = res.data[0]
  if (!ready) {
    const why = any && any.state === 'unauthorized' ? ' (non autorizzato: tocca «Consenti» sul telefono)' : ''
    $('and-device').innerHTML = `<span class="err">Nessun telefono pronto${why}.</span>`
    state.android = null
    return refreshStart()
  }
  const apps = await window.api.androidApps(ready.serial)
  if (!apps.ok || !apps.data.length) {
    $('and-device').innerHTML = `<span class="ok">✓ ${ready.model}</span> — ma non trovo dati di WhatsApp sulla memoria.`
    state.android = null
    return refreshStart()
  }
  const app = apps.data[0]
  const backups = await window.api.androidBackups(ready.serial, app.root)
  state.android = { serial: ready.serial, model: ready.model, app, backups: backups.data || [] }
  $('and-device').innerHTML = `<span class="ok">✓ ${ready.model}</span> · ${app.label}`
  fillBackups(state.android.backups)
  refreshStart()
})

function fillBackups(list) {
  const sel = $('and-backup')
  sel.innerHTML = ''
  if (!list.length) {
    $('and-step-backup').classList.add('disabled')
    sel.innerHTML = '<option>Nessun backup trovato in Databases/</option>'
    return
  }
  $('and-step-backup').classList.remove('disabled')
  for (const b of list) {
    const when = b.modified ? new Date(b.modified).toLocaleString('it-IT') : 's.d.'
    const mb = (b.size / 1048576).toFixed(1)
    const opt = document.createElement('option')
    opt.value = b.name
    opt.textContent = `${b.current ? '● più recente — ' : ''}${b.name} · ${mb} MB · ${when}`
    sel.appendChild(opt)
  }
}

function setDeviceError(id, error) {
  $(id).innerHTML = `<span class="err">${error || 'Errore nel rilevamento.'}</span>`
  refreshStart()
}

function refreshStart() {
  const ready = state.outDir && (state.tab === 'iphone' ? state.ios : state.android)
  $('start').disabled = !ready
}

// --- avanzamento ---
window.api.onProgress((p) => {
  $('log').classList.remove('hidden')
  if (p.text) {
    $('status').textContent = p.text
    const pre = $('log-lines')
    pre.textContent += p.text + '\n'
    pre.scrollTop = pre.scrollHeight
  }
  if (typeof p.percent === 'number') $('bar-fill').style.width = `${Math.min(100, p.percent)}%`
})

// --- avvio ---
$('start').addEventListener('click', async () => {
  $('start').disabled = true
  $('result').classList.add('hidden')
  $('log').classList.remove('hidden')
  $('log-lines').textContent = ''
  $('bar-fill').style.width = '0'
  $('status').textContent = 'Avvio…'

  const res = state.tab === 'iphone' ? await runIos() : await runAndroid()
  $('bar-fill').style.width = '100%'
  if (res.ok) showResult(res.data)
  else showError(res)
  $('start').disabled = false
})

async function runIos() {
  return window.api.iosBackup({
    udid: state.ios.udid,
    outDir: state.outDir,
    password: $('ios-password').value.trim(),
    media: $('ios-media').checked,
    exportHtml: $('ios-export').checked,
    keepRaw: $('ios-keepraw').checked
  })
}

async function runAndroid() {
  const name = $('and-backup').value
  const backup = state.android.backups.find((b) => b.name === name)
  return window.api.androidBackup({
    serial: state.android.serial,
    appId: state.android.app.appId,
    root: state.android.app.root,
    backup,
    key: $('and-key').value.trim(),
    media: $('and-media').checked,
    exportHtml: $('and-export').checked
  })
}

function showResult(d) {
  const box = $('result')
  box.className = 'result'
  const exp = d.exported
    ? `<p>Export leggibile: <b>${d.exported.chats}</b> chat, <b>${d.exported.messages}</b> messaggi.</p>`
    : '<p>Database copiato. Per leggere le chat serve la chiave (export non creato).</p>'
  box.innerHTML = `
    <h4>✓ Backup completato</h4>
    <p>Salvato in:<br /><code>${d.dest}</code></p>
    ${exp}
    <div class="actions">
      <button class="btn" id="r-open">Apri la cartella</button>
      ${d.exported ? '<button class="btn primary" id="r-html">Apri le chat (HTML)</button>' : ''}
    </div>`
  box.classList.remove('hidden')
  $('status').textContent = 'Fatto.'
  $('r-open').addEventListener('click', () => window.api.openPath(d.dest))
  if (d.exported) $('r-html').addEventListener('click', () => window.api.openPath(d.exported.indexPath))
}

function showError(res) {
  const box = $('result')
  box.className = 'result bad'
  box.innerHTML = `<h4>Backup non riuscito</h4><p>${res.error || 'Errore sconosciuto.'}</p>`
  box.classList.remove('hidden')
  $('status').textContent = 'Errore.'
  toast(res.error || 'Errore')
}
