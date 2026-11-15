# Banco di prova dei ruoli

Prova un ruolo di FastChat su uno o più modelli di Ollama, senza aprire l'app: esegue una serie di richieste,
misura i tempi, controlla le risposte con regole fisse e scrive un rapporto. Con una chiave Anthropic, Claude
giudica ogni risposta e, se richiesto, corregge i testi del ruolo e li riprova.

Usa lo stesso codice con cui l'app costruisce il prompt, quindi prova esattamente ciò che l'app invia. Legge i
testi dai sorgenti del repository (`roles/`, `store/sources/`): non servono build né installer.

## Cosa serve

- Node 22 e `npm install` in questa cartella.
- Ollama avviato, con il modello da provare e il modello di embedding (`ollama pull embeddinggemma`).
- Per il giudizio e la correzione: una chiave Anthropic nella variabile d'ambiente `ANTHROPIC_API_KEY`.
  Su Windows (PowerShell): `$env:ANTHROPIC_API_KEY = "…"` nella stessa finestra in cui si lancia il comando.
  La chiave non va scritta in nessun file del repository; il banco non la salva né la stampa.

## Uso

```bash
npm run bench -- --dry-run                         # elenca i casi e stima i tempi, senza chiamare nulla
npm run bench -- --models gemma4:e4b               # tutti i casi dell'Esperto di prompt engineering
npm run bench -- --models gemma4:e4b,gemma4:12b    # confronto tra modelli
npm run bench -- --models gemma4:e4b --think off   # stessa prova con il ragionamento spento
npm run bench -- --models gemma4:e4b --num-ctx 8192 --cases racconto-subito,lavoro-vago
npm run bench -- --models gemma4:e4b --rounds 2    # misura, poi due giri di «correggi e riprova»
npm run bench -- --apply bench/runs/<data>         # porta nei sorgenti la variante migliore di quel giro
```

| Opzione | Significato | Predefinito |
|---|---|---|
| `--role` | Ruolo da provare, come il file in `roles/` | `prompt.it` |
| `--models` | Modelli di Ollama, separati da virgola | quello consigliato dal ruolo |
| `--cases` | Solo questi casi | tutti |
| `--reps` | Ripetizioni di ogni caso | 1 |
| `--think` | `role` (come lo fissa il ruolo), `on`, `off` | `role` |
| `--num-ctx` | Memoria della conversazione, in token | 16384 |
| `--variant` | Prova una variante salvata invece dei testi del repository | — |
| `--judge-model` | Modello Anthropic che giudica e corregge | `claude-opus-5-5` |
| `--no-judge` | Solo misure e controlli, anche se c'è una chiave | — |
| `--rounds` | Giri di «correggi e riprova» dopo la prima misura | 0 |
| `--apply` | Copia nei sorgenti la variante migliore di un giro già fatto, e termina | — |
| `--url` | Indirizzo di Ollama | `OLLAMA_URL` o `http://127.0.0.1:11434` |
| `--out` | Cartella dei risultati; se esiste già, riprende da dove si era fermato | `bench/runs/<data>` |

## Cosa produce

In `bench/runs/<data>/` (cartella ignorata da git):

- `report.md`: i numeri per variante e modello, poi ogni caso con le battute, le misure e i controlli falliti.
  È il file da leggere e da condividere.
- `results.jsonl`: una riga per caso, con il prompt esatto inviato, la risposta, il ragionamento e le misure.
- `variants/<nome>/`: i testi provati (ruolo e basi), così ogni giro resta rileggibile.

## I casi di prova

Stanno in `bench/cases/<ruolo>.json`. Ogni caso ha una richiesta, le scelte del ruolo diverse dai predefiniti e
ciò che ci si aspetta: `prompt` (scrive subito), `ask` (fa domande; con `reply` la conversazione prosegue),
`diagnosis` (elenca i problemi senza riscrivere).

I casi sono divisi in due gruppi. Su quelli «di lavoro» (`train`) si leggono gli errori e si correggono i
testi; quelli «di controllo» (`test`) servono solo a misurare, e il confronto tra versioni si fa su questi.

## I controlli a regole fisse

Dicono se la risposta rispetta le scelte del ruolo: prompt in un blocco di codice, domande quando la richiesta è
vaga, nessun esempio se la tecnica non è scelta, niente titoli di sezione in un messaggio da incollare,
spiegazione in tre punti (o assente), ipotesi dichiarate con «Risponde subito», niente delimitatori né regole
sul dato mancante nei compiti creativi. Sono in `bench/checks.ts`. Non giudicano la qualità del prompt.

## Il giudice

Con una chiave Anthropic, dopo ogni caso Claude riceve ciò che ci si aspettava, le istruzioni del ruolo che il
modello ha ricevuto, la conversazione e l'esito dei controlli, e dà un voto da 1 a 5 su cinque criteri:
comportamento, aderenza alle scelte, qualità del prompt, fedeltà alla richiesta, naturalezza. La griglia è in
`bench/judge.ts`. Se la chiave manca o Anthropic non risponde, il banco prosegue senza voti e lo dice.

## Correggi e riprova

Con `--rounds N` il banco:

1. misura la variante di partenza su tutti i casi, poi la riesegue sui soli casi di controllo: la differenza tra
   le due esecuzioni è il rumore, sotto il quale un miglioramento non conta;
2. a ogni giro chiede a Claude una nuova versione dei testi, mostrandogli **solo i casi di lavoro**;
3. prova la nuova versione su tutti i casi e la tiene **solo se migliora sui casi di controllo** oltre il rumore;
   il giro successivo parte dalla migliore.

Il correttore può cambiare l'istruzione fissa del ruolo, le frasi delle opzioni e i documenti delle basi
(tecniche, esempi). Non può cambiare parametri, opzioni, predefiniti né effetti sulla mente: una proposta che
tocca la struttura, non supera i controlli dei ruoli o stravolge un documento viene scartata prima della prova.

Alla fine `report.md` racconta ogni giro (diagnosi, modifiche, esito). Se una variante ha vinto, trovi anche
`proposal.diff` con le differenze rispetto ai testi di partenza. **Nulla viene scritto nei sorgenti** finché non
lanci `--apply`. Dopo l'applicazione restano da fare a mano la rilettura, l'allineamento delle altre lingue e
`npm run packs:build`.

## Cosa esce dal computer, e quanto costa

- Le chiamate ai modelli locali restano sul computer.
- Ad Anthropic vanno, per il giudizio: le richieste di prova, le istruzioni del ruolo e le risposte dei modelli.
  Per la correzione: tutti i testi del ruolo e i risultati dei casi di lavoro. Sono testi di prova, senza dati
  personali; non metterne nei casi.
- Costo: una richiesta al giudice per caso, una al correttore per giro. Alla fine il banco stampa richieste e
  token usati; per un ciclo completo con due giri la stima è di pochi dollari.

## Limiti

- **Tempi**: a circa 10 token al secondo un caso dura due o tre minuti. Con `--dry-run` si vede la stima.
- **Rumore**: il modello lavora alla temperatura fissata dal ruolo; con una sola ripetizione le differenze
  piccole non contano. `--reps` le riduce.
- **Il giudice non è infallibile**: i controlli a regole fisse gli stanno accanto, e la variante migliore va
  comunque riletta prima di applicarla. Con pochi casi di controllo un miglioramento piccolo può essere fortuna:
  più casi e più ripetizioni lo rendono credibile.
- **Una lingua per volta**: il ciclo lavora sui testi di una lingua (per esempio `prompt.it`); le altre si
  allineano dopo.
- **Memoria**: il banco usa la memoria indicata con `--num-ctx`, non quella che l'app suggerisce per la
  macchina. Per riprodurre una conversazione dell'app, passa lo stesso valore.
