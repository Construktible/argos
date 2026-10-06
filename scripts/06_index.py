"""
Index des communes couvertes par le site, lu au démarrage : le site ne charge ensuite que les communes touchées
par une recherche (adresse, parcelle, commune explorée) et signale un rayon qui sort de la zone couverte.

  communes.json  millésimes, départements, emprise de la zone, et par commune : nom, emprise, effectifs (dossiers,
                 logements et surface créés hors annulés), année de départ (communes.DEBUT_FIABLE)
  contours.json  contour de chaque commune (GeoJSON, geo.api.gouv.fr, contours simplifiés), arrondi au mètre

Entrées : site/data/<INSEE>/meta.json et dossiers.json (sorties de 05_site.py)
Sortie  : site/data/communes.json, site/data/contours.json

Usage : python3 scripts/06_index.py 93 94
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

from communes import developper

ROOT = Path(__file__).resolve().parent.parent
GEO = "https://geo.api.gouv.fr/departements/{dep}"


def lire_api(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def arrondir(coords):
    return [arrondir(c) for c in coords] if isinstance(coords[0], list) else [round(c, 5) for c in coords]


def main():
    deps = sys.argv[1:] or ["93", "94"]
    out = ROOT / "site" / "data"
    communes, contours = [], []
    for dep in deps:
        geo = lire_api(GEO.format(dep=dep) + "/communes?format=geojson&geometry=contour&fields=code,nom")
        formes = {f["properties"]["code"]: f["geometry"] for f in geo["features"]}
        for insee in developper([dep]):
            meta = json.loads((out / insee / "meta.json").read_text(encoding="utf-8"))
            dossiers = json.loads((out / insee / "dossiers.json").read_text(encoding="utf-8"))
            valides = [d for d in dossiers if d["etat"] != "annulé"]
            nombre = lambda d, *cols: sum(float(d[c] or 0) for c in cols)
            communes.append({
                "insee": insee, "commune": meta["commune"], "departement": dep, "emprise": meta["emprise"],
                "dossiers": meta["dossiers"], "non_localises": meta["non_localises"], "ecartes": meta.get("ecartes", 0),
                "logements": round(sum(nombre(d, "nb_logements_crees") for d in valides)),
                "surface": round(sum(nombre(d, "surf_habitation_creee", "surf_non_residentielle_creee") for d in valides)),
                "debut_fiable": meta.get("debut_fiable"), "premiere_annee": meta["premiere_annee"],
                "derniere_annee": max(d["date_autorisation"][:4] for d in dossiers if d["date_autorisation"]),
                "sitadel": meta["sitadel"], "cadastre": meta["cadastre"],
            })
            g = formes[insee]
            contours.append({"type": "Feature", "properties": {"insee": insee, "commune": meta["commune"]},
                             "geometry": {"type": g["type"], "coordinates": arrondir(g["coordinates"])}})

    emprises = [c["emprise"] for c in communes]
    index = {
        "departements": {dep: lire_api(GEO.format(dep=dep))["nom"] for dep in deps},
        "sitadel": max(c["sitadel"] for c in communes), "cadastre": max(c["cadastre"] for c in communes),
        "genere": date.today().isoformat(),
        "premiere_annee": min(c["premiere_annee"] for c in communes),
        "derniere_annee": max(c["derniere_annee"] for c in communes),
        "emprise": [min(e[0] for e in emprises), min(e[1] for e in emprises), max(e[2] for e in emprises), max(e[3] for e in emprises)],
        **{k: sum(c[k] for c in communes) for k in ("dossiers", "non_localises", "ecartes", "logements", "surface")},
        "communes": sorted(communes, key=lambda c: c["commune"]),
    }
    heterogenes = {c["insee"] for c in communes if (c["sitadel"], c["cadastre"]) != (index["sitadel"], index["cadastre"])}
    if heterogenes:
        print(f"Attention : millésimes différents pour {sorted(heterogenes)}")
    for nom, contenu in (("communes.json", index), ("contours.json", {"type": "FeatureCollection", "features": contours})):
        with (out / nom).open("w", encoding="utf-8") as f:
            json.dump(contenu, f, ensure_ascii=False, separators=(",", ":"))
        print(f"-> site/data/{nom} ({(out / nom).stat().st_size / 1e3:.0f} ko)")
    print(f"{len(communes)} communes, {index['dossiers']} dossiers, {index['premiere_annee']}-{index['derniere_annee']}")


if __name__ == "__main__":
    main()
