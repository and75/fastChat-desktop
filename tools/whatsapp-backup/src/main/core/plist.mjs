// Lettura dei plist di Apple: binari (bplist00) e XML.

/** Riferimento a un oggetto in un archivio NSKeyedArchiver. */
export class UID {
  constructor(value) {
    this.value = value
  }
}

const APPLE_EPOCH = 978307200 // secondi tra 1970-01-01 e 2001-01-01

export function parsePlist(buf) {
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return parseBinary(buf)
  return parseXml(buf.toString('utf8'))
}

function parseBinary(buf) {
  if (buf.length < 40) throw new Error('plist binario troppo corto')
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const numObjects = Number(trailer.readBigUInt64BE(8))
  const topObject = Number(trailer.readBigUInt64BE(16))
  const tableOffset = Number(trailer.readBigUInt64BE(24))

  const uint = (pos, size) => {
    let n = 0n
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(buf[pos + i])
    return n
  }
  const offsetOf = (index) => {
    if (index >= numObjects) throw new Error('plist binario: riferimento non valido')
    return Number(uint(tableOffset + index * offsetSize, offsetSize))
  }

  const cache = new Map()
  const read = (index) => {
    if (cache.has(index)) return cache.get(index)
    const value = readAt(offsetOf(index))
    cache.set(index, value)
    return value
  }

  const readAt = (pos) => {
    const marker = buf[pos]
    const type = marker >> 4
    const info = marker & 0x0f
    // Lunghezza: nei 4 bit bassi, o in un intero che segue se valgono 0xF.
    const sized = () => {
      if (info !== 0x0f) return [info, pos + 1]
      const size = 1 << (buf[pos + 1] & 0x0f)
      return [Number(uint(pos + 2, size)), pos + 2 + size]
    }
    switch (type) {
      case 0x0:
        if (info === 0x8) return false
        if (info === 0x9) return true
        return null
      case 0x1: {
        const size = 1 << info
        const n = size === 8 ? buf.readBigInt64BE(pos + 1) : uint(pos + 1, size)
        return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n
      }
      case 0x2:
        return info === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1)
      case 0x3:
        return new Date((buf.readDoubleBE(pos + 1) + APPLE_EPOCH) * 1000)
      case 0x4: {
        const [len, start] = sized()
        return Buffer.from(buf.subarray(start, start + len))
      }
      case 0x5: {
        const [len, start] = sized()
        return buf.subarray(start, start + len).toString('latin1')
      }
      case 0x6: {
        const [len, start] = sized()
        const be = Buffer.from(buf.subarray(start, start + len * 2))
        return be.swap16().toString('utf16le')
      }
      case 0x8:
        return new UID(Number(uint(pos + 1, info + 1)))
      case 0xa:
      case 0xc: {
        const [len, start] = sized()
        const out = []
        for (let i = 0; i < len; i++) out.push(read(Number(uint(start + i * refSize, refSize))))
        return out
      }
      case 0xd: {
        const [len, start] = sized()
        const out = {}
        for (let i = 0; i < len; i++) {
          const key = read(Number(uint(start + i * refSize, refSize)))
          out[key] = read(Number(uint(start + (len + i) * refSize, refSize)))
        }
        return out
      }
      default:
        throw new Error(`plist binario: tipo ${type} non gestito`)
    }
  }

  return read(topObject)
}

function parseXml(text) {
  const tokens = text.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>|([^<]+)/g)
  const unescape = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&')

  const stack = [] // contenitori aperti: { kind, value, key }
  let root
  let text_ = ''
  const emit = (value) => {
    const top = stack.at(-1)
    if (!top) root = value
    else if (top.kind === 'array') top.value.push(value)
    else {
      top.value[top.key] = value
      top.key = undefined
    }
  }

  for (const m of tokens) {
    if (m[4] !== undefined) {
      text_ += m[4]
      continue
    }
    const closing = m[1] === '/'
    const selfClosing = m[3] === '/'
    const tag = m[2]
    if (tag === 'plist') continue
    if (!closing) {
      text_ = ''
      if (tag === 'dict' || tag === 'array') {
        const node = { kind: tag, value: tag === 'dict' ? {} : [] }
        if (selfClosing) emit(node.value)
        else stack.push(node)
      } else if (tag === 'true') emit(true)
      else if (tag === 'false') emit(false)
      else if (selfClosing && tag === 'string') emit('')
      else if (selfClosing && tag === 'data') emit(Buffer.alloc(0))
      continue
    }
    const body = text_
    text_ = ''
    switch (tag) {
      case 'dict':
      case 'array':
        emit(stack.pop().value)
        break
      case 'key':
        stack.at(-1).key = unescape(body)
        break
      case 'string':
        emit(unescape(body))
        break
      case 'integer':
        emit(Number(body.trim()))
        break
      case 'real':
        emit(Number(body.trim()))
        break
      case 'date':
        emit(new Date(body.trim()))
        break
      case 'data':
        emit(Buffer.from(body.replace(/\s+/g, ''), 'base64'))
        break
    }
  }
  if (root === undefined) throw new Error('plist XML non valido')
  return root
}
