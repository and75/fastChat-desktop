// Variabili d'ambiente del server Ollama. Ollama le legge solo all'avvio: per cambiarle bisogna salvarle e
// riavviarlo. Su Windows l'app lo fa da sola (variabili dell'utente + riavvio dell'app Ollama); altrove
// mostra i comandi da copiare: su Linux servirebbe sudo e su macOS il valore non sopravvive al riavvio.
import { t } from '@shared/i18n'

export type OllamaEnvName = 'OLLAMA_VULKAN' | 'OLLAMA_FLASH_ATTENTION' | 'OLLAMA_KV_CACHE_TYPE' | 'OLLAMA_MAX_LOADED_MODELS'

export interface OllamaEnvVar {
  name: OllamaEnvName
  /** Id dell'etichetta: il renderer la traduce (env.<label>, env.<label>.desc). */
  label: string
  description: string
  /** Valori ammessi; null nell'elenco = non impostata (predefinito di Ollama). L'etichetta è un id o il valore stesso. */
  options: Array<{ value: string | null; label: string }>
}

export const OLLAMA_ENV_VARS: OllamaEnvVar[] = [
  {
    name: 'OLLAMA_VULKAN',
    label: 'vulkan',
    description: '',
    options: [
      { value: null, label: 'unset' },
      { value: '1', label: 'on' },
      { value: '0', label: 'off' }
    ]
  },
  {
    name: 'OLLAMA_FLASH_ATTENTION',
    label: 'flash',
    description: '',
    options: [
      { value: null, label: 'unset' },
      { value: '1', label: 'on' },
      { value: '0', label: 'off' }
    ]
  },
  {
    name: 'OLLAMA_KV_CACHE_TYPE',
    label: 'kv',
    description: '',
    options: [
      { value: null, label: 'unset-f16' },
      { value: 'f16', label: 'f16' },
      { value: 'q8_0', label: 'q8_0' },
      { value: 'q4_0', label: 'q4_0' }
    ]
  },
  {
    name: 'OLLAMA_MAX_LOADED_MODELS',
    label: 'maxLoaded',
    description: '',
    options: [
      { value: null, label: 'unset-auto' },
      { value: '1', label: '1' },
      { value: '2', label: '2' },
      { value: '3', label: '3' }
    ]
  }
]

export type OllamaEnvValues = Partial<Record<OllamaEnvName, string | null>>

const NAMES = new Set(OLLAMA_ENV_VARS.map((v) => v.name))

/** Solo nomi e valori dell'elenco: niente può finire nei comandi se non è previsto. */
export function validateEnv(values: OllamaEnvValues): OllamaEnvValues {
  const out: OllamaEnvValues = {}
  for (const [name, value] of Object.entries(values)) {
    const def = OLLAMA_ENV_VARS.find((v) => v.name === name)
    if (!def || !NAMES.has(name as OllamaEnvName)) throw new Error(t('err.envUnknownVar', { name }))
    if (!def.options.some((o) => o.value === (value ?? null))) throw new Error(t('err.envBadValue', { name }))
    out[name as OllamaEnvName] = value ?? null
  }
  return out
}

/** Comandi da copiare per i sistemi dove l'app non applica da sola. */
export function envCommands(platform: string, values: OllamaEnvValues): string {
  const set = Object.entries(values).filter(([, v]) => v != null) as Array<[string, string]>
  const unset = Object.entries(values).filter(([, v]) => v == null).map(([k]) => k)
  if (platform === 'win32') {
    return [
      ...set.map(([k, v]) => `[Environment]::SetEnvironmentVariable('${k}', '${v}', 'User')`),
      ...unset.map((k) => `[Environment]::SetEnvironmentVariable('${k}', $null, 'User')`),
      '# poi chiudi Ollama dall\'icona di sistema e riaprilo'
    ].join('\n')
  }
  if (platform === 'darwin') {
    return [...set.map(([k, v]) => `launchctl setenv ${k} ${v}`), ...unset.map((k) => `launchctl unsetenv ${k}`), '# poi chiudi e riapri l\'app Ollama'].join('\n')
  }
  return [
    'sudo systemctl edit ollama.service',
    '# nel file che si apre:',
    '[Service]',
    ...set.map(([k, v]) => `Environment="${k}=${v}"`),
    '# salva, poi:',
    'sudo systemctl daemon-reload && sudo systemctl restart ollama'
  ].join('\n')
}

export interface EnvDeps {
  platform: string
  /** Esegue un programma e restituisce lo stdout (rifiuta se esce con errore). */
  run(file: string, args: string[]): Promise<string>
  /** Avvia un programma staccato dall'app, con l'ambiente indicato. */
  spawnDetached(file: string, args: string[], env: Record<string, string>): void
  exists(path: string): boolean
  /** Cartella dei programmi dell'utente (%LOCALAPPDATA%). */
  localAppData: string
  baseEnv: Record<string, string | undefined>
  /** Attende che Ollama risponda di nuovo; false se non risponde entro il tempo. */
  waitUntilUp(): Promise<boolean>
}

const ps = (deps: EnvDeps, script: string): Promise<string> =>
  deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])

/** Valori attuali delle variabili dell'utente (Windows). */
export async function readUserEnv(deps: EnvDeps): Promise<OllamaEnvValues> {
  if (deps.platform !== 'win32') return {}
  const pairs = [...NAMES].map((n) => `'${n}'=[Environment]::GetEnvironmentVariable('${n}','User')`).join(';')
  const out = await ps(deps, `@{${pairs}} | ConvertTo-Json -Compress`)
  const parsed = JSON.parse(out.trim() || '{}') as Record<string, string | null>
  const values: OllamaEnvValues = {}
  for (const n of NAMES) values[n] = parsed[n] ?? null
  return values
}

/** Percorso dell'app Ollama installata per l'utente (installazione predefinita). */
export const ollamaAppPath = (deps: EnvDeps): string => `${deps.localAppData}\\Programs\\Ollama\\ollama app.exe`

/**
 * Salva le variabili dell'utente e riavvia Ollama (Windows). Il nuovo processo riceve l'ambiente aggiornato
 * direttamente: quello dell'app non contiene ancora le variabili appena salvate.
 */
export async function applyEnvWindows(deps: EnvDeps, values: OllamaEnvValues): Promise<{ restarted: boolean }> {
  if (deps.platform !== 'win32') throw new Error(t('err.envWindowsOnly'))
  const clean = validateEnv(values)
  const app = ollamaAppPath(deps)
  if (!deps.exists(app)) throw new Error(`Ollama non trovato in ${app}: imposta le variabili e riavvia Ollama a mano`)
  for (const [name, value] of Object.entries(clean)) {
    await ps(deps, `[Environment]::SetEnvironmentVariable('${name}', ${value == null ? '$null' : `'${value}'`}, 'User')`)
  }
  // Chiude l'app (icona di sistema) e il server; se non erano attivi taskkill fallisce: va bene.
  await deps.run('taskkill.exe', ['/F', '/IM', 'ollama app.exe']).catch(() => '')
  await deps.run('taskkill.exe', ['/F', '/IM', 'ollama.exe']).catch(() => '')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(deps.baseEnv)) if (v != null) env[k] = v
  const current = await readUserEnv(deps).catch(() => ({}) as OllamaEnvValues)
  for (const [k, v] of Object.entries({ ...current, ...clean })) {
    if (v == null) delete env[k]
    else env[k] = v
  }
  deps.spawnDetached(app, [], env)
  return { restarted: await deps.waitUntilUp() }
}
