# FastChat

Application de bureau (Electron) pour discuter avec des modèles locaux servis par [Ollama](https://ollama.com).
Chaque conversation a un **rôle** (« Parler avec un… »), une **situation** écrite par l'utilisateur et ses propres
réglages : température, raisonnement activé ou non, mode plan. L'historique reste en local.

## Fonctionnalités

- **Rôles** : la flèche à côté de « Nouvelle conversation » ouvre « Parler avec un… », avec les rôles installés ; « Nouvelle conversation » seule utilise le « Généraliste » (aucune instruction). Un rôle apporte ses instructions, ses réglages du modèle et ses bases de connaissances ; il se règle dans l'onglet « Modèle » par des choix guidés, en quatre sections : « Identité et objectifs », « Style et format », « Règles », « Méthode ». Chaque choix ajoute une phrase aux instructions et peut modifier un réglage du modèle (il le signale). Le rôle se change dans une conversation vide ; sinon une nouvelle conversation s'ouvre, qui peut partir du résumé de la précédente.
- **Situation → prompt système** : dans l'onglet « Situation », on écrit le contexte de la conversation, avec une limite de caractères liée à la mémoire du modèle. Le modèle reçoit les instructions du rôle, puis la situation ; l'aperçu se trouve dans le même onglet. Recalculé à chaque envoi, jamais tronqué.
- **Modèles de conversation** : « Enregistrer comme modèle », dans l'onglet « Situation », enregistre le rôle, les choix et la situation ; on le retrouve dans « Parler avec un… », sous les rôles.
- **Modèle** : température 0–2, `top_p`, `num_ctx`, `seed` ; raisonnement activé ou non (désactivé si le modèle n'a pas la capacité `thinking`), affiché dans un bloc séparé et repliable.
- **Mode plan** : le modèle propose un plan (JSON contraint par un schéma) ; on le modifie, on le réordonne, on l'approuve ; puis il répond en le suivant.
- **Bases de connaissances** (RAG sur les documents) : chaque conversation a sa base, dans l'onglet « Connaissances », et peut lier des bases réutilisables de la bibliothèque (Paramètres → Connaissances), partagées entre plusieurs conversations. Documents PDF, Word, texte et Markdown, ou un dossier connecté de l'ordinateur. Une base s'exporte et s'installe sous forme de paquet `.fcpack`, avec les vecteurs déjà calculés et le modèle d'embedding déclaré ; l'application est livrée avec une base intégrée (« Guide de FastChat »). Le **Store** (bouton dans la barre latérale) montre par catégories — Rôles, Bases de connaissances, Plugins, Packs — ce que l'on peut installer et ce qui est déjà là ; un rôle s'installe avec les bases qu'il requiert, et quand il existe en plusieurs langues on choisit laquelle installer ; il lit le catalogue inclus dans l'application ou un dépôt configuré dans les Paramètres. Si les documents tiennent dans l'espace réservé (25/50/75 % de la mémoire, réglable par conversation, 50 % par défaut), le modèle les lit **en entier** à chaque question (il peut compter et additionner) ; sinon il reçoit les documents marqués « Entier », puis les extraits les plus pertinents, choisis avec un score hybride (similarité sémantique + mots exacts avec FTS5 : nombres, noms) jusqu'à remplir le budget. Les sources (« [Rapport, p. 3] ») apparaissent dans le prompt et sous la réponse. L'interrupteur « Utiliser la base de connaissances » vaut pour la conversation, le bouton livre à côté de « Envoyer » pour une seule question. Tout se fait en local : embedding avec Ollama, vecteurs et index FTS dans SQLite.
- **Historique** : recherche (titre et messages), renommage, archivage, suppression ; titre généré après le premier échange ; export en Markdown ou en JSON (avec les documents et les sources).
- **Robustesse** : bandeau avec « Réessayer » si Ollama ne répond pas, interruption avec enregistrement de la réponse partielle, régénération de la dernière réponse, historique coupé selon le contexte disponible.

## Prérequis

- Node 22+
- Ollama en cours d'exécution (par défaut `http://127.0.0.1:11434`, modifiable dans ⚙ Paramètres)

## Commandes

```bash
npm install
npm run dev            # démarrage avec HMR
npm test               # Vitest : prompt, client Ollama (faux serveur NDJSON), chat/plans, base de données, export
npm run test:e2e       # build + Playwright _electron contre un faux Ollama
                       # (Linux sans écran : xvfb-run -a npm run test:e2e)
npm run build          # vérification des types + build dans out/
npm run dist           # installeur pour le système courant dans dist/ (dmg / nsis / AppImage)
npm run test:packaged  # test rapide de l'application empaquetée (Linux, après npm run dist:linux)
npm run db:generate    # régénère les migrations après une modification de src/main/db/schema.ts
npm run packs:build    # régénère les paquets intégrés (packs/) à partir de la documentation
```

Variables utiles : `OLLAMA_URL` remplace l'URL enregistrée ; `FASTCHAT_USER_DATA` change le dossier des données ;
`FASTCHAT_KNOWLEDGE_FILES` et `FASTCHAT_KNOWLEDGE_FOLDER` évitent les boîtes de dialogue de choix de fichiers et de
dossier (utilisées par les tests).

## Architecture

- `src/main` — processus principal : fenêtre, IPC (`ipc.ts`), client Ollama (`ollama.ts`), chat et mode plan (`chat.ts`), résumé (`summary.ts`), mémoire de la conversation (`memory.ts`), base de connaissances (`knowledge/`), embedding partagé (`embedder.ts`), export (`export.ts`), base de données (`db/`).
- `src/preload` — n'expose au renderer que `window.api` (contrat dans `src/shared/api.ts`).
- `src/renderer` — React + Zustand + Tailwind.
- `src/shared` — types, canaux IPC, `roles.ts` (rôles : validation, instructions, réglages du modèle), `compose.ts` (composition du contexte), `prompt.ts` (prompt système, plan, sélection de l'historique), `memory.ts` et `knowledge.ts` (morceaux, choix des extraits, budget, sections du prompt), `i18n/` (italien, anglais, français).
- `drizzle/` — migrations SQL générées par drizzle-kit, appliquées au démarrage.

**Base de connaissances et plugins.** Un plugin (`src/main/knowledge/source.ts`) sait lire un type de source et
renvoie du texte en sections avec un repère (page, titre) ; le noyau fait le reste : morceaux, embedding (même
modèle que la mémoire à long terme, par modèle d'embedding), index FTS5 pour les mots exacts, budget (part de
`num_ctx` choisie par conversation, 50 % par défaut, avant la mémoire de la conversation), choix entre documents
entiers et extraits (score hybride 0,6 cosinus + 0,4 BM25, seuils, plafond par document qui augmente avec le
budget), section « Base de connaissances » dans le prompt système, sources sous la réponse, moniteur du contexte.
Deux familles : `file` (l'utilisateur ajoute des fichiers ; le plugin déclare les extensions) et `connected` (le
plugin liste lui-même les documents d'une source configurée : `list()`, version par document, « Actualiser » ; le
formulaire de configuration est dessiné par le noyau à partir des champs déclarés, les champs `secret` sont
chiffrés avec `safeStorage`). Intégrés : `text`, `pdf` (pdf.js), `docx` (mammoth), `folder` (dossier de
l'ordinateur, qui délègue aux plugins de fichiers). Pour en ajouter un : un fichier dans
`src/main/knowledge/sources/`, une ligne dans `sources/index.ts`, le libellé dans les trois langues, un test avec
un fichier d'exemple.

Le mécanisme complet est décrit dans [`base-de-connaissances.md`](base-de-connaissances.md).

**Composition du contexte** (Paramètres → Contexte) : l'ordre dans lequel instructions, résumé, mémoire et
documents arrivent au modèle est réglable (tout dans le prompt système, ou les connaissances à côté de la
question), avec un rappel du rôle en option. Le moniteur du contexte enregistre pour chaque appel l'ordre utilisé
et le délai avant le premier fragment, et exporte le tout en CSV pour comparer les dispositions et les modèles.

**Base de données.** SQLite dans `userData/chats.db`, avec le module intégré `node:sqlite` (Electron 45 / Node 24)
et Drizzle ORM (pilote `sqlite-proxy`). Aucun module natif à recompiler pour Electron ni à empaqueter.

**Sécurité.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` ; CSP limitée à `'self'` ;
navigation et nouvelles fenêtres bloquées (les liens externes s'ouvrent dans le navigateur). Les appels à Ollama
partent du processus principal.

**Premier lancement sur macOS.** Les installeurs ont une signature ad hoc, pas un certificat Apple : au premier
lancement, faites un clic droit sur l'application dans Applications → **Ouvrir**, ou bien *Réglages Système →
Confidentialité et sécurité → Ouvrir quand même*. Si macOS indique que l'application est « endommagée » (versions
jusqu'à la 0.1.8), dans le Terminal : `xattr -cr /Applications/FastChat.app`.

**Empaquetage.** `electron-builder.yml` ; icône dans `build/icon.png`. Sur macOS, signature ad hoc (gratuite) ;
Windows sans signature. Pour éviter les avertissements de Gatekeeper et de SmartScreen, il faut un certificat
Apple Developer (signature + notarisation) et un certificat pour Windows.

## Publication

Le workflow `.github/workflows/release.yml` compile les installeurs sur macOS (dmg arm64 + x64), Windows (nsis
x64) et Linux (AppImage x64) et les publie dans une Release GitHub.

```bash
git tag v0.1.0
git push origin v0.1.0
```

- La version de l'application est prise du tag (inutile de modifier `package.json`).
- Un tag avec un tiret (par exemple `v0.2.0-beta.1`) crée une préversion.
- Avant le build, la vérification des types et les tests unitaires s'exécutent ; s'ils échouent, aucune publication.
- Avec l'option « skip_macos », le build macOS est ignoré (utile si les runners macOS de GitHub restent en file
  d'attente) : la publication sort avec les seuls installeurs Windows et Linux.
- Depuis *Actions → Release → Run workflow*, avec le champ « version » (par exemple `0.2.0`), on publie sans créer
  le tag à la main : le workflow le crée. Avec le champ vide, on compile sans publier : les installeurs restent
  téléchargeables comme artefacts de l'exécution pendant 14 jours.
