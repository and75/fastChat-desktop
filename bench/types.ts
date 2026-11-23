// Banco di prova dei ruoli: i tipi condivisi tra esecuzione, controlli, giudice e rapporto.
import type { Role, RoleChoices } from '../src/shared/roles'

/** Una versione dei testi di un ruolo: la definizione e i documenti delle basi che porta con sé. */
export interface Variant {
  /** Nome leggibile: «base», «giro-1»… */
  name: string
  /** Lingua del ruolo (it, fr): i testi per il modello seguono questa. */
  language: string
  role: Role
  /** Per ogni base richiesta dal ruolo (per id), i file Markdown che la compongono. */
  bases: Record<string, { files: Array<{ name: string; text: string }>; editable: boolean }>
}

/** Cosa ci si aspetta dalla prima risposta dell'Esperto. */
export type Expectation =
  /** Scrive subito un prompt, in un blocco di codice. */
  | 'prompt'
  /** La richiesta è vaga: fa domande, senza scrivere il prompt. */
  | 'ask'
  /** Elenca i problemi di un prompt, senza riscriverlo. */
  | 'diagnosis'

export interface BenchCase {
  id: string
  /** «train»: Claude legge gli errori e corregge; «test»: serve solo a misurare. */
  split: 'train' | 'test'
  request: string
  /** Risposta dell'utente alle domande dell'Esperto: seconda battuta, se la prima non è già un prompt. */
  reply?: string
  /** Scelte del ruolo diverse dai predefiniti. */
  choices?: RoleChoices
  expect: Expectation
  /** Il risultato atteso è un compito creativo (racconto, email): niente delimitatori né dati in ingresso. */
  creative?: boolean
  note?: string
}

/** Una battuta: ciò che è partito verso il modello e ciò che è tornato, con le misure di Ollama. */
export interface Turn {
  user: string
  answer: string
  thinking: string
  /** I messaggi esatti inviati (sistema, storico, domanda). */
  sent: Array<{ role: string; content: string }>
  doneReason: string | null
  error: string | null
  measures: {
    totalMs: number | null
    loadMs: number | null
    promptEvalMs: number | null
    evalMs: number | null
    firstTokenMs: number | null
    promptTokens: number | null
    outputTokens: number | null
    thinkingTokens: number | null
    /** Token generati al secondo (ragionamento compreso). */
    tokensPerSecond: number | null
  }
}

export interface Check {
  id: string
  pass: boolean
  detail: string
}

export interface Verdict {
  /** Voto 1–5 per criterio, con la motivazione. */
  scores: Array<{ criterion: string; score: number; reason: string }>
  /** Media dei voti. */
  mean: number
  /** I difetti più gravi, in una frase ciascuno: materiale per la correzione. */
  problems: string[]
}

/** Una riga di results.jsonl: un caso, su un modello, una ripetizione. */
export interface CaseResult {
  variant: string
  model: string
  rep: number
  case: BenchCase
  /** Le scelte effettive del ruolo (predefiniti più quelle del caso). */
  choices: RoleChoices
  /** `gpuShare`: quota del modello in GPU secondo Ollama a fine caso (0 = solo CPU, 1 = tutto in GPU); `loadedCtx`: memoria con cui è caricato. */
  settings: { think: boolean; numCtx: number | null; temperature: number | null; gpuShare: number | null; loadedCtx: number | null }
  turns: Turn[]
  checks: Check[]
  verdict: Verdict | null
  /** Errore che ha impedito l'esecuzione (modello assente, Ollama spento…). */
  error: string | null
}

export interface RunOptions {
  ollamaUrl: string
  models: string[]
  reps: number
  /** role = come lo fissa il ruolo; on/off = forzato. */
  think: 'role' | 'on' | 'off'
  numCtx: number
  /** auto = decide Ollama; off = GPU bloccata, tutto su CPU. */
  gpu: 'auto' | 'off'
}
