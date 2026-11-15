// FastChat senza interfaccia: lo stesso codice del processo principale (database, basi di conoscenza, ruoli,
// chat) montato come lo monta src/main/ipc.ts, ma senza Electron. Ciò che il banco di prova invia a Ollama è
// quindi esattamente ciò che invierebbe l'app.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createChatService } from '../src/main/chat'
import { createContextLog } from '../src/main/contextLog'
import { openDatabase, runMigrations, type DbHandle } from '../src/main/db/client'
import { ensureRoles, getContextRequest, getSettings, listContextCalls, listDocuments, listMessages, saveRole, updateConversation } from '../src/main/db/repo'
import { createEmbedder } from '../src/main/embedder'
import { createKnowledge } from '../src/main/knowledge'
import { createBuiltinRegistry } from '../src/main/knowledge/sources'
import { createOllamaClient } from '../src/main/ollama'
import { createRoleSession } from '../src/main/roleSession'
import { resolveChoices, validateRole } from '../src/shared/roles'
import type { RoleChoices } from '../src/shared/roles'
import type { Conversation, ConversationPatch, StreamEvent } from '../src/shared/types'
import type { RunOptions, Turn, Variant } from './types'

const repo = resolve(import.meta.dirname, '..')

/** Id con cui la variante vive nel database del banco: uno solo, la variante si carica in un database suo. */
const ROLE_ID = 'bench.role'

export class BenchError extends Error {}

/**
 * Monta l'app su un database in memoria e ci carica una variante: il ruolo e le sue basi, indicizzate con il
 * modello di embedding delle Impostazioni (predefinito `embeddinggemma`), come farebbe l'installazione.
 */
export async function createBench(variant: Variant, options: Pick<RunOptions, 'ollamaUrl'>) {
  const issues = validateRole(variant.role)
  if (issues.length) throw new BenchError(`Il ruolo della variante «${variant.name}» non è valido: ${issues.map((i) => i.code).join(', ')}`)

  const h: DbHandle = openDatabase(':memory:')
  await runMigrations(h, join(repo, 'drizzle'))
  await ensureRoles(h.db)
  const work = mkdtempSync(join(tmpdir(), 'fastchat-bench-'))

  const ollama = createOllamaClient(() => options.ollamaUrl)
  const contextLog = createContextLog(h.db)
  const embedder = createEmbedder({ db: h.db, ollama, contextLog })
  const knowledge = createKnowledge({ db: h.db, embedder, registry: createBuiltinRegistry() })
  const events = new Map<string, StreamEvent[]>()
  const chat = createChatService({
    db: h.db,
    ollama,
    knowledge,
    embedder,
    contextLog,
    getContext: async () => (await getSettings(h.db)).context,
    emit: (_target, event) => void events.set(event.streamId, [...(events.get(event.streamId) ?? []), event])
  })

  // Le basi del ruolo: una base della libreria per id, con i suoi documenti, ritrovata dal ruolo tramite l'id
  // del pacchetto (come una base arrivata con il ruolo).
  for (const wanted of variant.role.bases ?? []) {
    const source = variant.bases[wanted.id]
    if (!source) throw new BenchError(`La variante «${variant.name}» non ha i documenti della base ${wanted.id}`)
    const base = await knowledge.createBase(wanted.name ?? wanted.id)
    const dir = join(work, wanted.id)
    mkdirSync(dir, { recursive: true })
    const paths = source.files.map((file) => {
      const path = join(dir, file.name)
      writeFileSync(path, file.text, { flag: 'w' })
      return path
    })
    await knowledge.addFiles(base, paths)
    await knowledge.wait(base.id)
    const docs = await listDocuments(h.db, base.id)
    const failed = docs.filter((d) => d.status !== 'ready')
    if (failed.length) {
      const reason = failed[0].error ?? failed[0].status
      throw new BenchError(`La base ${wanted.id} non è stata indicizzata (${reason}). Controlla che Ollama sia avviato e che il modello di embedding sia installato: ollama pull ${(await getSettings(h.db)).embeddingModel}`)
    }
    h.raw.prepare('update knowledge_bases set package_id = ? where id = ?').run(wanted.id, base.id)
  }

  await saveRole(h.db, {
    id: ROLE_ID,
    packageId: ROLE_ID,
    group: null,
    language: variant.language,
    name: variant.name,
    description: '',
    version: '0',
    definition: variant.role,
    origin: 'package'
  })

  /** Una conversazione nuova con il ruolo, sul modello indicato, con le scelte del caso. */
  async function open(model: string, choices: RoleChoices | undefined, run: Pick<RunOptions, 'think' | 'numCtx'>): Promise<Conversation> {
    const session = createRoleSession({
      db: h.db,
      knowledge,
      // Il modello è quello in prova, non quello consigliato dal ruolo; la memoria è quella chiesta dal banco.
      initialModel: async () => model,
      modelInstalled: async () => false,
      suggest: async () => ({ numCtx: run.numCtx })
    })
    let conv = await session.create({ roleId: ROLE_ID })
    for (const [parameter, value] of Object.entries(choices ?? {})) conv = await session.choose(conv.id, parameter, value)
    const patch: ConversationPatch = { title: `bench ${conv.id.slice(0, 8)}` }
    if (run.think !== 'role') patch.think = run.think === 'on'
    // Con un titolo già scelto l'app non chiede al modello di generarne uno: le misure restano pulite.
    return updateConversation(h.db, conv.id, patch)
  }

  /** Invia una battuta e raccoglie risposta, ragionamento, prompt esatto e misure di Ollama. */
  async function say(conv: Conversation, text: string): Promise<Turn> {
    const before = new Set((await listContextCalls(h.db, conv.id)).map((c) => c.id))
    const { streamId } = await chat.send({}, conv.id, text)
    await chat.wait(streamId)
    const stream = events.get(streamId) ?? []
    events.delete(streamId)
    const failure = stream.find((e) => e.type === 'error')
    const answer = (await listMessages(h.db, conv.id)).findLast((m) => m.role === 'assistant')
    const call = (await listContextCalls(h.db, conv.id)).find((c) => !before.has(c.id) && c.kind === 'chat')
    const sent = call ? await getContextRequest(h.db, call.id) : null
    const output = call?.evalCount ?? null
    return {
      user: text,
      answer: failure ? '' : (answer?.content ?? ''),
      thinking: failure ? '' : (answer?.thinking ?? ''),
      sent: sent?.messages ?? [],
      doneReason: call?.doneReason ?? null,
      error: failure?.error ?? call?.error ?? null,
      measures: {
        totalMs: call?.durationMs ?? null,
        loadMs: call?.loadMs ?? null,
        promptEvalMs: call?.promptEvalMs ?? null,
        evalMs: call?.evalMs ?? null,
        firstTokenMs: call?.firstTokenMs ?? null,
        promptTokens: call?.promptEvalCount ?? null,
        outputTokens: output,
        thinkingTokens: call?.thinkingTokens ?? null,
        tokensPerSecond: output && call?.evalMs ? Math.round((output / (call.evalMs / 1000)) * 10) / 10 : null
      }
    }
  }

  return {
    open,
    say,
    /** Le scelte effettive: i predefiniti del ruolo più quelle indicate. */
    choices: (choices?: RoleChoices): RoleChoices => resolveChoices(variant.role, choices),
    close(): void {
      h.close()
      rmSync(work, { recursive: true, force: true })
    }
  }
}

export type Bench = Awaited<ReturnType<typeof createBench>>
