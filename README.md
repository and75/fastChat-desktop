# FastChat

App desktop (Electron) per chattare con modelli locali serviti da [Ollama](https://ollama.com).
Ogni conversazione ha un proprio **brief** (ruolo, contesto, obiettivi, vincoli) e proprie impostazioni:
temperatura, ragionamento on/off e plan mode. Lo storico resta in locale.

> Stato: **fase 2** — conversazioni con brief, chat in streaming, sidebar con ricerca/rinomina/archivio. Prossime: temperatura e ragionamento (3), plan mode (4), template/export/packaging (5).

## Requisiti

- Node 22+
- Ollama in esecuzione (default `http://127.0.0.1:11434`, modificabile dall'app)

## Comandi

```bash
npm install
npm run dev          # avvio con HMR
npm test             # Vitest: prompt, client Ollama (server NDJSON finto), servizio chat, DB in memoria
npm run test:e2e     # build + Playwright _electron contro un Ollama finto
                     # (Linux senza display: xvfb-run -a npm run test:e2e)
npm run db:generate  # rigenera le migrazioni dopo aver cambiato src/main/db/schema.ts
```

Variabili utili: `OLLAMA_URL` sovrascrive l'URL salvato; `FASTCHAT_USER_DATA` cambia la cartella dati.

## Architettura

- `src/main` — processo principale: finestra, IPC, client Ollama (`ollama.ts`), database (`db/`).
- `src/preload` — espone al renderer solo `window.api` (contratto in `src/shared/api.ts`).
- `src/renderer` — React + Zustand + Tailwind.
- `src/shared` — tipi, canali IPC e `prompt.ts` (brief → system prompt, selezione dello storico nel contesto).
- `drizzle/` — migrazioni SQL generate da drizzle-kit, applicate all'avvio.

**Database.** SQLite in `userData/chats.db` tramite il modulo integrato `node:sqlite` (Electron 45 / Node 24)
e Drizzle ORM (driver `sqlite-proxy`). Non c'è nessun modulo nativo da ricompilare per Electron.

**Sicurezza.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP limitata a `'self'`;
navigazione e nuove finestre bloccate (i link esterni si aprono nel browser). Le chiamate a Ollama partono dal main.
