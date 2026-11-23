// Registro diagnostico su file: ogni chiamata a Ollama e i tempi di ogni risposta, per capire cosa è successo
// quando l'app sembra ferma. Non contiene mai il testo dei messaggi né dei documenti: solo nomi, numeri ed errori.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(scope: string, message: string, data?: Record<string, unknown>): void
  warn(scope: string, message: string, data?: Record<string, unknown>): void
  error(scope: string, message: string, data?: Record<string, unknown>): void
  /** File del registro; null se non scrive su file. */
  readonly path: string | null
}

/** Registro che non scrive nulla (test, o cartella non scrivibile). */
export const nullLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, path: null }

/** Messaggio di un errore con la sua causa: fetch nasconde lì il motivo vero (ECONNREFUSED, timeout…). */
export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const code = (cause as { code?: unknown } | undefined)?.code
  const why = cause instanceof Error ? `${typeof code === 'string' ? `${code} ` : ''}${cause.message}` : cause != null ? String(cause) : ''
  return why && why !== err.message ? `${err.message} (${why})` : err.message
}

/** Una riga del registro: data, livello, ambito, messaggio e i dati come coppie chiave=valore. */
export function formatLine(at: Date, level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): string {
  const pairs = Object.entries(data ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
  return [at.toISOString(), level.toUpperCase().padEnd(5), scope.padEnd(7), message, ...pairs].join(' ') + '\n'
}

/**
 * Registro su file. Oltre `maxBytes` il file diventa `<nome>.1` (uno solo: il precedente si perde) e si riparte.
 * Scrivere non fa mai fallire chi registra.
 */
export function createFileLogger(path: string, maxBytes = 1024 * 1024): Logger {
  let ready = false
  const write = (level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true })
        ready = true
      }
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`)
      } catch {
        /* il file non c'è ancora */
      }
      appendFileSync(path, formatLine(new Date(), level, scope, message, data))
    } catch {
      /* il registro non blocca l'app */
    }
  }
  return {
    info: (scope, message, data) => write('info', scope, message, data),
    warn: (scope, message, data) => write('warn', scope, message, data),
    error: (scope, message, data) => write('error', scope, message, data),
    path
  }
}
