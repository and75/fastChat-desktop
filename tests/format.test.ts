import { describe, expect, it } from 'vitest'
import { excerpt, formatElapsed, formatFullDate, formatMessageDate, timelinePositions } from '../src/shared/format'

describe('formatElapsed', () => {
  it('decimi sotto i 10 secondi, poi secondi interi, poi minuti', () => {
    expect(formatElapsed(0)).toBe('0,0 s')
    expect(formatElapsed(840)).toBe('0,8 s')
    expect(formatElapsed(9_950)).toBe('9,9 s')
    expect(formatElapsed(12_400)).toBe('12 s')
    expect(formatElapsed(59_999)).toBe('59 s')
    expect(formatElapsed(65_000)).toBe('1 min 05 s')
    expect(formatElapsed(3 * 60_000 + 42_000)).toBe('3 min 42 s')
  })
})

describe('formatMessageDate', () => {
  // date locali (il formato dipende dal fuso del sistema, come nell'app)
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
  const now = at(2026, 11, 4, 10, 0)

  it('oggi e ieri con l\'ora', () => {
    expect(formatMessageDate(at(2026, 11, 4, 9, 5), now)).toBe('Oggi, 09:05')
    expect(formatMessageDate(at(2026, 11, 4, 0, 0), now)).toBe('Oggi, 00:00')
    expect(formatMessageDate(at(2026, 11, 3, 23, 59), now)).toBe('Ieri, 23:59')
    expect(formatMessageDate(at(2026, 11, 3, 0, 1), now)).toBe('Ieri, 00:01')
  })

  it('giorno e mese nello stesso anno, anno se diverso', () => {
    expect(formatMessageDate(at(2026, 11, 2, 14, 32), now)).toBe('2 nov, 14:32')
    expect(formatMessageDate(at(2026, 1, 15, 8, 0), now)).toBe('15 gen, 08:00')
    expect(formatMessageDate(at(2025, 12, 31, 18, 45), now)).toBe('31 dic 2025, 18:45')
  })

  it('ieri a cavallo del cambio d\'ora (ultima domenica di ottobre)', () => {
    const monday = at(2026, 10, 26, 10, 0)
    expect(formatMessageDate(at(2026, 10, 25, 1, 30), monday)).toBe('Ieri, 01:30')
    expect(formatMessageDate(at(2026, 10, 24, 23, 0), monday)).toBe('24 ott, 23:00')
  })

  it('data completa per il tooltip', () => {
    expect(formatFullDate(at(2026, 11, 3, 14, 32))).toMatch(/martedì 3 novembre 2026.*14:32/)
  })
})

describe('excerpt', () => {
  it('toglie la sintassi Markdown e sostituisce i blocchi di codice', () => {
    expect(excerpt('# Titolo\n\nUn **grassetto**, un _corsivo_ e `codice`.')).toBe('Titolo Un grassetto, un corsivo e codice.')
    expect(excerpt('Ecco:\n\n```ts\nconst x = 1\n```\n\nFatto.')).toBe('Ecco: [codice] Fatto.')
    expect(excerpt('- uno\n- due\n1. tre\n> citazione')).toBe('uno due tre citazione')
    expect(excerpt('Vedi [la guida](https://x.y) e ![logo](a.png)')).toBe('Vedi la guida e logo')
    expect(excerpt('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2')
    expect(excerpt('In corso:\n```py\nprint(1)')).toBe('In corso: [codice]')
    expect(excerpt('snake_case_name e 2 * 3 * 4')).toBe('snake_case_name e 2 * 3 * 4')
  })

  it('taglia sul confine di parola con i puntini', () => {
    const long = 'parola '.repeat(40)
    const out = excerpt(long, 50)
    expect(out.length).toBeLessThanOrEqual(51)
    expect(out.endsWith('parola…')).toBe(true)
    expect(excerpt('breve', 50)).toBe('breve')
    expect(excerpt('   ')).toBe('')
  })
})

describe('timelinePositions', () => {
  it('proporzionali quando i messaggi sono distanti', () => {
    expect(timelinePositions([0, 0.5, 0.9], 200, 10)).toEqual([0, 100, 180])
  })

  it('distanza minima tra pallini vicini, senza uscire dalla linea', () => {
    expect(timelinePositions([0, 0.01, 0.02, 0.5], 200, 10)).toEqual([0, 10, 20, 100])
    expect(timelinePositions([0.9, 0.95, 1], 100, 10)).toEqual([80, 90, 100])
  })

  it('troppi pallini: distanza regolare su tutta l\'altezza', () => {
    expect(timelinePositions([0, 0.1, 0.2, 0.3, 0.4], 20, 10)).toEqual([0, 5, 10, 15, 20])
  })

  it('casi limite', () => {
    expect(timelinePositions([], 100, 10)).toEqual([])
    expect(timelinePositions([0.3], 100, 10)).toEqual([30])
  })
})
