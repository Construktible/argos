"""
Rattache chaque autorisation SITADEL d'une commune aux parcelles du cadastre Etalab, actuelles ou anciennes.

Identifiant parcelle (14 car.) = INSEE (5) + préfixe "000" (3) + section (2, complétée par 0) + numéro (4, complété par 0)
ex. section X, numéro 299 à Montreuil -> 930480000X0299
Commune nouvelle (communes.FUSIONS) : préfixe de l'ancienne commune si COMM est l'ancienne commune
(Pierrefitte : 930660590A0297) ; sinon "000", et à défaut le préfixe d'une ancienne commune où la parcelle existe.
Section absente du cadastre de la commune : on essaie les erreurs de saisie vues dans le 93, « D0 » pour « 0D »
et la lettre O pour le zéro (« OB » pour « 0B »).

Statut d'une référence :
  actuelle     parcelle présente dans le dernier millésime du cadastre
  ancienne     parcelle disparue depuis (division, fusion...), présente dans un millésime antérieur
  introuvable  absente de tous les millésimes (depuis juillet 2017), ou référence mal formée

Entrées : data/<INSEE>/*.csv (sortie de 01), data/<INSEE>/parcelles.geojson (sortie de 02)
Sortie  : data/<INSEE>/autorisations_parcelles.csv (une ligne par autorisation x référence cadastrale)

Usage : python3 scripts/03_jointure_cadastre.py [CODE_INSEE]
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

from communes import anciennes

ROOT = Path(__file__).resolve().parent.parent

FICHIERS = {  # fichier -> colonnes (type, numéro)
    "logements": ("TYPE_DAU", "NUM_DAU"),
    "locaux": ("TYPE_DAU", "NUM_DAU"),
    "amenager": (None, "NUM_PA"),
    "demolir": (None, "NUM_PD"),
}
STATUTS = ("actuelle", "ancienne", "introuvable")


def idu(insee: str, section: str, numero: str, prefixe: str = "000") -> str | None:
    s, n = section.strip().upper(), numero.strip()
    if not s or not n or not n.isdigit() or len(s) > 2 or len(n) > 4:
        return None
    return f"{insee}{prefixe}{s.rjust(2, '0')}{n.rjust(4, '0')}"


def sections_essayees(section: str, connues: set[str]) -> list[str]:
    s = section.strip().upper()
    if len(s) != 2 or s in connues:
        return [s]
    variantes = ["0" + s[0]] if s[1] == "0" and s[0].isalpha() else []
    variantes += ["0" + s[1]] if s[0] == "O" and s[1].isalpha() else []
    return [s, *variantes]


def main():
    insee = sys.argv[1] if len(sys.argv) > 1 else "93048"
    d = ROOT / "data" / insee
    with (d / "parcelles.geojson").open(encoding="utf-8") as f:
        parcelles = {feat["id"]: feat["properties"] for feat in json.load(f)["features"]}
    fusionnees = anciennes(insee)
    connues = {p[8:10] for p in parcelles}

    lignes, stats = [], {}
    for cle, (col_type, col_num) in FICHIERS.items():
        with (d / f"{cle}.csv").open(encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f, delimiter=";"))
        st = stats[cle] = {"autorisations": len(rows), "avec_ref": 0, "actuelle": 0, "rattachee": 0,
                           "refs": dict.fromkeys(STATUTS, 0)}
        for r in rows:
            type_dau = r[col_type] if col_type else {"NUM_PA": "PA", "NUM_PD": "PD"}[col_num]
            statuts = set()
            for i in (1, 2, 3):
                sec, num = r[f"SEC_CADASTRE{i}"], r[f"NUM_CADASTRE{i}"]
                if not sec.strip() and not num.strip():
                    continue
                prefixes = [fusionnees[r["COMM"]]] if r["COMM"] in fusionnees else ["000", *fusionnees.values()]
                candidats = [idu(insee, s, num, x) for s in sections_essayees(sec, connues) for x in prefixes]
                p = next((q for q in candidats if q in parcelles), candidats[0])
                prop = parcelles.get(p)
                statut = "introuvable" if prop is None else "actuelle" if prop["actuelle"] else "ancienne"
                statuts.add(statut)
                st["refs"][statut] += 1
                lignes.append({
                    "fichier": cle, "type_dau": type_dau, "num_dau": r[col_num],
                    "rang": i, "section": sec.strip(), "numero": num.strip(),
                    "idu": p or "", "statut": statut,
                    "dernier_millesime": prop["dernier_millesime"] if prop else "",
                    "date_autorisation": r["DATE_REELLE_AUTORISATION"],
                })
            st["avec_ref"] += bool(statuts)
            st["actuelle"] += "actuelle" in statuts
            st["rattachee"] += bool(statuts - {"introuvable"})

    with (d / "autorisations_parcelles.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(lignes[0]), delimiter=";")
        w.writeheader()
        w.writerows(lignes)

    print(f"{len(parcelles)} parcelles, tous millésimes confondus\n")
    print(f"{'':10s} {'':>8s} {'':>9s} {'rattachées au cadastre':^33s}   {'références':^30s}")
    print(f"{'fichier':10s} {'autoris.':>8s} {'avec réf.':>9s} {'actuel':>16s} {'+ anciens':>16s}   {'actuelle':>8s} {'ancienne':>9s} {'introuv.':>9s}")
    for cle, st in stats.items():
        a, refs = st["autorisations"], st["refs"]
        n = max(a, 1)  # commune sans aucun PA
        print(f"{cle:10s} {a:8d} {st['avec_ref']:9d} {st['actuelle']:8d} ({st['actuelle']/n:5.1%}) "
              f"{st['rattachee']:8d} ({st['rattachee']/n:5.1%})   "
              f"{refs['actuelle']:8d} {refs['ancienne']:9d} {refs['introuvable']:9d}")


if __name__ == "__main__":
    main()
