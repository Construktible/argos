"""Accueil : le carré avant / après, sur un vrai fond de plan de Montreuil, avec les vraies autorisations.

Repris du hero d'impeccable.style. Carré de 300 m autour d'une maison de l'est de Montreuil (parcelle T 190) :
parcelles et bâtiments du cadastre Etalab (2026-09-01), autorisations SITADEL accordées depuis DEPUIS sur les
parcelles à moins de 150 m de la maison (site/data/93048/dossiers.json). Les réponses aux questions et les libellés
posés sur le plan en sont tirés. Quartier choisi le 6 octobre 2026 pour ce qu'il montre : un immeuble à 50 m, deux
autres plus loin, une démolition, des petits travaux, un lotissement.

Écrit site/accueil/plan-avant.svg et plan-apres.svg, et remplace dans site/index.html le bloc compris entre
<!-- preuve:debut --> et <!-- preuve:fin --> (questions, réponses, libellés, adresse, curseur).
Styles : bloc « Accueil · avant / après » de site/style.css ; script : site/preuve.js.

Entrées : doc_source/cadastre/93048/2026-09-01.json.gz (parcelles) et batiments-2026-09-01.json.gz,
          site/data/93048/dossiers.json (sortie de scripts/05_site.py).
"""
import gzip
import json
import re
from math import cos, hypot, radians
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
CADASTRE = RACINE / "doc_source" / "cadastre" / "93048"
SITE = RACINE / "site"
DOSSIERS = SITE / "data" / "93048" / "dossiers.json"
CENTRE = (2.45153, 48.86575)     # est de Montreuil, parcelle T 190
DEMI = 150                       # m : le carré fait 300 m de côté ; autorisations retenues à moins de DEMI m
DEPUIS = 2021                    # comme la période par défaut du site (5 dernières années)
LIBELLES_MAX = 6                 # projets nommés sur le plan

QUESTIONS = [  # (question sur deux lignes, hauteur en % hors du carré puis dans le carré (écran étroit, l'adresse
    #             occupe le centre), position de la couture qui y répond)
    ("Qu'est-ce qui va se\nconstruire ici ?", 20, 8, 35),
    ("Un immeuble va-t-il\nsortir de terre ?", 50, 58, 24),
    ("Mon quartier va-t-il\nchanger ?", 80, 82, 13),
]
COURT = {"atelier d'artisanat": "atelier", "équipement d'intérêt collectif": "équipement", "local industriel": "local",
         "local non résidentiel": "local", "bâtiment agricole": "bâtiment agricole"}  # destinations, pour les libellés
CONSTRUCTIONS = {"bureaux": "Bureaux", "commerce": "Commerce", "hôtels": "Hôtel", "industrie": "Local d'activité",
                 "entrepôt": "Entrepôt", "service public ou d'intérêt collectif": "Équipement public"}
ARTICLES = {"Démolition": "une démolition", "Agrandissement": "un agrandissement", "Lotissement": "un lotissement",
            "Commerce": "un commerce", "Bureaux": "des bureaux", "Hôtel": "un hôtel", "Entrepôt": "un entrepôt",
            "Local d'activité": "un local d'activité", "Équipement public": "un équipement public"}
PRIORITES = {"Démolition": 1, "Lotissement": 3, "Agrandissement": 4, "1 maison": 4, "1 logement": 4, "Travaux": 9}


def priorite(o):
    """Ordre de présentation : immeubles d'abord, puis démolition, constructions et changements d'usage, lotissement,
    agrandissements ; les travaux sans objet précis ne sont jamais nommés."""
    return 0 if o["libelle"].endswith(" logements") else PRIORITES.get(o["libelle"], 2)

PALETTES = {
    "avant": dict(rue="#e6e1d6", sol="#dedad2", bord="#c9c3b7", bati="#c4beb2", bati_bord="#ada79b"),
    "apres": dict(rue="#ffffff", sol="#f4f2ed", bord="#d8d3c9", bati="#d9d5cc", bati_bord="#a9a397"),
}
BLEU, BLEU_BATI = "#2a78d6", "#8fb1e3"


def anneaux(g):
    return [g["coordinates"][0]] if g["type"] == "Polygon" else [p[0] for p in g["coordinates"]]


def dans(pts, q):
    """Point dans polygone (lancer de rayon)."""
    x, y = q
    c = False
    for i in range(len(pts)):
        (x1, y1), (x2, y2) = pts[i - 1], pts[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def centroide(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def distance(pts):
    """Distance de l'adresse (origine) au polygone, 0 dedans."""
    if dans(pts, (0, 0)):
        return 0
    best = float("inf")
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        dx, dy = x2 - x1, y2 - y1
        t = 0 if dx == dy == 0 else max(0, min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)))
        best = min(best, hypot(x1 + t * dx, y1 + t * dy))
    return best


def etiquette(d):
    """Libellé court d'une autorisation, posé sur le plan (« 11 logements », « Atelier → logement », « Démolition »)."""
    n, objet = round(float(d["nb_logements_crees"] or 0)), d["objet"] or ""
    if d["type"] == "PD":
        return "Démolition"
    if d["type"] == "PA":
        return "Lotissement"
    m = re.match(r"Changement de destination : (.+?) → (.+?)(?:,| ·|$)", objet)
    if m:
        avant, apres = (COURT.get(x, x) for x in m.groups())
        return f"{avant[0].upper()}{avant[1:]} → {apres}"
    if n >= 2:
        return f"{n} logements"
    if objet.startswith("Agrandissement"):
        return "Agrandissement"
    if objet.startswith("Construction neuve"):
        if n == 1:
            return "1 maison" if d["type_logements"] == "un logement individuel" else "1 logement"
        return CONSTRUCTIONS.get(d["destination_principale"], "Construction neuve")
    return "Travaux"


def ampleur(d):
    nombre = lambda c: float(d[c] or 0)
    return (nombre("nb_logements_crees"), nombre("surf_habitation_creee") + nombre("surf_non_residentielle_creee"),
            nombre("surf_habitation_demolie") + nombre("surf_non_residentielle_demolie"))


def charger():
    lon0, lat0 = CENTRE
    k = cos(radians(lat0))
    xy = lambda p: ((p[0] - lon0) * 111320 * k, -(p[1] - lat0) * 110540)
    marge = DEMI + 60

    def lire(nom):
        out = []
        for f in json.load(gzip.open(CADASTRE / nom))["features"]:
            for a in anneaux(f["geometry"]):
                pts = [xy(p) for p in a]
                if any(abs(x) < marge and abs(y) < marge for x, y in pts):
                    out.append(dict(pts=pts, props=f["properties"]))
        return out

    return lire("2026-09-01.json.gz"), lire("batiments-2026-09-01.json.gz")


def composer():
    parcelles, batiments = charger()
    for b in batiments:
        c = centroide(b["pts"])
        b["parcelle"] = next((p for p in parcelles if dans(p["pts"], c)), None)
    # L'adresse : la parcelle bâtie de maison (100 à 600 m²) la plus proche du centre ; on recentre sur elle
    bati = {id(b["parcelle"]) for b in batiments if b["parcelle"]}
    maison = min((p for p in parcelles if 100 < p["props"]["contenance"] < 600 and id(p) in bati),
                 key=lambda p: hypot(*centroide(p["pts"])))
    ox, oy = centroide(maison["pts"])
    for o in parcelles + batiments:
        o["pts"] = [(x - ox, y - oy) for x, y in o["pts"]]
    maison["adresse"] = True

    # Autorisations accordées depuis DEPUIS sur une parcelle actuelle à moins de DEMI m de l'adresse
    par_id = {p["props"]["id"]: p for p in parcelles}
    projets = []
    for d in json.loads(DOSSIERS.read_text(encoding="utf-8")):
        ps = [par_id[i] for i in d["actuelles"] if i in par_id]
        if d["date_autorisation"][:4] < str(DEPUIS) or not ps or min(distance(p["pts"]) for p in ps) > DEMI:
            continue
        for p in ps:
            p["autorisee"] = True
        projets.append(dict(d=d, parcelle=max(ps, key=lambda p: p["props"]["contenance"]),
                            distance=min(distance(p["pts"]) for p in ps), libelle=etiquette(d)))
    projets.sort(key=lambda o: (priorite(o), [-v for v in ampleur(o["d"])]))

    lieux = []  # projets nommés sur le plan : dans l'ordre de priorité, loin les uns des autres, de l'adresse et des bords
    #             gauche et droit (le libellé, centré sur sa parcelle, fait environ 80 m de large)
    for o in projets:
        c = centroide(o["parcelle"]["pts"])
        if (len(lieux) < LIBELLES_MAX and priorite(o) < 9 and 30 < hypot(*c) and abs(c[0]) < DEMI - 40 and abs(c[1]) < DEMI - 15
                and all(hypot(c[0] - l["xy"][0], c[1] - l["xy"][1]) > 45 for l in lieux)):
            lieux.append({**o, "xy": c})
    return parcelles, batiments, projets, lieux


def visible(pts):
    """Le polygone touche-t-il le carré ?"""
    xs, ys = [x for x, _ in pts], [y for _, y in pts]
    return max(xs) > -DEMI and min(xs) < DEMI and max(ys) > -DEMI and min(ys) < DEMI


def chemin(pts):
    return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"


def svg(etat, parcelles, batiments):
    """Plan autonome (fichier .svg chargé par <img>) : un style par classe plutôt que des attributs répétés."""
    pal = PALETTES[etat]
    apres = etat == "apres"
    style = (f'path{{stroke-width:.6px;vector-effect:non-scaling-stroke}}'
             f'.p{{fill:{pal["sol"]};stroke:{pal["bord"]}}}.b{{fill:{pal["bati"]};stroke:{pal["bati_bord"]}}}'
             f'.pa{{fill:{BLEU};fill-opacity:.5;stroke:{pal["bord"]}}}.ba{{fill:{BLEU_BATI};stroke:{pal["bati_bord"]}}}')
    el = [f'<rect x="{-DEMI}" y="{-DEMI}" width="{2 * DEMI}" height="{2 * DEMI}" fill="{pal["rue"]}"/>']
    for p in parcelles:
        if visible(p["pts"]):
            el.append(f'<path class="{"pa" if apres and p.get("autorisee") else "p"}" d="{chemin(p["pts"])}"/>')
    for b in batiments:
        if visible(b["pts"]):
            bleu = apres and b["parcelle"] and b["parcelle"].get("autorisee")
            el.append(f'<path class="{"ba" if bleu else "b"}" d="{chemin(b["pts"])}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-DEMI} {-DEMI} {2 * DEMI} {2 * DEMI}" '
            f'width="600" height="600"><style>{style}</style>{"".join(el)}</svg>\n')


def pc(v):
    return f"{(v + DEMI) / (2 * DEMI) * 100:.2f}%"


ARC = {  # mentions en arc aux coins, comme sur impeccable.style
    "avant": ("M 6 40 A 34 34 0 0 1 40 6", "Avant"),
    "apres": ("M 40 74 A 34 34 0 0 0 74 40", "Après"),
}


def arc(etat):
    d, texte = ARC[etat]
    return (f'<svg class="mention mention-{etat}" viewBox="0 0 80 80" aria-hidden="true">'
            f'<path id="arc-{etat}" d="{d}" fill="none"/><text><textPath href="#arc-{etat}" startOffset="50%" '
            f'text-anchor="middle">{texte}</textPath></text></svg>')


def bloc(parcelles, projets, lieux, version):
    nb = sum(1 for p in parcelles if p.get("autorisee"))
    sorte = lambda l: "logements" if l.endswith(" logements") else l  # une seule ligne « N logements » dans la liste
    vus, liste = set(), []
    for o in projets:
        if priorite(o) < 9 and sorte(o["libelle"]) not in vus:
            vus.add(sorte(o["libelle"]))
            liste.append(ARTICLES.get(o["libelle"], o["libelle"] if o["libelle"][0].isdigit() else o["libelle"][0].lower() + o["libelle"][1:]))
    liste = liste[:3]
    phrase = f"{liste[0][0].upper()}{liste[0][1:]}" + "".join(f",{chr(10) if i == 1 else ' '}{x}" for i, x in enumerate(liste[1:], 1)) + "…"
    immeuble = min((o for o in projets if float(o["d"]["nb_logements_crees"] or 0) >= 10), key=lambda o: o["distance"], default=None)
    reponses = [  # tirées des autorisations réelles posées sur le plan
        phrase,
        f"Oui : {immeuble['libelle']}\nà {max(10, round(immeuble['distance'] / 10) * 10)} m" if immeuble else f"Aucun recensé\nà moins de {DEMI} m",  # jamais « non » : l'absence de dossier ne prouve rien
        f"{len(projets)} autorisations\nà moins de {DEMI} m",
    ]
    br = lambda t: t.replace("\n", "<br>")
    paires = "".join(f'\n              <div class="paire" style="--haut:{h}%;--haut-etroit:{he}%;--rang:{i}" '
                     f'data-seuil="{seuil}"><span class="question">{br(q)}</span><span class="reponse">{br(r)}</span></div>'
                     for i, ((q, h, he, seuil), r) in enumerate(zip(QUESTIONS, reponses)))
    etiquettes = "".join(f'\n              <span class="projet" style="left:{pc(l["xy"][0])};'
                         f'top:{pc(l["xy"][1])}">{l["libelle"]}</span>' for l in lieux)
    return f"""<!-- preuve:debut · généré par design/accueil_preuve.py, ne pas modifier à la main -->
        <figure class="preuve" style="--position: 62%">
          <div class="couche avant"><div class="plan">
            <img class="plan-carte" src="accueil/plan-avant.svg?v={version}" alt="" width="600" height="600">
            {arc("avant")}{paires}
          </div></div>
          <div class="couche apres"><div class="plan">
            <img class="plan-carte" src="accueil/plan-apres.svg?v={version}" alt="" width="600" height="600">{etiquettes}
            {arc("apres")}
          </div></div>
          <span class="adresse-plan" aria-hidden="true"><span>Votre adresse</span></span>
          <div class="couture" aria-hidden="true"></div>
          <input class="curseur" type="range" min="2" max="98" step="any" value="62"
                 aria-label="Avant / après : glisser pour révéler les autorisations autour de l'adresse">
          <figcaption class="sr">Le plan d'un quartier de Montreuil, {DEMI} m autour d'une maison. Avant : des questions.
            Après : {len(projets)} autorisations accordées depuis {DEPUIS} sur {nb} parcelles, dont {", ".join(liste)}.</figcaption>
        </figure>
        <p class="preuve-legende">Plan réel d'un quartier de Montreuil · autorisations réellement accordées depuis {DEPUIS}</p>
        <!-- preuve:fin -->"""


def main():
    parcelles, batiments, projets, lieux = composer()
    for etat in ("avant", "apres"):
        (SITE / "accueil" / f"plan-{etat}.svg").write_text(svg(etat, parcelles, batiments), encoding="utf-8")
    index = SITE / "index.html"
    html = index.read_text(encoding="utf-8")
    motif = re.compile(r"<!-- preuve:debut.*?<!-- preuve:fin -->", re.S)
    if not motif.search(html):
        raise SystemExit("Repères <!-- preuve:debut --> et <!-- preuve:fin --> introuvables dans site/index.html")
    version = re.search(r'plan-avant\.svg\?v=(\d+)', html)
    version = int(version.group(1)) + 1 if version else 1  # les plans changent : le cache du navigateur aussi
    index.write_text(motif.sub(lambda _: bloc(parcelles, projets, lieux, version), html), encoding="utf-8")
    tailles = {f.name: f"{f.stat().st_size // 1024} Ko" for f in sorted((SITE / "accueil").glob("*.svg"))}
    print(index, tailles, len(projets), "autorisations,", sum(1 for p in parcelles if p.get("autorisee")), "parcelles bleues")
    for o in projets:
        print(f"  {o['distance']:5.0f} m  {o['libelle']:24s} {o['d']['id']}  {o['d']['objet'][:60]}")


if __name__ == "__main__":
    main()
