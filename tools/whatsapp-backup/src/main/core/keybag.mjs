// Cifratura dei backup iPhone: keybag, chiavi di classe, decifratura dei file.
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, truncate } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

const WRAP_PASSCODE = 2
const CLASS_KEY_TAGS = new Set(['CLAS', 'WRAP', 'WPKY', 'KTYP', 'PBKY'])
const INT_TAGS = new Set(['VERS', 'TYPE', 'WRAP', 'ITER', 'DPWT', 'DPIC', 'CLAS', 'KTYP'])
const ZERO_IV = Buffer.alloc(16)

export class WrongPasswordError extends Error {
  constructor() {
    super('Password del backup errata.')
  }
}

/** AES key unwrap (RFC 3394). Restituisce null se il controllo di integrità fallisce. */
export function aesUnwrap(kek, wrapped) {
  if (wrapped.length % 8 !== 0 || wrapped.length < 24) return null
  const n = wrapped.length / 8 - 1
  const ecb = createDecipheriv(`aes-${kek.length * 8}-ecb`, kek, null).setAutoPadding(false)
  let a = wrapped.readBigUInt64BE(0)
  const r = []
  for (let i = 0; i < n; i++) r.push(Buffer.from(wrapped.subarray(8 * (i + 1), 8 * (i + 2))))
  const block = Buffer.alloc(16)
  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      block.writeBigUInt64BE(a ^ BigInt(n * j + i), 0)
      r[i - 1].copy(block, 8)
      const out = ecb.update(block)
      a = out.readBigUInt64BE(0)
      out.copy(r[i - 1], 0, 8, 16)
    }
  }
  if (a !== 0xa6a6a6a6a6a6a6a6n) return null
  return Buffer.concat(r)
}

/** Legge il keybag (sequenza tag di 4 lettere, lunghezza a 32 bit, valore). */
export function parseKeybag(data) {
  const attrs = {}
  const classKeys = new Map()
  let current = null
  let headerUuid = false
  let headerWrap = false
  const close = () => {
    if (current?.CLAS !== undefined) classKeys.set(current.CLAS, current)
  }
  for (let pos = 0; pos + 8 <= data.length; ) {
    const tag = data.subarray(pos, pos + 4).toString('latin1')
    const len = data.readUInt32BE(pos + 4)
    const raw = data.subarray(pos + 8, pos + 8 + len)
    pos += 8 + len
    const value = INT_TAGS.has(tag) && len === 4 ? raw.readUInt32BE(0) : Buffer.from(raw)
    if (tag === 'UUID' && !headerUuid) {
      headerUuid = true
      attrs.UUID = value
    } else if (tag === 'WRAP' && !headerWrap) {
      headerWrap = true
      attrs.WRAP = value
    } else if (tag === 'UUID') {
      close()
      current = { UUID: value }
    } else if (current && CLASS_KEY_TAGS.has(tag)) {
      current[tag] = value
    } else {
      attrs[tag] = value
    }
  }
  close()
  return { attrs, classKeys }
}

/**
 * Ricava dalla password le chiavi di classe del backup.
 * @returns {Map<number, Buffer>} classe di protezione → chiave
 */
export function unlockKeybag(keybagData, password) {
  const { attrs, classKeys } = parseKeybag(keybagData)
  if (!attrs.SALT || !attrs.ITER) throw new Error('Keybag del backup non riconosciuto.')
  let secret = Buffer.from(password, 'utf8')
  // Da iOS 10.2: un primo giro di PBKDF2-SHA256, poi quello storico in SHA1.
  if (attrs.DPSL && attrs.DPIC) secret = pbkdf2Sync(secret, attrs.DPSL, attrs.DPIC, 32, 'sha256')
  const passcodeKey = pbkdf2Sync(secret, attrs.SALT, attrs.ITER, 32, 'sha1')

  const keys = new Map()
  for (const [cls, entry] of classKeys) {
    if (!entry.WPKY || !(entry.WRAP & WRAP_PASSCODE)) continue
    const key = aesUnwrap(passcodeKey, entry.WPKY)
    if (!key) throw new WrongPasswordError()
    keys.set(cls, key)
  }
  if (keys.size === 0) throw new Error('Il keybag non contiene chiavi protette da password.')
  return keys
}

/** Chiave avvolta preceduta dalla classe (4 byte little-endian): ManifestKey ed EncryptionKey. */
export function unwrapClassedKey(classKeys, blob, protectionClass) {
  const cls = protectionClass ?? blob.readUInt32LE(0)
  const classKey = classKeys.get(cls)
  if (!classKey) throw new Error(`Classe di protezione ${cls} assente dal keybag.`)
  const key = aesUnwrap(classKey, blob.subarray(4))
  if (!key) throw new Error('Chiave del file non valida.')
  return key
}

/** Decifra un file del backup (AES-256-CBC, IV a zero) e lo riporta alla dimensione vera. */
export async function decryptFile(src, dest, key, size) {
  const decipher = createDecipheriv('aes-256-cbc', key, ZERO_IV).setAutoPadding(false)
  await pipeline(createReadStream(src), decipher, createWriteStream(dest))
  if (size !== undefined && size < (await stat(dest)).size) await truncate(dest, size)
}
