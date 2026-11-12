# Ruoli: idea e piano di realizzazione

Stato: **progetto approvato, codice non ancora scritto.** Questo documento fissa l'idea, le decisioni prese e
il piano di lavoro. Va aggiornato man mano che le fasi vengono realizzate.

Documenti collegati: [`base-di-conoscenza.md`](base-di-conoscenza.md) (basi, pacchetti, Store).

---

## 1. L'idea in breve

Oggi una conversazione è «un modello + un Brief scritto a mano». L'utente deve sapere come si scrive un buon
prompt e come si regolano temperatura, stile e memoria.

Con i ruoli, l'utente sceglie **con chi parlare**: «Parla con un… Esperto di prompt engineering». Il ruolo
arriva già calibrato e porta con sé ciò che gli serve per comportarsi bene.

> **Un ruolo = una mente + delle basi di conoscenza.**
> **La conversazione aggiunge la situazione e i documenti dell'utente.**

| Elemento | Cos'è | Di chi è |
|---|---|---|
| **Ruolo** | L'identità con cui si parla. Si sceglie alla creazione della conversazione. | Di chi lo ha scritto (incluso nell'app, Store) |
| **Mente** | Le impostazioni del modello (temperatura, ragionamento, stile, memoria…) calibrate per il ruolo, più i **parametri del ruolo**. | Del ruolo; l'utente la regola |
| **Parametri del ruolo** | Scelte multiple proprie di quel ruolo (es. «Pubblico», «Formato atteso»). Ogni opzione diventa un'istruzione per il modello e può regolare la mente. | Del ruolo; l'utente sceglie tra le opzioni proposte |
| **Basi del ruolo** | Fino a due tipi: **comportamento** (manuali, tecniche del mestiere) ed **esempi** (few-shot). | Del ruolo |
| **Situazione** | Campo libero: il contesto di *questa* conversazione, scritto dall'utente. Sostituisce il Brief. | Dell'utente |
| **Documenti** | La base della conversazione e le basi collegate, come oggi. | Dell'utente |

### Cosa non c'è, per scelta

- **Nessun system prompt generale dell'app.** Il posto «sistema» lo riempie solo il ruolo (e la situazione).
- **Ruolo Generalista**: nessuna istruzione, nessun parametro, valori predefiniti del modello. È l'app di oggi.

---

## 2. Decisioni prese

| # | Tema | Decisione |
|---|---|---|
| 1 | Parametri | Ogni ruolo definisce **i suoi**, consolidati per quel mestiere. Non esiste un elenco comune. |
| 2 | Effetto di un'opzione | Ogni opzione porta una **frase di istruzione** e può anche **modificare la mente** (es. temperatura). |
| 3 | Brief | Diventa **Situazione**: un solo campo libero, con limite di caratteri legato al contesto del modello. |
| 4 | Brief esistenti | **Convertiti** in Situazione (i quattro campi con i loro titoli), sul ruolo Generalista. |
| 5 | Ordine del contesto | **Parametrizzabile** nelle Impostazioni (tre ordini), per fare test di qualità e velocità. |
| 6 | Basi | **Tre blocchi** (comportamento, esempi, documenti) con **quote regolabili** nelle Impostazioni. |
| 7 | Cambio di ruolo | Solo a **conversazione vuota**. Altrimenti si propone una **nuova conversazione** che parte dal **riassunto** della precedente. Da provare: indicare nel riassunto il ruolo precedente. |
| 8 | Template | Restano: una conversazione si salva come template (ruolo, scelte, situazione, mente). |
| 9 | Editor dei ruoli | **Dopo.** Nella prima versione solo ruoli installati (inclusi nell'app, Store). |
| 10 | Lingue | Un ruolo è **pensato in una lingua**, coerente con le sue basi. Lo stesso ruolo esiste in più lingue come **varianti**. |
| 11 | Store | **Scheda unica** per ruolo o base con scelta della lingua; **ricerca per titolo in tutte le lingue**; **filtro per lingua**. |
| 12 | Ruoli di base | **Assistente di FastChat** (documentazione dell'app) ed **Esperto di prompt engineering**, in **italiano e francese**; più il Generalista. |

---

## 3. Il ruolo nel dettaglio

### 3.1 Mente

Sono le impostazioni che l'app ha già nella scheda «Modello». Il ruolo ne fissa i **valori di partenza**:

- modello consigliato (se manca: avviso con «Scarica», si usa quello predefinito);
- temperatura, top-p, ragionamento, plan mode;
- stile della risposta (lunghezza);
- memoria (num_ctx) lasciata al valore suggerito dalla macchina, salvo indicazione del ruolo.

L'utente può sempre regolarle a mano, come oggi.

### 3.2 Parametri

Ogni parametro è definito dentro il ruolo:

| Campo | Significato |
|---|---|
| `id` | Identificatore stabile (per salvare la scelta) |
| `label` | Nome mostrato all'utente, nella lingua del ruolo |
| `type` | `single` (scelta singola), `multi` (scelta multipla), `toggle` (sì/no) |
| `options[]` | Le opzioni proposte |
| `options[].label` | Nome dell'opzione |
| `options[].instruction` | Frase che entra nelle istruzioni del ruolo quando l'opzione è scelta |
| `options[].mind` | Facoltativo: valori della mente che l'opzione imposta (es. `{ "temperature": 0.4 }`) |
| `default` | Opzione o opzioni preselezionate |

Regole:

- Le istruzioni del ruolo sono: testo fisso del ruolo (`instructions`) + le frasi delle opzioni scelte,
  nell'ordine dei parametri.
- Un'opzione che tocca la mente lo **dichiara** nell'interfaccia («imposta la temperatura a 0,4»).
- **Vince l'ultima azione**: se l'utente sposta a mano un valore dopo aver scelto l'opzione, vale il suo; se
  poi cambia opzione, vale quello dell'opzione.
- **Calcolo della mente** (deterministico, senza stato nascosto): valori base del ruolo (`mind`) → effetti delle
  opzioni scelte, nell'**ordine di definizione dei parametri** (se due toccano lo stesso valore vale l'ultimo
  definito) → ritocchi manuali dell'utente. Deselezionando un'opzione il valore torna da solo a quello
  dell'altra opzione attiva o, se non c'è, a quello base del ruolo. Un ritocco manuale su un valore decade
  quando l'utente cambia un'opzione che tocca quello stesso valore.
- Un `toggle` è trattato come un `single` con due opzioni (`on`/`off`): anche lo stato spento può avere la sua
  frase e il suo effetto sulla mente.

### 3.3 Basi del ruolo

| Scopo | Contenuto | Istruzione al modello | Fonti citate |
|---|---|---|---|
| **Comportamento** | Manuali, tecniche, regole del mestiere | «Applica queste tecniche» | No |
| **Esempi** | Coppie richiesta → risposta ben fatta (few-shot) | «Imita struttura e stile di questi esempi» | No |
| **Documenti** | Ciò che l'utente carica o collega | «Rispondi da questi testi» | Sì, come oggi |

Il meccanismo di scelta resta quello attuale: documento **intero** se entra nella quota, altrimenti **estratti**
scelti per la domanda (ricerca ibrida). Cambiano l'etichetta, l'istruzione e la quota.

Le basi del ruolo sono normali pacchetti di conoscenza: si installano con il ruolo, sono in sola lettura, e
l'utente può scollegarle dalla singola conversazione.

### 3.4 Formato del pacchetto

Stesso `.fcpack` delle basi, con `type: "identity"`. Stesse regole di firma e impronta.

```json
{
  "format": "fastchat-pack",
  "type": "identity",
  "id": "app.fastchat.ruolo.prompt.it",
  "group": "app.fastchat.ruolo.prompt",
  "language": "it",
  "name": "Esperto di prompt engineering",
  "description": "Scrive e migliora i prompt per modelli locali.",
  "version": "1.0.0"
}
```

`role.json` (dentro il pacchetto):

```json
{
  "instructions": "Sei un esperto di prompt engineering per modelli linguistici locali…",
  "mind": { "model": "gemma3:12b", "temperature": 0.6, "think": true, "style": "normal" },
  "parameters": [
    {
      "id": "target",
      "label": "Modello di destinazione",
      "type": "single",
      "default": "small",
      "options": [
        { "id": "small", "label": "Piccolo, locale", "instruction": "Scrivi prompt brevi e diretti: una istruzione per riga, niente premesse." },
        { "id": "large", "label": "Grande", "instruction": "Puoi usare istruzioni articolate, con ruolo, contesto e criteri di qualità." }
      ]
    },
    {
      "id": "intervento",
      "label": "Intervento",
      "type": "single",
      "default": "migliora",
      "options": [
        { "id": "scrive", "label": "Scrive da zero", "instruction": "Chiedi l'obiettivo se manca, poi scrivi il prompt completo." },
        { "id": "migliora", "label": "Migliora", "instruction": "Riscrivi il prompt dell'utente e spiega in tre punti cosa hai cambiato." },
        { "id": "spiega", "label": "Spiega cosa non va", "instruction": "Non riscrivere: elenca i problemi del prompt in ordine di gravità.", "mind": { "temperature": 0.3 } }
      ]
    }
  ],
  "bases": [
    { "id": "app.fastchat.kb.prompt-tecniche.it", "purpose": "behavior" },
    { "id": "app.fastchat.kb.prompt-esempi.it", "purpose": "examples" }
  ]
}
```

---

## 4. La conversazione

### 4.1 Situazione

- Un solo campo libero al posto dei quattro campi del Brief.
- **Limite di caratteri** = una quota del contesto del modello (proposta: 5% di `num_ctx`, con contatore
  visibile; il valore è regolabile insieme alle altre quote). `num_ctx` è in token, il contatore in caratteri:
  si converte con i caratteri per token già stimati dall'app (4 in partenza, poi misurati sulla conversazione).
  Esempio: 8.192 token × 5% × 4 ≈ 1.600 caratteri.
- Si può modificare in ogni momento; vale dalla domanda successiva.
- È sempre nella lingua dell'utente, così com'è.

### 4.2 Scelta e cambio del ruolo

- La freccia accanto a «Nuova conversazione» apre **«Parla con un…»**: ruoli installati, poi i template.
- «Nuova conversazione» senza scelta usa il **Generalista**.
- **Conversazione vuota**: il ruolo si può cambiare liberamente.
- **Conversazione avviata**: l'app propone «Nuova conversazione con *Ruolo X*», che parte con il **riassunto**
  della precedente (funzione di riassunto già esistente).
  - Opzione da provare nei test: una riga in testa al riassunto, «Riassunto di una conversazione avuta con:
    *Ruolo precedente*», perché il nuovo ruolo tenga i fatti e non lo stile.

### 4.3 Template

Restano come oggi. Salvano: ruolo, scelte dei parametri, mente, situazione. Compaiono in «Parla con un…» sotto
i ruoli.

---

## 5. Composizione del contesto

### 5.1 I blocchi

| Blocco | Contenuto | Cambia a ogni domanda? |
|---|---|---|
| **Istruzioni del ruolo** | Testo fisso del ruolo + frasi delle opzioni scelte + stile della risposta | No |
| **Situazione** | Il campo libero dell'utente | No |
| **Riassunto** | Riassunto automatico dei messaggi vecchi | Raramente |
| **Conversazione** | Messaggi recenti | Si allunga |
| **Memoria** | Estratti della memoria a lungo termine della conversazione | Sì |
| **Comportamento** | Tecniche dalla base di comportamento del ruolo | Sì (se a estratti) |
| **Esempi** | Esempi dalla base di esempi del ruolo | Sì (se a estratti) |
| **Documenti** | Testi dell'utente, con le fonti | Sì (se a estratti) |
| **Domanda** | L'ultimo messaggio dell'utente | Sì |

### 5.2 Perché l'ordine conta

A ogni domanda l'app manda a Ollama **tutto** il testo. Ollama conserva il calcolo della richiesta precedente e
lo **riusa finché il testo nuovo coincide con il vecchio, dall'inizio**. Dal primo punto diverso ricalcola
tutto ciò che segue.

- Se cambia solo la fine: ricalcola poche righe, risponde subito.
- Se cambia l'inizio (il system prompt): ricalcola l'intera conversazione.

Inoltre i modelli danno più peso a ciò che sta all'inizio e alla fine del contesto.

### 5.3 I tre ordini (impostazione)

**Ordine A — tutto nel system prompt** (comportamento di oggi; predefinito)

```
SISTEMA     Istruzioni del ruolo
            Situazione
            Riassunto
            Memoria · Comportamento · Esempi · Documenti      ← cambia a ogni domanda
UTENTE/ASSISTENTE   conversazione                             ← ricalcolata ogni volta
UTENTE      Domanda
```

**Ordine B — conoscenza accanto alla domanda**

```
SISTEMA     Istruzioni del ruolo
            Situazione
            Riassunto
UTENTE/ASSISTENTE   conversazione                             ← riusata
UTENTE      Memoria · Comportamento · Esempi · Documenti      ← ricalcolato
            Domanda
```

**Ordine C — anche il ruolo accanto alla domanda**

```
SISTEMA     Situazione
            Riassunto
UTENTE/ASSISTENTE   conversazione                             ← riusata
UTENTE      Istruzioni del ruolo                              ← ricalcolato
            Memoria · Comportamento · Esempi · Documenti
            Domanda
```

| | A | B | C |
|---|---|---|---|
| Il system prompt cambia a ogni domanda | Sì | No | No |
| Cosa si ricalcola | Tutto | Ultimo messaggio | Ultimo messaggio |
| Distanza conoscenza–domanda | Tutta la conversazione | Minima | Minima |
| Ruolo nel posto «sistema» | Sì | Sì | No |

**Promemoria del ruolo** (sì/no, indipendente dall'ordine): una riga breve con l'essenziale del ruolo, accanto
alla domanda. Serve a tenere il ruolo nelle conversazioni lunghe senza toglierlo dal system prompt.

Note:

- Con B e C conoscenza, promemoria e domanda sono **un solo messaggio `user`**, composto al momento dell'invio:
  mai due messaggi `user` di seguito (molti modelli locali li gestiscono male). In database resta solo il testo
  scritto dall'utente.
- Gli esempi sono racchiusi in delimitatori netti (es. `<esempio>…</esempio>`) e l'istruzione del blocco dice
  di imitarne forma e stile, non di copiarne il contenuto.
- Il numero di token inviati è lo stesso nei tre ordini: cambia dove stanno e quanto si riusa.
- Con B e C gli estratti viaggiano con l'ultima domanda e **non restano** nei messaggi precedenti salvati: la
  cronologia in database contiene solo la domanda dell'utente. È già così oggi.
- Modificare situazione o parametri a metà conversazione cambia il system prompt: la domanda successiva
  ricalcola tutto, una volta sola.

### 5.4 Quote della conoscenza

Oggi la conoscenza ha una quota unica per conversazione (25/50/75% di `num_ctx`, predefinito 50%).

Con i ruoli la quota si divide in **tre parti regolabili** nelle Impostazioni:

| Blocco | Proposta iniziale (della quota di conoscenza) |
|---|---|
| Comportamento | 20% |
| Esempi | 20% |
| Documenti | 60% |

- Lo spazio non usato da un blocco (base assente o piccola) passa agli altri, nell'ordine documenti, esempi,
  comportamento.
- La quota complessiva resta quella della conversazione (25/50/75%).
- I valori iniziali sono da confermare con i test.

### 5.5 Lingua dei testi scritti dall'app

I testi che l'app aggiunge per il modello (titoli dei blocchi, istruzione di stile, prompt del riassunto) oggi
seguono la lingua dell'interfaccia. Con i ruoli seguono **la lingua del ruolo**, per non mandare prompt misti.
Il Generalista non ha lingua propria e continua a seguire l'interfaccia.

---

## 6. Lingue e Store

- Un ruolo e le sue basi sono **scritti in una lingua**. Nome del ruolo, parametri e opzioni si vedono in quella
  lingua anche se l'interfaccia è in un'altra.
- Lo stesso ruolo in un'altra lingua è un **pacchetto distinto** (id proprio), legato agli altri dal campo
  `group`.
- Nello Store:
  - **una scheda per gruppo**, con «Disponibile in: Italiano · Français» e la scelta della lingua da installare
    (preselezionata quella dell'interfaccia, se c'è);
  - **ricerca** su titolo e descrizione di **tutte le varianti** (cercando «prompts» si trova anche la variante
    italiana);
  - **filtro per lingua** accanto alla ricerca («Tutte le lingue» predefinito);
  - si possono installare più lingue dello stesso ruolo: in «Parla con un…» compaiono con la sigla (· IT, · FR).
- Vale allo stesso modo per le basi di conoscenza vendute da sole.
- Installare un ruolo installa le basi che richiede; rimuoverlo le toglie se nessun altro ruolo le usa.

---

## 7. Ruoli di base (inclusi nell'app)

### Generalista
Nessuna istruzione, nessun parametro, nessuna base. Segue la lingua dell'interfaccia.

### Assistente di FastChat (IT, FR)
| | |
|---|---|
| **Scopo** | Rispondere a domande sull'uso dell'app |
| **Comportamento** | Come si risponde a una domanda d'uso: passi numerati, nomi esatti di schede e pulsanti, dire quando una funzione non esiste |
| **Documenti** | «Guida di FastChat», ampliata (Store, ruoli, Situazione); in francese va tradotta |
| **Parametri** | Livello: primo utilizzo · esperto — Formato: passo-passo · risposta breve |
| **Mente** | Temperatura bassa, risposte sintetiche |

### Esperto di prompt engineering (IT, FR)
| | |
|---|---|
| **Scopo** | Scrivere, migliorare e spiegare prompt |
| **Comportamento** | «Scrivere buoni prompt», ampliata con le tecniche |
| **Esempi** | Coppie «prompt debole → prompt migliorato» |
| **Parametri** | Modello di destinazione: piccolo locale · grande — Intervento: scrive da zero · migliora · spiega cosa non va — Formato: solo il prompt · prompt con spiegazione |
| **Mente** | Temperatura media, ragionamento attivo se il modello lo supporta |

I testi (istruzioni, frasi dei parametri, manuali, esempi, traduzioni francesi) nascono come **bozza** e vanno
riletti: sono ciò che l'utente percepisce come qualità.

---

## 8. Piano di realizzazione

Due consegne. La prima non cambia il comportamento dell'app: rende il contesto parametrizzabile e misurabile.
La seconda introduce i ruoli.

### Stato attuale del codice (punto di partenza)

| Cosa | Dove |
|---|---|
| Brief a quattro campi sulla conversazione (`role`, `context`, `goals`, `constraints`) | `src/main/db/schema.ts` (`conversations`, `brief_templates`) |
| System prompt dal Brief + stile | `src/shared/prompt.ts` (`buildSystemPrompt`, `buildStyleSection`) |
| Messaggi inviati: system (brief, stile, riassunto, memoria, documenti) + storico | `src/main/chat.ts` (`composeChat`, `Extras`) |
| Quota dei documenti | `src/shared/knowledge.ts` (`knowledgeBudget`, `buildKnowledgeSection`) |
| Basi collegate, senza scopo | tabella `conversation_bases` |
| Monitor del contesto (parti, token, tempi di caricamento e di valutazione del prompt) | tabella `context_calls`, `src/main/contextLog.ts` |
| Pacchetti e Store | `src/main/knowledge/pack.ts`, `src/main/store.ts`, `src/shared/store.ts` |
| Template | `brief_templates`, `useTemplates`, menu nella `Sidebar` |

---

### Prima consegna — contesto parametrizzabile

#### Fase 1 · Dati e conversione

- Migrazione `0014_roles`:
  - tabella `roles` (id, packageId, group, language, name, description, version, definizione JSON, origine);
  - `conversations`: `role_id`, `role_params` (JSON delle scelte), `situation`;
  - `brief_templates`: stessi tre campi;
  - `conversation_bases.purpose` (`behavior` | `examples` | `documents`, predefinito `documents`).
- Conversione dei dati: i quattro campi del Brief confluiscono in `situation` con i loro titoli
  (`# Ruolo`, `# Contesto`…), conversazioni e template passano al Generalista. I vecchi campi restano nel
  database per una versione, non più letti, così la conversione è reversibile.
- Tipi condivisi: `Role`, `RoleParameter`, `RoleOption`, `RoleMind` in `src/shared/roles.ts`.
- Ruolo Generalista creato all'avvio se manca.
- **Test**: conversione di Brief pieni, parziali e vuoti; template; migrazione su database esistente.

#### Fase 2 · Composizione del contesto

- Nuovo modulo puro `src/shared/compose.ts`: riceve i blocchi (§5.1) e l'ordine, restituisce i messaggi e le
  parti per il monitor. Sostituisce la logica di `composeChat`, che diventa un involucro.
- I tre ordini (§5.3) e il promemoria del ruolo.
- Con B e C la conoscenza è nel messaggio dell'utente inviato a Ollama, **non** in quello salvato.
- Tre blocchi di conoscenza: `recall` restituisce i pezzi divisi per scopo; tre sezioni con le loro istruzioni;
  quote come in §5.4.
- Limite della Situazione calcolato su `num_ctx`.
- Impostazioni → Generale → **«Composizione del contesto»**: ordine, promemoria, tre quote, quota della
  Situazione. Predefiniti = comportamento di oggi (ordine A, blocco unico di fatto).
- Plan mode ed esecuzione del piano usano lo stesso compositore.
- **Test**: stessi ingressi nei tre ordini (contenuto identico, posizione diversa); prefisso stabile tra due
  domande con B e C; quote e ridistribuzione; nessuna regressione con i predefiniti (i test attuali della chat
  devono restare verdi senza modifiche ai valori attesi).

#### Fase 3 · Strumenti per i test

- `context_calls`: ordine usato, promemoria sì/no, quote, **tempo al primo token**; il tempo di valutazione del
  prompt c'è già.
  - Riuso di Ollama: `prompt_eval_count` e il tempo di valutazione sono già registrati. **Da verificare con un
    Ollama vero** se `prompt_eval_count` conta solo i token nuovi (e allora misura il riuso in modo esatto) o
    tutto il prompt: il comportamento è cambiato tra versioni. La prova è semplice: due domande di seguito
    sulla stessa conversazione e confronto dei due valori. Fino ad allora fa fede il tempo di valutazione.
- Monitor del contesto: mostra ordine e tempi per ogni chiamata.
- Export CSV delle chiamate di una conversazione, per confrontare gli ordini.
- **Protocollo di prova** (manuale, con modelli veri): stessa conversazione medio-lunga (30–40 scambi) ripetuta
  nei tre ordini, con e senza promemoria; si confrontano tempo al primo token, tempo di valutazione, e qualità
  letta a mano su un insieme fisso di domande.
- **Test**: registrazione dei nuovi campi, export.

**Risultato della prima consegna**: l'app si comporta come oggi; nelle Impostazioni si può cambiare l'ordine e
le quote e misurare l'effetto. Il Brief è già «Situazione» nei dati, ma l'interfaccia del Brief resta invariata
fino alla seconda consegna (i quattro campi si leggono e scrivono come sezioni della Situazione).

---

### Seconda consegna — ruoli

#### Fase 4 · Interfaccia

- Barra laterale: menu **«Parla con un…»** (ruoli, poi template).
- Scheda «Modello»: intestazione con il ruolo; controlli della mente; sotto, i **parametri del ruolo** generati
  dalla definizione (select, scelta multipla, interruttore). Un'opzione che tocca la mente lo dichiara.
- Scheda «Brief» → **«Situazione»**: un campo, contatore dei caratteri, anteprima delle istruzioni che il
  modello riceverà (ruolo + situazione).
- Cambio ruolo: libero se la conversazione è vuota; altrimenti finestra «Nuova conversazione con…» che porta il
  riassunto.
- Scheda «Conoscenza»: le basi del ruolo compaiono con l'etichetta dello scopo, in sola lettura.
- Export della conversazione: ruolo, scelte, situazione al posto del Brief.
- Testi dell'app per il modello nella lingua del ruolo (§5.5).
- **Test**: e2e su scelta del ruolo, parametri che cambiano il prompt, effetto sulla mente, cambio ruolo con
  riassunto, template.

#### Fase 5 · Pacchetti e Store

- `pack.ts`: lettura e scrittura del tipo `identity` (`role.json`), campo `group`, verifica delle basi
  richieste.
- Installazione: ruolo + basi richieste; rimozione con controllo d'uso delle basi.
- Se una base richiesta dal ruolo non c'è più, all'apertura della conversazione compare un avviso non
  bloccante (come per il modello mancante), con il rimando allo Store.
- Catalogo: `group` e varianti per lingua; `storeEntries` raggruppa.
- Store: scheda unica con scelta della lingua, ricerca su tutte le varianti, filtro per lingua.
- Regola «ciò che è dello Store entra ed esce dallo Store» estesa ai ruoli.
- **Test**: installazione con dipendenze, varianti, ricerca multilingua, filtro, firma e impronta.

#### Fase 6 · Contenuti

- Generalista.
- «Assistente di FastChat» IT e FR: base di comportamento, Guida ampliata e tradotta.
- «Esperto di prompt engineering» IT e FR: base di comportamento, base di esempi.
- `scripts/build-packs.mjs`: costruisce i pacchetti dei ruoli e aggiorna il catalogo.

#### Fase 7 · Verifiche e documentazione

- Typecheck, test unitari, e2e completo, schermate di anteprima.
- Aggiornamento di questo documento, di `base-di-conoscenza.md` e del README.
- **Nessuna release senza conferma esplicita.**

---

## 9. Rischi e punti aperti

| Tema | Rischio | Come si affronta |
|---|---|---|
| Ordini B e C | Il ruolo in cima può «perdersi» nelle chat lunghe con modelli piccoli | Promemoria del ruolo; test |
| Ordine C | Il modello non trova il ruolo nel posto «sistema» | Solo come opzione di prova |
| Quote | Valori iniziali scelti a occhio | Regolabili; da fissare dopo i test |
| Opzioni che toccano la mente | L'utente vede cambiare valori che non ha toccato | Dichiarate nell'interfaccia; vince l'ultima azione |
| Conversione dei Brief | Testo più lungo del limite della Situazione | Si conserva comunque, con avviso |
| Riuso di Ollama | Non misurabile in modo diretto | Si usa il tempo di valutazione del prompt; da verificare |
| Contenuti in più lingue | Ogni lingua è una copia da mantenere | Accettato per semplicità; istruzioni condivise rimandate |
| Qualità dei ruoli di base | Dipende dai testi, non dal codice | Bozze da rileggere prima della release |

Rimandati a fasi successive: editor dei ruoli, ruoli creati dall'utente, pagamenti e licenze, plugin connettori
esterni.
