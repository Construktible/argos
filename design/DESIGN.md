# Argos · direction visuelle (5 octobre 2026)

Validée par l'utilisateur à partir d'une maquette réalisée dans Claude (canevas « Argos — maquette »).
`design/maquette/` contient le code source des deux écrans (`accueil.dc.html`, `resultat.dc.html`). C'est le format du canevas : du HTML avec des styles en ligne et des gabarits `{{ }}`. Ces fichiers ne s'ouvrent pas seuls dans un navigateur et servent seulement de référence pour les couleurs, les tailles, les espacements et les textes.

**Les données des maquettes sont fictives.** Ne rien en reprendre : certaines cartes montrent des DP sans surface créée (« Ravalement », « Clôture »), qui n'existent pas dans SITADEL.

## Principe

La recherche passe au premier plan, la carte au second. La question directrice est : « Qu'est-ce qui se prépare autour de cette adresse ? »
Une fois l'adresse saisie, on affiche d'abord une synthèse et une liste ; la carte vient en appui. Le modèle est la vue partagée liste + carte de Zillow.

## Ce qui ne change pas

- Toutes les fonctions actuelles de `site/` : vue parcelle (anciennes parcelles comprises), rapport dans un rayon, surlignage, impression PDF, export CSV, URL partageables (`lireUrl` / `naviguer`), fond plan / photo IGN, mode sombre.
- Moteur (`rechercher`), données, `05_site.py`.
- Site statique, sans framework ni étape de build. CSP : aucune nouvelle origine.
- `RAYONS = [100, 200, 300, 500]` : on garde ces valeurs (la maquette montre 150 / 300 / 500, ce n'est pas une décision).

## Jetons

On garde les noms de variables de `style.css` et on change leurs valeurs.

| Rôle | Valeur | Note |
|---|---|---|
| Fond de page (« papier ») | `#F5F3EE` | |
| Surface (cartes, en-tête de résultat) | `#FFFFFF` | |
| Encre | `#1D2125` | texte, boutons principaux, adresse choisie, rayon |
| Encre secondaire | `#3F4349` | texte courant secondaire |
| Encre tertiaire | `#4A4E54` / `#5C6066` | mentions, métadonnées |
| Trait | `#DDD9D0` | séparateurs |
| Trait fort | `#CFCBC1` | contours de contrôles |
| PC · permis de construire | `#C2410C` | texte blanc |
| PA · permis d'aménager | `#0B7285` | texte blanc |
| PD · permis de démolir | `#7048E8` | texte blanc |
| DP · déclaration préalable | `#E0A100` | **texte encre**, pas blanc |

- Chaque type garde sa couleur partout : badges de la liste, puces de filtre, légende, fiche.
- L'orange actuel (`--accent: #eb6834`) disparaît : il se confondrait avec le PC. L'adresse choisie et le rayon passent à l'encre.
- Mode sombre : dériver les jetons (par exemple fond `#141618`, surface `#1D2023`, encre `#F1EFEA`, trait `#33363A`), puis vérifier les contrastes des badges.
- Rayons d'angle : 8 px (petits contrôles), 10 à 12 px (barre et boutons), 14 px (cartes de dossier), 16 px (barre de l'accueil).

## Typographie

- IBM Plex Sans (400, 500, 600) pour tout le texte.
- IBM Plex Mono (400, 500) pour ce qui relève du registre : n° de dossier, références cadastrales, distances, codes de type, date de mise à jour.
- **Auto-hébergées** en woff2 dans `site/fonts/` : la CSP impose `font-src 'self'`, Google Fonts serait bloqué.
- Titres : graisse 600, interlettrage négatif (−0,015 à −0,025 em).

## Logo

Un point plein entouré de deux anneaux (l'adresse et son rayon), suivi de « argos » en minuscules, graisse 600. Le SVG est en tête des deux fichiers de maquette.

## Écran 1 · Accueil (nouveau, sans carte)

- **En-tête** : logo, puis liens « Explorer la carte » et « Les données », puis la pastille mono « Pilote · Montreuil 93048 ».
- **Hero** :
  - surtitre mono « Autorisations d'urbanisme · données SITADEL » ;
  - H1 « Qu'est-ce qui se prépare autour de cette adresse ? » (36 à 64 px) et un sous-titre ;
  - **la barre de recherche** : label visible, champ de 56 px, bord encre de 1,5 px, rayon 16 px, ombre légère, bouton « Rechercher » plein encre ;
  - exemples cliquables en mono, puis le lien « ou explorer directement sur la carte ».
- **Fond du hero** : motif discret de rues et d'anneaux concentriques, purement décoratif (`aria-hidden`).
- **« De l'adresse au dossier, en trois temps »** : trois colonnes, Une adresse / Un rayon / Chaque dossier.
- **« Quatre types d'autorisations, quatre couleurs »** : quatre cartes, puis les métadonnées (source, cadastre, mise à jour lue dans `meta.json`, couverture).
  - Y ajouter ce que SITADEL ne contient pas : seulement les autorisations accordées qui créent des logements ou de la surface, plus les PA et PD. Pas les refus, ni les dossiers en instruction.
- **Pied de page** : « projet personnel, sans lien avec une administration », plus la licence des données.
- **Barre « intelligente »** :
  - une adresse passe par le géocodeur IGN, comme aujourd'hui ;
  - une référence cadastrale (« AK 0212 » ou idu de 14 caractères) ouvre la vue parcelle ;
  - un n° de dossier (« PC 093048 25 B0041 » ou `PC09304825B0041`) ouvre le dossier ;
  - la détection est automatique, sans menu.

## Écran 2 · Résultat d'une adresse (vue partagée)

- **En-tête compact** : logo, barre de recherche (44 px), puis le sélecteur segmenté « Liste + carte / Liste / Carte ».
- **Barre de filtres** sous l'en-tête :
  - puces par type (pastille de couleur, libellé, nombre dans le rayon, `aria-pressed`) ;
  - rayon en segmenté ;
  - période (le select « Depuis » actuel) ;
  - à droite, la mention mono « SITADEL · mise à jour <meta.sitadel> ».
- **Colonne liste (environ 60 %)** :
  - surtitre mono « Autour du <adresse> » ;
  - H1 de synthèse : « N autorisations à moins de R m » ;
  - ligne « dont X projets importants · Y logements créés » ;
  - tri segmenté avec sa phrase d'aide.
- **Cartes de dossier** (grille `repeat(auto-fill, minmax(260px, 1fr))`) :
  - contenu, de haut en bas : badge de type, mention « Projet important », distance en mono, objet en titre (18 px, 600), détail (logements, surface), adresse, date · demandeur, puis un pied en pointillés (n° de dossier, parcelle(s), en mono) ;
  - chaque carte est un `button` avec `aria-pressed` ; la carte sélectionnée a un contour encre de 2 px et surligne sur la carte.
- **Colonne carte (environ 40 %)** : légende en haut à gauche, zoom et recentrage en haut à droite, fiche du dossier sélectionné en surimpression en bas, attribution en bas à droite.
- **État vide** : « Aucune autorisation ne correspond. Élargissez le rayon, changez de période ou réactivez un type. »
- **Mobile (< 820 px)** : la liste vient d'abord et la carte s'ouvre par le sélecteur. Aujourd'hui, c'est l'inverse.
- La vue parcelle et l'impression gardent leur structure actuelle et prennent seulement les nouveaux jetons.

### Tri

- **Ampleur** (par défaut) : liste plate, projets importants d'abord, puis surface décroissante.
- **Distance** : le regroupement par adresse actuel (`parAdresse`), du plus proche au plus lointain.
- **Date** : liste plate, décisions récentes d'abord.
- L'impression et le CSV ne changent pas (groupés par adresse).

## À trancher avec l'utilisateur avant de coder

1. **Rendu de la carte.** La maquette montre un point par dossier, coloré par type, de trois tailles selon l'ampleur, estompé hors rayon.
   - Or le 4 octobre, l'utilisateur a décidé que les parcelles portant une autorisation seraient colorées **d'une seule couleur, sans dégradé**.
   - De plus, une parcelle peut porter plusieurs dossiers de types différents.
   - Options :
     - **A.** Parcelles d'une seule couleur, comme aujourd'hui ; la couleur par type ne vit que dans la liste.
     - **B.** Un point par dossier, comme dans la maquette, avec les contours de parcelles en contexte.
     - **C.** Parcelles d'une seule couleur, plus des points par dossier au-dessus à fort zoom.
2. **Seuil « projet important ».** Proposition : au moins 10 logements créés, ou au moins 1 000 m² de surface de plancher créée, ou tout PA.
3. **Surlignage.** Garder le jaune actuel, ou passer au contour encre épais de la maquette ?
