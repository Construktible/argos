"""
Prépare les données du site public (site/data/<INSEE>/) à partir du jeu consolidé.

  parcelles.json  parcelles actuelles (GeoJSON : id, contenance), coordonnées arrondies à 6 décimales (~10 cm)
  anciennes.json  parcelles disparues rattachées à au moins un dossier, avec leurs successeurs : parcelles actuelles
                  qui recouvrent au moins 5 % de leur surface (estimé sur une grille de points)
  dossiers.json   dossiers (colonnes de dossiers.csv), avec `parcelles` (rattachement direct, actuelles ou anciennes)
                  et `actuelles` (parcelles actuelles concernées : directes, successeurs des anciennes, ou parcelle
                  de l'adresse pour un dossier localisé par géocodage)
  adresses.json   numéros de rue de la commune (Base Adresse Nationale), affichés sur la carte pour se repérer
  meta.json       millésimes, date de génération, emprise, effectifs, année de départ (communes.DEBUT_FIABLE)

Dans les communes de communes.DEBUT_FIABLE, les dossiers autorisés avant l'année fiable sont écartés (numéros de
parcelle tronqués dans SITADEL) et comptés dans meta.json (`ecartes`).

Entrées : data/<INSEE>/dossiers.csv, dossiers_parcelles.csv, parcelles.geojson (sorties de 02 à 04),
          doc_source/ban/adresses-<DEP>.csv.gz (https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/)

Usage : python3 scripts/05_site.py [CODE_INSEE]
"""
from __future__ import annotations

import csv
import gzip
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from communes import DEBUT_FIABLE, departement, nom as nom_commune
from recherche import ROOT, Index, contient, polygones

PART_MIN = 0.05  # part de la surface d'une parcelle disparue pour qu'une parcelle actuelle soit dite successeur
CELLULE = 0.0005  # degrés (~40-55 m) : grille d'index spatial des parcelles actuelles


def arrondir(coords):
    return [arrondir(c) for c in coords] if isinstance(coords[0], list) else [round(c, 6) for c in coords]


def echantillon(geom: dict, n: int) -> list[tuple[float, float]]:
    """Points d'une grille régulière sur l'emprise, gardés s'ils tombent dans le polygone."""
    polys = polygones(geom)
    xs, ys = zip(*(pt for poly in polys for pt in poly[0]))
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    k = max(2, math.isqrt(n))
    grille = [(x0 + (i + .5) * (x1 - x0) / k, y0 + (j + .5) * (y1 - y0) / k) for i in range(k) for j in range(k)]
    return [p for p in grille if contient(polys, *p)]


def main():
    insee = sys.argv[1] if len(sys.argv) > 1 else "93048"
    idx = Index(insee)
    out = ROOT / "site" / "data" / insee
    out.mkdir(parents=True, exist_ok=True)

    actuelles = {i for i, f in idx.parcelles.items() if f["properties"]["actuelle"]}
    grille = defaultdict(list)
    for i in actuelles:
        x0, y0, x1, y1 = idx.emprises[i]
        for cx in range(int(x0 // CELLULE), int(x1 // CELLULE) + 1):
            for cy in range(int(y0 // CELLULE), int(y1 // CELLULE) + 1):
                grille[cx, cy].append(i)

    def parcelle_actuelle(x: float, y: float) -> str | None:
        for i in grille.get((int(x // CELLULE), int(y // CELLULE)), ()):
            x0, y0, x1, y1 = idx.emprises[i]
            if x0 <= x <= x1 and y0 <= y <= y1 and contient(polygones(idx.parcelles[i]["geometry"]), x, y):
                return i
        return None

    debut = DEBUT_FIABLE.get(insee)
    gardes = {i for i, r in idx.dossiers.items() if not debut or r["date_autorisation"][:4] >= str(debut)}
    anciennes_liees = {p for i in gardes for p in idx.liens.get(i, ())} - actuelles
    successeurs = {}
    for a in sorted(anciennes_liees):
        geom = idx.parcelles[a]["geometry"]
        pts = echantillon(geom, 400) or echantillon(geom, 4000)
        compte = Counter(parcelle_actuelle(x, y) for x, y in pts)
        compte.pop(None, None)
        successeurs[a] = sorted(c for c, k in compte.items() if k / max(len(pts), 1) >= PART_MIN)

    dossiers = []
    for i, r in idx.dossiers.items():
        if i not in gardes:
            continue
        directes = sorted(idx.liens.get(i, ()))
        concernees = {p for p in directes if p in actuelles} | {s for p in directes if p in successeurs for s in successeurs[p]}
        if r["localisation"] == "adresse":
            res = idx.rechercher(float(r["lon"]), float(r["lat"]), 0)
            concernees |= {p for p in res["au_point"] if p in actuelles}
        dossiers.append({**r, "parcelles": directes, "actuelles": sorted(concernees)})

    def ecrire(nom, contenu):
        with (out / nom).open("w", encoding="utf-8") as f:
            json.dump(contenu, f, ensure_ascii=False, separators=(",", ":"))

    def feature(i, props):
        g = idx.parcelles[i]["geometry"]
        return {"type": "Feature", "properties": props, "geometry": {"type": g["type"], "coordinates": arrondir(g["coordinates"])}}

    ecrire("parcelles.json", {"type": "FeatureCollection", "features": [
        feature(i, {"id": i, "c": idx.parcelles[i]["properties"]["contenance"]}) for i in sorted(actuelles)]})
    ecrire("anciennes.json", {"type": "FeatureCollection", "features": [
        feature(a, {"id": a, "premier": idx.parcelles[a]["properties"]["premier_millesime"],
                    "dernier": idx.parcelles[a]["properties"]["dernier_millesime"], "successeurs": successeurs[a]})
        for a in sorted(anciennes_liees)]})
    ecrire("dossiers.json", dossiers)

    dep = departement(insee)
    with gzip.open(ROOT / "doc_source" / "ban" / f"adresses-{dep}.csv.gz", "rt", encoding="utf-8") as f:
        numeros = [{"type": "Feature", "properties": {"n": f"{r['numero']}{r['rep']}"},
                    "geometry": {"type": "Point", "coordinates": [round(float(r["lon"]), 6), round(float(r["lat"]), 6)]}}
                   for r in csv.DictReader(f, delimiter=";") if r["code_insee"] == insee and r["numero"] not in ("", "99999")]
    ecrire("adresses.json", {"type": "FeatureCollection", "features": numeros})

    emprises = [idx.emprises[i] for i in actuelles]
    sitadel = sorted((ROOT / "doc_source").glob("Liste-des-permis-de-demolir.*.csv"))[-1].name.split(".")[-2]
    ecrire("meta.json", {
        "insee": insee, "commune": nom_commune(insee), "sitadel": sitadel,
        "cadastre": max(f["properties"]["dernier_millesime"] for f in idx.parcelles.values()),
        "genere": date.today().isoformat(),
        "emprise": [min(e[0] for e in emprises), min(e[1] for e in emprises), max(e[2] for e in emprises), max(e[3] for e in emprises)],
        "dossiers": len(dossiers), "non_localises": sum(d["localisation"] == "aucune" for d in dossiers),
        "premiere_annee": min(d["date_autorisation"][:4] for d in dossiers if d["date_autorisation"]),
        "debut_fiable": debut, "ecartes": len(idx.dossiers) - len(gardes),
    })

    sans_successeur = sum(not s for s in successeurs.values())
    print(f"{len(actuelles)} parcelles actuelles, {len(anciennes_liees)} anciennes rattachées à un dossier "
          f"({sans_successeur} sans successeur), {len(dossiers)} dossiers")
    for nom in ("parcelles.json", "anciennes.json", "dossiers.json", "adresses.json", "meta.json"):
        print(f"  {nom:15s} {(out / nom).stat().st_size / 1e6:6.2f} Mo")


if __name__ == "__main__":
    main()
