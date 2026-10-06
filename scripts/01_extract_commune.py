"""
Extrait les autorisations de communes depuis les 4 fichiers nationaux SITADEL (DiDo), en un passage par fichier.

Les CSV DiDo ont 2 lignes d'en-tête : libellés longs, puis codes de colonnes.
On garde la ligne des codes comme en-tête.

COMM est tiré du numéro de dossier, pas recodifié selon le COG : les lignes d'une ancienne commune fusionnée
(communes.FUSIONS) vont dans la commune nouvelle, COMM inchangé. Pour un département demandé en entier, on signale
les autres COMM du département absents de la liste officielle des communes (lignes non extraites).

Usage : python3 scripts/01_extract_commune.py [CODE ...]   (codes INSEE ou départements, défaut : 93048)
        python3 scripts/01_extract_commune.py 93 94
"""
from __future__ import annotations

import csv
import io
import sys
from collections import Counter
from pathlib import Path

from communes import FUSIONS, departement, developper

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "doc_source"

FICHIERS = {
    "logements": "Liste-des-autorisations-durbanisme-creant-des-logements",
    "locaux": "Liste-des-autorisations-durbanisme-creant-des-locaux-non-residentiels",
    "amenager": "Liste-des-permis-damenager",
    "demolir": "Liste-des-permis-de-demolir",
}


def extraire(src: Path, cle: str, insees: list[str], deps_entiers: set[str]) -> tuple[Counter, Counter]:
    marqueurs = tuple({f'"{departement(i)}' for i in insees})  # préfiltre rapide, confirmé sur COMM
    cible = {i: i for i in insees} | {a: n for a, (n, _) in FUSIONS.items() if n in insees}
    n, hors_cog = Counter(), Counter()
    sorties, writers = {}, {}
    with src.open(encoding="utf-8", newline="") as f_in:
        f_in.readline()  # libellés longs, ignorés
        entete = next(csv.reader([f_in.readline()], delimiter=";"))
        i_comm, i_dep = entete.index("COMM"), entete.index("DEP_CODE")
        for insee in insees:
            dst = ROOT / "data" / insee / f"{cle}.csv"
            dst.parent.mkdir(parents=True, exist_ok=True)
            sorties[insee] = dst.open("w", encoding="utf-8", newline="")
            writers[insee] = csv.writer(sorties[insee], delimiter=";")
            writers[insee].writerow(entete)
        for ligne in f_in:
            if not any(m in ligne for m in marqueurs):
                continue
            row = next(csv.reader(io.StringIO(ligne), delimiter=";"))
            while len(row) < len(entete):  # retour à la ligne dans un champ entre guillemets (22 cas en France)
                ligne += next(f_in)
                row = next(csv.reader(io.StringIO(ligne), delimiter=";"))
            if row[i_comm] in cible:
                writers[cible[row[i_comm]]].writerow(row)
                n[cible[row[i_comm]]] += 1
            elif row[i_dep] in deps_entiers:
                hors_cog[row[i_comm]] += 1
    for f in sorties.values():
        f.close()
    return n, hors_cog


def main():
    codes = sys.argv[1:] or ["93048"]
    insees = developper(codes)
    deps_entiers = {c for c in codes if len(c) < 5}
    total, hors_cog = Counter(), Counter()
    for cle, prefixe in FICHIERS.items():
        src = sorted(SRC.glob(f"{prefixe}.*.csv"))[-1]  # millésime le plus récent
        n, h = extraire(src, cle, insees, deps_entiers)
        total += n
        hors_cog += h
        if len(insees) == 1:
            print(f"{cle:10s} {n[insees[0]]:6d} lignes  <- {src.name}")
        else:
            print(f"{cle:10s} {sum(n.values()):6d} lignes, {len(n)} communes sur {len(insees)}  <- {src.name}")
    if len(insees) > 1:
        print(f"-> data/<INSEE>/{{{','.join(FICHIERS)}}}.csv ; sans aucune ligne : {sorted(set(insees) - set(total)) or 'aucune'}")
    if hors_cog:
        print(f"COMM absents du COG (non extraits) : {dict(sorted(hors_cog.items()))}")


if __name__ == "__main__":
    main()
