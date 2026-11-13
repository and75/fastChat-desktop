# Prompts faibles et améliorés

## Améliorer un prompt vague

Demande : Améliore ce prompt : « Résume le texte. »

Réponse :
Tu es un rédacteur. Tu écris pour quelqu'un qui n'a pas lu le texte.
Résume le texte placé entre les trois guillemets.
Utilise cinq points, un par idée principale.
Chaque point est une phrase de vingt mots au maximum.
Si le texte ne contient pas cinq idées, écris moins de points.

"""
[texte]
"""

## Améliorer un prompt destiné à un programme

Demande : Améliore ce prompt : « Dis-moi si l'avis est positif ou négatif. »

Réponse :
Classe l'avis placé entre les trois guillemets.
Réponds par un seul mot : positif, négatif ou neutre.
Si l'avis porte sur plusieurs aspects, choisis le jugement sur l'aspect principal.
N'ajoute aucun autre texte.

"""
[avis]
"""

## Expliquer ce qui ne va pas

Demande : Qu'est-ce qui ne va pas dans ce prompt ? « Tu es un expert très compétent. Écris un e-mail au client, professionnel mais aussi amical, ni trop long ni trop court. »

Réponse :
1. La tâche précise manque : il ne dit pas de quoi parle l'e-mail ni ce qu'il doit obtenir.
2. Le contexte manque : qui est le client et ce qui s'est passé avant.
3. Le format est vague : « ni trop long » n'est pas une mesure. Mieux vaut un nombre de phrases.
4. « Professionnel mais amical » laisse le ton au hasard. Mieux vaut un exemple de phrase écrite dans le ton voulu.
5. « Expert très compétent » n'apporte rien : le rôle doit dire le métier.

## Écrire de zéro quand l'objectif est clair

Demande : Il me faut un prompt pour extraire la date, le montant et le fournisseur d'une facture.

Réponse :
Extrais les données de la facture placée entre les trois guillemets.
Réponds uniquement par un objet JSON avec ces champs : date, montant, fournisseur.
Écris la date au format AAAA-MM-JJ.
Écris le montant sous forme de nombre, avec un point pour les décimales et sans symbole monétaire.
Si une donnée est absente de la facture, utilise la valeur null.

"""
[facture]
"""

## Écrire de zéro quand l'objectif manque

Demande : Écris-moi un prompt pour le service client.

Réponse :
Pour l'écrire, il me faut deux choses :
1. Ce que le modèle doit faire : répondre aux clients, classer les demandes, ou les résumer pour un conseiller ?
2. Sur quoi il s'appuie : a-t-il une documentation à partir de laquelle répondre, ou doit-il seulement orienter la demande ?

## Ajouter un exemple au prompt

Demande : Améliore ce prompt, le modèle se trompe toujours de format : « Donne un titre à l'article. »

Réponse :
Écris un titre pour l'article placé entre les trois guillemets.
Le titre compte huit mots au maximum et ne se termine pas par un point.
N'utilise ni deux-points ni question.
Réponds uniquement par le titre.

Exemple de titre : Le port de Gênes rouvre après trois mois

"""
[article]
"""
