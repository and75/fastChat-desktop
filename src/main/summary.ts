// Riassunto automatico: quando i messaggi non coperti dal riassunto superano la soglia dello spazio
// per lo storico, i più vecchi confluiscono nel riassunto (aggiornato in modo incrementale) e il
// system prompt li sostituisce. Gira dopo ogni risposta, con lo stesso modello e lo stesso num_ctx.
import {
  buildSummaryRequest,
  buildSystemPrompt,
  charsPerToken,
  cleanSummary,
  historyAfter,
  planSummary,
  SUMMARY,
  SUMMARY_PROMPT,
  transcript,
  withSummary
} from '@shared/prompt'
import { resolveSettings } from '@shared/settings'
import type { Conversation, ModelCapabilities } from '@shared/types'
import type { Db } from './db/client'
import { getConversation, listMessages, updateConversation } from './db/repo'
import type { ChatRequest, OllamaClient } from './ollama'

export interface SummarizerDeps {
  db: Db
  ollama: OllamaClient
}

export type SummaryOutcome = 'updated' | 'not-needed' | 'disabled' | 'failed'

export function createSummarizer({ db, ollama }: SummarizerDeps) {
  const inProgress = new Set<string>()

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
  async function summarize(conversationId: string, force = false): Promise<{ outcome: SummaryOutcome; conversation: Conversation | null }> {
    if (inProgress.has(conversationId)) return { outcome: 'not-needed', conversation: null }
    const conv = await getConversation(db, conversationId)
    if (!conv || !conv.model) return { outcome: 'failed', conversation: conv }
    if (!conv.autoSummary && !force) return { outcome: 'disabled', conversation: conv }

    const history = await listMessages(db, conversationId)
    const { recent, aligned } = historyAfter(history, conv.summaryUpTo)
    const previous = aligned ? conv.summary : null
    const caps = await capsOf(conv.model)
    const s = resolveSettings(conv, caps)
    const plan = planSummary({
      recent,
      systemPrompt: withSummary(buildSystemPrompt(conv), previous),
      numCtx: s.numCtx,
      numPredict: s.numPredict,
      force
    })
    if (!plan) return { outcome: 'not-needed', conversation: conv }

    inProgress.add(conversationId)
    try {
      // La trascrizione deve stare nella memoria insieme a prompt, riassunto precedente e risposta.
      const cpt = charsPerToken(history)
      const overhead = SUMMARY_PROMPT.length + (previous?.length ?? 0) + 200
      const maxChars = Math.max(2000, (s.numCtx - SUMMARY.maxTokens) * cpt - overhead)
      const request: ChatRequest = {
        model: conv.model,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: buildSummaryRequest(previous, transcript(plan.cover, maxChars)) }
        ],
        options: { temperature: 0.2, top_p: s.topP, num_ctx: s.numCtx, num_predict: SUMMARY.maxTokens }
      }
      if (caps?.thinking) request.think = false
      const result = await ollama.chatStream(request, {})
      const summary = cleanSummary(result.content)
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
    } finally {
      inProgress.delete(conversationId)
    }
  }

  return { summarize, isSummarizing: (id: string) => inProgress.has(id) }
}

export type Summarizer = ReturnType<typeof createSummarizer>
