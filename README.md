
# C-Show Perudo — V1

Version multijoueur temps réel, pensée pour téléphone.

## Ce qui fonctionne
- Création d'une partie avec code 4 caractères
- 2 à 12 joueurs
- 5 dés privés par joueur
- Tours automatiques
- Enchères
- DUDO
- Les 1 sont jokers pour les enchères 2 à 6
- Pour une enchère sur les 1, seuls les 1 comptent
- Révélation des dés après DUDO
- Perte d'un dé
- Élimination
- Victoire du dernier joueur
- Rejouer une partie
- Interface mobile

## Important
Cette V1 utilise une règle d'enchère simplifiée :
- quantité supérieure, OU
- même quantité avec une valeur supérieure.

Les règles avancées Perudo (Palifico, changement spécifique vers/depuis les Pacos, Calza) seront à ajouter en V2.

## Lancer sur Mac
Ouvre Terminal puis :

```bash
cd ~/Desktop/cshow-perudo-v1
npm install
npm start
```

Puis ouvre :
http://localhost:3000

Pour tester avec plusieurs appareils sur le même Wi-Fi, utilise l'adresse IP locale du Mac :
http://ADRESSE-IP-DU-MAC:3000

## Pour Wix / jeu à distance
Il faudra héberger le serveur Node.js sur un hébergeur compatible WebSocket (Render, Railway, Fly.io, VPS, etc.), puis intégrer l'URL dans Wix avec un bouton ou une iframe.
