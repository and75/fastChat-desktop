import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileLogger, errorDetail, formatLine } from '../src/main/log'
import { createOllamaClient, OllamaError } from '../src/main/ollama'
import type { Logger } from '../src/main/log'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fastchat-log-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('registro diagnostico', () => {
  it('una riga per evento: data, livello, ambito, messaggio, dati (senza i valori assenti)', () => {
    const line = formatLine(new Date('2026-11-23T10:00:00.000Z'), 'warn', 'chat', 'ricerca non riuscita', { model: 'gemma4:e4b', ms: 1200, loadMs: null, note: undefined })
    expect(line).toBe('2026-11-23T10:00:00.000Z WARN  chat    ricerca non riuscita model="gemma4:e4b" ms=1200\n')
  })

  it('scrive sul file, creando la cartella; oltre la dimensione massima il file diventa .1 e si riparte', () => {
    const path = join(dir, 'logs', 'fastchat.log')
    const log = createFileLogger(path, 200)
    expect(log.path).toBe(path)
    log.info('app', 'avvio', { version: '1.0.0' })
    expect(readFileSync(path, 'utf8')).toMatch(/INFO  app     avvio version="1.0.0"\n$/)
    for (let i = 0; i < 6; i++) log.error('ollama', 'senza risposta', { n: i })
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(path, 'utf8').length).toBeLessThan(400)
    expect(readFileSync(path, 'utf8')).toContain('n=5')
  })

  it('una cartella non scrivibile non fa fallire chi registra', () => {
    const log = createFileLogger(join(dir, 'x\0y', 'fastchat.log'))
    expect(() => log.info('app', 'avvio')).not.toThrow()
  })

  it("l'errore porta con sé la causa: è lì che fetch mette il motivo vero", () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
    expect(errorDetail(new TypeError('fetch failed', { cause }))).toBe('fetch failed (ECONNREFUSED connect ECONNREFUSED 127.0.0.1:11434)')
    expect(errorDetail(new Error('semplice'))).toBe('semplice')
    expect(errorDetail('testo')).toBe('testo')
  })
})

describe('client Ollama: ogni esito va nel registro', () => {
  const memoryLog = (): { log: Logger; lines: Array<{ level: string; message: string; data?: Record<string, unknown> }> } => {
    const lines: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const at = (level: string) => (_scope: string, message: string, data?: Record<string, unknown>) => void lines.push({ level, message, data })
    return { lines, log: { info: at('info'), warn: at('warn'), error: at('error'), path: null } }
  }

  it("Ollama spento: all'utente «non raggiungibile», nel registro il motivo tecnico", async () => {
    const { log, lines } = memoryLog()
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    const client = createOllamaClient(() => 'http://127.0.0.1:1', async () => Promise.reject(new TypeError('fetch failed', { cause })), log)
    await expect(client.listModels()).rejects.toBeInstanceOf(OllamaError)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', message: 'GET /api/tags senza risposta' })
    expect(lines[0].data?.error).toContain('ECONNREFUSED')
  })

  it("errore HTTP: stato e testo di Ollama nel registro, con il modello; lo stato dei modelli (ripetuto) solo se fallisce", async () => {
    const { log, lines } = memoryLog()
    const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const failing = createOllamaClient(() => 'http://x', reply(500, { error: 'llama-server reported out-of-memory during startup' }), log)
    await expect(failing.chatStream({ model: 'grande', messages: [] }, {})).rejects.toThrow('Ollama 500')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', message: 'POST /api/chat errore', data: { model: 'grande', status: 500 } })
    expect(lines[0].data?.error).toContain('out-of-memory')

    lines.length = 0
    const ok = createOllamaClient(() => 'http://x', reply(200, { models: [] }), log)
    await ok.loadedModels()
    expect(lines).toHaveLength(0)
    await ok.listModels()
    expect(lines).toEqual([expect.objectContaining({ level: 'info', message: 'GET /api/tags ok' })])
  })
})
