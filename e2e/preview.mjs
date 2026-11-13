// Schermate di anteprima delle funzioni recenti, con una conversazione realistica e un Ollama simulato.
// Uso: npm run build && xvfb-run -a node e2e/preview.mjs   (immagini in test-results/preview/)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startFakeOllama } from '../tests/helpers/fakeOllama.ts'

const root = resolve(import.meta.dirname, '..')
const out = (name) => join(root, 'test-results', 'preview', name)

const ANSWERS = [
  [/budget|ottocento/i, 'Con **800 € a persona** per una settimana il piano regge: 4 notti a Lisbona e 3 a Porto in hotel tre stelle (circa 90 € a notte in doppia), treno Alfa Pendular tra le due città (25–35 €), e un margine di circa 150 € per cene e musei.'],
  [/treno|voli/i, 'Il treno è la scelta giusta: **Lisbona–Porto in 2 h 50** con l\'Alfa Pendular, partenze ogni ora, da prenotare sul sito di CP con 2–3 settimane di anticipo per le tariffe promozionali.'],
  [/mangiare|cucina/i, 'A Porto: **francesinha** (da Café Santiago), **tripas à moda do Porto** e un bicchiere di vinho verde. A Lisbona i **pastéis de nata** di Manteigaria e il baccalà in tutte le sue varianti.'],
  [/musei/i, 'Due da non perdere: il **Museu Calouste Gulbenkian** (collezione eccezionale, mezza giornata) e il **Museu Nacional do Azulejo**, per capire le piastrelle che vedrai ovunque.'],
  [/hotel|appartamento/i, 'Per una settimana in coppia conviene l\'**hotel in Baixa o Chiado**: tutto a piedi, colazione inclusa, e il prezzo resta dentro i 90 € a notte.'],
  [/Sintra/i, 'Sì, Sintra merita una giornata: treno da Rossio in 40 minuti, **Palácio da Pena** al mattino presto per evitare la coda, poi Quinta da Regaleira.'],
  [/quanto.*persona|ricordami|riepilog/i, 'Il budget fissato all\'inizio era di **800 € a persona**: con hotel, treno e Sintra restano circa **110 € di margine** per cene e ingressi.']
]

const SUMMARY = `Fatti stabiliti:
- Viaggio in Portogallo di una settimana, budget 800 € a persona.
- 4 notti a Lisbona e 3 a Porto, hotel tre stelle (~90 €/notte in doppia).
- Spostamento Lisbona–Porto in treno (Alfa Pendular, 2 h 50), niente voli interni.
- Cucina: francesinha e tripas a Porto, pastéis de nata a Lisbona.
- Musei: Gulbenkian e Museu do Azulejo.

Richieste aperte:
- Programma della giornata a Sintra.`

const respond = (messages) => {
  const system = messages[0]?.content ?? ''
  if (system.startsWith("Sei l'archivista")) return SUMMARY
  if (system.startsWith('Genera un titolo')) return /fondo rischi/.test(messages.at(-1)?.content ?? '') ? 'Bilancio e contratto' : 'Viaggio in Portogallo'
  const last = messages.at(-1)?.content ?? ''
  if (system.includes('# Base di conoscenza')) return 'Secondo la nota integrativa il **fondo rischi ammonta a trecentomila euro** [bilancio, p. 2]; il contratto prevede una penale dello 0,5% al giorno [contratto, Contratto di fornitura › Penali].'
  if (/quinte/i.test(last)) return String.raw`Nel circolo delle quinte si sale di una quinta giusta a ogni passo.

- Fa maggiore ($\text{F}$): $\text{F} \rightarrow \text{G} \rightarrow \text{C} \rightarrow \text{F}$
- Rapporto di frequenza della quinta: \(\frac{3}{2}\); il biglietto del concerto costa $5 o $10.

\[
f_n = f_0 \cdot \left(\frac{3}{2}\right)^n \cdot 2^{-k}
\]`.replaceAll('\\\\', '\\')
  if (last.includes('Riassumi il testo')) return 'La memoria è condivisa tra pesi e contesto.'
  const base = ANSWERS.find(([re]) => re.test(last))?.[1] ?? 'Va bene.'
  return last.startsWith('Ricordami') ? base : `${base}\n\nSe vuoi, preparo anche un itinerario giorno per giorno con orari e costi stimati per ogni tappa, così teniamo sotto controllo il budget complessivo.`
}

const fake = await startFakeOllama([
  {
    name: 'gemma3:27b',
    capabilities: ['completion'],
    contextLength: 131072,
    size: 17 * 1024 ** 3,
    parameters: 'temperature 1\ntop_p 0.95\nnum_ctx 4096',
    modelInfo: { 'gemma3.block_count': 62, 'gemma3.attention.head_count': 32, 'gemma3.attention.head_count_kv': 16, 'gemma3.attention.key_length': 128, 'gemma3.attention.sliding_window': 1024, 'fake.block_count': 62 },
    gpu: true,
    cpuTps: 4.2,
    gpuTps: 2.9,
    delayMs: 15,
    respond
  },
  { name: 'qwen3:8b', capabilities: ['completion', 'thinking'], contextLength: 40960, size: 5.2 * 1024 ** 3, respond },
  { name: 'embeddinggemma:latest', capabilities: ['embedding'], size: 0.6 * 1024 ** 3 }
])

const packFile = join(mkdtempSync(join(tmpdir(), 'fastchat-preview-pack-')), 'archivio-aziendale.fcpack')
const app = await electron.launch({
  args: [root, '--no-sandbox'],
  env: {
    ...process.env,
    OLLAMA_URL: fake.url,
    FASTCHAT_USER_DATA: mkdtempSync(join(tmpdir(), 'fastchat-preview-')),
    FASTCHAT_LANG: 'it',
    FASTCHAT_PACK_EXPORT: packFile,
    FASTCHAT_PACK_FILE: packFile,
    FASTCHAT_KNOWLEDGE_FILES: [join(root, 'tests', 'fixtures', 'bilancio.pdf'), join(root, 'tests', 'fixtures', 'contratto.docx'), join(root, 'tests', 'fixtures', 'relazione.txt')].join(process.platform === 'win32' ? ';' : ':'),
    FASTCHAT_SYSTEM_RAM: String(32 * 1024 ** 3),
    FASTCHAT_SYSTEM_UNIFIED: '0',
    NODE_ENV: 'production'
  }
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1360, 860))
await page.waitForTimeout(500)

const settings = page.getByTestId('model-settings')
const box = page.getByRole('textbox', { name: 'Messaggio' })
const send = async (text, waitMs = 0) => {
  await box.fill(text)
  await box.press('Enter')
  if (waitMs) return
  await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 60000 })
  await page.waitForTimeout(300)
}

await page.getByTestId('new-conversation').click()
await page.selectOption('#model-select', 'gemma3:27b')
await page.getByRole('tab', { name: 'Modello' }).click()
const openGroups = () => page.evaluate(() => document.querySelectorAll('[data-testid="model-settings"] details[data-group]').forEach((d) => (d.open = true)))
await openGroups()
await settings.getByRole('radio', { name: 'Conciso' }).click()
// memoria bassa, per arrivare al riassunto in poche domande
const memory = settings.getByRole('slider', { name: 'Memoria della conversazione' })
await memory.focus()
await memory.press('Home')
await page.waitForTimeout(500)

for (const q of [
  'Organizziamo una settimana in Portogallo: il budget massimo è ottocento euro a persona, cosa ne pensi?',
  'Preferisco il treno ai voli interni, come ci spostiamo tra Lisbona e Porto?',
  'Cosa mangiare a Porto e a Lisbona?',
  'E quali musei non perdere a Lisbona?',
  'Meglio hotel o appartamento a Lisbona?'
]) await send(q)

// riassunto + ricerca prima della risposta: lo stato «Sto riassumendo…»
await page.getByTestId('model-settings').getByTestId('memory-panel').scrollIntoViewIfNeeded()
await box.fill('Vale la pena una giornata a Sintra?')
await box.press('Enter')
await page.getByTestId('message-streaming').getByText(/Sto riassumendo|Cerco nella conversazione/).waitFor({ timeout: 20000 }).catch(() => undefined)
await page.screenshot({ path: out('1-riassunto-in-corso.png') })
await page.getByTestId('message-streaming').waitFor({ state: 'detached', timeout: 60000 })

// memoria a lungo termine: scarica il modello, poi una domanda su un dettaglio dell'inizio
const memPanel = settings.getByTestId('memory-panel')
const download = memPanel.getByTestId('memory-download')
if (await download.isVisible().catch(() => false)) await download.click()
await memPanel.getByTestId('memory-status').filter({ hasText: /indicizzat|da indicizzare/ }).waitFor({ timeout: 20000 })
await send('Ricordami: quanto era il budget per persona?')
const refs = page.getByTestId('message-assistant').last().getByTestId('memory-refs')
await refs.locator('summary').click().catch(() => undefined)
await page.waitForTimeout(400)
await refs.scrollIntoViewIfNeeded().catch(() => undefined)
await page.getByTestId('summary-card').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('2-scheda-riassunto.png') })
await refs.scrollIntoViewIfNeeded().catch(() => undefined)
await memPanel.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('3-estratti-e-memoria.png') })

// pannello Modello: memoria sotto il minimo (rosso), esecuzione, stile
await settings.getByTestId('execution-row').scrollIntoViewIfNeeded()
await settings.getByText('Memoria della conversazione').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('4-pannello-modello.png') })

// in fondo al pannello Modello: stato del contesto, dettaglio del calcolo, chiamate a Ollama
await page.evaluate(() => document.querySelectorAll('[data-testid="model-settings"] details[data-group]').forEach((d) => (d.open = false)))
const monitor = page.getByTestId('context-monitor')
await monitor.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('7-pannello-modello-chiuso.png') })
await monitor.getByTestId('context-reconcile').locator('summary').click()
await page.waitForTimeout(300)
await page.screenshot({ path: out('8-dettaglio-del-calcolo.png') })
await monitor.getByTestId('context-reconcile').locator('summary').click()
await monitor.getByTestId('context-calls').locator('summary').click()
const pick = async (re) => {
  const options = await monitor.getByTestId('context-call-select').locator('option').allTextContents()
  const label = options.find((o) => re.test(o))
  if (label) await monitor.getByTestId('context-call-select').selectOption({ label })
  await page.waitForTimeout(300)
}
await pick(/^Risposta/)
await monitor.getByTestId('context-call').scrollIntoViewIfNeeded()
await page.waitForTimeout(200)
await page.screenshot({ path: out('9-chiamata-risposta.png') })
await monitor.getByTestId('context-calls').locator('summary').click()
await page.evaluate(() => { const d = document.querySelector('[data-testid="model-settings"] details[data-group="answer"]'); if (d) d.open = true })
await page.locator('#panel-model').evaluate((el) => el.scrollTo(0, 0))
await page.waitForTimeout(300)
await page.screenshot({ path: out('10-come-risponde.png') })
await page.getByRole('tab', { name: /Situazione/ }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: out('11-situazione-plan-mode.png') })
await page.getByRole('tab', { name: 'Modello' }).click()
await openGroups()

// impostazioni → Modelli: test CPU/GPU su gemma (GPU integrata: vince la CPU)
await page.getByRole('button', { name: 'Impostazioni' }).click()
const dialog = page.getByTestId('settings-dialog')
await dialog.getByRole('tab', { name: 'Modelli' }).click()
const gemmaRow = dialog.getByTestId('model-row').filter({ hasText: 'gemma3:27b' })
await gemmaRow.getByTestId('benchmark-run').click()
await gemmaRow.getByTestId('benchmark-table').waitFor({ timeout: 60000 })
await gemmaRow.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('5-impostazioni-modelli.png') })

// impostazioni → Ollama
await dialog.getByRole('tab', { name: 'Ollama' }).click()
await dialog.getByTestId('ollama-env').waitFor()
await dialog.getByLabel('GPU tramite Vulkan').selectOption('1')
await dialog.getByLabel('Modelli caricati insieme').selectOption('2')
await page.waitForTimeout(300)
await page.screenshot({ path: out('6-impostazioni-ollama.png') })

// interfaccia in inglese: Impostazioni → Generale → Lingua
await dialog.getByRole('tab', { name: 'Generale' }).click()
await dialog.getByTestId('settings-language').selectOption('en')
await dialog.getByRole('button', { name: 'Salva' }).click()
await dialog.waitFor({ state: 'detached' })
await page.getByRole('tab', { name: 'Model' }).waitFor()
await page.evaluate(() => document.querySelectorAll('[data-testid="model-settings"] details[data-group]').forEach((d) => (d.open = d.dataset.group === 'memory')))
await page.waitForTimeout(400)
await page.screenshot({ path: out('12-english.png') })
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByTestId('settings-dialog').waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: out('13-english-settings.png') })
// e in francese
await dialog.getByTestId('settings-language').selectOption('fr')
await dialog.getByRole('button', { name: 'Save' }).click()
await dialog.waitFor({ state: 'detached' })
await page.getByRole('tab', { name: 'Modèle' }).waitFor()
await page.waitForTimeout(400)
await page.screenshot({ path: out('14-french.png') })

// base di conoscenza: nuova conversazione, scheda, documenti (PDF, Word, testo), domanda con le fonti
await page.getByRole('button', { name: 'Paramètres' }).click()
await page.getByTestId('settings-dialog').getByTestId('settings-language').selectOption('it')
await page.getByTestId('settings-dialog').getByRole('button', { name: /Salva|Enregistrer/ }).click()
await page.getByTestId('settings-dialog').waitFor({ state: 'detached' })
// il salvataggio delle impostazioni ha riportato l'URL di Ollama a quello salvato: si rimette quello del finto
await page.evaluate((url) => window.api.settings.set({ ollamaUrl: url }), fake.url)
await page.getByTestId('new-conversation').click()
await page.selectOption('#model-select', 'gemma3:27b')
await page.getByRole('tab', { name: /Conoscenza/ }).click()
await page.getByTestId('knowledge-add').click()
await page.getByTestId('knowledge-panel').locator('[data-testid="knowledge-doc"][data-status="ready"]').nth(2).waitFor({ timeout: 30000 }).catch(async (err) => {
  console.log('documenti:', await page.getByTestId('knowledge-doc').allInnerTexts())
  await page.screenshot({ path: out('15-base-di-conoscenza-errore.png') })
  throw err
})
await page.waitForTimeout(400)
await page.screenshot({ path: out('15-base-di-conoscenza.png') })
await send('A quanto ammonta il fondo rischi, e quali penali prevede il contratto?')
await page.getByTestId('knowledge-refs').locator('summary').click()
await page.waitForTimeout(400)
await page.screenshot({ path: out('16-fonti-dai-documenti.png') })
await page.getByTestId('knowledge-button').click()
await box.fill('E a memoria, senza guardare i documenti?')
await page.waitForTimeout(300)
await page.screenshot({ path: out('17-libro-spento-per-una-domanda.png') })

// libreria delle basi: una base riutilizzabile creata nelle Impostazioni e collegata a una conversazione nuova
await box.fill('')
await page.getByRole('button', { name: 'Impostazioni' }).click()
const settingsDialog = page.getByTestId('settings-dialog')
await settingsDialog.getByRole('tab', { name: 'Conoscenza' }).click()
await settingsDialog.getByTestId('library-new-name').fill('Archivio aziendale')
await settingsDialog.getByTestId('library-create').click()
await settingsDialog.getByTestId('library-base-editor').getByTestId('knowledge-add').click()
await settingsDialog.locator('[data-testid="knowledge-doc"][data-status="ready"]').nth(2).waitFor({ timeout: 30000 })
await page.waitForTimeout(400)
await page.screenshot({ path: out('18-libreria-delle-basi.png') })
// esporta la base come pacchetto e mostra l'anteprima dell'importazione (modello dichiarato, firma)
await settingsDialog.getByTestId('library-base-export').click()
await settingsDialog.getByTestId('library-exported').waitFor()
await settingsDialog.getByTestId('library-import').click()
await settingsDialog.getByTestId('pack-preview').waitFor()
await settingsDialog.getByTestId('library-base').filter({ hasText: 'Archivio aziendale' }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: out('20-importa-pacchetto.png') })
await settingsDialog.getByTestId('pack-preview').getByRole('button', { name: 'Annulla' }).click()
await settingsDialog.getByRole('button', { name: 'Chiudi' }).click()
await settingsDialog.waitFor({ state: 'detached' })
await page.getByTestId('new-conversation').click()
await page.selectOption('#model-select', 'gemma3:27b')
await page.getByRole('tab', { name: /Conoscenza/ }).click()
await page.getByTestId('knowledge-link-select').selectOption({ index: 1 })
await page.getByTestId('knowledge-linked-base').waitFor()
await send('A quanto ammonta il fondo rischi, e quali penali prevede il contratto?')
await page.getByTestId('knowledge-refs').locator('summary').click()
await page.getByTestId('knowledge-linked').scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
await page.screenshot({ path: out('19-base-collegata.png') })

// store: finestra sopra la chat, categorie, Guida già installata; un pacchetto con ciò che contiene
await page.getByTestId('store-open').click()
const storeDialog = page.getByTestId('store-dialog')
await storeDialog.getByTestId('store-item').first().waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: out('21-store.png') })
await storeDialog.getByTestId('store-tab-identity').click()
await page.waitForTimeout(300)
await page.screenshot({ path: out('22-store-ruoli.png') })

// formule: LaTeX in linea e a blocco, prezzi lasciati come testo
await storeDialog.getByTestId('dialog-close').click()
await storeDialog.waitFor({ state: 'detached' })
await page.getByTestId('new-conversation').click()
await page.selectOption('#model-select', 'gemma3:27b')
await send('Spiegami il circolo delle quinte')
await page.locator('.katex').first().waitFor()
console.log('katex:', await page.locator('.katex').count(), '| display:', await page.locator('.katex-display').count(), '| testo:', (await page.getByTestId('message-assistant').last().innerText()).includes('$5 o $10'))
await page.waitForTimeout(400)
await page.screenshot({ path: out('23-formule.png') })

// impostazioni → Contesto: ordine dei blocchi, promemoria, quote
await page.getByRole('button', { name: 'Impostazioni' }).click()
await page.getByTestId('settings-dialog').getByRole('tab', { name: 'Contesto' }).click()
await page.getByTestId('context-mode-manual').click()
await page.getByTestId('context-order-B').click()
await page.getByTestId('context-reminder-on').click()
await page.waitForTimeout(300)
await page.screenshot({ path: out('24-impostazioni-contesto.png') })
await page.getByTestId('context-bar').scrollIntoViewIfNeeded()
await page.getByTestId('context-reset').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: out('25-impostazioni-contesto-memoria.png') })

// ---- ruoli: «Parla con un…», parametri, situazione, cambio di ruolo, basi del ruolo
await page.getByTestId('dialog-close').click()
await page.getByTestId('settings-dialog').waitFor({ state: 'detached' })
await page.getByTestId('new-conversation').click()
await page.getByTestId('role-menu-open').click()
await page.getByTestId('role-menu').getByTestId('role-option').nth(2).waitFor()
await page.getByTestId('role-menu').getByTestId('role-option').nth(2).hover()
await page.waitForTimeout(300)
await page.screenshot({ path: out('26-parla-con-un.png') })
await page.getByTestId('role-menu').getByTestId('role-option').filter({ hasText: 'Esperto di prompt engineering' }).click()
await page.getByRole('tab', { name: 'Modello' }).click()
const rolePanel = page.getByTestId('conversation-panel')
await rolePanel.getByTestId('role-name').filter({ hasText: 'Esperto' }).waitFor()
await page.evaluate(() => document.querySelectorAll('#panel-model details[data-group]').forEach((d) => (d.open = false)))
await page.waitForTimeout(300)
// al primo arrivo: tutte le sezioni chiuse, ciascuna con le sue scelte in una riga
await page.screenshot({ path: out('27-ruolo-sezioni-chiuse.png') })
await page.evaluate(() => document.querySelectorAll('[data-testid="role-panel"] details[data-group]').forEach((d) => (d.open = true)))
await rolePanel.locator('[data-parameter="intervento"]').getByRole('radio', { name: 'Spiega cosa non va' }).click()
await rolePanel.locator('[data-parameter="risultato"]').getByRole('radio', { name: 'Solo il risultato' }).click()
await rolePanel.locator('[data-parameter="tecniche"]').locator('label', { hasText: 'Passi numerati' }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: out('27-ruolo-parametri.png') })
await page.locator('#panel-model').evaluate((el) => el.scrollTo(0, el.scrollHeight))
await page.waitForTimeout(300)
await page.screenshot({ path: out('27-ruolo-parametri-seguito.png') })
await page.locator('#panel-model').evaluate((el) => el.scrollTo(0, 0))
await page.getByRole('tab', { name: /Situazione/ }).click()
await rolePanel.getByTestId('situation-text').fill("Sto scrivendo un prompt per classificare le email dell'assistenza clienti in quattro categorie: reso, fattura, guasto, altro.\n\nLe email sono in italiano, spesso con errori di battitura.")
await rolePanel.getByTestId('situation-status').filter({ hasText: 'Salvato' }).waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: out('28-situazione.png') })
await send('Migliora questo prompt: «Classifica le email»')
await page.getByRole('tab', { name: /Conoscenza/ }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: out('30-conoscenza-del-ruolo.png') })
await page.getByRole('tab', { name: 'Modello' }).click()
await rolePanel.getByTestId('role-change').click()
await rolePanel.getByTestId('role-picker').getByRole('menuitem', { name: /Assistente di FastChat/ }).click()
await page.getByTestId('role-change-dialog').waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: out('29-cambio-ruolo.png') })

await app.close()
await fake.close()
console.log('ok')
