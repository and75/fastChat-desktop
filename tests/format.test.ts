import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../src/shared/format'

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
