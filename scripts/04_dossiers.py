"""
Construit le jeu de données consolidé : une ligne par dossier, localisée.

Un dossier (TYPE_DAU + NUM_DAU ; PA / PD pour les fichiers aménager / démolir) peut figurer dans plusieurs fichiers
SITADEL : logements et locaux pour un projet mixte, et aussi aménager pour un PA. Fusion champ par champ : première
valeur non vide dans l'ordre logements, locaux, aménager, démolir. Locaux passe en premier pour la destination et les
surfaces non résidentielles (nomenclature plus détaillée, surfaces plus complètes).
Les champs que le SDES juge insuffisamment renseignés sont écartés (logements sociaux, logements démolis, architecte...).
DR_DEPOT aussi : à Montreuil, 85 % des dates tombent un 1er janvier et 216 sont postérieures à l'autorisation. On garde
l'année de dépôt, tirée du numéro de dossier. SUPERFICIE_TERRAIN = 0 signifie « non renseignée » : vidée.
Accents corrompus dans la source (~2 % des lignes nationales) : « RUE MOLIAÃ\\x82Â\\x88RE » pour RUE MOLIÈRE. L'accent est
devenu « A » et l'octet suivant a été doublement mal décodé ; réparé ici (motif dominant, ~97 % des cas).

Localisation (colonne `localisation`, point lon/lat) :
  parcelle_actuelle   barycentre des parcelles rattachées, dont au moins une au cadastre actuel
  parcelle_ancienne   barycentre des parcelles rattachées, toutes disparues depuis
  adresse             dossier sans parcelle, adresse géocodée au numéro
  voie                dossier sans parcelle, adresse géocodée à la voie seulement : imprécis sur une longue rue
  aucune
Un résultat de géocodage n'est retenu que si un mot significatif de la voie interrogée figure dans la réponse
(ex. « 278 BD DE », libellé tronqué, renvoyait « 278 Rue de Rosny »).

Entrées : data/<INSEE>/{logements,locaux,amenager,demolir}.csv, autorisations_parcelles.csv (03), parcelles.geojson (02)
Géocodage : Géoplateforme (https://data.geopf.fr/geocodage/search), réponses gardées dans data/<INSEE>/geocodage.csv
Sorties : data/<INSEE>/dossiers.csv, data/<INSEE>/dossiers_parcelles.csv (id, idu, statut)

Usage : python3 scripts/04_dossiers.py [CODE_INSEE]
"""
from __future__ import annotations

import csv
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEOCODEUR = "https://data.geopf.fr/geocodage/search"
SCORE_MIN = 0.5

FICHIERS = {  # fichier -> colonnes (type, numéro, état)
    "logements": ("TYPE_DAU", "NUM_DAU", "ETAT_DAU"),
    "locaux": ("TYPE_DAU", "NUM_DAU", "ETAT_DAU"),
    "amenager": (None, "NUM_PA", "ETAT_PA"),
    "demolir": (None, "NUM_PD", "ETAT_PD"),
}
LOCAUX_D_ABORD = {"SURF_LOC_CREEE", "SURF_LOC_DEMOLIE", "TYPE_PRINCIP_LOCAUX_TRANSFORMES"}

# Libellés des dictionnaires de variables SDES (juin 2026)
ETATS = {"2": "autorisé", "4": "annulé", "5": "commencé", "6": "terminé"}
NATURES = {
    "1": "nouvelle construction",
    "2": "transformation sans extension ni diminution de surface",
    "3": "transformation avec extension de surface",
    "4": "transformation avec diminution de surface",
    "5": "extension de surface sans transformation",
    "6": "diminution de surface sans transformation",
}
DESTINATIONS_LOCAUX = {"1": "habitation", "2": "hôtels", "3": "bureaux", "4": "commerce", "6": "industrie",
                       "7": "agriculture", "8": "entrepôt", "9": "service public ou d'intérêt collectif"}
DESTINATIONS_LOGEMENTS = {"1": "habitation", "2": "non résidentiel"}
TYPES_LOGEMENTS = {"1": "un logement individuel", "2": "plusieurs logements individuels",
                   "3": "collectif hors résidence", "4": "résidence"}
RESIDENCES = {"1": "personnes âgées", "2": "étudiants", "3": "tourisme", "4": "hôtelière à vocation sociale",
              "5": "sociale", "6": "personnes handicapées", "7": "autre", "8": "projet mixte"}  # 9 = non rempli
# Pour l'objet en clair. Le code 5, absent du dictionnaire 2026 mais fréquent dans les dossiers anciens, est lu comme
# l'ancienne destination « artisanat » (nomenclature d'avant 2016, dont les autres codes coïncident) : interprétation.
DESTINATIONS_OBJET = {"1": "logement", "2": "hôtel", "3": "bureaux", "4": "commerce", "5": "atelier d'artisanat",
                      "6": "local industriel", "7": "bâtiment agricole", "8": "entrepôt", "9": "équipement d'intérêt collectif"}
SUFFIXES = {"B": "bis", "BI": "bis", "BIS": "bis", "T": "ter", "TER": "ter"}
MOTS_VIDES = {"RUE", "BD", "BOULEVARD", "AV", "AVENUE", "ALL", "ALLEE", "PL", "PLACE", "IMP", "IMPASSE", "CH",
              "CHEMIN", "SENTE", "SENTIER", "VILLA", "PASSAGE", "QUAI", "ROUTE", "SQUARE", "CITE", "COURS",
              "DE", "DU", "DES", "LA", "LE", "LES", "ET", "SAINT", "ST", "BIS", "TER"}

CHAMPS = ["id", "type", "num", "fichiers", "etat", "annee_depot", "date_autorisation", "date_ouverture_chantier",
          "date_achevement", "adresse", "code_postal", "references_cadastrales", "superficie_terrain",
          "demandeur", "siren", "objet", "nature_projet", "destination_principale", "type_logements", "residence",
          "nb_logements_crees", "surf_habitation_creee", "surf_habitation_demolie",
          "surf_non_residentielle_creee", "surf_non_residentielle_demolie", "localisation", "lon", "lat"]


MOJIBAKE = re.compile("AÃ\u0082Â([\u0080-¿])")  # « A » + « Ã\x82Â » + 2e octet du caractère accentué
MOJIBAKE_SIMPLE = re.compile("[ÂÃ][\u0080-¿]")  # caractère UTF-8 de 2 octets lu en latin-1


def reparer(s: str) -> str:
    def simple(m):
        try:
            return m.group(0).encode("latin-1").decode("utf-8")
        except UnicodeDecodeError:
            return m.group(0)

    for _ in range(3):
        if "Â" not in s and "Ã" not in s:
            break
        s = MOJIBAKE_SIMPLE.sub(simple, MOJIBAKE.sub(lambda m: bytes([0xC3, ord(m.group(1))]).decode("utf-8"), s))
    return s


def valeur(sources: dict, col: str) -> str:
    ordre = ["locaux", *FICHIERS] if col in LOCAUX_D_ABORD else FICHIERS
    for f in ordre:
        v = sources.get(f, {}).get(col, "").strip()
        if v:
            return reparer(v)
    return ""


def entier(s: str) -> int:
    """Nombre SITADEL, parfois décimal hors de Montreuil (« 63.97 » m²), arrondi à l'unité."""
    return round(float(s)) if s else 0


def objet(type_dau: str, v, destination: str) -> str:
    """Objet du dossier en clair (la nature du projet SDES, « transformation sans extension ni diminution de surface »,
    ne dit pas ce qui change) : type de transformation, destinations avant et après, logements et surfaces."""
    if type_dau == "PD":
        return "Démolition"
    if type_dau == "PA":
        return "Aménagement d'un terrain"
    nature, transfo = v("NATURE_PROJET_COMPLETEE"), v("TYPE_TRANSFO_PRINCIPAL")
    avant = DESTINATIONS_OBJET.get(v("TYPE_PRINCIP_LOCAUX_TRANSFORMES"), "local")
    apres = DESTINATIONS_OBJET.get(destination, "local")
    logements = entier(v("NB_LGT_TOT_CREES"))
    surface = entier(v("SURF_HAB_CREEE")) + entier(v("SURF_LOC_CREEE"))
    non_residentiel = destination not in ("", "1")
    if nature == "1":
        texte = "Construction neuve"
    elif nature == "5":
        texte = "Agrandissement" + (f" de {surface} m²" if surface else "") + (f" ({apres})" if non_residentiel else "")
    elif nature == "6":
        texte = "Réduction de surface (démolition partielle)"
    elif transfo == "1":
        texte = f"Changement de destination : {avant} → logement"
    elif transfo == "2":
        texte = "Réaménagement de logements (division, réunion ou rénovation)"
    elif transfo == "3":  # destination d'arrivée parfois absente (dossier du seul fichier logements)
        texte = f"Changement de destination : logement → {apres if non_residentiel else 'local non résidentiel'}"
    elif transfo == "4":
        texte = (f"Changement de destination : {avant} → {apres}" if non_residentiel and avant != apres
                 else f"Réaménagement de locaux ({avant})")
    else:
        texte = "Travaux sur un bâtiment existant"
    texte += {"3": ", avec agrandissement", "4": ", avec réduction de surface"}.get(nature, "")
    details = []
    if logements:
        pluriel = "s" if logements > 1 else ""
        details.append(f"{logements} logement{pluriel} " + ("après travaux" if transfo == "2" else f"créé{pluriel}"))
    if nature == "1" and non_residentiel and entier(v("SURF_LOC_CREEE")):
        details.append(f"{entier(v('SURF_LOC_CREEE')):,} m² ({apres})".replace(",", " "))
    return " · ".join([texte, *details])


def centroide(geometries: list) -> tuple[float, float]:
    """Barycentre des surfaces, calculé en lon/lat (approximation plane, exacte à une affinité près)."""
    sx = sy = sa = 0.0
    for g in geometries:
        for poly in [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]:
            for k, anneau in enumerate(poly):
                a = cx = cy = 0.0
                for (x0, y0), (x1, y1) in zip(anneau, anneau[1:]):
                    c = x0 * y1 - x1 * y0
                    a, cx, cy = a + c, cx + (x0 + x1) * c, cy + (y0 + y1) * c
                if a:
                    poids = abs(a) * (1 if k == 0 else -1)  # trous soustraits
                    sx, sy, sa = sx + cx / (3 * a) * poids, sy + cy / (3 * a) * poids, sa + poids
    return sx / sa, sy / sa


def mots(texte: str) -> set[str]:
    sans_accents = "".join(c for c in unicodedata.normalize("NFKD", texte.upper()) if not unicodedata.combining(c))
    return set(re.findall(r"[A-Z]{2,}", sans_accents))


def requete_adresse(s: dict) -> tuple[str, set[str]]:
    """Adresse SITADEL nettoyée pour le géocodeur (libellé tronqué à 26 car., numéros multiples...),
    et les mots significatifs de la voie, à retrouver dans la réponse."""
    num, voie = s["ADR_NUM_TER"].upper(), s["ADR_LIBVOIE_TER"].upper()
    voie = re.split(r"\(|-{2,}", voie)[0]  # « RUE KLEBER (48/50 RUE DE V », « BOULEVARD CHANZY--- RUE DE »
    m = re.match(r"\s*(\d+)[\d\s]*\s(\D.*)", voie)  # numéros dans le libellé : « 278 280 292 294 300 BD DE »
    if m and not num.strip():
        num, voie = m.groups()
    m = re.match(r"\s*(BIS|TER)\s+(.*)", voie)  # « BIS RUE DE PARIS »
    if m:
        num, voie = f"{num} {m.group(1)}", m.group(2)
    m = re.match(r"\s*(\d+)\s*(BIS|BI|B|TER|T)?\b", num)
    numero = f"{m.group(1)} {SUFFIXES.get(m.group(2), '')}" if m else ""
    significatifs = mots(f"{voie} {s['ADR_LIEUDIT_TER']}") - MOTS_VIDES
    if not significatifs:
        return "", set()
    requete = " ".join([numero, voie, s["ADR_LIEUDIT_TER"], s["ADR_CODPOST_TER"], s["ADR_LOCALITE_TER"]])
    return " ".join(requete.split()), significatifs


def geocoder(requete: str, insee: str) -> dict:
    url = GEOCODEUR + "?" + urllib.parse.urlencode({"q": requete, "index": "address", "citycode": insee, "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": "Argos (pipeline SITADEL)"})
    for essai in range(5):  # le géocodeur répond parfois 504 (constaté sur le 94)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                features = json.load(r)["features"]
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if essai == 4 or (isinstance(e, urllib.error.HTTPError) and e.code < 500):
                raise
            time.sleep(2 ** essai * 5)
    time.sleep(0.1)
    if not features:
        return {"label": "", "type": "", "score": "", "lon": "", "lat": ""}
    p, (x, y) = features[0]["properties"], features[0]["geometry"]["coordinates"]
    return {"label": p["label"], "type": p["type"], "score": f"{p['score']:.2f}", "lon": f"{x:.6f}", "lat": f"{y:.6f}"}


def main():
    insee = sys.argv[1] if len(sys.argv) > 1 else "93048"
    d = ROOT / "data" / insee

    dossiers = {}  # (type, num) -> {fichier: ligne}
    for f, (col_type, col_num, col_etat) in FICHIERS.items():
        with (d / f"{f}.csv").open(encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                r["ETAT"] = r[col_etat]
                type_dau = r[col_type] if col_type else {"amenager": "PA", "demolir": "PD"}[f]
                dossiers.setdefault((type_dau, r[col_num]), {})[f] = r

    refs = {}  # (type, num) -> {(section, numero): (idu, statut)}
    with (d / "autorisations_parcelles.csv").open(encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            refs.setdefault((r["type_dau"], r["num_dau"]), {}).setdefault((r["section"], r["numero"]), (r["idu"], r["statut"]))
    with (d / "parcelles.geojson").open(encoding="utf-8") as fh:
        geometries = {feat["id"]: feat["geometry"] for feat in json.load(fh)["features"]}

    cache_geo = d / "geocodage.csv"
    cache = {}
    if cache_geo.exists():
        with cache_geo.open(encoding="utf-8", newline="") as fh:
            cache = {r["requete"]: r for r in csv.DictReader(fh, delimiter=";")}
    geocodes = []

    sorties, liens = [], []
    for (type_dau, num), src in dossiers.items():
        v = lambda col: valeur(src, col)
        dossier_id = f"{type_dau}{num}"
        rattachees = {}
        for (sec, numero), (idu, statut) in refs.get((type_dau, num), {}).items():
            if idu:
                liens.append({"id": dossier_id, "idu": idu, "statut": statut})
                if statut != "introuvable":
                    rattachees[idu] = statut

        lon = lat = ""
        if rattachees:
            localisation = "parcelle_actuelle" if "actuelle" in rattachees.values() else "parcelle_ancienne"
            x, y = centroide([geometries[i] for i in rattachees])
            lon, lat = f"{x:.6f}", f"{y:.6f}"
        else:
            localisation = "aucune"
            requete, significatifs = requete_adresse({c: v(c) for c in ("ADR_NUM_TER", "ADR_LIBVOIE_TER", "ADR_LIEUDIT_TER",
                                                                        "ADR_CODPOST_TER", "ADR_LOCALITE_TER")})
            if requete:
                g = cache.get(requete) or geocoder(requete, insee)
                retenu = (g["type"] in ("housenumber", "street") and float(g["score"]) >= SCORE_MIN
                          and bool(significatifs & mots(g["label"])))
                geocodes.append({"id": dossier_id, "requete": requete, "retenu": int(retenu),
                                 **{k: g[k] for k in ("label", "type", "score", "lon", "lat")}})
                if retenu:
                    localisation = "adresse" if g["type"] == "housenumber" else "voie"
                    lon, lat = g["lon"], g["lat"]

        if "locaux" in src:
            code_destination = src["locaux"]["DESTINATION_PRINCIPALE"]
            destination = DESTINATIONS_LOCAUX.get(code_destination, "")
        elif "logements" in src:
            code_destination = "1" if src["logements"]["DESTINATION_PRINCIPALE"] == "1" else ""
            destination = DESTINATIONS_LOGEMENTS.get(src["logements"]["DESTINATION_PRINCIPALE"], "")
        else:
            code_destination = destination = ""
        sorties.append({
            "id": dossier_id, "type": type_dau, "num": num, "fichiers": "+".join(f for f in FICHIERS if f in src),
            "etat": ETATS.get(v("ETAT"), v("ETAT")), "annee_depot": v("AN_DEPOT"),
            "date_autorisation": v("DATE_REELLE_AUTORISATION"), "date_ouverture_chantier": v("DATE_REELLE_DOC"),
            "date_achevement": v("DATE_REELLE_DAACT"),
            "adresse": " ".join(" ".join([v("ADR_NUM_TER"), v("ADR_LIBVOIE_TER"), v("ADR_LIEUDIT_TER")]).split()),
            "code_postal": v("ADR_CODPOST_TER"),
            "references_cadastrales": ", ".join(f"{s} {n}" for s, n in refs.get((type_dau, num), {})),
            "superficie_terrain": "" if v("SUPERFICIE_TERRAIN") == "0" else v("SUPERFICIE_TERRAIN"),
            "demandeur": v("DENOM_DEM"), "siren": v("SIREN_DEM"), "objet": objet(type_dau, v, code_destination),
            "nature_projet": NATURES.get(v("NATURE_PROJET_COMPLETEE"), ""), "destination_principale": destination,
            "type_logements": TYPES_LOGEMENTS.get(v("TYPE_PRINCIP_LOGTS_CREES"), ""),
            "residence": RESIDENCES.get(v("RESIDENCE"), ""), "nb_logements_crees": v("NB_LGT_TOT_CREES"),
            "surf_habitation_creee": v("SURF_HAB_CREEE"), "surf_habitation_demolie": v("SURF_HAB_DEMOLIE"),
            "surf_non_residentielle_creee": v("SURF_LOC_CREEE"), "surf_non_residentielle_demolie": v("SURF_LOC_DEMOLIE"),
            "localisation": localisation, "lon": lon, "lat": lat,
        })

    sorties.sort(key=lambda r: (r["date_autorisation"], r["id"]))
    for nom, lignes, champs in (("dossiers.csv", sorties, CHAMPS),
                                ("dossiers_parcelles.csv", liens, ["id", "idu", "statut"]),
                                ("geocodage.csv", geocodes, ["id", "requete", "retenu", "label", "type", "score", "lon", "lat"])):
        with (d / nom).open("w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=champs, delimiter=";")
            w.writeheader()
            w.writerows(lignes)

    print(f"{len(sorties)} dossiers : " + ", ".join(f"{t} {n}" for t, n in Counter(r["type"] for r in sorties).most_common()))
    print("localisation : " + ", ".join(f"{k} {n}" for k, n in Counter(r["localisation"] for r in sorties).most_common()))
    print(f"-> data/{insee}/dossiers.csv, dossiers_parcelles.csv ({len(liens)} liens), geocodage.csv ({len(geocodes)} requêtes)")


if __name__ == "__main__":
    main()
