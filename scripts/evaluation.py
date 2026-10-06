"""
Évaluation de la recherche à l'adresse, commune par commune.

Pour chaque dossier rattaché à une parcelle dont l'adresse SITADEL se géocode au numéro, on cherche cette adresse
(recherche.Index) et on regarde si le dossier ressort sur la parcelle au point, sur une parcelle voisine, ou pas du tout.
Même test qu'à Montreuil en octobre 2026 : 79,8 % sur la parcelle, 90,2 % sur la parcelle ou une voisine.

Géocodage par lot (POST https://data.geopf.fr/geocodage/search/csv), réponses gardées dans data/<INSEE>/evaluation.csv
(cache et diagnostic, une ligne par dossier testé : resultat = parcelle, voisine, manque).
Sortie : data/evaluation.csv, une ligne par commune.

Usage : python3 scripts/evaluation.py 93 [94 …]
"""
from __future__ import annotations

import csv
import importlib.util
import io
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from pathlib import Path

from communes import developper, nom
from recherche import ROOT, Index

LOT = "https://data.geopf.fr/geocodage/search/csv"
CHAMPS = ["id", "requete", "label", "type", "score", "lon", "lat", "retenu", "resultat", "listes"]

_spec = importlib.util.spec_from_file_location("dossiers", ROOT / "scripts" / "04_dossiers.py")
d04 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(d04)


def geocoder_lot(requetes: dict[str, str], insee: str) -> dict[str, dict]:
    """id -> réponse du géocodeur, en un seul envoi."""
    tampon = io.StringIO()
    w = csv.writer(tampon, delimiter=";")
    w.writerow(["id", "q", "c"])
    w.writerows([i, q, insee] for i, q in requetes.items())
    limite = uuid.uuid4().hex
    champs = "".join(f'--{limite}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'
                     for k, v in (("columns", "q"), ("indexes", "address"), ("citycode", "c")))
    corps = (champs + f'--{limite}\r\nContent-Disposition: form-data; name="data"; filename="adresses.csv"\r\n'
             f'Content-Type: text/csv\r\n\r\n{tampon.getvalue()}\r\n--{limite}--\r\n').encode("utf-8")
    req = urllib.request.Request(LOT, data=corps, headers={
        "Content-Type": f"multipart/form-data; boundary={limite}", "User-Agent": "Argos (évaluation)"})
    for essai in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                texte = r.read().decode("utf-8")
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if essai == 4 or (isinstance(e, urllib.error.HTTPError) and e.code < 500):
                raise
            time.sleep(2 ** essai * 5)
    return {r["id"]: {"label": r["result_label"], "type": r["result_type"], "score": r["result_score"],
                      "lon": r["longitude"], "lat": r["latitude"]}
            for r in csv.DictReader(io.StringIO(texte), delimiter=";")}


def evaluer(insee: str) -> dict:
    d = ROOT / "data" / insee
    sources = {}  # (type, num) -> {fichier: ligne}, comme dans 04_dossiers.py
    for f, (col_type, col_num, _) in d04.FICHIERS.items():
        with (d / f"{f}.csv").open(encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                type_dau = r[col_type] if col_type else {"amenager": "PA", "demolir": "PD"}[f]
                sources.setdefault((type_dau, r[col_num]), {})[f] = r

    idx = Index(insee)
    requetes, significatifs = {}, {}
    for i, r in idx.dossiers.items():
        if r["localisation"] not in ("parcelle_actuelle", "parcelle_ancienne"):
            continue
        src = sources[(r["type"], r["num"])]
        q, s = d04.requete_adresse({c: d04.valeur(src, c) for c in (
            "ADR_NUM_TER", "ADR_LIBVOIE_TER", "ADR_LIEUDIT_TER", "ADR_CODPOST_TER", "ADR_LOCALITE_TER")})
        if q:
            requetes[i], significatifs[i] = q, s

    cache_f = d / "evaluation.csv"
    cache = {}
    if cache_f.exists():
        with cache_f.open(encoding="utf-8", newline="") as fh:
            cache = {r["id"]: r for r in csv.DictReader(fh, delimiter=";") if r["requete"] == requetes.get(r["id"])}
    manquants = {i: q for i, q in requetes.items() if i not in cache}
    reponses = {i: cache[i] for i in requetes if i in cache} | (geocoder_lot(manquants, insee) if manquants else {})

    lignes = []
    for i, q in requetes.items():
        g = reponses.get(i) or {"label": "", "type": "", "score": "", "lon": "", "lat": ""}
        retenu = (g["type"] == "housenumber" and float(g["score"] or 0) >= d04.SCORE_MIN
                  and bool(significatifs[i] & d04.mots(g["label"])))
        resultat, listes = "", ""
        if retenu:
            res = idx.rechercher(float(g["lon"]), float(g["lat"]), 0)
            resultat = "parcelle" if i in res["sur_parcelle"] else "voisine" if i in res["voisines"] else "manque"
            listes = len(res["sur_parcelle"] | res["voisines"])
        lignes.append({"id": i, "requete": q, **{k: g[k] for k in ("label", "type", "score", "lon", "lat")},
                       "retenu": int(retenu), "resultat": resultat, "listes": listes})
    with cache_f.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CHAMPS, delimiter=";")
        w.writeheader()
        w.writerows(lignes)

    testes = [l for l in lignes if l["retenu"]]
    c = Counter(l["resultat"] for l in testes)
    n = max(len(testes), 1)
    return {"insee": insee, "commune": nom(insee), "rattaches": sum(r["localisation"].startswith("parcelle")
                                                                    for r in idx.dossiers.values()),
            "testes": len(testes), "parcelle_pct": round(100 * c["parcelle"] / n, 1),
            "parcelle_ou_voisine_pct": round(100 * (c["parcelle"] + c["voisine"]) / n, 1),
            "listes_moyenne": round(sum(l["listes"] for l in testes) / n, 1)}


def main():
    lignes = []
    for insee in developper(sys.argv[1:] or ["93048"]):
        lignes.append(evaluer(insee))
        r = lignes[-1]
        print(f"{r['commune'][:28]:28s} {r['testes']:5d} testés sur {r['rattaches']:5d}  "
              f"parcelle {r['parcelle_pct']:5.1f} %  + voisines {r['parcelle_ou_voisine_pct']:5.1f} %  "
              f"({r['listes_moyenne']} dossiers listés)", flush=True)
    if len(lignes) > 1:
        lignes.sort(key=lambda r: r["parcelle_ou_voisine_pct"])
        with (ROOT / "data" / "evaluation.csv").open("w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(lignes[0]), delimiter=";")
            w.writeheader()
            w.writerows(lignes)
        t = sum(r["testes"] for r in lignes)
        p = sum(r["testes"] * r["parcelle_pct"] for r in lignes) / t
        v = sum(r["testes"] * r["parcelle_ou_voisine_pct"] for r in lignes) / t
        print(f"{'Total':28s} {t:5d} testés  parcelle {p:5.1f} %  + voisines {v:5.1f} %\n-> data/evaluation.csv")


if __name__ == "__main__":
    main()
