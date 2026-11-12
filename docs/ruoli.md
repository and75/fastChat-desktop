# Ruoli: idea e piano di realizzazione

Stato: **decisioni prese, codice non ancora scritto.** Il piano ha passato due revisioni esterne; le loro
osservazioni accolte sono integrate nel testo (riepilogo in Appendice B). Questo documento fissa l'idea, le decisioni prese e
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
| 1 | Parametri | Ogni ruolo definisce **i suoi**, consolidati per quel mestiere. Non esiste un elenco comune. Si mostrano in **quattro sezioni fisse**, uguali per tutti i ruoli (§3.2). |
| 2 | Effetto di un'opzione | Ogni opzione porta una **frase di istruzione** e può anche **modificare la mente** (es. temperatura). Due opzioni attive insieme **non toccano mai la stessa impostazione**. |
| 3 | Brief | Diventa **Situazione**: un solo campo libero, con limite di caratteri legato al contesto del modello. |
| 4 | Brief esistenti | **Convertiti** in Situazione (i quattro campi con i loro titoli), sul ruolo Generalista. |
| 5 | Ordine del contesto | **Parametrizzabile** nelle Impostazioni (tre ordini), per fare test di qualità e velocità. |
| 6 | Basi | **Tre tipi** (comportamento, esempi, documenti) con **quote regolabili** nelle Impostazioni. **Comportamento ed esempi sono sempre attivi**: fanno parte del ruolo. I **documenti restano opzionali** come oggi (pill e bottone libro); il ruolo può solo fissare il valore di partenza. |
| 7 | Cambio di ruolo | Solo a **conversazione vuota**. Altrimenti si propone una **nuova conversazione** che parte dal **riassunto** della precedente. Da provare: indicare nel riassunto il ruolo precedente. |
| 8 | Template | Restano: una conversazione si salva come template (ruolo, scelte, situazione, mente). |
| 9 | Editor dei ruoli | **Dopo.** Nella prima versione solo ruoli installati (inclusi nell'app, Store). |
| 10 | Lingue | Un ruolo è **pensato in una lingua**, coerente con le sue basi. Lo stesso ruolo esiste in più lingue come **varianti**. |
| 11 | Store | **Scheda unica** per ruolo o base con scelta della lingua; **ricerca per titolo in tutte le lingue**; **filtro per lingua**. |
| 13 | Interfaccia | **Semplice e guidata** per chi non è esperto, con tutto ciò che serve a chi vuole regolare: quattro sezioni di parametri sempre visibili, sotto i controlli del modello. |
| 14 | Modelli | L'**app resta universale**: nessuna regola legata a un modello nel codice. È il **ruolo** a dichiarare, per uno o più modelli, come va composto il contesto e con quali valori (profili per modello, §3.5). I profili nascono da **valutazioni** fatte da chi crea il ruolo. |
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

I parametri sono ciò che oggi l'utente scrive a mano nel Brief (Ruolo, Obiettivi, Vincoli), trasformato in
**scelte guidate**. Il Contesto del Brief non entra qui: diventa la Situazione (§4.1).

#### Quattro sezioni fisse, contenuto proprio del ruolo

Le **sezioni sono le stesse per tutti i ruoli** e sono sempre visibili; i **parametri e le opzioni dentro ogni
sezione li scrive il ruolo**. Una sezione senza parametri non si vede.

| Sezione | Contiene | Dal Brief |
|---|---|---|
| **1. Identità e obiettivi** | Chi è il ruolo, in cosa è specializzato, cosa deve ottenere | Ruolo, Obiettivi |
| **2. Stile e formato** | Pubblico, tono, struttura e lunghezza della risposta | Vincoli |
| **3. Regole e fonti** | Come usa le fonti, tecniche da applicare, limiti, cosa fa quando non sa | Vincoli |
| **4. Metodo** | Come procede prima di rispondere (chiarimenti, ragionamento, piano) | (nuovo) |

Perché sezioni fisse:

- **Interfaccia coerente**: l'utente ritrova la stessa struttura in ogni ruolo, con contenuti diversi.
- **Ordine naturale nel prompt**: le frasi seguono l'ordine delle sezioni.
- **Poche intestazioni**: quattro al massimo, anche per un ruolo ricco.

Dentro una sezione, ogni parametro può dichiarare un **tipo di vincolo** (`kind`: pubblico, formato, tono,
fonti, limiti, tecniche…). È un'etichetta facoltativa: serve a ordinare i parametri nella sezione e, in futuro,
all'editor dei ruoli. Non crea intestazioni.

#### Definizione di un parametro

| Campo | Significato |
|---|---|
| `id` | Identificatore stabile (per salvare la scelta) |
| `section` | `identity` · `style` · `rules` · `method` |
| `kind` | Facoltativo: tipo di vincolo (`audience`, `format`, `tone`, `sources`, `limits`, `techniques`…) |
| `label` | Nome mostrato all'utente, nella lingua del ruolo |
| `type` | `single` (scelta singola), `multi` (scelta multipla), `toggle` (sì/no) |
| `options[]` | Le opzioni proposte |
| `options[].label` | Nome dell'opzione |
| `options[].instruction` | Frase che entra nelle istruzioni del ruolo quando l'opzione è scelta |
| `options[].mind` | Facoltativo: valori della mente che l'opzione imposta (es. `{ "temperature": 0.3 }`) |
| `default` | Opzione o opzioni preselezionate |

#### Regole

- **Istruzioni del ruolo** = testo fisso del ruolo (`instructions`) + frasi delle opzioni scelte, nell'ordine
  delle sezioni e, dentro la sezione, dei parametri.
- **Nessun conflitto sulla mente**: in tutto il ruolo, **al massimo un parametro** può toccare una data
  impostazione (es. `temperature`). Le opzioni alternative di una scelta singola possono impostare valori
  diversi della stessa impostazione, perché ne è attiva una sola; in una scelta multipla al massimo **una**
  opzione può toccarla. Un ruolo che viola la regola è rifiutato alla costruzione del pacchetto e
  all'installazione.
- **Calcolo della mente**: valori base del ruolo (`mind`) → effetti delle opzioni scelte → ritocchi manuali
  dell'utente. Deselezionando un'opzione il valore torna a quello base del ruolo.
- **Vince l'ultima azione**: un ritocco manuale vale finché l'utente non cambia l'opzione che governa quello
  stesso valore.
- Un'opzione che tocca la mente lo **dichiara** nell'interfaccia («imposta la temperatura a 0,3»).
- Un `toggle` è un `single` con due opzioni (`on`/`off`): anche lo stato spento può avere frase ed effetto.
- **Frasi che convivono**: la regola sopra protegge le *impostazioni*, non le *frasi*. Perché due frasi non si
  contraddicano, l'autore le scrive **in forma condizionale** quando serve («Quando scrivi o riscrivi un prompt,
  specifica il formato esatto…» invece di «Specifica il formato esatto…»). Niente dipendenze tra parametri nel
  formato.
- I parametri **non** accendono né spengono le basi e non toccano le quote della conoscenza (§3.3).

#### Nell'interfaccia

Scheda del modello: in alto il ruolo e i controlli della mente, come oggi; sotto, le quattro sezioni con menu a
tendina (scelta singola), caselle (scelta multipla), interruttore (sì/no).

### 3.3 Basi del ruolo

| Tipo | Contenuto | Istruzione al modello | Fonti citate | Chi decide se è attiva |
|---|---|---|---|---|
| **Comportamento** | Manuali, tecniche, regole del mestiere | «Applica queste tecniche» | No | **Il ruolo: sempre attiva** |
| **Esempi** | Coppie richiesta → risposta ben fatta (few-shot) | «Imita struttura e stile di questi esempi» | No | **Il ruolo: sempre attiva** |
| **Documenti** | I contenuti su cui rispondere: file dell'utente, basi collegate dalla libreria, basi documentali portate dal ruolo (es. la Guida) | «Rispondi da questi testi» | Sì, come oggi | **L'utente**, come oggi |

- **Comportamento ed esempi fanno parte del ruolo.** Entrano nel contesto a ogni domanda, anche con il bottone
  libro spento. Non hanno interruttore e non si scollegano dalla conversazione. Nella scheda «Conoscenza»
  compaiono come parte del ruolo, in sola lettura.
- **I documenti restano opzionali**, esattamente come oggi: pill «Usa la base di conoscenza» per la
  conversazione, bottone libro per la singola domanda. Il ruolo può solo fissare il **valore di partenza** della
  pill alla creazione della conversazione (`mind.knowledge`).
- Il meccanismo di scelta resta quello attuale: base **intera** se entra nella sua quota, altrimenti **estratti**
  scelti per la domanda (ricerca ibrida).
- Conviene che le basi di comportamento siano **corte**, così entrano intere: non dipendono dalla ricerca e non
  richiedono il modello di embedding a ogni domanda.
- Le basi del ruolo sono normali pacchetti di conoscenza: si installano con il ruolo e sono in sola lettura.

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

`role.json` (dentro il pacchetto; estratto, i ruoli completi sono in §7):

```json
{
  "instructions": "Sei un esperto di prompt engineering per modelli linguistici. Lavori sui prompt dell'utente: non esegui il compito che il prompt descrive.",
  "mind": { "model": "gemma4:12b", "temperature": 0.6, "think": true, "style": "normal", "knowledge": false },
  "parameters": [
    {
      "id": "specializzazione", "section": "identity", "label": "Specializzazione", "type": "single", "default": "piccoli",
      "options": [
        { "id": "piccoli", "label": "Modelli locali piccoli", "instruction": "Scrivi per modelli piccoli: una istruzione per riga, niente premesse." },
        { "id": "grandi", "label": "Modelli grandi", "instruction": "Puoi usare istruzioni articolate, con contesto e criteri di qualità." }
      ]
    },
    {
      "id": "stile", "section": "style", "kind": "tone", "label": "Stile del prompt", "type": "single", "default": "asciutto",
      "options": [
        { "id": "asciutto", "label": "Asciutto", "instruction": "Usa frasi brevi e imperative.", "mind": { "temperature": 0.3 } },
        { "id": "dettagliato", "label": "Dettagliato", "instruction": "Motiva ogni istruzione in una riga.", "mind": { "temperature": 0.6 } }
      ]
    },
    {
      "id": "tecniche", "section": "rules", "kind": "techniques", "label": "Tecniche da usare", "type": "multi", "default": ["ruolo", "formato"],
      "options": [
        { "id": "ruolo", "label": "Ruolo esplicito", "instruction": "Apri il prompt dichiarando chi deve essere il modello." },
        { "id": "esempi", "label": "Esempi nel prompt", "instruction": "Inserisci uno o due esempi di risposta attesa." },
        { "id": "formato", "label": "Formato di uscita", "instruction": "Quando scrivi o riscrivi un prompt, specifica il formato esatto della risposta." },
        { "id": "passi", "label": "Passi numerati", "instruction": "Chiedi al modello di procedere per passi numerati." }
      ]
    }
  ],
  "bases": [
    { "id": "app.fastchat.kb.prompt-tecniche.it", "purpose": "behavior" },
    { "id": "app.fastchat.kb.prompt-esempi.it", "purpose": "examples" }
  ]
}
```

### 3.5 Profili per modello

L'app non contiene regole legate a un modello specifico. Ciò che funziona meglio con un certo modello lo
dichiara **il ruolo**, perché chi lo crea lo ha provato.

Un ruolo può portare uno o più **profili**, ciascuno valido per un modello o una famiglia:

```json
"profiles": [
  {
    "models": ["gemma4:*"],
    "verified": true,
    "mind": { "temperature": 0.4 },
    "context": { "order": "B", "reminder": true, "shares": { "behavior": 0.25, "examples": 0.25, "documents": 0.5 } }
  },
  {
    "models": ["llama3.2:*", "qwen3:*"],
    "verified": true,
    "context": { "order": "A", "reminder": false }
  }
]
```

| Campo | Significato |
|---|---|
| `models` | Nomi o famiglie a cui il profilo si applica (`gemma4:*`, `gemma4:e4b`) |
| `verified` | Il ruolo è stato valutato con questi modelli |
| `mind` | Valori della mente che sostituiscono quelli base del ruolo per questi modelli |
| `context` | Composizione del contesto: ordine (A/B/C), promemoria, quote dei tre blocchi |

Regole:

- **Precedenza** per ogni valore: scelta forzata dall'utente nelle Impostazioni (per i test) → profilo del
  ruolo per il modello in uso → valori base del ruolo → predefiniti dell'app.
- Nelle Impostazioni, ordine e quote hanno il valore **«Automatico (decide il ruolo)»**, predefinito; scegliere
  un valore esplicito lo impone a tutte le conversazioni ed è lo strumento per fare i confronti.
- Se il modello in uso **non ha un profilo**, valgono i valori base del ruolo e compare un avviso non bloccante:
  «Ruolo non verificato con questo modello».
- Il profilo più specifico vince (`gemma4:e4b` su `gemma4:*`).
- Il Generalista non ha profili: usa i predefiniti dell'app e del modello.

**Da dove vengono i profili.** Da valutazioni fatte da chi crea il ruolo: stesse domande, modelli e
composizioni diverse, confronto di qualità e velocità. Gli strumenti della prima consegna (ordine
parametrizzabile, monitor, export) sono il banco di prova manuale; un sistema di valutazione vero e proprio
(insieme di domande del ruolo, criteri, confronto automatico) arriva con l'editor dei ruoli.

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

**Ordine C — anche il ruolo accanto alla domanda** (diagnostico)

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

L'ordine C non dà vantaggi di riuso rispetto al B: resta come opzione di prova, utile soprattutto con i modelli
che non hanno un posto dedicato per il sistema (vedi sotto).

**Promemoria del ruolo** (sì/no, indipendente dall'ordine): una riga breve con l'essenziale del ruolo, accanto
alla domanda. Serve a tenere il ruolo nelle conversazioni lunghe senza toglierlo dal system prompt.

**Il posto «sistema» dipende dal modello.** Alcuni modelli hanno un posto dedicato per il messaggio di sistema;
altri (es. Gemma 2 e 3) lo incollano in testa al primo messaggio dell'utente. L'informazione sta nel template di
chat, che Ollama espone. Per i modelli più recenti però Ollama compone il testo con un formattatore interno
(`RENDERER` nel Modelfile, template ridotto a `{{ .Prompt }}`): è il caso di `gemma4`, per cui il dato **non è
leggibile**. L'app quindi rileva «dedicato / fuso / non determinabile» e lo mostra nel monitor; per i modelli
non determinabili decidono i test. Controllo definitivo a mano: Ollama avviato con `OLLAMA_DEBUG=1` scrive nel
log il prompt composto.

Note:

- Quando i documenti sono spenti (pill o bottone libro), il loro blocco non c'è; comportamento ed esempi restano.
- Con B e C conoscenza, promemoria e domanda sono **un solo messaggio `user`**, composto al momento dell'invio:
  mai due messaggi `user` di seguito (molti modelli locali li gestiscono male). In database resta solo il testo
  scritto dall'utente.
- Gli esempi sono racchiusi in delimitatori netti (es. `<esempio>…</esempio>`) e l'istruzione del blocco dice
  di imitarne forma e stile, non di copiarne il contenuto.
- **Quanto si riusa davvero con B e C**: gli estratti viaggiano solo con la domanda *corrente*. Alla domanda
  successiva la domanda precedente torna al suo testo originale, quindi Ollama riusa tutto fino allo scambio
  prima e ricalcola **l'ultimo scambio** (domanda e risposta precedenti) più la nuova domanda con i suoi
  estratti. Con A ricalcola invece l'intera conversazione. Verificato dai test (`tests/compose.test.ts`).
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

- Lo spazio non usato da un blocco (base assente, piccola, o documenti spenti) passa agli altri, nell'ordine
  documenti, esempi, comportamento. Così un ruolo centrato sui documenti e uno centrato su tecniche ed esempi
  usano bene lo spazio senza regolazioni.
- La quota complessiva resta quella della conversazione (25/50/75%).
- I valori iniziali sono da confermare con i test.

### 5.5 Lingua dei testi scritti dall'app

I testi che l'app aggiunge per il modello (titoli dei blocchi, istruzione di stile, prompt del riassunto) oggi
seguono la lingua dell'interfaccia. Con i ruoli seguono **la lingua del ruolo**, per non mandare prompt misti.
Il Generalista non ha lingua propria e continua a seguire l'interfaccia.

---

### 5.6 Come provare (prima consegna)

Tutto si fa dall'app, senza toccare file.

**Strumenti**

- **Impostazioni → Contesto**: ordine dei blocchi (Automatico, A, B, C), promemoria del ruolo, quote dei tre
  tipi di base. Vale dalla domanda successiva, anche in una conversazione già avviata.
- **Scheda Conoscenza → base collegata → uso**: Documenti, Comportamento, Esempi. È il modo di provare le basi
  del ruolo prima che i ruoli esistano.
- **Monitor del contesto** (scheda Modello → dettaglio delle chiamate): per ogni chiamata, ordine usato,
  promemoria, tipo di posto «sistema», tempo al primo frammento, tempi di Ollama, token per voce.
- **Esporta CSV**: una riga per chiamata, colonne fisse (`order`, `first_token_ms`, `prompt_eval_ms`,
  `prompt_eval_count`, `part_*`…).
- **`node scripts/cache-probe.mjs --model <modello>`**: misura fuori dall'app quanto si riusa con A e con B, e
  dice se `prompt_eval_count` conta solo i token nuovi.

**Protocollo proposto**

1. Scegli un modello e una conversazione di 30–40 scambi con un Brief compilato (o creala).
2. Prepara 5–8 domande fisse: alcune che dipendono da dettagli lontani, alcune sui documenti, una fuori tema.
3. Per ogni combinazione (A, B, C; promemoria spento e acceso) duplica la conversazione, imposta l'ordine, fai
   le stesse domande.
4. Esporta il CSV di ogni conversazione.
5. **Velocità**: confronta `first_token_ms` e `prompt_eval_ms` a parità di domanda. Scarta la prima domanda dopo
   un cambio di impostazione (rilegge tutto, in ogni ordine).
6. **Qualità**, letta a mano: il modello tiene il ruolo? usa i documenti giusti? cita le fonti? risponde nella
   lingua attesa? Annota un voto per risposta.
7. Ripeti con un secondo modello: i risultati cambiano da modello a modello, ed è per questo che finiranno nei
   profili del ruolo (§3.5).

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

I testi (istruzioni, frasi delle opzioni, manuali, esempi, traduzioni francesi) nascono come **bozza** e vanno
riletti: sono ciò che l'utente percepisce come qualità. ✓ indica l'opzione preselezionata.

### 7.1 Generalista

Nessuna istruzione, nessun parametro, nessuna base. Segue la lingua dell'interfaccia. È l'app di oggi.

### 7.2 Assistente di FastChat (IT, FR)

- **Scopo**: rispondere a domande sull'uso dell'app.
- **Mente di partenza**: `gemma4:e4b` consigliato · temperatura 0,2 · ragionamento spento · lunghezza «Sintetico».
- **Istruzione fissa**: «Sei l'assistente di FastChat. Rispondi solo a domande sull'uso dell'app, usando la
  documentazione fornita. Usa i nomi esatti di schede e pulsanti. Se una funzione non esiste, dillo.»
- **Basi**: comportamento «Come rispondere a una domanda d'uso» · documenti «Guida di FastChat» (ampliata con
  Store, ruoli, Situazione; in francese va tradotta).

| Sezione | Parametro | Tipo | Opzione | Frase per il modello | Mente |
|---|---|---|---|---|---|
| **Identità e obiettivi** | Scopo della risposta | Singola | Far fare ✓ | «Guida l'utente a compiere l'azione.» | — |
| | | | Far capire | «Spiega come funziona e perché, prima dei passi.» | — |
| **Stile e formato** | Livello | Singola | Primo utilizzo ✓ | «Spiega ogni termine la prima volta e non dare nulla per scontato.» | — |
| | | | Utente esperto | «Vai dritto al punto, senza concetti di base.» | — |
| | Formato atteso | Singola | Passo-passo ✓ | «Rispondi con passi numerati, un'azione per passo.» | lunghezza «Normale» |
| | | | Risposta breve | «Rispondi in una o due frasi.» | lunghezza «Essenziale» |
| | Percorso | Sì/No | Sì ✓ | «Indica sempre il percorso: finestra → scheda → pulsante.» | — |
| | | | No | (nessuna frase) | — |
| **Regole e fonti** | Argomenti da collegare | Multipla | Basi di conoscenza ✓ | «Quando è pertinente, collega la risposta alle basi di conoscenza.» | — |
| | | | Modelli e memoria | «Quando è pertinente, indica l'effetto su memoria e velocità.» | — |
| | | | Store e ruoli | «Quando è pertinente, segnala cosa si trova nello Store.» | — |
| | Se la Guida non lo dice | Singola | Lo dichiara ✓ | «Se la documentazione non copre la domanda, dillo e non inventare.» | — |
| | | | Propone un'alternativa | «Se la documentazione non copre la domanda, dillo e indica la funzione più vicina.» | — |

Sezione non usata: Metodo. Documenti accesi in partenza (la Guida è la sua fonte).

**Esempio di calibrazione** — Far fare · Utente esperto · Risposta breve · Percorso: Sì · Argomenti: Modelli e
memoria · Lo dichiara.

- Mente risultante: temperatura 0,2 · ragionamento spento · lunghezza «Essenziale».
- Istruzioni che riceve il modello:
  > Sei l'assistente di FastChat. Rispondi solo a domande sull'uso dell'app, usando la documentazione fornita.
  > Usa i nomi esatti di schede e pulsanti. Se una funzione non esiste, dillo.
  > Guida l'utente a compiere l'azione.
  > Vai dritto al punto, senza concetti di base.
  > Rispondi in una o due frasi.
  > Indica sempre il percorso: finestra → scheda → pulsante.
  > Quando è pertinente, indica l'effetto su memoria e velocità.
  > Se la documentazione non copre la domanda, dillo e non inventare.

### 7.3 Esperto di prompt engineering (IT, FR)

- **Scopo**: scrivere, migliorare e spiegare prompt.
- **Mente di partenza**: `gemma4:12b` consigliato (tag da confermare) · temperatura 0,6 · ragionamento acceso · lunghezza «Normale».
- **Istruzione fissa**: «Sei un esperto di prompt engineering per modelli linguistici. Lavori sui prompt
  dell'utente: non esegui il compito che il prompt descrive.»
- **Basi**: comportamento «Tecniche di prompt» (da «Scrivere buoni prompt», ampliata) · esempi «Prompt deboli e
  migliorati».

| Sezione | Parametro | Tipo | Opzione | Frase per il modello | Mente |
|---|---|---|---|---|---|
| **Identità e obiettivi** | Specializzazione | Singola | Modelli locali piccoli ✓ | «Scrivi per modelli piccoli: una istruzione per riga, niente premesse.» | — |
| | | | Modelli grandi | «Puoi usare istruzioni articolate, con contesto e criteri di qualità.» | — |
| | Intervento | Singola | Scrive da zero | «Se manca l'obiettivo chiedilo, poi scrivi il prompt completo.» | — |
| | | | Migliora ✓ | «Riscrivi il prompt dell'utente mantenendone l'intento.» | — |
| | | | Spiega cosa non va | «Non riscrivere: elenca i problemi in ordine di gravità.» | — |
| **Stile e formato** | Chi userà il prompt | Singola | Principiante ✓ | «Evita i termini tecnici nelle spiegazioni.» | — |
| | | | Esperto | «Usa pure i termini tecnici del prompt engineering.» | — |
| | Risultato | Singola | Solo il risultato | «Restituisci solo il risultato richiesto, senza commenti.» | lunghezza «Sintetico» |
| | | | Risultato con spiegazione ✓ | «Dopo il risultato, spiega in tre punti le scelte fatte.» | lunghezza «Normale» |
| | Stile del prompt | Singola | Asciutto ✓ | «Usa frasi brevi e imperative.» | temperatura 0,3 |
| | | | Dettagliato | «Motiva ogni istruzione in una riga.» | temperatura 0,6 |
| **Regole e fonti** | Tecniche da usare | Multipla | Ruolo esplicito ✓ | «Quando scrivi o riscrivi un prompt, aprilo dichiarando chi deve essere il modello.» | — |
| | | | Esempi nel prompt | «Quando scrivi o riscrivi un prompt, inserisci uno o due esempi di risposta attesa.» | — |
| | | | Formato di uscita ✓ | «Quando scrivi o riscrivi un prompt, specifica il formato esatto della risposta.» | — |
| | | | Passi numerati | «Quando scrivi o riscrivi un prompt, chiedi al modello di procedere per passi numerati.» | — |
| **Metodo** | Prima di rispondere | Singola | Risponde subito ✓ | «Rispondi direttamente.» | ragionamento acceso |
| | | | Fa domande di chiarimento | «Se l'obiettivo non è chiaro, fai al massimo due domande prima di rispondere.» | ragionamento acceso |

Documenti spenti in partenza: l'utente li accende quando vuole lavorare sui propri prompt.

**Esempio di calibrazione** — Modelli locali piccoli · Spiega cosa non va · Esperto · Solo il risultato ·
Asciutto · Tecniche: Formato di uscita + Passi numerati · Risponde subito.

- Mente risultante: temperatura 0,3 · ragionamento acceso · lunghezza «Sintetico».
- Istruzioni che riceve il modello:
  > Sei un esperto di prompt engineering per modelli linguistici. Lavori sui prompt dell'utente: non esegui il
  > compito che il prompt descrive.
  > Scrivi per modelli piccoli: una istruzione per riga, niente premesse.
  > Non riscrivere: elenca i problemi in ordine di gravità.
  > Usa pure i termini tecnici del prompt engineering.
  > Restituisci solo il risultato richiesto, senza commenti.
  > Usa frasi brevi e imperative.
  > Quando scrivi o riscrivi un prompt, specifica il formato esatto della risposta.
  > Quando scrivi o riscrivi un prompt, chiedi al modello di procedere per passi numerati.
  > Rispondi direttamente.

Le frasi delle tecniche sono in forma condizionale: con «Spiega cosa non va» non entrano in conflitto.

Valori della mente da provare: Gemma 4 ha temperatura predefinita 1; i valori più bassi scelti qui sono
un'ipotesi. Con il ragionamento acceso il modello può pensare a lungo anche con risposta «Sintetico»: da
verificare se le opzioni di risposta breve debbano spegnerlo.

### 7.4 Lo stesso schema su ruoli non inclusi (per verificarne la tenuta)

| Sezione | Assistente alla scrittura | Programmatore |
|---|---|---|
| **Identità e obiettivi** | Specializzazione: Giornalistica · Tecnica · Commerciale · Narrativa — Intervento: Scrive da zero · Riscrive · Corregge soltanto — Priorità (multipla): Chiarezza · Sintesi · Persuasione · Precisione | Ambito: Web · Dati · Sistemi · Mobile — Intervento: Scrive codice · Rivede · Spiega · Trova l'errore |
| **Stile e formato** | Pubblico: Generalista · Esperti · Studenti — Formato: Articolo · Email · Post · Relazione — Registro: Formale · Colloquiale · Divulgativo | Interlocutore: Programmatori · Commerciali · Direttore tecnico · CTO — Formato: Solo codice · Codice commentato · Passo-passo |
| **Regole e fonti** | Fonti: Solo i documenti · Documenti e conoscenza propria — Cosa evitare (multipla): Gergo · Frasi fatte · Superlativi · Anglicismi | Fonti: Solo il codice fornito · Anche librerie note — Limiti: Non inventa API · Segnala ciò che non ha potuto provare |
| **Metodo** | Scrive subito · Propone una scaletta | Risponde subito · Prima il piano, poi il codice |

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
- Tipi condivisi: `Role`, `RoleParameter`, `RoleOption`, `RoleMind`, `RoleSection` in `src/shared/roles.ts`, con le
  funzioni pure: validazione del ruolo (sezioni, un solo parametro per impostazione della mente), calcolo della mente, composizione delle
  istruzioni dalle scelte.
- Ruolo Generalista creato all'avvio se manca.
- **Test**: conversione di Brief pieni, parziali e vuoti; template; migrazione su database esistente.

#### Fase 2 · Composizione del contesto

- Nuovo modulo puro `src/shared/compose.ts`: riceve i blocchi (§5.1) e l'ordine, restituisce i messaggi e le
  parti per il monitor. Sostituisce la logica di `composeChat`, che diventa un involucro.
- I tre ordini (§5.3) e il promemoria del ruolo.
- Con B e C la conoscenza è nel messaggio dell'utente inviato a Ollama, **non** in quello salvato.
- Comportamento ed esempi entrano sempre; i documenti solo se la pill o il bottone libro lo dicono (come oggi).
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
- Rilevamento del posto «sistema» per modello (dedicato / fuso / non determinabile) dal template di Ollama,
  mostrato nel monitor.
- Token di ragionamento separati da quelli della risposta visibile. Ollama non li restituisce separati: si
  stimano dalla lunghezza del testo di ragionamento.
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
- Scheda «Modello»: intestazione con il ruolo; controlli della mente; sotto, i **parametri del ruolo**, nelle quattro
  sezioni, generati dalla definizione (select, scelta multipla, interruttore). Un'opzione che tocca la mente lo dichiara.
- Scheda «Brief» → **«Situazione»**: un campo, contatore dei caratteri, anteprima delle istruzioni che il
  modello riceverà (ruolo + situazione).
- Cambio ruolo: libero se la conversazione è vuota; altrimenti finestra «Nuova conversazione con…» che porta il
  riassunto.
- Scheda «Conoscenza»: comportamento ed esempi compaiono come parte del ruolo, in sola lettura e senza
  «Scollega»; pill e bottone libro governano solo i documenti. Il ruolo fissa il valore di partenza della pill.
- Export della conversazione: ruolo, scelte, situazione al posto del Brief.
- Testi dell'app per il modello nella lingua del ruolo (§5.5).
- **Test**: e2e su scelta del ruolo, parametri che cambiano il prompt, effetto sulla mente, cambio ruolo con
  riassunto, template.

#### Fase 5 · Pacchetti e Store

- Profili per modello (§3.5): lettura dal pacchetto, scelta del profilo per il modello in uso, precedenza,
  avviso «non verificato»; valore «Automatico (decide il ruolo)» nelle Impostazioni.

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
| Ordine C | Il modello non trova il ruolo nel posto «sistema» | Solo come opzione di prova (diagnostica) |
| Posto «sistema» | Per i modelli con formattatore interno a Ollama (es. `gemma4`) non si sa come viene trattato | Rilevamento a tre valori; decidono i test |
| Frasi delle opzioni | Possono contraddirsi tra loro | Forma condizionale; responsabilità dell'autore |
| Basi sempre attive | Una base di comportamento lunga richiede la ricerca a ogni domanda | Basi di comportamento corte, che entrano intere |
| Dati su Gemma 4 | Dimensioni, finestre e canale di sistema riferiti da un revisore, non verificati | Il modello consigliato è un campo del ruolo, non è nel codice |
| Quote | Valori iniziali scelti a occhio | Regolabili; da fissare dopo i test |
| Opzioni che toccano la mente | L'utente vede cambiare valori che non ha toccato | Dichiarate nell'interfaccia; vince l'ultima azione |
| Conversione dei Brief | Testo più lungo del limite della Situazione | Si conserva comunque, con avviso |
| Riuso di Ollama | Non misurabile in modo diretto | Si usa il tempo di valutazione del prompt; da verificare |
| Contenuti in più lingue | Ogni lingua è una copia da mantenere | Accettato per semplicità; istruzioni condivise rimandate |
| Qualità dei ruoli di base | Dipende dai testi, non dal codice | Bozze da rileggere prima della release |

Rimandati a fasi successive: sistema di valutazione dei ruoli (domande di prova, criteri, confronto tra modelli
e composizioni), editor dei ruoli, ruoli creati dall'utente, pagamenti e licenze, plugin connettori
esterni.

---

## Appendice A — Struttura dei parametri: alternative considerate

Applicate allo stesso ruolo (Assistente alla scrittura).

| Alternativa | Struttura | Esito |
|---|---|---|
| **A** | Tre gruppi del Brief: Ruolo, Obiettivi, Vincoli | Scartata: «Vincoli» diventa un contenitore unico |
| **B** | Solo tipi di vincolo: Pubblico, Formato, Tono, Fonti, Limiti, Metodo | Scartata: spariscono identità e obiettivi |
| **C** | Otto gruppi: Identità, Obiettivi, cinque tipi di vincolo, Metodo; ogni impostazione della mente di proprietà di un gruppo | Scartata dopo la seconda revisione: troppe intestazioni, spesso con un solo parametro; parametri incastrati a forza (es. «Tecniche» in Fonti) |
| **D** | **Quattro sezioni** (Identità e obiettivi, Stile e formato, Regole e fonti, Metodo), tipo di vincolo come etichetta facoltativa, regola piatta sulla mente | **Scelta** (§3.2) |

## Appendice B — Esito delle revisioni esterne

**Accolto**

- Con gli ordini B e C, conoscenza, promemoria e domanda in un solo messaggio `user`.
- Conversione token → caratteri per il limite della Situazione.
- `toggle` come scelta singola a due opzioni.
- Avviso non bloccante se una base del ruolo manca.
- Delimitatori netti attorno agli esempi.
- Quattro sezioni al posto di otto gruppi.
- Regola piatta: al massimo un parametro per impostazione della mente.
- Frasi condizionali al posto delle dipendenze tra parametri.
- Token di ragionamento registrati a parte.
- Ordine B con promemoria come candidato principale (da confermare con i test).

**Non accolto, o in sospeso**

- Togliere l'ordine C: resta come opzione diagnostica.
- `prompt_eval_count` come misura esatta dei token nuovi: affermato due volte, **non verificato**; si prova
  con un Ollama vero in fase 3.
- Caratteristiche di Gemma 4 (canale di sistema nativo, dimensioni, finestre): **non verificate**. Dal Modelfile
  risulta solo che usa un formattatore interno a Ollama. Il template pubblicato da Google per Gemma 4 prevede
  un turno di sistema, ma non è confermato come lo applica Ollama.

## Appendice C — Domande ancora aperte

1. **Quantità**: quante frasi regge un modello piccolo prima che le istruzioni si diluiscano? I ruoli di §7 ne
   producono 8–9.
2. **Ordine del contesto**: A, B o C, con o senza promemoria, sui modelli realmente usati.
3. **Quote**: 20/20/60 e 5% per la Situazione sono valori iniziali.
4. **Ragionamento e risposte brevi**: le opzioni di risposta sintetica devono spegnere il ragionamento?
5. **Valori della mente dei ruoli di base**: da provare con Gemma 4 (temperatura predefinita 1).
