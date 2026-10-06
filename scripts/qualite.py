"""
Tableau de qualité du rattachement, une ligne par commune : dossiers placés sur la carte et références cadastrales.

  précis     dossier rattaché à une parcelle (actuelle ou ancienne) ou géocodé au numéro
  carte      précis + géocodé à la rue seulement (imprécis)
  perdus     ni parcelle, ni adresse exploitable : absents de la carte et des rapports

Entrées : data/<INSEE>/dossiers.csv, autorisations_parcelles.csv (sorties de 03 et 04)
Sortie  : data/qualite.csv

Usage : python3 scripts/qualite.py 93 [94 …]
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

from communes import developper, nom

ROOT = Path(__file__).resolve().parent.parent


def main():
    lignes = []
    for insee in developper(sys.argv[1:] or ["93048"]):
        d = ROOT / "data" / insee
        with (d / "dossiers.csv").open(encoding="utf-8", newline="") as f:
            loc = Counter(r["localisation"] for r in csv.DictReader(f, delimiter=";"))
        with (d / "autorisations_parcelles.csv").open(encoding="utf-8", newline="") as f:
            refs = Counter(r["statut"] for r in csv.DictReader(f, delimiter=";"))
        n = sum(loc.values())
        precis = loc["parcelle_actuelle"] + loc["parcelle_ancienne"] + loc["adresse"]
        lignes.append({
            "insee": insee, "commune": nom(insee), "dossiers": n,
            "parcelle_actuelle": loc["parcelle_actuelle"], "parcelle_ancienne": loc["parcelle_ancienne"],
            "adresse": loc["adresse"], "voie": loc["voie"], "perdus": loc["aucune"],
            "precis_pct": round(100 * precis / n, 1), "carte_pct": round(100 * (precis + loc["voie"]) / n, 1),
            "refs": sum(refs.values()), "refs_introuvables_pct": round(100 * refs["introuvable"] / max(sum(refs.values()), 1), 1),
        })
    lignes.sort(key=lambda r: r["carte_pct"])

    with (ROOT / "data" / "qualite.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(lignes[0]), delimiter=";")
        w.writeheader()
        w.writerows(lignes)

    print(f"{'commune':28s} {'dossiers':>8s} {'précis':>7s} {'carte':>6s} {'perdus':>6s} {'réf. introuv.':>13s}")
    for r in lignes:
        print(f"{r['commune'][:28]:28s} {r['dossiers']:8d} {r['precis_pct']:6.1f}% {r['carte_pct']:5.1f}% "
              f"{r['perdus']:6d} {r['refs_introuvables_pct']:12.1f}%")
    total = sum(r["dossiers"] for r in lignes)
    perdus = sum(r["perdus"] for r in lignes)
    print(f"{'Total':28s} {total:8d} {'':7s} {100 * (total - perdus) / total:5.1f}% {perdus:6d}")
    print("-> data/qualite.csv")


if __name__ == "__main__":
    main()
