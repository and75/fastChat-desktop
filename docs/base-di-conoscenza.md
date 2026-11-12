# Base di conoscenza: come funziona il RAG sui documenti

Riferimento del meccanismo, allineato al codice (`src/main/knowledge/`, `src/shared/knowledge.ts`,
`src/main/chat.ts`). Quando il codice cambia, aggiornare anche questa pagina.

## 0. Basi di conoscenza

- Una **base** è un insieme di documenti (tabella `knowledge_bases`). Documenti e sorgenti collegate
  appartengono a una base, non a una conversazione.
- **Base della conversazione** (`origin: 'conversation'`): una per conversazione, solo sua, per i documenti
  che l'utente aggiunge dalla scheda «Conoscenza». Nasce al primo documento e viene eliminata con la conversazione.
- **Basi della libreria** (`origin: 'local'`, e `'package'` per quelle installate da un pacchetto): si creano
  e si gestiscono in Impostazioni → Conoscenza, e si **collegano** a quante conversazioni si vuole
  (`conversation_bases`). I documenti si indicizzano una volta sola. Un'identità del modello potrà portare
  con sé le sue basi collegandole alla conversazione.
- Una conversazione usa **l'unione**: la sua base più quelle collegate. Ricerca, budget e documenti interi
  valgono sull'insieme; le fonti riportano il nome della base quando il documento viene dalla libreria.
- Dalla conversazione le basi collegate si collegano e scollegano soltanto: documenti, «Intero» e sorgenti si
  modificano nella libreria e valgono per tutte le conversazioni che collegano la base.
- Eliminando una base dalla libreria (con conferma che dice quante conversazioni la usano) sparisce da tutte,
  con documenti e pezzi; i documenti propri delle conversazioni restano.
- Le chiamate di embedding dei documenti di una conversazione finiscono nel suo monitor del contesto e seguono
  la CPU/GPU del suo modello; quelle delle basi della libreria non appartengono a nessuna conversazione.

## 0.1 Modello di embedding per base

- Una base ha un **modello di embedding effettivo**: quello delle Impostazioni (base della conversazione, basi
  locali, pacchetti di solo testo) oppure quello **dichiarato dal pacchetto** che ha portato i vettori.
- Le basi con il modello delle Impostazioni si reindicizzano quando lo si cambia; quelle con il modello
  dichiarato hanno vettori fissi e non si toccano.
- Per usare una base serve che il suo modello sia installato in Ollama: altrimenti resta installata ma
  inattiva, con l'avviso «serve il modello X» e il download.
- Una conversazione può avere basi con modelli diversi: la domanda diventa vettore **una volta per modello**
  (di norma uno solo), i punteggi si calcolano per gruppo e la scelta degli estratti è unica. Quando i
  documenti vanno al modello per intero non serve nessun embedding della domanda.

## 0.2 Pacchetti (.fcpack)

Il formato con cui una base si esporta, si installa e si distribuirà dallo store. È uno zip:

| File | Contenuto |
|---|---|
| `manifest.json` | id, tipo (`knowledge`; `identity` e `bundle` sono riservati), nome, versione, autore, lingua, licenza, **modello di embedding dichiarato** (nome, dimensioni, impronta), impronta SHA-256 di ogni file |
| `knowledge.json` | documenti e pezzi con locatore: il testo c'è sempre (fonti, ricerca a parole) |
| `vectors.bin` | vettori float32 dei pezzi, nell'ordine dei pezzi; assente nei pacchetti di solo testo |
| `signature.json` | firma Ed25519 del manifest, che fissa l'impronta degli altri file |

- **Con i vettori** (il caso normale, modello predefinito `embeddinggemma`): all'installazione i pezzi sono
  subito pronti, senza chiamate a Ollama; la base è legata al modello dichiarato.
- **Di solo testo**: i documenti si indicizzano con il modello dell'utente; se manca aspettano «in attesa» e
  ripartono quando il modello viene scaricato. Una copia del pacchetto resta in `userData/packs/`.
- **Fiducia**: `verified` (firma di una chiave in `src/main/knowledge/trust.ts`), `unsigned`, `unknown`
  (firmato da una chiave non nota), `builtin` (integrato nell'app). Senza firma verificata l'installazione
  chiede una conferma esplicita. Un pacchetto alterato (impronte o firma che non tornano) non si installa.
- **Aggiornamento**: stesso id, nuova versione → la base resta la stessa (e resta collegata), il contenuto
  viene sostituito.
- Le basi installate da un pacchetto sono di **sola lettura**; «Intero» resta modificabile.
- **Esporta** (Impostazioni → Conoscenza): solo basi locali con tutti i documenti pronti; il pacchetto porta i
  vettori del modello della base, dichiarato nel manifest con dimensioni e impronta.
- **Pacchetti integrati**: i file in `packs/` vengono installati o aggiornati all'avvio (`npm run packs:build`
  li rigenera dalla documentazione). Oggi: «Guida di FastChat», di solo testo.
- **Collega alle nuove conversazioni**: opzione per base della libreria; le nuove conversazioni la trovano già
  collegata.
- Firmare: `node scripts/pack-keys.mjs <id>` genera la coppia di chiavi; la pubblica va in `trust.ts`, la
  privata resta a chi pubblica.

## 0.3 Store

Finestra sopra la chat, aperta dal bottone «Store» nella barra laterale (sopra la riga con le impostazioni).

- **Categorie**, in ordine: Identità, Basi di conoscenza, Plugin, Pacchetti (riuniscono più voci).
- **Stati**: Installato · Aggiornamento disponibile · Disponibile · Presto disponibile. La Guida integrata risulta installata all'apertura.
- **Oggi si installano le basi di conoscenza**; identità e plugin sono in catalogo ma non installabili. Un pacchetto installa le basi che contiene.
- **Titoli e descrizioni nella lingua dell'interfaccia** (it/en/fr): nel catalogo (`name`, `summary` per lingua) e nel manifest del pacchetto (`i18n`), così valgono anche in libreria, basi collegate e fonti. Il contenuto resta nella lingua del pacchetto.
- **Catalogo**: se «Repository dello store» (Impostazioni → Generale) è vuoto si usa quello incluso nell'app (`store/catalog.json`, generato da `npm run packs:build`); altrimenti `GET {url}/catalog.json` e `GET {url}/{file}`. Se il repository non risponde si mostra il catalogo locale con il motivo.
- **Chi gestisce cosa**: ciò che è dello Store (voci del catalogo, base integrata) si installa, si aggiorna e si rimuove solo dallo Store. In Impostazioni → Conoscenza quelle basi mostrano «Gestisci nello Store» al posto di «Elimina», e «Importa pacchetto…» rifiuta un file con l'id di una voce dello Store. Le Impostazioni gestiscono le basi create dall'utente e i pacchetti importati da file.
- **Sicurezza**: impronta SHA-256 del file confrontata con il catalogo; dal repository si installano solo pacchetti con firma riconosciuta; quelli del catalogo incluso nell'app sono fidati come la Guida.

Voce del catalogo:

```json
{ "id": "it.fastchat.prompt", "type": "knowledge", "version": "1.0.0",
  "name": { "it": "Scrivere buoni prompt", "en": "Writing good prompts", "fr": "Écrire de bons prompts" },
  "summary": { "it": "…", "en": "…", "fr": "…" },
  "author": "FastChat", "language": "it", "price": 0,
  "embedding": { "model": "embeddinggemma", "dimensions": 768 },
  "file": "items/it.fastchat.prompt/1.0.0.fcpack", "sha256": "…", "size": 2341 }
```

Altri campi: `builtin` (integrata), `model` (identità: modello consigliato o richiesto), `requires`, `contains` (pacchetti).

## 0.4 Tipi di base in una conversazione

Una base collegata a una conversazione ha un **uso** (`conversation_bases.purpose`):

| Uso | Contenuto | Quando entra nel prompt | Fonti sotto la risposta |
|---|---|---|---|
| `documents` (predefinito) | I contenuti su cui rispondere | Solo con la pill o il bottone libro accesi, come sempre | Sì |
| `behavior` | Tecniche e regole del ruolo | Sempre | No |
| `examples` | Risposte ben fatte da imitare, ciascuna tra `<esempio>…</esempio>` | Sempre | No |

- I documenti aggiunti alla conversazione sono sempre `documents`.
- L'uso si sceglie sulla base collegata, nella scheda «Conoscenza». Con i ruoli arriverà dal pacchetto del ruolo.
- **Quote**: lo spazio della conoscenza (25/50/75% della memoria) si divide tra i tre usi secondo le quote delle
  Impostazioni (20/20/60 predefinite). Ciò che un uso non consuma passa agli altri, prima ai documenti: con sole
  basi di tipo `documents` il comportamento è quello di sempre.
- «Pronti» e il bottone libro contano solo i documenti.

Progetto completo dei ruoli: [`ruoli.md`](ruoli.md) e [`ruoli-piano.md`](ruoli-piano.md).

## 1. Ingresso: i plugin

- Un plugin (`KnowledgeSource`, in `src/main/knowledge/source.ts`) sa leggere un tipo di sorgente e
  restituisce **testo a sezioni con un locatore** (pagina, titolo). Non fa altro: pezzi, embedding,
  ricerca, prompt e interfaccia sono del nucleo.
- Plugin `file` (l'utente aggiunge file dal dialog o trascinandoli):
  - `text`: txt e simili in una sezione; Markdown diviso ai titoli, locatore = catena dei titoli;
  - `pdf` (pdf.js): una sezione per pagina, locatore «p. N»; scansioni senza testo → errore, niente OCR;
  - `docx` (mammoth): HTML → Markdown → sezioni ai titoli.
- Plugin `connected` (la sorgente elenca lei i documenti):
  - `folder`: una cartella del computer, sottocartelle fino a 4 livelli, al massimo 500 file, cartelle
    nascoste e `node_modules` escluse; delega la lettura ai plugin `file`; versione = data e dimensione;
    «Aggiorna» aggiunge i nuovi, rifà i cambiati, toglie gli spariti; «Scollega» rimuove tutto.
  - Il form di configurazione lo disegna il nucleo dai campi dichiarati dal plugin (testo, cartella,
    segreto); i campi segreti sono cifrati con `safeStorage`.
- Registro: `createBuiltinRegistry()` in `src/main/knowledge/sources/index.ts`. Per aggiungere un
  plugin: un file nella cartella, una riga nel registro, l'etichetta nelle tre lingue, un test con una fixture.

## 2. Indicizzazione (una volta per documento, in sottofondo)

1. Impronta SHA-256 del file: lo stesso file non entra due volte nella stessa base.
2. Il plugin estrae le sezioni; limite 25 MB per file e 2 milioni di caratteri di testo.
3. Ogni sezione viene divisa per paragrafi in **pezzi di al massimo 1.600 caratteri** (~400 token);
   ogni pezzo eredita il locatore della sezione.
4. **Embedding** con Ollama, in lotti di 16, con il **modello di embedding dedicato** scelto in
   Impostazioni (`embeddingModel`, predefinito `embeddinggemma`). Non è il modello della conversazione:
   è lo stesso modello usato dalla memoria a lungo termine. Dal modello di chat si prende solo
   l'esecuzione CPU/GPU (`num_gpu = 0` se la chat gira solo in CPU), per non far ricaricare i modelli a Ollama.
5. I vettori vanno in SQLite (`knowledge_chunks`) **per modello di embedding**: cambiando modello i
   documenti vengono reindicizzati; vettori di modelli diversi non si confrontano mai.
6. Il testo dei pezzi entra anche nell'indice **FTS5** (`knowledge_fts`, BM25, accenti ignorati),
   tenuto allineato con trigger su inserimento e cancellazione.
7. Stato per documento: `pending` → `indexing` (con avanzamento) → `ready` oppure `error` (con il motivo,
   «Riprova» disponibile). Una domanda usa solo i documenti `ready`. Ogni chiamata di embedding è
   registrata nel monitor del contesto (`embed-doc`).

## 3. Quando parte la ricerca

A ogni domanda, se valgono entrambe le condizioni:

- la **pill** «Usa la base di conoscenza» della conversazione è accesa, **oppure** il **bottone libro**
  accanto a «Invia» è acceso per questa domanda (la scelta sulla domanda vince su quella della conversazione);
- c'è almeno un documento `ready` con pezzi per il modello di embedding attuale, nella base della
  conversazione o in una base collegata.

La scelta del bottone libro si salva sul messaggio dell'utente: «Rigenera» la ripete.

## 4. Budget: quanto spazio nel prompt

```
budget = min( quota × num_ctx ,
              num_ctx − riserva per la risposta (20%) − brief − stile − riassunto − storico recente − domanda )
```

- **Quota** per conversazione, nella scheda «Conoscenza»: 25 %, **50 % (predefinito)**, 75 %.
- Il budget è un tetto: in una conversazione già lunga i documenti possono avere meno della quota.
- Dopo i documenti, la memoria della conversazione (estratti dei messaggi riassunti) prende al massimo il
  12 % di quel che resta. Sotto 64 token non si cerca nulla.

## 5. Scelta del contenuto, in ordine

1. **Tutto per intero.** Se la somma dei pezzi di tutti i documenti pronti sta nel budget, vanno al modello
   completi, in ordine di documento e posizione. L'introduzione della sezione dice che i documenti sono
   completi: il modello può contare, confrontare e sommare.
2. **Documenti «Intero»** (bottone a spillo sul documento). Vanno per intero finché stanno nel budget, prima
   di tutto il resto. Se da soli lo superano, la scheda avvisa che verranno tagliati.
3. **Estratti** nello spazio che avanza:
   - un solo embedding della domanda (testo della domanda + ultimi 500 caratteri della risposta precedente),
     condiviso con la memoria della conversazione;
   - ricerca a parole esatte FTS5 sulla domanda (parole di almeno 3 lettere e numeri);
   - **punteggio ibrido** = 0,6 × coseno + 0,4 × BM25 normalizzato sul migliore (la parte BM25 conta solo
     se qualche pezzo ha un punteggio significativo);
   - soglie: punteggio ≥ 0,25 e ≥ 50 % del migliore;
   - tetto per documento = max(2, budget in pezzi ÷ numero di documenti): cresce con il budget, cala con
     il numero di documenti;
   - si riempie il budget in ordine di punteggio; nessun limite fisso al numero di estratti.

## 6. Nel prompt

- Sezione `# Base di conoscenza`, nel system prompt dopo brief, stile, riassunto e memoria della conversazione.
- Introduzione per «documenti completi» o per «estratti» (e una frase di raccordo quando ci sono entrambi);
  poi ogni voce come `[Titolo, p. N]` seguita dal testo.
- Istruzioni al modello: rispondere dai documenti quando riguardano la domanda, citare la fonte tra
  parentesi quadre, dire chiaramente quando l'informazione non c'è.
- Testi nella lingua dell'interfaccia (italiano, inglese, francese).

## 7. Dopo la risposta

- **Fonti** salvate sul messaggio (`knowledgeRefs`) e mostrate sotto la risposta: titolo, locatore,
  punteggio oppure «documento intero».
- Monitor del contesto: voce «Estratti dei documenti» nella chiamata di risposta, chiamate `embed-query` ed
  `embed-doc` con i conteggi di Ollama.
- Esportazione Markdown e JSON con l'elenco dei documenti, la scelta sulla domanda e le fonti per risposta.

## 8. Interfaccia

- **Impostazioni → Conoscenza**: libreria delle basi (crea, rinomina, elimina) e documenti di ogni base, con
  gli stessi comandi della scheda.
- Scheda **«Conoscenza»** nel pannello laterale: pill, selettore dello spazio, «Basi collegate» (collega,
  scollega), aggiunta file e drag&drop,
  «Collega: …» per le sorgenti collegate, elenco documenti con stato, «Intero», «Riprova», rimozione;
  riga di stato con pezzi indicizzati e modello; riga che dice se i documenti stanno nello spazio riservato
  e, se no, quanta memoria servirebbe.
- **Bottone libro** accanto a «Invia»: mostra se la prossima domanda userà i documenti; un clic lo inverte per
  quella domanda; disabilitato senza documenti pronti.
- Gruppo «Cosa ricorda» del pannello Modello: riga riepilogativa con rimando alla scheda.

## 9. Limiti noti

- Domande sull'insieme dei documenti («quante sono?», «il totale?») funzionano solo quando i documenti
  vanno al modello per intero (caso 1): altrimenti non ci sono parole che li selezionino. La scheda dice
  quanta memoria servirebbe. Per totali e conteggi su molti documenti servirebbe un estrattore strutturato
  (campi per tipo di documento), non ancora costruito.
- La ricerca a coseno è in JavaScript su tutti i pezzi della conversazione: regge migliaia di pezzi, non
  decine di migliaia.
- Niente reranker, niente OCR, niente sincronizzazione automatica delle cartelle collegate. Plugin esterni
  caricati da disco: predisposti dal contratto, non costruiti.

## Variabili per i test

- `FASTCHAT_KNOWLEDGE_FILES`: percorsi (separati da `:`; `;` su Windows) aggiunti al posto del dialog.
- `FASTCHAT_KNOWLEDGE_FOLDER`: cartella restituita al posto del dialog di scelta cartella.
- `FASTCHAT_PACK_FILE` / `FASTCHAT_PACK_EXPORT`: pacchetto da importare / percorso in cui esportare, al posto dei dialog.
