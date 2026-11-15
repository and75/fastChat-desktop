# Banco di prova dei ruoli

Prova un ruolo di FastChat su uno o più modelli di Ollama, senza aprire l'app: esegue una serie di richieste,
misura i tempi, controlla le risposte con regole fisse e scrive un rapporto.

Usa lo stesso codice con cui l'app costruisce il prompt, quindi prova esattamente ciò che l'app invia. Legge i
testi dai sorgenti del repository (`roles/`, `store/sources/`): non servono build né installer.

## Cosa serve

- Node 22 e `npm install` in questa cartella.
- Ollama avviato, con il modello da provare e il modello di embedding (`ollama pull embeddinggemma`).

## Uso

```bash
npm run bench -- --dry-run                         # elenca i casi e stima i tempi, senza chiamare nulla
npm run bench -- --models gemma4:e4b               # tutti i casi dell'Esperto di prompt engineering
npm run bench -- --models gemma4:e4b,gemma4:12b    # confronto tra modelli
npm run bench -- --models gemma4:e4b --think off   # stessa prova con il ragionamento spento
npm run bench -- --models gemma4:e4b --num-ctx 8192 --cases racconto-subito,lavoro-vago
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

## Limiti

- **Tempi**: a circa 10 token al secondo un caso dura due o tre minuti. Con `--dry-run` si vede la stima.
- **Rumore**: il modello lavora alla temperatura fissata dal ruolo; con una sola ripetizione le differenze
  piccole non contano. `--reps` le riduce.
- **Memoria**: il banco usa la memoria indicata con `--num-ctx`, non quella che l'app suggerisce per la
  macchina. Per riprodurre una conversazione dell'app, passa lo stesso valore.
