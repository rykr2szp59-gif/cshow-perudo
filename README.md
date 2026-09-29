
# C-Show Perudo V2

## Règles intégrées
- Chaque joueur commence avec 5 dés.
- Le 6 est remplacé visuellement par un Toucan / Perudo.
- Une première annonce doit porter sur une valeur normale (1 à 5).
- Une annonce normale = quantité + valeur.
- Les Perudo sont jokers pour les annonces normales.
- Une annonce de Perudo ne compte que les Perudo.
- Passage normal -> Perudo : moitié entière + 1.
  Exemple : 6 dés de 4 -> minimum 4 Perudo.
- Passage Perudo -> normal : double + 1.
  Exemple : 4 Perudo -> minimum 9 dés d'une valeur normale.
- "TU MENS" :
  - si l'annonce était fausse, l'annonceur perd 1 dé ;
  - si l'annonce était vraie, celui qui a dit "TU MENS" perd 1 dé.
- "EXACT" :
  - si le compte est exactement égal à l'annonce, le joueur gagne 1 dé ;
  - sinon il perd 1 dé ;
  - maximum : 5 dés.
- Chrono : 20 secondes par joueur.
- Si le chrono arrive à zéro, le joueur perd 1 dé.
- Validation de l'annonce avec confirmation sur téléphone.
- Le dernier joueur encore en jeu gagne.

## Lancer
```bash
npm install
npm start
```

Puis :
http://localhost:3000

## Déploiement
Le projet est prêt pour Render avec render.yaml.
