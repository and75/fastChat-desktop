// Credenziali delle sorgenti collegate: i campi `secret` non vanno in chiaro nel database. Si cifrano con
// safeStorage di Electron (portachiavi del sistema); nei test si passa un cifrario finto.
import type { KnowledgeSource, SourceConfig } from './source'

export interface Cipher {
  encrypt(text: string): string
  decrypt(text: string): string
}

const PREFIX = 'enc:'

/** Cifrario su safeStorage di Electron; se non è disponibile i segreti restano in chiaro (avvisando). */
export function electronCipher(safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }): Cipher {
  return {
    encrypt: (text) => (safeStorage.isEncryptionAvailable() ? PREFIX + safeStorage.encryptString(text).toString('base64') : text),
    decrypt: (text) => (text.startsWith(PREFIX) ? safeStorage.decryptString(Buffer.from(text.slice(PREFIX.length), 'base64')) : text)
  }
}

export const plainCipher: Cipher = { encrypt: (t) => t, decrypt: (t) => t }

const secretKeys = (source: KnowledgeSource): string[] => (source.configFields ?? []).filter((f) => f.type === 'secret').map((f) => f.key)

/** Configurazione da salvare: campi noti del plugin, ripuliti, con i segreti cifrati. */
export function sealConfig(source: KnowledgeSource, raw: Record<string, unknown>, cipher: Cipher): SourceConfig {
  const out: SourceConfig = {}
  const secrets = new Set(secretKeys(source))
  for (const f of source.configFields ?? []) {
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : ''
    if (f.required && !v) throw new Error(`Campo obbligatorio: ${f.key}`)
    if (v) out[f.key] = secrets.has(f.key) ? cipher.encrypt(v) : v
  }
  return out
}

/** Configurazione da passare al plugin: segreti in chiaro. */
export function openConfig(source: KnowledgeSource, stored: SourceConfig, cipher: Cipher): SourceConfig {
  const out: SourceConfig = { ...stored }
  for (const k of secretKeys(source)) if (out[k]) out[k] = cipher.decrypt(out[k])
  return out
}

/** Configurazione per il renderer: i segreti non si mostrano. */
export function maskConfig(source: KnowledgeSource, stored: SourceConfig): SourceConfig {
  const out: SourceConfig = { ...stored }
  for (const k of secretKeys(source)) if (out[k]) out[k] = '••••••'
  return out
}
