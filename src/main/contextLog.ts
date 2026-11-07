// Monitor del contesto: registra ogni chiamata a Ollama di una conversazione (stima per voce + conteggi reali)
// e avvisa il renderer.
import type { ContextCall, ContextCallInput, ContextCallKind, ContextPart } from '@shared/types'
import type { Db } from './db/client'
import { addContextCall } from './db/repo'
import type { ChatResult } from './ollama'

export interface ContextLog {
  record(input: ContextCallInput): Promise<ContextCall | null>
}

/** Campi comuni di una chiamata, prima della risposta di Ollama. */
export interface CallStart {
  conversationId: string
  kind: ContextCallKind
  note?: string | null
  model: string
  numCtx: number | null
  parts: ContextPart[]
  droppedMessages?: number
}

/** Unisce l'inizio della chiamata con il risultato di Ollama (o l'errore). */
export function callInput(start: CallStart, result: Partial<ChatResult> | null, error?: unknown): ContextCallInput {
  return {
    conversationId: start.conversationId,
    kind: start.kind,
    note: start.note ?? null,
    model: start.model,
    numCtx: start.numCtx,
    parts: start.parts,
    droppedMessages: start.droppedMessages ?? 0,
    promptEvalCount: result?.promptEvalCount ?? null,
    evalCount: result?.evalCount ?? null,
    loadMs: result?.loadMs ?? null,
    promptEvalMs: result?.promptEvalMs ?? null,
    evalMs: result?.evalMs ?? null,
    durationMs: result?.durationMs ?? null,
    doneReason: result?.doneReason ?? null,
    aborted: result?.aborted ?? false,
    error: error == null ? null : error instanceof Error ? error.message : String(error)
  }
}

/** Il registro non fa mai fallire la chiamata che registra. */
export function createContextLog(db: Db, notify?: (call: ContextCall) => void): ContextLog {
  return {
    async record(input) {
      try {
        const call = await addContextCall(db, input)
        notify?.(call)
        return call
      } catch {
        return null
      }
    }
  }
}
