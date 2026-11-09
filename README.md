# FastChat

App desktop (Electron) per chattare con modelli locali serviti da [Ollama](https://ollama.com).
Ogni conversazione ha un proprio **brief** (ruolo, contesto, obiettivi, vincoli) e proprie impostazioni:
temperatura, ragionamento on/off e plan mode. Lo storico resta in locale.

## Funzionalità

- **Brief → system prompt**: solo le sezioni compilate, nell'ordine Ruolo, Contesto, Obiettivi, Vincoli; ricalcolato a ogni invio, mai troncato.
- **Template**: «Salva come template» nel pannello del brief; «▾» accanto a «Nuova conversazione» per partire da un template.
- **Modello**: temperatura 0–2, `top_p`, `num_ctx`, `seed`; ragionamento on/off (disabilitato se il modello non ha la capability `thinking`), mostrato in un blocco separato e richiudibile.
- **Plan mode**: il modello propone un piano (JSON vincolato da schema); lo modifichi, riordini, approvi; poi risponde seguendolo.
- **Base di conoscenza** (RAG sui documenti, per conversazione): scheda «Conoscenza» nel pannello, documenti PDF, Word, testo e Markdown o una cartella collegata del computer. Se i documenti stanno nello spazio riservato (25/50/75% della memoria, regolabile per conversazione, 50% predefinito) il modello li legge **per intero** a ogni domanda (può contare e sommare); altrimenti riceve i documenti segnati «Intero» e poi gli estratti più pertinenti, scelti con un punteggio ibrido (somiglianza semantica + parole esatte con FTS5: numeri, nomi) fino a riempire il budget. Le fonti («[Relazione, p. 3]») compaiono nel prompt e sotto la risposta. La pill «Usa la base di conoscenza» vale per la conversazione, il bottone libro accanto a «Invia» per la singola domanda. Tutto in locale: embedding con Ollama, vettori e indice FTS in SQLite.
- **Storico**: ricerca (titolo e messaggi), rinomina, archivio, eliminazione; titolo generato dopo il primo scambio; export in Markdown o JSON (con documenti e fonti).
- **Robustezza**: banner con «Riprova» se Ollama non risponde, interruzione con salvataggio del parziale, rigenerazione dell'ultima risposta, storico tagliato al contesto disponibile.

## Requisiti

- Node 22+
- Ollama in esecuzione (default `http://127.0.0.1:11434`, modificabile in ⚙ Impostazioni)

## Comandi

```bash
npm install
npm run dev            # avvio con HMR
npm test               # Vitest: prompt, client Ollama (server NDJSON finto), chat/piani, DB, export
npm run test:e2e       # build + Playwright _electron contro un Ollama finto
                       # (Linux senza display: xvfb-run -a npm run test:e2e)
npm run build          # typecheck + build in out/
npm run dist           # installer per il sistema corrente in dist/ (dmg / nsis / AppImage)
npm run test:packaged  # smoke test dell'app impacchettata (Linux, dopo npm run dist:linux)
npm run db:generate    # rigenera le migrazioni dopo aver cambiato src/main/db/schema.ts
```

Variabili utili: `OLLAMA_URL` sovrascrive l'URL salvato; `FASTCHAT_USER_DATA` cambia la cartella dati;
`FASTCHAT_KNOWLEDGE_FILES` e `FASTCHAT_KNOWLEDGE_FOLDER` saltano i dialog di scelta di file e cartella
(usate dai test).

## Architettura

- `src/main` — processo principale: finestra, IPC (`ipc.ts`), client Ollama (`ollama.ts`), chat e plan mode (`chat.ts`), riassunto (`summary.ts`), memoria della conversazione (`memory.ts`), base di conoscenza (`knowledge/`), embedding condiviso (`embedder.ts`), export (`export.ts`), database (`db/`).
- `src/preload` — espone al renderer solo `window.api` (contratto in `src/shared/api.ts`).
- `src/renderer` — React + Zustand + Tailwind.
- `src/shared` — tipi, canali IPC, `prompt.ts` (system prompt, piano, selezione dello storico), `memory.ts` e `knowledge.ts` (pezzi, scelta degli estratti, budget, sezioni del prompt), `i18n/` (italiano, inglese, francese).
- `drizzle/` — migrazioni SQL generate da drizzle-kit, applicate all'avvio.

**Base di conoscenza e plugin.** Un plugin (`src/main/knowledge/source.ts`) sa leggere un tipo di
sorgente e restituisce testo a sezioni con un locatore (pagina, titolo); il nucleo fa il resto: pezzi,
embedding (stesso modello della memoria a lungo termine, per modello di embedding), indice FTS5 per le parole
esatte, budget (quota di `num_ctx` scelta per conversazione, 50% predefinito, prima della memoria della conversazione), scelta tra
documenti interi ed estratti (punteggio ibrido 0,6 coseno + 0,4 BM25, soglie, tetto per documento che cresce
con il budget), sezione «Base di conoscenza» nel system prompt, fonti sulla risposta, monitor del contesto. Due famiglie: `file` (l'utente
aggiunge file; il plugin dichiara le estensioni) e `connected` (il plugin elenca lui i documenti da una
sorgente configurata: `list()`, versione per documento, «Aggiorna»; il form di configurazione lo disegna il
nucleo dai campi dichiarati, i campi `secret` sono cifrati con `safeStorage`). Integrati: `text`, `pdf`
(pdf.js), `docx` (mammoth), `folder` (cartella del computer, delega ai plugin file). Per aggiungerne uno: un
file in `src/main/knowledge/sources/`, una riga in `sources/index.ts`, l'etichetta nelle tre lingue, un test
con una fixture.

**Database.** SQLite in `userData/chats.db` tramite il modulo integrato `node:sqlite` (Electron 45 / Node 24)
e Drizzle ORM (driver `sqlite-proxy`). Nessun modulo nativo da ricompilare per Electron o da impacchettare.

**Sicurezza.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP limitata a `'self'`;
navigazione e nuove finestre bloccate (i link esterni si aprono nel browser). Le chiamate a Ollama partono dal main.

**Primo avvio su macOS.** Gli installer hanno una firma ad-hoc, non un certificato Apple: al primo
avvio fai clic destro sull'app in Applicazioni → **Apri**, oppure *Impostazioni di Sistema → Privacy e
sicurezza → Apri comunque*. Se macOS dice che l'app è «danneggiata» (versioni fino alla 0.1.8), nel
Terminale: `xattr -cr /Applications/FastChat.app`.

**Packaging.** `electron-builder.yml`; icona in `build/icon.png`. Su macOS firma ad-hoc (gratuita);
Windows senza firma. Per evitare gli avvisi di Gatekeeper e SmartScreen servono un certificato Apple
Developer (firma + notarizzazione) e uno per Windows.

## Release

Il workflow `.github/workflows/release.yml` compila gli installer su macOS (dmg arm64 + x64),
Windows (nsis x64) e Linux (AppImage x64) e li pubblica in una Release GitHub.

```bash
git tag v0.1.0
git push origin v0.1.0
```

- La versione dell'app viene presa dal tag (non serve modificare `package.json`).
- Un tag con trattino (es. `v0.2.0-beta.1`) crea una pre-release.
- Prima della build girano typecheck e test unitari; se falliscono, nessuna release.
- Con l'opzione «skip_macos» la build macOS viene saltata (utile se i runner macOS di GitHub
  restano in coda): la release esce con i soli installer Windows e Linux.
- Da *Actions → Release → Run workflow* con il campo «version» (es. `0.2.0`) si pubblica senza
  creare il tag a mano: lo crea il workflow. Con il campo vuoto si compila senza pubblicare: gli installer restano
  scaricabili come artifact del run per 14 giorni.
