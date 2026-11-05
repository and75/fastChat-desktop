// Test end-to-end: avvia l'app buildata (out/) con Playwright `_electron`, contro un Ollama finto.
// Uso: npm run test:e2e   (su Linux senza display: xvfb-run -a npm run test:e2e)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startFakeOllama } from '../tests/helpers/fakeOllama.ts'

const root = resolve(import.meta.dirname, '..')
const userData = mkdtempSync(join(tmpdir(), 'fastchat-e2e-'))
const fake = await startFakeOllama([
  { name: 'qwen3:4b', capabilities: ['completion', 'thinking'] },
  { name: 'llama3.2:3b', capabilities: ['completion', 'tools'] },
  // risponde dopo 5 s: simula il caricamento del modello in Ollama
  { name: 'lento-avvio:1b', capabilities: ['completion'], startDelayMs: 5000, chunks: [{ content: 'Eccomi.' }] },
  {
    name: 'thinker:8b',
    capabilities: ['completion', 'thinking'],
    contextLength: 32768,
    parameters: 'temperature 0.6\ntop_p 0.95\nnum_ctx 4096',
    delayMs: 80,
    chunks: [
      ...Array.from({ length: 12 }, (_, i) => ({ thinking: `passo${i} ` })),
      ...Array.from({ length: 30 }, (_, i) => ({ content: `risposta${i} ` }))
    ]
  },
  {
    name: 'slow:1b',
    capabilities: ['completion'],
    delayMs: 60,
    chunks: [
      { content: 'Ecco **il codice**:\n\n```ts\nconst x = 1\n```\n\n' },
      ...Array.from({ length: 60 }, (_, i) => ({ content: `parola${i} ` }))
    ]
  }
])
// Le richieste di generazione del titolo (dopo il primo scambio) non contano come "ultima chat".
const isTitleRequest = (body) => body?.messages?.[0]?.content?.startsWith('Genera un titolo')
const chatRequests = () => fake.requests.filter((r) => r.path === '/api/chat' && !isTitleRequest(r.body))
const lastChat = () => chatRequests().at(-1)?.body


/** Attiva/disattiva un interruttore cliccando l'etichetta visibile (l'input è nascosto) e attende lo stato. */
async function setSwitch(scope, name, on) {
  const input = scope.getByRole('switch', { name })
  if ((await input.isChecked()) !== on) {
    await scope.locator('label', { has: scope.page().getByRole('switch', { name }) }).click()
  }
  await scope.page().waitForFunction(
    ([el, want]) => el.checked === want,
    [await input.elementHandle(), on]
  )
}

/** Attende (con polling lato Node) che una condizione asincrona diventi vera. */
async function waitUntil(check, timeout = 10_000) {
  const end = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > end) throw new Error('waitUntil: condizione non verificata in tempo')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const steps = []
async function step(name, fn) {
  try {
    await fn()
    steps.push(`  ✓ ${name}`)
  } catch (err) {
    steps.push(`  ✗ ${name}`)
    throw err
  }
}

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  env: {
    ...process.env,
    OLLAMA_URL: fake.url,
    FASTCHAT_USER_DATA: userData,
    FASTCHAT_EXPORT_PATH: join(userData, 'export'),
    // Macchina finta: 16 GB di RAM non unificata → quota 50%. Con un modello da 2 GB e 128 KiB per token
    // la memoria suggerita è ~42k → 32.768 (thinker:8b), 8.192 per i modelli con contesto massimo 8k.
    FASTCHAT_SYSTEM_RAM: String(16 * 1024 ** 3),
    FASTCHAT_SYSTEM_UNIFIED: '0',
    NODE_ENV: 'production'
  }
})

/** La conversazione aggiornata più di recente, letta dal main. */
const latestConversation = async () =>
  (await app.windows()[0].evaluate(() => window.api.conversations.list())).data[0]

let failed = false
try {
  const page = await app.firstWindow()
  /** Apre una scheda del pannello di destra (Modello / Brief) e attende che sia attiva. */
  const openTab = async (name) => {
    const tab = page.getByRole('tab', { name })
    await tab.click()
    await page.waitForFunction((n) => {
      const t = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes(n))
      return t?.getAttribute('aria-selected') === 'true'
    }, name)
  }
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await step('la finestra usa sandbox e contextIsolation', async () => {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      return wc.getLastWebPreferences()
    })
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
  })

  await step('il renderer vede solo window.api (niente require/process)', async () => {
    const globals = await page.evaluate(() => ({
      api: typeof window.api,
      models: typeof window.api?.models?.list,
      require: typeof window.require,
      process: typeof window.process
    }))
    assert.deepEqual(globals, { api: 'object', models: 'function', require: 'undefined', process: 'undefined' })
  })

  await step('ModelPicker elenca i modelli di Ollama', async () => {
    const select = page.locator('#model-select')
    await select.locator('option', { hasText: 'qwen3:4b' }).waitFor({ state: 'attached' })
    const options = await select.locator('option').allTextContents()
    assert.deepEqual(options, ['lento-avvio:1b', 'llama3.2:3b', 'qwen3:4b', 'slow:1b', 'thinker:8b'])
  })

  await step('capabilities: llama3.2 senza ragionamento, qwen3 con ragionamento', async () => {
    await page.getByTestId('thinking-capability').filter({ hasText: 'senza ragionamento' }).waitFor()
    await page.selectOption('#model-select', 'qwen3:4b')
    await page.getByTestId('thinking-capability').filter({ hasText: /^ragionamento$/ }).waitFor()
  })

  await step('il modello scelto è salvato nelle impostazioni (SQLite)', async () => {
    const res = await page.evaluate(() => window.api.settings.get())
    assert.equal(res.ok, true)
    assert.equal(res.data.defaultModel, 'qwen3:4b')
  })

  await step('Ollama irraggiungibile → banner, poi "Riprova" con URL corretto', async () => {
    const bad = await page.evaluate(() => window.api.settings.set({ ollamaUrl: 'http://127.0.0.1:1' }))
    assert.equal(bad.ok, true)
    await page.getByTitle('Aggiorna elenco modelli').click()
    const banner = page.getByTestId('ollama-banner')
    await banner.waitFor()
    await banner.getByLabel('URL di Ollama').fill(fake.url)
    await banner.getByRole('button', { name: 'Riprova' }).click()
    await banner.waitFor({ state: 'detached' })
    await page.locator('#model-select option', { hasText: 'qwen3:4b' }).waitFor({ state: 'attached' })
  })

  // ------------------------------------------------------------------ fase 2
  const items = page.getByTestId('conversation-item')
  const composer = page.getByLabel('Messaggio')

  await step('nuova conversazione: compare in sidebar con il modello predefinito', async () => {
    await page.getByTestId('new-conversation').click()
    await items.first().waitFor()
    assert.equal(await items.count(), 1)
    assert.equal(await page.locator('#model-select').inputValue(), 'qwen3:4b')
    // conversazione vuota: stima (≈) del solo brief, quindi pochi token
    await page.getByTestId('context-usage').filter({ hasText: /^Contesto ≈\d+ \/ / }).waitFor()
    await page.selectOption('#model-select', 'llama3.2:3b')
  })

  await step('brief: si salva da solo e l\'anteprima mostra le sezioni in ordine', async () => {
    await openTab('Brief')
    const panel = page.getByTestId('brief-panel')
    await panel.getByLabel('Vincoli').fill('Rispondi solo in italiano.')
    await panel.getByLabel('Ruolo').fill('Sei un tutor paziente.')
    await panel.getByTestId('brief-status').filter({ hasText: 'Salvato' }).waitFor()
    await panel.getByText('Anteprima system prompt').click()
    assert.equal(
      await panel.getByTestId('system-preview').textContent(),
      '# Ruolo\nSei un tutor paziente.\n\n# Vincoli\nRispondi solo in italiano.'
    )
  })

  await step('invio: risposta in streaming e brief inviato come primo messaggio system', async () => {
    await composer.fill('Ciao!')
    await composer.press('Enter')
    await page.getByTestId('message-user').filter({ hasText: 'Ciao!' }).waitFor()
    // sotto il messaggio dell'utente: data compatta, completa nel tooltip
    const date = page.getByTestId('message-user').filter({ hasText: 'Ciao!' }).getByTestId('message-date')
    assert.match(await date.textContent(), /^Oggi, \d{2}:\d{2}$/)
    assert.match(await date.getAttribute('title'), /\d{4}.*\d{2}:\d{2}/)
    assert.equal(await page.getByTestId('message-assistant').getByTestId('message-date').count(), 0)
    await page.getByTestId('message-assistant').filter({ hasText: 'Ciao mondo!' }).waitFor()
    const body = lastChat()
    assert.equal(body.model, 'llama3.2:3b')
    assert.deepEqual(body.messages, [
      { role: 'system', content: '# Ruolo\nSei un tutor paziente.\n\n# Vincoli\nRispondi solo in italiano.' },
      { role: 'user', content: 'Ciao!' }
    ])
    assert.equal('think' in body, false)
    const meta = await page.getByTestId('message-assistant').last().textContent()
    assert.match(meta, /42 token/)
  })

  await step('contatore del contesto: conteggio di Ollama dopo la risposta, su memoria del modello', async () => {
    const meter = page.getByTestId('context-usage')
    // llama3.2 nel server finto ha contesto massimo 8.192: la memoria calcolata dalla RAM si ferma lì
    await meter.filter({ hasText: /^Contesto [\d,]+k? \/ 8,2k · \d+%$/ }).waitFor()
    const text = await meter.textContent()
    assert.doesNotMatch(text, /≈/, 'dopo una risposta il numero viene da Ollama, non è una stima')
    const title = await meter.getAttribute('title')
    assert.match(title, /token usati su 8\.192 disponibili \(conteggio di Ollama/)
  })

  await step('titolo automatico dopo il primo scambio (sidebar e intestazione)', async () => {
    await items.filter({ hasText: 'Ciao mondo!' }).waitFor()
    await page.locator('header h1', { hasText: 'Ciao mondo!' }).waitFor()
    const titleReq = fake.requests.filter((r) => r.path === '/api/chat' && isTitleRequest(r.body))
    assert.equal(titleReq.length, 1)
    assert.match(titleReq[0].body.messages[1].content, /Domanda:\nCiao!/)
  })

  await step('streaming visibile, Markdown con codice evidenziato, Interrompi salva il parziale', async () => {
    await page.selectOption('#model-select', 'slow:1b')
    await composer.fill('Scrivi tanto')
    await composer.press('Enter')
    const live = page.getByTestId('message-streaming')
    await live.locator('code.hljs').waitFor()
    await live.filter({ hasText: 'parola3' }).waitFor()
    await page.getByRole('button', { name: 'Interrompi' }).click()
    await live.waitFor({ state: 'detached' })
    const saved = page.getByTestId('message-assistant').last()
    const text = await saved.textContent()
    assert.match(text, /parola3/)
    assert.doesNotMatch(text, /parola59/)
    // il secondo turno porta con sé lo storico
    assert.deepEqual(
      lastChat().messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'user']
    )
  })

  await step('copia negli appunti: risposta intera (Markdown) e singolo blocco di codice', async () => {
    const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
    const saved = page.getByTestId('message-assistant').last()

    // blocco di codice: pulsante che compare al passaggio del mouse, copia solo il codice
    await saved.locator('pre').hover()
    await saved.getByRole('button', { name: 'Copia il codice' }).click()
    await saved.getByRole('button', { name: 'Codice copiato' }).waitFor()
    assert.equal(await readClipboard(), 'const x = 1')

    // risposta intera: testo Markdown originale, non quello reso
    await saved.getByRole('button', { name: 'Copia la risposta' }).click()
    await saved.getByRole('button', { name: 'Risposta copiata' }).waitFor()
    const text = await readClipboard()
    assert.match(text, /^Ecco \*\*il codice\*\*:\n\n```ts\nconst x = 1\n```/)
    assert.match(text, /parola3/)

    // ogni risposta ha «Copia», «Rigenera» solo l'ultima
    const answers = page.getByTestId('message-assistant')
    assert.equal(await answers.first().getByRole('button', { name: 'Copia la risposta' }).count(), 1)
    assert.equal(await answers.first().getByRole('button', { name: 'Rigenera', exact: true }).count(), 0)
  })

  await step('rigenera l\'ultima risposta', async () => {
    await page.selectOption('#model-select', 'llama3.2:3b')
    const before = await page.getByTestId('message-assistant').count()
    await page.getByRole('button', { name: 'Rigenera', exact: true }).click()
    await page.getByTestId('message-assistant').last().filter({ hasText: 'Ciao mondo!' }).waitFor()
    assert.equal(await page.getByTestId('message-assistant').count(), before)
    assert.equal(lastChat().messages.at(-1).content, 'Scrivi tanto')
  })

  await step('storico persistente: dopo il reload la conversazione e i messaggi ci sono', async () => {
    await page.reload()
    await items.first().waitFor()
    await items.first().getByRole('button').first().click()
    await page.getByTestId('message-user').filter({ hasText: 'Scrivi tanto' }).waitFor()
    assert.equal(await page.getByTestId('message-assistant').count(), 2)
    assert.equal(await page.getByTestId('brief-panel').getByLabel('Ruolo').inputValue(), 'Sei un tutor paziente.')
  })

  await step('attesa del modello: puntini animati e tempo trascorso fino al primo token', async () => {
    await page.selectOption('#model-select', 'lento-avvio:1b')
    await composer.fill('Sei sveglio?')
    await composer.press('Enter')
    const waiting = page.getByTestId('message-streaming').getByTestId('waiting-indicator')
    await waiting.waitFor()
    assert.match(await waiting.textContent(), /^Il modello sta elaborando·\d,\d s$/)
    assert.equal(await waiting.locator('.loader-dot').count(), 3)
    // l'animazione gira davvero: l'opacità del primo punto cambia nel tempo
    const dot = waiting.locator('.loader-dot').first()
    const sampleOpacity = async () => {
      const values = new Set()
      for (let i = 0; i < 8; i++) {
        values.add(await dot.evaluate((el) => getComputedStyle(el).opacity))
        await page.waitForTimeout(90)
      }
      return values.size
    }
    assert.equal(await dot.evaluate((el) => getComputedStyle(el).animationName), 'loader-dot')
    assert.ok((await sampleOpacity()) > 2, 'i punti devono essere animati')
    // con «riduci movimento» pulsano solo in trasparenza, senza spostarsi, ma restano animati
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await dot.evaluate((el) => getComputedStyle(el).animationName), 'loader-fade')
    assert.ok((await sampleOpacity()) > 2, 'anche con «riduci movimento» i punti devono pulsare')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // il tempo avanza
    const seconds = async () => Number((await waiting.getByTestId('elapsed').textContent()).replace(' s', '').replace(',', '.'))
    const first = await seconds()
    await page.waitForTimeout(600)
    assert.ok((await seconds()) > first, 'il tempo trascorso deve aumentare')
    // al primo token il loader sparisce e compare la risposta
    await page.getByTestId('message-assistant').last().filter({ hasText: 'Eccomi.' }).waitFor()
    assert.equal(await page.getByTestId('waiting-indicator').count(), 0)
    await page.selectOption('#model-select', 'llama3.2:3b')
  })

  await step('sidebar: rinomina, ricerca, archivia, elimina', async () => {
    // seconda conversazione
    await page.getByTestId('new-conversation').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 2)

    // quella con i messaggi ha già il titolo generato dopo il primo scambio
    const first = items.filter({ hasText: 'Ciao mondo!' })
    await first.hover()
    await first.getByTitle('Rinomina').click()
    await page.getByLabel('Titolo conversazione').fill('Lezione di italiano')
    await page.getByLabel('Titolo conversazione').press('Enter')
    await items.filter({ hasText: 'Lezione di italiano' }).waitFor()

    const search = page.getByLabel('Cerca conversazioni')
    await search.fill('parola42') // cerca anche nel testo dei messaggi
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 0)
    await search.fill('Scrivi tanto')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 1)
    await search.fill('')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 2)

    const lesson = items.filter({ hasText: 'Lezione di italiano' })
    await lesson.hover()
    await lesson.getByTitle('Archivia').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 1)
    await page.getByLabel('Mostra archiviate').check()
    await items.filter({ hasText: 'Lezione di italiano' }).waitFor()
    await page.getByLabel('Mostra archiviate').uncheck()

    page.once('dialog', (d) => d.accept())
    const other = items.first()
    await other.hover()
    await other.getByTitle('Elimina').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 0)
  })

  await step('nessun errore JavaScript nel renderer', async () => {
    assert.deepEqual(errors, [])
  })

  await page.getByLabel('Mostra archiviate').check()
  await items.first().getByRole('button').first().click()
  await page.getByTestId('message-assistant').first().waitFor()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase2.png') })

  // ------------------------------------------------------------------ fase 3
  await step('ragionamento: interruttore disabilitato se il modello non lo supporta', async () => {
    await page.getByLabel('Mostra archiviate').uncheck()
    await page.getByTestId('new-conversation').click()
    await openTab('Modello')
    await page.selectOption('#model-select', 'llama3.2:3b')
    const toggle = page.getByTestId('model-settings').getByRole('switch', { name: 'Ragionamento' })
    await page.getByTestId('thinking-capability').filter({ hasText: 'senza ragionamento' }).waitFor()
    assert.equal(await toggle.isDisabled(), true)
    await page.selectOption('#model-select', 'thinker:8b')
    await page.getByTestId('thinking-capability').filter({ hasText: /^ragionamento$/ }).waitFor()
    assert.equal(await toggle.isDisabled(), false)
    assert.equal(await toggle.isChecked(), false)
  })

  await step('temperatura e parametri avanzati arrivano a Ollama in options', async () => {
    const settings = page.getByTestId('model-settings')
    await setSwitch(settings, 'Ragionamento', true)
    await settings.getByLabel('Temperatura').fill('1.2')
    await page.getByTestId('temperature-value').filter({ hasText: '1.20' }).waitFor()
    // le impostazioni avanzate sono sempre visibili (nessun apri/chiudi)
    assert.equal(await settings.locator('details, summary').count(), 0)
    assert.equal(await settings.getByText('Impostazioni avanzate').count(), 0)

    // al cambio modello i cursori partono dai valori suggeriti: top_p dal Modelfile, memoria calcolata
    // dalla RAM (16 GB, modello da 2 GB → 32.768, che è anche il massimo del modello)
    await settings.getByTestId('top_p-value').filter({ hasText: '0,95 (consigliato dal modello)' }).waitFor()
    await settings.getByTestId('num_ctx-value').filter({ hasText: '32.768 token ≈ 24.600 parole (calcolato per questa macchina)' }).waitFor()
    await settings.getByText('Calcolato su 16 GB di RAM e un modello da 2 GB.').waitFor()
    // la temperatura è stata cambiata (1,2) e il Modelfile consiglia 0,6: compare il ripristino
    await settings.getByRole('button', { name: 'Torna al valore suggerito: Temperatura' }).filter({ hasText: '↺ Suggerito 0.60' }).waitFor()

    await settings.getByLabel('Varietà delle parole').fill('0.9')
    await settings.getByTestId('top_p-value').filter({ hasText: /^0,90$/ }).waitFor()
    await settings.getByRole('button', { name: 'Torna al valore suggerito: Varietà delle parole' }).filter({ hasText: '0,95' }).waitFor()
    const memory = settings.getByLabel('Memoria della conversazione')
    await memory.focus()
    await memory.press('ArrowLeft')
    await settings.getByTestId('num_ctx-value').filter({ hasText: '16.384 token' }).waitFor()
    await settings.getByLabel('Risposte ripetibili').fill('7')
    await page.getByTestId('composer-temperature').filter({ hasText: '1.20' }).waitFor()
    await page.waitForTimeout(400) // debounce del salvataggio
    const conv = await page.evaluate(async () => {
      const list = await window.api.conversations.list()
      return list.data[0]
    })
    assert.equal(conv.temperature, 1.2)
    assert.equal(conv.topP, 0.9)
    assert.equal(conv.numCtx, 16384)
    assert.equal(conv.seed, 7)
    assert.equal(conv.think, true)
  })

  await step('ThinkingBlock: ragionamento in streaming, poi si richiude e si riapre', async () => {
    await composer.fill('Ragiona su questo')
    await composer.press('Enter')
    const live = page.getByTestId('message-streaming')
    await live.getByText('Sta ragionando…').waitFor()
    await live.getByTestId('thinking-text').filter({ hasText: 'passo2' }).waitFor()
    // all'arrivo della risposta il blocco si chiude
    await live.filter({ hasText: 'risposta1' }).waitFor()
    assert.equal(await live.getByTestId('thinking-text').count(), 0)
    await live.waitFor({ state: 'detached' })

    const msg = page.getByTestId('message-assistant').last()
    await msg.getByText('Ragionamento · 12 parole').click()
    assert.match(await msg.getByTestId('thinking-text').textContent(), /passo0 passo1 .* passo11/)
    assert.doesNotMatch(await msg.locator('.markdown').textContent(), /passo/)

    const body = lastChat()
    assert.equal(body.think, true)
    assert.deepEqual(body.options, { temperature: 1.2, top_p: 0.9, num_ctx: 16384, seed: 7 })
  })

  await step('cursore della memoria: "↺ Suggerito" riporta al valore calcolato, che è ciò che va a Ollama', async () => {
    const settings = page.getByTestId('model-settings')
    await settings.getByRole('button', { name: 'Torna al valore suggerito: Memoria della conversazione' }).click()
    await settings.getByTestId('num_ctx-value').filter({ hasText: '32.768 token' }).waitFor()
    await waitUntil(async () => (await latestConversation()).numCtx === 32768)
  })

  await step('ragionamento spento: think=false e nessun blocco', async () => {
    await setSwitch(page.getByTestId('model-settings'), 'Ragionamento', false)
    await waitUntil(async () => (await latestConversation()).think === false)
    await composer.fill('Rispondi subito')
    await composer.press('Enter')
    await page.getByTestId('message-assistant').nth(1).waitFor()
    assert.equal(lastChat().think, false)
    assert.deepEqual(lastChat().options, { temperature: 1.2, top_p: 0.9, num_ctx: 32768, seed: 7 })
    assert.equal(await page.getByTestId('message-assistant').nth(1).getByTestId('thinking-block').count(), 0)
  })

  await step('"Tutti i valori suggeriti": temperatura e top_p dal Modelfile, memoria dalla macchina', async () => {
    const settings = page.getByTestId('model-settings')
    await settings.getByRole('button', { name: '↺ Tutti i valori suggeriti' }).click()
    await settings.getByTestId('temperature-value').filter({ hasText: '0.60 (consigliato dal modello)' }).waitFor()
    await settings.getByTestId('top_p-value').filter({ hasText: '0,95 (consigliato dal modello)' }).waitFor()
    await settings.getByTestId('num_ctx-value').filter({ hasText: '32.768 token' }).waitFor()
    await waitUntil(async () => {
      const c = await latestConversation()
      return c.temperature === 0.6 && c.topP === 0.95 && c.numCtx === 32768 && c.seed === 7
    })
    assert.equal(await settings.getByRole('button', { name: '↺ Tutti i valori suggeriti' }).count(), 0)
  })

  await step('nessun errore JavaScript nel renderer (fase 3)', async () => {
    assert.deepEqual(errors, [])
  })

  await page.getByTestId('message-assistant').first().getByTestId('thinking-text').waitFor()
  await page.getByTestId('model-settings').getByText('Varietà delle parole').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase3.png') })

  // ------------------------------------------------------------------ fase 4
  const planRequests = () => fake.requests.filter((r) => r.path === '/api/chat' && r.body?.format)

  await step('plan mode: il modello propone un piano (format = JSON schema)', async () => {
    await page.getByTestId('new-conversation').click()
    await openTab('Modello')
    await page.selectOption('#model-select', 'thinker:8b')
    await openTab('Brief')
    await page.getByTestId('brief-panel').getByLabel('Vincoli').fill('Usa esempi con la pizza.')
    await page.getByTestId('brief-panel').getByTestId('brief-status').filter({ hasText: 'Salvato' }).waitFor()
    await openTab('Modello')
    await setSwitch(page.getByTestId('model-settings'), 'Plan mode', true)
    await page.getByRole('button', { name: 'Pianifica' }).waitFor()

    const before = planRequests().length
    await composer.fill('Spiegami le frazioni')
    await composer.press('Enter')
    await page.getByTestId('plan-loading').waitFor()
    const checklist = page.getByTestId('plan-checklist')
    await checklist.waitFor()
    assert.equal(planRequests().length, before + 1)
    const req = planRequests().at(-1).body
    assert.deepEqual(req.format.required, ['steps'])
    assert.match(req.messages[0].content, /^# Vincoli\nUsa esempi con la pizza\.\n\n# Modalità piano/)
    assert.equal(await checklist.getByTestId('plan-step').count(), 3)
    // nessuna risposta dell'assistente finché il piano non è approvato
    assert.equal(await page.getByTestId('message-assistant').count(), 0)
  })

  await step('checklist: modifica, riordina, elimina e aggiungi passi', async () => {
    const checklist = page.getByTestId('plan-checklist')
    await checklist.getByLabel('Titolo del passo 1').fill('Cos\'è una frazione')
    await checklist.getByLabel('Sposta su il passo 3').click()
    // ora: 1 Cos'è una frazione, 2 Scrivere la risposta, 3 Raccogliere i punti chiave
    await checklist.getByLabel('Elimina il passo 3').click()
    await checklist.getByRole('button', { name: '+ Aggiungi passo' }).click()
    await checklist.getByLabel('Titolo del passo 3').fill('Esempio con la pizza')
    await checklist.getByLabel('Dettaglio del passo 3').fill('Una pizza in otto fette.')
    const titles = await checklist.locator('input[aria-label^="Titolo del passo"]').evaluateAll((els) => els.map((e) => e.value))
    assert.deepEqual(titles, ['Cos\'è una frazione', 'Scrivere la risposta', 'Esempio con la pizza'])
    await page.screenshot({ path: join(root, 'test-results', 'e2e-phase4-checklist.png') })
  })

  await step('approva ed esegui: il piano modificato entra nel system prompt, stato Eseguito', async () => {
    await page.getByRole('button', { name: 'Approva ed esegui' }).click()
    await page.getByTestId('message-streaming').waitFor()
    await page.getByTestId('message-assistant').first().waitFor()
    await page.getByTestId('plan-checklist').waitFor({ state: 'detached' })
    await page.getByTestId('plan-status').filter({ hasText: 'Eseguito' }).waitFor()

    const body = lastChat()
    assert.equal(body.format, undefined)
    const system = body.messages[0].content
    assert.match(system, /^# Vincoli\nUsa esempi con la pizza\.\n\n# Piano approvato\n/)
    assert.match(
      system,
      /1\. Cos'è una frazione — Riassumere cosa chiede l'utente\.\n2\. Scrivere la risposta — Rispondere in modo ordinato\.\n3\. Esempio con la pizza — Una pizza in otto fette\.$/
    )
    assert.deepEqual(body.messages.slice(1), [{ role: 'user', content: 'Spiegami le frazioni' }])
  })

  await step('rigenera il piano, poi annulla', async () => {
    await composer.fill('E i decimali?')
    await composer.press('Enter')
    const checklist = page.getByTestId('plan-checklist')
    await checklist.waitFor()
    await checklist.getByLabel('Titolo del passo 1').fill('Modifica che verrà scartata')
    const before = planRequests().length
    await checklist.getByRole('button', { name: '↻ Rigenera' }).click()
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="Titolo del passo 1"]')?.value === 'Capire la richiesta'
    )
    assert.equal(planRequests().length, before + 1)
    // lo storico del secondo piano contiene il primo scambio
    assert.deepEqual(
      planRequests().at(-1).body.messages.slice(1).map((m) => m.role),
      ['user', 'assistant', 'user']
    )
    await page.getByTestId('plan-checklist').getByRole('button', { name: 'Annulla' }).click()
    await page.getByTestId('plan-checklist').waitFor({ state: 'detached' })
    await page.getByTestId('plan-status').filter({ hasText: 'Annullato' }).waitFor()
    assert.equal(await page.getByTestId('message-assistant').count(), 1)
  })

  await step('i piani restano nello storico dopo il reload', async () => {
    await page.reload()
    await items.first().waitFor()
    await items.first().getByRole('button').first().click()
    await page.getByTestId('plan-status').filter({ hasText: 'Eseguito' }).waitFor()
    await page.getByTestId('plan-status').filter({ hasText: 'Annullato' }).waitFor()
  })

  await step('plan mode spento: si torna a "Invia"', async () => {
    await openTab('Modello')
    await setSwitch(page.getByTestId('model-settings'), 'Plan mode', false)
    await page.getByRole('button', { name: 'Invia' }).waitFor()
  })

  await step('nessun errore JavaScript nel renderer (fase 4)', async () => {
    assert.deepEqual(errors, [])
  })
  await page.getByTestId('plan-summary').first().locator('summary').click()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase4.png') })

  // ------------------------------------------------------------------ fase 5
  await step('export Markdown e JSON (brief, messaggi, piani)', async () => {
    // pulsante a sola icona con menu a tendina
    const exportBtn = page.getByRole('button', { name: 'Esporta conversazione' })
    assert.equal(((await exportBtn.textContent()) ?? '').trim(), '')
    await exportBtn.click()
    await page.getByRole('menu', { name: 'Esporta conversazione' }).waitFor()
    await page.getByRole('menuitem', { name: /Markdown/ }).click()
    await page.getByRole('menu').waitFor({ state: 'detached' })
    await page.getByTestId('export-status').filter({ hasText: 'Salvata in' }).waitFor()
    const md = readFileSync(join(userData, 'export.md'), 'utf8')
    assert.match(md, /^# .+\n\n- Modello: thinker:8b\n/)
    assert.match(md, /## Brief\n\n### Vincoli\nUsa esempi con la pizza\./)
    assert.match(md, /### Utente · .+\n\nSpiegami le frazioni\n\n#### Piano \(eseguito\)\n\n1\. Cos'è una frazione/)
    assert.match(md, /#### Piano \(annullato\)/)

    await exportBtn.click()
    await page.keyboard.press('Escape') // Esc chiude il menu
    await page.getByRole('menu').waitFor({ state: 'detached' })
    await exportBtn.click()
    await page.getByRole('menuitem', { name: /JSON/ }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="export-status"]')?.textContent?.includes('.json'))
    const json = JSON.parse(readFileSync(join(userData, 'export.json'), 'utf8'))
    assert.equal(json.format, 'fastchat-conversation')
    assert.equal(json.messages.length, 3)
    assert.deepEqual(json.plans.map((p) => p.status), ['executed', 'rejected'])
  })

  await step('salva come template e crea una conversazione dal template', async () => {
    await openTab('Brief')
    const panel = page.getByTestId('brief-panel')
    await panel.getByRole('button', { name: 'Salva come template' }).click()
    await panel.getByLabel('Nome del template').fill('Tutor pizza')
    await panel.getByRole('button', { name: 'Salva', exact: true }).click()
    await panel.getByText('Template salvato').waitFor()

    await page.getByRole('button', { name: 'Nuova da template' }).click()
    await page.getByTestId('template-menu').getByRole('button', { name: 'Tutor pizza' }).click()
    await page.locator('header h1', { hasText: 'Nuova conversazione' }).waitFor()
    assert.equal(await page.getByTestId('brief-panel').getByLabel('Vincoli').inputValue(), 'Usa esempi con la pizza.')
    assert.equal(await page.locator('#model-select').inputValue(), 'thinker:8b')
    assert.equal(await page.getByTestId('messages').getByTestId('message-user').count(), 0)
  })

  await step('impostazioni: verifica URL, tema scuro, modello predefinito', async () => {
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const dialog = page.getByTestId('settings-dialog')
    await dialog.waitFor()
    const url = dialog.getByLabel('URL di Ollama')
    assert.equal(await url.inputValue(), fake.url)
    await dialog.getByRole('button', { name: 'Verifica' }).click()
    await dialog.getByTestId('settings-check').filter({ hasText: 'Connesso · 5 modelli' }).waitFor()
    await url.fill('http://127.0.0.1:1')
    await dialog.getByRole('button', { name: 'Verifica' }).click()
    await dialog.getByTestId('settings-check').filter({ hasText: 'non raggiungibile' }).waitFor()
    // la verifica non salva nulla
    assert.equal((await page.evaluate(() => window.api.settings.get())).data.ollamaUrl, fake.url)
    await url.fill(fake.url)
    await dialog.getByLabel('Tema').selectOption('dark')
    await dialog.getByLabel('Modello predefinito').selectOption('llama3.2:3b')
    await dialog.getByRole('button', { name: 'Salva' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    const saved = (await page.evaluate(() => window.api.settings.get())).data
    assert.equal(saved.theme, 'dark')
    assert.equal(saved.defaultModel, 'llama3.2:3b')
    await page.getByTestId('new-conversation').click()
    await page.waitForFunction(() => document.querySelector('#model-select')?.value === 'llama3.2:3b')
  })

  await step('campo di scrittura: altezza dinamica fino al 40% della finestra; barre invisibili', async () => {
    const box = page.getByLabel('Messaggio')
    const height = () => box.evaluate((el) => el.getBoundingClientRect().height)
    await box.fill('')
    const oneLine = await height()
    // il placeholder lungo non fa crescere il campo vuoto
    assert.ok(oneLine < 50, `campo vuoto alto ${oneLine}px`)

    await box.fill('riga\nriga\nriga\nriga\nriga')
    const five = await height()
    assert.ok(five > oneLine * 2.5, `5 righe: ${five}px contro ${oneLine}px`)

    await box.fill(Array.from({ length: 80 }, (_, i) => `riga ${i}`).join('\n'))
    const capped = await box.evaluate((el) => ({
      h: el.getBoundingClientRect().height,
      max: window.innerHeight * 0.4,
      scrolls: el.scrollHeight > el.clientHeight
    }))
    assert.ok(capped.h <= capped.max + 1, `80 righe: ${capped.h}px oltre il 40% (${capped.max}px)`)
    assert.ok(capped.scrolls, 'oltre il limite il testo deve scorrere dentro il campo')
    await page.screenshot({ path: join(root, 'test-results', 'e2e-composer.png') })

    // una riga molto lunga va a capo: più spazio orizzontale (pannello chiuso) = campo più basso
    await box.fill('parola '.repeat(70))
    const withPanel = await height()
    const panelBtn = page.getByRole('button', { name: 'Nascondi il pannello della conversazione' })
    assert.equal(await panelBtn.getAttribute('aria-pressed'), 'true')
    await panelBtn.click()
    await page.waitForFunction((h) => document.querySelector('textarea[aria-label="Messaggio"]').getBoundingClientRect().height < h, withPanel)
    const showBtn = page.getByRole('button', { name: 'Mostra il pannello della conversazione' })
    assert.equal(await showBtn.getAttribute('aria-pressed'), 'false')
    // tooltip al passaggio del mouse
    await showBtn.hover()
    await page.waitForFunction(() => {
      const tip = [...document.querySelectorAll('[role="tooltip"]')].find((t) => t.textContent === 'Mostra il pannello della conversazione')
      return tip && getComputedStyle(tip).opacity === '1'
    })
    await showBtn.click()
    await page.waitForFunction((h) => Math.abs(document.querySelector('textarea[aria-label="Messaggio"]').getBoundingClientRect().height - h) < 2, withPanel)

    // dopo l'invio il campo torna a una riga
    await box.fill('Ciao\ndi nuovo\nsu tre righe')
    await box.press('Enter')
    await page.waitForFunction((h) => document.querySelector('textarea[aria-label="Messaggio"]').getBoundingClientRect().height <= h + 1, oneLine)

    const scrollbars = await page.evaluate(() =>
      [
        document.querySelector('[data-testid="messages"]').parentElement,
        document.querySelector('[data-testid="brief-panel"]'),
        document.querySelector('textarea[aria-label="Messaggio"]'),
        document.querySelector('ul[aria-label="Conversazioni"]')
      ].map((el) => getComputedStyle(el).scrollbarWidth)
    )
    assert.deepEqual(scrollbars, ['none', 'none', 'none', 'none'])
  })

  await step('pannello a schede: Modello / Brief, indicatore del brief, tastiera, scheda ricordata', async () => {
    const modelPanel = page.locator('#panel-model')
    const briefPanel = page.locator('#panel-brief')
    await openTab('Modello')
    assert.equal(await modelPanel.isVisible(), true)
    assert.equal(await briefPanel.isVisible(), false)

    await openTab('Brief')
    assert.equal(await briefPanel.isVisible(), true)
    assert.equal(await modelPanel.isVisible(), false)
    // brief vuoto: nessun indicatore; compilando un campo compare il •
    const role = briefPanel.getByLabel('Ruolo')
    await role.fill('')
    await page.getByTestId('brief-filled').waitFor({ state: 'detached' })
    await role.fill('Sei un assistente')
    await page.getByTestId('brief-filled').waitFor()
    await page.getByRole('tab', { name: 'Brief (compilato)' }).waitFor()

    // frecce: dalla scheda Brief si passa a Modello
    await page.getByRole('tab', { name: 'Brief' }).focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(() => document.getElementById('panel-tab-model')?.getAttribute('aria-selected') === 'true')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'panel-tab-model')

    // dopo il riavvio della pagina si riapre l'ultima scheda scelta (Modello)
    await page.reload()
    await items.first().waitFor()
    await items.first().getByRole('button').first().click()
    await page.waitForFunction(() => document.getElementById('panel-tab-model')?.getAttribute('aria-selected') === 'true')
    assert.equal(await page.locator('#panel-model').isVisible(), true)
  })

  await step('barra laterale: logo e nome in cima, pulsante con freccia dei preset, sezione Conversazioni', async () => {
    const side = page.getByRole('complementary', { name: 'Barra laterale' })
    assert.equal(await side.getByTestId('app-name').textContent(), 'FastChat')
    // ordine verticale: nome, pulsante, titolo della sezione, ricerca
    const y = async (loc) => (await loc.boundingBox()).y
    const name = await y(side.getByTestId('app-name'))
    const button = await y(side.getByTestId('new-conversation'))
    const heading = side.getByRole('heading', { name: 'Conversazioni' })
    const section = await y(heading)
    const search = await y(side.getByLabel('Cerca conversazioni'))
    assert.ok(name < button && button < section && section < search, `ordine: ${name}, ${button}, ${section}, ${search}`)

    // la freccia è attaccata al pulsante e apre i preset sopra la lista, senza spostarla
    const listY = await y(side.getByRole('list', { name: 'Conversazioni' }))
    await side.getByRole('button', { name: 'Nuova da template' }).click()
    await side.getByTestId('template-menu').waitFor()
    assert.equal(await y(side.getByRole('list', { name: 'Conversazioni' })), listY)
    await page.keyboard.press('Escape')
    await side.getByTestId('template-menu').waitFor({ state: 'detached' })
  })

  await step('finestra senza barra di sistema: controlli dopo il pulsante del pannello, topbar trascinabile', async () => {
    const controls = page.getByTestId('window-controls')
    await controls.waitFor()
    const panelBtn = page.getByRole('button', { name: /il pannello della conversazione$/ })
    assert.ok((await panelBtn.boundingBox()).x < (await controls.boundingBox()).x, 'i controlli vengono dopo il pulsante del pannello')
    for (const name of ['Riduci a icona', 'Ingrandisci', 'Chiudi']) await controls.getByRole('button', { name }).waitFor()

    // la topbar si trascina, i suoi controlli restano cliccabili
    const regions = await page.evaluate(() => {
      const r = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')
      const header = document.querySelector('header')
      return { header: r(header), button: r(header.querySelector('button')), select: r(document.querySelector('#model-select')) }
    })
    assert.deepEqual(regions, { header: 'drag', button: 'no-drag', select: 'no-drag' })

    // Sotto Xvfb non c'è un window manager: ingrandire/ridurre non avrebbe effetto. Si simula il WM
    // sostituendo i metodi della finestra nel main (stessi eventi), così si verifica tutta la catena
    // pulsante → IPC → finestra → evento → icona.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const state = { maximized: false, minimized: false, calls: [] }
      globalThis.__wm = state
      win.isMaximized = () => state.maximized
      win.maximize = () => { state.calls.push('maximize'); state.maximized = true; win.emit('maximize') }
      win.unmaximize = () => { state.calls.push('unmaximize'); state.maximized = false; win.emit('unmaximize') }
      win.minimize = () => { state.calls.push('minimize'); state.minimized = true }
    })
    const wm = () => app.evaluate(() => globalThis.__wm)
    await controls.getByRole('button', { name: 'Ingrandisci' }).click()
    await controls.getByRole('button', { name: 'Ripristina' }).waitFor()
    await controls.getByRole('button', { name: 'Ripristina' }).click()
    await controls.getByRole('button', { name: 'Ingrandisci' }).waitFor()
    await controls.getByRole('button', { name: 'Riduci a icona' }).click()
    await waitUntil(async () => (await wm()).minimized)
    assert.deepEqual((await wm()).calls, ['maximize', 'unmaximize', 'minimize'])
  })

  await step('allineamento: blocco del logo e topbar alla stessa altezza, contenuti centrati sulla stessa linea', async () => {
    const side = page.getByRole('complementary', { name: 'Barra laterale' })
    const center = async (loc) => {
      const b = await loc.boundingBox()
      return b.y + b.height / 2
    }
    const title = page.locator('header h1')
    const header = await page.locator('header').boundingBox()
    const logoRow = await side.getByTestId('app-name').locator('..').boundingBox()
    assert.ok(Math.abs(header.height - logoRow.height) <= 1, `altezze: topbar ${header.height}, logo ${logoRow.height}`)
    const t = await center(title)
    for (const [name, loc] of [
      ['nome', side.getByTestId('app-name')],
      ['pulsante della barra', side.getByRole('button', { name: 'Chiudi la barra laterale' })],
      ['pulsante del pannello', page.getByRole('button', { name: /il pannello della conversazione$/ })]
    ]) {
      const c = await center(loc)
      assert.ok(Math.abs(c - t) <= 1.5, `${name} a ${c}, titolo a ${t}`)
    }
  })

  await step('barra laterale richiudibile: striscia con logo e azioni rapide, stato ricordato', async () => {
    const side = page.getByRole('complementary', { name: 'Barra laterale' })
    const width = async () => (await side.boundingBox()).width
    const open = await width()
    const before = await items.count()
    // il pulsante sta a destra nel blocco del logo, dopo il nome
    const closeBtn = side.getByRole('button', { name: 'Chiudi la barra laterale' })
    assert.ok((await closeBtn.boundingBox()).x > (await side.getByTestId('app-name').boundingBox()).x)
    await closeBtn.click()

    // chiusa: striscia stretta con logo, riapri, nuova conversazione e impostazioni
    await side.getByRole('button', { name: 'Apri la barra laterale' }).waitFor()
    assert.ok((await width()) < 90 && (await width()) < open / 2, `larghezza chiusa: ${await width()}`)
    assert.equal(await side.getByLabel('Cerca conversazioni').count(), 0)
    assert.equal(await side.getByTestId('app-name').count(), 0)
    {
      const logo = await side.locator('span[aria-hidden="true"]').first().boundingBox()
      const title = await page.locator('header h1').boundingBox()
      const diff = Math.abs(logo.y + logo.height / 2 - (title.y + title.height / 2))
      assert.ok(diff <= 1.5, `striscia chiusa: logo disallineato di ${diff}px`)
    }
    for (const name of ['Nuova conversazione', 'Impostazioni']) await side.getByRole('button', { name }).waitFor()
    // tooltip a destra della striscia (non fuori dalla finestra)
    const plus = side.getByTestId('new-conversation-rail')
    await plus.hover()
    const tip = page.getByRole('tooltip', { name: 'Nuova conversazione' })
    await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('[role="tooltip"]')].find((el) => el.textContent === 'Nuova conversazione')
      return t && getComputedStyle(t).opacity === '1'
    })
    assert.ok((await tip.boundingBox()).x > (await plus.boundingBox()).x)
    // azioni rapide funzionanti
    await plus.click()
    await page.locator('header h1', { hasText: 'Nuova conversazione' }).waitFor()
    await side.getByRole('button', { name: 'Impostazioni' }).click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('settings-dialog').waitFor({ state: 'detached' })

    // lo stato resta dopo il riavvio della pagina
    await page.reload()
    await side.getByRole('button', { name: 'Apri la barra laterale' }).waitFor()
    await side.getByRole('button', { name: 'Apri la barra laterale' }).click()
    await side.getByRole('button', { name: 'Chiudi la barra laterale' }).waitFor()
    assert.equal(Math.round(await width()), Math.round(open))
    assert.equal(await items.count(), before + 1)
    await items.first().getByRole('button').first().click()
  })

  await step('cronologia: un pallino per messaggio, estratto al passaggio del mouse, clic per saltare', async () => {
    await page.getByTestId('new-conversation').click()
    await page.locator('header h1', { hasText: 'Nuova conversazione' }).waitFor()
    const timeline = page.getByRole('navigation', { name: 'Cronologia della conversazione' })
    const dots = timeline.getByTestId('timeline-dot')
    assert.equal(await dots.count(), 0)

    const composer = page.getByRole('textbox', { name: 'Messaggio' })
    const lines = Array.from({ length: 25 }, (_, i) => `riga ${i + 1} del testo`).join('\n')
    for (let n = 1; n <= 4; n++) {
      await composer.fill(`Domanda ${n} sul **tema**\n${lines}`)
      await composer.press('Enter')
      await waitUntil(async () => (await page.getByTestId('message-assistant').count()) === n)
    }
    await dots.nth(7).waitFor()
    assert.equal(await dots.count(), 8)
    assert.deepEqual(
      await dots.evaluateAll((els) => els.map((el) => el.dataset.role)),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']
    )
    // la linea prende tutta l'altezza della colonna; pallini in ordine, a distanze non regolari
    const railBox = await timeline.boundingBox()
    const area = await page.getByTestId('messages').locator('..').boundingBox()
    assert.ok(railBox.height > area.height - 40, `linea alta ${railBox.height} su ${area.height}`)
    const ys = await dots.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 13, `pallini ${i - 1}/${i} troppo vicini`)
    const gaps = ys.slice(1).map((y, i) => y - ys[i])
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 20, `distanze: ${gaps.join(', ')}`)

    // in fondo è evidenziato l'ultimo messaggio
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-dot"]')[7]?.getAttribute('aria-current') === 'true')

    // estratto nel tooltip, senza Markdown
    await dots.nth(2).hover()
    const tip = page.getByTestId('timeline-tooltip')
    await tip.waitFor()
    assert.match(await tip.textContent(), /^Tu · Oggi, \d{2}:\d{2}Domanda 2 sul tema riga 1 del testo/)
    await dots.nth(3).hover()
    assert.match(await tip.textContent(), /^Assistente · Oggi, \d{2}:\d{2}Ciao mondo!$/)

    // clic: il messaggio arriva in cima all'area e il suo pallino diventa quello attivo
    const scroller = page.getByTestId('messages').locator('..')
    const target = page.getByTestId('message-user').filter({ hasText: 'Domanda 2' })
    await dots.nth(2).click()
    await waitUntil(async () => {
      const top = (await target.boundingBox()).y - (await scroller.boundingBox()).y
      return top >= 0 && top < 40
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-dot"]')[2]?.getAttribute('aria-current') === 'true')

    // da tastiera: Invio su un pallino
    await dots.nth(0).focus()
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await scroller.evaluate((el) => el.scrollTop)) < 30)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-dot"]')[0]?.getAttribute('aria-current') === 'true')
    await page.screenshot({ path: join(root, 'test-results', 'e2e-timeline.png') })
  })

  await step('nessun errore JavaScript nel renderer (fase 5)', async () => {
    assert.deepEqual(errors, [])
  })

  // conversazione del plan mode (titolo generato dalla risposta «risposta0 …»), con piani e messaggi
  await items.filter({ hasText: 'risposta0' }).first().getByRole('button').first().click()
  await page.getByTestId('message-assistant').first().waitFor()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase5-dark.png') })
} catch (err) {
  failed = true
  console.error(err)
} finally {
  await app.close()
  await fake.close()
  rmSync(userData, { recursive: true, force: true })
}

console.log(steps.join('\n'))
process.exit(failed ? 1 : 0)
