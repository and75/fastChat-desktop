# Base de connaissances : comment fonctionne le RAG sur les documents

Référence du mécanisme, alignée sur le code (`src/main/knowledge/`, `src/shared/knowledge.ts`,
`src/main/chat.ts`). Quand le code change, mettre aussi cette page à jour.

## 0. Bases de connaissances

- Une **base** est un ensemble de documents (table `knowledge_bases`). Les documents et les sources connectées
  appartiennent à une base, pas à une conversation.
- **Base de la conversation** (`origin: 'conversation'`) : une par conversation, rien qu'à elle, pour les documents
  que l'utilisateur ajoute depuis l'onglet « Connaissances ». Elle naît au premier document et est supprimée avec
  la conversation.
- **Bases de la bibliothèque** (`origin: 'local'`, et `'package'` pour celles installées depuis un paquet) : elles
  se créent et se gèrent dans Paramètres → Connaissances, et se **lient** à autant de conversations que l'on veut
  (`conversation_bases`). Les documents ne sont indexés qu'une fois. Un rôle apporte ses propres bases : elles
  arrivent déjà liées aux conversations qui l'utilisent (voir 0.4).
- Une conversation utilise **l'union** : sa base plus celles qui lui sont liées. Recherche, budget et documents
  entiers valent pour l'ensemble ; les sources indiquent le nom de la base quand le document vient de la
  bibliothèque.
- Depuis la conversation, les bases liées ne peuvent qu'être liées ou déliées : documents, « Entier » et sources
  se modifient dans la bibliothèque et valent pour toutes les conversations qui lient la base.
- Supprimer une base de la bibliothèque (avec une confirmation qui dit combien de conversations l'utilisent) la
  fait disparaître de toutes, avec ses documents et ses morceaux ; les documents propres aux conversations restent.
- Les appels d'embedding des documents d'une conversation vont dans son moniteur du contexte et suivent le
  CPU/GPU de son modèle ; ceux des bases de la bibliothèque n'appartiennent à aucune conversation.

## 0.1 Modèle d'embedding par base

- Une base a un **modèle d'embedding effectif** : celui des Paramètres (base de la conversation, bases locales,
  paquets de texte seul) ou celui **déclaré par le paquet** qui a apporté les vecteurs.
- Les bases qui utilisent le modèle des Paramètres sont réindexées quand on le change ; celles qui ont un modèle
  déclaré ont des vecteurs fixes et ne sont pas touchées.
- Pour utiliser une base, son modèle doit être installé dans Ollama : sinon elle reste installée mais inactive,
  avec l'avertissement « le modèle X est nécessaire » et le téléchargement.
- Une conversation peut avoir des bases avec des modèles différents : la question devient un vecteur **une fois
  par modèle** (en général un seul), les scores se calculent par groupe et le choix des extraits est unique.
  Quand les documents vont au modèle en entier, aucun embedding de la question n'est nécessaire.

## 0.2 Paquets (.fcpack)

Le format sous lequel une base s'exporte, s'installe et se distribue depuis le Store. C'est un zip :

| Fichier | Contenu |
|---|---|
| `manifest.json` | id, type (`knowledge` pour une base, `identity` pour un rôle ; `bundle` est réservé), groupe des variantes par langue, nom, version, auteur, langue, licence, **modèle d'embedding déclaré** (nom, dimensions, empreinte), empreinte SHA-256 de chaque fichier |
| `knowledge.json` | documents et morceaux avec leur repère : le texte est toujours présent (sources, recherche par mots) |
| `vectors.bin` | vecteurs float32 des morceaux, dans l'ordre des morceaux ; absent des paquets de texte seul |
| `role.json` | définition d'un rôle (paquets `identity`) : instructions, réglages du modèle, paramètres, bases requises |
| `signature.json` | signature Ed25519 du manifeste, qui fixe l'empreinte des autres fichiers |

- **Avec les vecteurs** (le cas normal, modèle par défaut `embeddinggemma`) : à l'installation, les morceaux sont
  prêts tout de suite, sans appel à Ollama ; la base est liée au modèle déclaré.
- **Texte seul** : les documents sont indexés avec le modèle de l'utilisateur ; s'il manque, ils attendent « En
  attente » et repartent quand le modèle est téléchargé. Une copie du paquet reste dans `userData/packs/`.
- **Confiance** : `verified` (signature d'une clé présente dans `src/main/knowledge/trust.ts`), `unsigned`,
  `unknown` (signé par une clé inconnue), `builtin` (intégré à l'application). Sans signature vérifiée,
  l'installation demande une confirmation explicite. Un paquet altéré (empreintes ou signature qui ne
  correspondent pas) ne s'installe pas.
- **Mise à jour** : même id, nouvelle version → la base reste la même (et reste liée), le contenu est remplacé.
- Les bases installées depuis un paquet sont en **lecture seule** ; « Entier » reste modifiable.
- **Exporter** (Paramètres → Connaissances) : seulement les bases locales dont tous les documents sont prêts ; le
  paquet contient les vecteurs du modèle de la base, déclaré dans le manifeste avec ses dimensions et son empreinte.
- **Paquets intégrés** : les fichiers de `packs/` sont installés ou mis à jour au démarrage
  (`npm run packs:build` les régénère à partir de la documentation). Aujourd'hui : « Guide de FastChat » en
  italien, en texte seul, et les deux rôles italiens avec leurs bases. Le Guide en français et en anglais et les
  rôles français s'installent depuis le Store.
- **Rôles** : un paquet `identity` s'installe avec les bases que le rôle requiert (d'autres paquets, cherchés à
  côté du fichier ou dans le catalogue du Store). Si une base manque, le rôle fonctionne quand même, et l'onglet
  « Connaissances » le signale. Quand on supprime le rôle, les bases arrivées avec lui ne partent que si aucun
  autre rôle ne les requiert.
- **Lier aux nouvelles conversations** : option par base de la bibliothèque ; les nouvelles conversations la
  trouvent déjà liée.
- Signer : `node scripts/pack-keys.mjs <id>` génère la paire de clés ; la clé publique va dans `trust.ts`, la clé
  privée reste chez celui qui publie.

## 0.3 Store

Fenêtre au-dessus du chat, ouverte par le bouton « Store » dans la barre latérale (au-dessus de la ligne des
paramètres).

- **Catégories**, dans l'ordre : Rôles, Bases de connaissances, Plugins, Packs (qui réunissent plusieurs éléments).
- **États** : Installé · Mise à jour disponible · Disponible · Bientôt disponible. Le Guide intégré apparaît
  installé à l'ouverture.
- **On installe des bases de connaissances et des rôles** ; les plugins sont dans le catalogue mais ne
  s'installent pas encore. Un rôle s'installe avec les bases qu'il requiert, prises dans le même catalogue. Un
  pack installe ce qu'il contient.
- **Langues** : les éléments qui ont le même `group` forment une seule fiche, avec « Disponible en : » pour
  choisir la variante. La recherche porte sur le titre et la description de toutes les variantes ; à côté de la
  recherche se trouve le filtre par langue.
- **Titres et descriptions des bases dans la langue de l'interface** (it/en/fr) : dans le catalogue (`name`,
  `summary` par langue) et dans le manifeste du paquet (`i18n`), ce qui vaut aussi dans la bibliothèque, les bases
  liées et les sources. Le contenu reste dans la langue du paquet. Un rôle est écrit dans une seule langue : son
  titre et sa description sont dans cette langue.
- **Catalogue** : si « Dépôt du store » (Paramètres → Général) est vide, on utilise celui qui est inclus dans
  l'application (`store/catalog.json`, généré par `npm run packs:build`) ; sinon `GET {url}/catalog.json` et
  `GET {url}/{file}`. Si le dépôt ne répond pas, le catalogue local s'affiche avec la raison.
- **Qui gère quoi** : ce qui appartient au Store (éléments du catalogue, base et rôles intégrés) s'installe, se
  met à jour et se supprime uniquement depuis le Store. Dans Paramètres → Connaissances, ces bases affichent
  « Gérer dans le Store » à la place de « Supprimer la base », et « Importer un paquet… » refuse un fichier qui
  porte l'id d'un élément du Store. Les Paramètres gèrent les bases créées par l'utilisateur et les paquets
  importés depuis un fichier.
- **Sécurité** : l'empreinte SHA-256 du fichier est comparée à celle du catalogue ; depuis le dépôt, on n'installe
  que des paquets dont la signature est reconnue ; ceux du catalogue inclus dans l'application sont de confiance,
  comme le Guide.

Élément du catalogue :

```json
{ "id": "it.fastchat.prompt", "type": "knowledge", "version": "1.0.0",
  "name": { "it": "Scrivere buoni prompt", "en": "Writing good prompts", "fr": "Écrire de bons prompts" },
  "summary": { "it": "…", "en": "…", "fr": "…" },
  "author": "FastChat", "language": "it", "price": 0,
  "embedding": { "model": "embeddinggemma", "dimensions": 768 },
  "file": "items/it.fastchat.prompt/1.0.0.fcpack", "sha256": "…", "size": 2341 }
```

Autres champs : `builtin` (intégré), `group` (variantes par langue), `model` (rôles : modèle conseillé ou requis),
`requires`, `contains` (packs), `forRole` (base d'un rôle : elle s'installe avec lui et le Store ne la montre pas
comme une fiche à part).

## 0.4 Types de base dans une conversation

Une base liée à une conversation a un **usage** (`conversation_bases.purpose`) :

| Usage | Contenu | Quand il entre dans le prompt | Sources sous la réponse |
|---|---|---|---|
| `documents` (par défaut) | Les contenus à partir desquels répondre | Seulement quand l'interrupteur ou le bouton livre est activé, comme toujours | Oui |
| `behavior` | Techniques et règles du rôle | Toujours | Non |
| `examples` | Réponses bien faites à imiter, chacune entre `<exemple>…</exemple>` | Toujours | Non |

- Les documents ajoutés à la conversation sont toujours `documents`.
- Les bases d'un rôle arrivent avec leur usage, déclaré par le rôle. Dans l'onglet « Connaissances », elles sont à
  part, sous « Du rôle », en lecture seule et sans « Délier ».
- Pour les autres bases liées, l'usage se choisit sur la base, dans l'onglet « Connaissances ».
- **Parts** : l'espace des connaissances (25/50/75 % de la mémoire) se partage entre les trois usages selon les
  parts des Paramètres (20/20/60 par défaut). Ce qu'un usage ne consomme pas passe aux autres, d'abord aux
  documents : avec seulement des bases de type `documents`, le comportement est celui de toujours.
- « Prêts » et le bouton livre ne comptent que les documents.

## 1. Entrée : les plugins

- Un plugin (`KnowledgeSource`, dans `src/main/knowledge/source.ts`) sait lire un type de source et renvoie du
  **texte en sections avec un repère** (page, titre). Il ne fait rien d'autre : morceaux, embedding, recherche,
  prompt et interface relèvent du noyau.
- Plugins `file` (l'utilisateur ajoute des fichiers par la boîte de dialogue ou en les faisant glisser) :
  - `text` : txt et similaires en une section ; Markdown découpé aux titres, repère = suite des titres ;
  - `pdf` (pdf.js) : une section par page, repère « p. N » ; numérisations sans texte → erreur, pas d'OCR ;
  - `docx` (mammoth) : HTML → Markdown → sections aux titres.
- Plugins `connected` (la source liste elle-même les documents) :
  - `folder` : un dossier de l'ordinateur, sous-dossiers jusqu'à 4 niveaux, 500 fichiers au maximum, dossiers
    cachés et `node_modules` exclus ; délègue la lecture aux plugins `file` ; version = date et taille ;
    « Actualiser » ajoute les nouveaux, refait ceux qui ont changé, retire ceux qui ont disparu ; « Déconnecter »
    retire tout.
  - Le formulaire de configuration est dessiné par le noyau à partir des champs déclarés par le plugin (texte,
    dossier, secret) ; les champs secrets sont chiffrés avec `safeStorage`.
- Registre : `createBuiltinRegistry()` dans `src/main/knowledge/sources/index.ts`. Pour ajouter un plugin : un
  fichier dans le dossier, une ligne dans le registre, le libellé dans les trois langues, un test avec un fichier
  d'exemple.

## 2. Indexation (une fois par document, en arrière-plan)

1. Empreinte SHA-256 du fichier : le même fichier n'entre pas deux fois dans la même base.
2. Le plugin extrait les sections ; limite de 25 Mo par fichier et de 2 millions de caractères de texte.
3. Chaque section est découpée par paragraphes en **morceaux de 1 600 caractères au maximum** (~400 tokens) ;
   chaque morceau hérite du repère de la section.
4. **Embedding** avec Ollama, par lots de 16, avec le **modèle d'embedding dédié** choisi dans les Paramètres
   (`embeddingModel`, par défaut `embeddinggemma`). Ce n'est pas le modèle de la conversation : c'est le même
   modèle que celui de la mémoire à long terme. Du modèle de chat, on ne reprend que l'exécution CPU/GPU
   (`num_gpu = 0` si le chat tourne seulement sur le CPU), pour ne pas faire recharger les modèles à Ollama.
5. Les vecteurs vont dans SQLite (`knowledge_chunks`) **par modèle d'embedding** : si l'on change de modèle, les
   documents sont réindexés ; les vecteurs de modèles différents ne sont jamais comparés.
6. Le texte des morceaux entre aussi dans l'index **FTS5** (`knowledge_fts`, BM25, accents ignorés), tenu à jour
   par des déclencheurs à l'insertion et à la suppression.
7. État par document : `pending` → `indexing` (avec la progression) → `ready` ou `error` (avec la raison,
   « Réessayer l'indexation » disponible). Une question n'utilise que les documents `ready`. Chaque appel
   d'embedding est enregistré dans le moniteur du contexte (`embed-doc`).

## 3. Quand la recherche démarre

À chaque question, si les deux conditions sont réunies :

- l'**interrupteur** « Utiliser la base de connaissances » de la conversation est activé, **ou** le **bouton
  livre** à côté de « Envoyer » est activé pour cette question (le choix fait sur la question l'emporte sur celui
  de la conversation) ;
- il y a au moins un document `ready` avec des morceaux pour le modèle d'embedding actuel, dans la base de la
  conversation ou dans une base liée.

Le choix du bouton livre est enregistré sur le message de l'utilisateur : « Régénérer » le répète.

## 4. Budget : quelle place dans le prompt

```
budget = min( part × num_ctx ,
              num_ctx − réserve pour la réponse (20 %) − instructions du rôle − situation − style − résumé − historique récent − question )
```

- **Part** par conversation, dans l'onglet « Connaissances » : 25 %, **50 % (par défaut)**, 75 %.
- Le budget est un plafond : dans une conversation déjà longue, les documents peuvent avoir moins que leur part.
- Après les documents, la mémoire de la conversation (extraits des messages résumés) prend au maximum 12 % de ce
  qui reste. En dessous de 64 tokens, on ne cherche rien.

## 5. Choix du contenu, dans l'ordre

1. **Tout en entier.** Si la somme des morceaux de tous les documents prêts tient dans le budget, ils vont au
   modèle complets, dans l'ordre des documents et des positions. L'introduction de la section dit que les
   documents sont complets : le modèle peut compter, comparer et additionner.
2. **Documents « Entier »** (bouton en forme d'épingle sur le document). Ils vont en entier tant qu'ils tiennent
   dans le budget, avant tout le reste. S'ils le dépassent à eux seuls, l'onglet prévient qu'ils seront coupés.
3. **Extraits** dans la place qui reste :
   - un seul embedding de la question (texte de la question + 500 derniers caractères de la réponse précédente),
     partagé avec la mémoire de la conversation ;
   - recherche par mots exacts FTS5 sur la question (mots d'au moins 3 lettres et nombres) ;
   - **score hybride** = 0,6 × cosinus + 0,4 × BM25 normalisé sur le meilleur (la part BM25 ne compte que si un
     morceau a un score significatif) ;
   - seuils : score ≥ 0,25 et ≥ 50 % du meilleur ;
   - plafond par document = max(2, budget en morceaux ÷ nombre de documents) : il augmente avec le budget et
     diminue avec le nombre de documents ;
   - on remplit le budget par ordre de score ; aucune limite fixe au nombre d'extraits.

## 6. Dans le prompt

- Section `# Base de connaissances`, dans le prompt système après les instructions du rôle, la situation, le
  style, le résumé et la mémoire de la conversation. Avant elle viennent, s'il y en a, les techniques
  (`# Comment travailler`) et les exemples (`# Exemples`) du rôle.
- Introduction pour « documents complets » ou pour « extraits » (et une phrase de liaison quand il y a les deux) ;
  puis chaque entrée sous la forme `[Titre, p. N]` suivie du texte.
- Instructions au modèle : répondre à partir des documents quand ils concernent la question, citer la source
  entre crochets, dire clairement quand l'information n'y est pas.
- Textes dans la langue du rôle ; pour le Généraliste, dans celle de l'interface (italien, anglais, français).

## 7. Après la réponse

- **Sources** enregistrées sur le message (`knowledgeRefs`) et affichées sous la réponse : titre, repère, score
  ou « document entier ».
- Moniteur du contexte : entrée « Extraits des documents » dans l'appel de réponse, appels `embed-query` et
  `embed-doc` avec les décomptes d'Ollama.
- Export Markdown et JSON avec la liste des documents, le choix fait sur la question et les sources par réponse.

## 8. Interface

- **Paramètres → Connaissances** : bibliothèque des bases (créer, renommer, supprimer) et documents de chaque
  base, avec les mêmes commandes que l'onglet.
- Onglet **« Connaissances »** dans le panneau latéral : bases « Du rôle », interrupteur « Utiliser la base de
  connaissances », sélecteur de l'espace, « Bases liées » (lier, délier), ajout de fichiers et glisser-déposer,
  « Connecter : … » pour les sources connectées, liste des documents avec leur état, « Entier », « Réessayer
  l'indexation », suppression ; ligne d'état avec les morceaux indexés et le modèle ; ligne qui dit si les
  documents tiennent dans l'espace réservé et, sinon, combien de mémoire il faudrait.
- **Bouton livre** à côté de « Envoyer » : il montre si la prochaine question utilisera les documents ; un clic
  l'inverse pour cette question ; désactivé sans documents prêts.
- Groupe « Ce dont il se souvient » de l'onglet Modèle : ligne récapitulative avec un renvoi vers l'onglet.

## 9. Limites connues

- Les questions sur l'ensemble des documents (« combien y en a-t-il ? », « le total ? ») ne fonctionnent que
  lorsque les documents vont au modèle en entier (cas 1) : sinon aucun mot ne permet de les sélectionner. L'onglet
  dit combien de mémoire il faudrait. Pour des totaux et des décomptes sur beaucoup de documents, il faudrait un
  extracteur structuré (champs par type de document), pas encore construit.
- La recherche par cosinus est en JavaScript sur tous les morceaux de la conversation : elle tient des milliers
  de morceaux, pas des dizaines de milliers.
- Pas de reranker, pas d'OCR, pas de synchronisation automatique des dossiers connectés. Plugins externes
  chargés depuis le disque : prévus par le contrat, pas construits.

## Variables pour les tests

- `FASTCHAT_KNOWLEDGE_FILES` : chemins (séparés par `:` ; `;` sous Windows) ajoutés à la place de la boîte de
  dialogue.
- `FASTCHAT_KNOWLEDGE_FOLDER` : dossier renvoyé à la place de la boîte de dialogue de choix de dossier.
- `FASTCHAT_PACK_FILE` / `FASTCHAT_PACK_EXPORT` : paquet à importer / chemin d'export, à la place des boîtes de
  dialogue.
