# Manuale d'uso di FastChat

## La finestra

A sinistra c'è la barra laterale, con l'elenco delle conversazioni. Al centro la conversazione, con il campo di scrittura in basso. A destra il pannello della conversazione, con le schede «Modello», «Situazione» e «Conoscenza».

Il pannello si nasconde e si mostra con il pulsante in alto a destra, accanto all'icona per esportare.

## Iniziare una conversazione

«Nuova conversazione», nella barra laterale, apre una conversazione con il ruolo «Generalista»: nessuna istruzione, il modello così com'è.

La freccia accanto a «Nuova conversazione» apre «Parla con un…»: l'elenco dei ruoli installati, poi i template. Un clic su un ruolo apre una conversazione con quel ruolo.

Il modello si sceglie dal menu «Modello», nella barra in alto.

## Ruoli

Un ruolo dice al modello chi è e come deve rispondere. Si regola dalla scheda «Modello», dove compaiono il ruolo e le sue sezioni: «Identità e obiettivi», «Stile e formato», «Regole», «Metodo».

Ogni sezione si apre con un clic e contiene le scelte del ruolo. Chiusa, mostra in una riga le scelte in vigore. Alcune scelte cambiano anche le impostazioni del modello: lo dice una riga sotto la scelta, per esempio «imposta la temperatura a 0,3».

Per cambiare ruolo si usa «Cambia…», accanto al nome del ruolo. A conversazione vuota il ruolo cambia subito. A conversazione avviata si apre una nuova conversazione, che può partire dal riassunto di quella precedente.

## Situazione

Nella scheda «Situazione» si scrive il contesto di questa conversazione, con parole proprie: di cosa si sta parlando, per chi, con quali vincoli. Si salva da sola e vale dalla domanda successiva.

Sotto il campo c'è il contatore dei caratteri. «Cosa riceve il modello» mostra le istruzioni complete: quelle del ruolo, poi la situazione.

Nella stessa scheda ci sono «Plan mode» e «Salva come template».

## Documenti e basi di conoscenza

Nella scheda «Conoscenza», «Aggiungi documenti» carica i file su cui il modello deve rispondere. Si possono anche trascinare nel riquadro.

«Usa la base di conoscenza» accende o spegne l'uso dei documenti per tutta la conversazione. Il bottone a forma di libro accanto a «Invia» vale per una sola domanda.

«Collega una base…» collega alla conversazione una base della libreria. Le basi della libreria si creano in «Impostazioni» → scheda «Conoscenza».

Le basi «Del ruolo» fanno parte del ruolo: sono sempre attive e non si scollegano.

## Come risponde il modello

Nella scheda «Modello», sotto le sezioni del ruolo, ci sono quattro gruppi: «Dove gira», «Come sceglie le parole», «Come risponde», «Cosa ricorda».

In «Come risponde» si trovano «Ragionamento» e «Stile della risposta», con quattro valori: «Essenziale», «Conciso», «Normale», «Esteso». In «Come sceglie le parole» c'è la «Temperatura». In «Cosa ricorda» c'è la «Memoria della conversazione».

«Ragionamento», «Plan mode» e «Stile» si trovano anche sotto il campo di scrittura.

«↺ Tutti i valori suggeriti» riporta temperatura e memoria ai valori consigliati per il modello.

## Plan mode

Con «Plan mode» acceso il pulsante di invio diventa «Pianifica». Il modello propone un piano in passi; i passi si possono modificare. «Approva ed esegui» fa partire la risposta che segue il piano.

## Conversazioni lunghe

Quando la conversazione non sta più nella memoria del modello, i messaggi più vecchi vengono sostituiti da un «Riassunto automatico», visibile nella conversazione. Si può leggere e correggere con «Mostra e modifica», rifare con «Aggiorna», togliere con «Elimina».

Lo «Stato del contesto», in fondo alla scheda «Modello», mostra quanta memoria è occupata.

## Store

«Store», in fondo alla barra laterale, elenca ciò che si può installare: «Ruoli», «Basi di conoscenza», «Plugin», «Pacchetti».

«Installa» aggiunge la voce; «Rimuovi» la toglie. Un ruolo si installa insieme alle basi che richiede. Quando un ruolo esiste in più lingue, «Disponibile in:» permette di scegliere quale installare.

## Template ed esportazione

«Salva come template», nella scheda «Situazione», salva ruolo, scelte e situazione. Il template si ritrova in «Parla con un…».

L'icona di esportazione, in alto a destra, salva la conversazione in Markdown o in JSON.

## Impostazioni

L'ingranaggio in fondo alla barra laterale apre le «Impostazioni», con le schede «Generale», «Modelli», «Ollama», «Conoscenza», «Contesto».

In «Generale» si scelgono «Lingua», «Tema», «URL di Ollama» e «Modello predefinito». In «Conoscenza» si gestiscono le basi della libreria e si importa un pacchetto con «Importa pacchetto…».
