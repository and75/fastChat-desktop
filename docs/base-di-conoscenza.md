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
