// Smoke test dell'app impacchettata (dist/linux-unpacked): avvio, migrazioni dall'asar, elenco modelli, una risposta.
// Uso: npm run dist:linux && xvfb-run -a node e2e/packaged.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startFakeOllama } from '../tests/helpers/fakeOllama.ts'

const exe = resolve(import.meta.dirname, '../dist/linux-unpacked/fastchat-desktop')
if (!existsSync(exe)) throw new Error(`Eseguibile non trovato: ${exe} (prima: npm run dist:linux)`)
const userData = mkdtempSync(join(tmpdir(), 'fastchat-pkg-'))
const fake = await startFakeOllama([{ name: 'llama3.2:3b', capabilities: ['completion'] }])
const app = await electron.launch({
  executablePath: exe,
  args: ['--no-sandbox'],
  env: { ...process.env, OLLAMA_URL: fake.url, FASTCHAT_USER_DATA: userData }
})
try {
  const page = await app.firstWindow()
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  await page.locator('#model-select option', { hasText: 'llama3.2:3b' }).waitFor({ state: 'attached' })
  await page.getByRole('button', { name: '+ Nuova conversazione' }).click()
  await page.getByLabel('Messaggio').fill('Ciao')
  await page.getByLabel('Messaggio').press('Enter')
  await page.getByTestId('message-assistant').filter({ hasText: 'Ciao mondo!' }).waitFor()
  assert.equal(existsSync(join(userData, 'chats.db')), true)
  console.log('✓ app impacchettata: avvio, migrazioni, modelli e chat ok')
} finally {
  await app.close()
  await fake.close()
  rmSync(userData, { recursive: true, force: true })
}
