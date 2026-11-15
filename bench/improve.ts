// Il correttore: Claude legge come è andata una variante sui casi di lavoro e propone la successiva, cambiando
// solo i testi (istruzione fissa, frasi delle opzioni, documenti delle basi del ruolo). La struttura del ruolo,
// cioè parametri, opzioni, predefiniti ed effetti sulla mente, non si tocca: una proposta che la altera, o che
// non supera i controlli dei ruoli, viene scartata.
import { z } from 'zod'
import { validateRole, type Role } from '../src/shared/roles'
import type { Ask } from './claude'
import type { CaseResult, Variant } from './types'

const ProposalSchema = z.object({
  /** Cosa non va, in poche frasi: la causa nei testi, non l'elenco dei sintomi. */
  diagnosis: z.string(),
  /** Le modifiche fatte, una frase ciascuna. */
  changes: z.array(z.string()),
  /** La nuova istruzione fissa del ruolo (testo completo), oppure stringa vuota per lasciarla com'è. */
  instructions: z.string(),
  /** Le frasi delle opzioni da cambiare: solo quelle che cambiano. */
  options: z.array(z.object({ parameter: z.string(), option: z.string(), instruction: z.string() })),
  /** I documenti delle basi da cambiare: il testo completo del documento, in Markdown. */
  bases: z.array(z.object({ id: z.string(), text: z.string() }))
})

export type Proposal = z.infer<typeof ProposalSchema>

const SYSTEM = `Metti a punto i testi di un «ruolo» per un'applicazione di chat con modelli linguistici locali e piccoli (circa 4–12 miliardi di parametri). Il ruolo è un «esperto di prompt engineering»: riceve la richiesta di un utente e scrive, migliora o diagnostica un prompt.

Il modello locale riceve, in un solo messaggio di sistema: l'istruzione fissa del ruolo, una frase per ogni opzione scelta dall'utente, un documento di tecniche, e i due esempi più vicini alla richiesta presi da un documento di esempi. Tu puoi cambiare solo questi testi.

Ti viene dato come si è comportato il modello su alcuni casi di prova: le risposte, i controlli automatici falliti e il giudizio di un valutatore. Il tuo compito è trovare, nei testi, la causa dei difetti e proporre una versione migliore.

Come lavorare:
- Cerca la causa, non il sintomo. Un modello piccolo applica alla lettera ciò che legge: se aggiunge un esempio non richiesto o una regola fuori posto, quasi sempre una frase dei testi glielo suggerisce, o un esempio glielo mostra. Togliere o riformulare quella frase vale più che aggiungere un divieto.
- Preferisci togliere e chiarire ad aggiungere. Ogni frase in più diluisce le altre e allunga il tempo di risposta. Evita maiuscole e toni perentori.
- Fai poche modifiche mirate per giro, quelle che spiegano il maggior numero di difetti: così si capisce quale ha avuto effetto.
- Scrivi regole generali. Non nominare i casi di prova, i loro argomenti o le loro parole: i testi devono funzionare per qualunque richiesta, e verranno misurati su casi che non vedi.
- Gli esempi insegnano più delle regole: se la forma delle risposte è sbagliata, guarda prima se un esempio la mostra così. Ogni esempio sta sotto un titolo «## …» e ha la forma «Richiesta: … / Risposta: …»; mantienila.
- Mantieni la lingua dei testi e il loro registro. Non cambiare il significato di un'opzione: la sua frase deve continuare a fare ciò che l'etichetta promette all'utente.

Cosa restituire:
- «instructions»: il testo completo della nuova istruzione fissa, oppure una stringa vuota se non la cambi.
- «options»: solo le frasi delle opzioni che cambi, indicate con gli identificativi di parametro e opzione che ti vengono dati.
- «bases»: solo i documenti che cambi, ciascuno con il suo testo completo (non un frammento), indicato con il suo identificativo.
- «diagnosis» e «changes»: la causa che hai individuato e le modifiche fatte, in italiano, una frase per modifica.

Se i testi vanno già bene e i difetti dipendono dal modello, restituisci elenchi vuoti e dillo in «diagnosis».`

/** I testi di una variante, come li legge il correttore. */
function describeVariant(variant: Variant): string {
  const role = variant.role
  const parameters = (role.parameters ?? [])
    .map((p) => {
      const defaults = Array.isArray(p.default) ? p.default : [p.default]
      const options = p.options.map((o) => `  - opzione «${o.id}» (${o.label}${defaults.includes(o.id) ? ', predefinita' : ''}): ${o.instruction ?? '(nessuna frase)'}`).join('\n')
      return `- parametro «${p.id}» (${p.label}, ${p.type === 'multi' ? 'scelta multipla' : 'scelta singola'}):\n${options}`
    })
    .join('\n')
  const bases = (role.bases ?? [])
    .filter((b) => variant.bases[b.id]?.editable)
    .map((b) => `<documento id="${b.id}" uso="${b.purpose === 'examples' ? 'esempi: partono i due più vicini alla richiesta' : 'tecniche: inviato per intero'}">\n${variant.bases[b.id].files.map((f) => f.text.trim()).join('\n\n')}\n</documento>`)
    .join('\n\n')
  return `<istruzione_fissa>\n${role.instructions ?? ''}\n</istruzione_fissa>\n\n<frasi_delle_opzioni>\n${parameters}\n</frasi_delle_opzioni>\n\n${bases}`
}

/** Un caso di lavoro, come lo legge il correttore: richiesta, scelte, risposte, difetti. */
function describeCase(r: CaseResult): string {
  const failed = r.checks.filter((c) => !c.pass)
  const lines = [`<caso id="${r.case.id}" modello="${r.model}">`, `Atteso: ${r.case.expect}${r.case.note ? ` — ${r.case.note}` : ''}`, `Scelte in vigore: ${Object.entries(r.choices).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ')}`]
  for (const [i, t] of r.turns.entries()) lines.push(`<utente battuta="${i + 1}">\n${t.user}\n</utente>`, `<esperto battuta="${i + 1}">\n${t.error ? `(errore: ${t.error})` : t.answer.trim() || '(risposta vuota)'}\n</esperto>`)
  lines.push(`Controlli automatici falliti: ${failed.length ? failed.map((c) => `${c.id} (${c.detail})`).join('; ') : 'nessuno'}`)
  if (r.verdict) {
    lines.push(`Giudizio: media ${r.verdict.mean}/5 — ${r.verdict.scores.map((s) => `${s.criterion} ${s.score} (${s.reason})`).join('; ')}`)
    if (r.verdict.problems.length) lines.push(`Difetti segnalati: ${r.verdict.problems.join(' | ')}`)
  }
  const thinking = r.turns.reduce((n, t) => n + (t.measures.thinkingTokens ?? 0), 0)
  const output = r.turns.reduce((n, t) => n + (t.measures.outputTokens ?? 0), 0)
  lines.push(`Token generati: ${output}, di cui ${thinking} di ragionamento.`, '</caso>')
  return lines.join('\n')
}

/** Il testo che il correttore riceve: i testi della variante e i soli casi di lavoro. */
export function improvePrompt(variant: Variant, results: CaseResult[], history: string[]): string {
  const train = results.filter((r) => r.variant === variant.name && r.case.split === 'train' && !r.error)
  const tried = history.length ? `\n\n<giri_precedenti>\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n</giri_precedenti>` : ''
  return `${describeVariant(variant)}\n\n<casi_di_lavoro>\n${train.map(describeCase).join('\n\n')}\n</casi_di_lavoro>${tried}`
}

/** Limiti entro cui un documento riscritto resta credibile: né svuotato né gonfiato. */
const withinBounds = (before: string, after: string): boolean => after.trim().length >= before.trim().length * 0.4 && after.trim().length <= before.trim().length * 1.6 + 400

/**
 * Applica una proposta a una variante. Restituisce la nuova variante, oppure il motivo per cui la proposta non è
 * accettabile (identificativi sconosciuti, ruolo non più valido, documento stravolto, nessuna modifica).
 */
export function applyProposal(variant: Variant, proposal: Proposal, name: string): { variant: Variant } | { rejected: string } {
  const role = structuredClone(variant.role) as Role
  const bases = structuredClone(variant.bases)
  let changed = false
  if (proposal.instructions.trim() && proposal.instructions.trim() !== (role.instructions ?? '').trim()) {
    role.instructions = proposal.instructions.trim()
    changed = true
  }
  for (const edit of proposal.options) {
    const option = (role.parameters ?? []).find((p) => p.id === edit.parameter)?.options.find((o) => o.id === edit.option)
    if (!option) return { rejected: `opzione sconosciuta: ${edit.parameter}/${edit.option}` }
    if (!edit.instruction.trim()) return { rejected: `frase vuota per ${edit.parameter}/${edit.option}` }
    if (!option.instruction) return { rejected: `l'opzione ${edit.parameter}/${edit.option} non ha una frase: non se ne può aggiungere una` }
    if (edit.instruction.trim() !== option.instruction.trim()) {
      option.instruction = edit.instruction.trim()
      changed = true
    }
  }
  for (const edit of proposal.bases) {
    const base = bases[edit.id]
    if (!base || !base.editable) return { rejected: `documento non modificabile: ${edit.id}` }
    if (base.files.length !== 1) return { rejected: `la base ${edit.id} ha più documenti: non si può sostituire con uno solo` }
    const before = base.files[0].text
    if (!withinBounds(before, edit.text)) return { rejected: `il documento ${edit.id} è cambiato troppo (da ${before.length} a ${edit.text.length} caratteri)` }
    const purpose = (role.bases ?? []).find((b) => b.id === edit.id)?.purpose
    if (purpose === 'examples' && (edit.text.match(/^## \S/gm) ?? []).length < 2) return { rejected: `il documento di esempi ${edit.id} deve avere almeno due esempi, ciascuno sotto un titolo «## »` }
    if (edit.text.trim() !== before.trim()) {
      base.files[0] = { ...base.files[0], text: edit.text.trim() + '\n' }
      changed = true
    }
  }
  if (!changed) return { rejected: 'nessuna modifica proposta' }
  const issues = validateRole(role)
  if (issues.length) return { rejected: `il ruolo non è più valido: ${issues.map((i) => i.code).join(', ')}` }
  return { variant: { name, language: variant.language, role, bases } }
}

/** Chiede a Claude la variante successiva. null se non risponde; altrimenti la proposta e il suo esito. */
export async function proposeVariant(ask: Ask, variant: Variant, results: CaseResult[], name: string, history: string[]): Promise<{ proposal: Proposal; outcome: { variant: Variant } | { rejected: string } } | null> {
  const proposal = await ask({ system: SYSTEM, user: improvePrompt(variant, results, history), schema: ProposalSchema, maxTokens: 32000 })
  if (!proposal) return null
  return { proposal, outcome: applyProposal(variant, proposal, name) }
}
