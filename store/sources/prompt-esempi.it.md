# Prompt deboli e migliorati

## Scrivere da zero un prompt creativo

Richiesta: Scrivi un prompt per un racconto su un ragazzo che gioca la sua prima partita di calcio.

Risposta:
```
Sei uno scrittore di narrativa per ragazzi. Scrivi un racconto breve, di circa 400 parole, su un ragazzo di dodici anni che gioca la sua prima partita di calcio in una squadra vera.

Il racconto è per lettori della sua età: usa frasi semplici e un tono caldo, senza morale finale. Raccontalo in terza persona e al passato. Concentrati su ciò che il ragazzo prova, dall'attesa negli spogliatoi al fischio finale, più che sul risultato della partita.

Dai un nome al ragazzo e chiudi con un'immagine concreta, non con una spiegazione.
```

Perché è scritto così:
1. Dice per chi è il racconto: da lì il modello ricava lessico e tono.
2. Fissa lunghezza, persona e tempo verbale, che altrimenti sceglierebbe a caso.
3. Indica dove mettere l'attenzione (le emozioni, non il punteggio), così il racconto non diventa una cronaca.

## Migliorare un prompt vago

Richiesta: Migliora questo prompt: «Riassumi il testo.»

Risposta:
```
<documento>
[testo da riassumere]
</documento>

In base al documento qui sopra, scrivi un riassunto per un collega che non l'ha letto e deve decidere se vale la pena leggerlo per intero.

Scrivi un solo paragrafo di cinque frasi al massimo: prima l'argomento, poi le conclusioni principali, infine ciò che resta aperto. Riporta solo ciò che il documento dice; se un punto non è chiaro nel testo, segnalalo invece di interpretarlo.
```

Perché è scritto così:
1. Dice a chi serve il riassunto e per quale decisione: è questo che stabilisce cosa tenere e cosa tagliare.
2. Il documento sta in testa, tra due tag, e la richiesta dopo: con i testi lunghi il modello segue meglio le istruzioni che arrivano alla fine.
3. Dice cosa fare nei punti poco chiari, così il modello non inventa.

## Migliorare un prompt il cui risultato va letto da un programma

Richiesta: Migliora questo prompt, la risposta deve finire in un foglio di calcolo: «Dimmi se la recensione è positiva o negativa.»

Risposta:
```
Classifica la recensione di un prodotto come positiva, negativa o neutra. La risposta viene inserita da un programma in un foglio di calcolo: scrivi quindi una sola parola, senza punteggiatura né commenti.

Se la recensione parla di più aspetti, vale il giudizio sull'aspetto a cui dedica più spazio.

Recensione: Le cuffie suonano benissimo, le uso tutti i giorni.
Giudizio: positiva

Recensione: La batteria regge, ma i cuscinetti sembrano fragili.
Giudizio: neutra

Recensione: Assistenza pessima, non comprerò più da loro.
Giudizio: negativa

Recensione: [recensione da classificare]
Giudizio:
```

Perché è scritto così:
1. Spiega perché serve una sola parola: il modello capisce il vincolo e non aggiunge frasi di contorno.
2. Tre esempi diversi, tutti con la stessa struttura, fissano il formato meglio di una descrizione.
3. Il prompt finisce con «Giudizio:», così la risposta comincia direttamente dalla parola attesa.

## Spiegare cosa non va in un prompt

Richiesta: Cosa non va in questo prompt? «Sei un esperto molto bravo. Scrivi un'email al cliente, che sia professionale ma anche amichevole, non troppo lunga e nemmeno troppo corta.»

Risposta:
1. Non dice di cosa parla l'email né cosa deve ottenere: senza l'obiettivo il modello scrive un testo generico.
2. Manca il contesto: chi è il cliente e cosa è successo prima.
3. «Non troppo lunga e nemmeno troppo corta» non è una misura. Meglio un numero di frasi o di righe.
4. «Professionale ma amichevole» lascia il tono al caso. Meglio una frase d'esempio scritta nel tono voluto.
5. «Esperto molto bravo» non aggiunge nulla: il ruolo deve dire il mestiere e per chi scrive.

## Quando l'obiettivo non è chiaro

Richiesta: Scrivimi un prompt per il servizio clienti.

Risposta:
Per scriverlo bene mi servono due informazioni:
1. Cosa deve fare il modello: rispondere ai clienti, smistare le richieste, o riassumerle per un operatore?
2. Su cosa si basa: ha una documentazione da cui rispondere, o deve solo indirizzare la richiesta alla persona giusta?
