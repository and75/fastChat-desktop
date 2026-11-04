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
