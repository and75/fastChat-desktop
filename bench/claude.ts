// Claude come giudice e come correttore: una sola funzione, «chiedi e ricevi una risposta con questa forma».
// La chiave si legge dall'ambiente (ANTHROPIC_API_KEY) e non compare mai nei file del banco.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'

/** Chiede a un modello una risposta che rispetti lo schema; null se il modello declina o la risposta non è valida. */
/** `context` è materiale lungo e stabile (le fonti): va in testa alla richiesta e si mette in cache tra un giro e l'altro. */
export type Ask = <Schema extends z.ZodType>(input: { system: string; user: string; context?: string; schema: Schema; maxTokens?: number }) => Promise<z.infer<Schema> | null>

export interface Claude {
  model: string
  ask: Ask
  /** Token usati finora, per dire quanto è costato il giro. */
  usage: { input: number; output: number; calls: number }
}

type Env = Record<string, string | undefined>

/**
 * La chiave come la userà il banco: `ANTHROPIC_API_KEY` senza spazi, a capo e virgolette rimasti dal
 * copia-incolla. `warnings` dice cosa è stato tolto o cosa non torna; `fingerprint` la fa riconoscere senza mostrarla.
 */
export function readAnthropicKey(env: Env = process.env): { key: string | null; fingerprint: string; warnings: string[] } {
  const raw = env.ANTHROPIC_API_KEY ?? ''
  const warnings: string[] = []
  let key = raw.trim()
  if (key !== raw) warnings.push('ANTHROPIC_API_KEY aveva spazi o a capo attorno: li ho tolti')
  const unquoted = key.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  if (unquoted !== key) warnings.push('ANTHROPIC_API_KEY era tra virgolette: le ho tolte (nel Prompt dei comandi di Windows si scrive senza)')
  key = unquoted
  if (key && /\s/.test(key)) warnings.push('ANTHROPIC_API_KEY contiene spazi o a capo in mezzo: è stata copiata male')
  if (key && !key.startsWith('sk-ant-')) warnings.push('ANTHROPIC_API_KEY non inizia con «sk-ant-»: non sembra una chiave della Console di Anthropic')
  if (env.ANTHROPIC_AUTH_TOKEN) warnings.push('nell\'ambiente c\'è anche ANTHROPIC_AUTH_TOKEN: il banco la ignora e usa solo ANTHROPIC_API_KEY')
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') !== ANTHROPIC_URL) warnings.push(`nell'ambiente c'è ANTHROPIC_BASE_URL (${env.ANTHROPIC_BASE_URL}): il banco la ignora e chiama ${ANTHROPIC_URL}`)
  const fingerprint = !key ? 'assente' : key.length < 20 ? `${key.length} caratteri (troppo corta)` : `${key.slice(0, 10)}…${key.slice(-4)}, ${key.length} caratteri`
  return { key: key || null, fingerprint, warnings }
}

const ANTHROPIC_URL = 'https://api.anthropic.com'

/** C'è una chiave Anthropic nell'ambiente? Senza, il banco fa solo misure e controlli a regole fisse. */
export const hasAnthropicKey = (env: Env = process.env): boolean => readAnthropicKey(env).key !== null

// Chiave e indirizzo espliciti: altre variabili dell'ambiente (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, messe
// per esempio da Claude Code) non cambiano la credenziale né la destinazione.
const newClient = (): Anthropic => new Anthropic({ apiKey: readAnthropicKey().key, authToken: null, baseURL: ANTHROPIC_URL })

/** Una richiesta minima al modello giudice: null se la chiave funziona, altrimenti il motivo. */
export async function checkAnthropicKey(model: string): Promise<string | null> {
  try {
    await newClient().messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ok' }] })
    return null
  } catch (err) {
    return describeAnthropicError(err)
  }
}

export function createClaude(model = 'claude-opus-5-5'): Claude {
  const client = newClient()
  const usage = { input: 0, output: 0, calls: 0 }
  const ask: Ask = async ({ system, user, context, schema, maxTokens = 16000 }) => {
    // In streaming: una risposta lunga (un documento riscritto) non incontra i limiti di tempo di una richiesta sola.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      // Se il modello declina la richiesta, il servizio la ripete sul modello di ripiego predefinito.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: context ? [{ type: 'text', text: context, cache_control: { type: 'ephemeral' } }, { type: 'text', text: user }] : user }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) }
    })
    const message = await stream.finalMessage()
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
  if (err instanceof Anthropic.APIConnectionError) return `Anthropic non raggiungibile: controlla la connessione (${err.message})`
  if (err instanceof Anthropic.APIError) {
    const plain =
      err instanceof Anthropic.AuthenticationError ? 'Anthropic non riconosce la chiave'
      : err instanceof Anthropic.PermissionDeniedError ? 'la chiave non ha il permesso per questa richiesta'
      : err instanceof Anthropic.NotFoundError ? 'modello non trovato o non disponibile per questa chiave'
      : err instanceof Anthropic.RateLimitError ? 'limite di richieste raggiunto: riprova tra poco'
      : err.status === 400 ? 'richiesta rifiutata (spesso: credito esaurito, o un\'opzione non accettata dal modello)'
      : 'errore del servizio'
    // Il messaggio vero di Anthropic: dice il motivo esatto e non contiene la chiave.
    const id = err.requestID ? `, richiesta ${err.requestID}` : ''
    return `${plain} — Anthropic risponde ${err.status ?? '?'}: ${err.message}${id}`
  }
  return err instanceof Error ? err.message : String(err)
}
