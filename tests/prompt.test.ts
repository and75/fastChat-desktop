import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, estimateTokens, selectHistory, type HistoryMessage } from '../src/shared/prompt'

const brief = (b: Partial<Record<'role' | 'context' | 'goals' | 'constraints', string>>) => ({
  role: '',
  context: '',
  goals: '',
  constraints: '',
  ...b
})

describe('buildSystemPrompt', () => {
  it('brief vuoto → stringa vuota', () => {
    expect(buildSystemPrompt(brief({}))).toBe('')
    expect(buildSystemPrompt(brief({ role: '   \n ' }))).toBe('')
  })

  it('omette le sezioni vuote', () => {
    expect(buildSystemPrompt(brief({ goals: 'Spiegare bene' }))).toBe('# Obiettivi\nSpiegare bene')
  })

  it('ordine fisso Ruolo, Contesto, Obiettivi, Vincoli, a prescindere dall\'input', () => {
    const out = buildSystemPrompt({
      constraints: 'Rispondi in italiano',
      goals: 'G',
      context: 'C',
      role: 'Sei un tutor'
    })
    expect(out).toBe('# Ruolo\nSei un tutor\n\n# Contesto\nC\n\n# Obiettivi\nG\n\n# Vincoli\nRispondi in italiano')
  })

  it('rimuove spazi ai bordi ma conserva il testo multilinea', () => {
    expect(buildSystemPrompt(brief({ context: '\n  riga 1\nriga 2  \n' }))).toBe('# Contesto\nriga 1\nriga 2')
  })
})

describe('selectHistory', () => {
  const msg = (role: 'user' | 'assistant', len: number, tag = ''): HistoryMessage => ({
    role,
    content: tag + 'x'.repeat(len - tag.length)
  })

  it('tutto lo storico se ci sta', () => {
    const h = [msg('user', 10), msg('assistant', 10), msg('user', 10)]
    expect(selectHistory(h, '')).toEqual(h)
  })

  it('limita il numero di messaggi tenendo i più recenti', () => {
    const h = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 5, String(i)))
    const out = selectHistory(h, '', { maxMessages: 4, maxTokens: 1e6, reserveTokens: 0 })
    expect(out.map((m) => m.content[0])).toEqual(['6', '7', '8', '9'])
  })

  it('il brief si sottrae dal budget e non viene mai troncato', () => {
    const h = [msg('user', 400, 'a'), msg('assistant', 400, 'b'), msg('user', 400, 'c')]
    const system = 'y'.repeat(400)
    // budget: 350 - 104 (brief) = 246 token → entrano 'c' e 'b' (104 ciascuno), non 'a';
    // poi la risposta 'b' resterebbe in testa senza la sua domanda e viene scartata.
    const out = selectHistory(h, system, { maxMessages: 50, maxTokens: 350, reserveTokens: 0 })
    expect(out.map((m) => m.content[0])).toEqual(['c'])
    // con budget sufficiente entra tutto
    const out2 = selectHistory(h, system, { maxMessages: 50, maxTokens: 450, reserveTokens: 0 })
    expect(out2.map((m) => m.content[0])).toEqual(['a', 'b', 'c'])
    // senza brief lo stesso budget di 350 basta per tutti e tre
    const out3 = selectHistory(h, '', { maxMessages: 50, maxTokens: 350, reserveTokens: 0 })
    expect(out3.map((m) => m.content[0])).toEqual(['a', 'b', 'c'])
  })

  it('l\'ultimo messaggio entra sempre, anche se fuori budget', () => {
    const out = selectHistory([msg('user', 10_000)], 'brief', { maxMessages: 50, maxTokens: 100, reserveTokens: 50 })
    expect(out).toHaveLength(1)
  })

  it('stima token ~ caratteri/4', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(104)
  })
})
