# Techniques de prompt

## Les parties d'un bon prompt

Un prompt complet répond à cinq questions, dans cet ordre : qui le modèle doit être, ce qu'il sait de la situation, ce qu'il doit faire, sous quelle forme il doit répondre, ce qu'il ne doit pas faire.

Elles ne sont pas toujours toutes nécessaires. Une tâche simple ne demande que la tâche et le format. Plus la tâche est délicate, plus il faut de parties.

## Rôle

Une ligne qui dit qui est le modèle et pour qui il écrit : « Tu es un relecteur technique. Tu écris pour des développeurs expérimentés. » Le rôle fixe le vocabulaire et le niveau de détail mieux qu'une liste d'adjectifs.

## Contexte

Seulement les faits qui changent la réponse : les données de départ, ce qui est déjà décidé, qui lira. Trois phrases pertinentes valent mieux qu'une page générale.

Le texte à traiter se sépare des instructions par un délimiteur clair, par exemple trois guillemets ou un titre.

## Tâche

Un verbe précis et un objet : résume, compare, corrige, extrais, classe. « Qu'en penses-tu ? » n'est pas une tâche.

Une tâche par prompt. S'il y en a deux, elles vont dans deux étapes numérotées ou dans deux prompts.

## Format

Dire la forme exacte : liste, tableau, JSON avec le nom des champs, nombre de phrases, langue. Si la réponse est lue par un programme, le format est la partie la plus importante du prompt.

Un exemple de la réponse attendue fixe le format mieux qu'une description. Un ou deux suffisent : avec trop d'exemples, le modèle copie aussi les détails sans importance.

## Contraintes

Écrire ce qu'il faut faire plutôt que ce qu'il faut éviter : « Réponds seulement par le nom de la catégorie » fonctionne mieux que « N'ajoute pas d'explications ».

Dire quoi faire quand l'information manque : « Si le texte ne le dit pas, écris "non indiqué" ». Sans cette ligne, le modèle invente.

## Pour les petits modèles

Une instruction par ligne, à l'impératif. Pas de préambule, pas de formules de politesse, pas d'instruction répétée.

Peu d'instructions : au-delà de huit ou neuf, les dernières pèsent plus que les premières et celles du milieu se perdent.

L'instruction la plus importante se place à la fin, près du texte à traiter.

Des mots simples, et toujours les mêmes : si une chose s'appelle « catégorie », elle ne devient pas « classe » deux lignes plus loin.

## Pour les grands modèles

Ils supportent des instructions développées. Il est utile d'expliquer la raison d'une contrainte et de donner des critères de qualité : « la réponse est bonne si un client la comprend sans connaître le produit ».

## Comment reconnaître un prompt faible

Par ordre de gravité :

1. La tâche manque, ou il y en a plusieurs.
2. Le format de la réponse manque.
3. Il manque ce qu'il faut faire quand l'information est absente.
4. Le contexte est absent, ou bien long et général.
5. Les instructions se contredisent ou se répètent.
6. Le texte à traiter est mêlé aux instructions.
