// Localizza i binari esterni (adb, libimobiledevice) sia in sviluppo sia nell'app impacchettata.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

function platformDir() {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

/** Cartelle dove cercare i binari inclusi: `resources/bin/<os>/` in packaged e in dev. */
function bundledDirs() {
  const dirs = []
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, 'bin', platformDir()))
  // in sviluppo: tools/whatsapp-backup/resources/bin/<os>/
  dirs.push(join(here, '..', '..', '..', 'resources', 'bin', platformDir()))
  return dirs
}

function existsFile(p) {
  try {
    accessSync(p, constants.X_OK | constants.F_OK)
    return true
  } catch {
    return false
  }
}

function onPath(name) {
  const file = exe(name)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsFile(join(dir, file))) return join(dir, file)
  }
  return null
}

/** Percorso di un binario: prima quello incluso nell'app, poi quello di sistema. Null se assente. */
export function findTool(name) {
  for (const dir of bundledDirs()) {
    const p = join(dir, exe(name))
    if (existsFile(p)) return p
  }
  return onPath(name)
}

export function adbPath() {
  const p = findTool('adb')
  if (!p) throw new ToolMissingError('adb', 'Android Platform Tools')
  return p
}

export function idevicePath(name) {
  const p = findTool(name)
  if (!p) throw new ToolMissingError(name, 'libimobiledevice')
  return p
}

export class ToolMissingError extends Error {
  constructor(tool, pkg) {
    super(`Strumento «${tool}» non trovato (${pkg}).`)
    this.tool = tool
    this.pkg = pkg
  }
}

/** Esegue un binario raccogliendo stdout/stderr. Nessuna shell: argomenti passati come array. */
export async function run(file, args, { timeout = 0, maxBuffer = 1 << 28, env } = {}) {
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      timeout,
      maxBuffer,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    if (err.code === 'ENOENT') throw err
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err), code: err.code ?? 1 }
  }
}
