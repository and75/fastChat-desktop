# Prompt deboli e migliorati

## Aggiungere i dettagli che mancano

Richiesta: Migliora questo prompt: «Riassumi gli appunti della riunione.»

Risposta:
```
Riassumi gli appunti della riunione in un solo paragrafo. Poi scrivi un elenco dei partecipanti, ciascuno con i punti principali che ha sostenuto. Infine elenca i prossimi passi o le azioni decise, se ce ne sono.

<appunti>
[appunti della riunione]
</appunti>
```

Perché è scritto così:
1. Il prompt di partenza lasciava al modello tutte le scelte: quanto lungo, cosa tenere, in che ordine.
2. Ora dice le tre parti della risposta e la forma di ciascuna: paragrafo, elenco, azioni.
3. «Se ce ne sono» dice cosa fare quando un'informazione manca, così il modello non inventa azioni mai decise.

## Migliorare un prompt del tipo «Agisci come…»

Richiesta: Migliora questo prompt: «Voglio che tu agisca come un narratore. Inventerai storie divertenti, coinvolgenti, fantasiose e accattivanti per il pubblico. Possono essere fiabe, storie educative o qualsiasi altro tipo di storia capace di catturare l'attenzione. La mia prima richiesta è: mi serve una storia interessante sulla perseveranza.»

Risposta:
```
Sei un narratore di storie per bambini dai sei ai nove anni. Scrivi una storia sulla perseveranza da leggere ad alta voce prima di dormire: circa 500 parole, cioè quattro o cinque minuti di lettura.

La protagonista è una bambina della stessa età di chi ascolta, alle prese con qualcosa che non le riesce al primo tentativo. Fai capire cos'è la perseveranza attraverso quello che lei fa, senza nominarla e senza una morale finale: i bambini la colgono meglio dai fatti che da una spiegazione.

Usa frasi brevi e qualche ripetizione, che aiutano chi ascolta a seguire. Chiudi con un'immagine tranquilla, adatta al momento della buonanotte.
```

Perché è scritto così:
1. «Divertenti, coinvolgenti, fantasiose» sono aggettivi che non guidano il modello. Al loro posto ci sono pubblico, occasione e durata.
2. La regola «niente morale» ha il suo motivo accanto: il modello la applica meglio se sa a cosa serve.
3. Ho scelto io età e occasione, che il prompt non diceva: se sono altre, basta cambiare la prima frase.

## Scrivere un prompt il cui risultato va letto da un programma

Richiesta: Mi serve un prompt per classificare le recensioni dei prodotti; il risultato finisce in un foglio di calcolo.

Risposta:
```
Classifica la recensione di un prodotto come positiva, negativa o neutra. La risposta viene inserita da un programma in un foglio di calcolo: scrivi quindi una sola parola, senza punteggiatura né commenti.

Recensione: Adoro queste cuffie, la qualità del suono è straordinaria!
Giudizio: positiva

Recensione: La batteria è discreta, ma i cuscinetti sembrano scadenti.
Giudizio: neutra

Recensione: Assistenza clienti pessima, non comprerò mai più da loro.
Giudizio: negativa

Recensione: [recensione da classificare]
Giudizio:
```

Perché è scritto così:
1. Spiega perché serve una sola parola: il modello capisce il vincolo e non aggiunge frasi di contorno.
2. Tre esempi diversi, tutti con la stessa struttura, fissano il formato meglio di una descrizione.
3. Il prompt finisce con «Giudizio:», così la risposta comincia direttamente dalla parola attesa.

## Scrivere un prompt di sistema da riusare

Richiesta: Mi serve un prompt da riusare ogni volta che devo riassumere un articolo.

Risposta:
```
# Identità
Sei un esperto nel riassumere contenuti. Ricevi un testo e ne restituisci un riassunto nel formato descritto qui sotto.

# Sezioni della risposta
- RIASSUNTO IN UNA FRASE: tutto il contenuto in una sola frase di venti parole.
- PUNTI PRINCIPALI: i dieci punti più importanti, ciascuno di sedici parole al massimo.
- DA RICORDARE: le cinque conclusioni più utili per chi legge.

# Regole
- Usa elenchi numerati.
- Non ripetere lo stesso punto in sezioni diverse.
- Scrivi solo le tre sezioni, senza avvertenze né commenti.

# Testo
[articolo da riassumere]
```

Perché è scritto così:
1. Un prompt che si riusa spesso conviene dividerlo in sezioni con un titolo: si legge e si corregge più facilmente.
2. Il formato è descritto sezione per sezione, con misure precise (venti parole, dieci punti).
3. L'articolo va in fondo, sotto il suo titolo, separato dalle istruzioni.

## Spiegare cosa non va in un prompt

Richiesta: Cosa non va in questo prompt? «Voglio che tu agisca come uno scrittore di saggi. Dovrai fare ricerche su un argomento, formulare una tesi e creare un testo persuasivo, informativo e coinvolgente. La mia prima richiesta è: aiutami a scrivere un saggio persuasivo sull'importanza di ridurre i rifiuti di plastica.»

Risposta:
1. Non dice per chi è il saggio né dove verrà pubblicato: da questo dipendono tono, lessico e argomenti.
2. Manca la lunghezza: il modello sceglie a caso tra una pagina e dieci.
3. Chiede di «fare ricerche», ma non fornisce fonti: il modello citerà dati a memoria, alcuni inventati. Meglio allegare i dati o chiedere di segnalare le affermazioni da verificare.
4. «Persuasivo, informativo e coinvolgente» non guida la scrittura. Meglio dire quale obiezione del lettore il saggio deve superare.
5. Non dice la struttura attesa: tesi, argomenti, conclusione, con o senza titoli.

## Quando l'obiettivo non è chiaro

Richiesta: Scrivimi un prompt per il servizio clienti.

Risposta:
Per scriverlo bene mi servono due informazioni:
1. Cosa deve fare il modello: rispondere ai clienti, smistare le richieste, o riassumerle per un operatore?
2. Su cosa si basa: ha una documentazione da cui rispondere, o deve solo indirizzare la richiesta alla persona giusta?
