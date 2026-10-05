"""
Extrait les autorisations d'une commune depuis les 4 fichiers nationaux SITADEL (DiDo).

Les CSV DiDo ont 2 lignes d'en-tête : libellés longs, puis codes de colonnes.
On garde la ligne des codes comme en-tête.

Usage : python3 scripts/01_extract_commune.py [CODE_INSEE]   (défaut : 93048)
"""
from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "doc_source"

FICHIERS = {
    "logements": "Liste-des-autorisations-durbanisme-creant-des-logements",
    "locaux": "Liste-des-autorisations-durbanisme-creant-des-locaux-non-residentiels",
    "amenager": "Liste-des-permis-damenager",
    "demolir": "Liste-des-permis-de-demolir",
}


def extraire(src: Path, dst: Path, insee: str) -> int:
    marqueur = f'"{insee}"'
    n = 0
    with src.open(encoding="utf-8", newline="") as f_in, dst.open("w", encoding="utf-8", newline="") as f_out:
        f_in.readline()  # libellés longs, ignorés
        entete = next(csv.reader([f_in.readline()], delimiter=";"))
        i_comm = entete.index("COMM")
        w = csv.writer(f_out, delimiter=";")
        w.writerow(entete)
        for ligne in f_in:
            if marqueur not in ligne:  # préfiltre rapide
                continue
            row = next(csv.reader(io.StringIO(ligne), delimiter=";"))
            if row[i_comm] == insee:
                w.writerow(row)
                n += 1
    return n


def main():
    insee = sys.argv[1] if len(sys.argv) > 1 else "93048"
    out = ROOT / "data" / insee
    out.mkdir(parents=True, exist_ok=True)
    for cle, prefixe in FICHIERS.items():
        src = sorted(SRC.glob(f"{prefixe}.*.csv"))[-1]  # millésime le plus récent
        n = extraire(src, out / f"{cle}.csv", insee)
        print(f"{cle:10s} {n:6d} lignes  <- {src.name}")


if __name__ == "__main__":
    main()
