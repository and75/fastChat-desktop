// Il correttore: Claude legge come è andata una variante sui casi di lavoro e propone la successiva. Può cambiare
// l'istruzione fissa e le frasi delle opzioni, e può AGGIUNGERE esempi al documento degli esempi. I documenti
// riletti dall'utente (tecniche, esempi esistenti) non si riscrivono: ciò che il correttore vi trova di dannoso
// lo segnala, e decide l'utente. La struttura del ruolo (parametri, opzioni, predefiniti, effetti sulla mente)
// non si tocca: una proposta che la altera, o che non supera i controlli dei ruoli, viene scartata.
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
  /** Esempi nuovi da aggiungere in coda al documento degli esempi (quelli esistenti non si toccano). */
  examples: z.array(z.object({ title: z.string(), request: z.string(), response: z.string() })),
  /** Frasi dei documenti che il correttore ritiene dannose: solo segnalate, mai applicate. */
  documentNotes: z.array(z.string())
})

export type Proposal = z.infer<typeof ProposalSchema>

const SYSTEM = `Metti a punto i testi di un «ruolo» per un'applicazione di chat con modelli linguistici locali e piccoli (circa 4–12 miliardi di parametri). Il ruolo è un «esperto di prompt engineering»: riceve la richiesta di un utente e scrive, migliora o diagnostica un prompt.

Il modello locale riceve, in un solo messaggio di sistema: l'istruzione fissa del ruolo, una frase per ogni opzione scelta dall'utente, un documento di tecniche, e i due esempi più vicini alla richiesta presi da un documento di esempi.

Puoi cambiare l'istruzione fissa e le frasi delle opzioni, e puoi aggiungere esempi nuovi al documento degli esempi. Non puoi riscrivere il documento delle tecniche né modificare o togliere gli esempi esistenti: sono stati riletti da una persona e restano come sono. Se una loro frase ti sembra la causa di un difetto, segnalala in «documentNotes»: non verrà applicata, ma verrà letta.

Ti viene dato come si è comportato il modello su alcuni casi di prova: le risposte, i controlli automatici falliti e il giudizio di un valutatore. Il tuo compito è trovare, nei testi, la causa dei difetti e proporre una versione migliore.

Come lavorare:
- Cerca la causa, non il sintomo. Un modello piccolo applica alla lettera ciò che legge: se aggiunge un esempio non richiesto o una regola fuori posto, quasi sempre una frase dei testi glielo suggerisce, o un esempio glielo mostra. Togliere o riformulare quella frase vale più che aggiungere un divieto.
- Preferisci togliere e chiarire ad aggiungere. Ogni frase in più diluisce le altre e allunga il tempo di risposta. Evita maiuscole e toni perentori.
- Fai poche modifiche mirate per giro, quelle che spiegano il maggior numero di difetti: così si capisce quale ha avuto effetto.
- Scrivi regole generali. Non nominare i casi di prova, i loro argomenti o le loro parole: i testi devono funzionare per qualunque richiesta, e verranno misurati su casi che non vedi.
- Gli esempi insegnano più delle regole. Aggiungi un esempio solo quando serve: se manca un caso d'uso che gli esempi esistenti non coprono, o se un comportamento atteso non è mostrato da nessuno. Al massimo due per giro. Un esempio nuovo mostra una risposta riuscita, con la stessa forma degli altri, su una richiesta diversa da quelle dei casi di prova.
- Mantieni la lingua dei testi e il loro registro. Non cambiare il significato di un'opzione: la sua frase deve continuare a fare ciò che l'etichetta promette all'utente.

Cosa restituire:
- «instructions»: il testo completo della nuova istruzione fissa, oppure una stringa vuota se non la cambi.
- «options»: solo le frasi delle opzioni che cambi, indicate con gli identificativi di parametro e opzione che ti vengono dati.
- «examples»: gli esempi nuovi, ciascuno con un titolo breve che dice il caso d'uso, la richiesta dell'utente e la risposta completa dell'esperto (con il prompt in un blocco di codice, se la risposta contiene un prompt). Elenco vuoto se non ne servono.
- «documentNotes»: le frasi dei documenti che ritieni dannose, citate, con il motivo in una frase. Elenco vuoto se non ce ne sono.
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
    .map((b) => `<documento id="${b.id}" uso="${b.purpose === 'examples' ? 'esempi: partono i due più vicini alla richiesta; puoi solo aggiungerne' : 'tecniche: inviato per intero; non modificabile'}">\n${variant.bases[b.id].files.map((f) => f.text.trim()).join('\n\n')}\n</documento>`)
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

/** Esempi che un giro può aggiungere al massimo, e lunghezza massima di ciascuno (deve stare in un pezzo solo). */
export const MAX_NEW_EXAMPLES = 2
const MAX_EXAMPLE_CHARS = 1500

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Le parole con cui il documento degli esempi introduce richiesta e risposta, nella sua lingua. */
function exampleLabels(document: string): { request: string; response: string } {
  return /^Demande ?:/m.test(document) ? { request: 'Demande :', response: 'Réponse :' } : /^Request:/m.test(document) ? { request: 'Request:', response: 'Response:' } : { request: 'Richiesta:', response: 'Risposta:' }
}

/**
 * Applica una proposta a una variante. Restituisce la nuova variante, oppure il motivo per cui la proposta non è
 * accettabile (identificativi sconosciuti, ruolo non più valido, esempio non valido, nessuna modifica).
 * `forbidden` sono le richieste dei casi di prova: un esempio nuovo non può ricalcarne una.
 */
export function applyProposal(variant: Variant, proposal: Proposal, name: string, forbidden: string[] = []): { variant: Variant } | { rejected: string } {
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
  if (proposal.examples.length) {
    if (proposal.examples.length > MAX_NEW_EXAMPLES) return { rejected: `troppi esempi nuovi in un giro (${proposal.examples.length}, al massimo ${MAX_NEW_EXAMPLES})` }
    const id = (role.bases ?? []).find((b) => b.purpose === 'examples' && bases[b.id]?.editable)?.id
    if (!id || bases[id].files.length !== 1) return { rejected: 'il ruolo non ha un documento di esempi a cui aggiungerne' }
    const file = bases[id].files[0]
    const labels = exampleLabels(file.text)
    const titles = new Set((file.text.match(/^## .+$/gm) ?? []).map((t) => normalize(t.slice(3))))
    let text = file.text.trimEnd()
    for (const example of proposal.examples) {
      const title = example.title.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim()
      if (!title || !example.request.trim() || !example.response.trim()) return { rejected: 'esempio nuovo incompleto (servono titolo, richiesta e risposta)' }
      if (titles.has(normalize(title))) return { rejected: `esiste già un esempio con il titolo «${title}»` }
      if (forbidden.some((request) => normalize(request) === normalize(example.request))) return { rejected: `l'esempio «${title}» ricalca la richiesta di un caso di prova` }
      // Un titolo dentro la risposta spezzerebbe l'esempio in due: i titoli di sezione stanno solo nei blocchi di codice.
      if (/^#{1,2} \S/m.test(example.response.replace(/```[\s\S]*?```/g, ''))) return { rejected: `la risposta dell'esempio «${title}» contiene un titolo fuori da un blocco di codice` }
      const block = `## ${title}\n\n${labels.request} ${example.request.trim()}\n\n${labels.response}\n${example.response.trim()}`
      if (block.length > MAX_EXAMPLE_CHARS) return { rejected: `l'esempio «${title}» è troppo lungo (${block.length} caratteri, al massimo ${MAX_EXAMPLE_CHARS})` }
      titles.add(normalize(title))
      text += `\n\n${block}`
    }
    bases[id].files[0] = { ...file, text: text + '\n' }
    changed = true
  }
  if (!changed) return { rejected: 'nessuna modifica proposta' }
  const issues = validateRole(role)
  if (issues.length) return { rejected: `il ruolo non è più valido: ${issues.map((i) => i.code).join(', ')}` }
  return { variant: { name, language: variant.language, role, bases } }
}

/** Chiede a Claude la variante successiva. null se non risponde; altrimenti la proposta e il suo esito. */
export async function proposeVariant(ask: Ask, variant: Variant, results: CaseResult[], name: string, history: string[]): Promise<{ proposal: Proposal; outcome: { variant: Variant } | { rejected: string } } | null> {
  const proposal = await ask({ system: SYSTEM, user: improvePrompt(variant, results, history), schema: ProposalSchema, maxTokens: 16000 })
  if (!proposal) return null
  // Un esempio nuovo non può ricalcare nessuna richiesta di prova, nemmeno quelle di controllo che il correttore non vede.
  const forbidden = [...new Set(results.flatMap((r) => [r.case.request, r.case.reply ?? '']).filter(Boolean))]
  return { proposal, outcome: applyProposal(variant, proposal, name, forbidden) }
}
