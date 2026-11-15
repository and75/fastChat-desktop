// Claude come giudice e come correttore: una sola funzione, «chiedi e ricevi una risposta con questa forma».
// La chiave si legge dall'ambiente (ANTHROPIC_API_KEY) e non compare mai nei file del banco.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'

/** Chiede a un modello una risposta che rispetti lo schema; null se il modello declina o la risposta non è valida. */
export type Ask = <Schema extends z.ZodType>(input: { system: string; user: string; schema: Schema; maxTokens?: number }) => Promise<z.infer<Schema> | null>

export interface Claude {
  model: string
  ask: Ask
  /** Token usati finora, per dire quanto è costato il giro. */
  usage: { input: number; output: number; calls: number }
}

/** C'è una credenziale Anthropic nell'ambiente? Senza, il banco fa solo misure e controlli a regole fisse. */
export const hasAnthropicKey = (): boolean => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

export function createClaude(model = 'claude-opus-5-5'): Claude {
  const client = new Anthropic()
  const usage = { input: 0, output: 0, calls: 0 }
  const ask: Ask = async ({ system, user, schema, maxTokens = 16000 }) => {
    const message = await client.beta.messages.parse({
      model,
      max_tokens: maxTokens,
      // Se il modello declina la richiesta, il servizio la ripete sul modello di ripiego predefinito.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) }
    })
    usage.calls++
    usage.input += message.usage.input_tokens
    usage.output += message.usage.output_tokens
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return null
    return (message.parsed_output as z.infer<typeof schema> | null) ?? null
  }
  return { model, ask, usage }
}

/** Un errore di Anthropic in una frase leggibile, senza dati della richiesta. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'chiave Anthropic non valida (controlla ANTHROPIC_API_KEY)'
  if (err instanceof Anthropic.PermissionDeniedError) return 'la chiave Anthropic non ha accesso a questo modello'
  if (err instanceof Anthropic.RateLimitError) return 'limite di richieste Anthropic raggiunto: riprova tra poco'
  if (err instanceof Anthropic.APIConnectionError) return 'Anthropic non raggiungibile: controlla la connessione'
  if (err instanceof Anthropic.APIError) return `errore Anthropic ${err.status ?? ''}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
