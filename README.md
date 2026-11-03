# FastChat

App desktop (Electron) per chattare con modelli locali serviti da [Ollama](https://ollama.com).
Ogni conversazione ha un proprio **brief** (ruolo, contesto, obiettivi, vincoli) e proprie impostazioni:
temperatura, ragionamento on/off e plan mode. Lo storico resta in locale.

## Funzionalità

- **Brief → system prompt**: solo le sezioni compilate, nell'ordine Ruolo, Contesto, Obiettivi, Vincoli; ricalcolato a ogni invio, mai troncato.
- **Template**: «Salva come template» nel pannello del brief; «▾» accanto a «Nuova conversazione» per partire da un template.
- **Modello**: temperatura 0–2, `top_p`, `num_ctx`, `seed`; ragionamento on/off (disabilitato se il modello non ha la capability `thinking`), mostrato in un blocco separato e richiudibile.
- **Plan mode**: il modello propone un piano (JSON vincolato da schema); lo modifichi, riordini, approvi; poi risponde seguendolo.
- **Storico**: ricerca (titolo e messaggi), rinomina, archivio, eliminazione; titolo generato dopo il primo scambio; export in Markdown o JSON.
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

Variabili utili: `OLLAMA_URL` sovrascrive l'URL salvato; `FASTCHAT_USER_DATA` cambia la cartella dati
(usate dai test).

## Architettura

- `src/main` — processo principale: finestra, IPC (`ipc.ts`), client Ollama (`ollama.ts`), chat e plan mode (`chat.ts`), export (`export.ts`), database (`db/`).
- `src/preload` — espone al renderer solo `window.api` (contratto in `src/shared/api.ts`).
- `src/renderer` — React + Zustand + Tailwind.
- `src/shared` — tipi, canali IPC e `prompt.ts` (system prompt, piano, selezione dello storico).
- `drizzle/` — migrazioni SQL generate da drizzle-kit, applicate all'avvio.

**Database.** SQLite in `userData/chats.db` tramite il modulo integrato `node:sqlite` (Electron 45 / Node 24)
e Drizzle ORM (driver `sqlite-proxy`). Nessun modulo nativo da ricompilare per Electron o da impacchettare.

**Sicurezza.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP limitata a `'self'`;
navigazione e nuove finestre bloccate (i link esterni si aprono nel browser). Le chiamate a Ollama partono dal main.

**Packaging.** `electron-builder.yml`; icona in `build/icon.png`. Gli installer non sono firmati:
su macOS serve la firma/notarizzazione per distribuirli senza avvisi di Gatekeeper.

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
- Da *Actions → Release → Run workflow* si compila senza pubblicare: gli installer restano
  scaricabili come artifact del run per 14 giorni.
