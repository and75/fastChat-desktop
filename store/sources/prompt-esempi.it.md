# Prompt deboli e migliorati

## Migliorare un prompt vago

Richiesta: Migliora questo prompt: «Riassumi il testo.»

Risposta:
Sei un redattore. Scrivi per chi non ha letto il testo.
Riassumi il testo tra le tre virgolette.
Usa cinque punti, uno per idea principale.
Ogni punto è una frase di venti parole al massimo.
Se il testo non contiene cinque idee, scrivi meno punti.

"""
[testo]
"""

## Migliorare un prompt per un programma

Richiesta: Migliora questo prompt: «Dimmi se la recensione è positiva o negativa.»

Risposta:
Classifica la recensione tra le tre virgolette.
Rispondi con una sola parola: positiva, negativa o neutra.
Se la recensione parla di più aspetti, scegli il giudizio sull'aspetto principale.
Non aggiungere altro testo.

"""
[recensione]
"""

## Spiegare cosa non va

Richiesta: Cosa non va in questo prompt? «Sei un esperto molto bravo. Scrivi un'email al cliente, che sia professionale ma anche amichevole, non troppo lunga e nemmeno troppo corta.»

Risposta:
1. Manca il compito preciso: non dice di cosa parla l'email né cosa deve ottenere.
2. Manca il contesto: chi è il cliente e cosa è successo prima.
3. Il formato è vago: «non troppo lunga» non è una misura. Meglio un numero di frasi.
4. «Professionale ma amichevole» lascia il tono al caso. Meglio un esempio di una frase scritta nel tono voluto.
5. «Esperto molto bravo» non aggiunge nulla: il ruolo deve dire il mestiere.

## Scrivere da zero quando l'obiettivo è chiaro

Richiesta: Mi serve un prompt per estrarre data, importo e fornitore da una fattura.

Risposta:
Estrai i dati dalla fattura tra le tre virgolette.
Rispondi solo con un oggetto JSON con questi campi: data, importo, fornitore.
Scrivi la data nel formato AAAA-MM-GG.
Scrivi l'importo come numero, con il punto per i decimali e senza simbolo di valuta.
Se un dato non è presente nella fattura, usa il valore null.

"""
[fattura]
"""

## Scrivere da zero quando l'obiettivo manca

Richiesta: Scrivimi un prompt per il servizio clienti.

Risposta:
Per scriverlo mi servono due cose:
1. Cosa deve fare il modello: rispondere ai clienti, classificare le richieste, o riassumerle per un operatore?
2. Su cosa si basa: ha una documentazione da cui rispondere, o deve solo indirizzare la richiesta?

## Aggiungere un esempio al prompt

Richiesta: Migliora questo prompt, il modello sbaglia sempre il formato: «Dai un titolo all'articolo.»

Risposta:
Scrivi un titolo per l'articolo tra le tre virgolette.
Il titolo ha al massimo otto parole e non finisce con il punto.
Non usare i due punti né le domande.
Rispondi solo con il titolo.

Esempio di titolo: Il porto di Genova riapre dopo tre mesi

"""
[articolo]
"""
