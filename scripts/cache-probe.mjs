#!/usr/bin/env node
// Prova del riuso di Ollama: quanto costa una domanda in più a seconda di dove stanno gli estratti.
//
// Uso (Ollama acceso, modello già scaricato):
//   node scripts/cache-probe.mjs --model gemma4:e4b
//   node scripts/cache-probe.mjs --model gemma4:e4b --exchanges 30 --ctx 16384 --url http://127.0.0.1:11434
//
// Cosa fa: costruisce una conversazione finta di N scambi e fa due domande di seguito, in tre modi:
//   A  estratti nel system prompt (com'è oggi)
//   B  estratti accanto alla domanda (system prompt fermo)
//   =  la stessa identica richiesta due volte (riferimento: tutto già letto)
// Per ogni richiesta stampa i token del prompt contati da Ollama (prompt_eval_count), il tempo di lettura del
// prompt, e il tempo al primo frammento misurato da qui. Non usa né modifica i dati dell'app.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []))
const MODEL = args.model
const URL = (args.url ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
const EXCHANGES = Number(args.exchanges ?? 20)
const NUM_CTX = Number(args.ctx ?? 16384)
if (!MODEL) {
  console.error('Manca il modello: node scripts/cache-probe.mjs --model gemma4:e4b')
  process.exit(1)
}

const SYSTEM = '# Ruolo\nSei un consulente che risponde in modo breve e preciso.\n\n# Vincoli\nRispondi in italiano, in una frase.'
const TOPICS = ['il budget del progetto', 'le scadenze', 'i fornitori', 'il personale', 'i rischi', 'la qualità', 'i clienti', 'la logistica']
const paragraph = (i, n = 6) => Array.from({ length: n }, (_, k) => `Nota ${i}.${k + 1}: per ${TOPICS[(i + k) % TOPICS.length]} il valore concordato è ${1000 + i * 37 + k * 11} e la revisione è fissata al giorno ${1 + ((i * 3 + k) % 27)}.`).join(' ')
const history = []
for (let i = 0; i < EXCHANGES; i++) {
  history.push({ role: 'user', content: `Domanda ${i + 1}: riassumi lo stato di ${TOPICS[i % TOPICS.length]}. ${paragraph(i, 2)}` })
  history.push({ role: 'assistant', content: `Risposta ${i + 1}: ${paragraph(i + 100, 4)}` })
}
/** Estratti «trovati» per una domanda: diversi a ogni domanda, come nella realtà. */
const excerpts = (k) => `# Base di conoscenza\n\n${Array.from({ length: 8 }, (_, j) => `[documento ${k}-${j + 1}]\n${paragraph(k * 50 + j, 5)}`).join('\n\n')}`
const QUESTIONS = ['Qual è il valore concordato più alto tra quelli che hai visto?', 'E quale revisione cade per prima nel mese?']

async function chat(messages) {
  const started = Date.now()
  const res = await fetch(`${URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: true, think: false, options: { num_ctx: NUM_CTX, temperature: 0, seed: 1, num_predict: 24 } })
  })
  if (!res.ok) throw new Error(`Ollama ha risposto ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const decoder = new TextDecoder()
  let buffer = ''
  let first = null
  let content = ''
  let done = null
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const obj = JSON.parse(line)
      if (obj.error) throw new Error(obj.error)
      if ((obj.message?.content || obj.message?.thinking) && first == null) first = Date.now() - started
      content += obj.message?.content ?? ''
      if (obj.done) done = obj
    }
  }
  const ms = (ns) => (typeof ns === 'number' ? Math.round(ns / 1e6) : null)
  return { content: content.trim(), promptTokens: done?.prompt_eval_count ?? null, promptMs: ms(done?.prompt_eval_duration), loadMs: ms(done?.load_duration), firstMs: first }
}

/** Messaggi di una domanda nei due ordini; `asked` sono le domande già fatte in questa prova, con le risposte. */
function build(order, asked, k) {
  const tail = asked.flatMap((x) => [{ role: 'user', content: x.question }, { role: 'assistant', content: x.answer }])
  const question = QUESTIONS[k]
  if (order === 'A') return [{ role: 'system', content: `${SYSTEM}\n\n${excerpts(k)}` }, ...history, ...tail, { role: 'user', content: question }]
  return [{ role: 'system', content: SYSTEM }, ...history, ...tail, { role: 'user', content: `${excerpts(k)}\n\n# Domanda\n${question}` }]
}

const rows = []
const run = async (label, messages) => {
  const r = await chat(messages)
  rows.push({ prova: label, 'token prompt (Ollama)': r.promptTokens, 'lettura prompt ms': r.promptMs, 'primo frammento ms': r.firstMs, 'caricamento ms': r.loadMs })
  return r
}

console.log(`Modello ${MODEL} · ${EXCHANGES} scambi · num_ctx ${NUM_CTX} · ${URL}\n`)
try {
  // Riscaldamento: carica il modello, così i tempi non includono il caricamento.
  await chat([{ role: 'user', content: 'ok' }])

  for (const order of ['A', 'B']) {
    // Una richiesta diversa in mezzo: la prova parte senza nulla di riusabile dell'altra.
    await chat([{ role: 'user', content: `azzera ${order}` }])
    const first = await run(`${order} · domanda 1 (niente da riusare)`, build(order, [], 0))
    await run(`${order} · domanda 2 (dopo la 1)`, build(order, [{ question: QUESTIONS[0], answer: first.content || 'Ok.' }], 1))
  }

  await chat([{ role: 'user', content: 'azzera =' }])
  const same = build('B', [], 0)
  await run('= · prima volta', same)
  await run('= · stessa richiesta, seconda volta', same)
} catch (err) {
  console.error(`\nErrore: ${err.message}\nControlla che Ollama sia acceso (${URL}) e che il modello «${MODEL}» sia installato (ollama list).`)
  process.exit(1)
}

console.table(rows)
const get = (label) => rows.find((r) => r.prova.startsWith(label))
const a2 = get('A · domanda 2')
const b2 = get('B · domanda 2')
const s1 = get('= · prima')
const s2 = get('= · stessa')
console.log('\nCome leggere i risultati')
console.log(`1. prompt_eval_count conta solo i token nuovi? Stessa richiesta due volte: ${s1['token prompt (Ollama)']} poi ${s2['token prompt (Ollama)']} token.`)
console.log(s2['token prompt (Ollama)'] != null && s1['token prompt (Ollama)'] != null && s2['token prompt (Ollama)'] < s1['token prompt (Ollama)'] * 0.5 ? '   → Sì: la seconda volta ne conta molti meno. Il valore misura ciò che Ollama ha davvero riletto.' : '   → No: conta tutto il prompt anche quando è già in memoria. Per il riuso guarda i tempi, non i token.')
console.log(`2. Riuso con l'ordine B: alla seconda domanda il tempo di lettura è ${b2['lettura prompt ms']} ms (B) contro ${a2['lettura prompt ms']} ms (A);`)
console.log(`   primo frammento dopo ${b2['primo frammento ms']} ms (B) contro ${a2['primo frammento ms']} ms (A).`)
if (a2['lettura prompt ms'] && b2['lettura prompt ms']) console.log(`   → B legge il prompt in ${Math.round((b2['lettura prompt ms'] / a2['lettura prompt ms']) * 100)}% del tempo di A.`)
console.log('\nIncolla questa tabella nella conversazione: serve a fissare i valori predefiniti.')
