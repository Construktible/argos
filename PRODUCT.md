# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Utilisateur principal : l'acheteur d'une maison ou d'un appartement**, avant l'achat. Il veut savoir ce qui a été autorisé autour du bien, par exemple un immeuble en face. En cas d'arbitrage, on tranche pour lui.
- **Ensuite : les professionnels de la transaction** : agents immobiliers, notaires, etc.
- Le site est public et ouvert à tous ; ces deux publics passent en premier.

## Product Purpose

Rendre la base SITADEL (autorisations d'urbanisme accordées) interrogeable dans l'espace, à l'adresse et à la parcelle, pour répondre à la question : « Qu'est-ce qui se prépare autour de cette adresse ? »

Deux usages :
- une adresse → les autorisations sur la parcelle, sur les parcelles voisines et dans un rayon (300 m par défaut), en rapport imprimable (PDF) et en tableau (CSV) ;
- une parcelle cliquée sur la carte → ses autorisations, y compris celles déposées sous d'anciens numéros.

Réussite : à partir d'une adresse, l'utilisateur sait ce qui a été autorisé autour du bien, et ce que les données ne permettent pas de savoir.

## Positioning

Argos rattache chaque autorisation SITADEL à une parcelle en parcourant tous les millésimes du cadastre depuis 2017, puis géocode l'adresse des dossiers restants. Les parcelles sont souvent divisées ou fusionnées après le permis : avec le seul cadastre actuel, 88 % des autorisations de logements de Montreuil trouvent leur parcelle ; avec tous les millésimes, 97 %. Les dossiers déposés sous un ancien numéro apparaissent sur la parcelle actuelle. À Montreuil, 1 721 dossiers sur 1 729 sont localisés.

## Operating Context

- Moment : avant l'achat d'un bien.
- **Non établi : l'appareil et la situation de consultation** (ordinateur, chez soi, ou téléphone, sur place pendant une visite). À trancher avant tout choix qui privilégie l'un ou l'autre.
- Documents produits : rapport imprimé ou enregistré en PDF, tableau CSV, lien qui reproduit la vue.
- Données : SITADEL est mise à jour chaque mois ; une autorisation est diffusée environ un mois après la décision. Le site affiche le mois des données.
- Pilote : Montreuil (INSEE 93048). Extension à d'autres communes prévue, avec mise à jour mensuelle ; communes non choisies.

## Capabilities and Constraints

Fonctions en place (`site/`) :
- recherche d'adresse (géocodeur IGN, avec autocomplétion) ; rapport dans un rayon de 100, 200, 300 ou 500 m : autorisations sur la parcelle, sur les voisines (moins de 10 m) et dans le rayon, triées par ampleur, distance ou date, filtrables par type et par année ;
- carte des parcelles portant au moins une autorisation, sur fond plan ou photo IGN ; clic sur une parcelle → ses autorisations, anciennes parcelles comprises ;
- impression PDF, export CSV, liens partageables (l'état de la vue est dans l'URL).

Contraintes techniques :
- site statique, sans serveur, sans framework ni étape de construction (décidé le 4 octobre 2026), publié sur GitHub Pages : https://construktible.github.io/argos/ ;
- CSP stricte en balise meta : aucune nouvelle origine sans décision explicite ;
- préparation des données en Python 3, bibliothèque standard seulement ;
- données publiques uniquement (Licence Ouverte 2.0), sources citées : SITADEL (SDES), cadastre DGFiP / Etalab, IGN Géoplateforme (BAN, fonds de carte). Les adresses saisies sont envoyées au géocodeur de l'IGN.

Limites des données, à montrer et non à cacher :
- seules les autorisations **accordées** qui créent des logements ou de la surface de plancher, plus les permis d'aménager et de démolir : ni refus, ni demandes en cours d'instruction ;
- environ un mois entre la décision et la diffusion ;
- état d'avancement (commencé, terminé, annulé) peu fiable ;
- quelques dossiers non localisables (8 à Montreuil).

Vocabulaire : « autorisation d'urbanisme » ; sigles PC (permis de construire), DP (déclaration préalable, petits travaux), PA (permis d'aménager, lotissement), PD (permis de démolir) ; « parcelle actuelle », « ancienne parcelle » ; « rayon ».

## Brand Commitments

- Nom : Argos.
- Indépendance affichée : « Projet personnel, sans lien avec la Ville de Montreuil ni avec une administration » (README, pied de page du site).
- Langue : français.

## Evidence on Hand

- Données réelles de Montreuil : `data/93048/dossiers.csv` (1 729 autorisations depuis 2013 : PC 1 026, DP 389, PD 302, PA 12) et `site/data/93048/`.
- Évaluation de la recherche (`CLAUDE.md`) : pour 1 531 dossiers, chercher leur adresse fait ressortir le dossier sur la parcelle dans 79,8 % des cas, sur la parcelle ou une voisine dans 90,2 %.
- Direction visuelle : `design/DESIGN.md` ; maquettes : `design/maquette/` (données fictives, à ne pas reprendre).
- Aucun témoignage, client, partenaire, chiffre d'audience ni article de presse : ne pas en inventer.

## Product Principles

1. **L'acheteur d'abord.** En cas d'arbitrage, on optimise pour la personne qui s'apprête à acheter ; les professionnels passent ensuite.
2. **Dire ce que les données ne disent pas.** Les limites de SITADEL accompagnent les réponses ; rien ne doit laisser croire qu'aucun projet ne viendra autour du bien.
3. **Tout ce qui touche la parcelle, même sous d'anciens numéros.** Le rattachement sur tous les millésimes du cadastre reste visible dans l'interface.
4. **Français courant.** Les codes de la source sont traduits en libellés clairs ; seuls les identifiants officiels (numéro de dossier, référence cadastrale) restent tels quels.
5. **Données publiques, sources citées, indépendance affichée.**
