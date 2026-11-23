// Controlli a regole fisse sulle risposte dell'Esperto di prompt engineering: funzioni pure, senza modello.
// Dicono se una risposta rispetta le scelte del ruolo; la qualità del prompt la giudica Claude (judge.ts).
import type { RoleChoices } from '../src/shared/roles'
import type { BenchCase, Check, Turn } from './types'

/** I blocchi di codice di una risposta (il prompt prodotto sta lì) e il testo fuori dai blocchi. */
export function splitAnswer(answer: string): { blocks: string[]; outside: string; before: string; after: string } {
  const blocks: string[] = []
  const fence = /```[^\n]*\n([\s\S]*?)```/g
  let outside = ''
  let before = ''
  let last = 0
  for (let m = fence.exec(answer); m; m = fence.exec(answer)) {
    if (blocks.length === 0) before = answer.slice(0, m.index)
    outside += answer.slice(last, m.index)
    blocks.push(m[1])
    last = m.index + m[0].length
  }
  const after = blocks.length ? answer.slice(last) : ''
  return { blocks, outside: (outside + answer.slice(last)).trim(), before: before.trim(), after: after.trim() }
}

/** Righe che cominciano un punto numerato («1.», «2)»…), anche in grassetto. */
const numberedPoints = (text: string): number => (text.match(/^\s*(\*\*)?\d+[.)]/gm) ?? []).length

const has = (choices: RoleChoices, parameter: string, option: string): boolean => {
  const value = choices[parameter]
  return Array.isArray(value) ? value.includes(option) : value === option
}

const EXAMPLE = /<\/?(esempio|exemple|example)>|^\s*(esempio|exemple|example)\s*\d*\s*:|ecco un esempio|voici un exemple/im
const DECLARED = /ipotes|ipotizz|presum|suppo|assum|do per scontato|scelte (fatte|prese)|ho (scelto|deciso|stabilito)|hypoth[èe]s|choix|j'ai (choisi|décidé)/i
/** Voci «Etichetta: valore» («Pubblico: bambini; Lunghezza: breve»), anche a punti elenco. */
const LABELLED = /(^|[;\n])\s*[-*•]?\s*\**[A-ZÀ-Ù][^:;\n]{1,30}:\**\s*\S/g

/**
 * Prima del prompt il modello dichiara ciò che ha scelto al posto dell'utente? Vale qualunque formula
 * («Ho ipotizzato…», «Scelte fatte: …», «Pubblico: …; Lunghezza: …»); non una frase di cortesia («Ecco il
 * prompt:») né un elenco numerato che non parla di ipotesi o scelte: lì è una diagnosi fuori posto.
 */
export function declaresChoices(before: string): boolean {
  if (DECLARED.test(before)) return true
  return numberedPoints(before) < 2 && (before.match(LABELLED) ?? []).length >= 2
}

/**
 * I punti di una spiegazione, comunque siano scritti: righe numerate, punti elenco, oppure paragrafi o frasi
 * (tolta la riga di introduzione, «Ecco le scelte fatte:»).
 */
export function explanationPoints(after: string): { count: number; unit: string } {
  const numbered = numberedPoints(after)
  if (numbered) return { count: numbered, unit: 'punti numerati' }
  const bullets = (after.match(/^\s*[-*•]\s+\S/gm) ?? []).length
  if (bullets) return { count: bullets, unit: 'punti elenco' }
  const body = after.trim().replace(/^[^\n]{0,80}:\s*(\n|$)/, '').trim()
  if (!body) return { count: 0, unit: 'punti' }
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim())
  if (paragraphs.length > 1) return { count: paragraphs.length, unit: 'paragrafi' }
  return { count: body.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ù«"])/).filter((s) => s.trim()).length, unit: 'frasi' }
}

/**
 * I controlli che valgono per un caso, date le scelte del ruolo. `turns` sono le battute nell'ordine: la prima
 * risponde alla richiesta, l'eventuale seconda alla risposta dell'utente alle domande.
 */
export function runChecks(testCase: BenchCase, choices: RoleChoices, turns: Turn[]): Check[] {
  const checks: Check[] = []
  const add = (id: string, pass: boolean, detail: string): void => void checks.push({ id, pass, detail })
  const first = turns[0]
  if (!first) return [{ id: 'eseguito', pass: false, detail: 'nessuna risposta' }]

  for (const [i, turn] of turns.entries()) {
    if (turn.error) add(`senza-errori-${i + 1}`, false, turn.error)
    else if (turn.doneReason && turn.doneReason !== 'stop') add(`risposta-completa-${i + 1}`, false, `la risposta si è fermata per «${turn.doneReason}»`)
  }
  if (!first.answer.trim()) {
    add('risposta', false, 'risposta vuota')
    return checks
  }

  const opening = splitAnswer(first.answer)
  if (testCase.expect === 'ask') {
    add('fa-domande', opening.blocks.length === 0 && first.answer.includes('?'), opening.blocks.length ? 'ha scritto subito il prompt invece di chiedere' : first.answer.includes('?') ? 'ha chiesto prima di scrivere' : 'non ha chiesto nulla')
  } else if (testCase.expect === 'diagnosis') {
    add('non-riscrive', opening.blocks.length === 0, opening.blocks.length ? 'ha riscritto il prompt invece di elencare i problemi' : 'non ha riscritto il prompt')
    add('elenca-problemi', numberedPoints(first.answer) >= 2, `${numberedPoints(first.answer)} punti numerati`)
    return checks
  }

  // Il prompt prodotto: nella prima battuta, oppure nella seconda dopo le risposte dell'utente.
  const final = turns.findLast((t) => splitAnswer(t.answer).blocks.length > 0)
  if (testCase.expect === 'ask' && !testCase.reply) return checks
  if (!final) {
    add('blocco-di-codice', false, 'nessun prompt in un blocco di codice')
    return checks
  }
  const { blocks, before, after } = splitAnswer(final.answer)
  const prompt = blocks.join('\n')
  add('blocco-di-codice', true, `${blocks.length} blocco/i, ${prompt.length} caratteri`)

  if (!has(choices, 'tecniche', 'esempi')) {
    const found = EXAMPLE.exec(prompt)
    add('niente-esempi-non-richiesti', !found, found ? `il prompt contiene un esempio («${found[0].trim()}») senza la tecnica scelta` : 'nessun esempio nel prompt')
  }

  const titles = (prompt.match(/^#{1,3} \S/gm) ?? []).length
  if (has(choices, 'tipo', 'messaggio')) add('senza-titoli-di-sezione', titles === 0, titles ? `${titles} titoli di sezione in un messaggio da incollare` : 'nessun titolo di sezione')
  if (has(choices, 'tipo', 'sistema')) add('con-sezioni', titles >= 2, `${titles} titoli di sezione`)

  const points = explanationPoints(after)
  if (has(choices, 'spiegazione', 'nessuna')) add('senza-spiegazione', after.length < 200, after.length < 200 ? 'nessuna spiegazione dopo il prompt' : `${after.length} caratteri dopo il prompt`)
  else if (choices.spiegazione) add('spiegazione-in-tre-punti', points.count === 3, `${points.count} ${points.unit} dopo il prompt`)

  if (has(choices, 'metodo', 'subito') && testCase.expect === 'prompt') add('ipotesi-dichiarate', declaresChoices(before), declaresChoices(before) ? 'ipotesi dichiarate prima del prompt' : 'nessuna ipotesi dichiarata prima del prompt')

  if (testCase.creative) {
    const delimiter = /<[a-zà-ù_-]+>[\s\S]*<\/[a-zà-ù_-]+>|"""/i.test(prompt)
    add('niente-delimitatori-inutili', !delimiter, delimiter ? 'delimitatori in un prompt che non ha un testo da elaborare' : 'nessun delimitatore')
    // «Se manca…», «Se non è specificato…», ma anche «Se durante la narrazione un elemento chiave … manca».
    const missing = /\bse\b[^.\n]{0,120}?\b(manca|mancano|mancant[ei]|non (è|sono|viene|vengono|hai|disponi)[^.\n]{0,30}(specificat|indicat|fornit|present|dettagli))/i.exec(prompt)
    add('niente-regola-sul-dato-mancante', !missing, missing ? `regola sul dato mancante fuori posto: «${missing[0]}»` : 'nessuna regola sul dato mancante')
  }
  return checks
}

/** Quota di controlli superati (1 se non ce ne sono). */
export const passRate = (checks: Check[]): number => (checks.length ? checks.filter((c) => c.pass).length / checks.length : 1)
