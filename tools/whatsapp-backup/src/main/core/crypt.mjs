// Decifratura dei backup di WhatsApp per Android (msgstore.db.crypt15).
//
// Formato crypt15 (backup crittografato end-to-end):
//   [varint: lunghezza header][header BackupPrefix (protobuf)][ciphertext][tag GCM 16B][MD5 16B]
// Chiave AES: HKDF-SHA256(rootKey, salt=32 zeri, info="backup encryption", 32B),
//   dove rootKey sono i 32 byte della chiave a 64 cifre esadecimali scelta dall'utente.
// Payload: AES-256-GCM (nonce = IV di 16 byte dall'header), poi decompressione zlib → SQLite.
//
// Riferimento di formato: ElDavoo/wa-crypt-tools (verificato sui .proto e sul codice).
import { createDecipheriv, createHmac } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

export class WrongKeyError extends Error {
  constructor(message = 'Chiave errata o file di backup non compatibile.') {
    super(message)
  }
}

/** Accetta la chiave a 64 cifre esadecimali (anche con spazi) o 32 byte grezzi. */
export function parseBackupKey(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length === 32) return input
    throw new Error('La chiave grezza deve essere di 32 byte.')
  }
  const hex = String(input).replace(/\s+/g, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('La chiave deve essere di 64 cifre esadecimali (i 64 caratteri mostrati da WhatsApp).')
  }
  return Buffer.from(hex, 'hex')
}

/** Deriva la chiave AES a 256 bit dalla rootKey. HKDF-SHA256 con salt di 32 zeri e info fissa. */
export function deriveAesKey(rootKey, info = 'backup encryption') {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(rootKey).digest() // HKDF-Extract
  // HKDF-Expand, un solo blocco (output 32B): T(1) = HMAC(prk, info || 0x01)
  return createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'latin1'), Buffer.from([1])]))
    .digest()
}

// --- lettura minimale di protobuf (solo ciò che serve per l'header) ---

function readVarint(buf, pos) {
  let shift = 0
  let value = 0n
  for (;;) {
    if (pos >= buf.length) throw new Error('header del backup troncato')
    const byte = buf[pos++]
    value |= BigInt(byte & 0x7f) << BigInt(shift)
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [value, pos]
}

/** Scorre i campi di un messaggio protobuf: { field, wire, value, pos } per ciascuno. */
function* fields(buf, start = 0, end = buf.length) {
  let pos = start
  while (pos < end) {
    let tag
    ;[tag, pos] = readVarint(buf, pos)
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      let v
      ;[v, pos] = readVarint(buf, pos)
      yield { field, wire, value: v }
    } else if (wire === 2) {
      let len
      ;[len, pos] = readVarint(buf, pos)
      const l = Number(len)
      yield { field, wire, value: buf.subarray(pos, pos + l) }
      pos += l
    } else if (wire === 5) {
      pos += 4
    } else if (wire === 1) {
      pos += 8
    } else {
      throw new Error(`tipo di campo protobuf ${wire} non gestito`)
    }
  }
}

/**
 * Legge l'header crypt15: ritorna l'IV e la posizione di inizio del ciphertext.
 * @returns {{ iv: Buffer, dataStart: number, keyType: number|null }}
 */
export function parseCrypt15Header(buf) {
  const [headerLen, afterVarint] = readVarint(buf, 0)
  const headerEnd = afterVarint + Number(headerLen)
  if (headerEnd > buf.length) throw new Error('header del backup più lungo del file')
  const prefix = buf.subarray(afterVarint, headerEnd)

  let iv = null
  let keyType = null
  for (const f of fields(prefix)) {
    if ((f.field === 1 || f.field === 6) && f.wire === 0) keyType = Number(f.value)
    if (f.field === 3 && f.wire === 2) {
      // e2ee_key_data (C15IV): campo 1 = encryption_iv
      for (const inner of fields(f.value)) {
        if (inner.field === 1 && inner.wire === 2) iv = Buffer.from(inner.value)
      }
    }
  }
  if (!iv || iv.length !== 16) throw new Error('IV non trovato nell’header crypt15 (file non E2E?).')
  return { iv, dataStart: headerEnd, keyType }
}

/** AES-256-GCM con verifica del tag. Prova i due possibili trailer (con/senza MD5). */
function gcmDecrypt(region, key, iv) {
  const attempts = region.length >= 32 ? [32, 16] : [16]
  let lastErr
  for (const trailer of attempts) {
    const tag = region.subarray(region.length - trailer, region.length - trailer + 16)
    const ciphertext = region.subarray(0, region.length - trailer)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch (err) {
      lastErr = err
    }
  }
  throw new WrongKeyError(
    'Verifica crittografica fallita: la chiave non corrisponde a questo backup, oppure il file è danneggiato.'
  )
}

function maybeInflate(plain) {
  if (plain.subarray(0, 16).equals(SQLITE_MAGIC)) return plain // già un DB (non compresso)
  try {
    return inflateSync(plain)
  } catch {
    return plain
  }
}

/**
 * Decifra un backup crypt15 in memoria e restituisce il contenuto SQLite.
 * @param {Buffer} fileBuf  contenuto del .crypt15
 * @param {Buffer|string} backupKey  chiave a 64 cifre o 32 byte
 * @returns {Buffer} database SQLite decifrato e decompresso
 */
export function decryptCrypt15(fileBuf, backupKey) {
  const rootKey = parseBackupKey(backupKey)
  const key = deriveAesKey(rootKey)
  const { iv, dataStart } = parseCrypt15Header(fileBuf)
  const plain = gcmDecrypt(fileBuf.subarray(dataStart), key, iv)
  const db = maybeInflate(plain)
  if (!db.subarray(0, 16).equals(SQLITE_MAGIC)) {
    throw new WrongKeyError('Decifrato ma il risultato non è un database SQLite valido.')
  }
  return db
}

/** Riconosce il tipo di file dal nome. */
export function cryptKind(name) {
  const m = /\.crypt(\d+)$/.exec(name)
  return m ? Number(m[1]) : null
}
