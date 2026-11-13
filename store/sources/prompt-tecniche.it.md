# Tecniche di prompt

## Le parti di un buon prompt

Un prompt completo risponde a cinque domande, in quest'ordine: chi deve essere il modello, cosa sa della situazione, cosa deve fare, in che forma deve rispondere, cosa non deve fare.

Non tutte servono sempre. Un compito semplice vuole solo il compito e il formato. Più il compito è delicato, più parti servono.

## Ruolo

Una riga che dice chi è il modello e per chi scrive: «Sei un revisore tecnico. Scrivi per programmatori esperti.» Il ruolo fissa lessico e livello di dettaglio meglio di un elenco di aggettivi.

## Contesto

Solo i fatti che cambiano la risposta: i dati di partenza, ciò che è già deciso, chi leggerà. Tre frasi pertinenti valgono più di una pagina generica.

Il testo su cui lavorare va separato dalle istruzioni con un delimitatore chiaro, per esempio tre virgolette o un titolo.

## Compito

Un verbo preciso e un oggetto: riassumi, confronta, correggi, estrai, classifica. «Cosa ne pensi?» non è un compito.

Un compito per prompt. Se sono due, vanno in due passi numerati o in due prompt.

## Formato

Dire la forma esatta: elenco, tabella, JSON con i nomi dei campi, numero di frasi, lingua. Se la risposta va letta da un programma, il formato è la parte più importante del prompt.

Un esempio della risposta attesa fissa il formato meglio di una descrizione. Uno o due bastano: con troppi il modello copia anche i dettagli irrilevanti.

## Vincoli

Scrivere cosa fare al posto di cosa evitare: «Rispondi solo con il nome della categoria» funziona meglio di «Non aggiungere spiegazioni».

Dire cosa fare quando l'informazione manca: «Se il testo non lo dice, scrivi "non indicato"». Senza questa riga il modello inventa.

## Per i modelli piccoli

Un'istruzione per riga, in forma imperativa. Niente premesse, niente cortesie, niente istruzioni ripetute.

Poche istruzioni: oltre otto o nove, le ultime pesano più delle prime e quelle di mezzo si perdono.

L'istruzione più importante va in fondo, vicino al testo da elaborare.

Parole semplici e sempre le stesse: se una cosa si chiama «categoria», non diventa «classe» due righe dopo.

## Per i modelli grandi

Reggono istruzioni articolate. Conviene spiegare il perché di un vincolo e dare criteri di qualità: «la risposta è buona se un cliente la capisce senza conoscere il prodotto».

## Come si riconosce un prompt debole

In ordine di gravità:

1. Manca il compito, o ce n'è più d'uno.
2. Manca il formato della risposta.
3. Manca cosa fare quando l'informazione non c'è.
4. Il contesto è assente, oppure è lungo e generico.
5. Le istruzioni si contraddicono o si ripetono.
6. Il testo da elaborare è mescolato alle istruzioni.
