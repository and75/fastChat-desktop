// Le varianti dei testi di un ruolo: quella di partenza si legge dai sorgenti del repository (roles/ e
// store/sources/), le successive stanno in una cartella ciascuna, così ogni giro resta rileggibile.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseRole, type Role } from '../src/shared/roles'
import { BenchError } from './harness'
import type { Variant } from './types'

const repo = resolve(import.meta.dirname, '..')

/** I documenti della Guida di FastChat, per lingua: la base di documenti dell'Assistente. */
const GUIDE: Record<string, string[]> = {
  'app.fastchat.guida': ['README.md', 'docs/base-di-conoscenza.md', 'store/sources/manuale.it.md'],
  'app.fastchat.guida.fr': ['docs/fr/README.md', 'docs/fr/base-de-connaissances.md', 'store/sources/manuale.fr.md'],
  'app.fastchat.guida.en': ['docs/en/README.md', 'docs/en/knowledge-base.md', 'store/sources/manuale.en.md']
}

/** Da quali file del repository nasce una base (la stessa corrispondenza di scripts/build-packs.mjs). */
function sourcesOf(baseId: string): { paths: string[]; editable: boolean } {
  if (GUIDE[baseId]) return { paths: GUIDE[baseId], editable: false }
  const m = /^app\.fastchat\.kb\.([a-z-]+)\.([a-z]{2})$/.exec(baseId)
  if (!m) throw new BenchError(`Non so da quali file nasce la base ${baseId}`)
  const source = m[1] === 'assistente' ? 'assistente-comportamento' : m[1]
  return { paths: [`store/sources/${source}.${m[2]}.md`], editable: true }
}

/** Il percorso, nel repository, di ogni file modificabile di un ruolo: serve per applicare una variante. */
export function repoFiles(roleKey: string, role: Role): { role: string; bases: Record<string, string> } {
  const bases: Record<string, string> = {}
  for (const base of role.bases ?? []) {
    const { paths, editable } = sourcesOf(base.id)
    if (editable) bases[base.id] = paths[0]
  }
  return { role: `roles/${roleKey}.json`, bases }
}

/** La variante di partenza di un ruolo (es. «prompt.it»): i testi che oggi stanno nel repository. */
export function loadBaseline(roleKey: string): Variant {
  const path = join(repo, 'roles', `${roleKey}.json`)
  if (!existsSync(path)) {
    const known = readdirSync(join(repo, 'roles')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    throw new BenchError(`Ruolo sconosciuto: ${roleKey}. Disponibili: ${known.join(', ')}`)
  }
  const role = parseRole(JSON.parse(readFileSync(path, 'utf8')))
  const bases: Variant['bases'] = {}
  for (const base of role.bases ?? []) {
    const { paths, editable } = sourcesOf(base.id)
    bases[base.id] = { editable, files: paths.map((p) => ({ name: p.replaceAll('/', '_'), text: readFileSync(join(repo, p), 'utf8') })) }
  }
  return { name: 'base', language: roleKey.split('.').at(-1) ?? 'it', role, bases }
}

/** Scrive una variante in una cartella: role.json e i documenti delle basi. */
export function saveVariant(dir: string, variant: Variant): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'role.json'), JSON.stringify(variant.role, null, 2) + '\n')
  const index: Record<string, { editable: boolean; files: string[] }> = {}
  for (const [id, base] of Object.entries(variant.bases)) {
    mkdirSync(join(dir, 'bases', id), { recursive: true })
    for (const file of base.files) writeFileSync(join(dir, 'bases', id, file.name), file.text)
    index[id] = { editable: base.editable, files: base.files.map((f) => f.name) }
  }
  writeFileSync(join(dir, 'variant.json'), JSON.stringify({ name: variant.name, language: variant.language, bases: index }, null, 2) + '\n')
}

/** Rilegge una variante scritta con saveVariant. */
export function loadVariant(dir: string): Variant {
  if (!existsSync(join(dir, 'variant.json'))) throw new BenchError(`Non è una variante: ${dir}`)
  const meta = JSON.parse(readFileSync(join(dir, 'variant.json'), 'utf8')) as { name: string; language: string; bases: Record<string, { editable: boolean; files: string[] }> }
  const bases: Variant['bases'] = {}
  for (const [id, base] of Object.entries(meta.bases)) bases[id] = { editable: base.editable, files: base.files.map((name) => ({ name, text: readFileSync(join(dir, 'bases', id, name), 'utf8') })) }
  return { name: meta.name, language: meta.language, role: parseRole(JSON.parse(readFileSync(join(dir, 'role.json'), 'utf8'))), bases }
}
