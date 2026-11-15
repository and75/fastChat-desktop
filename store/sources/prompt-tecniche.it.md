# Tecniche di prompt

## Come si presenta un buon prompt

Un buon prompt si legge come la consegna che daresti a un collega capace ma appena arrivato: non conosce il progetto, il pubblico, né cosa intendi per «fatto bene». Se un collega leggendolo dovesse farti domande, anche il modello resterà nel dubbio.

Scrivi in frasi complete e naturali, in paragrafi brevi: uno per argomento. Un prompt non è un modulo da compilare: non usare etichette come «Ruolo:» o «Compito:» davanti a ogni riga. Usa titoli o sezioni solo quando il prompt è lungo e ha parti davvero diverse.

## Dire l'obiettivo e il contesto

Di' cosa vuoi ottenere e a cosa servirà il risultato: chi lo leggerà, dove verrà usato, cosa è già stato deciso. Il modello non ha queste informazioni se non gliele dai, e senza di esse dà una risposta generica.

Chiedi l'azione, non un parere: «Riscrivi questa email in tono più cordiale» ottiene l'email riscritta; «Potresti suggerire come migliorarla?» ottiene dei suggerimenti.

## Spiegare il perché delle regole

Una regola con il suo motivo funziona meglio di un ordine secco, perché il modello capisce lo scopo e lo applica anche ai casi che non hai previsto. «Non usare i puntini di sospensione» è un ordine. «Il testo verrà letto ad alta voce da una sintesi vocale, che non sa pronunciare i puntini di sospensione: evitali» è una regola che il modello sa estendere.

Evita le maiuscole e i toni perentori («IMPORTANTE», «DEVI ASSOLUTAMENTE»): non rendono la regola più chiara e spingono il modello ad applicarla anche dove non serve.

## Dare un ruolo

Una frase all'inizio che dice chi è il modello e per chi scrive orienta il lessico e il livello di dettaglio: «Sei un revisore tecnico e scrivi per programmatori esperti». Basta una frase: il ruolo dà il tono, non sostituisce le istruzioni.

## Descrivere la forma della risposta

Di' com'è fatta la risposta che ti aspetti: un elenco, una tabella, un solo paragrafo, quante frasi, in che lingua. Descrivi ciò che vuoi invece di ciò che non vuoi: «Rispondi in paragrafi di prosa continua» funziona meglio di «Non usare elenchi».

Se il modello tende a risposte lunghe o corte, dillo: «rispondi in tre frasi», «spiega in dettaglio ogni passaggio».

## Usare esempi

Uno o più esempi della risposta attesa fissano formato e tono meglio di una descrizione. Da tre a cinque esempi bastano quasi sempre. Devono essere diversi tra loro: se si somigliano troppo, il modello copia anche i dettagli che non c'entrano. Devono anche avere tutti la stessa struttura, perché il modello imita quella. Un esempio mostra una risposta riuscita: i casi limite, come un testo troppo breve o un dato assente, si trattano con una regola, non con un esempio di risposta fallita.

Tieni gli esempi separati dalle istruzioni, per esempio ciascuno dentro `<esempio>` e `</esempio>`.

## Separare i dati dalle istruzioni

Quando il prompt contiene un testo su cui lavorare (un documento, un'email, una recensione), separalo dalle istruzioni con un delimitatore chiaro: tag come `<documento>` e `</documento>`, oppure un titolo. Scegli un solo tipo di delimitatore e usalo sempre uguale.

Il delimitatore serve solo se c'è un testo da elaborare. Un prompt che chiede di scrivere qualcosa da zero, come un racconto o un'email, non ne ha bisogno.

Se il testo è lungo, mettilo prima e la domanda dopo, introdotta da una frase di raccordo: «In base al documento qui sopra, …».

## Dire cosa fare quando l'informazione manca

Senza indicazioni il modello tende a inventare. Scrivi cosa deve fare se il dato non c'è: «Se il testo non lo dice, scrivi "non indicato"».

## Dividere i compiti complessi

Un prompt che chiede molte cose insieme dà risultati peggiori di più prompt semplici. Se il lavoro ha più fasi (per esempio estrarre i dati e poi scrivere un riassunto), conviene un prompt per fase, usando la risposta del primo come ingresso del secondo.

## Modelli locali piccoli e modelli grandi

Un modello piccolo, o usato senza ragionamento, lavora come un collaboratore alle prime armi: ha bisogno di istruzioni esplicite, di un solo compito per prompt e di vedere il formato della risposta in un esempio. Le regole più importanti (ruolo, vincoli, formato) vanno all'inizio.

Un modello grande, o con il ragionamento acceso, lavora come un collega esperto: gli si può dare l'obiettivo e i criteri di qualità, lasciandogli i dettagli. Non serve chiedergli di «ragionare passo per passo» nella risposta: lo fa già per conto suo.

## Migliorare un prompt che non funziona

Un prompt si mette a punto per tentativi. Leggi la risposta, individua cosa non va e cambia una cosa per volta:

- riformula la richiesta con altre parole;
- aggiungi il contesto o l'esempio che mancava;
- cambia l'ordine delle parti (esempi, contesto, domanda);
- trasforma il compito in uno equivalente più semplice, per esempio una scelta tra opzioni invece di una domanda aperta.

## Come si riconosce un prompt debole

Dal più grave al meno grave:

1. Non si capisce cosa deve produrre il modello, oppure chiede più cose insieme.
2. Manca il contesto: a cosa serve il risultato e chi lo leggerà.
3. Non dice che forma deve avere la risposta.
4. Non dice cosa fare quando l'informazione manca.
5. Le regole sono ordini senza motivo, oppure si contraddicono.
6. Il testo da elaborare è mescolato alle istruzioni.

## Fonti

Sintesi delle guide ufficiali sul prompt engineering di Anthropic («Prompting best practices»), Google («Prompt design strategies» e la documentazione di Gemma) e OpenAI («Prompt engineering»).
