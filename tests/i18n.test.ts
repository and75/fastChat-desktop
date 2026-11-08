import { afterEach, describe, expect, it } from 'vitest'
import { fmtInt, getLocale, LOCALES, resolveLocale, setLocale, t, tn } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { it as itDict, type Key } from '../src/shared/i18n/it'
import { formatElapsed, formatMessageDate } from '../src/shared/format'
import { buildMemorySection } from '../src/shared/memory'
import { buildStyleSection, buildSummaryPrompt, buildSystemPrompt, withSummary } from '../src/shared/prompt'

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('dizionari', () => {
  afterEach(() => setLocale('it'))

  it('inglese: stesse chiavi, stessi segnaposto, nessun testo vuoto', () => {
    const keys = Object.keys(itDict) as Key[]
    expect(Object.keys(en).sort()).toEqual([...keys].sort())
    for (const k of keys) {
      expect(en[k], k).not.toBe('')
      expect(placeholders(en[k]), k).toEqual(placeholders(itDict[k]))
    }
  })

  it('plurali: ogni chiave _one ha la sua _other, e viceversa', () => {
    const keys = Object.keys(itDict)
    for (const k of keys) {
      if (k.endsWith('_one')) expect(keys, k).toContain(k.replace(/_one$/, '_other'))
      if (k.endsWith('_other')) expect(keys, k).toContain(k.replace(/_other$/, '_one'))
    }
  })

  it('t: segnaposto sostituiti; tn: singolare e plurale secondo la lingua', () => {
    expect(t('export.savedTo', { path: '/x.md' })).toBe('Salvata in /x.md')
    expect(tn('settings.connected', 1)).toBe('Connesso · 1 modello')
    expect(tn('settings.connected', 7)).toBe('Connesso · 7 modelli')
    setLocale('en')
    expect(tn('settings.connected', 1)).toBe('Connected · 1 model')
    expect(tn('message.usedExcerpts', 3)).toBe('Used 3 excerpts from the conversation')
    expect(fmtInt(4096)).toBe('4,096')
    setLocale('it')
    expect(fmtInt(4096)).toBe('4.096')
  })

  it('resolveLocale: scelta esplicita, altrimenti dal sistema (italiano o inglese)', () => {
    expect(resolveLocale('en', 'it-IT')).toBe('en')
    expect(resolveLocale('auto', 'it-CH')).toBe('it')
    expect(resolveLocale('auto', 'fr-FR')).toBe('en')
    expect(resolveLocale(null, undefined)).toBe('en')
    expect(LOCALES).toEqual(['it', 'en'])
  })

  it('i prompt al modello seguono la lingua: sezioni del brief, stile, riassunto, memoria', () => {
    const brief = { role: 'Tutor', context: '', goals: '', constraints: '' }
    expect(buildSystemPrompt(brief, 'concise')).toMatch(/^# Ruolo\nTutor\n\n# Stile della risposta\n/)
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(buildSystemPrompt(brief, 'concise')).toMatch(/^# Role\nTutor\n\n# Answer style\nGet straight to the point/)
    expect(buildStyleSection('normal')).toBe('')
    expect(withSummary('x', 'facts')).toBe('x\n\n# Summary of the conversation so far\nfacts')
    expect(buildSummaryPrompt(120)).toContain('At most 120 words')
    expect(buildMemorySection([{ text: 'User: hi', role: 'user', position: 2 }], 9)).toContain('[message 2 of 9 · user]')
  })

  it('formati: date e tempi nella lingua attiva', () => {
    const now = new Date(2026, 10, 8, 15, 0).getTime()
    expect(formatMessageDate(now - 60_000, now)).toMatch(/^Oggi, /)
    setLocale('en')
    expect(formatMessageDate(now - 60_000, now)).toMatch(/^Today, /)
    expect(formatElapsed(840)).toBe('0.8 s')
  })
})
