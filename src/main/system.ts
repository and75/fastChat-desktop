// Informazioni sulla macchina, per dimensionare la memoria della conversazione.
import { totalmem } from 'node:os'
import type { SystemInfo } from '@shared/settings'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** true se l'URL di Ollama punta a questa macchina: solo allora la RAM locale è quella che conta. */
export function isLocalOllama(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * RAM e tipo di memoria. Con Ollama remoto la RAM non si conosce (null).
 * FASTCHAT_SYSTEM_RAM (byte) e FASTCHAT_SYSTEM_UNIFIED servono ai test end-to-end per avere valori stabili.
 */
export function systemInfo(ollamaUrl: string): SystemInfo {
  const forcedRam = Number(process.env.FASTCHAT_SYSTEM_RAM)
  const unified = process.env.FASTCHAT_SYSTEM_UNIFIED
    ? process.env.FASTCHAT_SYSTEM_UNIFIED === '1'
    : process.platform === 'darwin' && process.arch === 'arm64'
  if (!isLocalOllama(ollamaUrl)) return { ramBytes: null, unified }
  const ramBytes = Number.isFinite(forcedRam) && forcedRam > 0 ? forcedRam : totalmem()
  return { ramBytes: ramBytes > 0 ? ramBytes : null, unified }
}
