"""
Recherche à l'adresse : parcelles au point de l'adresse, autorisations qui s'y rattachent, et autorisations dans un rayon.

Le point vient du géocodeur de la Géoplateforme. Parcelles au point : actuelles et anciennes qui le contiennent (une
parcelle renumérotée garde les permis déposés sous son ancien numéro). Le point d'une adresse tombe souvent sur la
façade ou la voie, hors parcelle : on le ramène alors 50 cm à l'intérieur de la parcelle actuelle la plus proche
(25 m au plus), puis on cherche les parcelles qui contiennent ce point rapproché. Les dossiers des parcelles voisines
(à moins de 10 m au-delà de la plus proche) sont listés à part : à Montreuil, en cherchant l'adresse SITADEL de chaque
dossier, 80 % ressortent sur la parcelle, 90 % sur la parcelle ou une voisine.
Rayon : un dossier en fait partie si l'une de ses parcelles est à moins de R mètres du point (distance au contour), ou,
pour un dossier localisé par géocodage, si son point l'est. Les dossiers non localisés sont exclus, et comptés.
Distances calculées dans un plan tangent au point recherché : écart négligeable à l'échelle d'une commune.

Entrées : data/<INSEE>/dossiers.csv, dossiers_parcelles.csv, parcelles.geojson (sorties de 02 à 04)

Usage : python3 scripts/recherche.py "27 bis rue du Progrès, Montreuil" [--rayon 300] [--csv rapport.csv] [--insee 93048]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEOCODEUR = "https://data.geopf.fr/geocodage/search"
R_TERRE = 6371008.8
TOLERANCE_VOIE = 25  # m : distance max entre le point de l'adresse et la parcelle la plus proche
RENTREE = 0.5  # m : le point rapproché est placé à cette distance à l'intérieur du contour
VOISINAGE = 10  # m : au-delà de la parcelle la plus proche, parcelles dites voisines


def geocoder(adresse: str) -> dict | None:
    url = GEOCODEUR + "?" + urllib.parse.urlencode({"q": adresse, "index": "address", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": "Argos (recherche)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        features = json.load(r)["features"]
    if not features:
        return None
    p, (lon, lat) = features[0]["properties"], features[0]["geometry"]["coordinates"]
    return {"label": p["label"], "type": p["type"], "score": p["score"], "citycode": p.get("citycode", ""),
            "lon": lon, "lat": lat}


def polygones(geom: dict) -> list:
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def contient(polys: list, x: float, y: float) -> bool:
    for poly in polys:
        dedans = False
        for anneau in poly:  # règle pair-impair sur tous les anneaux : les trous ressortent
            for (x0, y0), (x1, y1) in zip(anneau, anneau[1:]):
                if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                    dedans = not dedans
        if dedans:
            return True
    return False


def plus_proche(polys: list) -> tuple[float, float, float]:
    """Distance de l'origine (le point recherché) au polygone, et point du contour le plus proche. 0 si dedans."""
    if contient(polys, 0.0, 0.0):
        return 0.0, 0.0, 0.0
    best = (math.inf, 0.0, 0.0)
    for poly in polys:
        for anneau in poly:
            for (x0, y0), (x1, y1) in zip(anneau, anneau[1:]):
                dx, dy = x1 - x0, y1 - y0
                t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(x0 * dx + y0 * dy) / (dx * dx + dy * dy)))
                px, py = x0 + t * dx, y0 + t * dy
                if math.hypot(px, py) < best[0]:
                    best = (math.hypot(px, py), px, py)
    return best


class Index:
    """Données d'une commune, chargées une fois pour enchaîner les recherches."""

    def __init__(self, insee: str):
        d = ROOT / "data" / insee
        with (d / "parcelles.geojson").open(encoding="utf-8") as f:
            self.parcelles = {feat["id"]: feat for feat in json.load(f)["features"]}
        self.emprises = {}
        for idu, feat in self.parcelles.items():
            xs, ys = zip(*(pt for poly in polygones(feat["geometry"]) for pt in poly[0]))
            self.emprises[idu] = (min(xs), min(ys), max(xs), max(ys))
        with (d / "dossiers.csv").open(encoding="utf-8", newline="") as f:
            self.dossiers = {r["id"]: r for r in csv.DictReader(f, delimiter=";")}
        self.liens = defaultdict(set)  # id dossier -> parcelles rattachées (actuelles ou anciennes)
        with (d / "dossiers_parcelles.csv").open(encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f, delimiter=";"):
                if r["statut"] != "introuvable":
                    self.liens[r["id"]].add(r["idu"])

    def rechercher(self, lon0: float, lat0: float, rayon: float) -> dict:
        """Parcelles au point, dossiers sur ces parcelles et sur les voisines, dossiers dans le rayon,
        distances (id -> m). `rapproche` : distance du point à la parcelle actuelle la plus proche, s'il a fallu
        le rapprocher."""
        kx = math.radians(1) * R_TERRE * math.cos(math.radians(lat0))  # mètres par degré, plan tangent au point
        ky = math.radians(1) * R_TERRE
        marge = max(rayon, TOLERANCE_VOIE + VOISINAGE)
        bx0, bx1, by0, by1 = lon0 - marge / kx, lon0 + marge / kx, lat0 - marge / ky, lat0 + marge / ky
        proj, proches = {}, {}
        for idu, (x0, y0, x1, y1) in self.emprises.items():
            if x1 >= bx0 and x0 <= bx1 and y1 >= by0 and y0 <= by1:
                proj[idu] = [[[((x - lon0) * kx, (y - lat0) * ky) for x, y in anneau] for anneau in poly]
                             for poly in polygones(self.parcelles[idu]["geometry"])]
                proches[idu] = plus_proche(proj[idu])

        au_point, rapproche = [], None
        actuelles = sorted((v[0], idu) for idu, v in proches.items() if self.parcelles[idu]["properties"]["actuelle"])
        if actuelles and actuelles[0][0] <= TOLERANCE_VOIE:
            dist0, idu0 = actuelles[0]
            sx = sy = 0.0
            if dist0 > 0:
                _, px, py = proches[idu0]
                sx, sy, rapproche = px * (dist0 + RENTREE) / dist0, py * (dist0 + RENTREE) / dist0, dist0
            au_point = [idu for idu, polys in proj.items() if contient(polys, sx, sy)]
            if idu0 not in au_point:  # rapprochement dans un angle rentrant : on garde au moins la plus proche
                au_point.insert(0, idu0)

        distances, sur_parcelle = {}, set()
        for i, idus in self.liens.items():
            dist = min((proches[p][0] for p in idus if p in proches), default=math.inf)
            if dist <= marge:
                distances[i] = dist
            if idus & set(au_point):
                sur_parcelle.add(i)
        for i, r in self.dossiers.items():
            if r["localisation"] in ("adresse", "voie"):
                x, y = (float(r["lon"]) - lon0) * kx, (float(r["lat"]) - lat0) * ky
                if math.hypot(x, y) <= marge:
                    distances[i] = math.hypot(x, y)
                    if any(contient(proj[p], x, y) for p in au_point):
                        sur_parcelle.add(i)
        voisines = set()
        if au_point:
            voisines = {i for i, dist in distances.items() if dist <= (rapproche or 0) + VOISINAGE} - sur_parcelle
        return {"au_point": au_point, "rapproche": rapproche, "sur_parcelle": sur_parcelle, "voisines": voisines,
                "dans_rayon": {i: dist for i, dist in distances.items() if dist <= rayon}, "distances": distances}


def numero(r: dict) -> str:  # format des panneaux de chantier : PC 093 048 24 B0107
    n = r["num"]
    return f'{r["type"]} {n[:3]} {n[3:6]} {n[6:8]} {n[8:]}'


def tronquer(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n - 1] + "…"


def projet(r: dict) -> str:
    return " · ".join(m for m in (r["objet"], r["demandeur"]) if m)


def main():
    ap = argparse.ArgumentParser(description="Autorisations d'urbanisme à une adresse et dans un rayon autour.")
    ap.add_argument("adresse")
    ap.add_argument("--rayon", type=float, default=300, help="en mètres (défaut : 300)")
    ap.add_argument("--csv", type=Path, help="exporte les autorisations du rayon")
    ap.add_argument("--insee", default="93048")
    args = ap.parse_args()

    g = geocoder(args.adresse)
    if not g:
        sys.exit("Adresse introuvable.")
    idx = Index(args.insee)
    res = idx.rechercher(g["lon"], g["lat"], args.rayon)
    dossiers, dans_rayon, distances = idx.dossiers, res["dans_rayon"], res["distances"]

    precision = {"housenumber": "au numéro", "street": "à la voie : position approximative"}.get(g["type"], "position approximative")
    print(f"Adresse : {g['label']} ({precision}, score {g['score']:.2f}) | {g['lon']:.6f}, {g['lat']:.6f}")
    if g["citycode"] != args.insee:
        print(f"Attention : adresse hors de la commune couverte ({args.insee}), seules ses autorisations sont prises en compte.")

    note = f" (point de l'adresse à {res['rapproche']:.0f} m de la parcelle la plus proche : rapproché)" if res["rapproche"] else ""
    print(f"\nParcelle(s) au point{note} :")
    for i in res["au_point"]:
        p = idx.parcelles[i]["properties"]
        statut = "actuelle" if p["actuelle"] else f"ancienne, au cadastre de {p['premier_millesime'][:7]} à {p['dernier_millesime'][:7]}"
        print(f"  section {i[8:10].lstrip('0') or '0'} n° {i[10:].lstrip('0')}  ({i}, {p['contenance'] or '?'} m²)  {statut}")
    if not res["au_point"]:
        print("  aucune")

    def lister(ids, avec_distance):
        for i in sorted(ids, key=lambda i: (dossiers[i]["date_autorisation"], i), reverse=True):
            r = dossiers[i]
            dist = f"{'≈' if r['localisation'] == 'voie' else ' '}{distances[i]:4.0f} m  " if avec_distance else ""
            print(f"  {dist}{r['date_autorisation']}  {numero(r):19s}  {r['etat']:9s}  {tronquer(r['adresse'], 28):28s}  "
                  f"{tronquer(projet(r), 95)}")

    print(f"\nAutorisations sur ces parcelles : {len(res['sur_parcelle'])}")
    lister(res["sur_parcelle"], False)
    if res["voisines"]:
        print(f"\nSur les parcelles voisines (à moins de {VOISINAGE} m au-delà) : {len(res['voisines'])}")
        lister(res["voisines"], True)

    valides = [dossiers[i] for i in dans_rayon if dossiers[i]["etat"] != "annulé"]
    types = Counter(dossiers[i]["type"] for i in dans_rayon)
    logements = sum(int(r["nb_logements_crees"] or 0) for r in valides)
    surface = sum(int(r["surf_habitation_creee"] or 0) + int(r["surf_non_residentielle_creee"] or 0) for r in valides)
    milliers = lambda n: f"{n:,}".replace(",", " ")
    print(f"\nAutorisations à moins de {args.rayon:.0f} m : {len(dans_rayon)}"
          + (" (" + ", ".join(f"{t} {n}" for t, n in types.most_common()) + ")" if types else ""))
    if valides:
        print(f"  hors annulées : {milliers(logements)} logements créés, {milliers(surface)} m² de surface de plancher créée")
    lister(dans_rayon, True)

    non_localises = sum(r["localisation"] == "aucune" for r in dossiers.values())
    print(f"\n≈ : dossier localisé à la rue seulement. {non_localises} autorisations de la commune ne sont pas localisées, "
          "donc absentes de toute recherche.")
    print("SITADEL ne recense que les autorisations accordées qui créent des logements ou de la surface de plancher, "
          "et les permis d'aménager et de démolir. L'état (commencé, terminé, annulé) est souvent incomplet.")

    if args.csv:
        champs = ["distance_m", "sur_parcelle", "parcelle_voisine", *next(iter(dossiers.values()))]
        with args.csv.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=champs, delimiter=";")
            w.writeheader()
            for i in sorted(dans_rayon, key=lambda i: dossiers[i]["date_autorisation"], reverse=True):
                w.writerow({"distance_m": round(dans_rayon[i]), "sur_parcelle": int(i in res["sur_parcelle"]),
                            "parcelle_voisine": int(i in res["voisines"]), **dossiers[i]})
        print(f"\n-> {args.csv}")


if __name__ == "__main__":
    main()
