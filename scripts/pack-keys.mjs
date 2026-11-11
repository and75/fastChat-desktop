// Genera una coppia di chiavi Ed25519 per firmare i pacchetti (.fcpack).
// Uso: node scripts/pack-keys.mjs <id-della-chiave> [cartella]
// Scrive <id>.private.pem (da tenere segreta, mai nel repository) e stampa la chiave pubblica da incollare in
// src/main/knowledge/trust.ts sotto quell'id: i pacchetti firmati con la privata risulteranno «verificati».
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [id, dir = '.'] = process.argv.slice(2)
if (!id || !/^[a-z0-9][a-z0-9._-]{1,40}$/.test(id)) {
  console.error('Uso: node scripts/pack-keys.mjs <id-della-chiave> [cartella]')
  process.exit(1)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const out = join(resolve(dir), `${id}.private.pem`)
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(`Chiave privata scritta in ${out} (non metterla nel repository).\n`)
console.log(`Da aggiungere a TRUSTED_KEYS in src/main/knowledge/trust.ts:\n\n  '${id}': \`${publicKey.export({ type: 'spki', format: 'pem' }).trim()}\`\n`)
