"""
Communes d'un département (code officiel géographique, via geo.api.gouv.fr), gardées en cache dans data/communes-<DEP>.json.

Usage : python3 scripts/communes.py 93 [94 …]   # codes INSEE, un par ligne
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://geo.api.gouv.fr/departements/{dep}/communes?fields=nom,code"

# Communes nouvelles : ancienne commune -> (commune nouvelle, préfixe cadastral de l'ancienne commune).
# SITADEL garde l'ancien code (COMM tiré du numéro de dossier). Le cadastre Etalab a un fichier de l'ancienne commune
# jusqu'à la fusion (parcelles <ancienne>000…), puis ses parcelles passent dans la nouvelle (<nouvelle><préfixe>…).
FUSIONS = {"93059": ("93066", "059")}  # Pierrefitte-sur-Seine dans Saint-Denis au 1er janvier 2025

# Communes où SITADEL a tronqué les numéros de parcelle à 2 chiffres pendant plusieurs années (« K 16 » pour K 163) :
# ces dossiers sont rattachés à une parcelle qui existe, mais à 150-250 m de la bonne. Mesuré par evaluation.py
# (octobre 2026) : moins de 25 % des dossiers retrouvés à leur adresse avant l'année indiquée, le plus souvent plus de
# 80 % ensuite. Le site n'affiche que les autorisations à partir de cette année (choix du 6 octobre 2026 : pas de
# correction, les dossiers anciens intéressent peu un acheteur). À L'Haÿ, 2013-2015 est juste mais masqué aussi.
DEBUT_FIABLE = {"93014": 2017, "93047": 2018, "93050": 2020, "94038": 2021, "94042": 2021}


def anciennes(insee: str) -> dict[str, str]:
    """Anciennes communes fusionnées dans `insee` -> leur préfixe cadastral."""
    return {a: prefixe for a, (n, prefixe) in FUSIONS.items() if n == insee}


def departement(insee: str) -> str:
    return insee[:3] if insee.startswith("97") else insee[:2]


def communes(dep: str) -> dict[str, str]:
    """Code INSEE -> nom, pour toutes les communes du département."""
    cache = ROOT / "data" / f"communes-{dep}.json"
    if not cache.exists():
        with urllib.request.urlopen(API.format(dep=dep), timeout=60) as r:
            liste = json.load(r)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({c["code"]: c["nom"] for c in sorted(liste, key=lambda c: c["code"])},
                                    ensure_ascii=False, indent=0), encoding="utf-8")
    return json.loads(cache.read_text(encoding="utf-8"))


def nom(insee: str) -> str:
    return communes(departement(insee)).get(insee, insee)


def developper(codes: list[str]) -> list[str]:
    """Codes INSEE (5 caractères) et codes département (2 ou 3) -> codes INSEE."""
    return [c for code in codes for c in ([code] if len(code) == 5 else communes(code))]


if __name__ == "__main__":
    print("\n".join(developper(sys.argv[1:])))
