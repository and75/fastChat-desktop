import { describe, expect, it } from 'vitest'
import { formatElapsed, formatFullDate, formatMessageDate } from '../src/shared/format'

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
