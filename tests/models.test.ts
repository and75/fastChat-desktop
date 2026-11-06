import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { benchmarkConfigs, pickBest, runBenchmark } from '../src/main/benchmark'
import { createChatService } from '../src/main/chat'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { addMessage, createConversation, getModelSetting, listModelSettings, removeModelSetting, saveModelSetting } from '../src/main/db/repo'
import { createOllamaClient } from '../src/main/ollama'
import { applyEnvWindows, envCommands, readUserEnv, validateEnv, type EnvDeps } from '../src/main/ollamaEnv'
import { createSummarizer } from '../src/main/summary'
import { startFakeOllama, type FakeOllama } from './helpers/fakeOllama'

let fake: FakeOllama
let h: DbHandle
beforeAll(async () => {
  fake = await startFakeOllama([
    // GPU dedicata: molto più veloce in GPU
    { name: 'veloce-gpu', capabilities: ['completion'], gpu: true, cpuTps: 8, gpuTps: 40, modelInfo: { 'fake.block_count': 32 } },
    // GPU integrata: la CPU è più veloce
    { name: 'igpu', capabilities: ['completion'], gpu: true, cpuTps: 12, gpuTps: 9, modelInfo: { 'fake.block_count': 32 } },
    // nessuna GPU per Ollama (Vulkan spento)
    { name: 'senza-gpu', capabilities: ['completion'], gpu: false, cpuTps: 10, modelInfo: { 'fake.block_count': 32 } }
  ])
})
afterAll(() => fake.close())
beforeEach(async () => {
  h = openDatabase(':memory:')
  await runMigrations(h, resolve(__dirname, '../drizzle'))
})
afterEach(() => h.close())

describe('test CPU/GPU', () => {
  it('configurazioni: solo CPU, tutto su GPU, metà dei layer se noti', () => {
    expect(benchmarkConfigs(null).map((c) => c.numGpu)).toEqual([0, 999])
    expect(benchmarkConfigs({ layers: 32 } as never).map((c) => c.numGpu)).toEqual([0, 999, 16])
  })

  it('pickBest: la più veloce nella scrittura; a parità (entro 5%) la CPU; senza GPU sempre la CPU', () => {
    const run = (numGpu: number, evalTps: number) => ({ label: '', numGpu, evalTps, promptTps: null, loadMs: null, vramShare: null })
    expect(pickBest([run(0, 8), run(999, 40)], true)).toBe(999)
    expect(pickBest([run(0, 10), run(999, 10.4)], true)).toBe(0)
    expect(pickBest([run(0, 8), run(999, 40)], false)).toBe(0)
  })

  it('GPU dedicata: vince la GPU', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const steps: string[] = []
    const r = await runBenchmark(ollama, 'veloce-gpu', await ollama.showModel('veloce-gpu'), (s, n, label) => steps.push(`${s}/${n} ${label}`))
    expect(steps).toEqual(['1/3 Solo CPU', '2/3 Tutto su GPU', '3/3 Metà su GPU (16 layer)'])
    expect(r.gpuAvailable).toBe(true)
    expect(r.best).toBe(999)
    expect(r.runs.map((x) => x.vramShare)).toEqual([0, 1, 0.5])
    expect(r.runs[0].evalTps).toBe(8)
    // ogni prova invia num_gpu, temperatura 0 e seed fisso
    const sent = fake.requests.filter((q) => q.path === '/api/chat').slice(-3).map((q) => (q.body as { options: Record<string, number> }).options)
    expect(sent.map((o) => o.num_gpu)).toEqual([0, 999, 16])
    expect(sent.every((o) => o.temperature === 0 && o.seed === 42)).toBe(true)
  })

  it('GPU integrata: vince la CPU', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const r = await runBenchmark(ollama, 'igpu', await ollama.showModel('igpu'), () => undefined)
    expect(r.best).toBe(0)
    expect(r.gpuAvailable).toBe(true)
  })

  it('nessuna GPU (Vulkan spento): niente prova a metà, resta la CPU', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const r = await runBenchmark(ollama, 'senza-gpu', await ollama.showModel('senza-gpu'), () => undefined)
    expect(r.gpuAvailable).toBe(false)
    expect(r.runs).toHaveLength(2)
    expect(r.best).toBe(0)
  })
})

describe('configurazione per modello nel database', () => {
  it('salva, aggiorna solo i campi indicati, limita num_gpu, elimina', async () => {
    await saveModelSetting(h.db, 'a', { numGpu: 0, digest: 'd1' })
    expect(await getModelSetting(h.db, 'a')).toMatchObject({ numGpu: 0, digest: 'd1', dismissed: false, benchmark: null })
    await saveModelSetting(h.db, 'a', { dismissed: true })
    expect(await getModelSetting(h.db, 'a')).toMatchObject({ numGpu: 0, digest: 'd1', dismissed: true })
    expect((await saveModelSetting(h.db, 'a', { numGpu: 5000 })).numGpu).toBe(999)
    expect((await saveModelSetting(h.db, 'a', { numGpu: null })).numGpu).toBeNull()
    expect(await listModelSettings(h.db)).toHaveLength(1)
    await removeModelSetting(h.db, 'a')
    expect(await getModelSetting(h.db, 'a')).toBeNull()
  })

  it('num_gpu del modello va in tutte le richieste: chat, titolo, riassunto', async () => {
    const ollama = createOllamaClient(() => fake.url)
    await saveModelSetting(h.db, 'igpu', { numGpu: 0 })
    const chat = createChatService({ db: h.db, ollama, summarizer: createSummarizer({ db: h.db, ollama }), emit: () => undefined })
    const conv = await createConversation(h.db, { model: 'igpu', numCtx: 1024 })
    for (let i = 0; i < 8; i++) await addMessage(h.db, { conversationId: conv.id, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) })
    const before = fake.requests.length
    await chat.wait((await chat.send({}, conv.id, 'ciao')).streamId)
    const sent = fake.requests.slice(before).filter((q) => q.path === '/api/chat').map((q) => (q.body as { options: Record<string, number> }).options)
    expect(sent.length).toBeGreaterThan(1) // riassunto + risposta
    expect(sent.every((o) => o.num_gpu === 0)).toBe(true)
  })

  it('senza configurazione num_gpu non viene inviato (decide Ollama)', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const chat = createChatService({ db: h.db, ollama, emit: () => undefined })
    const conv = await createConversation(h.db, { model: 'senza-gpu' })
    await chat.wait((await chat.send({}, conv.id, 'ciao')).streamId)
    const last = fake.requests.filter((q) => q.path === '/api/chat').at(-1)!.body as { options: Record<string, number> }
    expect('num_gpu' in last.options).toBe(false)
  })
})

describe('download, elimina, modelli caricati', () => {
  it('pull riporta l\'avanzamento e aggiunge il modello; delete lo toglie; ps la quota in GPU', async () => {
    const ollama = createOllamaClient(() => fake.url)
    const progress: string[] = []
    await ollama.pullModel('nuovo:1b', (p) => progress.push(`${p.status}${p.total ? ` ${p.completed}/${p.total}` : ''}`))
    expect(progress).toEqual(['pulling manifest', 'downloading 50/100', 'downloading 100/100', 'success'])
    expect((await ollama.listModels()).some((m) => m.name === 'nuovo:1b')).toBe(true)
    expect((await ollama.listModels()).find((m) => m.name === 'nuovo:1b')?.digest).toBe('digest-nuovo:1b')
    await ollama.deleteModel('nuovo:1b')
    expect((await ollama.listModels()).some((m) => m.name === 'nuovo:1b')).toBe(false)
    await expect(ollama.deleteModel('nuovo:1b')).rejects.toThrow(/not found/)
  })
})

describe('variabili d\'ambiente di Ollama', () => {
  it('validateEnv: solo nomi e valori previsti', () => {
    expect(validateEnv({ OLLAMA_VULKAN: '1', OLLAMA_KV_CACHE_TYPE: null })).toEqual({ OLLAMA_VULKAN: '1', OLLAMA_KV_CACHE_TYPE: null })
    expect(() => validateEnv({ PATH: 'x' } as never)).toThrow(/non gestita/)
    expect(() => validateEnv({ OLLAMA_VULKAN: "1'; rm -rf" })).toThrow(/non valido/)
  })

  it('comandi da copiare per Linux e macOS', () => {
    expect(envCommands('linux', { OLLAMA_VULKAN: '1' })).toContain('Environment="OLLAMA_VULKAN=1"')
    expect(envCommands('linux', { OLLAMA_VULKAN: '1' })).toContain('sudo systemctl restart ollama')
    expect(envCommands('darwin', { OLLAMA_VULKAN: '1', OLLAMA_KV_CACHE_TYPE: null })).toBe('launchctl setenv OLLAMA_VULKAN 1\nlaunchctl unsetenv OLLAMA_KV_CACHE_TYPE\n# poi chiudi e riapri l\'app Ollama')
  })

  /** Windows simulato: registra i comandi, tiene le variabili dell'utente in memoria. */
  function fakeWindows(over: Partial<EnvDeps> = {}) {
    const userEnv: Record<string, string | null> = { OLLAMA_FLASH_ATTENTION: '1' }
    const calls: string[] = []
    const spawned: Array<{ file: string; env: Record<string, string> }> = []
    const deps: EnvDeps = {
      platform: 'win32',
      run: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        const script = args.at(-1) ?? ''
        const set = script.match(/SetEnvironmentVariable\('(\w+)', (?:'([^']*)'|\$null), 'User'\)/)
        if (set) userEnv[set[1]] = set[2] ?? null
        if (script.includes('ConvertTo-Json')) return JSON.stringify(userEnv)
        if (file === 'taskkill.exe') throw new Error('non in esecuzione')
        return ''
      },
      spawnDetached: (file, _args, env) => spawned.push({ file, env }),
      exists: () => true,
      localAppData: 'C:\\Users\\a\\AppData\\Local',
      baseEnv: { PATH: 'C:\\Windows', OLLAMA_VULKAN: '0' },
      waitUntilUp: async () => true,
      ...over
    }
    return { deps, calls, spawned, userEnv }
  }

  it('Windows: legge le variabili dell\'utente', async () => {
    const { deps } = fakeWindows()
    expect(await readUserEnv(deps)).toMatchObject({ OLLAMA_FLASH_ATTENTION: '1', OLLAMA_VULKAN: null })
  })

  it('Windows: salva, chiude Ollama, lo riavvia con l\'ambiente aggiornato', async () => {
    const { deps, calls, spawned, userEnv } = fakeWindows()
    const r = await applyEnvWindows(deps, { OLLAMA_VULKAN: '1', OLLAMA_FLASH_ATTENTION: null })
    expect(r.restarted).toBe(true)
    expect(userEnv).toMatchObject({ OLLAMA_VULKAN: '1', OLLAMA_FLASH_ATTENTION: null })
    expect(calls.filter((c) => c.startsWith('taskkill.exe'))).toEqual(['taskkill.exe /F /IM ollama app.exe', 'taskkill.exe /F /IM ollama.exe'])
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('C:\\Users\\a\\AppData\\Local\\Programs\\Ollama\\ollama app.exe')
    // il nuovo processo riceve i valori nuovi (non quelli vecchi dell'app) e niente variabile rimossa
    expect(spawned[0].env.OLLAMA_VULKAN).toBe('1')
    expect('OLLAMA_FLASH_ATTENTION' in spawned[0].env).toBe(false)
    expect(spawned[0].env.PATH).toBe('C:\\Windows')
  })

  it('Windows: Ollama non installato nel percorso predefinito → errore chiaro, niente toccato', async () => {
    const { deps, calls } = fakeWindows({ exists: () => false })
    await expect(applyEnvWindows(deps, { OLLAMA_VULKAN: '1' })).rejects.toThrow(/Ollama non trovato/)
    expect(calls).toHaveLength(0)
  })

  it('fuori da Windows non applica', async () => {
    const { deps } = fakeWindows({ platform: 'linux' })
    await expect(applyEnvWindows(deps, { OLLAMA_VULKAN: '1' })).rejects.toThrow(/solo su Windows/)
  })
})
