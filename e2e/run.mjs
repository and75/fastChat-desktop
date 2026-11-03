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
  { name: 'llama3.2:3b', capabilities: ['completion', 'tools'] }
])

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
    assert.deepEqual(options, ['llama3.2:3b', 'qwen3:4b'])
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

  await step('nessun errore JavaScript nel renderer', async () => {
    assert.deepEqual(errors, [])
  })

  await page.screenshot({ path: join(root, 'test-results', 'e2e-phase1.png') })
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
