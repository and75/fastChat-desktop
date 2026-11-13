# FastChat

Desktop app (Electron) for chatting with local models served by [Ollama](https://ollama.com).
Each conversation has a **role** (“Talk to a…”), a **situation** written by the user and its own settings:
temperature, reasoning on or off, plan mode. The history stays on the computer.

## Features

- **Roles**: the arrow next to “New conversation” opens “Talk to a…”, with the installed roles; “New conversation” on its own uses the “Generalist” (no instructions). A role brings its own instructions, model settings and knowledge bases; it is adjusted in the “Model” tab through guided choices, in four sections: “Identity and goals”, “Style and format”, “Rules”, “Method”. Each choice adds a sentence to the instructions and may change a model setting (it says so). The role can be changed in an empty conversation; otherwise a new conversation opens, which can start from the summary of the previous one.
- **Situation → system prompt**: in the “Situation” tab you write the context of the conversation, with a character limit tied to the model's memory. The model receives the role's instructions, then the situation; the preview is in the same tab. Recomputed on every send, never truncated.
- **Templates**: “Save as template”, in the “Situation” tab, saves the role, the choices and the situation; it is then found in “Talk to a…”, under the roles.
- **Model**: temperature 0–2, `top_p`, `num_ctx`, `seed`; reasoning on or off (disabled if the model lacks the `thinking` capability), shown in a separate, collapsible block.
- **Plan mode**: the model proposes a plan (JSON constrained by a schema); you edit it, reorder it, approve it; then it answers by following it.
- **Knowledge bases** (RAG over documents): each conversation has its own base, in the “Knowledge” tab, and can link reusable bases from the library (Settings → Knowledge), shared between several conversations. PDF, Word, text and Markdown documents, or a connected folder on the computer. A base is exported and installed as a `.fcpack` package, with the vectors already computed and the embedding model declared; the app ships with a built-in base (“FastChat Guide”). The **Store** (button in the sidebar) shows by category — Roles, Knowledge bases, Plugins, Bundles — what can be installed and what is already there; a role is installed with the bases it requires, and when it exists in several languages you choose which one to install; it reads the catalogue bundled with the app or a repository configured in Settings. If the documents fit in the reserved space (25/50/75% of memory, adjustable per conversation, 50% by default) the model reads them **in full** at every question (it can count and add up); otherwise it receives the documents marked “Whole”, then the most relevant excerpts, chosen with a hybrid score (semantic similarity + exact words with FTS5: numbers, names) until the budget is filled. Sources (“[Report, p. 3]”) appear in the prompt and under the answer. The “Use the knowledge base” switch applies to the conversation, the book button next to “Send” to a single question. Everything is local: embedding with Ollama, vectors and FTS index in SQLite.
- **History**: search (title and messages), rename, archive, delete; title generated after the first exchange; export as Markdown or JSON (with documents and sources).
- **Robustness**: banner with “Retry” if Ollama does not respond, interruption that saves the partial answer, regeneration of the last answer, history trimmed to the available context.

## Requirements

- Node 22+
- Ollama running (default `http://127.0.0.1:11434`, editable in ⚙ Settings)

## Commands

```bash
npm install
npm run dev            # start with HMR
npm test               # Vitest: prompt, Ollama client (fake NDJSON server), chat/plans, database, export
npm run test:e2e       # build + Playwright _electron against a fake Ollama
                       # (Linux without a display: xvfb-run -a npm run test:e2e)
npm run build          # typecheck + build into out/
npm run dist           # installer for the current system in dist/ (dmg / nsis / AppImage)
npm run test:packaged  # smoke test of the packaged app (Linux, after npm run dist:linux)
npm run db:generate    # regenerate the migrations after changing src/main/db/schema.ts
npm run packs:build    # regenerate the built-in packages (packs/) from the documentation
```

Useful variables: `OLLAMA_URL` overrides the saved URL; `FASTCHAT_USER_DATA` changes the data folder;
`FASTCHAT_KNOWLEDGE_FILES` and `FASTCHAT_KNOWLEDGE_FOLDER` skip the file and folder dialogs (used by the tests).

## Architecture

- `src/main` — main process: window, IPC (`ipc.ts`), Ollama client (`ollama.ts`), chat and plan mode (`chat.ts`), summary (`summary.ts`), conversation memory (`memory.ts`), knowledge base (`knowledge/`), shared embedding (`embedder.ts`), export (`export.ts`), database (`db/`).
- `src/preload` — exposes only `window.api` to the renderer (contract in `src/shared/api.ts`).
- `src/renderer` — React + Zustand + Tailwind.
- `src/shared` — types, IPC channels, `roles.ts` (roles: validation, instructions, model settings), `compose.ts` (context composition), `prompt.ts` (system prompt, plan, history selection), `memory.ts` and `knowledge.ts` (chunks, choice of excerpts, budget, prompt sections), `i18n/` (Italian, English, French).
- `drizzle/` — SQL migrations generated by drizzle-kit, applied at start-up.

**Knowledge base and plugins.** A plugin (`src/main/knowledge/source.ts`) knows how to read one type of source and
returns text in sections with a locator (page, heading); the core does the rest: chunks, embedding (same model as
long-term memory, per embedding model), FTS5 index for exact words, budget (share of `num_ctx` chosen per
conversation, 50% by default, before the conversation memory), choice between whole documents and excerpts
(hybrid score 0.6 cosine + 0.4 BM25, thresholds, per-document cap that grows with the budget), “Knowledge base”
section in the system prompt, sources under the answer, context monitor. Two families: `file` (the user adds
files; the plugin declares the extensions) and `connected` (the plugin itself lists the documents of a configured
source: `list()`, version per document, “Refresh”; the configuration form is drawn by the core from the declared
fields, `secret` fields are encrypted with `safeStorage`). Built in: `text`, `pdf` (pdf.js), `docx` (mammoth),
`folder` (a folder on the computer, which delegates to the file plugins). To add one: a file in
`src/main/knowledge/sources/`, a line in `sources/index.ts`, the label in the three languages, a test with a
fixture.

The full mechanism is described in [`knowledge-base.md`](knowledge-base.md).

**Context composition** (Settings → Context): the order in which instructions, summary, memory and documents
reach the model is adjustable (everything in the system prompt, or knowledge next to the question), with an
optional role reminder. The context monitor records, for every call, the order used and the time to the first
fragment, and exports everything as CSV to compare layouts and models.

**Database.** SQLite in `userData/chats.db`, through the built-in `node:sqlite` module (Electron 45 / Node 24)
and Drizzle ORM (`sqlite-proxy` driver). No native module to rebuild for Electron or to package.

**Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP limited to `'self'`;
navigation and new windows blocked (external links open in the browser). Calls to Ollama are made from the main
process.

**First launch on macOS.** The installers have an ad-hoc signature, not an Apple certificate: at first launch,
right-click the app in Applications → **Open**, or *System Settings → Privacy & Security → Open Anyway*. If
macOS says the app is “damaged” (versions up to 0.1.8), in Terminal: `xattr -cr /Applications/FastChat.app`.

**Packaging.** `electron-builder.yml`; icon in `build/icon.png`. On macOS an ad-hoc signature (free); Windows
unsigned. Avoiding the Gatekeeper and SmartScreen warnings needs an Apple Developer certificate (signing +
notarisation) and one for Windows.

## Release

The `.github/workflows/release.yml` workflow builds the installers on macOS (dmg arm64 + x64), Windows (nsis x64)
and Linux (AppImage x64) and publishes them in a GitHub Release.

```bash
git tag v0.1.0
git push origin v0.1.0
```

- The app version is taken from the tag (no need to edit `package.json`).
- A tag with a hyphen (e.g. `v0.2.0-beta.1`) creates a pre-release.
- Typecheck and unit tests run before the build; if they fail, there is no release.
- With the “skip_macos” option the macOS build is skipped (useful when GitHub's macOS runners stay queued): the
  release comes out with the Windows and Linux installers only.
- From *Actions → Release → Run workflow*, with the “version” field (e.g. `0.2.0`), you publish without creating
  the tag by hand: the workflow creates it. With the field empty, it builds without publishing: the installers
  remain downloadable as artifacts of the run for 14 days.
