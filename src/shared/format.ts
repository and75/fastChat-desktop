// Formattazione condivisa (funzioni pure, testabili senza interfaccia).

/** Tempo trascorso leggibile: «0,8 s», «12 s», «1 min 05 s». */
export function formatElapsed(ms: number): string {
  const s = ms / 1000
  // Troncato (non arrotondato): 9,95 s resta «9,9 s» e non diventa «10,0 s».
  const tenths = Math.floor(s * 10) / 10
  if (s < 10) return `${tenths.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  if (s < 60) return `${Math.floor(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`
}

const time = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' })
const dayMonthYear = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })
const full = new Intl.DateTimeFormat('it-IT', { dateStyle: 'full', timeStyle: 'short' })

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
  const hm = time.format(d)
  if (day === startOfDay(new Date(now))) return `Oggi, ${hm}`
  if (day === startOfDay(new Date(now), -1)) return `Ieri, ${hm}`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${(sameYear ? dayMonth : dayMonthYear).format(d)}, ${hm}`
}

/** Data completa per il tooltip: «martedì 3 novembre 2026 alle ore 14:32». */
export function formatFullDate(ts: number): string {
  return full.format(new Date(ts))
}
