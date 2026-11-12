# Ruoli — decisioni e piano di esecuzione

Stato: **prima consegna rilasciata nella 0.1.22** (passi 1.0–1.8); manca solo la prova con Ollama vero (passo
1.7), che va eseguita sul computer dell'utente. **Seconda consegna in corso**: fatti i passi 2.1, 2.2 e 2.3.

- L'idea, il formato dei ruoli e gli esempi completi sono in [`ruoli.md`](ruoli.md).
- Questo documento è la versione operativa: **cosa è stato deciso** (Parte 1) e **in che passi si realizza**
  (Parte 2). In caso di differenza tra i due, vale questo.

---

# Parte 1 — Decisioni prese

## 1.1 Il concetto

| # | Decisione |
|---|---|
| D1 | Un'identità è un **ruolo**. Si usa in una conversazione con la dicitura **«Parla con un…»**. |
| D2 | Ogni ruolo ha una **mente**: le impostazioni del modello che l'app ha già, calibrate per il ruolo. |
| D3 | Ciò che oggi è nel Brief (Ruolo, Obiettivi, Vincoli) entra nel ruolo come **parametri a scelta**. Il Contesto del Brief diventa la **Situazione**. |
| D4 | **Nessun system prompt generale dell'app.** Esiste un ruolo **Generalista**: nessuna istruzione, nessun parametro, valori predefiniti del modello. È l'app di oggi. |
| D5 | Una conversazione può sempre diventare un **template**; i template restano. |
| D6 | L'**app è universale**: nessuna regola legata a un modello nel codice. Ciò che vale per un modello lo dichiara il ruolo. |
| D7 | Interfaccia **semplice e guidata** per chi non è esperto, con tutti i controlli per chi vuole regolare. |

## 1.2 Parametri del ruolo

| # | Decisione |
|---|---|
| D8 | Ogni ruolo definisce **i suoi** parametri, consolidati per quel mestiere. Non esiste un elenco comune. |
| D9 | I parametri si mostrano in **quattro sezioni fisse, sempre visibili**: Identità e obiettivi · Stile e formato · Regole e fonti · Metodo. Una sezione vuota non si vede. |
| D10 | Tipi di parametro: scelta singola, scelta multipla, sì/no (trattato come scelta singola a due opzioni). |
| D11 | Ogni opzione porta una **frase di istruzione** e può **modificare la mente**. |
| D12 | **In tutto il ruolo, al massimo un parametro può toccare una data impostazione** del modello. Un ruolo che viola la regola è rifiutato. |
| D13 | Calcolo della mente: valori base del ruolo → effetti delle opzioni → ritocchi manuali dell'utente. Vince l'ultima azione. |
| D14 | Le frasi che potrebbero contraddirsi si scrivono **in forma condizionale**. Niente dipendenze tra parametri nel formato. |
| D15 | I parametri **non** accendono né spengono le basi e non toccano le quote. |
| D37 | **La temperatura è indipendente dalla lunghezza della risposta**: un parametro che imposta lo stile (lunghezza) non può impostare anche la temperatura. Un ruolo che lo fa è rifiutato. Nessuna regola automatica nell'app lega i due valori. |

## 1.3 Basi di conoscenza

| # | Decisione |
|---|---|
| D16 | Tre tipi: **comportamento** (tecniche del mestiere), **esempi** (few-shot), **documenti** (contenuti su cui rispondere). |
| D17 | **Comportamento ed esempi sono sempre attivi**: fanno parte del ruolo, non hanno interruttore, non si scollegano. |
| D18 | I **documenti restano opzionali come oggi**: pill per la conversazione, bottone libro per la domanda. Il ruolo può solo fissare il valore di partenza della pill. |
| D19 | Tre blocchi nel contesto, ciascuno con la sua istruzione, con **quote regolabili** nelle Impostazioni. Lo spazio non usato da un blocco passa agli altri. |
| D20 | Gli esempi stanno tra delimitatori netti; l'istruzione dice di imitarne la forma, non il contenuto. |

## 1.4 Situazione e conversazione

| # | Decisione |
|---|---|
| D21 | **Situazione**: un campo libero, nella lingua dell'utente, con limite di caratteri = quota del contesto del modello (proposta 5%), convertita con i caratteri per token stimati dall'app. |
| D22 | I Brief esistenti (conversazioni e template) vengono **convertiti in Situazione** sul Generalista, con i loro titoli. |
| D23 | Il ruolo si cambia **solo a conversazione vuota**. Altrimenti l'app propone una **nuova conversazione** che parte dal **riassunto** della precedente. Indicare nel riassunto il ruolo precedente è un'opzione da provare. |

## 1.5 Composizione del contesto

| # | Decisione |
|---|---|
| D24 | L'ordine dei blocchi è **parametrizzabile**: A (tutto nel system prompt, come oggi), B (conoscenza accanto alla domanda), C (anche il ruolo accanto alla domanda, diagnostico). |
| D25 | **Promemoria del ruolo** accanto alla domanda: attivabile, indipendente dall'ordine. |
| D26 | Con B e C, conoscenza, promemoria e domanda sono **un solo messaggio utente**; nel database resta solo il testo scritto dall'utente. |
| D27 | Finché non ci sono risultati di test, il predefinito è il **comportamento di oggi** (ordine A). |
| D28 | Il ruolo può portare **profili per modello**: mente e composizione del contesto per un modello o una famiglia, con l'indicazione «verificato». |
| D29 | Precedenza: scelta forzata nelle Impostazioni → profilo del ruolo per il modello → valori base del ruolo → predefiniti dell'app. Nelle Impostazioni il valore predefinito è **«Automatico (decide il ruolo)»**. |
| D30 | I profili nascono da **valutazioni** di chi crea il ruolo. Ora: strumenti manuali (monitor, export). Il sistema di valutazione vero arriva con l'editor dei ruoli. |

## 1.6 Lingue, Store, contenuti

| # | Decisione |
|---|---|
| D31 | Un ruolo è **scritto in una lingua**, coerente con le sue basi. Lo stesso ruolo in un'altra lingua è una **variante** (pacchetto distinto, stesso gruppo). |
| D32 | I testi che l'app scrive per il modello seguono **la lingua del ruolo**; per il Generalista, quella dell'interfaccia. |
| D33 | Store: **scheda unica** per ruolo o base con scelta della lingua; **ricerca per titolo in tutte le lingue**; **filtro per lingua**. |
| D34 | Ruoli di base: **Generalista**, **Assistente di FastChat**, **Esperto di prompt engineering**; gli ultimi due in **italiano e francese**. |
| D35 | Nella prima versione solo ruoli **installati**; l'**editor dei ruoli** viene dopo. |
| D36 | **Nessuna release senza conferma esplicita.** |

## 1.7 Non verificato (da provare, non da assumere)

- Se `prompt_eval_count` di Ollama conti solo i token nuovi o tutto il prompt.
- Come Ollama tratta il messaggio di sistema per i modelli con formattatore interno (es. `gemma4`).
- I valori iniziali: quote 20/20/60, Situazione 5%, mente dei ruoli di base.
- Quante frasi di istruzione regge un modello piccolo.

---

# Parte 2 — Piano di esecuzione

## 2.1 Regole di lavoro

- **Due consegne.** La prima non cambia il comportamento dell'app con le impostazioni predefinite.
- **Un passo = un commit** sul branch `claude/contesto-parametri-effettivi`, con i test del passo verdi.
- **A fine consegna**: typecheck, test unitari, end-to-end completo, schermate di anteprima, documentazione.
- **Punti di controllo** (⏸): mi fermo e aspetto il tuo riscontro.
- Dimensione dei passi: **S** piccolo, **M** medio, **L** grande.

## 2.2 Una correzione rispetto a `ruoli.md`

In `ruoli.md` la conversione del Brief in Situazione era nella prima consegna, con l'interfaccia del Brief
lasciata invariata. Qui la sposto **nella seconda consegna**, insieme alla nuova interfaccia:

- convertire i dati lasciando la vecchia scheda costringerebbe a ricomporre i quattro campi a ogni lettura;
- la prima consegna resta davvero a comportamento invariato: tocca solo composizione, misure e impostazioni.

Nella prima consegna il «ruolo» da ricordare nel promemoria è il campo **Ruolo del Brief**.

---

## Prima consegna — contesto parametrizzabile e misurabile

**Obiettivo**: poter cambiare l'ordine del contesto e le quote dalle Impostazioni, e misurarne l'effetto su
velocità e qualità in conversazioni medio-lunghe. Con le impostazioni predefinite l'app si comporta come oggi.

### Passo 1.0 — Rete di sicurezza · S

- Test «fotografia» dei messaggi inviati a Ollama oggi: conversazione con Brief, stile, riassunto, memoria,
  documenti; plan mode ed esecuzione del piano.
- Servono a dimostrare, a ogni passo, che l'ordine A produce **esattamente** gli stessi messaggi di oggi.
- File: `tests/compose.test.ts` (nuovo).
- **Fatto quando**: i test passano sul codice attuale, senza modifiche.

### Passo 1.1 — Impostazioni della composizione · S

- `AppSettings` (`src/shared/types.ts`): nuovo blocco `context`:
  - `order`: `auto` · `A` · `B` · `C` (predefinito `auto`; finché non ci sono ruoli, `auto` = A);
  - `reminder`: `auto` · `on` · `off` (predefinito `auto` = spento);
  - `shares`: quote dei tre blocchi (predefinito 20/20/60);
  - `situationShare`: quota della Situazione (predefinito 5%; usata dalla seconda consegna).
- Validazione al salvataggio (`src/main/ipc.ts`): valori ammessi, quote che sommano a 100.
- **Test**: valori predefiniti, validazione, lettura di impostazioni salvate prima dell'aggiornamento.
- **Fatto quando**: le impostazioni esistono e si salvano, senza effetto sul comportamento.

### Passo 1.2 — Compositore puro · L

- Nuovo modulo `src/shared/compose.ts`, senza dipendenze dal main:
  - **ingresso**: i blocchi (istruzioni, stile, situazione, riassunto, memoria, comportamento, esempi,
    documenti, promemoria, storico, domanda) e la configurazione (ordine, promemoria);
  - **uscita**: i messaggi per Ollama e le voci per il monitor.
- Ordini A, B, C come in `ruoli.md` §5.3.
- Con B e C: un solo messaggio utente finale = blocchi + domanda (D26).
- La scelta dei messaggi dello storico che entrano nel contesto tiene conto dei blocchi accanto alla domanda.
- Nuove voci del monitor: `situation`, `behavior`, `examples`, `reminder`.
- **Test**:
  - ordine A = fotografie del passo 1.0, identiche;
  - B e C: stesso contenuto di A, posizione diversa; mai due messaggi utente di seguito;
  - **prefisso stabile**: con B e C, tra due domande consecutive i messaggi fino all'ultima domanda esclusa
    sono identici carattere per carattere;
  - promemoria presente o assente secondo configurazione.
- **Fatto quando**: tutti i test sopra sono verdi e il modulo non è ancora usato dall'app.

### Passo 1.3 — Il compositore nella chat · M

- `src/main/chat.ts`: `composeChat` diventa un involucro del nuovo modulo; `buildRequest` legge ordine e
  promemoria dalle impostazioni.
- Stesso percorso per risposta normale, plan mode, esecuzione del piano, «Continua», rigenerazione.
- Il messaggio salvato nel database resta il testo dell'utente (già così oggi).
- Promemoria nella prima consegna: prima riga del campo Ruolo del Brief, tra delimitatori.
- **Test**: quelli esistenti di `tests/chat.test.ts` verdi **senza modificare i valori attesi**; nuovi test con
  ordine B e C su conversazione con documenti e memoria.
- **Fatto quando**: con impostazioni predefinite l'end-to-end completo è verde senza ritocchi.

⏸ **Controllo 1** — ti mostro, sulla stessa conversazione, i messaggi inviati nei tre ordini.

### Passo 1.4 — Tre tipi di base · L

- Migrazione `0014`: `conversation_bases.purpose` (`documents` predefinito, `behavior`, `examples`).
- `src/main/knowledge/index.ts`: `recall` restituisce i pezzi divisi per tipo; tre sezioni con le loro
  istruzioni (`src/shared/knowledge.ts`); esempi tra delimitatori (D20).
- Quote: `knowledgeBudget` divide la quota della conversazione nei tre blocchi, con ridistribuzione dello
  spazio non usato (D19).
- **Sempre attivi**: comportamento ed esempi entrano anche con pill o bottone libro spenti (D17); i documenti
  seguono pill e bottone come oggi (D18).
- **Strumento di prova** (resta poi per gli esperti): nella scheda «Conoscenza», su una base collegata dalla
  libreria, un selettore «Documenti · Comportamento · Esempi». Senza ruoli è l'unico modo per provare i tre
  blocchi; con i ruoli il tipo arriva dal pacchetto.
- **Test**: quote e ridistribuzione; comportamento presente con documenti spenti; fonti citate solo per i
  documenti; con tutte le basi di tipo «documenti» il risultato è identico a oggi.
- **Fatto quando**: una base collegata come «comportamento» entra nel suo blocco, sempre, senza fonti.

### Passo 1.5 — Misure · M

- Migrazione `0015`, tabella `context_calls`: ordine usato, promemoria, quote, **tempo al primo token**,
  **token di ragionamento** (stimati dal testo di ragionamento; Ollama non li dà separati), tipo di posto
  «sistema».
- `src/main/chat.ts`: tempo al primo token misurato sul primo frammento ricevuto (ragionamento o risposta).
- **Posto «sistema»**: funzione pura che legge template e Modelfile del modello (già richiesti a Ollama) e
  restituisce `dedicato` · `fuso` · `non determinabile` (quest'ultimo quando c'è un formattatore interno,
  es. `RENDERER gemma4`).
- **Test**: registrazione dei nuovi campi; riconoscimento su template noti (Llama 3, Qwen, Gemma 3) e sul
  Modelfile di `gemma4:e4b`.
- **Fatto quando**: ogni chiamata registrata porta ordine, tempi e tipo di sistema.

### Passo 1.6 — Interfaccia · M

- Impostazioni: nuova scheda **«Contesto»** (la scheda Generale è già lunga):
  - Ordine: Automatico · A · B · C, con una riga di spiegazione ciascuno;
  - Promemoria del ruolo: Automatico · Acceso · Spento;
  - Quote dei tre blocchi (tre valori che sommano a 100) e quota della Situazione.
- Monitor del contesto: per ogni chiamata, ordine, tempo al primo token, tempo di valutazione del prompt, tipo
  di sistema, token di ragionamento.
- **Export CSV** delle chiamate di una conversazione.
- Testi in italiano, inglese, francese.
- **Test**: end-to-end — cambiare ordine dalle Impostazioni, mandare una domanda, ritrovare l'ordine nel
  monitor; export.
- **Fatto quando**: l'ordine si cambia e si legge senza toccare file o codice.

### Passo 1.7 — Prova del riuso con Ollama vero · S

Qui non c'è Ollama: la prova la esegui tu.

- `scripts/cache-probe.mjs`: manda due domande consecutive sulla stessa conversazione, in ordine A e in ordine
  B, e stampa per ciascuna `prompt_eval_count`, tempo di valutazione e tempo al primo token.
- Risponde alle due domande aperte: cosa conta `prompt_eval_count`, e quanto si risparmia davvero con B.
- Se `prompt_eval_count` conta solo i token nuovi, va corretto l'indicatore «Contesto» dell'app, che oggi lo
  usa come occupazione totale: lo verifico e, se serve, lo sistemo in questo passo.
- **Fatto quando**: hai eseguito lo script con `gemma4:e4b` e abbiamo i numeri.

### Passo 1.8 — Chiusura della prima consegna · S

- Typecheck, test unitari, end-to-end completo, schermate di anteprima.
- `docs/ruoli.md` e `docs/base-di-conoscenza.md` aggiornati; README.
- **Protocollo di prova** scritto in `docs/ruoli.md`: conversazione di 30–40 scambi, stesso insieme di domande,
  tre ordini, con e senza promemoria; cosa guardare nel CSV.

⏸ **Controllo 2** — consegna pronta sul branch. Tu fai i test di qualità e velocità. Decidi se rilasciarla da
sola (versione intermedia) o aspettare i ruoli.

---

## Seconda consegna — ruoli

**Obiettivo**: scegliere «Parla con un…», calibrare il ruolo con i suoi parametri, scrivere la Situazione;
installare ruoli dallo Store nella propria lingua.

### Passo 2.1 — Il ruolo come dato · M

- `src/shared/roles.ts`: tipi (`Role`, `RoleParameter`, `RoleOption`, `RoleMind`, `RoleProfile`) e funzioni
  pure:
  - **validazione**: sezioni ammesse, un solo parametro per impostazione della mente (D12), opzioni e
    predefiniti coerenti;
  - **calcolo della mente** (D13);
  - **composizione delle istruzioni** dalle scelte, nell'ordine delle sezioni;
  - **scelta del profilo** per il modello in uso e precedenza (D28, D29).
- **Test**: ruoli validi e non validi; mente con e senza ritocchi manuali; istruzioni per varie combinazioni;
  profilo più specifico; modello senza profilo.
- **Fatto quando**: i due ruoli di base, scritti come JSON di prova, passano la validazione e producono le
  istruzioni attese di `ruoli.md` §7.

### Passo 2.2 — Dati e conversione · M

- Migrazione `0016`:
  - tabella `roles` (id, pacchetto, gruppo, lingua, nome, versione, definizione, origine);
  - `conversations` e `brief_templates`: `role_id`, `role_params`, `mind_overrides`, `situation`.
- **Conversione** (D22): i quattro campi del Brief confluiscono in `situation` con i loro titoli; conversazioni
  e template passano al Generalista. I vecchi campi restano nel database per una versione, non più letti.
- Generalista creato all'avvio se manca.
- **Test**: conversione di Brief pieni, parziali, vuoti; template; il system prompt di una conversazione
  convertita è **identico** a quello di prima.
- **Fatto quando**: un database della versione attuale si apre, converte, e risponde come prima.

### Passo 2.3 — Il ruolo nel prompt · M

- Istruzioni del ruolo + Situazione al posto del Brief, attraverso il compositore.
- Limite della Situazione (D21).
- Promemoria: campo `reminder` del ruolo; se manca, la prima frase delle istruzioni.
- Testi dell'app per il modello nella lingua del ruolo (D32): titoli dei blocchi, stile, riassunto, piano.
- Comportamento ed esempi del ruolo collegati alla conversazione con il loro tipo.
- **Test**: prompt completo per un ruolo con parametri, situazione e basi, nei tre ordini; ruolo francese con
  interfaccia italiana.

### Passo 2.4 — Pacchetti · M

- `src/main/knowledge/pack.ts`: tipo `identity` (`role.json`), campo `group`, profili.
- Installazione: ruolo + basi richieste; rimozione con controllo d'uso delle basi; aggiornamento.
- Ruoli integrati installati all'avvio, come la Guida.
- Base richiesta mancante: avviso non bloccante all'apertura della conversazione.
- **Test**: installazione con dipendenze; ruolo non valido rifiutato; firma e impronta; base mancante.

### Passo 2.5 — Interfaccia dei ruoli · L

- Barra laterale: menu **«Parla con un…»** (ruoli, poi template); «Nuova conversazione» = Generalista.
- Scheda del modello: ruolo in testa; controlli della mente; quattro sezioni di parametri generate dalla
  definizione; nota accanto alle opzioni che toccano la mente; avviso «non verificato con questo modello».
- Scheda **«Situazione»** al posto del Brief: campo, contatore, anteprima delle istruzioni.
- Cambio ruolo: libero se vuota; altrimenti «Nuova conversazione con…» con il riassunto (D23).
- Scheda «Conoscenza»: comportamento ed esempi come parte del ruolo, in sola lettura; pill e bottone libro solo
  per i documenti; valore di partenza dal ruolo.
- Template ed export della conversazione con ruolo, scelte e situazione.
- **Test**: end-to-end su ogni punto.

⏸ **Controllo 3** — ti mostro le schermate prima di passare allo Store.

### Passo 2.6 — Store · M

- Catalogo: varianti per lingua raggruppate (`group`).
- Scheda unica con scelta della lingua; ricerca su tutte le varianti; filtro per lingua (D33).
- Ruoli installabili; «ciò che è dello Store entra ed esce dallo Store» esteso ai ruoli.
- **Test**: raggruppamento, ricerca multilingua, filtro, installazione di una variante.

### Passo 2.7 — Contenuti · L

- Assistente di FastChat (IT, FR): base di comportamento, Guida ampliata e tradotta.
- Esperto di prompt engineering (IT, FR): base di comportamento, base di esempi.
- `scripts/build-packs.mjs`: costruisce i pacchetti dei ruoli e aggiorna il catalogo.
- Profili per `gemma4:*` compilati con i risultati dei tuoi test della prima consegna.

⏸ **Controllo 4** — rileggi i testi dei ruoli (istruzioni, frasi, manuali, esempi, francese).

### Passo 2.8 — Chiusura della seconda consegna · M

- Typecheck, test unitari, end-to-end completo, schermate.
- Documentazione aggiornata; README.

⏸ **Controllo 5** — tutto sul branch; release solo con il tuo ok.

---

## 2.2bis Stato dei passi

| Passo | Stato | Note |
|---|---|---|
| 1.0 Rete di sicurezza | Fatto | `tests/compose.test.ts`: fotografie dei messaggi inviati oggi |
| 1.1 Impostazioni | Fatto | `AppSettings.context` |
| 1.2 Compositore | Fatto | `src/shared/compose.ts` |
| 1.3 Nella chat | Fatto | Con le impostazioni predefinite i messaggi sono identici a prima |
| 1.4 Tre tipi di base | Fatto | Migrazione 0014; selettore dell'uso sulla base collegata |
| 1.5 Misure | Fatto | Migrazione 0015; due test esistenti aggiornati con i campi nuovi |
| 1.6 Interfaccia | Fatto | Impostazioni → Contesto; monitor; export CSV |
| 1.7 Prova con Ollama | **Da eseguire dall'utente** | `node scripts/cache-probe.mjs --model gemma4:e4b` |
| 1.8 Chiusura | Fatto | Documentazione e protocollo di prova |
| 2.1 Il ruolo come dato | Fatto | `src/shared/roles.ts`, `tests/roles.test.ts`, ruoli di prova in `tests/fixtures/roles/` |
| 2.2 Dati e conversione | Fatto | Migrazione 0016; Generalista e conversione dei Brief all'avvio (`ensureRoles`) |
| 2.3 Il ruolo nel prompt | Fatto | `rolePrompt`, lingua del ruolo (`src/main/promptLocale.ts`), `linkRole`; un test end-to-end aggiornato |

Scelte fatte nel passo 2.1:

- **Un «ruolo» nel codice è il contenuto di `role.json`**; nome, lingua e gruppo stanno nel manifesto del
  pacchetto (passo 2.4).
- **Lunghezza della risposta**: i valori sono quelli dell'app (Essenziale, Conciso, Normale, Esteso). Dove
  `ruoli.md` diceva «Sintetico» ora dice «Conciso».
- **Vince l'ultima azione**: i ritocchi manuali vincono sempre nel calcolo; quando l'utente cambia la scelta di
  un parametro, decadono i ritocchi sulle impostazioni che quel parametro governa (`releaseOverrides`, da
  chiamare nell'interfaccia al passo 2.5).
- **Profilo e opzioni**: la mente del profilo sostituisce i valori base del ruolo; le opzioni scelte vincono sul
  profilo.
- **Un'opzione può toccare** temperatura, top-p, ragionamento, plan mode, stile, memoria. Non il modello né la
  pill dei documenti (D15).
- **Quote del profilo**: nelle Impostazioni le quote non hanno ancora il valore «Automatico». Per ora valgono
  quelle del profilo finché nelle Impostazioni restano le predefinite (20/20/60). Da rivedere con l'interfaccia.

Scelte fatte nel passo 2.2:

- **La conversione avviene all'avvio, nel codice** (`convertBriefs`), non nella migrazione: i titoli dei quattro
  campi dipendono dalla lingua dell'interfaccia. Si esegue una volta sola: fa fede `role_id` nullo.
- **I titoli restano nella lingua del momento della conversione.** Prima seguivano la lingua dell'interfaccia a
  ogni domanda; dopo sono testo dell'utente.
- **Per il Generalista la situazione entra nel prompt senza un titolo suo**: così il prompt è identico a prima.
  Se metterlo per gli altri ruoli si decide al passo 2.3.
- **Scheda Brief fino al passo 2.5**: l'utente aveva scelto di lasciarla senza effetto. Al passo 2.3 è emerso
  che l'end-to-end scrive il Brief dalla scheda in molte prove e si ferma al primo errore: senza effetto sarebbe
  rimasto inutilizzabile per due passi. Per questo `updateConversation` rigenera la situazione quando cambiano
  i quattro campi (poche righe, marcate «transitorio»). **Da togliere al passo 2.5**, con la scheda Brief.
- Le conversazioni e i template nuovi nascono sul Generalista; un template salva anche ruolo, scelte, ritocchi
  e situazione.

Scelte fatte nel passo 2.3:

- **Titolo «# Situazione»** solo quando il ruolo ha istruzioni; per il Generalista la situazione entra senza
  titolo (prompt identico a prima).
- **La mente non si tocca in questo passo**: temperatura, stile e ragionamento restano quelli salvati nella
  conversazione. Il ruolo li imposterà alla scelta del ruolo e delle opzioni (passo 2.5).
- **Lingua del ruolo**: i testi per il modello (chiavi `prompt.*`, sezioni di conoscenza e memoria) seguono la
  lingua del ruolo per tutta la chiamata, anche con più conversazioni insieme; errori e interfaccia no. Vale
  anche per riassunto e titolo. Una lingua che l'app non conosce (es. tedesco) usa i testi dell'interfaccia.
- **Promemoria**: campo `reminder` del ruolo, altrimenti la prima frase delle istruzioni. Il Generalista non ne
  ha: con il promemoria acceso e un vecchio Brief non compare più nulla accanto alla domanda.
- **Ordine C con un vecchio Brief**: tutto il Brief è situazione e resta nel sistema (prima Ruolo, Obiettivi e
  Vincoli andavano accanto alla domanda).
- **Monitor e indicatore del contesto**: «Istruzioni» e «Situazione» sono voci distinte; il Brief convertito
  compare come «Situazione».
- **Un ruolo che non c'è più** (pacchetto rimosso) vale il Generalista: resta la situazione.
- **Limite della situazione** (`situationLimit`): calcolato, non applicato al prompt. Servirà al contatore della
  scheda nuova.
- **Basi del ruolo** (`knowledge.linkRole`): collegate alla creazione della conversazione con il loro tipo;
  quelle non installate sono restituite, per l'avviso del passo 2.4.

Scoperte durante il lavoro:

- **Riuso con l'ordine B**: non è «solo l'ultima domanda». Gli estratti viaggiano con la domanda corrente; alla
  domanda successiva quella precedente torna al suo testo, quindi Ollama riusa tutto fino allo scambio prima e
  ricalcola l'ultimo scambio più la nuova domanda. Con A ricalcola l'intera conversazione.
- **Titolo «# Domanda»**: negli ordini B e C (e con il promemoria) la domanda è preceduta da un titolo che la
  separa dal materiale. Se non c'è nulla da accompagnare la domanda resta com'è.
- L'app aveva già un messaggio nel monitor per il caso in cui Ollama conta meno token della stima («ha riusato
  la cache»): la prova 1.7 dirà se è ciò che accade davvero.

## 2.3 Ordine e dipendenze

```
1.0 → 1.1 → 1.2 → 1.3 ⏸ → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 ⏸
                                                     │
2.1 → 2.2 → 2.3 → 2.4 → 2.5 ⏸ → 2.6 → 2.7 ⏸ → 2.8 ⏸
```

- 1.4 (tipi di base) e 1.5 (misure) sono indipendenti tra loro: l'ordine si può invertire.
- 2.7 (contenuti) dipende dai risultati dei test della prima consegna per i profili; il resto no.

## 2.4 Fuori da questo piano

- Editor dei ruoli e ruoli creati dall'utente.
- Sistema di valutazione dei ruoli (domande di prova, criteri, confronto automatico).
- Pagamenti e licenze; repository remoto dello Store.
- Plugin connettori esterni.

## 2.5 Rischi principali

| Rischio | Dove | Contromisura |
|---|---|---|
| Regressione nella composizione dei messaggi | 1.2, 1.3 | Fotografie del passo 1.0; test esistenti senza ritocchi |
| Conversione dei Brief che cambia il comportamento | 2.2 | Test: system prompt identico prima e dopo |
| Il risparmio dell'ordine B non si verifica con il modello reale | 1.7 | Si misura prima di costruirci sopra i profili |
| Interfaccia dei ruoli troppo carica | 2.5 | Controllo 3 sulle schermate |
| Qualità dei testi dei ruoli | 2.7 | Controllo 4 |

---

# Parte 3 — Passaggio di consegne (per riprendere in una nuova sessione)

## Dove siamo

- **Prima consegna**: fatta e rilasciata nella **0.1.22** (passi 1.0–1.8). `main` e il branch
  `claude/contesto-parametri-effettivi` coincidono, salvo questo documento.
- **Seconda consegna** (ruoli): fatti i **passi 2.1** (il ruolo come dato), **2.2** (dati e conversione dei
  Brief) e **2.3** (il prompt nasce da ruolo e situazione). Non c'è ancora modo di scegliere un ruolo dall'app.
  Si prosegue dal **passo 2.4**.

## Cosa manca dalla prima consegna

- **Prova con Ollama vero** (passo 1.7): l'utente deve eseguire `node scripts/cache-probe.mjs --model gemma4:e4b`
  e riportare la tabella. Dice se `prompt_eval_count` conta solo i token nuovi e quanto si risparmia con
  l'ordine B. Finché non c'è, i predefiniti restano: ordine A, promemoria spento, quote 20/20/60, situazione 5%.
- **Trascinamento dei bordi** della barra della memoria: verificato solo da tastiera nei test automatici.
- **Test instabile** «finestra piccola» dell'end-to-end: fallisce circa una volta su dieci (topbar a −48 px dopo
  la rotella). Non dipende dai ruoli; potrebbe essere un vero difetto di impaginazione. Da indagare a parte.

## Punti ancora da confermare con l'utente

- Tag del modello consigliato per l'Esperto di prompt engineering (`gemma4:12b` non verificato; l'utente ha
  `gemma4:e4b`).
- Promemoria del ruolo: nelle prove brevi con Gemma 4 il ruolo regge senza. Decidere dopo prove lunghe se
  tenerlo nell'interfaccia.
- Riga «Riassunto di una conversazione avuta con: *ruolo precedente*» al cambio di ruolo: opzione da provare.

## Come lavora l'utente (preferenze espresse)

- Scrive in italiano; vuole risposte **schematiche e brevi**.
- **Il piano prima del codice.** Per le decisioni: **una domanda per volta**, con una raccomandazione.
- **Non contraddire un comportamento esistente senza chiederlo prima.** Ogni novità parte spenta o identica al
  comportamento attuale, e va dichiarata.
- Per l'interfaccia: **anteprima prima di realizzare**; interfaccia semplice e guidata, compatta, senza
  scorrimento dove si può.
- Bozze dei contenuti (testi dei ruoli, francese) vanno fatte rileggere.
- **Nessuna release senza conferma esplicita. Nessuna pull request se non richiesta.**
- Le chiavi private di firma dei pacchetti non vanno mai nel repository.

## Comandi

| Cosa | Comando |
|---|---|
| Typecheck | `npm run typecheck` |
| Test unitari (329) | `npx vitest run` |
| End-to-end | `npm run build && xvfb-run -a node e2e/run.mjs` |
| Schermate di anteprima | `xvfb-run -a node e2e/preview.mjs` (in `test-results/preview/`) |
| Pacchetti e catalogo dello Store | `npm run packs:build` |
| Nuova migrazione | `npx drizzle-kit generate --name <nome> < /dev/null` |

- Commit in italiano, uno per passo del piano.
- Release: push del branch su `main` in fast-forward, poi workflow `release.yml` con l'input `version`.
- Variabili per i test: `FASTCHAT_KNOWLEDGE_FILES`, `FASTCHAT_PACK_FILE`, `FASTCHAT_PACK_EXPORT`,
  `FASTCHAT_CONTEXT_EXPORT`, `FASTCHAT_LANG`, `FASTCHAT_USER_DATA`, `OLLAMA_URL`.

## File da conoscere per la seconda consegna

| File | Cosa contiene |
|---|---|
| `src/shared/roles.ts` | Il ruolo come dato: validazione, istruzioni, mente, profili (passo 2.1) |
| `src/shared/compose.ts` | Compositore del contesto, ordini, promemoria, rilevamento del posto «sistema» |
| `src/main/chat.ts` | `composeChat`, `buildRequest`: dove entrano istruzioni, estratti e impostazioni |
| `src/shared/prompt.ts` | `buildRolePrompt` (istruzioni, situazione, stile); `buildSystemPrompt` resta per il Brief e la conversione |
| `src/main/promptLocale.ts` | Lingua dei testi per il modello durante una chiamata |
| `src/main/knowledge/index.ts` | `recallAll`, tipi di base (`purpose`), pacchetti |
| `src/main/knowledge/pack.ts`, `src/main/store.ts`, `src/shared/store.ts` | Formato `.fcpack`, Store, catalogo |
| `src/renderer/src/components/BriefPanel.tsx`, `ModelSettings.tsx`, `Sidebar.tsx` | Brief, mente, menu dei template |
| `src/renderer/src/components/ContextSettingsPanel.tsx` | Scheda Impostazioni → Contesto |
| `tests/compose.test.ts` | Fotografie dei messaggi: devono restare verdi |

## Messaggio di apertura suggerito per la nuova sessione

> Riprendiamo il progetto dei ruoli di FastChat. Leggi `docs/ruoli.md` e `docs/ruoli-piano.md` (soprattutto la
> Parte 3). La prima consegna è rilasciata; partiamo dalla seconda, passo 2.1. Prima di scrivere codice dimmi in
> breve cosa farai nel passo e aspetta il mio ok.
