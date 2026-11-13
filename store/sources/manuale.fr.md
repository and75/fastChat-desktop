# Manuel d'utilisation de FastChat

## La fenêtre

À gauche se trouve la barre latérale, avec la liste des conversations. Au centre, la conversation, avec le champ de saisie en bas. À droite, le panneau de la conversation, avec les onglets « Modèle », « Situation » et « Connaissances ».

Le panneau se masque et s'affiche avec le bouton en haut à droite, à côté de l'icône d'exportation.

## Commencer une conversation

« Nouvelle conversation », dans la barre latérale, ouvre une conversation avec le rôle « Généraliste » : aucune instruction, le modèle tel qu'il est.

La flèche à côté de « Nouvelle conversation » ouvre « Parler avec un… » : la liste des rôles installés, puis les conversations enregistrées comme modèles. Un clic sur un rôle ouvre une conversation avec ce rôle.

Le modèle se choisit dans le menu « Modèle », dans la barre du haut.

## Rôles

Un rôle dit au modèle qui il est et comment il doit répondre. Il se règle dans l'onglet « Modèle », où apparaissent le rôle et ses sections : « Identité et objectifs », « Style et format », « Règles », « Méthode ».

Chaque section s'ouvre d'un clic et contient les choix du rôle. Fermée, elle montre en une ligne les choix en vigueur. Certains choix modifient aussi les réglages du modèle : une ligne sous le choix le signale, par exemple « règle la température sur 0,3 ».

Pour changer de rôle, on utilise « Changer… », à côté du nom du rôle. Dans une conversation vide, le rôle change tout de suite. Dans une conversation commencée, une nouvelle conversation s'ouvre, qui peut partir du résumé de la précédente.

## Situation

Dans l'onglet « Situation », on écrit le contexte de cette conversation, avec ses propres mots : de quoi il est question, pour qui, avec quelles contraintes. Le texte s'enregistre tout seul et s'applique dès la question suivante.

Sous le champ se trouve le compteur de caractères. « Ce que reçoit le modèle » montre les instructions complètes : celles du rôle, puis la situation.

Dans le même onglet se trouvent « Mode plan » et « Enregistrer comme modèle ».

## Documents et bases de connaissances

Dans l'onglet « Connaissances », « Ajouter des documents » charge les fichiers à partir desquels le modèle doit répondre. On peut aussi les faire glisser dans le cadre.

« Utiliser la base de connaissances » active ou désactive l'utilisation des documents pour toute la conversation. Le bouton en forme de livre à côté de « Envoyer » vaut pour une seule question.

« Lier une base… » relie à la conversation une base de la bibliothèque. Les bases de la bibliothèque se créent dans « Paramètres » → onglet « Connaissances ».

Les bases « Du rôle » font partie du rôle : elles sont toujours actives et ne se détachent pas.

## Comment le modèle répond

Dans l'onglet « Modèle », sous les sections du rôle, se trouvent quatre groupes : « Où il tourne », « Comment il choisit les mots », « Comment il répond », « Ce dont il se souvient ».

Dans « Comment il répond » se trouvent « Raisonnement » et « Style de la réponse », avec quatre valeurs : « Essentiel », « Concis », « Normal », « Détaillé ». Dans « Comment il choisit les mots » se trouve la « Température ». Dans « Ce dont il se souvient » se trouve la « Mémoire de la conversation ».

« Raisonnement », « Mode plan » et « Style » se trouvent aussi sous le champ de saisie.

« ↺ Toutes les valeurs suggérées » ramène la température et la mémoire aux valeurs conseillées pour le modèle.

## Mode plan

Quand « Mode plan » est activé, le bouton d'envoi devient « Planifier ». Le modèle propose un plan en étapes ; les étapes peuvent être modifiées. « Approuver et exécuter » lance la réponse qui suit le plan.

## Conversations longues

Quand la conversation ne tient plus dans la mémoire du modèle, les messages les plus anciens sont remplacés par un « Résumé automatique », visible dans la conversation. On peut le lire et le corriger avec « Afficher et modifier », le refaire avec « Actualiser », le retirer avec « Supprimer ».

L'« État du contexte », en bas de l'onglet « Modèle », montre la part de mémoire occupée.

## Store

« Store », en bas de la barre latérale, liste ce que l'on peut installer : « Rôles », « Bases de connaissances », « Plugins », « Packs ».

« Installer » ajoute l'élément ; « Supprimer » le retire. Un rôle s'installe avec les bases qu'il requiert. Quand un rôle existe en plusieurs langues, « Disponible en : » permet de choisir laquelle installer.

## Conversations enregistrées comme modèles et exportation

« Enregistrer comme modèle », dans l'onglet « Situation », enregistre le rôle, les choix et la situation. La conversation enregistrée se retrouve dans « Parler avec un… », sous « Modèles ».

L'icône d'exportation, en haut à droite, enregistre la conversation en Markdown ou en JSON.

## Paramètres

La roue dentée en bas de la barre latérale ouvre les « Paramètres », avec les onglets « Général », « Modèles », « Ollama », « Connaissances », « Contexte ».

Dans « Général », on choisit « Langue », « Thème », « URL d'Ollama » et « Modèle par défaut ». Dans « Connaissances », on gère les bases de la bibliothèque et on importe un paquet avec « Importer un paquet… ».
