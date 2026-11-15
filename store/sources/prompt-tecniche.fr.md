# Techniques de prompt

## À quoi ressemble un bon prompt

Un bon prompt se lit comme la consigne que tu donnerais à un collègue compétent mais qui vient d'arriver : il ne connaît ni le projet, ni le public, ni ce que tu entends par « bien fait ». Si un collègue devait te poser des questions en le lisant, le modèle restera lui aussi dans le doute.

Écris en phrases complètes et naturelles, en paragraphes courts : un par sujet. Un prompt n'est pas un formulaire à remplir : n'utilise pas d'étiquettes comme « Rôle : » ou « Tâche : » devant chaque ligne. N'utilise des titres ou des sections que lorsque le prompt est long et comporte des parties vraiment différentes.

## Dire l'objectif et le contexte

Dis ce que tu veux obtenir et à quoi servira le résultat : qui le lira, où il sera utilisé, ce qui est déjà décidé. Le modèle n'a pas ces informations si tu ne les lui donnes pas, et sans elles il donne une réponse générique.

Demande l'action, pas un avis : « Réécris cet e-mail sur un ton plus cordial » obtient l'e-mail réécrit ; « Pourrais-tu suggérer comment l'améliorer ? » obtient des suggestions.

## Expliquer le pourquoi des règles

Une règle accompagnée de sa raison fonctionne mieux qu'un ordre sec, parce que le modèle comprend le but et l'applique aussi aux cas que tu n'as pas prévus. « N'utilise pas de points de suspension » est un ordre. « Le texte sera lu à voix haute par une synthèse vocale, qui ne sait pas prononcer les points de suspension : évite-les » est une règle que le modèle sait étendre.

Évite les majuscules et les tons péremptoires (« IMPORTANT », « TU DOIS ABSOLUMENT ») : ils ne rendent pas la règle plus claire et poussent le modèle à l'appliquer même là où elle ne sert pas.

## Donner un rôle

Une phrase au début, qui dit qui est le modèle et pour qui il écrit, oriente le vocabulaire et le niveau de détail : « Tu es un relecteur technique et tu écris pour des développeurs expérimentés ». Une phrase suffit : le rôle donne le ton, il ne remplace pas les instructions.

## Décrire la forme de la réponse

Dis à quoi ressemble la réponse que tu attends : une liste, un tableau, un seul paragraphe, combien de phrases, dans quelle langue. Décris ce que tu veux plutôt que ce que tu ne veux pas : « Réponds en paragraphes de prose continue » fonctionne mieux que « N'utilise pas de listes ».

Si le modèle a tendance à faire des réponses longues ou courtes, dis-le : « réponds en trois phrases », « explique en détail chaque étape ».

## Utiliser des exemples

Un ou plusieurs exemples de la réponse attendue fixent le format et le ton mieux qu'une description. Trois à cinq exemples suffisent presque toujours. Ils doivent être différents les uns des autres : s'ils se ressemblent trop, le modèle copie aussi les détails sans rapport. Ils doivent aussi avoir tous la même structure, parce que c'est elle que le modèle imite. Un exemple montre une réponse réussie : les cas limites, comme un texte trop court ou une donnée absente, se traitent par une règle, pas par un exemple de réponse ratée.

Garde les exemples séparés des instructions, par exemple chacun entre `<exemple>` et `</exemple>`.

## Séparer les données des instructions

Quand le prompt contient un texte sur lequel travailler (un document, un e-mail, un avis), sépare-le des instructions par un délimiteur clair : des balises comme `<document>` et `</document>`, ou bien un titre. Choisis un seul type de délimiteur et utilise-le toujours de la même façon.

Le délimiteur ne sert que s'il y a un texte à traiter. Un prompt qui demande d'écrire quelque chose à partir de rien, comme un récit ou un e-mail, n'en a pas besoin.

Si le texte est long, place-le d'abord et la question ensuite, introduite par une phrase de liaison : « D'après le document ci-dessus, … ».

## Dire quoi faire quand l'information manque

Sans indication, le modèle a tendance à inventer. Écris ce qu'il doit faire si la donnée n'est pas là : « Si le texte ne le dit pas, écris "non indiqué" ».

## Diviser les tâches complexes

Un prompt qui demande beaucoup de choses à la fois donne de moins bons résultats que plusieurs prompts simples. Si le travail comporte plusieurs phases (par exemple extraire les données puis écrire un résumé), mieux vaut un prompt par phase, en utilisant la réponse du premier comme entrée du second.

## Petits modèles locaux et grands modèles

Un petit modèle, ou un modèle utilisé sans raisonnement, travaille comme un collaborateur débutant : il a besoin d'instructions explicites, d'une seule tâche par prompt et de voir le format de la réponse dans un exemple. Les règles les plus importantes (rôle, contraintes, format) vont au début.

Un grand modèle, ou un modèle avec le raisonnement activé, travaille comme un collègue expérimenté : on peut lui donner l'objectif et les critères de qualité, en lui laissant les détails. Inutile de lui demander de « raisonner étape par étape » dans la réponse : il le fait déjà de lui-même.

## Améliorer un prompt qui ne fonctionne pas

Un prompt se met au point par essais. Lis la réponse, repère ce qui ne va pas et change une chose à la fois :

- reformule la demande avec d'autres mots ;
- ajoute le contexte ou l'exemple qui manquait ;
- change l'ordre des parties (exemples, contexte, question) ;
- transforme la tâche en une tâche équivalente plus simple, par exemple un choix entre des options au lieu d'une question ouverte.

## Comment reconnaître un prompt faible

Du plus grave au moins grave :

1. On ne comprend pas ce que le modèle doit produire, ou bien il demande plusieurs choses à la fois.
2. Il manque le contexte : à quoi sert le résultat et qui le lira.
3. Il ne dit pas quelle forme doit avoir la réponse.
4. Il ne dit pas quoi faire quand l'information manque.
5. Les règles sont des ordres sans raison, ou bien elles se contredisent.
6. Le texte à traiter est mélangé aux instructions.

## Sources

Synthèse des guides officiels de prompt engineering d'Anthropic (« Prompting best practices »), de Google (« Prompt design strategies » et la documentation de Gemma) et d'OpenAI (« Prompt engineering »).
