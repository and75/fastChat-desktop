import { strict as assert } from 'node:assert'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { decryptCrypt15, deriveAesKey, parseBackupKey, parseCrypt15Header, WrongKeyError } from '../src/main/core/crypt.mjs'

const varint = (n) => {
  const o = []
  while (n > 0x7f) {
    o.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  o.push(n)
  return Buffer.from(o)
}
const lenField = (f, b) => Buffer.concat([varint((f << 3) | 2), varint(b.length), b])
const varField = (f, v) => Buffer.concat([varint((f << 3) | 0), varint(v)])

/** Costruisce un finto .crypt15 come lo scrive WhatsApp. */
function makeCrypt15(db, hexKey, { withMd5 = true } = {}) {
  const aesKey = deriveAesKey(parseBackupKey(hexKey))
  const iv = randomBytes(16)
  const prefix = Buffer.concat([varField(6, 3), lenField(3, lenField(1, iv))])
  const header = Buffer.concat([varint(prefix.length), prefix])
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
  const ct = Buffer.concat([cipher.update(deflateSync(db)), cipher.final()])
  const tag = cipher.getAuthTag()
  const parts = [header, ct, tag]
  if (withMd5) parts.push(createHash('md5').update(ct).digest())
  return { file: Buffer.concat(parts), iv }
}

const sampleDb = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from('x'.repeat(200))])

test('parseBackupKey accetta 64 hex (anche con spazi) e rifiuta il resto', () => {
  const hex = randomBytes(32).toString('hex')
  assert.equal(parseBackupKey(hex).length, 32)
  const spaced = hex.replace(/(....)/g, '$1 ').trim()
  assert.ok(parseBackupKey(spaced).equals(parseBackupKey(hex)))
  assert.throws(() => parseBackupKey('troppo-corta'))
})

test('deriveAesKey è deterministica e lunga 32 byte', () => {
  const k = parseBackupKey(randomBytes(32).toString('hex'))
  const a = deriveAesKey(k)
  assert.equal(a.length, 32)
  assert.ok(a.equals(deriveAesKey(k)))
})

test('parseCrypt15Header estrae IV e keyType', () => {
  const hex = randomBytes(32).toString('hex')
  const { file, iv } = makeCrypt15(sampleDb, hex)
  const h = parseCrypt15Header(file)
  assert.ok(h.iv.equals(iv))
  assert.equal(h.keyType, 3)
})

test('round-trip: decifra un backup con la chiave giusta', () => {
  const hex = randomBytes(32).toString('hex')
  const { file } = makeCrypt15(sampleDb, hex)
  assert.ok(decryptCrypt15(file, hex).equals(sampleDb))
})

test('gestisce il trailer senza MD5 (backup multi-file)', () => {
  const hex = randomBytes(32).toString('hex')
  const { file } = makeCrypt15(sampleDb, hex, { withMd5: false })
  assert.ok(decryptCrypt15(file, hex).equals(sampleDb))
})

test('chiave sbagliata → WrongKeyError, nessun output', () => {
  const hex = randomBytes(32).toString('hex')
  const { file } = makeCrypt15(sampleDb, hex)
  assert.throws(() => decryptCrypt15(file, randomBytes(32).toString('hex')), WrongKeyError)
})
