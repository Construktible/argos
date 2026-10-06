"""
Télécharge tous les millésimes du cadastre Etalab d'une commune et construit l'index de ses parcelles.

Une parcelle divisée ou fusionnée change d'identifiant : elle disparaît du cadastre courant mais reste
dans les millésimes antérieurs (environ un par trimestre depuis juillet 2017).
Le lien « latest » d'Etalab peut avoir un millésime de retard : on prend le plus récent de la liste.
Commune nouvelle : on y ajoute les millésimes des anciennes communes (communes.FUSIONS), identifiants renommés
comme après la fusion (930590000A0297 -> 930660590A0297), pour suivre la même parcelle de part et d'autre.

Source : https://cadastre.data.gouv.fr/data/etalab-cadastre/<millésime>/geojson/communes/<DEP>/<INSEE>/cadastre-<INSEE>-parcelles.json.gz
Cache  : doc_source/cadastre/<INSEE>/<millésime>.json.gz
Sortie : data/<INSEE>/parcelles.geojson, toutes les parcelles vues au moins une fois, avec leur dernière
         géométrie connue. Propriétés : idu, contenance, premier_millesime, dernier_millesime, actuelle

Usage : python3 scripts/02_cadastre.py [CODE_INSEE]
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from communes import anciennes

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://cadastre.data.gouv.fr/data/etalab-cadastre/"


def lister_millesimes() -> list[str]:
    with urllib.request.urlopen(BASE, timeout=60) as r:
        return sorted(set(re.findall(r"(\d{4}-\d{2}-\d{2})/", r.read().decode())))


def telecharger(millesime: str, insee: str, dst: Path) -> bool:
    if dst.exists():
        return True
    dep = insee[:3] if insee.startswith("97") else insee[:2]
    url = f"{BASE}{millesime}/geojson/communes/{dep}/{insee}/cadastre-{insee}-parcelles.json.gz"
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            contenu = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise
    tmp = dst.with_name(dst.name + ".part")
    tmp.write_bytes(contenu)
    tmp.rename(dst)
    return True


def main():
    insee = sys.argv[1] if len(sys.argv) > 1 else "93048"
    cache = ROOT / "doc_source" / "cadastre" / insee
    cache.mkdir(parents=True, exist_ok=True)

    fusionnees = anciennes(insee)
    for a in fusionnees:
        (ROOT / "doc_source" / "cadastre" / a).mkdir(parents=True, exist_ok=True)

    index, vus, precedents = {}, [], set()
    print(f"{'millésime':10s} {'parcelles':>9s} {'apparues':>9s} {'disparues':>9s}")
    for m in lister_millesimes():
        f = cache / f"{m}.json.gz"
        if not telecharger(m, insee, f):
            print(f"{m:10s} absent")
            continue
        vus.append(m)
        sources = [(f, None)] + [(ROOT / "doc_source" / "cadastre" / a / f"{m}.json.gz", prefixe)
                                 for a, prefixe in fusionnees.items()]
        features = []
        for src, prefixe in sources:
            if prefixe and not telecharger(m, src.parent.name, src):
                continue  # après la fusion, l'ancienne commune n'a plus de fichier
            with gzip.open(src, "rt", encoding="utf-8") as fh:
                features += [(feat, prefixe) for feat in json.load(fh)["features"]]
        ids = set()
        for feat, prefixe in features:
            idu = feat.get("id") or feat["properties"]["id"]  # id au niveau feature absent en 2017-10
            if prefixe:
                idu = insee + prefixe + idu[8:]
            if idu in ids:
                continue
            ids.add(idu)
            p = index.setdefault(idu, {"premier_millesime": m, "n": 0})
            p.update(dernier_millesime=m, n=p["n"] + 1,
                     contenance=feat["properties"].get("contenance"), geometry=feat["geometry"])
        if precedents:
            print(f"{m:10s} {len(ids):9d} {len(ids - precedents):9d} {len(precedents - ids):9d}")
        else:
            print(f"{m:10s} {len(ids):9d}")
        precedents = ids

    dernier = vus[-1]
    features = [
        {"type": "Feature", "id": idu, "geometry": p["geometry"], "properties": {
            "idu": idu, "contenance": p["contenance"],
            "premier_millesime": p["premier_millesime"], "dernier_millesime": p["dernier_millesime"],
            "actuelle": p["dernier_millesime"] == dernier,
        }}
        for idu, p in sorted(index.items())
    ]
    out = ROOT / "data" / insee / "parcelles.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"))

    rang = {m: i for i, m in enumerate(vus)}
    actuelles = sum(f["properties"]["actuelle"] for f in features)
    discontinues = sum(rang[p["dernier_millesime"]] - rang[p["premier_millesime"]] + 1 != p["n"] for p in index.values())
    print(f"\n{len(vus)} millésimes, {len(index)} parcelles vues : {actuelles} actuelles ({dernier}), "
          f"{len(index) - actuelles} disparues, {discontinues} à présence discontinue")
    print(f"-> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
