// Il giudice: Claude legge la richiesta, le istruzioni che il modello locale ha ricevuto e la sua risposta, e dà
// un voto da 1 a 5 per criterio, con la motivazione. La griglia è fissa: gli stessi criteri per ogni caso.
import { z } from 'zod'
import type { Ask } from './claude'
import type { CaseResult, Variant, Verdict } from './types'

export const CRITERIA = {
  comportamento: 'Ha fatto la cosa giusta per questa richiesta: chiedere quando mancano pubblico o scopo, scrivere il prompt quando ha ciò che serve, elencare i problemi senza riscrivere quando gli si chiede una diagnosi.',
  aderenza: 'Rispetta le istruzioni del ruolo e le scelte in vigore: forma del prompt, spiegazione richiesta o no, tecniche da usare, ipotesi dichiarate.',
  qualita: 'Il prompt prodotto (o le domande, o la diagnosi) è utile davvero: dice obiettivo, contesto e forma della risposta; un modello lo eseguirebbe bene così com\'è.',
  fedelta: 'Rispetta ciò che l\'utente ha chiesto: non stravolge l\'intento e non inventa requisiti senza dichiararli.',
  naturalezza: 'È scritto come lo scriverebbe un esperto: prosa naturale, niente etichette meccaniche, niente regole o delimitatori fuori posto, niente ripetizioni.'
} as const

export type Criterion = keyof typeof CRITERIA

const VerdictSchema = z.object({
  scores: z.array(z.object({ criterion: z.enum(Object.keys(CRITERIA) as [Criterion, ...Criterion[]]), score: z.number(), reason: z.string() })),
  problems: z.array(z.string())
})

const SYSTEM = `Sei il giudice di un banco di prova. Valuti le risposte di un modello linguistico locale e piccolo che lavora come «esperto di prompt engineering» dentro un'applicazione di chat: riceve la richiesta di un utente e deve scrivere, migliorare o diagnosticare un prompt.

Ti vengono dati: cosa ci si aspettava, le istruzioni che il modello ha ricevuto, la conversazione, e l'esito di alcuni controlli automatici. Il ragionamento interno del modello non ti viene mostrato: giudica solo ciò che l'utente vede.

Dai un voto intero da 1 a 5 a ciascun criterio, con una motivazione di una frase che citi un fatto preciso della risposta:
${Object.entries(CRITERIA).map(([id, text]) => `- ${id}: ${text}`).join('\n')}

Scala: 5 = un esperto umano non farebbe meglio; 4 = buono, difetti marginali; 3 = usabile ma con un difetto evidente; 2 = difetti che lo rendono poco utile; 1 = sbagliato o inutilizzabile.

Sii severo e coerente: lo stesso difetto vale lo stesso voto in ogni caso. Non premiare la lunghezza. Se la conversazione ha due battute (domande, poi il prompt), giudica l'insieme.

In «problems» elenca al massimo tre difetti, dal più grave, ciascuno in una frase che dica cosa è successo e in quale parte delle istruzioni ricevute potrebbe stare la causa. Se non ci sono difetti rilevanti, lascia l'elenco vuoto. Scrivi in italiano.`

const EXPECTED = {
  prompt: 'Scrivere subito il prompt, in un blocco di codice.',
  ask: 'La richiesta non dice per chi è il risultato o a cosa serve: fare due o tre domande brevi e fermarsi; scrivere il prompt solo dopo le risposte dell\'utente.',
  diagnosis: 'Elencare i problemi del prompt, dal più grave al meno grave, senza riscriverlo. L\'elenco è già la risposta completa: la spiegazione in tre punti vale solo dopo un prompt scritto, quindi la sua assenza qui non è un difetto.'
} as const

/** Le istruzioni del ruolo come il modello le ha ricevute: il messaggio di sistema fino alle tecniche. */
const roleInstructionsOf = (system: string): string => system.split(/\n\n# /)[0]

/** Il testo che il giudice riceve per un caso. */
export function judgePrompt(result: CaseResult): string {
  const system = result.turns[0]?.sent.find((m) => m.role === 'system')?.content ?? ''
  const conversation = result.turns.map((t, i) => `<utente battuta="${i + 1}">\n${t.user}\n</utente>\n<esperto battuta="${i + 1}">\n${t.answer.trim() || '(risposta vuota)'}\n</esperto>`).join('\n')
  const checks = result.checks.map((c) => `- ${c.pass ? 'superato' : 'FALLITO'} · ${c.id}: ${c.detail}`).join('\n') || '- nessuno'
  return `<atteso>\n${EXPECTED[result.case.expect]}${result.case.note ? `\nNota sul caso: ${result.case.note}` : ''}\n</atteso>

<istruzioni_ricevute_dal_modello>
${roleInstructionsOf(system)}
</istruzioni_ricevute_dal_modello>

<conversazione>
${conversation}
</conversazione>

<controlli_automatici>
${checks}
</controlli_automatici>`
}

/** Costruisce il giudice a partire da una funzione che interroga Claude (sostituibile nei test). */
export function createJudge(ask: Ask): (result: CaseResult, variant: Variant) => Promise<Verdict | null> {
  return async (result) => {
    if (result.turns.length === 0 || result.turns.every((t) => !t.answer.trim())) return null
    const reply = await ask({ system: SYSTEM, user: judgePrompt(result), schema: VerdictSchema, maxTokens: 4000 })
    if (!reply) return null
    // Un voto per criterio, nell'ordine della griglia, limitato alla scala; i criteri mancanti invalidano il verdetto.
    const scores = (Object.keys(CRITERIA) as Criterion[]).map((criterion) => reply.scores.find((s) => s.criterion === criterion))
    if (scores.some((s) => !s)) return null
    const clean = scores.map((s) => ({ criterion: s!.criterion, score: Math.min(5, Math.max(1, Math.round(s!.score))), reason: s!.reason.trim() }))
    return { scores: clean, mean: Math.round((clean.reduce((n, s) => n + s.score, 0) / clean.length) * 100) / 100, problems: reply.problems.slice(0, 3).map((p) => p.trim()).filter(Boolean) }
  }
}
