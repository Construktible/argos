# Argos

Les autorisations d'urbanisme de la base SITADEL, interrogeables à l'adresse et à la parcelle : permis de construire,
d'aménager, de démolir et déclarations préalables accordés, rattachés au cadastre, y compris sous d'anciens numéros
de parcelle. Pilote : Montreuil (93048).

Site : https://construktible.github.io/argos/

## Contenu

- `site/` : site statique (HTML, CSS, JavaScript, MapLibre), sans serveur ni étape de construction. Ses données sont dans `site/data/<INSEE>/`.
- `scripts/` : préparation des données (Python 3, bibliothèque standard seulement).
- `data/<INSEE>/` : extraits et jeu consolidé par commune, produits par les scripts.
- `design/` : direction visuelle et maquettes du site.
- `CLAUDE.md` : notes du projet (sources, ordre des scripts, pièges des données).

Les fichiers sources bruts (`doc_source/`, environ 1,3 Go) ne sont pas versionnés ; leur provenance est décrite dans `CLAUDE.md`.

## Aperçu local

```bash
python3 -m http.server 8765 --directory site
```

Puis http://localhost:8765.

## Sources et licences

- Autorisations : base SITADEL, service statistique du ministère chargé du logement (SDES), Licence Ouverte 2.0.
- Parcelles : plan cadastral de la DGFiP diffusé par Etalab, Licence Ouverte 2.0.
- Adresses, géocodage et fonds de carte : IGN, Géoplateforme (Base Adresse Nationale).
- Polices IBM Plex : SIL Open Font License 1.1 (`site/fonts/`).

Projet personnel, sans lien avec la Ville de Montreuil ni avec une administration.
