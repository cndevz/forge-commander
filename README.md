# Forge Commander

Application web pour construire un deck Commander (EDH) de **100 cartes prises dans ta collection** Magic: The Gathering.

1. **Collection** : colle ta liste ou choisis un fichier `.txt` (format Archidekt, Moxfield, Cardmarket ou MTG Arena : `1 Sol Ring (TLE) 316`).
2. **Commandant** : choisis parmi les créatures légendaires de ta collection. Une carte placée sous `// COMMANDER` est présélectionnée.
3. **Deck** : génère un deck prêt à jouer, affiché carte par carte, puis copie la liste ou télécharge-la en `.txt` (même format qu'à l'import).

L'onglet **Suggestions EDHREC** liste les cartes que tu ne possèdes pas, triées par présence dans les decks EDHREC de ce commandant, avec le prix indicatif Cardmarket.

## Comment le deck est construit

- Uniquement des cartes de ta collection, dans l'identité de couleur du commandant et légales en Commander. Un seul exemplaire de chaque carte, sauf les terrains de base.
- Quotas de rôles : 10 accélérations, 10 pioches, 8 gestions ciblées, 3 wraths, 3 protections (rôles déduits du texte des cartes).
- Note de chaque carte : son % de présence sur EDHREC avec ce commandant, un bonus de synergie EDHREC, un bonus tribal (types cités par le commandant) et un malus pour les coûts de 6 ou plus.
- Le reste des sorts est choisi par note en visant une courbe de mana jouable.
- 33 à 38 terrains selon le coût moyen des sorts. Les terrains de base sont répartis selon les symboles de mana des sorts.
- Le curseur « Variété » ajoute du hasard : chaque génération donne un deck différent.
- S'il manque des terrains, le deck prend d'autres cartes de ta collection. S'il manque des sorts, il prend les terrains en trop. Il ne dépasse jamais ce que tu possèdes et signale ce qui manque.

## Données

- [Scryfall](https://scryfall.com/docs/api) pour les cartes et les images, mis en cache dans le navigateur (IndexedDB) pendant 14 jours.
- [EDHREC](https://edhrec.com) : fichiers JSON publics de leur site (`json.edhrec.com`). Si le navigateur bloque l'appel direct, l'application passe par un relais CORS public gratuit.

## Lancer en local

Aucune installation ni compilation : ce sont des fichiers statiques.

```sh
npx http-server .   # ou : python3 -m http.server
```

Tests : `node test/test.mjs`

## Mise en ligne gratuite (GitHub Pages)

Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`. Le site est ensuite disponible à `https://<utilisateur>.github.io/forge-commander/`.
