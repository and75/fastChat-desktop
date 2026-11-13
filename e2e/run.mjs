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
  // risponde sempre con done_reason "length": simula una risposta tagliata al limite di token
  { name: 'cut:1b', capabilities: ['completion'], doneReason: 'length', chunks: [{ content: 'Inizio della risposta…' }] },
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
const isTitleRequest = (body) => /^(Genera un titolo|Generate a short title|Génère un titre)/.test(body?.messages?.[0]?.content ?? '')
// Nemmeno le richieste del riassunto automatico (dopo la risposta) contano come "ultima chat".
const isSummaryRequest = (body) => /^(Sei l'archivista|You are the archivist|Tu es l'archiviste)/.test(body?.messages?.[0]?.content ?? '')
const chatRequests = () => fake.requests.filter((r) => r.path === '/api/chat' && !isTitleRequest(r.body) && !isSummaryRequest(r.body))
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
    // Pacchetti: «Esporta…» scrive qui e «Importa pacchetto…» legge lo stesso file, senza dialog.
    FASTCHAT_PACK_EXPORT: join(userData, 'archivio.fcpack'),
    FASTCHAT_PACK_FILE: join(userData, 'archivio.fcpack'),
    // Monitor del contesto: «Esporta CSV» scrive qui, senza dialog.
    FASTCHAT_CONTEXT_EXPORT: join(userData, 'contesto.csv'),
    // Base di conoscenza: «Aggiungi documenti» salta il dialog e aggiunge questi file.
    FASTCHAT_KNOWLEDGE_FILES: [join(root, 'tests', 'fixtures', 'relazione.txt'), join(root, 'tests', 'fixtures', 'bilancio.pdf')].join(process.platform === 'win32' ? ';' : ':'),
    // Macchina finta: 16 GB di RAM. Con un modello da 2 GB e 128 KiB per token la memoria suggerita
    // è ~115k, limitata al massimo del modello: 32.768 (thinker:8b), 8.192 per quelli con contesto 8k.
    FASTCHAT_LANG: 'it',
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
  /** Apre una scheda del pannello di destra (Modello / Situazione / Conoscenza) e attende che sia attiva. */
  /** I gruppi del pannello Modello partono chiusi: per i test li si apre (la scelta resta in localStorage). */
  const openGroups = () =>
    page.evaluate(() => document.querySelectorAll('[data-testid="model-settings"] details[data-group]').forEach((d) => (d.open = true)))
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
    assert.deepEqual(options, ['cut:1b', 'lento-avvio:1b', 'llama3.2:3b', 'qwen3:4b', 'slow:1b', 'thinker:8b'])
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

  /** Scrive la situazione della conversazione aperta e attende che sia salvata. */
  const writeSituation = async (text, saved = 'Salvato', tab = 'Situazione') => {
    await openTab(tab)
    const panel = page.getByTestId('conversation-panel')
    await panel.getByTestId('situation-text').fill(text)
    await panel.getByTestId('situation-status').filter({ hasText: saved }).waitFor()
  }

  await step('situazione: si salva da sola, con il contatore; l\'anteprima mostra ciò che riceve il modello', async () => {
    const panel = page.getByTestId('conversation-panel')
    await writeSituation('# Ruolo\nSei un tutor paziente.\n\n# Vincoli\nRispondi solo in italiano.')
    // contatore: caratteri scritti sul limite (5% della memoria del modello)
    assert.match(await panel.getByTestId('situation-count').textContent(), /^68 di 1\.638 caratteri$/)
    assert.equal(
      await panel.getByTestId('system-preview').textContent(),
      '# Ruolo\nSei un tutor paziente.\n\n# Vincoli\nRispondi solo in italiano.'
    )
  })

  await step('invio: risposta in streaming e situazione inviata come primo messaggio system', async () => {
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
    assert.equal(await page.getByTestId('conversation-panel').getByTestId('situation-text').inputValue(), '# Ruolo\nSei un tutor paziente.\n\n# Vincoli\nRispondi solo in italiano.')
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
    await openGroups()
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
    // quattro gruppi richiudibili: dove gira, come sceglie le parole, come risponde, cosa ricorda
    assert.deepEqual(await settings.locator('details[data-group]').evaluateAll((els) => els.map((d) => d.dataset.group)), ['run', 'words', 'answer', 'memory'])
    assert.equal(await settings.getByTestId('execution-row').isVisible(), true)

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
    // nessun num_predict: la lunghezza della risposta la governa lo stile nel system prompt
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

  await step('stile della risposta: istruzione nel system prompt (pannello e composer), nessun limite di token', async () => {
    const settings = page.getByTestId('model-settings')
    const control = settings.getByTestId('style-control')
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    assert.equal(await control.getByRole('radio', { name: 'Normale' }).getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByTestId('composer-style').inputValue(), 'normal')
    // il misuratore mostra la soglia del riassunto (70%) e la spiega nel tooltip
    assert.equal(await page.getByTestId('context-usage').getByTestId('context-threshold').getAttribute('style'), 'left: 70%;')
    assert.match(await page.getByTestId('context-usage').getAttribute('title'), /Oltre il 70% i messaggi più vecchi vengono riassunti prima della risposta/)

    await control.getByRole('radio', { name: 'Conciso' }).click()
    await waitUntil(async () => (await latestConversation()).style === 'concise')
    assert.equal(await page.getByTestId('composer-style').inputValue(), 'concise')
    await control.getByTestId('style-hint').filter({ hasText: 'Dritto al punto' }).waitFor()
    await openTab('Situazione')
    await page.getByTestId('system-preview').filter({ hasText: '# Stile della risposta' }).waitFor()
    await openTab('Modello')

    await box.fill('In breve?')
    await box.press('Enter')
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    const body = lastChat()
    assert.equal(body.messages[0].role, 'system')
    assert.match(body.messages[0].content, /^# Stile della risposta\nVai dritto al punto[\s\S]*La brevità non deve costare precisione/)
    assert.equal('num_predict' in body.options, false)

    // dal composer: Essenziale; poi Normale → nessuna sezione (e nessun system prompt, senza brief)
    await page.getByTestId('composer-style').selectOption('essential')
    await waitUntil(async () => (await latestConversation()).style === 'essential')
    assert.equal(await control.getByRole('radio', { name: 'Essenziale' }).getAttribute('aria-checked'), 'true')
    await control.getByRole('radio', { name: 'Normale' }).click()
    await waitUntil(async () => (await latestConversation()).style === 'normal')
  })

  await step('risposta tagliata al limite: avviso e "Continua" che chiede di proseguire', async () => {
    await page.selectOption('#model-select', 'cut:1b')
    // (con i pallini della cronologia, "Messaggio" non è più un'etichetta univoca)
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    await box.fill('Scrivi un testo lungo')
    await box.press('Enter')
    const msg = page.getByTestId('message-assistant').last()
    await msg.getByTestId('truncated-note').filter({ hasText: 'Risposta interrotta: memoria esaurita' }).waitFor()
    await msg.getByTestId('continue-answer').click()
    await page.getByTestId('message-user').last().filter({ hasText: 'Continua da dove ti sei fermato' }).waitFor()
    await page.getByTestId('message-assistant').last().getByTestId('truncated-note').waitFor()
    const body = lastChat()
    assert.equal(body.messages.at(-1).content, 'Continua da dove ti sei fermato, senza ripetere quanto già scritto.')
    assert.equal(body.messages.at(-2).content, 'Inizio della risposta…')
    // il pulsante compare solo sull'ultima risposta
    assert.equal(await page.getByTestId('continue-answer').count(), 1)
    await page.selectOption('#model-select', 'thinker:8b')
  })

  await step('riassunto automatico: prima della risposta, con stato visibile, scheda nel flusso e modifica', async () => {
    const settings = page.getByTestId('model-settings')
    const panel = settings.getByTestId('summary-panel')
    await panel.getByText('Nessun riassunto').waitFor()
    // memoria minima (1.024): i messaggi già scambiati + uno da 1.200 caratteri superano il 70%
    const memory = settings.getByRole('slider', { name: 'Memoria della conversazione' })
    await memory.focus()
    await memory.press('Home')
    await waitUntil(async () => (await latestConversation()).numCtx === 1024)
    // sotto il minimo del modello (4.096, num_ctx del Modelfile di thinker:8b): avviso e cursore rosso
    await settings.getByTestId('num_ctx-warning').filter({ hasText: 'Sotto il minimo per questo modello (4.096 token' }).waitFor()
    assert.equal(await memory.getAttribute('data-warning'), 'true')
    assert.match(await memory.getAttribute('class'), /accent-red-600/)
    const before = (await page.evaluate(() => window.api.conversations.list())).data // (solo per contare)
    const total = (await page.evaluate(async (id) => (await window.api.conversations.get(id)).data.messages.length, before[0].id))
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    const summaryRequests = () => fake.requests.filter((r) => isSummaryRequest(r.body)).map((r) => r.body)
    const firstSummaryIdx = summaryRequests().length
    // ~2.400 caratteri: con i messaggi già scambiati il totale supera il 70% di 1.024 token
    await box.fill('Dati: ' + 'd'.repeat(2400))
    await box.press('Enter')
    // PRIMA della risposta: i messaggi più vecchi vengono riassunti, e si vede
    await page.getByTestId('message-streaming').getByText('Sto riassumendo i messaggi più vecchi').waitFor()
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })

    // la risposta è partita già con il riassunto nel system prompt e solo i messaggi non coperti
    const body = lastChat()
    assert.match(body.messages[0].content, /^# Riassunto della conversazione finora\nrisposta0 risposta1/)
    const sentAfterSummary = body.messages.filter((m) => m.role !== 'system')
    assert.ok(sentAfterSummary.length <= 2, `inviati ${sentAfterSummary.length} messaggi oltre al riassunto`)
    assert.match(sentAfterSummary.at(-1).content, /^Dati: d/)
    const summaryReq = summaryRequests()[firstSummaryIdx]
    assert.equal(summaryReq.think, false)
    assert.equal(summaryReq.options.num_ctx, 1024)
    assert.match(summaryReq.messages[1].content, /^Messaggi:\n/)

    // la scheda nel flusso, al confine con i messaggi inviati per intero: stesso numero del database
    const card = page.getByTestId('summary-card')
    const coveredNow = async () => {
      const c = await latestConversation()
      const msgs = (await page.evaluate(async (id) => (await window.api.conversations.get(id)).data.messages, c.id))
      return msgs.findIndex((m) => m.id === c.summaryUpTo) + 1
    }
    const covered = await coveredNow()
    assert.ok(covered >= total - 1, `coperti ${covered} su ${total} messaggi precedenti`)
    await card.getByText(`copre i ${covered} messaggi qui sopra`).waitFor()
    await card.getByTestId('summary-preview').filter({ hasText: /^risposta0 risposta1/ }).waitFor()
    assert.equal((await page.getByTestId('timeline-dot').evaluateAll((els) => els.filter((e) => e.dataset.summarized === 'true').length)), covered)
    await panel.getByText(/Riassunto in vigore: copre i primi \d+ messaggi, aggiornato alle \d{2}:\d{2}\./).waitFor()
    assert.match(await page.getByTestId('context-usage').getAttribute('title'), /nel riassunto automatico/)
    // la scheda sta subito dopo l'ultimo messaggio coperto
    const order = await page.evaluate(() => [...document.querySelectorAll('[data-message-id]')].map((e) => e.dataset.messageId))
    assert.equal(order.indexOf('summary'), covered)

    // la conversazione continua normalmente
    await box.fill('E quindi?')
    await box.press('Enter')
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    const coveredBeforeLong = await coveredNow()
    const countBefore = summaryRequests().length

    // un messaggio lungo porta oltre il 70%: prima della risposta il riassunto si aggiorna in modo incrementale
    await box.fill('Altri dati: ' + 'e'.repeat(2400))
    await box.press('Enter')
    await page.getByTestId('message-streaming').getByText('Sto riassumendo i messaggi più vecchi').waitFor()
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    await waitUntil(async () => (await coveredNow()) > coveredBeforeLong)
    await card.getByText(`copre i ${await coveredNow()} messaggi qui sopra`).waitFor()
    const incremental = summaryRequests()[countBefore]
    assert.match(incremental.messages[1].content, /^Riassunto finora:\nrisposta0 [\s\S]*\n\nNuovi messaggi:\n/)
    assert.match(lastChat().messages.filter((m) => m.role !== 'system').at(-1).content, /^Altri dati: e/)

    // mostra e modifica nella scheda, poi elimina
    await card.getByTestId('summary-toggle').click()
    const text = card.getByTestId('summary-text')
    assert.match(await text.inputValue(), /^risposta0/)
    await text.fill('Riassunto scritto a mano.')
    await text.blur()
    await waitUntil(async () => (await latestConversation()).summary === 'Riassunto scritto a mano.')
    await panel.getByTestId('summary-goto').click()
    await card.getByTestId('summary-clear').click()
    await card.waitFor({ state: 'detached' })
    await panel.getByText('Nessun riassunto').waitFor()
    await waitUntil(async () => (await latestConversation()).summary === null && (await latestConversation()).summaryUpTo === null)
    assert.equal((await page.getByTestId('timeline-dot').evaluateAll((els) => els.filter((e) => e.dataset.summarized === 'true').length)), 0)
    // interruttore spento: all'invio non si riassume; "Riassumi ora" funziona comunque (manuale)
    await setSwitch(settings, 'Riassunto automatico', false)
    await waitUntil(async () => (await latestConversation()).autoSummary === false)
    await panel.getByTestId('summary-now').click()
    await card.waitFor()
    await setSwitch(settings, 'Riassunto automatico', true)
    await memory.focus()
    await memory.press('End')
    await waitUntil(async () => (await latestConversation()).numCtx === 32768)
    // sopra il minimo: niente avviso, cursore normale
    assert.equal(await settings.getByTestId('num_ctx-warning').count(), 0)
    assert.equal(await memory.getAttribute('data-warning'), null)
  })

  await step('memoria a lungo termine: scarica embeddinggemma, estratti nel prompt e sotto la risposta', async () => {
    const panel = page.getByTestId('model-settings').getByTestId('memory-panel')
    // c'è un riassunto, ma il modello di embedding non è installato
    await panel.getByTestId('memory-status').filter({ hasText: 'Serve il modello di embedding embeddinggemma' }).waitFor()
    await panel.getByTestId('memory-download').click()
    await panel.getByTestId('memory-status').filter({ hasText: /pezz[io] (indicizzat|da indicizzare)|da indicizzare/ }).waitFor()
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    await box.fill('Ripetimi la risposta sui dati di prima')
    await box.press('Enter')
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    // estratti nel system prompt, dopo il riassunto, con l'avvertenza sulle correzioni
    const system = lastChat().messages[0].content
    assert.ok(system.indexOf('# Riassunto della conversazione finora') < system.indexOf('# Dalla conversazione precedente'), 'estratti dopo il riassunto')
    assert.match(system, /valgono il riassunto e i messaggi recenti/)
    const embeds = fake.requests.filter((r) => r.path === '/api/embed')
    assert.ok(embeds.length >= 2, 'indicizzazione + domanda')
    // sotto la risposta: quali estratti, e un clic porta al messaggio
    const refs = page.getByTestId('message-assistant').last().getByTestId('memory-refs')
    await refs.getByText(/Ha usato \d+ estratt[io] della conversazione/).click()
    await refs.getByRole('button', { name: /Messaggio \d+ · (tu|assistente)/ }).first().click()
    await panel.getByTestId('memory-status').filter({ hasText: /\d+ pezz[io] indicizzat/ }).waitFor()
    await refs.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(root, 'test-results', 'e2e-memory.png') })
    // spenta: niente più estratti
    await setSwitch(page.getByTestId('model-settings'), 'Memoria a lungo termine', false)
    await waitUntil(async () => (await latestConversation()).longMemory === false)
    await box.fill('E ancora sui dati?')
    await box.press('Enter')
    await page.getByTestId('message-assistant').last().filter({ hasText: 'risposta0' }).waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    assert.doesNotMatch(lastChat().messages[0].content, /# Dalla conversazione precedente/)
    await setSwitch(page.getByTestId('model-settings'), 'Memoria a lungo termine', true)
  })

  await step('nessun errore JavaScript nel renderer (fase 3)', async () => {
    assert.deepEqual(errors, [])
  })

  await page.getByTestId('message-assistant').first().getByTestId('thinking-text').waitFor()
  await page.getByTestId('model-settings').getByText('Varietà delle parole').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase3.png') })

  await step('base di conoscenza: scheda, documenti (testo e PDF), estratti con fonte, bottone libro per una domanda, interruttore', async () => {
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    const book = page.getByTestId('knowledge-button')
    const ask = async (text) => {
      const n = chatRequests().length
      await box.fill(text)
      await box.press('Enter')
      await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 60_000 })
      await waitUntil(() => chatRequests().length > n)
      return chatRequests().at(-1).body.messages[0]
    }
    // conversazione nuova: senza documenti la scheda è vuota e il bottone libro è disabilitato
    await page.getByTestId('new-conversation').click()
    await page.selectOption('#model-select', 'llama3.2:3b')
    await openTab('Conoscenza')
    const panel = page.getByTestId('knowledge-panel')
    await panel.getByTestId('knowledge-status').filter({ hasText: 'Nessun documento' }).waitFor()
    assert.equal(await book.isDisabled(), true)
    assert.equal(await page.getByRole('switch', { name: 'Usa la base di conoscenza' }).isChecked(), true)
    // aggiunta (dialog saltato): un testo e un PDF, indicizzati in sottofondo; il puntino sulla scheda
    await panel.getByTestId('knowledge-add').click()
    await panel.locator('[data-testid="knowledge-doc"][data-status="ready"]').nth(1).waitFor({ timeout: 30_000 })
    await panel.getByTestId('knowledge-status').filter({ hasText: /2 documenti, \d+ pezzi indicizzati con embeddinggemma/ }).waitFor()
    await page.getByRole('tab', { name: 'Conoscenza (compilato)' }).waitFor()
    const rows = await panel.getByTestId('knowledge-doc').allInnerTexts()
    assert.match(rows[0], /relazione[\s\S]*Testo e Markdown/)
    assert.match(rows[1], /bilancio[\s\S]*PDF/)
    assert.ok(fake.requests.some((r) => r.path === '/api/embed' && r.body.input.some((x) => x.includes('Genova'))), 'il PDF è stato indicizzato')
    await page.waitForFunction(() => document.querySelector('[data-testid="knowledge-button"]')?.getAttribute('aria-pressed') === 'true')
    // domanda: «Cerco nei documenti», sezione nel system prompt con la fonte, fonti sotto la risposta
    const n0 = chatRequests().length
    await box.fill('Quante persone ha assunto la sede di Torino?')
    await box.press('Enter')
    await page.getByTestId('message-streaming').getByText('Cerco nei documenti').waitFor({ timeout: 20_000 }).catch(() => undefined)
    await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 60_000 })
    await waitUntil(() => chatRequests().length > n0)
    let system = chatRequests().at(-1).body.messages[0]
    assert.equal(system.role, 'system')
    assert.match(system.content, /# Base di conoscenza/)
    assert.match(system.content, /\[relazione\]\n[\s\S]*Torino/)
    const refs = page.getByTestId('message-assistant').last().getByTestId('knowledge-refs')
    await refs.getByText(/\d+ font[ei] dai documenti/).click()
    await refs.getByText(/^relazione/).first().waitFor()
    await refs.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(root, 'test-results', 'e2e-knowledge.png') })
    // monitor del contesto: la voce «Estratti dei documenti» nell'ultima risposta
    const calls = (await page.evaluate((id) => window.api.context.calls(id), (await latestConversation()).id)).data
    const chatCall = calls.find((c) => c.kind === 'chat')
    assert.ok(chatCall.parts.some((p) => p.key === 'knowledge' && p.count >= 1), 'voce knowledge nel monitor')
    assert.ok(calls.some((c) => c.kind === 'embed-doc'), 'indicizzazione dei documenti nel monitor')
    // bottone libro spento per una domanda sola: niente sezione, poi torna acceso
    await book.click()
    assert.equal(await book.getAttribute('aria-pressed'), 'false')
    system = await ask('E senza documenti?')
    assert.doesNotMatch(system.content, /# Base di conoscenza/)
    await page.locator('[data-testid="message-knowledge"][data-on="false"]').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="knowledge-button"]')?.getAttribute('aria-pressed') === 'true')
    // interruttore spento: il libro è spento; acceso per una domanda sola → sezione presente
    await page.getByTestId('knowledge-pill').click()
    await waitUntil(async () => (await latestConversation()).knowledge === false)
    await page.waitForFunction(() => document.querySelector('[data-testid="knowledge-button"]')?.getAttribute('aria-pressed') === 'false')
    await book.click()
    system = await ask('Di nuovo con i documenti: quante persone ha assunto la sede di Torino?')
    assert.match(system.content, /# Base di conoscenza/)
    await page.waitForFunction(() => document.querySelector('[data-testid="knowledge-button"]')?.getAttribute('aria-pressed') === 'false')
    await page.getByTestId('knowledge-pill').click()
    await waitUntil(async () => (await latestConversation()).knowledge === true)
    // i due documenti stanno nello spazio riservato: il modello li ha letti per intero (fonti «documento intero»)
    await panel.getByTestId('knowledge-fit').filter({ hasText: /il 50% della memoria\): il modello li legge per intero/ }).waitFor()
    // spazio per i documenti: 25 / 50 / 75%, salvato sulla conversazione, la riga si aggiorna
    assert.equal(await panel.getByTestId('knowledge-share-50').getAttribute('aria-checked'), 'true')
    await panel.getByTestId('knowledge-share-75').click()
    await waitUntil(async () => (await latestConversation()).knowledgeShare === 0.75)
    await panel.getByTestId('knowledge-fit').filter({ hasText: 'il 75% della memoria' }).waitFor()
    await panel.getByTestId('knowledge-share-50').click()
    await waitUntil(async () => (await latestConversation()).knowledgeShare === 0.5)
    // la prima risposta: le fonti dicono «documento intero» (textContent legge anche i dettagli chiusi)
    assert.match(await page.getByTestId('knowledge-refs').first().textContent(), /documento intero/)
    // «Intero» su un documento: resta segnato anche dopo il ricaricamento dello stato
    await panel.getByTestId('knowledge-doc-pin').first().click()
    await panel.getByTestId('knowledge-doc').first().filter({ hasText: /· intero/ }).waitFor()
    assert.equal(await panel.getByTestId('knowledge-doc-pin').first().getAttribute('aria-pressed'), 'true')
    await panel.getByTestId('knowledge-doc-pin').first().click()
    await panel.getByTestId('knowledge-doc').first().filter({ hasNotText: /· intero/ }).waitFor()
    // rimozione di un documento
    await panel.getByTestId('knowledge-doc-remove').first().click()
    await waitUntil(async () => (await panel.getByTestId('knowledge-doc').count()) === 1)
    await panel.getByTestId('knowledge-status').filter({ hasText: /1 documento/ }).waitFor()
  })

  await step('libreria delle basi: crea una base nelle Impostazioni, collegala a una conversazione, fonti con il nome della base, scollega ed elimina', async () => {
    // Impostazioni → Conoscenza: nuova base con due documenti (dialog saltato)
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const dialog = page.getByTestId('settings-dialog')
    await dialog.getByRole('tab', { name: 'Conoscenza' }).click()
    const library = dialog.getByTestId('knowledge-library')
    // la libreria parte con la base integrata nell'app, installata da un pacchetto all'avvio
    await library.getByTestId('library-base').filter({ hasText: /Guida di FastChat[\s\S]*Pacchetto/ }).waitFor()
    assert.equal(await library.getByTestId('library-base').count(), 1)
    await library.getByTestId('library-new-name').fill('Archivio aziendale')
    await library.getByTestId('library-create').click()
    const editor = library.getByTestId('library-base-editor')
    await editor.getByTestId('knowledge-add').click()
    await editor.locator('[data-testid="knowledge-doc"][data-status="ready"]').nth(1).waitFor({ timeout: 30_000 })
    await library.getByTestId('library-base').filter({ hasText: /Archivio aziendale[\s\S]*2 documenti/ }).waitFor()
    // rinomina
    await editor.getByTestId('library-base-name').fill('Archivio')
    await editor.getByTestId('library-base-name').press('Enter')
    await library.getByTestId('library-base').filter({ hasText: /^Archivio2 documenti/ }).waitFor()
    await dialog.getByRole('button', { name: 'Chiudi' }).click()
    await dialog.waitFor({ state: 'detached' })

    // conversazione nuova, senza documenti propri: il libro è disabilitato finché non si collega la base
    await page.getByTestId('new-conversation').click()
    await page.selectOption('#model-select', 'llama3.2:3b')
    await openTab('Conoscenza')
    const panel = page.getByTestId('knowledge-panel')
    const book = page.getByTestId('knowledge-button')
    assert.equal(await book.isDisabled(), true)
    await panel.getByTestId('knowledge-link-select').selectOption({ label: 'Archivio (2 documenti)' })
    await panel.getByTestId('knowledge-linked-base').filter({ hasText: /Archivio[\s\S]*2 documenti/ }).waitFor()
    assert.equal(await panel.getByTestId('knowledge-doc').count(), 0, 'i documenti della base non compaiono tra quelli della conversazione')
    await page.waitForFunction(() => document.querySelector('[data-testid="knowledge-button"]')?.getAttribute('aria-pressed') === 'true')
    await page.getByRole('tab', { name: 'Conoscenza (compilato)' }).waitFor()
    const conv = await latestConversation()
    const status = (await page.evaluate((id) => window.api.knowledge.status(id), conv.id)).data
    assert.equal(status.baseId, null, 'collegare una base non crea la base della conversazione')
    assert.equal(status.ready, 2)

    // domanda: i documenti della base collegata entrano nel prompt e le fonti ne riportano il nome
    const n0 = chatRequests().length
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    await box.fill('Quante persone ha assunto la sede di Torino?')
    await box.press('Enter')
    await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 60_000 })
    await waitUntil(() => chatRequests().length > n0)
    assert.match(chatRequests().at(-1).body.messages[0].content, /# Base di conoscenza[\s\S]*Torino/)
    const refs = page.getByTestId('message-assistant').last().getByTestId('knowledge-refs')
    await refs.locator('summary').click()
    assert.match(await refs.innerText(), /relazione[\s\S]*Archivio/)
    await page.screenshot({ path: join(root, 'test-results', 'e2e-knowledge-library.png') })

    // un documento proprio accanto alla base collegata: stanno insieme, ciascuno al suo posto
    await panel.getByTestId('knowledge-add').click()
    await panel.locator('[data-testid="knowledge-doc"][data-status="ready"]').nth(1).waitFor({ timeout: 30_000 })
    assert.equal(await panel.getByTestId('knowledge-linked-base').count(), 1)

    // scollega: la base resta nella libreria
    await panel.getByTestId('knowledge-unlink').click()
    await waitUntil(async () => (await panel.getByTestId('knowledge-linked-base').count()) === 0)
    assert.equal((await page.evaluate(() => window.api.knowledge.bases())).data.length, 2)
    // ricollega, poi elimina dalla libreria: la conferma dice quante conversazioni la usano, e sparisce dalla conversazione
    await panel.getByTestId('knowledge-link-select').selectOption({ label: 'Archivio (2 documenti)' })
    await panel.getByTestId('knowledge-linked-base').waitFor()
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    await dialog.getByRole('tab', { name: 'Conoscenza' }).click()
    await library.getByTestId('library-base').filter({ hasText: 'in 1 conversazione' }).click()
    // prima di eliminarla: esporta come pacchetto (con i vettori) e reimporta il file
    const editor2 = library.getByTestId('library-base-editor')
    await editor2.getByTestId('library-base-model').filter({ hasText: 'modello di embedding delle Impostazioni (embeddinggemma)' }).waitFor()
    await editor2.getByTestId('library-base-export').click()
    await editor2.getByTestId('library-exported').filter({ hasText: 'archivio.fcpack' }).waitFor()
    await library.getByTestId('library-import').click()
    const preview = library.getByTestId('pack-preview')
    await preview.getByText('2 documenti,').waitFor()
    await preview.getByText('Vettori inclusi, calcolati con embeddinggemma.').waitFor()
    await preview.getByText(/non firmato/).waitFor()
    const embedsBefore = fake.requests.filter((r) => r.path === '/api/embed').length
    await preview.getByRole('button', { name: 'Installa comunque' }).click()
    await preview.waitFor({ state: 'detached' })
    await library.getByTestId('library-base').filter({ hasText: /Archivio[\s\S]*Pacchetto · 2 documenti/ }).waitFor()
    assert.equal(fake.requests.filter((r) => r.path === '/api/embed').length, embedsBefore, 'installare un pacchetto con i vettori non calcola embedding')
    // elimina la base locale: la conferma dice quante conversazioni la usano
    await library.getByTestId('library-base-delete').click()
    await library.getByText('Collegata a 1 conversazione').waitFor()
    await library.getByTestId('library-base-delete-confirm').click()
    await waitUntil(async () => (await library.getByTestId('library-base').count()) === 2)
    // la base installata dal pacchetto: sola lettura, modello dichiarato, provenienza
    await library.getByTestId('library-base').filter({ hasText: /Archivio[\s\S]*Pacchetto/ }).click()
    const packed = library.getByTestId('library-base-editor')
    await packed.getByTestId('library-base-pack').filter({ hasText: /Pacchetto local\.archivio-[\s\S]*non firmato/ }).waitFor()
    await packed.getByTestId('library-base-model').filter({ hasText: 'Vettori calcolati con embeddinggemma' }).waitFor()
    assert.equal(await packed.getByTestId('knowledge-add').count(), 0)
    assert.equal(await packed.getByTestId('knowledge-doc').count(), 2)
    assert.equal(await packed.getByTestId('knowledge-doc-remove').count(), 0)
    await dialog.getByRole('button', { name: 'Chiudi' }).click()
    await dialog.waitFor({ state: 'detached' })
    await waitUntil(async () => (await panel.getByTestId('knowledge-linked-base').count()) === 0)
    assert.equal(await panel.getByTestId('knowledge-doc').count(), 2, 'i documenti della conversazione restano')
  })

  await step('tipi di base: una base collegata può valere come comportamento del ruolo, sempre attiva e senza fonti', async () => {
    const panel = page.getByTestId('knowledge-panel')
    // collega la Guida e usala come «Comportamento»
    await panel.getByTestId('knowledge-link-select').selectOption({ label: await panel.getByTestId('knowledge-link-select').locator('option').filter({ hasText: 'Guida di FastChat' }).textContent() })
    const linked = panel.getByTestId('knowledge-linked-base').filter({ hasText: 'Guida di FastChat' })
    await linked.waitFor()
    assert.equal(await linked.getByTestId('knowledge-purpose').inputValue(), 'documents')
    await linked.getByTestId('knowledge-purpose').selectOption('behavior')
    await linked.getByText('Sempre attiva: tecniche da applicare, senza fonti.').waitFor()
    // domanda con il libro spento: le tecniche sono nel prompt lo stesso, sotto il loro titolo
    const book = page.getByTestId('knowledge-button')
    if ((await book.getAttribute('aria-pressed')) === 'true') await book.click()
    const before = chatRequests().length
    const composer = page.getByRole('textbox', { name: 'Messaggio' })
    await composer.fill('come collego una base?')
    await composer.press('Enter')
    await waitUntil(() => chatRequests().length > before)
    const system = chatRequests()[before].body.messages[0].content
    assert.match(system, /# Come lavorare\n\nTecniche e regole del tuo ruolo/)
    assert.doesNotMatch(system, /forniti dall'utente/)
    await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 30000 }).catch(() => undefined)
    // si torna a «Documenti» e si scollega, per non toccare i passi successivi
    await linked.getByTestId('knowledge-purpose').selectOption('documents')
    await linked.getByTestId('knowledge-unlink').click()
    await linked.waitFor({ state: 'detached' })
  })

  await step('composizione del contesto: ordine B e promemoria dalle Impostazioni, visibili nel monitor ed esportabili', async () => {
    const openContext = async () => {
      await page.getByRole('button', { name: 'Impostazioni' }).click()
      const dialog = page.getByTestId('settings-dialog')
      await dialog.getByRole('tab', { name: 'Contesto' }).click()
      return { dialog, form: dialog.getByTestId('context-settings') }
    }
    const setContext = async (order, reminder) => {
      const { dialog, form } = await openContext()
      if (order === 'auto') await form.getByTestId('context-mode-auto').click()
      else {
        await form.getByTestId('context-mode-manual').click()
        await form.getByTestId(`context-order-${order}`).click()
      }
      await form.getByTestId(`context-reminder-${reminder}`).click()
      await form.getByRole('button', { name: 'Salva' }).click()
      await form.getByTestId('context-settings-saved').waitFor()
      return { dialog, form }
    }
    // in automatico le schede mostrano l'ordine in uso (A) e non si possono scegliere
    const { dialog: settings, form } = await openContext()
    assert.equal(await form.getByTestId('context-mode-auto').getAttribute('aria-checked'), 'true')
    assert.equal(await form.getByTestId('context-orders').getAttribute('data-order'), 'A')
    assert.equal(await form.getByTestId('context-order-B').isDisabled(), true)
    // il disegno: con A gli estratti sono nel sistema, con B accanto alla domanda
    const blocks = (order, slot) => form.getByTestId(`context-order-${order}`).locator(`[data-slot="${slot}"] [data-block]`).evaluateAll((els) => els.map((e) => e.dataset.block))
    assert.deepEqual(await blocks('A', 'system'), ['instructions', 'summary', 'memory', 'behavior', 'examples', 'knowledge'])
    assert.deepEqual(await blocks('B', 'user'), ['memory', 'behavior', 'examples', 'knowledge', 'question'])
    // «Scelgo io» + promemoria acceso: il blocco compare accanto alla domanda in A e B; con C non serve
    await form.getByTestId('context-mode-manual').click()
    await form.getByTestId('context-reminder-on').click()
    assert.deepEqual(await blocks('B', 'user'), ['memory', 'behavior', 'examples', 'knowledge', 'reminder', 'question'])
    assert.deepEqual(await blocks('C', 'user'), ['instructions', 'memory', 'behavior', 'examples', 'knowledge', 'question'])
    await form.getByTestId('context-order-C').click()
    assert.equal(await form.getByTestId('context-reminder-on').isDisabled(), true)
    // barra della memoria: i bordi si spostano con le frecce, a passi; la somma resta 100
    await form.getByTestId('context-legend-behavior').filter({ hasText: 'Comportamento · 20%' }).waitFor()
    await form.getByTestId('context-handle-behavior').press('ArrowRight')
    await form.getByTestId('context-legend-behavior').filter({ hasText: 'Comportamento · 25%' }).waitFor()
    await form.getByTestId('context-legend-examples').filter({ hasText: 'Esempi · 15%' }).waitFor()
    await form.getByTestId('context-legend-documents').filter({ hasText: 'Documenti · 60%' }).waitFor()
    await form.getByTestId('context-handle-situation').press('ArrowRight')
    await form.getByTestId('context-legend-situation').filter({ hasText: 'Situazione · 6%' }).waitFor()
    // «Ripristina» torna ai predefiniti senza salvare
    await form.getByTestId('context-reset').click()
    await form.getByTestId('context-legend-behavior').filter({ hasText: 'Comportamento · 20%' }).waitFor()
    assert.equal(await form.getByTestId('context-mode-auto').getAttribute('aria-checked'), 'true')
    await settings.getByTestId('dialog-close').click()
    await settings.waitFor({ state: 'detached' })

    // ordine B con promemoria acceso: conversazione nuova con una situazione
    const { dialog } = await setContext('B', 'on')
    await dialog.getByTestId('dialog-close').click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByTestId('new-conversation').click()
    await page.selectOption('#model-select', 'llama3.2:3b')
    await writeSituation('# Ruolo\nSei un tutor')
    const before = chatRequests().length
    const composer = page.getByRole('textbox', { name: 'Messaggio' })
    await composer.fill('ciao')
    await composer.press('Enter')
    await page.getByTestId('message-assistant').first().waitFor()
    const sent = chatRequests()[before].body.messages
    // Il Generalista non ha un ruolo da ricordare: nessun promemoria accanto
    // alla domanda (con un ruolo vero c'è: lo verificano i test unitari, in attesa della scelta del ruolo).
    assert.deepEqual(sent, [
      { role: 'system', content: '# Ruolo\nSei un tutor' },
      { role: 'user', content: 'ciao' }
    ])
    // nella chat si vede il testo scritto dall'utente, non il promemoria
    assert.equal(await page.getByTestId('message-user').last().innerText().then((t) => t.includes('Promemoria')), false)
    // monitor: ordine, promemoria, tipo di sistema, tempo al primo frammento
    await openTab('Modello')
    const monitor = page.locator('#panel-model').getByTestId('context-monitor')
    await monitor.getByTestId('context-calls').locator('summary').click()
    await monitor.getByTestId('context-call-select').selectOption({ index: await monitor.getByTestId('context-call-select').locator('option').evaluateAll((os) => os.findIndex((o) => /chat|Risposta/i.test(o.textContent ?? ''))) })
    await monitor.getByTestId('context-compose').filter({ hasText: /Ordine B · promemoria del ruolo · sistema: / }).waitFor()
    await monitor.getByTestId('context-first-token').waitFor()
    // export CSV: una riga per chiamata, con l'ordine usato
    await monitor.getByTestId('context-export').click()
    await monitor.getByTestId('context-exported').filter({ hasText: 'contesto.csv' }).waitFor()
    const csv = readFileSync(join(userData, 'contesto.csv'), 'utf8').trim().split('\n')
    assert.match(csv[0], /^time;kind;note;model;num_ctx;order;reminder;system_slot;/)
    assert.ok(csv.some((l) => /;chat;[^;]*;llama3\.2:3b;\d+;B;1;/.test(l)), 'la chiamata di chat riporta ordine B e promemoria')
    // si torna al comportamento predefinito per i passi successivi
    const back = await setContext('auto', 'auto')
    await back.dialog.getByTestId('dialog-close').click()
    await back.dialog.waitFor({ state: 'detached' })
  })

  await step('store: finestra sopra la chat, quattro categorie, ruoli con lingua e filtro, Guida già installata, installa una base e la collega', async () => {
    await page.getByTestId('store-open').click()
    const store = page.getByTestId('store-dialog')
    await store.getByTestId('store-item').first().waitFor()
    // categorie nell'ordine: Ruoli, Basi di conoscenza, Plugin, Pacchetti; si apre sulle basi
    assert.deepEqual(await store.getByRole('tab').allTextContents(), ['Ruoli2', 'Basi di conoscenza2', 'Plugin1', 'Pacchetti0'])
    assert.equal(await store.getByRole('tab', { name: /Basi di conoscenza/ }).getAttribute('aria-selected'), 'true')
    const item = (name) => store.getByTestId('store-item').filter({ has: page.getByTestId('store-item-name').filter({ hasText: name }) })
    // la Guida integrata: installata, senza azioni
    const guide = item('Guida di FastChat')
    await guide.locator('[data-testid="store-item-state"][data-state="installed"]').first().waitFor()
    assert.equal(await guide.getByRole('button').count(), 0)
    await store.getByTestId('store-source').filter({ hasText: 'Catalogo incluso nell’app' }).waitFor()
    // ruoli: i due in bozza inclusi nell'app, installati e non rimovibili; ciascuno con la sua lingua e ciò che richiede
    await store.getByTestId('store-tab-identity').click()
    const expert = item('Esperto di prompt engineering')
    await expert.locator('[data-testid="store-item-state"][data-state="installed"]').first().waitFor()
    await expert.getByTestId('store-item-language').filter({ hasText: 'Italiano' }).waitFor()
    await expert.getByTestId('store-item-part').filter({ hasText: 'Scrivere buoni prompt' }).waitFor()
    assert.equal(await store.getByTestId('store-item-install').count(), 0)
    assert.equal(await store.getByTestId('store-item-remove').count(), 0)
    // filtro per lingua accanto alla ricerca: pulsanti, non un menu
    const filter = store.getByTestId('store-language-filter')
    assert.deepEqual(await filter.getByRole('radio').allTextContents(), ['Tutte le lingue', 'Italiano'])
    await filter.getByRole('radio', { name: 'Italiano' }).click()
    assert.equal(await store.getByTestId('store-item').count(), 2)
    await store.getByTestId('store-search').fill('uso dell\'app')
    assert.equal(await store.getByTestId('store-item').count(), 1)
    await store.getByTestId('store-search').fill('')
    await filter.getByRole('radio', { name: 'Tutte le lingue' }).click()
    // plugin: nel catalogo, non ancora installabili
    await store.getByTestId('store-tab-plugin').click()
    await store.locator('[data-testid="store-item-state"][data-state="soon"]').first().waitFor()
    // nessun pacchetto nel catalogo incluso nell'app
    await store.getByTestId('store-tab-bundle').click()
    await store.getByTestId('store-empty').filter({ hasText: 'Nessuna voce in questa categoria.' }).waitFor()
    // ricerca
    await store.getByTestId('store-tab-knowledge').click()
    await store.getByTestId('store-search').fill('prompt')
    assert.equal(await store.getByTestId('store-item').count(), 1)
    await store.getByTestId('store-search').fill('zzz')
    await store.getByTestId('store-empty').filter({ hasText: 'Nessun risultato per «zzz»' }).waitFor()
    await store.getByTestId('store-search').fill('')
    // installa «Scrivere buoni prompt»: diventa installata
    await item('Scrivere buoni prompt').getByTestId('store-item-install').click()
    await item('Scrivere buoni prompt').locator('[data-testid="store-item-state"][data-state="installed"]').first().waitFor()
    // rimuovere chiede conferma (qui si annulla)
    await item('Scrivere buoni prompt').getByTestId('store-item-remove').click()
    await item('Scrivere buoni prompt').getByTestId('store-item-confirm').filter({ hasText: 'Rimuovere «Scrivere buoni prompt»?' }).waitFor()
    await item('Scrivere buoni prompt').getByRole('button', { name: 'Annulla' }).click()
    // finestra grande, in proporzione allo schermo, con la chiusura in alto a destra
    const box = await store.boundingBox()
    const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    assert.ok(box.width > win.w * 0.85 && box.height > win.h * 0.8, 'lo store occupa gran parte della finestra')
    const close = await store.getByTestId('dialog-close').boundingBox()
    assert.ok(close.x > box.x + box.width - 80 && close.y < box.y + 40, 'chiusura in alto a destra')
    await store.getByTestId('dialog-close').click()
    await store.waitFor({ state: 'detached' })
    // in Impostazioni → Conoscenza le basi dello Store non si eliminano: rimandano allo Store
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const settings = page.getByTestId('settings-dialog')
    await settings.getByRole('tab', { name: 'Conoscenza' }).click()
    for (const name of ['Guida di FastChat', 'Scrivere buoni prompt']) {
      await settings.getByTestId('library-base').filter({ hasText: name }).click()
      await settings.getByTestId('library-base-store').waitFor()
      assert.equal(await settings.getByTestId('library-base-delete').count(), 0)
    }
    await settings.getByTestId('library-base-store').click()
    await settings.waitFor({ state: 'detached' })
    await store.getByTestId('store-item').first().waitFor()
    await store.getByTestId('dialog-close').click()
    await store.waitFor({ state: 'detached' })
    // la base installata si collega dalla scheda «Conoscenza»
    const panel = page.getByTestId('knowledge-panel')
    await waitUntil(async () => (await panel.getByTestId('knowledge-link-select').locator('option').allTextContents()).some((o) => o.startsWith('Scrivere buoni prompt')))
  })

  // ------------------------------------------------------------------ fase 4
  const planRequests = () => fake.requests.filter((r) => r.path === '/api/chat' && r.body?.format)

  await step('plan mode: il modello propone un piano (format = JSON schema)', async () => {
    await page.getByTestId('new-conversation').click()
    await openTab('Modello')
    await page.selectOption('#model-select', 'thinker:8b')
    await writeSituation('# Vincoli\nUsa esempi con la pizza.')
    await setSwitch(page.getByTestId('conversation-panel'), 'Plan mode', true)
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
    await openTab('Situazione')
    await setSwitch(page.getByTestId('conversation-panel'), 'Plan mode', false)
    await page.getByRole('button', { name: 'Invia' }).waitFor()
  })

  await step('nessun errore JavaScript nel renderer (fase 4)', async () => {
    assert.deepEqual(errors, [])
  })
  await page.getByTestId('plan-summary').first().locator('summary').click()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase4.png') })

  // ------------------------------------------------------------------ fase 5
  await step('export Markdown e JSON (situazione, messaggi, piani)', async () => {
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
    assert.match(md, /## Situazione\n\n### Vincoli\nUsa esempi con la pizza\./)
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
    await openTab('Situazione')
    const panel = page.getByTestId('conversation-panel')
    await panel.getByRole('button', { name: 'Salva come template' }).click()
    await panel.getByLabel('Nome del template').fill('Tutor pizza')
    await panel.getByRole('button', { name: 'Salva', exact: true }).click()
    await panel.getByText('Template salvato').waitFor()

    await page.getByTestId('role-menu-open').click()
    const template = page.getByTestId('role-menu').getByTestId('template-option').filter({ hasText: 'Tutor pizza' })
    // sotto il nome: il ruolo e cosa porta con sé
    await template.filter({ hasText: 'Generalista · situazione salvata' }).waitFor()
    await template.getByRole('menuitem').click()
    await page.locator('header h1', { hasText: 'Nuova conversazione' }).waitFor()
    assert.equal(await page.getByTestId('conversation-panel').getByTestId('situation-text').inputValue(), '# Vincoli\nUsa esempi con la pizza.')
    assert.equal(await page.locator('#model-select').inputValue(), 'thinker:8b')
    assert.equal(await page.getByTestId('messages').getByTestId('message-user').count(), 0)
  })

  await step('ruoli: «Parla con un…» crea la conversazione con il ruolo; i parametri cambiano istruzioni e mente', async () => {
    const panel = page.getByTestId('conversation-panel')
    await page.getByTestId('role-menu-open').click()
    const menu = page.getByTestId('role-menu')
    // il Generalista per primo, poi i ruoli installati (qui le due bozze incluse nell'app)
    await menu.getByTestId('role-option').nth(2).waitFor()
    assert.deepEqual(await menu.getByTestId('role-option').evaluateAll((els) => els.map((e) => e.querySelector('span span')?.textContent)), [
      'Generalista',
      'Assistente di FastChat (bozza)',
      'Esperto di prompt engineering (bozza)'
    ])
    await menu.getByTestId('role-option').filter({ hasText: 'Esperto di prompt engineering' }).click()
    await openTab('Modello')
    await panel.getByTestId('role-name').filter({ hasText: 'Esperto di prompt engineering (bozza)' }).waitFor()
    // la mente del ruolo: temperatura 0,3 (opzione «Asciutto»), ragionamento acceso, documenti spenti in partenza
    let conv = await latestConversation()
    assert.equal(conv.roleId, 'app.fastchat.ruolo.prompt.it')
    assert.deepEqual([conv.temperature, conv.think, conv.style, conv.knowledge], [0.3, true, 'normal', false])
    // il modello consigliato (gemma4:e4b) non è installato: resta il predefinito, con l'avviso
    await panel.getByTestId('role-unverified').filter({ hasText: /Ruolo non verificato con .+\. Consigliato: gemma4:e4b\./ }).waitFor()
    // nella barra laterale, sotto il titolo, con chi si parla
    await items.first().getByTestId('conversation-role').filter({ hasText: 'Esperto di prompt engineering' }).waitFor()
    // quattro sezioni, nell'ordine fisso
    assert.deepEqual(await panel.getByTestId('role-section').evaluateAll((els) => els.map((e) => e.dataset.section)), ['identity', 'style', 'rules', 'method'])
    // al primo arrivo sono chiuse: ciascuna mostra in una riga le scelte in vigore
    assert.equal(await panel.locator('[data-testid="role-section"] details[open]').count(), 0)
    assert.equal(await panel.getByTestId('group-role-style-summary').textContent(), 'Principiante · Risultato con spiegazione · Asciutto')
    assert.equal(await panel.getByTestId('group-role-rules-summary').textContent(), 'Tecniche da usare: Ruolo esplicito, Formato di uscita')
    await panel.locator('[data-testid="role-section"][data-section="rules"] summary').filter({ hasText: /^.?Regole/ }).waitFor()
    // niente menu a tendina: pulsanti affiancati per la scelta singola, interruttori per quella multipla
    await page.evaluate(() => document.querySelectorAll('[data-testid="role-panel"] details[data-group]').forEach((d) => (d.open = true)))
    assert.equal(await panel.getByTestId('role-panel').getByRole('combobox').count(), 0)

    // scelta singola: l'opzione dichiara il suo effetto sulla mente, e lo applica
    const style = panel.locator('[data-parameter="stile"]')
    await style.getByTestId('role-effect').filter({ hasText: 'imposta la temperatura a 0,3' }).waitFor()
    await style.getByRole('radio', { name: 'Dettagliato' }).click()
    await style.getByTestId('role-effect').filter({ hasText: 'imposta la temperatura a 0,6' }).waitFor()
    await waitUntil(async () => (await latestConversation()).temperature === 0.6)
    // la lunghezza della risposta non tocca la temperatura
    await panel.locator('[data-parameter="risultato"]').getByRole('radio', { name: 'Solo il risultato' }).click()
    await waitUntil(async () => (await latestConversation()).style === 'concise')
    assert.equal((await latestConversation()).temperature, 0.6)
    // scelta multipla
    await setSwitch(panel.locator('[data-parameter="tecniche"]'), 'Passi numerati', true)
    await waitUntil(async () => ((await latestConversation()).roleParams?.tecniche ?? []).includes('passi'))
    // un ritocco a mano resta finché non cambia l'opzione che governa quel valore
    await page.getByTestId('composer-style').selectOption('extended')
    await waitUntil(async () => (await latestConversation()).style === 'extended')
    await panel.locator('[data-parameter="destinatario"]').getByRole('radio', { name: 'Esperto' }).click()
    await waitUntil(async () => (await latestConversation()).roleParams?.destinatario === 'esperto')
    assert.equal((await latestConversation()).style, 'extended')
    await panel.locator('[data-parameter="risultato"]').getByRole('radio', { name: 'Risultato con spiegazione' }).click()
    await waitUntil(async () => (await latestConversation()).style === 'normal')

    // situazione e anteprima: le istruzioni del ruolo, poi la situazione con il suo titolo
    await writeSituation('Classifico email di assistenza')
    const preview = await page.getByTestId('system-preview').textContent()
    assert.match(preview, /^Sei un esperto di prompt engineering[\s\S]*Motiva ogni istruzione in una riga\.[\s\S]*\n\n# Situazione\nClassifico email di assistenza$/)

    // ciò che parte verso il modello è ciò che l'anteprima mostra
    const before = chatRequests().length
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    await box.fill('Guarda questo prompt')
    await box.press('Enter')
    await page.getByTestId('message-assistant').first().waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    const sent = chatRequests()[before].body
    // (se la base di comportamento del ruolo è installata, le sue tecniche seguono la situazione)
    assert.ok(sent.messages[0].content.startsWith(preview), sent.messages[0].content.slice(0, 400))
    assert.equal(sent.options.temperature, 0.6)

    // scheda Conoscenza: la base del ruolo sta a parte, in sola lettura; se non è installata lo si dice
    await openTab('Conoscenza')
    const roleBases = panel.getByTestId('role-bases')
    await roleBases.waitFor()
    assert.equal((await roleBases.getByTestId('role-base').count()) + (await roleBases.getByTestId('role-base-missing').count()), 1)
    assert.equal(await roleBases.getByTestId('knowledge-unlink').count(), 0)
  })

  await step('cambio di ruolo: subito a conversazione vuota; a conversazione avviata, nuova conversazione con o senza riassunto', async () => {
    const panel = page.getByTestId('conversation-panel')
    const started = await latestConversation()
    await openTab('Modello')
    // conversazione avviata: si propone una nuova conversazione
    await panel.getByTestId('role-change').click()
    await panel.getByTestId('role-picker').getByRole('menuitem', { name: /Assistente di FastChat/ }).click()
    const dialog = page.getByTestId('role-change-dialog')
    await dialog.getByText('Porta con te il riassunto').waitFor()
    await dialog.getByTestId('role-change-confirm').filter({ hasText: 'Apri la nuova conversazione' }).click()
    await dialog.waitFor({ state: 'detached' })
    await panel.getByTestId('role-name').filter({ hasText: 'Assistente di FastChat (bozza)' }).waitFor()
    let conv = await latestConversation()
    assert.notEqual(conv.id, started.id)
    assert.equal(conv.roleId, 'app.fastchat.ruolo.assistente.it')
    // parte dal riassunto della precedente: i suoi messaggi, o il riassunto che li copre
    assert.match(conv.summary, /Guarda questo prompt/)
    assert.equal(await page.getByTestId('messages').getByTestId('message-user').count(), 0)
    // la mente è quella del nuovo ruolo
    assert.deepEqual([conv.temperature, conv.think, conv.knowledge], [0.2, false, true])
    // la Guida è la sua base di documenti: collegata, tra quelle del ruolo
    await openTab('Conoscenza')
    await panel.getByTestId('role-bases').getByTestId('role-base').filter({ hasText: 'Guida di FastChat' }).waitFor()

    // conversazione vuota: il ruolo cambia subito, senza finestra
    await openTab('Modello')
    await panel.getByTestId('role-change').click()
    await panel.getByTestId('role-picker').getByRole('menuitem', { name: 'Generalista' }).click()
    await panel.getByTestId('role-name').filter({ hasText: 'Generalista' }).waitFor()
    await waitUntil(async () => (await latestConversation()).roleId === 'app.fastchat.ruolo.generalista')
    conv = await latestConversation()
    assert.equal(conv.think, false)
    assert.equal(await panel.getByTestId('role-section').count(), 0)
    assert.equal(await page.getByTestId('role-change-dialog').count(), 0)
    // la conversazione di partenza è rimasta com'era
    await items.filter({ hasText: 'Esperto di prompt engineering' }).first().waitFor()
    // «Altri ruoli nello Store…» apre lo Store sulla scheda dei ruoli
    await page.getByTestId('role-menu-open').click()
    await page.getByTestId('role-menu-store').click()
    const store = page.getByTestId('store-dialog')
    await store.getByTestId('store-item').first().waitFor()
    assert.equal(await store.getByTestId('store-tab-identity').getAttribute('aria-selected'), 'true')
    await store.getByTestId('dialog-close').click()
    await store.waitFor({ state: 'detached' })
  })

  await step('impostazioni: verifica URL, tema scuro, modello predefinito', async () => {
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const dialog = page.getByTestId('settings-dialog')
    await dialog.waitFor()
    const url = dialog.getByLabel('URL di Ollama')
    assert.equal(await url.inputValue(), fake.url)
    await dialog.getByRole('button', { name: 'Verifica' }).click()
    await dialog.getByTestId('settings-check').filter({ hasText: 'Connesso · 7 modelli' }).waitFor()
    await url.fill('http://127.0.0.1:1')
    await dialog.getByRole('button', { name: 'Verifica' }).click()
    await dialog.getByTestId('settings-check').filter({ hasText: 'non raggiungibile' }).waitFor()
    // la verifica non salva nulla
    assert.equal((await page.evaluate(() => window.api.settings.get())).data.ollamaUrl, fake.url)
    await url.fill(fake.url)
    // («Tema» è anche dentro «sistema» nell'elenco della lingua: si usa il testid)
    await dialog.getByTestId('settings-theme').selectOption('dark')
    await dialog.getByLabel('Modello predefinito').selectOption('llama3.2:3b')
    await dialog.getByLabel('Cache KV di Ollama').selectOption('q8_0')
    await dialog.getByRole('button', { name: 'Salva' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    const saved = (await page.evaluate(() => window.api.settings.get())).data
    assert.equal(saved.theme, 'dark')
    assert.equal(saved.defaultModel, 'llama3.2:3b')
    assert.equal(saved.kvCacheType, 'q8_0')
    await page.getByTestId('new-conversation').click()
    await page.waitForFunction(() => document.querySelector('#model-select')?.value === 'llama3.2:3b')
    // la cache quantizzata entra nel calcolo della memoria (qui limitata dal massimo del modello) e nella spiegazione
    await openTab('Modello')
    await page.getByTestId('model-settings').getByText(/con cache KV q8_0\./).waitFor()
  })

  await step('esecuzione del modello: avviso per il modello nuovo, test CPU/GPU, scelta salvata per modello', async () => {
    const row = page.getByTestId('model-settings').getByTestId('execution-row')
    // llama3.2:3b non è mai stato testato: avviso non bloccante
    await row.getByTestId('benchmark-notice').filter({ hasText: 'Modello nuovo' }).waitFor()
    await row.getByTestId('benchmark-run').click()
    // (con il server finto il test dura pochi millisecondi: l'avanzamento non si fa in tempo a vedere)
    await row.getByTestId('benchmark-notice').waitFor({ state: 'detached' })
    // nel server finto non c'è GPU: resta la CPU, e lo si dice
    assert.equal(await row.getByTestId('num-gpu-select').inputValue(), 'cpu')
    await row.getByText('Ollama non usa la GPU per questo modello').waitFor()
    const saved = (await page.evaluate(() => window.api.models.settings())).data.find((m) => m.model === 'llama3.2:3b')
    assert.equal(saved.numGpu, 0)
    assert.equal(saved.gpuAvailable, false)
    assert.deepEqual(saved.benchmark.map((r) => r.numGpu), [0, 999])
    // le richieste successive del modello portano num_gpu
    const box = page.getByRole('textbox', { name: 'Messaggio' })
    await box.fill('Ciao')
    await box.press('Enter')
    await page.getByTestId('message-assistant').last().waitFor()
    await page.getByTestId('message-streaming').waitFor({ state: 'detached' })
    assert.equal(lastChat().options.num_gpu, 0)
  })

  await step('impostazioni → Modelli: risultati del test, esecuzione per modello, scarica ed elimina', async () => {
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const dialog = page.getByTestId('settings-dialog')
    await dialog.getByRole('tab', { name: 'Modelli' }).click()
    const manager = dialog.getByTestId('model-manager')
    await manager.getByTestId('model-row').first().waitFor()
    assert.equal(await manager.getByTestId('model-row').count(), 7) // + embeddinggemma, scaricato per la memoria
    const llama = manager.getByTestId('model-row').filter({ hasText: 'llama3.2:3b' })
    assert.equal(await llama.getByTestId('benchmark-table').locator('tbody tr').count(), 2)
    await page.screenshot({ path: join(root, 'test-results', 'e2e-models.png') })
    // esecuzione scelta a mano per un altro modello
    await manager.getByTestId('model-row').filter({ hasText: 'qwen3:4b' }).getByTestId('num-gpu-select').selectOption('gpu')
    await waitUntil(async () => (await page.evaluate(() => window.api.models.settings())).data.some((m) => m.model === 'qwen3:4b' && m.numGpu === 999))
    // scarica un modello: avanzamento, poi compare nell'elenco
    await manager.getByLabel('Nome del modello da scaricare').fill('nuovo:1b')
    await manager.getByRole('button', { name: 'Scarica' }).click()
    await manager.getByTestId('model-row').filter({ hasText: 'nuovo:1b' }).waitFor()
    // elimina (con conferma)
    page.once('dialog', (d) => void d.accept())
    await manager.getByTestId('model-row').filter({ hasText: 'nuovo:1b' }).getByRole('button', { name: 'Elimina' }).click()
    await manager.getByTestId('model-row').filter({ hasText: 'nuovo:1b' }).waitFor({ state: 'detached' })
    assert.equal(await manager.getByTestId('model-row').count(), 7)

    // Ollama: fuori da Windows l'app mostra i comandi invece di applicarli
    await dialog.getByRole('tab', { name: 'Ollama' }).click()
    const env = dialog.getByTestId('ollama-env')
    await env.getByLabel('GPU tramite Vulkan').selectOption('1')
    await env.getByTestId('ollama-env-apply').filter({ hasText: 'Mostra i comandi' }).click()
    await env.getByTestId('ollama-env-commands').filter({ hasText: 'Environment="OLLAMA_VULKAN=1"' }).waitFor()
    await dialog.getByRole('button', { name: 'Chiudi' }).click()
    await dialog.waitFor({ state: 'detached' })
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
        document.querySelector('[data-testid="conversation-panel"]'),
        document.querySelector('textarea[aria-label="Messaggio"]'),
        document.querySelector('ul[aria-label="Conversazioni"]')
      ].map((el) => getComputedStyle(el).scrollbarWidth)
    )
    assert.deepEqual(scrollbars, ['none', 'none', 'none', 'none'])
  })

  await step('pannello a schede: Modello / Situazione / Conoscenza, indicatore della situazione, tastiera, scheda ricordata', async () => {
    const modelPanel = page.locator('#panel-model')
    const briefPanel = page.locator('#panel-situation')
    await openTab('Modello')
    assert.equal(await modelPanel.isVisible(), true)
    assert.equal(await briefPanel.isVisible(), false)

    await openTab('Situazione')
    assert.equal(await briefPanel.isVisible(), true)
    assert.equal(await modelPanel.isVisible(), false)
    // situazione vuota: nessun indicatore; scrivendo compare il •
    const role = briefPanel.getByTestId('situation-text')
    await role.fill('')
    await page.locator('#panel-tab-situation').getByTestId('tab-filled').waitFor({ state: 'detached' })
    await role.fill('Sei un assistente')
    await page.locator('#panel-tab-situation').getByTestId('tab-filled').waitFor()
    await page.getByRole('tab', { name: 'Situazione (compilato)' }).waitFor()

    // frecce: da Situazione a sinistra si va a Modello, a destra a Conoscenza
    await page.getByRole('tab', { name: 'Situazione' }).focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(() => document.getElementById('panel-tab-model')?.getAttribute('aria-selected') === 'true')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'panel-tab-model')
    assert.equal(await page.getByRole('tab').count(), 3)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.getElementById('panel-tab-knowledge')?.getAttribute('aria-selected') === 'true')
    assert.equal(await page.locator('#panel-knowledge').isVisible(), true)
    await openTab('Modello')

    // in fondo al pannello Modello: stato del contesto con la stessa percentuale del contatore in basso,
    // e sotto, chiusi, il dettaglio del calcolo e le chiamate a Ollama
    const monitor = page.locator('#panel-model').getByTestId('context-monitor')
    const pctOf = (t) => t.match(/(\d+|>100)%/)?.[1]
    assert.equal(pctOf(await monitor.getByTestId('context-state-total').innerText()), pctOf(await page.getByTestId('context-usage').innerText()))
    assert.equal(await monitor.getByTestId('context-reconcile').evaluate((d) => d.open), false)
    assert.equal(await monitor.getByTestId('context-calls').evaluate((d) => d.open), false)
    await monitor.getByTestId('context-reconcile').locator('summary').click()
    await monitor.getByTestId('context-state-source').waitFor()
    await monitor.getByTestId('context-calls').locator('summary').click()
    await monitor.getByTestId('context-sent').or(monitor.getByTestId('context-empty')).first().waitFor()
    if (await monitor.getByTestId('context-sent').isVisible()) {
      assert.match(await monitor.getByTestId('context-sent').innerText(), /Totale inviato/)
      assert.match(await monitor.getByTestId('context-consumed').innerText(), /Prompt letto|fallita|conteggi/)
    }

    // i gruppi chiusi mostrano i valori; chiudendone uno, resta chiuso dopo il riavvio
    const words = page.locator('#panel-model details[data-group="words"]')
    await words.locator('summary').click()
    await page.getByTestId('group-words-summary').filter({ hasText: /temperatura \d\.\d\d · varietà \d,\d\d · seed/ }).waitFor()

    // dopo il riavvio della pagina si riapre l'ultima scheda scelta (Modello)
    await page.reload()
    await items.first().waitFor()
    await items.first().getByRole('button').first().click()
    await page.waitForFunction(() => document.getElementById('panel-tab-model')?.getAttribute('aria-selected') === 'true')
    assert.equal(await page.locator('#panel-model').isVisible(), true)
    assert.equal(await page.locator('#panel-model details[data-group="words"]').evaluate((d) => d.open), false)
    assert.equal(await page.locator('#panel-model details[data-group="answer"]').evaluate((d) => d.open), true)
    await openGroups()
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
    await side.getByRole('button', { name: 'Parla con un…' }).click()
    await side.getByTestId('role-menu').waitFor()
    assert.equal(await y(side.getByRole('list', { name: 'Conversazioni' })), listY)
    await page.keyboard.press('Escape')
    await side.getByTestId('role-menu').waitFor({ state: 'detached' })
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

  await step('finestra piccola: il documento non scorre mai (né con la rotella né da codice)', async () => {
    const resize = (w, h) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]), [w, h])
    for (const [w, h] of [[900, 600], [760, 500]]) {
      await resize(w, h)
      await page.waitForFunction((w) => innerWidth === w, w)
      // la cronologia ricalcola i pallini al frame successivo (ResizeObserver → requestAnimationFrame)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const m = await page.evaluate(() => {
        scrollTo(500, 500)
        document.querySelector('[data-testid="message-assistant"]')?.scrollIntoView({ block: 'start' })
        const d = document.documentElement
        return { scrollW: d.scrollWidth, scrollH: d.scrollHeight, w: innerWidth, h: innerHeight, x: scrollX, y: scrollY }
      })
      assert.ok(m.scrollW <= m.w && m.scrollH <= m.h, `documento ${m.scrollW}×${m.scrollH} più grande della finestra ${m.w}×${m.h}`)
      assert.deepEqual([m.x, m.y], [0, 0])
      await page.mouse.move(w / 2, h / 2)
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(150)
      assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), [0, 0])
      // la topbar resta al suo posto
      const top = await page.locator('header').first().boundingBox()
      assert.equal(Math.round(top.y), 0)
    }
    await resize(1200, 800)
    await page.waitForFunction(() => innerWidth === 1200)
  })

  await step('lingua: in inglese cambiano interfaccia e prompt al modello, poi si torna in italiano', async () => {
    await page.getByRole('button', { name: 'Impostazioni' }).click()
    const dialog = page.getByTestId('settings-dialog')
    await dialog.getByTestId('settings-language').selectOption('en')
    await dialog.getByRole('button', { name: 'Salva' }).click()
    await dialog.waitFor({ state: 'detached' })
    // interfaccia: schede, barra laterale, composer
    await page.getByRole('tab', { name: 'Model' }).waitFor()
    await page.getByTestId('new-conversation').filter({ hasText: 'New conversation' }).waitFor()
    await page.getByRole('textbox', { name: 'Message' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
    // il titolo predefinito si legge in inglese, ma nel DB resta quello salvato
    await page.getByTestId('new-conversation').click()
    await page.getByTestId('conversation-item').first().filter({ hasText: 'New conversation' }).waitFor()
    assert.equal((await latestConversation()).title, 'Nuova conversazione')
    // prompt al modello in inglese: lo stile diventa «# Answer style»
    await page.selectOption('#model-select', 'llama3.2:3b')
    await writeSituation('# Role\nTutor', 'Saved', 'Situation')
    await page.getByTestId('system-preview').filter({ hasText: '# Role' }).waitFor()
    const before = chatRequests().length
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill('hello')
    await composer.press('Enter')
    await page.getByTestId('message-assistant').first().waitFor()
    const req = chatRequests()[before].body
    assert.match(req.messages[0].content, /^# Role\nTutor/)
    // store e basi installate: i titoli seguono la lingua dell'interfaccia
    await page.getByTestId('store-open').filter({ hasText: 'Store' }).click()
    const store = page.getByTestId('store-dialog')
    await store.getByTestId('store-item').first().waitFor()
    assert.deepEqual(await store.getByRole('tab').allTextContents(), ['Roles2', 'Knowledge bases2', 'Plugins1', 'Bundles0'])
    assert.deepEqual(await store.getByTestId('store-item-name').allTextContents(), ['FastChat Guide', 'Writing good prompts'])
    await store.locator('[data-testid="store-item-state"][data-state="installed"]').first().filter({ hasText: 'Installed' }).waitFor()
    await store.getByRole('button', { name: 'Close' }).click()
    await store.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Settings' }).click()
    await dialog.getByRole('tab', { name: 'Knowledge' }).click()
    await dialog.getByTestId('library-base').filter({ hasText: 'FastChat Guide' }).waitFor()
    await dialog.getByTestId('library-base').filter({ hasText: 'Writing good prompts' }).waitFor()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'detached' })
    // di nuovo in italiano
    await page.getByRole('button', { name: 'Settings' }).click()
    await dialog.getByTestId('settings-language').selectOption('it')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByRole('tab', { name: 'Modello' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'it')
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
