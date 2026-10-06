# Argos

## Objectif

Rendre SITADEL interrogeable spatialement : recherche à l'adresse, croisement des permis avec la géométrie cadastrale des parcelles.
Pilote : **Montreuil (INSEE 93048)**, extension à d'autres communes prévue ensuite.

Destiné au **public**. Usages visés :
- visualiser les autorisations parcelle par parcelle ;
- générer un rapport des autorisations dans un rayon autour d'une adresse (ex. 300 m).

Stack, interface et hébergement : **pas encore décidés**. Ne rien présumer.

Échanges en français, directs et concis.

## Feuille de route

1. [x] **Rattacher les autorisations aux parcelles** : cadastre actuel, puis millésimes 2017-2026 (parcelles renumérotées), puis géocodage de l'adresse pour les dossiers sans parcelle. 1 721 dossiers localisés sur 1 729.
2. [x] **Jeu de données consolidé** : `dossiers.csv` (une ligne par dossier, dédoublonné, codes traduits en libellés), `dossiers_parcelles.csv`, `parcelles.geojson`
3. [x] **Recherche en ligne de commande** (`recherche.py`) : adresse → géocodeur → point → parcelles actuelles et anciennes au point → autorisations sur la parcelle, sur les parcelles voisines, dans un rayon ; export CSV. Moteur réutilisable (classe `Index`).
4. [ ] **Interface publique** : site statique (décidé le 4 octobre 2026) dans `site/`, sans serveur : MapLibre 5.24 (CDN avec SRI), fond et géocodeur IGN, données générées par `05_site.py`. Fonctions voulues par l'utilisateur : (1) clic sur une parcelle → ses autorisations, y compris celles déposées sous d'anciens numéros ; (2) adresse → rapport dans un rayon (300 m par défaut), autorisations groupées par adresse, extrait de carte avec les parcelles portant au moins une autorisation colorées (une seule couleur, pas de dégradé par nombre), impression PDF, CSV. Reste : hébergement.
5. [ ] **Extension à d'autres communes**, mise à jour mensuelle

## Arborescence

```
doc_source/                 fichiers bruts (~1,3 Go, ne pas versionner)
  documentation/            dictionnaires des variables SDES (juin 2026) + note de présentation SDES (2021)
  cadastre/<INSEE>/         cadastre Etalab de la commune, un fichier par millésime (<AAAA-MM-JJ>.json.gz)
data/<INSEE>/               extraits par commune (générés par les scripts, non versionnés depuis le 6 octobre 2026 : 272 Mo pour le 93 et le 94)
scripts/                    pipeline de données (Python 3, stdlib uniquement)
```

## Sources

### SITADEL (SDES, via DiDo)

- Jeu « Liste des permis de construire et autres autorisations d'urbanisme », `datasetId=6513f0189d7d312c80ec5b5b`
  https://www.statistiques.developpement-durable.gouv.fr/catalogue?page=dataset&datasetId=6513f0189d7d312c80ec5b5b
- Mise à jour mensuelle, millésime `AAAA-MM` (dernier utilisé : `2026-09`). Données depuis 2013. Passage à Sitadel3 en mars 2026.
- 4 fichiers :
  - logements : rid `8b35affb-55fc-4c1f-915b-7750f974446a`
  - locaux non résidentiels : rid `f8f0700f-806c-40a7-83b1-f21cf507e7c4`
  - permis d'aménager, permis de démolir : rids non relevés (téléchargés depuis le catalogue)
- API DiDo, publique, sans authentification. Doc : https://cgdd.gitlab-pages.din.developpement-durable.gouv.fr/sdsed-bun/dido/api/
  - JSON paginé : `GET https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles/{rid}/rows?millesime=2026-09&COMM=eq%3A93048` (`page`, `pageSize`, `columns=`)
  - CSV : `GET .../dido/api/v1/datafiles/{rid}/csv?millesime=2026-09&COMM=eq%3A93048`
  - Filtres : `COLONNE=op:valeur`, op ∈ `eq ne in nin gt gte lt lte contains startsWith endsWith`. Encoder `:` en `%3A` (sinon erreur 400 constatée).
- Format CSV : séparateur `;`, **2 lignes d'en-tête** (libellés longs, puis codes de colonnes). Utiliser la 2e.
- Dictionnaires des variables en `.xls` binaire, illisibles en stdlib : les libellés des codes utiles sont recopiés dans `04_dossiers.py`.

### Cadastre (Etalab)

- Environ un millésime par trimestre, de `2017-07-06` à `2026-09-01` (36 au 4 octobre 2026). Liste : https://cadastre.data.gouv.fr/data/etalab-cadastre/
- Fichier d'une commune : `https://cadastre.data.gouv.fr/data/etalab-cadastre/<millésime>/geojson/communes/<DEP>/<INSEE>/cadastre-<INSEE>-parcelles.json.gz` (redirection vers un stockage OVH).
- **`latest` peut avoir un millésime de retard** : le 4 octobre 2026, il pointait encore vers `2026-06-01` alors que `2026-09-01` était en ligne. Prendre le plus récent de la liste.
- Identifiant parcelle sur 14 caractères, ex. `930480000A0237` : `feature.id`, sauf dans le millésime `2017-10-12` où il n'est que dans `properties.id`.
- Montreuil : 14 218 parcelles en 2026-09, 14 756 vues au moins une fois depuis 2017 (538 disparues). Préfixe toujours `000`.

### Géocodage (Géoplateforme IGN, BAN)

- `GET https://data.geopf.fr/geocodage/search?q=<adresse>&index=address&citycode=<INSEE>&limit=1`, public, sans clé. Successeur de `api-adresse.data.gouv.fr` (réponses identiques constatées).
- Réponse GeoJSON : `properties.type` (`housenumber`, `street`…), `score` (0 à 1), `label`, `id` (clé BAN).
- Par lot : `POST https://data.geopf.fr/geocodage/search/csv`, multipart `data=@fichier.csv`, `columns=<colonne adresse>`, `indexes=address`, `citycode=<nom d'une colonne>` (pas une valeur : erreur 400 sinon). 1 700 adresses en 3 s.
- Numéros de rue affichés sur la carte du site : BAN du département, rangée dans `doc_source/ban/adresses-<DEP>.csv.gz` (8 Mo pour le 93, lue par `05_site.py`).
- La BAN (`https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-<DEP>.csv.gz`) a une colonne `cad_parcelles` (parcelles de l'adresse), mais **vide à Montreuil** (2 adresses sur 14 419) : pas de lien adresse → parcelle exploitable, d'où l'approche géométrique.

## Scripts

```
python3 scripts/01_extract_commune.py 93 94      # codes INSEE ou départements, un passage -> data/<INSEE>/{logements,locaux,amenager,demolir}.csv
python3 scripts/02_cadastre.py [INSEE]           # télécharge tous les millésimes -> data/<INSEE>/parcelles.geojson
python3 scripts/03_jointure_cadastre.py [INSEE]  # -> data/<INSEE>/autorisations_parcelles.csv
python3 scripts/04_dossiers.py [INSEE]           # -> data/<INSEE>/dossiers.csv, dossiers_parcelles.csv, geocodage.csv
python3 scripts/qualite.py 93 94                 # dossiers placés sur la carte, par commune -> data/qualite.csv
python3 scripts/evaluation.py 93 94              # recherche à l'adresse de chaque dossier, par commune -> data/evaluation.csv
for c in $(python3 scripts/communes.py 93 94); do python3 scripts/02_cadastre.py $c; done   # idem 03, 04 : par commune

python3 scripts/recherche.py "27 bis rue du Progrès, Montreuil" [--rayon 300] [--csv rapport.csv] [--insee 93048]
python3 scripts/05_site.py [INSEE]               # -> site/data/<INSEE>/{parcelles,anciennes,dossiers,adresses,meta}.json (boucle sur communes.py comme 02)
python3 scripts/06_index.py 93 94                # -> site/data/{communes,contours}.json : index lu au démarrage du site
python3 -m http.server 8765 --directory site     # aperçu local : http://localhost:8765
python3 design/accueil_preuve.py                 # -> site/accueil/plan-{avant,apres}.svg + bloc avant/après de site/index.html
```

Accueil : carré avant / après repris d'impeccable.style (plan réel de Montreuil, autorisations **fictives**, la légende le dit). Généré par `design/accueil_preuve.py` à partir du cadastre (`doc_source/cadastre/93048/`, parcelles et `batiments-2026-09-01.json.gz`) ; il remplace le bloc entre `<!-- preuve:debut -->` et `<!-- preuve:fin -->` d'`index.html` : ne pas l'éditer à la main. Script : `site/preuve.js`.

Démonstration de l'accueil (section `#demo`, `app.js` « Accueil : démonstration », 6 octobre 2026) : 4 adresses réelles fixes (Montreuil, Saint-Denis, Ivry, Cachan) et un curseur de rayon 100/200/300/500 m ; nombre, types et 3 plus grands projets comme l'aperçu public, plan SVG des parcelles réelles (bleu = au moins une autorisation). Communes chargées quand la section approche de l'écran (IntersectionObserver).

Pré-ouverture (`app.js`, section « Avant l'ouverture ») : sans code bêta, une recherche, la carte de la commune ou un lien vers une parcelle ouvrent une page à part (écran `#attente` d'`index.html`, 6 octobre 2026) : aperçu (nombre et types), liste d'attente, accès bêta. Avec le code, la liste et la carte. `CODES_BETA` : empreintes SHA-256 des codes, en minuscules ; `LISTE_ATTENTE` : URL du formulaire Brevo, vide tant que le compte n'existe pas (rien n'est alors enregistré). Le verrou vit dans le navigateur (`localStorage`) : ce n'est pas une protection, les données sont publiques.

Site : après modification de `app.js` ou `style.css`, incrémenter `?v=` dans `index.html` (sinon le navigateur garde l'ancienne version en cache).

Site multi-communes (6 octobre 2026) : au démarrage, seul l'index (`communes.json`, 24 ko, et `contours.json`, 283 ko) est lu ; une vue charge ensuite les communes dont elle a besoin (rapport : communes dont le contour est à moins du rayon + 30 m ; parcelle : sa commune ; `#explorer=<INSEE>` : la commune, `#explorer` seul : liste des 86 communes). Poids : 0,4 Mo compressé par commune en médiane, 1,4 Mo au plus (254 Mo bruts, 35 Mo compressés au total). Les suggestions d'adresse sont filtrées sur les communes couvertes ; un rayon qui sort de la zone est signalé.

- `parcelles.geojson` : toutes les parcelles vues au moins une fois, avec leur dernière géométrie connue (`idu, contenance, premier_millesime, dernier_millesime, actuelle`).
- `autorisations_parcelles.csv` : diagnostic de la jointure, une ligne par fichier source × autorisation × référence cadastrale (`fichier, type_dau, num_dau, rang, section, numero, idu, statut, dernier_millesime, date_autorisation`). `statut` : `actuelle` (présente dans le dernier millésime), `ancienne` (disparue depuis), `introuvable`.
- `dossiers.csv` : **le produit**. Une ligne par dossier (`id` = type + numéro, ex. `PC09304812B0119`), codes traduits en libellés, champs mal renseignés écartés. `localisation` : `parcelle_actuelle`, `parcelle_ancienne`, `adresse` (géocodée au numéro), `voie` (géocodée à la rue seulement, imprécis), `aucune` ; `lon`, `lat` = barycentre des parcelles ou point géocodé.
- `dossiers_parcelles.csv` : `id, idu, statut`.
- `geocodage.csv` : requêtes envoyées au géocodeur et réponses (`retenu` 0/1). Sert de cache.
- `recherche.py` : le point de l'adresse est ramené 50 cm à l'intérieur de la parcelle actuelle la plus proche (25 m max), puis on prend les parcelles actuelles et anciennes qui le contiennent. Parcelles voisines : à moins de 10 m au-delà de la plus proche. Rayon : distance du point au contour des parcelles du dossier. Distances en plan tangent au point.

## Pièges des données (vérifiés sur Montreuil)

- **SITADEL ne recense pas toutes les autorisations** : seulement les autorisations accordées (ni refus, ni dossiers en instruction) qui créent des logements ou de la surface de plancher, y compris par transformation, plus les PA et PD. Vérifié : 6 dossiers sur 1 054 sans logement créé dans logements, 1 seul sans surface créée ni transformée. Un agrandissement de maison sans nouveau logement n'y figure pas.
- **Identifiant d'un dossier = `TYPE_DAU` + `NUM_DAU`**. `NUM_DAU` seul n'est pas unique : un PC et une DP peuvent partager le même numéro (26 cas dans logements). PA et PD : `NUM_PA` / `NUM_PD`. `NUM_DAU` = code commune (6) + année de dépôt (2) + numéro d'ordre (5).
- Un dossier peut figurer dans plusieurs fichiers : logements **et** locaux pour un projet mixte (191 à Montreuil), et un PA aussi dans logements ou locaux. Dédoublonner sur type + numéro : 1 729 dossiers uniques à Montreuil.
- `DESTINATION_PRINCIPALE` n'a pas la même nomenclature dans logements (1 logements, 2 non résidentiel) et dans locaux (1 habitation à 9 service public). Les surfaces non résidentielles sont aussi plus complètes dans locaux. Pour un dossier mixte, prendre locaux.
- **Parcelle** : `INSEE + "000" + section.rjust(2, "0") + numero.rjust(4, "0")`. Le préfixe est généralement absent de SITADEL. Quelques sections aberrantes (`0`, `01`).
- 3 références cadastrales maximum par dossier, alors qu'un terrain peut en compter davantage.
- **Les parcelles sont renumérotées après le permis** (division, fusion) : une référence SITADEL désigne souvent une parcelle absente du cadastre actuel. D'où la jointure sur tous les millésimes.
- **Accents corrompus dans la source** (~2 % des lignes nationales) : « RUE MOLIAÃ\x82Â\x88RE » pour RUE MOLIÈRE (l'accent devenu « A », l'octet suivant doublement mal décodé). Réparé dans `04_dossiers.py` (~97 % des cas ; 1 valeur résiduelle à Montreuil).
- **Le point d'une adresse tombe hors parcelle dans 81 % des cas** (façade, voie), à 0,9 m en médiane : il faut le ramener dans la parcelle la plus proche avant tout test d'inclusion.
- `ADR_LIBVOIE_TER` : 26 caractères max, type de voie inclus (`ADR_TYPEVOIE_TER` n'existe plus). Les libellés longs sont tronqués, les saisies hétérogènes (`48-50`, `54 BI`, `RUE KLEBER (48/50 RUE DE V`, `278 280 292 294 300 BD DE`). Le géocodeur peut alors répondre une autre rue avec un score moyen (« 278 BD DE » → « 278 Rue de Rosny », 0,58) : exiger qu'un mot significatif de la voie figure dans la réponse.
- `DR_DEPOT` (date réelle de dépôt, ajoutée en avril 2026) inutilisable : 85 % des dates au 1er janvier, 216 postérieures à l'autorisation (sans doute un modificatif). L'année de dépôt `AN_DEPOT`, tirée du numéro, est fiable.
- `SUPERFICIE_TERRAIN` = 0 signifie non renseignée (212 dossiers).
- `DPC_*` (mois de prise en compte) est au format `AAAA-MM`, pas `AAAAMM` comme l'indique le dictionnaire. Une autorisation est diffusée à la fin du mois suivant sa prise en compte : à Montreuil (2021-2025), délai médian d'**environ 1 mois** entre la décision et sa diffusion, plus de 3 mois dans 2 à 5 % des cas.
- `NATURE_PROJET_COMPLETEE` est illisible pour le public (« transformation sans extension ni diminution de surface »). `04_dossiers.py` écrit un champ `objet` en clair à partir de `TYPE_TRANSFO_PRINCIPAL` et des destinations avant/après : « Changement de destination : atelier d'artisanat → logement · 1 logement créé ».
- `TYPE_PRINCIP_LOCAUX_TRANSFORMES` = 5 (180 dossiers à Montreuil) est absent du dictionnaire 2026. **Interprétation, non confirmée par le SDES** : ancienne destination « artisanat » (nomenclature d'avant 2016, dont les autres codes coïncident).
- `I_EXTENSION`, `I_SURELEVATION`, `I_NIVSUPP` : jamais renseignés à Montreuil.
- `COMM` est tiré du numéro de dossier, pas recodifié selon le COG. **Pierrefitte-sur-Seine (93059) fusionnée dans Saint-Denis (93066) au 1er janvier 2025** : 346 lignes ont encore 93059. Le cadastre a un fichier 93059 jusqu'en 2024-10 (`930590000A0297`), puis la parcelle passe dans 93066 avec le préfixe `059` (`930660590A0297`). Géré par `communes.FUSIONS` (01, 02, 03). Le géocodeur répond `citycode` 93066, `oldcitycode` 93059.
- `ETAT_*` (2 autorisé, 4 annulé, 5 commencé, 6 terminé) peu fiable : selon le SDES, ~15 % des ouvertures de chantier, 1/3 des achèvements et près de la moitié des annulations ne remontent jamais.
- Champs demandeur (`DENOM_DEM`, `SIREN_DEM`…) vides pour les personnes physiques.

### Vus en étendant au 93 et au 94 (6 octobre 2026)

- **Numéros de parcelle tronqués à 2 chiffres** certaines années (« K 16 » pour K 163) : le dossier tombe sur une parcelle existante à 150-250 m de la bonne. Clichy-sous-Bois avant 2017, Montfermeil avant 2018, Neuilly-sur-Marne avant 2020, L'Haÿ-les-Roses 2016-2020, Joinville-le-Pont avant 2021 (moins de 25 % des dossiers retrouvés à leur adresse, contre ~80 % ensuite). Choix de l'utilisateur : pas de correction, le site n'affiche ces communes qu'à partir de l'année fiable, avec une mention (`communes.DEBUT_FIABLE`).
- Sections mal saisies : « D0 » pour « 0D », lettre O pour zéro (« OB », « OY »). Essayées en second par 03 quand la section n'existe pas dans la commune.
- 22 enregistrements en France ont un retour à la ligne dans un champ entre guillemets (lecture ligne à ligne impossible) ; surfaces parfois décimales (« 63.97 ») ; communes sans aucun PA.
- Le géocodeur répond parfois 504 : 04 et `evaluation.py` réessaient.
- Le millésime cadastre `2018-01-02` manque pour tout le 94 chez Etalab ; les fichiers départementaux n'existent pas pour les anciens millésimes (404 en 2017).
- 93 et 94 : 35 084 dossiers, 97,3 % sur la carte. 945 perdus, dont 787 sans adresse ni référence dans SITADEL. Recherche à l'adresse : 77,5 % des dossiers sur leur parcelle, 87,5 % avec les voisines (Montreuil 82,6 / 92,1 avec `evaluation.py`).

## État au 4 octobre 2026 (SITADEL 2026-09, cadastre 2026-09-01, Montreuil)

| Fichier   | Autorisations | ≥ 1 réf. cadastrale | Rattachées, cadastre actuel | Rattachées, tous millésimes |
|-----------|---------------|---------------------|-----------------------------|-----------------------------|
| logements | 1 054         | 99,6 %              | 88,4 %                      | 97,1 %                      |
| locaux    | 554           | 99,6 %              | 91,5 %                      | 97,8 %                      |
| démolir   | 302           | 99,0 %              | 85,8 %                      | 97,0 %                      |
| aménager  | 12            | 10                  | 5                           | 9                           |

Références : 2 364 actuelles, 293 anciennes, 93 introuvables (sur 2 750).

- **Anciennes : renumérotation vérifiée.** 271 sur 293 désignent une parcelle disparue *après* l'autorisation, en médiane 2 ans plus tard (quartiles 1,1 et 3,6 ans). 17 avaient déjà disparu au moment de l'autorisation (référence périmée), 5 sont indéterminées (même trimestre).
- **Introuvables** (68 parcelles distinctes) : 69 sur 93 concernent des autorisations de 2013-2016, donc probablement des parcelles disparues avant le premier millésime Etalab (juillet 2017). Depuis 2017, moins de 2,5 % des références par an. 8 ont une section inexistante (`OY`, `SN`, `GC`, `0`, `01`), 5 un numéro supérieur au maximum de leur section.

Dossiers (`dossiers.csv`) : 1 729 (PC 1 026, DP 389, PD 302, PA 12) ; 783 autorisés, 570 terminés, 268 commencés, 108 annulés.
Localisation : parcelle actuelle 1 541, parcelle ancienne 143, adresse géocodée 33, rue seulement 4, aucune 8 (7 sans adresse ni référence, 1 adresse inexploitable).

**Évaluation de la recherche** : pour chacun des 1 531 dossiers rattachés à une parcelle et dont l'adresse SITADEL se géocode au numéro, on cherche cette adresse. Le dossier ressort sur la parcelle dans **79,8 %** des cas, sur la parcelle ou une voisine dans **90,2 %** (2,2 dossiers listés par adresse en moyenne). Manqués : adresse au coin de deux parcelles, parcelle du dossier en second rang derrière la façade, adresse SITADEL mal géocodée (« 1 RUE CLAIRE MAISON » → « 1 Rue Molière ») ou référence cadastrale incohérente avec l'adresse. Le rapport de rayon n'est pas affecté par ces écarts de quelques mètres.
