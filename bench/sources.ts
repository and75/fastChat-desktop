// Le fonti del correttore: le stesse guide e raccolte da cui sono nati le tecniche e gli esempi del ruolo
// (store/sources/FONTI.md). Si scaricano una volta in una cartella ignorata da git e si allegano a ogni richiesta
// di correzione. Non stanno nel repository: le guide dei fornitori sono testi protetti, da consultare soltanto.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')

export interface SourceEntry {
  id: string
  title: string
  kind: 'guida' | 'prompt' | 'raccolta'
  license: string
  url: string
}

export interface Source extends SourceEntry {
  text: string
}

/** Quanto testo di una fonte si allega al massimo, e quanti prompt si prendono da una raccolta. */
const MAX_CHARS = 90_000
const COLLECTION_ROWS = 150
const COLLECTION_PROMPT_CHARS = 700

export const sourceList = (): SourceEntry[] => JSON.parse(readFileSync(join(repo, 'bench', 'sources.json'), 'utf8')) as SourceEntry[]
export const sourcesDir = (): string => join(repo, 'bench', 'sources-cache')

/** HTML → testo leggibile: via script, stili e menu; titoli e paragrafi su righe proprie. */
export function htmlToText(html: string): string {
  const main = /<article[\s\S]*<\/article>/i.exec(html)?.[0] ?? /<main[\s\S]*<\/main>/i.exec(html)?.[0] ?? html
  return main
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-3])[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/?(p|div|li|tr|pre|br|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Una riga di CSV con campi tra virgolette (virgole e virgolette doppie dentro i campi). */
function csvRows(csv: string, limit: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < csv.length && rows.length <= limit; i++) {
    const c = csv[i]
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  return rows
}

/** Il testo che si conserva di una fonte: Markdown così com'è, HTML ripulito, raccolte ridotte ai primi prompt. */
export function sourceText(entry: SourceEntry, raw: string): string {
  if (entry.kind === 'raccolta') {
    const [header, ...rows] = csvRows(raw, COLLECTION_ROWS)
    const act = header?.indexOf('act') ?? 0
    const prompt = header?.indexOf('prompt') ?? 1
    return rows
      .filter((r) => r[prompt]?.trim())
      .map((r) => `## ${r[act]?.trim()}\n${r[prompt].trim().slice(0, COLLECTION_PROMPT_CHARS)}`)
      .join('\n\n')
  }
  const text = /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw.trim()
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[…fonte troncata a ${MAX_CHARS} caratteri]` : text
}

/** Scarica le fonti nella cartella locale. Restituisce, per ognuna, se è andata bene. */
export async function fetchSources(log: (line: string) => void = () => undefined, fetchImpl: typeof fetch = fetch): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const dir = sourcesDir()
  mkdirSync(dir, { recursive: true })
  const out: Array<{ id: string; ok: boolean; detail: string }> = []
  for (const entry of sourceList()) {
    try {
      const res = await fetchImpl(entry.url, { headers: { 'user-agent': 'Mozilla/5.0 (fastchat-bench)' }, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = sourceText(entry, await res.text())
      if (text.length < 200) throw new Error('contenuto vuoto')
      writeFileSync(join(dir, `${entry.id}.md`), text + '\n')
      out.push({ id: entry.id, ok: true, detail: `${text.length} caratteri` })
    } catch (err) {
      out.push({ id: entry.id, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
    log(`  ${out.at(-1)!.ok ? 'scaricata' : 'NON scaricata'} · ${entry.title} · ${out.at(-1)!.detail}`)
  }
  return out
}

/** Le fonti già scaricate (quelle mancanti si saltano). */
export function loadSources(): Source[] {
  const dir = sourcesDir()
  return sourceList().flatMap((entry) => {
    const path = join(dir, `${entry.id}.md`)
    return existsSync(path) ? [{ ...entry, text: readFileSync(path, 'utf8').trim() }] : []
  })
}

/** Le fonti come blocco di testo da allegare a una richiesta: un documento per fonte, con titolo, licenza e indirizzo. */
export function sourcesBlock(sources: Source[]): string {
  if (sources.length === 0) return ''
  const docs = sources.map((s) => `<fonte id="${s.id}" tipo="${s.kind}" titolo="${s.title}" licenza="${s.license}" indirizzo="${s.url}">\n${s.text}\n</fonte>`).join('\n\n')
  return `<fonti>\n${docs}\n</fonti>`
}
