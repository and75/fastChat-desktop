# Scrivere buoni prompt

Indicazioni pratiche per ottenere risposte migliori da un modello linguistico locale. Valgono per qualunque modello; con i modelli piccoli contano di più.

## Dire chi è il modello e a chi parla

Un ruolo chiaro orienta tono e livello di dettaglio. «Sei un tutor di matematica per ragazzi di terza media» produce spiegazioni diverse da «Sei un revisore tecnico». In FastChat il ruolo si scrive nel campo Ruolo del brief e vale per tutta la conversazione.

Indica anche il destinatario: un principiante, un collega esperto, un cliente. Il modello adatta lessico ed esempi.

## Dare il contesto che serve

Il modello sa solo quello che gli scrivi. Fornisci i dati di partenza, i vincoli e ciò che è già stato deciso. Se la risposta deve basarsi su documenti, aggiungili alla base di conoscenza della conversazione invece di incollarli a pezzi.

Evita il contesto inutile: occupa memoria e distrae. Meglio tre frasi pertinenti che una pagina generica.

## Chiedere una cosa precisa

Una richiesta vaga dà una risposta vaga. Specifica l'azione (riassumi, confronta, correggi, elenca), l'oggetto e il risultato atteso. «Riassumi questo verbale in cinque punti, uno per decisione presa» è meglio di «Cosa ne pensi?».

Se il compito è lungo, dividilo in passi e chiedine uno alla volta, oppure usa il plan mode: il modello propone un piano, lo correggi, poi lo esegue.

## Indicare il formato della risposta

Dì come vuoi la risposta: un elenco, una tabella, un testo di cento parole, codice senza commenti. Indica la lingua se può essere ambigua. Con lo stile della risposta di FastChat scegli tra essenziale, conciso, normale ed esteso senza riscriverlo ogni volta.

## Mostrare un esempio

Un esempio vale più di una descrizione. Se vuoi un certo formato, mostra una riga fatta come la vuoi. Se vuoi un certo tono, incolla una frase scritta con quel tono. Uno o due esempi bastano; troppi fanno copiare al modello anche i dettagli irrilevanti.

## Mettere i vincoli

Scrivi cosa non deve fare: non inventare dati, non superare una certa lunghezza, non usare termini tecnici. Per le risposte che devono essere verificabili chiedi di citare la fonte e di dire quando l'informazione manca.

## Controllare e correggere

Leggi la risposta e di' cosa non va, in modo specifico: «il punto tre è sbagliato perché…», «accorcia il secondo paragrafo». Una correzione mirata funziona meglio che ripetere la domanda. Se la conversazione ha preso una strada sbagliata, conviene ripartire da una conversazione nuova con un brief migliore.

## Temperatura e ripetibilità

Con una temperatura bassa il modello è più prevedibile e adatto a compiti precisi (estrazione di dati, codice). Con una temperatura alta varia di più ed è adatto a idee e testi creativi. Per ottenere la stessa risposta alla stessa domanda si fissa il seed.

## Errori comuni

- Chiedere più cose insieme senza ordine: il modello ne salta qualcuna.
- Dare per scontato ciò che non è scritto.
- Usare negazioni vaghe («non essere noioso») al posto di indicazioni positive («usa frasi brevi e un esempio concreto»).
- Incollare testi lunghissimi quando basterebbe la parte pertinente.
- Fidarsi di numeri e citazioni senza controllarli.
