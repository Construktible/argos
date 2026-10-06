"""Essai : avant / après sur un vrai fond de plan de Montreuil, autorisations fictives (référence : impeccable.style).

Écrit site/essais/montreuil.html (styles : montreuil.css, script : montreuil.js). Carré de 300 m autour d'une
maison du quartier Villiers-Barbusse : parcelles et bâtiments du cadastre Etalab (2026-09-01). Les autorisations
sont inventées : elles sont posées sur des parcelles choisies pour leur taille, pas tirées de SITADEL.

Entrées : doc_source/cadastre/93048/2026-09-01.json.gz (parcelles) et batiments-2026-09-01.json.gz.
"""
import gzip
import json
import random
from math import cos, hypot, radians
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
CADASTRE = RACINE / "doc_source" / "cadastre" / "93048"
SORTIE = RACINE / "site" / "essais" / "montreuil.html"
CENTRE = (2.4400, 48.8640)       # Villiers-Barbusse
DEMI = 150                       # m : le carré fait 300 m de côté

QUESTIONS = [  # (question sur deux lignes, hauteur dans le carré en %, position de la couture qui y répond)
    ("Qu'est-ce qui va se\nconstruire ici ?", 20, 35),
    ("Un immeuble va-t-il\nsortir de terre ?", 50, 24),
    ("Mon quartier va-t-il\nchanger ?", 80, 13),
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


def chemin(pts):
    return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"


def svg(etat, parcelles, batiments):
    pal = PALETTES[etat]
    apres = etat == "apres"
    ns = 'vector-effect="non-scaling-stroke"'
    el = [f'<rect x="{-DEMI - 5}" y="{-DEMI - 5}" width="{2 * DEMI + 10}" height="{2 * DEMI + 10}" fill="{pal["rue"]}"/>']
    for p in parcelles:
        fond = f'fill="{BLEU}" fill-opacity=".5"' if apres and p.get("autorisee") else f'fill="{pal["sol"]}"'
        el.append(f'<path d="{chemin(p["pts"])}" {fond} stroke="{pal["bord"]}" stroke-width=".6" {ns}/>')
    for b in batiments:
        bleu = apres and b["parcelle"] and b["parcelle"].get("autorisee")
        el.append(f'<path d="{chemin(b["pts"])}" fill="{BLEU_BATI if bleu else pal["bati"]}" '
                  f'stroke="{pal["bati_bord"]}" stroke-width=".6" {ns}/>')
    return (f'<svg viewBox="{-DEMI} {-DEMI} {2 * DEMI} {2 * DEMI}" preserveAspectRatio="xMidYMid slice" '
            f'aria-hidden="true">{"".join(el)}</svg>')


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


def main():
    parcelles, batiments, lieux = composer()
    nb = sum(1 for p in parcelles if p.get("autorisee"))
    a_m = lambda libelle: round(hypot(*centroide(lieux[[l["libelle"] for l in PROJETS].index(libelle)]["pts"])) / 10) * 10
    reponses = [  # tirées des autorisations (fictives) posées sur le plan
        "Une école, 32 logements,\n4 maisons…",
        f"Oui : 32 logements\nà {a_m('32 logements')} m",
        f"{nb} autorisations\nà moins de {DEMI} m",
    ]
    br = lambda t: t.replace("\n", "<br>")
    questions = "".join(f'<div class="paire" style="top:{h}%;--rang:{i}" data-seuil="{seuil}">'
                        f'<span class="question">{br(q)}</span><span class="reponse">{br(r)}</span></div>'
                        for i, ((q, h, seuil), r) in enumerate(zip(QUESTIONS, reponses)))
    projets = []
    for l, p in zip(PROJETS, lieux):
        x, y = centroide(p["pts"])
        projets.append(f'<span class="projet" style="left:{pc(x)};top:{pc(y)}">{l["libelle"]}</span>')
    html = f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Argos · essai Montreuil</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="../style.css?v=31">
<link rel="stylesheet" href="montreuil.css?v=5">
</head>
<body>
<div class="accueil">
  <header class="accueil-entete">
    <a class="titre" href="../" aria-label="Argos, accueil">
      <svg class="logo" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="3.6" fill="currentColor"/>
        <circle cx="15" cy="15" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="15" cy="15" r="13.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity=".45"/>
      </svg>
      <span class="marque">argos</span>
    </a>
    <span class="pastille">Essai · Montreuil</span>
  </header>
  <main>
    <section class="hero hero-preuve">
      <div class="hero-contenu">
        <p class="surtitre">Autorisations d'urbanisme · données SITADEL</p>
        <h1>Ce qui va changer autour de vous, avant que ça se voie.</h1>
      </div>
      <div class="scene">
        <figure class="preuve" style="--position: 62%">
          <div class="couche avant"><article class="plan">
            <div class="plan-carte">{svg("avant", parcelles, batiments)}</div>{arc("avant")}{questions}
          </article></div>
          <div class="couche apres"><article class="plan">
            <div class="plan-carte">{svg("apres", parcelles, batiments)}</div>{"".join(projets)}{arc("apres")}
          </article></div>
          <span class="adresse-plan" aria-hidden="true"><span>Votre adresse</span></span>
          <div class="couture" aria-hidden="true"></div>
          <input class="curseur" type="range" min="2" max="98" step="any" value="62"
                 aria-label="Avant / après : glisser pour révéler les autorisations délivrées autour de l'adresse">
          <p class="sr">Plan d'un quartier, 150 m autour d'une adresse : avant, des questions ; après, {nb} parcelles
            portant une autorisation, dont une école, 32 logements et 4 maisons.</p>
        </figure>
      </div>
      <p class="legende-essai">Glissez pour voir ce qui a été autorisé autour de l'adresse.
        <span>Fond de plan : cadastre de Montreuil. Autorisations fictives.</span></p>
    </section>
  </main>
</div>
<script src="montreuil.js?v=3" defer></script>
</body>
</html>
"""
    SORTIE.write_text(html, encoding="utf-8")
    print(SORTIE, f"{len(html) // 1024} Ko", nb, "parcelles bleues",
          [tuple(round(v) for v in centroide(p["pts"])) for p in lieux])


if __name__ == "__main__":
    main()
