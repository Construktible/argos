"""Accueil : le carré avant / après, sur un vrai fond de plan de Montreuil, autorisations fictives.

Repris du hero d'impeccable.style. Carré de 300 m autour d'une maison du quartier Villiers-Barbusse : parcelles
et bâtiments du cadastre Etalab (2026-09-01). Les autorisations sont inventées : elles sont posées sur des
parcelles choisies pour leur taille, pas tirées de SITADEL (la légende du carré le dit).

Écrit site/accueil/plan-avant.svg et plan-apres.svg, et remplace dans site/index.html le bloc compris entre
<!-- preuve:debut --> et <!-- preuve:fin --> (questions, réponses, libellés, adresse, curseur).
Styles : bloc « Accueil · avant / après » de site/style.css ; script : site/preuve.js.

Entrées : doc_source/cadastre/93048/2026-09-01.json.gz (parcelles) et batiments-2026-09-01.json.gz.
"""
import gzip
import json
import random
import re
from math import cos, hypot, radians
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
CADASTRE = RACINE / "doc_source" / "cadastre" / "93048"
SITE = RACINE / "site"
CENTRE = (2.4400, 48.8640)       # Villiers-Barbusse
DEMI = 150                       # m : le carré fait 300 m de côté

QUESTIONS = [  # (question sur deux lignes, hauteur en % hors du carré puis dans le carré (écran étroit, l'adresse
    #             occupe le centre), position de la couture qui y répond)
    ("Qu'est-ce qui va se\nconstruire ici ?", 20, 8, 35),
    ("Un immeuble va-t-il\nsortir de terre ?", 50, 58, 24),
    ("Mon quartier va-t-il\nchanger ?", 80, 82, 13),
]
# Autorisations fictives : point visé (m depuis l'adresse, y vers le bas), surface de parcelle admise (m²)
PROJETS = [
    dict(pos=(-60, 55), surface=(1500, 9000), libelle="Une école"),
    dict(pos=(85, -40), surface=(700, 6000), libelle="32 logements"),
    dict(pos=(55, 90), surface=(300, 1500), libelle="4 maisons"),
    dict(pos=(35, -95), surface=(100, 400), libelle="Agrandissement"),
    dict(pos=(-75, -80), surface=(150, 600), libelle="Démolition"),
    dict(pos=(-90, -35), surface=(400, 2000), libelle="Bureaux → logements"),
]
AUTRES_AUTORISATIONS = 7

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

    lieux = []
    for l in PROJETS:
        lo, hi = l["surface"]
        p = min((p for p in parcelles if lo <= p["props"]["contenance"] <= hi and not p.get("adresse")
                 and not p.get("autorisee") and 55 < hypot(*centroide(p["pts"])) < DEMI - 15
                 and all(hypot(*(a - b for a, b in zip(centroide(p["pts"]), centroide(q["pts"])))) > 45 for q in lieux)),
                key=lambda p: hypot(*(a - b for a, b in zip(centroide(p["pts"]), l["pos"]))))
        p["autorisee"] = True
        lieux.append(p)
    rng = random.Random(7)
    autres = [p for p in parcelles if not p.get("autorisee") and not p.get("adresse")
              and 100 < p["props"]["contenance"] < 2500 and 25 < hypot(*centroide(p["pts"])) < DEMI - 10]
    for p in rng.sample(autres, AUTRES_AUTORISATIONS):
        p["autorisee"] = True
    return parcelles, batiments, lieux


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


def bloc(parcelles, lieux, version):
    nb = sum(1 for p in parcelles if p.get("autorisee"))
    a_m = lambda libelle: round(hypot(*centroide(lieux[[l["libelle"] for l in PROJETS].index(libelle)]["pts"])) / 10) * 10
    reponses = [  # tirées des autorisations (fictives) posées sur le plan
        "Une école, 32 logements,\n4 maisons…",
        f"Oui : 32 logements\nà {a_m('32 logements')} m",
        f"{nb} autorisations\nà moins de {DEMI} m",
    ]
    br = lambda t: t.replace("\n", "<br>")
    paires = "".join(f'\n              <div class="paire" style="--haut:{h}%;--haut-etroit:{he}%;--rang:{i}" '
                     f'data-seuil="{seuil}"><span class="question">{br(q)}</span><span class="reponse">{br(r)}</span></div>'
                     for i, ((q, h, he, seuil), r) in enumerate(zip(QUESTIONS, reponses)))
    projets = "".join(f'\n              <span class="projet" style="left:{pc(centroide(p["pts"])[0])};'
                      f'top:{pc(centroide(p["pts"])[1])}">{l["libelle"]}</span>' for l, p in zip(PROJETS, lieux))
    return f"""<!-- preuve:debut · généré par design/accueil_preuve.py, ne pas modifier à la main -->
        <figure class="preuve" style="--position: 62%">
          <div class="couche avant"><div class="plan">
            <img class="plan-carte" src="accueil/plan-avant.svg?v={version}" alt="" width="600" height="600">
            {arc("avant")}{paires}
          </div></div>
          <div class="couche apres"><div class="plan">
            <img class="plan-carte" src="accueil/plan-apres.svg?v={version}" alt="" width="600" height="600">{projets}
            {arc("apres")}
          </div></div>
          <span class="adresse-plan" aria-hidden="true"><span>Votre adresse</span></span>
          <div class="couture" aria-hidden="true"></div>
          <input class="curseur" type="range" min="2" max="98" step="any" value="62"
                 aria-label="Avant / après : glisser pour révéler les autorisations autour de l'adresse">
          <figcaption class="sr">Illustration : le plan d'un quartier de Montreuil, 150 m autour d'une adresse.
            Avant : des questions. Après : {nb} parcelles portant une autorisation fictive, dont une école,
            32 logements et 4 maisons.</figcaption>
        </figure>
        <p class="preuve-legende">Illustration · plan réel d'un quartier de Montreuil, autorisations fictives</p>
        <!-- preuve:fin -->"""


def main():
    parcelles, batiments, lieux = composer()
    for etat in ("avant", "apres"):
        (SITE / "accueil" / f"plan-{etat}.svg").write_text(svg(etat, parcelles, batiments), encoding="utf-8")
    index = SITE / "index.html"
    html = index.read_text(encoding="utf-8")
    motif = re.compile(r"<!-- preuve:debut.*?<!-- preuve:fin -->", re.S)
    if not motif.search(html):
        raise SystemExit("Repères <!-- preuve:debut --> et <!-- preuve:fin --> introuvables dans site/index.html")
    version = re.search(r'plan-avant\.svg\?v=(\d+)', html)
    version = int(version.group(1)) + 1 if version else 1  # les plans changent : le cache du navigateur aussi
    index.write_text(motif.sub(lambda _: bloc(parcelles, lieux, version), html), encoding="utf-8")
    tailles = {f.name: f"{f.stat().st_size // 1024} Ko" for f in sorted((SITE / "accueil").glob("*.svg"))}
    print(index, tailles, sum(1 for p in parcelles if p.get("autorisee")), "parcelles bleues")


if __name__ == "__main__":
    main()
