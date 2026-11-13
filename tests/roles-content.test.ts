// I testi dei ruoli inclusi nell'app (roles/*.json): rispettano le regole dei ruoli, e le varianti di lingua di
// uno stesso ruolo hanno la stessa struttura (stessi parametri, opzioni, predefiniti ed effetti sulla mente).
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roleInstructions, validateRole, type Role } from '../src/shared/roles'

const dir = resolve(__dirname, '../roles')
const load = (file: string): Role => JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Role
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
/** La struttura di un ruolo, senza i testi: ciò che deve coincidere tra le lingue. */
const shape = (role: Role): unknown => ({
  mind: role.mind,
  parameters: (role.parameters ?? []).map((p) => ({ id: p.id, section: p.section, kind: p.kind, type: p.type, default: p.default, options: p.options.map((o) => ({ id: o.id, mind: o.mind, hasInstruction: !!o.instruction })) })),
  bases: (role.bases ?? []).map((b) => b.purpose)
})

describe('testi dei ruoli inclusi nell\'app', () => {
  it('ogni ruolo è valido, ha un promemoria e basi con un nome leggibile', () => {
    expect(files).toEqual(['assistente.fr.json', 'assistente.it.json', 'prompt.fr.json', 'prompt.it.json'])
    for (const file of files) {
      const role = load(file)
      expect(validateRole(role), file).toEqual([])
      expect(role.reminder?.trim(), file).toBeTruthy()
      for (const base of role.bases ?? []) expect(base.name?.trim(), `${file}: ${base.id}`).toBeTruthy()
      // la lingua del file è quella delle sue basi
      const lang = file.split('.')[1]
      for (const base of role.bases ?? []) if (base.id !== 'app.fastchat.guida') expect(base.id.endsWith(`.${lang}`), `${file}: ${base.id}`).toBe(true)
    }
  })

  it('le varianti di lingua hanno la stessa struttura', () => {
    for (const name of ['assistente', 'prompt']) expect(shape(load(`${name}.fr.json`)), name).toEqual(shape(load(`${name}.it.json`)))
  })

  it('con le scelte predefinite le istruzioni restano poche righe (un modello piccolo le regge)', () => {
    for (const file of files) expect(roleInstructions(load(file)).split('\n').length, file).toBeLessThanOrEqual(9)
  })
})
