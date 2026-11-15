# Prompts faibles et améliorés

## Ajouter les détails qui manquent

Demande : Améliore ce prompt : « Résume les notes de la réunion. »

Réponse :
```
Résume les notes de la réunion en un seul paragraphe. Écris ensuite une liste des participants, chacun avec les points principaux qu'il a défendus. Pour finir, énumère les prochaines étapes ou les actions décidées, s'il y en a.

<notes>
[notes de la réunion]
</notes>
```

Pourquoi il est écrit ainsi :
1. Le prompt de départ laissait tous les choix au modèle : quelle longueur, quoi garder, dans quel ordre.
2. Il dit maintenant les trois parties de la réponse et la forme de chacune : paragraphe, liste, actions.
3. « S'il y en a » dit quoi faire quand une information manque : le modèle n'invente pas d'actions jamais décidées.

## Améliorer un prompt du type « Agis comme… »

Demande : Améliore ce prompt : « Je veux que tu agisses comme un conteur. Tu inventeras des histoires divertissantes, captivantes, pleines d'imagination et attrayantes pour le public. Il peut s'agir de contes, d'histoires éducatives ou de tout autre type d'histoire capable de capter l'attention. Ma première demande est : j'ai besoin d'une histoire intéressante sur la persévérance. »

Réponse :
```
Tu es un conteur d'histoires pour des enfants de six à neuf ans. Écris une histoire sur la persévérance, à lire à voix haute avant de dormir : environ 500 mots, soit quatre ou cinq minutes de lecture.

L'héroïne est une petite fille du même âge que ceux qui écoutent, aux prises avec quelque chose qu'elle ne réussit pas du premier coup. Fais comprendre ce qu'est la persévérance par ce qu'elle fait, plus que par les mots : les enfants la saisissent mieux par les faits que par une explication.

Utilise des phrases courtes et quelques répétitions, qui aident à suivre quand on écoute. Termine sur une image paisible, adaptée au moment du coucher.
```

Pourquoi il est écrit ainsi :
1. « Divertissantes, captivantes, pleines d'imagination » sont des adjectifs qui ne guident pas le modèle. À leur place, il y a le public, l'occasion et la durée.
2. L'indication « par ce qu'elle fait » est accompagnée de sa raison : le modèle l'applique mieux s'il sait à quoi elle sert.
3. J'ai choisi moi-même l'âge et l'occasion, que le prompt ne disait pas : s'ils sont différents, il suffit de changer la première phrase.

## Écrire un prompt dont le résultat est lu par un programme

Demande : J'ai besoin d'un prompt pour classer les avis sur des produits ; le résultat va dans un tableur.

Réponse :
```
Classe l'avis sur un produit comme positif, négatif ou neutre. La réponse est insérée par un programme dans un tableur : écris donc un seul mot, sans ponctuation ni commentaire.

Avis : J'adore ce casque, la qualité du son est extraordinaire !
Jugement : positif

Avis : La batterie est correcte, mais les coussinets ont l'air fragiles.
Jugement : neutre

Avis : Service client déplorable, je n'achèterai plus jamais chez eux.
Jugement : négatif

Avis : [avis à classer]
Jugement :
```

Pourquoi il est écrit ainsi :
1. Il explique pourquoi il faut un seul mot : le modèle comprend la contrainte et n'ajoute pas de phrases autour.
2. Trois exemples différents, tous avec la même structure, fixent le format mieux qu'une description.
3. Le prompt se termine par « Jugement : » : la réponse commence directement par le mot attendu.

## Écrire un prompt système à réutiliser

Demande : J'ai besoin d'un prompt à réutiliser chaque fois que je dois résumer un article.

Réponse :
```
# Identité
Tu es un expert du résumé de contenus. L'article à résumer arrive à chaque fois dans le message de l'utilisateur : tu en renvoies un résumé au format décrit ci-dessous.

# Sections de la réponse
- RÉSUMÉ EN UNE PHRASE : tout le contenu en une seule phrase de vingt mots.
- POINTS PRINCIPAUX : les dix points les plus importants, chacun de seize mots au maximum.
- À RETENIR : les cinq conclusions les plus utiles pour le lecteur.

# Règles
- Utilise des listes numérotées.
- Ne répète pas le même point dans des sections différentes.
- Écris seulement les trois sections, sans avertissements ni commentaires.
```

Pourquoi il est écrit ainsi :
1. Un prompt que l'on réutilise souvent gagne à être divisé en sections avec un titre : il se lit et se corrige plus facilement.
2. Le format est décrit section par section, avec des mesures précises (vingt mots, dix points).
3. Le prompt ne contient que les instructions : l'article arrive à chaque fois dans le message de l'utilisateur, ainsi le prompt se réutilise sans modification.

## Expliquer ce qui ne va pas dans un prompt

Demande : Qu'est-ce qui ne va pas dans ce prompt ? « Je veux que tu agisses comme un rédacteur d'essais. Tu devras faire des recherches sur un sujet, formuler une thèse et créer un texte persuasif, informatif et captivant. Ma première demande est : aide-moi à écrire un essai persuasif sur l'importance de réduire les déchets plastiques. »

Réponse :
1. Il ne dit pas pour qui est l'essai ni où il sera publié : le ton, le vocabulaire et les arguments en dépendent.
2. Il manque la longueur : le modèle choisit au hasard entre une page et dix.
3. Il demande de « faire des recherches », mais ne fournit pas de sources : le modèle citera des données de mémoire, dont certaines inventées. Mieux vaut joindre les données, ou demander de signaler les affirmations à vérifier.
4. « Persuasif, informatif et captivant » ne guide pas l'écriture. Mieux vaut dire quelle objection du lecteur l'essai doit surmonter.
5. Il ne dit pas la structure attendue : thèse, arguments, conclusion, avec ou sans titres.

## Quand l'objectif n'est pas clair

Demande : Écris-moi un prompt pour le service client.

Réponse :
Pour bien l'écrire, il me faut deux informations :
1. Ce que le modèle doit faire : répondre aux clients, trier les demandes, ou les résumer pour un opérateur ?
2. Sur quoi il s'appuie : a-t-il une documentation à partir de laquelle répondre, ou doit-il seulement orienter la demande vers la bonne personne ?
