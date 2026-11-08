// Formattazione condivisa (funzioni pure, testabili senza interfaccia). Segue la lingua attiva.
import { localeTag, t } from './i18n'

/** Tempo trascorso leggibile: «0,8 s», «12 s», «1 min 05 s». */
export function formatElapsed(ms: number): string {
  const s = ms / 1000
  // Troncato (non arrotondato): 9,95 s resta «9,9 s» e non diventa «10,0 s».
  const tenths = Math.floor(s * 10) / 10
  if (s < 10) return `${tenths.toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  if (s < 60) return `${Math.floor(s)} s`
  const m = Math.floor(s / 60)
  return t('format.minSec', { min: m, sec: String(Math.floor(s % 60)).padStart(2, '0') })
}

const time = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit' })
const dayMonth = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short' })
const dayMonthYear = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' })
const full = (): Intl.DateTimeFormat => new Intl.DateTimeFormat(localeTag(), { dateStyle: 'full', timeStyle: 'short' })

/** Mezzanotte del giorno di `d` spostato di `offsetDays` (dal calendario: corretto anche col cambio d'ora). */
const startOfDay = (d: Date, offsetDays = 0): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays).getTime()

/**
 * Data di un messaggio, compatta: «Oggi, 14:32», «Ieri, 09:10», «3 nov, 14:32»,
 * con l'anno solo se diverso da quello di `now` («3 nov 2025, 14:32»).
 */
export function formatMessageDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const day = startOfDay(d)
  const hm = time().format(d)
  if (day === startOfDay(new Date(now))) return t('format.today', { time: hm })
  if (day === startOfDay(new Date(now), -1)) return t('format.yesterday', { time: hm })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${(sameYear ? dayMonth() : dayMonthYear()).format(d)}, ${hm}`
}

/** Data completa per il tooltip: «martedì 3 novembre 2026 alle ore 14:32». */
export function formatFullDate(ts: number): string {
  return full().format(new Date(ts))
}

/**
 * Estratto leggibile di un messaggio (per il tooltip della cronologia): senza sintassi Markdown,
 * blocchi di codice sostituiti da «[codice]», spazi compattati, tagliato a `max` caratteri
 * su un confine di parola con «…».
 */
export function excerpt(text: string, max = 120): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ` ${t('format.code')} `) // blocchi di codice (anche non chiusi, in streaming)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // immagini → testo alternativo
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → testo
    .replace(/`([^`]*)`/g, '$1') // codice in linea
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '') // titoli, citazioni, elenchi
    .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, ' ') // righe di separazione delle tabelle
    .replace(/\|/g, ' ')
    .replace(/(^|[^\w*~])(\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\2(?![\w*~])/g, '$1$3') // grassetto, corsivo, barrato (non dentro le parole)
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + '…'
}

/**
 * Posizioni dei pallini della cronologia, in pixel dall'alto della linea (altezza `height`).
 * `ratios` (0–1, crescenti) è dove ogni messaggio inizia rispetto all'intera conversazione.
 * I pallini restano proporzionali, ma due pallini distano almeno `minGap`; se non ci stanno
 * tutti, si distribuiscono a distanza regolare su tutta l'altezza.
 */
export function timelinePositions(ratios: number[], height: number, minGap: number): number[] {
  const n = ratios.length
  if (n === 0) return []
  if (n === 1) return [Math.min(Math.max(ratios[0], 0), 1) * height]
  if ((n - 1) * minGap >= height) return ratios.map((_, i) => (i * height) / (n - 1))
  const pos = ratios.map((r) => Math.min(Math.max(r, 0), 1) * height)
  // in avanti: ogni pallino almeno minGap sotto il precedente…
  for (let i = 1; i < n; i++) pos[i] = Math.max(pos[i], pos[i - 1] + minGap)
  // …all'indietro: senza uscire dal fondo della linea
  pos[n - 1] = Math.min(pos[n - 1], height)
  for (let i = n - 2; i >= 0; i--) pos[i] = Math.min(pos[i], pos[i + 1] - minGap)
  return pos
}

/** Prima riga significativa di un riassunto: salta i titoli ("# …", "Fatti stabiliti:") e toglie elenchi e grassetti. */
export function summaryPreview(summary: string): string {
  const lines = summary
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ heading: /^#/.test(l) || /:\**$/.test(l), text: l.replace(/^(#+\s*|[-*•]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '').trim() }))
    .filter((l) => l.text)
  return (lines.find((l) => !l.heading) ?? lines[0])?.text ?? ''
}
