import { describe, expect, it } from 'vitest'
import { normalizeMath } from '../src/shared/math'

describe('formule nel testo del modello', () => {
  it('lascia com\'è ciò che il parser capisce già', () => {
    const s = '($\\text{C}$): $\\text{F} \\rightarrow \\text{G} \\rightarrow \\text{C} \\rightarrow \\text{F}$'
    expect(normalizeMath(s)).toBe(s)
    expect(normalizeMath('$$\nE = mc^2\n$$')).toBe('$$\nE = mc^2\n$$')
    expect(normalizeMath('testo semplice')).toBe('testo semplice')
  })
  it('converte \\(…\\) e \\[…\\]', () => {
    expect(normalizeMath('area \\(\\pi r^2\\) e\n\\[\na^2+b^2=c^2\n\\]')).toBe('area $\\pi r^2$ e\n$$\na^2+b^2=c^2\n$$')
  })
  it('non tocca il codice', () => {
    expect(normalizeMath('`\\(x\\)` e\n```sh\necho "$1 \\[a\\]"\n```')).toBe('`\\(x\\)` e\n```sh\necho "$1 \\[a\\]"\n```')
  })
  it('i prezzi non sono formule', () => {
    expect(normalizeMath('costa $5 e poi $10 al mese')).toBe('costa \\$5 e poi \\$10 al mese')
    expect(normalizeMath('solo $20')).toBe('solo \\$20')
    expect(normalizeMath('vale $2x$ e $x$')).toBe('vale $2x$ e $x$')
  })
})
