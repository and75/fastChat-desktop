// Test end-to-end: avvia l'app buildata (out/) con Playwright `_electron`, contro un Ollama finto.
// Uso: npm run test:e2e   (su Linux senza display: xvfb-run -a npm run test:e2e)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startFakeOllama } from '../tests/helpers/fakeOllama.ts'

const root = resolve(import.meta.dirname, '..')
const userData = mkdtempSync(join(tmpdir(), 'fastchat-e2e-'))
const fake = await startFakeOllama([
  { name: 'qwen3:4b', capabilities: ['completion', 'thinking'] },
  { name: 'llama3.2:3b', capabilities: ['completion', 'tools'] },
  {
    name: 'thinker:8b',
    capabilities: ['completion', 'thinking'],
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
const lastChat = () => fake.requests.filter((r) => r.path === '/api/chat').at(-1)?.body

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
  env: { ...process.env, OLLAMA_URL: fake.url, FASTCHAT_USER_DATA: userData, NODE_ENV: 'production' }
})

let failed = false
try {
  const page = await app.firstWindow()
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
    assert.deepEqual(options, ['llama3.2:3b', 'qwen3:4b', 'slow:1b', 'thinker:8b'])
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
    await page.getByRole('button', { name: '+ Nuova conversazione' }).click()
    await items.first().waitFor()
    assert.equal(await items.count(), 1)
    assert.equal(await page.locator('#model-select').inputValue(), 'qwen3:4b')
    await page.selectOption('#model-select', 'llama3.2:3b')
  })

  await step('brief: si salva da solo e l\'anteprima mostra le sezioni in ordine', async () => {
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

  await step('rigenera l\'ultima risposta', async () => {
    await page.selectOption('#model-select', 'llama3.2:3b')
    const before = await page.getByTestId('message-assistant').count()
    await page.getByRole('button', { name: '↻ Rigenera' }).click()
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

  await step('sidebar: rinomina, ricerca, archivia, elimina', async () => {
    // seconda conversazione
    await page.getByRole('button', { name: '+ Nuova conversazione' }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="conversation-item"]').length === 2)

    // la più vecchia (in fondo) è quella con i messaggi
    const first = items.filter({ hasText: 'Nuova conversazione' }).last()
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
    await page.getByRole('button', { name: '+ Nuova conversazione' }).click()
    await page.getByTestId('model-settings').waitFor()
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
    await settings.getByRole('switch', { name: 'Ragionamento' }).check({ force: true })
    await settings.getByLabel('Temperatura').fill('1.2')
    await page.getByTestId('temperature-value').filter({ hasText: '1.20' }).waitFor()
    await settings.getByText('Parametri avanzati').click()
    await settings.getByLabel('top_p').fill('0.9')
    await settings.getByLabel('seed').fill('7')
    await page.getByTestId('composer-temperature').filter({ hasText: '1.20' }).waitFor()
    await page.waitForTimeout(400) // debounce del salvataggio
    const conv = await page.evaluate(async () => {
      const list = await window.api.conversations.list()
      return list.data[0]
    })
    assert.equal(conv.temperature, 1.2)
    assert.equal(conv.topP, 0.9)
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
    assert.deepEqual(body.options, { temperature: 1.2, top_p: 0.9, seed: 7 })
  })

  await step('ragionamento spento: think=false e nessun blocco', async () => {
    await page.getByTestId('model-settings').getByRole('switch', { name: 'Ragionamento' }).uncheck({ force: true })
    await page.waitForFunction(async () => (await window.api.conversations.list()).data[0].think === false)
    await composer.fill('Rispondi subito')
    await composer.press('Enter')
    await page.getByTestId('message-assistant').nth(1).waitFor()
    assert.equal(lastChat().think, false)
    assert.equal(await page.getByTestId('message-assistant').nth(1).getByTestId('thinking-block').count(), 0)
  })

  await step('nessun errore JavaScript nel renderer (fase 3)', async () => {
    assert.deepEqual(errors, [])
  })

  await page.getByTestId('message-assistant').first().getByTestId('thinking-text').waitFor()
  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase3.png') })
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
