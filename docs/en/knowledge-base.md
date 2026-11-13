# Knowledge base: how RAG over documents works

Reference for the mechanism, aligned with the code (`src/main/knowledge/`, `src/shared/knowledge.ts`,
`src/main/chat.ts`). When the code changes, update this page too.

## 0. Knowledge bases

- A **base** is a set of documents (`knowledge_bases` table). Documents and connected sources belong to a
  base, not to a conversation.
- **Conversation base** (`origin: 'conversation'`): one per conversation, its own only, for the documents the
  user adds from the “Knowledge” tab. It is created with the first document and deleted with the conversation.
- **Library bases** (`origin: 'local'`, and `'package'` for those installed from a package): they are created
  and managed in Settings → Knowledge, and **linked** to as many conversations as you like
  (`conversation_bases`). Documents are indexed only once. A role brings its own bases: they arrive already
  linked to the conversations that use it (see 0.4).
- A conversation uses **the union**: its own base plus the linked ones. Search, budget and whole documents
  apply to the set; sources show the name of the base when the document comes from the library.
- From the conversation, linked bases can only be linked and unlinked: documents, “Whole” and sources are
  edited in the library and apply to every conversation that links the base.
- Deleting a base from the library (with a confirmation that says how many conversations use it) removes it
  from all of them, with its documents and chunks; the conversations' own documents stay.
- Embedding calls for a conversation's documents go into its context monitor and follow the CPU/GPU of its
  model; those for library bases belong to no conversation.

## 0.1 Embedding model per base

- A base has an **effective embedding model**: the one in Settings (conversation base, local bases, text-only
  packages) or the one **declared by the package** that brought the vectors.
- Bases using the Settings model are re-indexed when it changes; those with a declared model have fixed
  vectors and are left alone.
- To use a base, its model must be installed in Ollama: otherwise the base stays installed but inactive, with
  the notice that the model is required and the download.
- A conversation can have bases with different models: the question becomes a vector **once per model**
  (normally just one), scores are computed per group and the choice of excerpts is a single one. When the
  documents go to the model in full, no embedding of the question is needed.

## 0.2 Packages (.fcpack)

The format in which a base is exported, installed and distributed from the Store. It is a zip:

| File | Content |
|---|---|
| `manifest.json` | id, type (`knowledge` for a base, `identity` for a role; `bundle` is reserved), group of language variants, name, version, author, language, licence, **declared embedding model** (name, dimensions, fingerprint), SHA-256 fingerprint of every file |
| `knowledge.json` | documents and chunks with locator: the text is always there (sources, word search) |
| `vectors.bin` | float32 vectors of the chunks, in chunk order; absent in text-only packages |
| `role.json` | definition of a role (`identity` packages): instructions, model settings, parameters, required bases |
| `signature.json` | Ed25519 signature of the manifest, which fixes the fingerprint of the other files |

- **With vectors** (the normal case, default model `embeddinggemma`): on installation the chunks are ready at
  once, with no calls to Ollama; the base is tied to the declared model.
- **Text-only**: documents are indexed with the user's model; if it is missing they wait (“Waiting”) and
  resume when the model is downloaded. A copy of the package stays in `userData/packs/`.
- **Trust**: `verified` (signature by a key in `src/main/knowledge/trust.ts`), `unsigned`, `unknown` (signed
  by an unknown key), `builtin` (built into the app). Without a verified signature, installation asks for an
  explicit confirmation. A tampered package (fingerprints or signature that do not match) is not installed.
- **Update**: same id, new version → the base stays the same (and stays linked), the content is replaced.
- Bases installed from a package are **read-only**; “Whole” can still be changed.
- **Export** (Settings → Knowledge): local bases only, with all documents ready; the package carries the
  vectors of the base's model, declared in the manifest with dimensions and fingerprint.
- **Built-in packages**: the files in `packs/` are installed or updated at start-up (`npm run packs:build`
  regenerates them from the documentation). Today: “FastChat Guide”, text-only, and the roles included in the
  app.
- **Roles**: an `identity` package is installed with the bases the role requires (other packages, looked for
  next to the file or in the Store catalogue). If a base is missing the role works anyway, and the
  “Knowledge” tab reports it. When the role is removed, the bases that came with it go only if no other role
  requires them.
- **Link to new conversations**: an option per library base; new conversations find it already linked.
- Signing: `node scripts/pack-keys.mjs <id>` generates the key pair; the public key goes into `trust.ts`, the
  private key stays with the publisher.

## 0.3 Store

A window above the chat, opened with the “Store” button in the sidebar (above the row with the settings).

- **Categories**, in order: Roles, Knowledge bases, Plugins, Bundles (which group several items).
- **States**: Installed · Update available · Available · Coming soon. The built-in Guide shows as installed on opening.
- **Knowledge bases and roles can be installed**; plugins are in the catalogue but cannot be installed. A role is installed with the bases it requires, taken from the same catalogue. A bundle installs what it contains.
- **Languages**: items with the same `group` are a single card, with “Available in:” to choose the variant. Search looks at the title and description of all variants; next to the search is the language filter.
- **Titles and descriptions of bases in the interface language** (it/en/fr): in the catalogue (`name`, `summary` per language) and in the package manifest (`i18n`), so they also apply in the library, linked bases and sources. The content stays in the package's language. A role is written in one language only: its title and description are in that language.
- **Catalogue**: if “Store repository” (Settings → General) is empty, the one bundled with the app is used (`store/catalog.json`, generated by `npm run packs:build`); otherwise `GET {url}/catalog.json` and `GET {url}/{file}`. If the repository does not respond, the local catalogue is shown with the reason.
- **Who manages what**: what belongs to the Store (catalogue items, built-in base and roles) is installed, updated and removed only from the Store. In Settings → Knowledge those bases show “Manage in the Store” instead of “Delete base”, and “Import package…” refuses a file with the id of a Store item. Settings manages the bases created by the user and the packages imported from a file.
- **Security**: SHA-256 fingerprint of the file compared with the catalogue; from the repository only packages with a recognised signature are installed; those in the catalogue bundled with the app are trusted like the Guide.

Catalogue item:

```json
{ "id": "it.fastchat.prompt", "type": "knowledge", "version": "1.0.0",
  "name": { "it": "Scrivere buoni prompt", "en": "Writing good prompts", "fr": "Écrire de bons prompts" },
  "summary": { "it": "…", "en": "…", "fr": "…" },
  "author": "FastChat", "language": "it", "price": 0,
  "embedding": { "model": "embeddinggemma", "dimensions": 768 },
  "file": "items/it.fastchat.prompt/1.0.0.fcpack", "sha256": "…", "size": 2341 }
```

Other fields: `builtin` (built in), `group` (language variants), `model` (roles: recommended or required model), `requires`, `contains` (bundles).

## 0.4 Types of base in a conversation

A base linked to a conversation has a **purpose** (`conversation_bases.purpose`):

| Purpose | Content | When it enters the prompt | Sources under the answer |
|---|---|---|---|
| `documents` (default) | The content to answer from | Only with the switch or the book button on, as always | Yes |
| `behavior` | The role's techniques and rules | Always | No |
| `examples` | Well-made answers to imitate, each between `<example>…</example>` | Always | No |

- Documents added to the conversation are always `documents`.
- A role's bases arrive with their purpose, declared by the role. In the “Knowledge” tab they are kept apart,
  under “From the role”, read-only and without unlinking.
- For the other linked bases the purpose is chosen on the base, in the “Knowledge” tab.
- **Shares**: the knowledge space (25/50/75% of memory) is divided between the three purposes according to the
  shares in Settings (20/20/60 by default). What one purpose does not use goes to the others, documents first:
  with only `documents` bases the behaviour is the same as ever.
- The count of ready documents and the book button consider documents only.

Full design of roles (in Italian): [`ruoli.md`](../ruoli.md) and [`ruoli-piano.md`](../ruoli-piano.md).

## 1. Input: plugins

- A plugin (`KnowledgeSource`, in `src/main/knowledge/source.ts`) knows how to read one type of source and
  returns **text in sections with a locator** (page, heading). It does nothing else: chunks, embedding,
  search, prompt and interface belong to the core.
- `file` plugins (the user adds files from the dialog or by dragging them):
  - `text`: txt and similar in one section; Markdown split at headings, locator = chain of headings;
  - `pdf` (pdf.js): one section per page, locator “p. N”; scans without text → error, no OCR;
  - `docx` (mammoth): HTML → Markdown → sections at headings.
- `connected` plugins (the source itself lists the documents):
  - `folder`: a folder on the computer, subfolders up to 4 levels, at most 500 files, hidden folders and
    `node_modules` excluded; it delegates reading to the `file` plugins; version = date and size; “Refresh”
    adds new files, redoes changed ones, removes those that are gone; “Disconnect” removes everything.
  - The configuration form is drawn by the core from the fields declared by the plugin (text, folder,
    secret); secret fields are encrypted with `safeStorage`.
- Registry: `createBuiltinRegistry()` in `src/main/knowledge/sources/index.ts`. To add a plugin: a file in
  the folder, a line in the registry, the label in the three languages, a test with a fixture.

## 2. Indexing (once per document, in the background)

1. SHA-256 fingerprint of the file: the same file does not enter the same base twice.
2. The plugin extracts the sections; limit of 25 MB per file and 2 million characters of text.
3. Each section is split by paragraphs into **chunks of at most 1,600 characters** (~400 tokens); each chunk
   inherits the section's locator.
4. **Embedding** with Ollama, in batches of 16, with the **dedicated embedding model** chosen in Settings
   (`embeddingModel`, default `embeddinggemma`). It is not the conversation's model: it is the same model
   used by long-term memory. Only the CPU/GPU execution is taken from the chat model (`num_gpu = 0` if the
   chat runs on CPU only), so that Ollama does not reload the models.
5. Vectors go into SQLite (`knowledge_chunks`) **per embedding model**: when the model changes the documents
   are re-indexed; vectors from different models are never compared.
6. The text of the chunks also enters the **FTS5** index (`knowledge_fts`, BM25, accents ignored), kept in
   step by triggers on insert and delete.
7. State per document: `pending` → `indexing` (with progress) → `ready` or `error` (with the reason, “Retry
   indexing” available). A question uses only `ready` documents. Every embedding call is recorded in the
   context monitor (`embed-doc`).

## 3. When the search runs

At every question, if both conditions hold:

- the conversation's “Use the knowledge base” **switch** is on, **or** the **book button** next to “Send” is
  on for this question (the choice on the question wins over the conversation's);
- there is at least one `ready` document with chunks for the current embedding model, in the conversation
  base or in a linked base.

The book button's choice is saved on the user's message: “Regenerate” repeats it.

## 4. Budget: how much space in the prompt

```
budget = min( share × num_ctx ,
              num_ctx − reserve for the answer (20%) − role instructions − situation − style − summary − recent history − question )
```

- **Share** per conversation, in the “Knowledge” tab: 25%, **50% (default)**, 75%.
- The budget is a ceiling: in an already long conversation the documents may get less than the share.
- After the documents, the conversation memory (excerpts of the summarised messages) takes at most 12% of
  what is left. Below 64 tokens nothing is searched.

## 5. Choice of content, in order

1. **Everything in full.** If the sum of the chunks of all ready documents fits in the budget, they go to the
   model complete, in document and position order. The section's introduction says the documents are
   complete: the model can count, compare and add up.
2. **“Whole” documents** (pin button on the document). They go in full as long as they fit in the budget,
   before everything else. If they exceed it on their own, the tab warns that they will be cut.
3. **Excerpts** in the space that remains:
   - a single embedding of the question (text of the question + last 500 characters of the previous answer),
     shared with the conversation memory;
   - FTS5 exact-word search on the question (words of at least 3 letters and numbers);
   - **hybrid score** = 0.6 × cosine + 0.4 × BM25 normalised on the best (the BM25 part counts only if some
     chunk has a significant score);
   - thresholds: score ≥ 0.25 and ≥ 50% of the best;
   - cap per document = max(2, budget in chunks ÷ number of documents): it grows with the budget and shrinks
     with the number of documents;
   - the budget is filled in score order; no fixed limit on the number of excerpts.

## 6. In the prompt

- `# Knowledge base` section, in the system prompt after role instructions, situation, style, summary and
  conversation memory. Before it come, if present, the role's techniques (`# How to work`) and examples
  (`# Examples`).
- Introduction for “complete documents” or for “excerpts” (and a linking sentence when both are present);
  then each entry as `[Title, p. N]` followed by the text.
- Instructions to the model: answer from the documents when they concern the question, cite the source in
  square brackets, say clearly when the information is not there.
- Texts in the role's language; for the Generalist, in the interface language (Italian, English, French).

## 7. After the answer

- **Sources** saved on the message (`knowledgeRefs`) and shown under the answer: title, locator, score or
  “whole document”.
- Context monitor: “Document excerpts” entry in the answer call, `embed-query` and `embed-doc` calls with
  Ollama's counts.
- Markdown and JSON export with the list of documents, the choice on the question and the sources per answer.

## 8. Interface

- **Settings → Knowledge**: library of bases (create, rename, delete) and documents of each base, with the
  same commands as the tab.
- **“Knowledge”** tab in the side panel: “From the role” bases, “Use the knowledge base” switch, space
  selector, “Linked knowledge bases” (link, unlink), adding files and drag & drop, “Connect: …” for connected
  sources, list of documents with state, “Whole”, “Retry indexing”, removal; status line with indexed chunks
  and model; a line saying whether the documents fit in the reserved space and, if not, how much memory would
  be needed.
- **Book button** next to “Send”: shows whether the next question will use the documents; one click flips it
  for that question; disabled with no ready documents.
- “What it remembers” group in the Model panel: summary line with a link to the tab.

## 9. Known limits

- Questions about the whole set of documents (“how many are there?”, “the total?”) work only when the
  documents go to the model in full (case 1): otherwise there are no words that select them. The tab says how
  much memory would be needed. Totals and counts over many documents would need a structured extractor
  (fields per type of document), not built yet.
- Cosine search is in JavaScript over all the conversation's chunks: it copes with thousands of chunks, not
  tens of thousands.
- No reranker, no OCR, no automatic synchronisation of connected folders. External plugins loaded from disk:
  provided for by the contract, not built.

## Variables for tests

- `FASTCHAT_KNOWLEDGE_FILES`: paths (separated by `:`; `;` on Windows) added in place of the dialog.
- `FASTCHAT_KNOWLEDGE_FOLDER`: folder returned in place of the folder dialog.
- `FASTCHAT_PACK_FILE` / `FASTCHAT_PACK_EXPORT`: package to import / path to export to, in place of the dialogs.
