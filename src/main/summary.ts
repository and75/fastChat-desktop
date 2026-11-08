// Riassunto automatico: quando i messaggi non coperti dal riassunto superano la soglia dello spazio
import { t } from '@shared/i18n'
// per lo storico, i più vecchi confluiscono nel riassunto (aggiornato in modo incrementale) e il
// system prompt li sostituisce. Gira dopo ogni risposta, con lo stesso modello e lo stesso num_ctx.
import {
  buildSummaryRequest,
  buildSystemPrompt,
  charsPerToken,
  cleanSummary,
  computeContextUsage,
  historyAfter,
  planSummary,
  buildSummaryPrompt,
  estimateTokens,
  summaryMaxTokens,
  transcriptChunks,
  withSummary
} from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import type { Conversation, ModelCapabilities } from '@shared/types'
import type { Db } from './db/client'
import { getConversation, getModelSetting, listMessages, updateConversation } from './db/repo'
import { callInput, type CallStart, type ContextLog } from './contextLog'
import type { ChatRequest, ChatResult, OllamaClient } from './ollama'

export interface SummarizerDeps {
  db: Db
  ollama: OllamaClient
  contextLog?: ContextLog
}

/** Testo fino all'ultima riga completa (per un riassunto tagliato a metà frase). */
export function completeLines(text: string): string {
  const cut = text.lastIndexOf('\n')
  return (cut > text.length / 3 ? text.slice(0, cut) : text).trim()
}

export type SummaryOutcome = 'updated' | 'not-needed' | 'disabled' | 'failed'

export function createSummarizer({ db, ollama, contextLog }: SummarizerDeps) {
  /** Chiamata a Ollama registrata nel monitor del contesto. */
  async function call(request: ChatRequest, start: CallStart): Promise<ChatResult> {
    try {
      const result = await ollama.chatStream(request, {})
      await contextLog?.record(callInput(start, result))
      return result
    } catch (err) {
      await contextLog?.record(callInput(start, null, err))
      throw err
    }
  }

  /** Riassunti in corso, per conversazione: chi deve rispondere può aspettarli. */
  const running = new Map<string, Promise<unknown>>()

  async function capsOf(model: string): Promise<ModelCapabilities | null> {
    try {
      return await ollama.showModel(model)
    } catch {
      return null
    }
  }

  /**
   * Aggiorna il riassunto se serve. Con `force` riassume anche sotto la soglia (azione manuale) e
   * riparte da zero se il riassunto non è più allineato ai messaggi.
   */
  async function summarize(
    conversationId: string,
    force = false,
    /** Chiamato solo se il riassunto parte davvero, o se si aspetta quello in corso (stato nell'interfaccia). */
    onStart?: () => void,
    /** Se un riassunto è già in corso: aspettarlo e poi ricontrollare (prima della risposta), invece di rinunciare. */
    wait = false
  ): Promise<{ outcome: SummaryOutcome; conversation: Conversation | null }> {
    const busy = running.get(conversationId)
    if (busy) {
      if (!wait) return { outcome: 'not-needed', conversation: null }
      onStart?.()
      await busy.catch(() => undefined)
      const again = await summarize(conversationId, force, undefined, true)
      if (again.outcome !== 'not-needed') return again
      // Nessun nuovo riassunto necessario, ma quello appena finito va usato.
      return { outcome: 'updated', conversation: await getConversation(db, conversationId) }
    }
    let release: () => void = () => undefined
    running.set(conversationId, new Promise<void>((r) => (release = r)))
    try {
      return await run(conversationId, force, onStart)
    } finally {
      running.delete(conversationId)
      release()
    }
  }

  async function run(
    conversationId: string,
    force: boolean,
    onStart?: () => void
  ): Promise<{ outcome: SummaryOutcome; conversation: Conversation | null }> {
    const conv = await getConversation(db, conversationId)
    if (!conv || !conv.model) return { outcome: 'failed', conversation: conv }
    if (!conv.autoSummary && !force) return { outcome: 'disabled', conversation: conv }

    const history = await listMessages(db, conversationId)
    const { recent, aligned } = historyAfter(history, conv.summaryUpTo)
    const previous = aligned ? conv.summary : null
    const caps = await capsOf(conv.model)
    const s = resolveSettings(conv, caps)
    const reserveTokens = s.reserveTokens
    // Stesso numero del misuratore: i conteggi reali di Ollama dell'ultimo scambio, quando validi.
    const usage = computeContextUsage({
      brief: conv,
      style: conv.style,
      messages: history,
      numCtx: s.numCtx,
      summary: aligned ? conv.summary : null,
      summaryUpTo: aligned ? conv.summaryUpTo : null,
      summaryUpdatedAt: aligned ? conv.summaryUpdatedAt : null
    })
    const plan = planSummary({
      recent,
      systemPrompt: withSummary(buildSystemPrompt(conv, conv.style), previous),
      numCtx: s.numCtx,
      measuredTotal: usage.estimated && usage.used === 0 ? null : usage.used,
      force
    })
    if (!plan) return { outcome: 'not-needed', conversation: conv }

    onStart?.()
    try {
      // Ogni richiesta deve stare nella memoria: prompt + riassunto precedente + blocco di trascrizione +
      // riassunto da scrivere. I messaggi coperti vanno in blocchi, riassunti uno dopo l'altro: niente si taglia.
      const cpt = charsPerToken(history)
      // Stessa esecuzione (CPU/GPU) della chat: con un valore diverso Ollama ricaricherebbe il modello.
      const numGpu = (await getModelSetting(db, conv.model))?.numGpu ?? null
      const outTokens = summaryMaxTokens(s.numCtx, reserveTokens)
      const prompt = buildSummaryPrompt(Math.max(30, Math.round(outTokens * 0.7)))
      const previousTokens = Math.max(outTokens, previous ? estimateTokens(previous, cpt) : 0)
      const room = s.numCtx - outTokens - previousTokens - estimateTokens(prompt, cpt) - 48
      if (room < 64) return { outcome: 'failed', conversation: conv }
      let summary = previous
      const chunks = transcriptChunks(plan.cover, room * cpt)
      for (const [i, chunk] of chunks.entries()) {
        const request: ChatRequest = {
          model: conv.model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: buildSummaryRequest(summary, chunk) }
          ],
          options: { temperature: 0.2, top_p: s.topP, num_ctx: s.numCtx, num_predict: outTokens, ...(numGpu != null ? { num_gpu: numGpu } : {}) }
        }
        if (caps?.thinking) request.think = false
        const start: CallStart = {
          conversationId,
          kind: 'summary',
          note: chunks.length > 1 ? t('call.note.block', { i: i + 1, n: chunks.length }) : null,
          model: conv.model,
          numCtx: s.numCtx,
          parts: [
            { key: 'instructions', label: 'instructions', tokens: estimateTokens(prompt, cpt) },
            ...(summary ? [{ key: 'summary' as const, label: 'summary.previous', tokens: estimateTokens(summary, cpt) }] : []),
            { key: 'transcript', label: 'transcript.messages', tokens: estimateTokens(chunk, cpt), ...(i === 0 ? { count: plan.cover.length } : {}) }
          ]
        }
        const result = await call(request, start)
        let next = cleanSummary(result.content)
        if (next && result.doneReason === 'length') {
          // Riassunto tagliato al limite: lo si fa condensare, e se serve si chiude sull'ultima riga completa.
          const condense: ChatRequest = {
            ...request,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: `Condensa questo riassunto senza perdere fatti, nomi e richieste aperte:\n${completeLines(next)}` }
            ]
          }
          const shorter = await call(condense, {
            ...start,
            kind: 'condense',
            parts: [
              { key: 'instructions', label: 'instructions', tokens: estimateTokens(prompt, cpt) },
              { key: 'summary', label: 'summary.condense', tokens: estimateTokens(condense.messages[1].content, cpt) }
            ]
          })
          const text = cleanSummary(shorter.content)
          next = text ? (shorter.doneReason === 'length' ? completeLines(text) : text) : completeLines(next)
        }
        if (!next) return { outcome: 'failed', conversation: conv }
        summary = next
      }
      if (!summary) return { outcome: 'failed', conversation: conv }

      // Nel frattempo la conversazione può essere cambiata (altri messaggi): il riassunto resta valido,
      // perché copre solo messaggi già presenti all'inizio.
      const saved = await updateConversation(db, conversationId, {
        summary,
        summaryUpTo: plan.cover.at(-1)!.id,
        summaryUpdatedAt: Date.now()
      })
      return { outcome: 'updated', conversation: saved }
    } catch {
      return { outcome: 'failed', conversation: conv }
    }
  }

  return { summarize, isSummarizing: (id: string) => running.has(id) }
}

export type Summarizer = ReturnType<typeof createSummarizer>
