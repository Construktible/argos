"use strict";
/* Argos · site public : autorisations d'urbanisme parcelle par parcelle, et dans un rayon autour d'une adresse.
   Même logique que scripts/recherche.py : point d'adresse rapproché dans la parcelle actuelle la plus proche,
   parcelles actuelles et anciennes au point, parcelles voisines, distance au contour des parcelles pour le rayon.
   Données préparées par scripts/05_site.py (une commune par dossier) et 06_index.py (index des communes et contours) :
   seules les communes touchées par la vue sont chargées. Direction visuelle : design/DESIGN.md. */

const DONNEES = "data";
const GEOCODEUR = "https://data.geopf.fr/geocodage/search";
const STYLE_PLAN = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/gris.json";
const TUILES_PHOTO = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS"
  + "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
const R_TERRE = 6371008.8;
const TOLERANCE_VOIE = 25;  // m : distance max entre le point de l'adresse et la parcelle la plus proche
const RENTREE = 0.5;        // m : le point rapproché est placé à cette distance à l'intérieur du contour
const VOISINAGE = 10;       // m : au-delà de la parcelle la plus proche, parcelles dites voisines
const MARGE_ZONE = 30;      // m : tolérance sur les contours de communes (simplifiés) pour charger une commune et repérer le bord de zone
const RAYONS = [100, 200, 300, 500];
const ANS_RECENTS = 5;  // période par défaut : les 5 dernières années des données, l'historique complet reste à un clic
const COULEUR_AUTORISATION = "#2a78d6";  // parcelles du rayon portant au moins une autorisation
const ENCRE = "#1d2125";       // adresse choisie, rayon, parcelle choisie (la carte reste claire en mode sombre)
const SURLIGNAGE = "#ffe600";  // autorisation sélectionnée dans la liste
const TYPES = {PC: "permis de construire", DP: "déclaration préalable", PA: "permis d'aménager", PD: "permis de démolir"};
const TYPES_PLURIEL = {PC: "permis de construire", DP: "déclarations préalables", PA: "permis d'aménager", PD: "permis de démolir"};
const ORDRE_TYPES = ["PC", "DP", "PD", "PA"];  // puces et légende des sigles, du plus fréquent au plus rare
const PRECISIONS = {DP: "petits travaux", PA: "lotissement"};  // ce que le nom officiel ne dit pas
const TRANSPARENT = "rgba(0,0,0,0)";
const PETIT_ECRAN = matchMedia("(max-width: 820px)");

const etat = {types: new Set(Object.keys(TYPES)), depuis: 0, rayon: 300, vue: null, resultat: null, photo: false,
  tri: "ampleur", affichage: "split",  // tri de la liste du rayon ; affichage : liste + carte, liste seule, carte seule
  surligne: null, survol: null,  // autorisation sélectionnée (fixe) et autorisation survolée dans la liste
  pointee: null,                 // parcelle survolée sur la carte : ses autorisations sont mises en avant dans la liste
  parcelle: null,                // parcelle cliquée sur la carte : sa fiche s'ouvre en surimpression
  retourParcelle: null};         // autorisation ouverte depuis une fiche de parcelle : bouton de retour vers celle-ci
const toutes = new Map();          // idu -> {geom, emprise, actuelle, contenance | premier, dernier, successeurs}
const predecesseurs = new Map();   // idu actuelle -> [idu anciennes]
const parParcelle = new Map();     // idu actuelle -> [dossiers]
const parId = new Map();
const infoCommune = new Map();     // insee -> entrée de communes.json (nom, emprise, effectifs, année de départ)
const chargements = new Map();     // insee -> promesse du chargement de la commune
const pretes = new Set();          // communes chargées
const collection = () => ({type: "FeatureCollection", features: []});
const geoParcelles = collection(), geoAnciennes = collection(), geoAdresses = collection();  // communes chargées, réunies
let zone, contours, carte, marqueur, infobulle;  // zone : communes.json ; contours : contours.json
let dossiers = [];
let debutRecent;  // première année de la période par défaut
let cartePrete = false;  // nos couches ajoutées ; isStyleLoaded() reste faux tant qu'une icône du fond IGN manque

/* ---------- Mise en forme ---------- */

const nombre = new Intl.NumberFormat("fr-FR");
const formatDate = new Intl.DateTimeFormat("fr-FR", {day: "numeric", month: "short", year: "numeric"});
const formatMois = new Intl.DateTimeFormat("fr-FR", {month: "long", year: "numeric"});
const formatMoisCourt = new Intl.DateTimeFormat("fr-FR", {month: "short", year: "numeric"});
const dateFr = s => s ? formatDate.format(new Date(`${s}T12:00:00`)) : "";
const moisFr = s => s ? formatMois.format(new Date(`${s.slice(0, 7)}-15T12:00:00`)) : "";  // "2026-09" -> "septembre 2026"
const milliers = s => s >= 10000 ? `${nombre.format(Math.round(s / 1000))} 000` : nombre.format(s);
const nomType = (t, n) => n > 1 ? TYPES_PLURIEL[t] : TYPES[t];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const pluriel = (n, mot, motPluriel = `${mot}s`) => `${nombre.format(n)} ${n > 1 ? motPluriel : mot}`;
const numeroDossier = d => `${d.type} ${d.num.slice(0, 3)} ${d.num.slice(3, 6)} ${d.num.slice(6, 8)} ${d.num.slice(8)}`;
const nomParcelle = id => `${id.slice(5, 8) === "000" ? "" : `${id.slice(5, 8)} `}${id.slice(8, 10).replace(/^0/, "")} ${Number(id.slice(10))}`;  // préfixe : ancienne commune fusionnée
const annee = s => s ? s.slice(0, 4) : "";
const parDateDesc = (a, b) => (b.date_autorisation || "").localeCompare(a.date_autorisation || "") || a.id.localeCompare(b.id);
const dansPeriode = d => Number(annee(d.date_autorisation) || etat.depuis) >= etat.depuis;
const visible = d => etat.types.has(d.type) && dansPeriode(d);

const projet = d => d.objet || d.nature_projet || "";  // objet en clair, écrit par scripts/04_dossiers.py
const surfaceCreee = d => Number(d.surf_habitation_creee || 0) + Number(d.surf_non_residentielle_creee || 0);
const surfaceDemolie = d => Number(d.surf_habitation_demolie || 0) + Number(d.surf_non_residentielle_demolie || 0);
const TRIS = {  // liste du rayon ; la valeur à droite de chaque ligne suit le tri ; l'impression et le CSV restent groupés par adresse
  ampleur: {libelle: "Ampleur", aide: "Les plus grandes surfaces créées d'abord.",
    ordre: (a, b) => surfaceCreee(b) - surfaceCreee(a) || surfaceDemolie(b) - surfaceDemolie(a)
      || Number(b.nb_logements_crees || 0) - Number(a.nb_logements_crees || 0) || parDateDesc(a, b)},
  distance: {libelle: "Distance", aide: "Les plus proches d'abord, regroupées par adresse."},
  date: {libelle: "Date", aide: "Les décisions les plus récentes d'abord, par année.", ordre: parDateDesc},
};

function totaux(liste) {
  const valides = liste.filter(d => d.etat !== "annulé");
  return {
    logements: valides.reduce((s, d) => s + Number(d.nb_logements_crees || 0), 0),
    surface: valides.reduce((s, d) => s + surfaceCreee(d), 0),
  };
}

/* ---------- Géométrie (plan tangent au point recherché, en mètres) ---------- */

const polygones = g => g.type === "Polygon" ? [g.coordinates] : g.coordinates;

function emprise(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polygones(g)) for (const [x, y] of poly[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function contient(polys, x, y) {
  for (const poly of polys) {
    let dedans = false;
    for (const anneau of poly) {  // règle pair-impair sur tous les anneaux : les trous ressortent
      for (let k = 0; k < anneau.length - 1; k++) {
        const [x0, y0] = anneau[k], [x1, y1] = anneau[k + 1];
        if ((y0 > y) !== (y1 > y) && x < x0 + (y - y0) * (x1 - x0) / (y1 - y0)) dedans = !dedans;
      }
    }
    if (dedans) return true;
  }
  return false;
}

function plusProche(polys) {  // distance de l'origine au polygone, et point du contour le plus proche ; 0 si dedans
  if (contient(polys, 0, 0)) return [0, 0, 0];
  let best = [Infinity, 0, 0];
  for (const poly of polys) for (const anneau of poly) {
    for (let k = 0; k < anneau.length - 1; k++) {
      const [x0, y0] = anneau[k], [x1, y1] = anneau[k + 1], dx = x1 - x0, dy = y1 - y0;
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / (dx * dx + dy * dy)));
      const px = x0 + t * dx, py = y0 + t * dy, d = Math.hypot(px, py);
      if (d < best[0]) best = [d, px, py];
    }
  }
  return best;
}

function centroide(g) {  // barycentre des surfaces, trous soustraits
  let sx = 0, sy = 0, sa = 0;
  for (const poly of polygones(g)) poly.forEach((anneau, k) => {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < anneau.length - 1; i++) {
      const [x0, y0] = anneau[i], [x1, y1] = anneau[i + 1], c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    if (a) {
      const poids = Math.abs(a) * (k === 0 ? 1 : -1);
      sx += cx / (3 * a) * poids; sy += cy / (3 * a) * poids; sa += poids;
    }
  });
  return [sx / sa, sy / sa];
}

function cercle(lon, lat, r, n = 96) {
  const kx = Math.PI / 180 * R_TERRE * Math.cos(lat * Math.PI / 180), ky = Math.PI / 180 * R_TERRE;
  const pts = Array.from({length: n + 1}, (_, i) => {
    const t = 2 * Math.PI * i / n;
    return [lon + r * Math.cos(t) / kx, lat + r * Math.sin(t) / ky];
  });
  return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [pts]}};
}

/* Parcelles au point, dossiers sur ces parcelles et sur les voisines, dossiers dans le rayon.
   dansRayonTous ignore le filtre de type : il sert aux nombres affichés sur les puces. */
function rechercher(lon0, lat0, rayon) {
  const kx = Math.PI / 180 * R_TERRE * Math.cos(lat0 * Math.PI / 180), ky = Math.PI / 180 * R_TERRE;
  const marge = Math.max(rayon, TOLERANCE_VOIE + VOISINAGE);
  const bx0 = lon0 - marge / kx, bx1 = lon0 + marge / kx, by0 = lat0 - marge / ky, by1 = lat0 + marge / ky;
  const proj = new Map(), proches = new Map();
  for (const [id, p] of toutes) {
    const [x0, y0, x1, y1] = p.emprise;
    if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
    const polys = polygones(p.geom).map(poly => poly.map(a => a.map(([x, y]) => [(x - lon0) * kx, (y - lat0) * ky])));
    proj.set(id, polys);
    proches.set(id, plusProche(polys));
  }

  const auPoint = [];
  let rapproche = null, best = null;
  for (const [id, v] of proches) if (toutes.get(id).actuelle && (!best || v[0] < best[0])) best = [v[0], id];
  if (best && best[0] <= TOLERANCE_VOIE) {
    const [d0, id0] = best;
    let sx = 0, sy = 0;
    if (d0 > 0) {
      const [, px, py] = proches.get(id0);
      sx = px * (d0 + RENTREE) / d0; sy = py * (d0 + RENTREE) / d0; rapproche = d0;
    }
    for (const [id, polys] of proj) if (contient(polys, sx, sy)) auPoint.push(id);
    if (!auPoint.includes(id0)) auPoint.unshift(id0);  // rapprochement dans un angle rentrant
  }

  const ensemble = new Set(auPoint), distances = new Map(), surParcelle = new Set();
  let plusAnciennes = 0;  // dossiers du rayon écartés par la seule période
  for (const d of dossiers) {
    let dist = Infinity;
    if (d.localisation === "adresse" || d.localisation === "voie") dist = Math.hypot((d.lon - lon0) * kx, (d.lat - lat0) * ky);
    else for (const p of d.parcelles) if (proches.has(p)) dist = Math.min(dist, proches.get(p)[0]);
    if (!dansPeriode(d)) { if (dist <= rayon && etat.types.has(d.type)) plusAnciennes++; continue; }
    if (dist <= marge) distances.set(d.id, dist);
    if (d.parcelles.some(p => ensemble.has(p)) || d.actuelles.some(p => ensemble.has(p))) surParcelle.add(d.id);
  }
  const typeAffiche = id => etat.types.has(parId.get(id).type);
  const seuil = (rapproche || 0) + VOISINAGE;
  const voisines = new Set(auPoint.length
    ? [...distances].filter(([id, x]) => x <= seuil && !surParcelle.has(id) && typeAffiche(id)).map(([id]) => id) : []);
  for (const id of surParcelle) if (!typeAffiche(id)) surParcelle.delete(id);
  const dansRayonTous = new Map([...distances].filter(([, x]) => x <= rayon));
  const dansRayon = new Map([...dansRayonTous].filter(([id]) => typeAffiche(id)));
  return {auPoint, rapproche, surParcelle, voisines, dansRayon, dansRayonTous, plusAnciennes};
}

/* ---------- Zone couverte : communes à charger, bord de zone ---------- */

function distancesCommunes(lon0, lat0, marge) {  // [insee, distance du point au contour (0 dedans)] des communes à moins de `marge`
  const kx = Math.PI / 180 * R_TERRE * Math.cos(lat0 * Math.PI / 180), ky = Math.PI / 180 * R_TERRE;
  const res = [];
  for (const f of contours.features) {
    const [x0, y0, x1, y1] = f.emprise;
    if (x1 < lon0 - marge / kx || x0 > lon0 + marge / kx || y1 < lat0 - marge / ky || y0 > lat0 + marge / ky) continue;
    const polys = polygones(f.geometry).map(poly => poly.map(a => a.map(([x, y]) => [(x - lon0) * kx, (y - lat0) * ky])));
    const d = plusProche(polys)[0];
    if (d <= marge) res.push([f.properties.insee, d]);
  }
  return res;
}

const communesAutour = (lon, lat, rayon) => distancesCommunes(lon, lat, rayon + MARGE_ZONE).map(([insee]) => insee);
const dansZone = (lon, lat) => distancesCommunes(lon, lat, MARGE_ZONE).length > 0;

function communeAuPoint(lon, lat) {  // commune qui contient le point, sinon la plus proche à moins de MARGE_ZONE
  const ds = distancesCommunes(lon, lat, MARGE_ZONE).sort((a, b) => a[1] - b[1]);
  return ds.length ? ds[0][0] : null;
}

function horsZone(lon, lat, rayon) {  // "adresse" : le point est hors zone ; "rayon" : une partie du cercle l'est
  if (!dansZone(lon, lat)) return "adresse";
  return cercle(lon, lat, rayon, 32).geometry.coordinates[0].some(([x, y]) => !dansZone(x, y)) ? "rayon" : "";
}

function communesVue(v) {  // communes dont la vue a besoin
  const connue = i => infoCommune.has(i);
  if (v.mode === "commune") return connue(v.insee) ? [v.insee] : [];
  if (v.mode === "parcelle") return connue(v.id.slice(0, 5)) ? [v.id.slice(0, 5)] : [];
  return communesAutour(v.lon, v.lat, Math.max(etat.rayon, TOLERANCE_VOIE + VOISINAGE));
}

function communeVue(v) {  // commune de rattachement de la vue, pour le retour à « toute la commune »
  if (v.mode === "commune") return v.insee;
  if (v.mode === "parcelle") return v.id.slice(0, 5);
  return communeAuPoint(v.lon, v.lat) || (infoCommune.has(v.commune) ? v.commune : "");
}

function chargerCommune(insee) {
  if (!chargements.has(insee)) {
    const lire = f => fetch(`${DONNEES}/${insee}/${f}`).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
    chargements.set(insee, Promise.all(["parcelles.json", "anciennes.json", "dossiers.json", "adresses.json"].map(lire))
      .then(fichiers => integrer(insee, ...fichiers))
      .catch(e => { chargements.delete(insee); throw e; }));
  }
  return chargements.get(insee);
}

function integrer(insee, parcelles, anciennes, ds, adresses) {  // données d'une commune ajoutées à celles déjà chargées
  for (const f of parcelles.features) {
    toutes.set(f.properties.id, {geom: f.geometry, emprise: emprise(f.geometry), actuelle: true, contenance: f.properties.c});
  }
  for (const f of anciennes.features) {
    const p = f.properties;
    toutes.set(p.id, {geom: f.geometry, emprise: emprise(f.geometry), actuelle: false, premier: p.premier, dernier: p.dernier});
    for (const s of p.successeurs) predecesseurs.set(s, [...(predecesseurs.get(s) || []), p.id]);
  }
  for (const d of ds) {
    d.insee = insee;
    d.lon = d.lon === "" ? null : Number(d.lon);
    d.lat = d.lat === "" ? null : Number(d.lat);
    parId.set(d.id, d);
    for (const p of d.actuelles) parParcelle.set(p, [...(parParcelle.get(p) || []), d]);
  }
  dossiers = dossiers.concat(ds);
  geoParcelles.features.push(...parcelles.features);
  geoAnciennes.features.push(...anciennes.features);
  geoAdresses.features.push(...adresses.features);
  pretes.add(insee);
  if (cartePrete) {
    carte.getSource("parcelles").setData(geoParcelles);
    carte.getSource("anciennes").setData(geoAnciennes);
    carte.getSource("adresses").setData(geoAdresses);
  }
}

function noteDebut(insees, toujours = false) {  // communes où SITADEL n'est fiable qu'à partir d'une année (scripts/communes.py)
  const cs = insees.map(i => infoCommune.get(i)).filter(c => c?.debut_fiable && (toujours || etat.depuis < c.debut_fiable));
  if (!cs.length) return "";
  return `<p class="alerte">${cs.map(c => `À ${esc(c.commune)}, autorisations recensées depuis ${c.debut_fiable} seulement`).join(" ; ")} :
    avant, les numéros de parcelle de SITADEL sont erronés.</p>`;
}

/* ---------- Rendu de la liste ---------- */

function sigleType(t, classe = "badge") {  // sigle du type dans sa couleur ; les lecteurs d'écran lisent le nom complet
  return `<span class="${classe}" data-type="${t}" title="${esc(TYPES[t])}"><span aria-hidden="true">${t}</span><span class="sr">${esc(TYPES[t])}</span></span>`;
}

function legendeSigles(filtre = true) {  // ce que veulent dire PC, DP, PD, PA ; à l'écran, un clic masque ou réaffiche le type
  const nom = t => `${esc(TYPES[t])}${PRECISIONS[t] ? ` (${PRECISIONS[t]})` : ""}`;
  if (!filtre) return `<p class="sigles">${ORDRE_TYPES.map(t => `<span><span class="badge" data-type="${t}">${t}</span> ${nom(t)}</span>`).join("")}</p>`;
  return `<div class="sigles" role="group" aria-labelledby="titre-sigles"><span class="sigles-titre" id="titre-sigles">Afficher :</span>${ORDRE_TYPES.map(t => `
    <button type="button" class="sigle" data-type="${t}" aria-pressed="${etat.types.has(t)}" title="Afficher ou masquer : ${esc(TYPES[t])}">
      <span class="badge" data-type="${t}" aria-hidden="true">${t}</span><span class="nom">${nom(t)}</span></button>`).join("")}</div>`;
}

const LIMITES = [  // ce que SITADEL ne contient pas : détail de la mise en garde du rapport
  "Un projet déposé récemment peut être en cours d'instruction sans figurer ici.",
  "Une autorisation n'apparaît qu'un mois environ après la décision, parfois plus.",
  "Seuls figurent les projets qui créent des logements ou de la surface de plancher, et les permis d'aménager et de démolir : "
    + "pas les petits travaux (ravalement, clôture, fenêtres), ni la plupart des petites extensions de maison.",
  "L'état d'avancement (commencé, terminé, annulé) n'est pas toujours mis à jour.",
];

function limitesRapport(n, imprime = false) {  // sous le chiffre clé ; quand rien n'est trouvé, rappeler que l'absence ne prouve rien
  const phrase = n ? "Seules les autorisations accordées figurent ici : ni les demandes en cours d'instruction, ni les refus."
    : "Cela ne garantit pas qu'aucun projet ne viendra : seules les autorisations accordées figurent ici, ni les demandes en cours d'instruction, ni les refus.";
  const detail = `<ul>${LIMITES.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`;
  if (imprime) return `<div class="limites-rapport"><p>${phrase}</p>${detail}</div>`;
  return `<details class="limites-rapport"><summary>${phrase} <span class="plus">Ce que les données ne disent pas</span></summary>${detail}</details>`;
}

function tuile(valeur, libelle) {
  return `<div class="tuile"><span class="valeur">${valeur}</span><span class="libelle">${libelle}</span></div>`;
}

function lienPeriode(nAnciennes) {  // un clic pour l'historique complet, ou pour revenir à la période par défaut
  const premiere = Number(zone.premiere_annee);
  if (etat.depuis < debutRecent) return `<button type="button" class="lien-periode" data-depuis="${debutRecent}">N'afficher que les autorisations depuis ${debutRecent}</button>`;
  if (!nAnciennes) return "";
  const annees = etat.depuis - 1 > premiere ? `de ${premiere} à ${etat.depuis - 1}` : `de ${premiere}`;
  return `<button type="button" class="lien-periode" data-depuis="${premiere}">Afficher aussi ${nAnciennes > 1
    ? `les ${nombre.format(nAnciennes)} autorisations ${annees}` : "l'autorisation plus ancienne"}</button>`;
}

function autorisationsParcelle(id) {  // [autorisations de la période, récentes d'abord ; nombre d'autres écartées par la seule période]
  const ds = (parParcelle.get(id) || []).filter(d => etat.types.has(d.type));
  const liste = ds.filter(dansPeriode).sort(parDateDesc);
  return [liste, ds.length - liste.length];
}

function nombreAutorisations(liste, anciennes) {  // « 2 autorisations depuis 2021 », « Aucune autorisation depuis 2021 » ou « Aucune autorisation recensée »
  if (liste.length) return `${pluriel(liste.length, "autorisation")} depuis ${etat.depuis}`;
  return anciennes ? `Aucune autorisation depuis ${etat.depuis}` : "Aucune autorisation recensée";
}

const REGISTRE = new Set(["Numéro", "Références cadastrales"]);  // champs du registre, en chasse fixe

function detailsDossier(d) {  // toutes les informations du dossier, en liste de définitions
  const details = [
    ["Numéro", numeroDossier(d)],
    ["Type", TYPES[d.type]],
    ["Déposé en", d.annee_depot],
    ["Autorisé le", dateFr(d.date_autorisation)],
    ["Chantier ouvert le", dateFr(d.date_ouverture_chantier)],
    ["Achevé le", dateFr(d.date_achevement)],
    ["Références cadastrales", d.references_cadastrales],
    ["Superficie du terrain", d.superficie_terrain && `${nombre.format(d.superficie_terrain)} m²`],
    ["Logements créés", Number(d.nb_logements_crees) > 0 && `${d.nb_logements_crees}${d.type_logements ? ` (${d.type_logements})` : ""}`],
    ["Résidence", d.residence],
    ["Habitation créée", Number(d.surf_habitation_creee) > 0 && `${nombre.format(d.surf_habitation_creee)} m²`],
    ["Habitation démolie", Number(d.surf_habitation_demolie) > 0 && `${nombre.format(d.surf_habitation_demolie)} m²`],
    ["Autres surfaces créées", Number(d.surf_non_residentielle_creee) > 0 && `${nombre.format(d.surf_non_residentielle_creee)} m²`],
    ["Autres surfaces démolies", Number(d.surf_non_residentielle_demolie) > 0 && `${nombre.format(d.surf_non_residentielle_demolie)} m²`],
  ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd${REGISTRE.has(k) ? ` class="mono"` : ""}>${esc(v)}</dd>`).join("");
  const demandeur = d.demandeur ? `<dt>Demandeur</dt><dd>${esc(d.demandeur)}${d.siren
    ? ` (<a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${esc(d.siren)}" target="_blank" rel="noopener">SIREN ${esc(d.siren)}</a>)` : ""}</dd>` : "";
  return details + demandeur;
}

function htmlDossier(d, {distance = null, origine = ""} = {}) {  // ligne dépliable : vue parcelle et impression
  const approx = d.localisation === "voie" ? "≈ " : "";
  const ligne = [dateFr(d.date_autorisation), d.etat].filter(Boolean).join(" · ");
  return `<li class="dossier${d.etat === "annulé" ? " annule" : ""}" data-id="${esc(d.id)}"><details><summary>
      ${sigleType(d.type, "type")}
      <span class="ligne1">${esc(ligne)}</span>
      <span class="distance">${distance === null ? "" : `${approx}${nombre.format(Math.round(distance))} m`}</span>
      <span class="adresse">${esc(adresseLisible(d.adresse || "Adresse non renseignée"))}</span>
      <span class="projet">${esc([projet(d), d.demandeur].filter(Boolean).join(" · "))}</span>
      ${origine ? `<span class="origine">${esc(origine)}</span>` : ""}
    </summary><dl>${detailsDossier(d)}</dl></details></li>`;
}

function listeDossiers(liste, options = () => ({})) {
  if (!liste.length) return `<p class="vide">Aucune autorisation avec les filtres actuels.</p>`;
  return `<ul class="dossiers">${liste.map(d => htmlDossier(d, options(d))).join("")}</ul>`;
}

function grouperParAdresse(liste, distances) {  // [adresse, dossiers récents d'abord, distance du plus proche], du plus proche au plus lointain
  const groupes = new Map();
  for (const d of liste) {
    const cle = (d.adresse || "Adresse non renseignée").toUpperCase().replace(/\s+/g, " ");
    groupes.set(cle, [...(groupes.get(cle) || []), d]);
  }
  return [...groupes].map(([adresse, ds]) => [adresse, ds.sort(parDateDesc), Math.min(...ds.map(d => distances.get(d.id)))])
    .sort((a, b) => a[2] - b[2]);
}

function enteteGroupe(adresse, ds, proche, lisible = false) {
  return `<span>${esc(lisible ? adresseLisible(adresse) : adresse)}</span><span class="distance">${ds.some(d => d.localisation === "voie") ? "≈ " : ""}${nombre.format(Math.round(proche))} m · ${pluriel(ds.length, "autorisation")}</span>`;
}

function parAdresse(liste, distances) {  // version imprimable
  if (!liste.length) return `<p class="vide">Aucune autorisation avec les filtres actuels.</p>`;
  return grouperParAdresse(liste, distances).map(([adresse, ds, proche]) => `
    <section class="groupe"><h4>${enteteGroupe(adresse, ds, proche, true)}</h4>${listeDossiers(ds)}</section>`).join("");
}

/* Liste compacte du rapport : une ligne par dossier ; la sélection surligne ses parcelles et ouvre la fiche */

const MOTS_MINUSCULES = new Set(["de", "du", "des", "la", "le", "les", "et", "à", "au", "aux", "sur", "sous", "en",
  "rue", "avenue", "av", "boulevard", "bd", "place", "allée", "allee", "impasse", "chemin", "passage", "sentier", "sente",
  "villa", "cité", "cite", "square", "quai", "cours", "cour", "route", "voie", "ruelle", "hameau", "résidence", "residence", "parvis"]);

function adresseLisible(a) {  // SITADEL écrit en capitales : « 66 RUE DE LAGNY » -> « 66 rue de Lagny »
  if (!a || a !== a.toUpperCase()) return a || "";
  const s = a.toLowerCase().split(/\s+/).map(m => MOTS_MINUSCULES.has(m) ? m : m.replace(/\p{L}+/gu, (lettres, i) => {
    if (/\d/.test(m[i - 1] || "")) return lettres;                          // 27bis
    if (/^[ld]$/.test(lettres) && /['’]/.test(m[i + 1] || "")) return lettres;  // élision : l', d'
    return lettres[0].toUpperCase() + lettres.slice(1);
  })).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function chiffresDossier(d, court = false) {  // « 114 logements créés · 8 476 m² créés » ; en court : « 114 logements · … »
  const logements = Number(d.nb_logements_crees || 0), creee = surfaceCreee(d), demolie = surfaceDemolie(d);
  return [logements > 0 && (court ? pluriel(logements, "logement") : pluriel(logements, "logement créé", "logements créés")),
    creee > 0 && `${nombre.format(creee)} m² créés`, demolie > 0 && `${nombre.format(demolie)} m² démolis`].filter(Boolean).join(" · ");
}

function decisionDossier(d, courte = false) {  // « autorisé le 3 oct. 2019 · terminé » ; en court : « oct. 2019 · terminé »
  const date = d.date_autorisation && new Date(`${d.date_autorisation}T12:00:00`);
  const decision = !date ? "" : courte ? formatMoisCourt.format(date)
    : `${d.type === "DP" ? "non-opposition le" : "autorisé le"} ${dateFr(d.date_autorisation)}`;
  return [decision, d.etat !== "autorisé" && d.etat].filter(Boolean).join(" · ");
}

function registreDossier(d) {  // n° de dossier et parcelles actuelles
  const ps = d.actuelles.map(nomParcelle);
  const parcelles = ps.length ? `${ps.length > 1 ? "Parcelles" : "Parcelle"} ${ps.slice(0, 4).join(", ")}${ps.length > 4 ? ` +${ps.length - 4}` : ""}` : "";
  return `<span>${esc(numeroDossier(d))}</span>${parcelles ? `<span>${esc(parcelles)}</span>` : ""}`;
}

function valeursADroite(d, distance) {  // [ligne 1, ligne 2] à droite de la ligne : la grandeur du tri en cours
  if (etat.tri === "date") return [annee(d.date_autorisation), ""];
  if (etat.tri === "ampleur") {
    const creee = surfaceCreee(d), demolie = surfaceDemolie(d), logements = Number(d.nb_logements_crees || 0);
    return [creee > 0 ? `${nombre.format(creee)} m²` : demolie > 0 ? `−${nombre.format(demolie)} m²` : "–",
      logements > 0 ? pluriel(logements, "logement") : ""];
  }
  return [distance === null ? "" : `${d.localisation === "voie" ? "≈ " : ""}${nombre.format(Math.round(distance))} m`, ""];
}

function htmlLigneDossier(d, distance = null, sansAdresse = false, origine = "") {
  const [droite1, droite2] = valeursADroite(d, distance);
  const chiffres = etat.tri !== "ampleur" ? chiffresDossier(d, true)  // en tri par ampleur, surface et logements sont déjà à droite
    : surfaceCreee(d) > 0 && surfaceDemolie(d) > 0 ? `${nombre.format(surfaceDemolie(d))} m² démolis` : "";
  const ligne2 = [!sansAdresse && adresseLisible(d.adresse || "Adresse non renseignée"), decisionDossier(d, true)].filter(Boolean).join(" · ");
  const titreDroite = etat.tri === "ampleur" && surfaceCreee(d) === 0 && surfaceDemolie(d) > 0 ? ` title="Surface démolie"` : "";
  return `<li><button type="button" class="ligne-dossier${d.etat === "annulé" ? " annule" : ""}" data-id="${esc(d.id)}" aria-pressed="${d.id === etat.surligne}">
    ${sigleType(d.type)}
    <span class="l1"><span class="titre-dossier">${esc(projet(d).split(" · ")[0] || TYPES[d.type])}</span>${chiffres ? `<span class="detail"> · ${esc(chiffres)}</span>` : ""}</span>
    <span class="droite"${titreDroite}>${esc(droite1)}</span>
    <span class="l2">${esc(ligne2)}</span>
    <span class="droite-2">${esc(droite2)}</span>
    ${origine ? `<span class="l3">${esc(origine)}</span>` : ""}
  </button></li>`;
}

function lignes(liste, distance = () => null, sansAdresse = false, origine = () => "") {  // origine : déposée sous un ancien numéro…
  return `<ul class="liste-dossiers">${liste.map(d => htmlLigneDossier(d, distance(d), sansAdresse, origine(d))).join("")}</ul>`;
}

function htmlFiche(d) {  // fiche du dossier sélectionné, en surimpression sur la carte
  const dist = etat.resultat?.dansRayon.get(d.id), chiffres = chiffresDossier(d);
  const decision = decisionDossier(d), quand = [decision.charAt(0).toUpperCase() + decision.slice(1), d.demandeur].filter(Boolean).join(" · ");
  const ou = etat.resultat?.surParcelle.has(d.id) ? "sur la parcelle"  // pas « à 4 m » : la distance va du point de l'adresse, sur la voie
    : dist === undefined ? "" : `à ${d.localisation === "voie" ? "≈ " : ""}${nombre.format(Math.round(dist))} m`;
  return `
    ${etat.retourParcelle ? `<button type="button" class="retour" data-action="retour-parcelle">← Parcelle ${nomParcelle(etat.retourParcelle)}</button>` : ""}
    <div class="fiche-haut">
      <span class="badge" data-type="${d.type}" aria-hidden="true">${d.type}</span>
      <span class="type-fiche">${esc(TYPES[d.type])}${ou ? `<span class="distance"> · ${ou}</span>` : ""}</span>
      <button type="button" class="fermer" data-action="fermer-fiche" aria-label="Fermer la fiche">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
      </button>
    </div>
    <p class="titre-dossier${d.etat === "annulé" ? " annule" : ""}">${esc(projet(d).split(" · ")[0] || TYPES[d.type])}</p>
    ${chiffres ? `<p class="detail">${esc(chiffres)}</p>` : ""}
    <p class="adresse">${esc(adresseLisible(d.adresse || "Adresse non renseignée"))}</p>
    <p class="quand">${esc(quand)}</p>
    <p class="registre">${registreDossier(d)}</p>
    <details><summary>Toutes les informations</summary><dl>${detailsDossier(d)}</dl></details>
    ${carteVisible() ? "" : `<button type="button" class="action" data-action="voir-carte">Voir sur la carte</button>`}`;
}

function htmlFicheParcelle(id) {  // fiche de la parcelle cliquée sur la carte : la liste et le cadrage ne changent pas
  const p = toutes.get(id), [liste, anciennes] = autorisationsParcelle(id);
  const {logements, surface} = totaux(liste);
  const bilan = [nombreAutorisations(liste, anciennes), logements > 0 && pluriel(logements, "logement créé", "logements créés"),
    surface > 0 && `${nombre.format(surface)} m² créés`].filter(Boolean).join(" · ");
  return `
    <div class="fiche-haut">
      <p class="titre-dossier">Parcelle ${nomParcelle(id)}</p>
      <button type="button" class="fermer" data-action="fermer-fiche" aria-label="Fermer la fiche">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
      </button>
    </div>
    <p class="detail">${p.contenance ? `${nombre.format(p.contenance)} m² · ` : ""}<span class="mono">${id}</span></p>
    ${notePredecesseurs(id)}
    <p class="bilan">${esc(bilan)}</p>
    ${liste.length ? lignes(liste, () => null, false, d => origineDans(d, id)) : ""}
    ${lienPeriode(anciennes)}
    <button type="button" class="action" data-action="rayon-parcelle">Autorisations dans un rayon de ${etat.rayon} m</button>`;
}

/* ---------- Vues : toute la commune, une parcelle, un rapport dans un rayon ---------- */

function listeCommunes() {  // communes couvertes, par département : chacune ouvre sa carte
  return Object.entries(zone.departements).map(([dep, nom]) => `
    <h3>${esc(nom)}</h3>
    <ul class="liste-communes">${zone.communes.filter(c => c.departement === dep)
      .map(c => `<li><a href="#explorer=${c.insee}">${esc(c.commune)}</a></li>`).join("")}</ul>`).join("");
}

function vueZone() {  // aucune commune choisie : la liste, et la carte des contours
  return `
    <h2>Choisissez une commune</h2>
    <p>Cliquez sur une commune de la carte ou de la liste, ou cherchez une adresse pour voir les autorisations d'un rayon autour.</p>
    ${listeCommunes()}`;
}

function vueCommune(insee) {  // carte de toute la commune, sans adresse
  const c = infoCommune.get(insee);
  if (!c) return vueZone();
  const ds = dossiers.filter(d => d.insee === insee), visibles = ds.filter(visible);
  const {logements, surface} = totaux(visibles);
  const parType = Object.keys(TYPES).map(t => [t, visibles.filter(d => d.type === t).length]).filter(([, n]) => n);
  const nonLocalises = ds.filter(d => d.localisation === "aucune").sort(parDateDesc), n = nonLocalises.length;
  return `
    <button class="retour" data-action="zone">← Toutes les communes</button>
    <h2>${esc(c.commune)}</h2>
    <p>Cliquez sur une parcelle de la carte pour voir ses autorisations, y compris celles déposées sous d'anciens numéros,
       ou cherchez une adresse pour voir celles d'un rayon autour.</p>
    ${noteDebut([insee], true)}
    <div class="chiffres">
      ${tuile(nombre.format(visibles.length), `autorisations accordées depuis ${etat.depuis}`)}
      ${tuile(nombre.format(logements), "logements créés")}
      ${tuile(milliers(surface), "m² de surface de plancher créés")}
    </div>
    <p class="precision-chiffres">${parType.map(([t, n]) => `${nombre.format(n)} ${nomType(t, n)}`).join(" · ")}.
      Logements et surfaces hors autorisations annulées.</p>
    ${lienPeriode(ds.filter(d => etat.types.has(d.type) && !dansPeriode(d)).length)}
    ${legendeSigles()}
    ${n ? `<details class="non-localisees"><summary>${pluriel(n, "autorisation n'a", "autorisations n'ont")} pas pu être
      placée${n > 1 ? "s" : ""} sur la carte (ni adresse exploitable, ni parcelle retrouvée)</summary>${listeDossiers(nonLocalises)}</details>` : ""}
    <p class="note"><a href="#donnees">Ce que contiennent les données, et ce qu'elles ne contiennent pas</a></p>`;
}

function remplirAccueil() {  // chiffres et dates de l'accueil, lus dans l'index des communes
  const n = zone.non_localises, fiables = zone.communes.filter(c => c.debut_fiable)
    .sort((a, b) => a.debut_fiable - b.debut_fiable || a.commune.localeCompare(b.commune));
  const info = {
    premiere_annee: zone.premiere_annee,
    communes: nombre.format(zone.communes.length),
    sitadel: moisFr(zone.sitadel),
    cadastre: moisFr(zone.cadastre),
    genere: dateFr(zone.genere),
    bilan: `${pluriel(zone.dossiers, "autorisation accordée", "autorisations accordées")} depuis ${zone.premiere_annee}
      dans ${zone.communes.length} communes, ${pluriel(zone.logements, "logement créé", "logements créés")}
      et ${milliers(zone.surface)} m² de surface de plancher créés.`,
    "non-localisees": `${pluriel(n, "autorisation n'a", "autorisations n'ont")} pas pu être placée${n > 1 ? "s" : ""} sur la carte
      (ni adresse exploitable, ni parcelle retrouvée) : elles sont listées sur la page de chaque commune.`,
    "debut-fiable": `Dans ${fiables.length} communes, les autorisations ne sont recensées qu'à partir d'une année récente, les numéros
      de parcelle de SITADEL étant erronés avant : ${fiables.map(c => `${c.commune} depuis ${c.debut_fiable}`).join(", ")}.`,
  };
  document.querySelectorAll("[data-info]").forEach(el => { if (el.dataset.info in info) el.textContent = info[el.dataset.info]; });
}

function origineDans(d, idParcelle) {
  if (d.parcelles.includes(idParcelle)) return "";
  const ancienne = d.parcelles.find(p => (predecesseurs.get(idParcelle) || []).includes(p));
  if (ancienne) return `Déposée sous l'ancienne parcelle ${nomParcelle(ancienne)}`;
  if (d.localisation === "adresse") return "Rattachée par son adresse (pas de référence cadastrale exploitable)";
  return "";
}

function notePredecesseurs(id) {  // vue et fiche de la parcelle : anciens numéros, dont les autorisations sont incluses
  const preds = (predecesseurs.get(id) || []).filter(a => toutes.has(a))
    .map(a => `${nomParcelle(a)} (au cadastre de ${annee(toutes.get(a).premier)} à ${annee(toutes.get(a).dernier)})`);
  return preds.length ? `<p class="note">Issue d'une division ou d'une fusion : ${preds.join(", ")}. Les autorisations
      déposées sous ${preds.length > 1 ? "ces anciens numéros" : "cet ancien numéro"} sont incluses.</p>` : "";
}

function vueParcelle(id) {
  const p = toutes.get(id), [liste, anciennes] = autorisationsParcelle(id);
  const {logements, surface} = totaux(liste);
  return `
    <button class="retour" data-action="commune">← Toute la commune</button>
    <h2>Parcelle ${nomParcelle(id)}</h2>
    <p class="sous-titre">${p.contenance ? `${nombre.format(p.contenance)} m² · ` : ""}<span class="mono">${id}</span></p>
    ${notePredecesseurs(id)}
    ${liste.length ? `<div class="chiffres">
      ${tuile(nombre.format(liste.length), liste.length > 1 ? "autorisations" : "autorisation")}
      ${tuile(nombre.format(logements), "logements créés")}
      ${tuile(nombre.format(surface), "m² créés")}
    </div>` : ""}
    <div class="actions">
      <button class="action" data-action="rayon-parcelle">Autorisations dans un rayon de ${etat.rayon} m</button>
    </div>
    ${legendeSigles()}
    <h3>${liste.length ? `Autorisations sur cette parcelle depuis ${etat.depuis}` : `${nombreAutorisations(liste, anciennes)} sur cette parcelle`}</h3>
    ${liste.length ? listeDossiers(liste, d => ({origine: origineDans(d, id)})) : ""}
    ${lienPeriode(anciennes)}`;
}

function autourDe(v) {
  if (v.precision === "parcelle") return `Autour de la parcelle ${v.libelle.replace(/^Parcelle /, "")}`;
  if (v.libelle === "Point choisi") return "Autour du point choisi";
  return v.precision === "housenumber" ? `Autour du ${v.libelle}` : `Autour de : ${v.libelle}`;
}

function vueRapport(v) {  // écran : synthèse et cartes de dossier ; impression : version groupée par adresse, inchangée
  const res = etat.resultat = rechercher(v.lon, v.lat, etat.rayon);
  const enRayon = [...res.dansRayon.keys()].map(id => parId.get(id)).sort(parDateDesc);
  const surParcelle = [...res.surParcelle].map(id => parId.get(id)).filter(visible).sort(parDateDesc);
  const voisines = [...res.voisines].map(id => parId.get(id)).sort(parDateDesc);
  const {logements, surface} = totaux(enRayon);
  const parcellesAuPoint = res.auPoint.filter(p => toutes.get(p).actuelle).map(nomParcelle);
  const anciennesAuPoint = res.auPoint.filter(p => !toutes.get(p).actuelle).map(nomParcelle);
  const precision = {housenumber: "Adresse localisée au numéro.", street: "Position approximative : centre de la voie.",
    parcelle: "Centre de la parcelle."}[v.precision] || "Position approximative.";
  const localisation = `${precision}${res.rapproche ? ` Point de l'adresse à ${nombre.format(Math.round(res.rapproche))} m de la parcelle la plus proche, sur la voie.` : ""}`;
  const filtres = `Depuis ${etat.depuis}${etat.types.size < 4 ? `, ${[...etat.types].join(", ")} seulement` : ""}. Logements et surfaces hors autorisations annulées.`;
  const approximative = !["housenumber", "parcelle"].includes(v.precision) ? `<p class="alerte">${precision} Les distances sont indicatives.</p>` : "";
  const departements = Object.values(zone.departements).join(" et ");
  const bord = horsZone(v.lon, v.lat, etat.rayon);
  const horsCommune = (bord === "adresse"
    ? `<p class="alerte">Adresse hors de la zone couverte (${esc(departements)}) : seules les autorisations de ces départements sont prises en compte.</p>`
    : bord === "rayon" ? `<p class="alerte">Une partie du rayon sort de la zone couverte (${esc(departements)}) : les autorisations au-delà ne sont pas recensées.</p>`
    : "") + noteDebut(communesAutour(v.lon, v.lat, etat.rayon));
  const titreParcelle = `Sur la parcelle${parcellesAuPoint.length > 1 ? "s" : ""} ${parcellesAuPoint.join(", ")}${anciennesAuPoint.length
    ? ` <span class="note">(et ancienne${anciennesAuPoint.length > 1 ? "s" : ""} ${anciennesAuPoint.join(", ")})</span>` : ""}`;
  const distance = d => res.dansRayon.get(d.id) ?? null;
  const notePied = `≈ : autorisation localisée à la rue seulement. Distances mesurées jusqu'au contour des parcelles.
      Données SITADEL de ${moisFr(zone.sitadel)}.`;
  const typesMasques = etat.types.size < Object.keys(TYPES).length;

  let liste;
  if (!enRayon.length) liste = `<p class="vide-bloc">Élargissez le rayon ou la période${typesMasques ? ", ou réaffichez les types masqués" : ""}.</p>`;
  else if (etat.tri === "distance") liste = grouperParAdresse(enRayon, res.dansRayon).map(([adresse, ds, proche]) => `
      <section class="groupe-adresse"><h3>${enteteGroupe(adresse, ds, proche, true)}</h3>${lignes(ds, distance, true)}</section>`).join("");
  else liste = lignes([...enRayon].sort(TRIS[etat.tri].ordre), distance);

  const ecran = `
    <div class="resume">
      <button class="retour" data-action="commune">← Toute la commune</button>
      <p class="surtitre">${esc(autourDe(v))}</p>
      <h1 class="synthese">${enRayon.length ? pluriel(enRayon.length, "autorisation") : "Aucune autorisation"} depuis ${etat.depuis} à moins de ${etat.rayon}&nbsp;m</h1>
      ${lienPeriode(res.plusAnciennes)}
      ${limitesRapport(enRayon.length)}
      ${approximative}${horsCommune}
      <details class="menu-rapport">
        <summary>Éditer un rapport</summary>
        <div class="menu">
          <button type="button" data-action="imprimer">PDF : imprimer ou enregistrer</button>
          <button type="button" data-action="csv">Tableau des autorisations (CSV)</button>
          <button type="button" data-action="lien">Copier le lien de cette page</button>
        </div>
      </details>
      ${legendeSigles()}
    </div>
    <section class="bloc">
      <h2>${esc(v.libelle)}</h2>
      ${!res.auPoint.length ? `<p class="vide">Aucune parcelle à moins de ${TOLERANCE_VOIE} m de ce point.</p>`
        : surParcelle.length ? lignes(surParcelle)
        : `<p class="vide">Aucune autorisation sur cette parcelle depuis ${etat.depuis}${typesMasques ? " pour les types affichés" : ""}.</p>`}
    </section>
    ${voisines.length ? `<section class="bloc"><h2>Sur les parcelles voisines <span class="note">(moins de ${VOISINAGE} m)</span></h2>${lignes(voisines, distance)}</section>` : ""}
    <section class="bloc">
      <div class="tri-barre">
        <h2>Dans le rayon de ${etat.rayon} m</h2>
        <div class="tri">
          <span id="lbl-tri">Trier par</span>
          <div class="segmente" role="group" aria-labelledby="lbl-tri">
            ${Object.entries(TRIS).map(([k, t]) => `<button type="button" data-tri="${k}" aria-pressed="${k === etat.tri}">${t.libelle}</button>`).join("")}
          </div>
          <span class="aide">${TRIS[etat.tri].aide}</span>
        </div>
      </div>
      ${liste}
    </section>
    <p class="note pied-rapport">${notePied}</p>`;

  const imprimable = `
    <h2>${esc(v.libelle)}</h2>
    <p class="sous-titre">${localisation}</p>
    ${horsCommune}
    <div class="chiffres">
      ${tuile(nombre.format(enRayon.length), `autorisation${enRayon.length > 1 ? "s" : ""} à moins de ${etat.rayon} m`)}
      ${tuile(nombre.format(logements), "logements créés")}
      ${tuile(nombre.format(surface), "m² de surface de plancher créés")}
    </div>
    <p class="precision-chiffres">${filtres}</p>
    ${limitesRapport(enRayon.length, true)}
    ${legendeSigles(false)}
    <img class="impression-seule" id="carte-impression" alt="Carte : adresse recherchée et rayon de ${etat.rayon} m">
    <h3>${titreParcelle}</h3>
    ${res.auPoint.length ? listeDossiers(surParcelle) : `<p class="vide">Aucune parcelle à moins de ${TOLERANCE_VOIE} m de ce point.</p>`}
    ${voisines.length ? `<h3>Sur les parcelles voisines <span class="note">(moins de ${VOISINAGE} m)</span></h3>${listeDossiers(voisines, d => ({distance: distance(d)}))}` : ""}
    <h3>Dans un rayon de ${etat.rayon} m, par adresse</h3>
    ${parAdresse(enRayon, res.dansRayon)}
    <p class="note">${notePied}</p>`;

  return `<div class="ecran-seul">${ecran}</div><div class="version-imprimable">${imprimable}</div>`;
}

function rendre() {
  const v = etat.vue;
  if (v.mode === "parcelle" && !toutes.has(v.id)) etat.vue = {mode: "commune", insee: v.id.slice(0, 5)};
  etat.resultat = null;
  etat.surligne = etat.survol = etat.pointee = etat.parcelle = etat.retourParcelle = null;
  document.getElementById("vue").innerHTML = etat.vue.mode === "commune" ? vueCommune(etat.vue.insee)
    : etat.vue.mode === "parcelle" ? vueParcelle(etat.vue.id) : vueRapport(etat.vue);
  rendreFiltres();
  majFiche();
  annoncer(annonceVue());
  if (cartePrete) majCarte();
}

/* ---------- Barre de filtres : types (avec leur nombre dans la vue), rayon, période ---------- */

function rendreFiltres() {  // les types se choisissent dans la légende des sigles, en tête de la liste
  const res = etat.resultat;
  document.getElementById("filtre-rayon").hidden = !res;
  document.getElementById("rayons").innerHTML = RAYONS.map(r =>
    `<button type="button" data-rayon="${r}" aria-pressed="${r === etat.rayon}">${r} m</button>`).join("");
}

function initFiltres() {
  const premiere = Number(zone.premiere_annee), derniere = Number(zone.derniere_annee);
  const choix = document.getElementById("filtre-depuis");
  for (let a = premiere; a <= derniere; a++) choix.add(new Option(String(a), String(a)));
  debutRecent = Math.max(premiere, derniere - ANS_RECENTS);
  etat.depuis = debutRecent;
  choix.value = String(debutRecent);
  choix.addEventListener("change", () => changerPeriode(Number(choix.value)));
  document.getElementById("filtres").addEventListener("click", e => {
    const rayon = e.target.closest("[data-rayon]");
    if (rayon) {
      etat.rayon = Number(rayon.dataset.rayon);
      const v = etat.vue;
      rapportAutourDe(v.lon, v.lat, v.libelle, v.precision, v.commune);
    }
  });
}

function changerPeriode(a) {  // sélecteur « Depuis » ou lien de période ; la fiche de parcelle ouverte le reste
  const parcelle = etat.parcelle;
  etat.depuis = a;
  document.getElementById("filtre-depuis").value = String(a);
  rendre();
  if (parcelle) ouvrirParcelle(parcelle);
}

/* ---------- Affichage : liste + carte, liste seule, carte seule ---------- */

const carteVisible = () => etat.affichage === "carte" || (etat.affichage === "split" && !PETIT_ECRAN.matches);

function choisirAffichage(a) {
  etat.affichage = a;
  const appli = document.getElementById("appli");
  appli.classList.remove("vue-split", "vue-liste", "vue-carte");
  appli.classList.add(`vue-${a}`);
  document.querySelectorAll("[data-affichage]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.affichage === a)));
  if (a === "carte" && PETIT_ECRAN.matches) window.scrollTo(0, 0);
  majFiche();
  if (carte) requestAnimationFrame(() => {  // nouvelle taille : cadrer sur le rayon, ou sur le dossier sélectionné
    carte.resize();
    if (!cartePrete) return;
    if (etat.surligne && etat.vue?.mode === "rapport" && carteVisible()) montrerSurCarte(parId.get(etat.surligne), true);
    else cadrer();
  });
}

function initAffichage() {  // sur petit écran, la liste d'abord ; la carte s'ouvre par le sélecteur
  let impose = PETIT_ECRAN.matches;  // « Liste » imposée par la largeur : « Liste + carte » revient quand la fenêtre s'élargit
  choisirAffichage(impose ? "liste" : "split");
  document.querySelector(".affichage").addEventListener("click", e => {
    const b = e.target.closest("[data-affichage]");
    if (b) { impose = false; choisirAffichage(b.dataset.affichage); }
  });
  PETIT_ECRAN.addEventListener("change", e => {
    if (e.matches && etat.affichage === "split") { impose = true; choisirAffichage("liste"); }
    else if (!e.matches && impose && etat.affichage === "liste") { impose = false; choisirAffichage("split"); }
  });
}

/* ---------- Carte ---------- */

function majCarte() {
  const v = etat.vue, res = etat.resultat;
  const avecAutorisation = res ? [...new Set([...res.dansRayon.keys()].flatMap(id => parId.get(id).actuelles))] : [];
  carte.setFilter("parcelles-autorisations", ["in", ["get", "id"], ["literal", avecAutorisation]]);
  let choisies = [], anciennesChoisies = [];
  if (v?.mode === "parcelle") { choisies = [v.id]; anciennesChoisies = predecesseurs.get(v.id) || []; }
  if (res) {
    choisies = res.auPoint.filter(p => toutes.get(p).actuelle);
    anciennesChoisies = res.auPoint.filter(p => !toutes.get(p).actuelle);
  }
  carte.setFilter("parcelles-choix", ["in", ["get", "id"], ["literal", choisies]]);
  carte.setFilter("anciennes-choix", ["in", ["get", "id"], ["literal", anciennesChoisies]]);
  carte.setFilter("parcelle-pointee", ["==", ["get", "id"], ""]);
  carte.getSource("rayon").setData({type: "FeatureCollection", features: res ? [cercle(v.lon, v.lat, etat.rayon)] : []});
  if (res) (marqueur ||= new maplibregl.Marker({color: ENCRE, scale: .8})).setLngLat([v.lon, v.lat]).addTo(carte);
  else marqueur?.remove();
  majLegende(anciennesChoisies.length > 0);
  appliquerSurlignage();
}

function majLegende(anciennes) {  // seulement ce qui peut apparaître sur la carte dans la vue actuelle
  const v = etat.vue, res = etat.resultat, lignes = [];
  if (res) lignes.push(["autorisee", `Parcelle avec au moins une autorisation depuis ${etat.depuis}`], ["rayon", `Rayon de ${etat.rayon} m`],
    ["choix", "Adresse et parcelle choisies"]);
  if (v?.mode === "parcelle") lignes.push(["choix", "Parcelle choisie"]);
  if (anciennes) lignes.push(["ancienne", "Ancienne parcelle"]);
  if (res || v?.mode === "parcelle") lignes.push(["surlignee", "Autorisation sélectionnée dans la liste"]);
  const legende = document.getElementById("legende");
  legende.innerHTML = lignes.map(([c, t]) => `<p class="${c}"><i></i>${t}</p>`).join("");
  legende.hidden = !lignes.length;
}

function appliquerSurlignage() {  // parcelles des autorisations sélectionnée et survolée, ou leur point si localisées par l'adresse
  document.querySelectorAll("#vue [data-id]").forEach(el => {
    const choisi = el.dataset.id === etat.surligne;
    if (el.classList.contains("ligne-dossier")) el.setAttribute("aria-pressed", String(choisi));
    else el.classList.toggle("surlignee", choisi);
  });
  if (!cartePrete) return;
  const ds = [...new Set([etat.surligne, etat.survol])].filter(Boolean).map(id => parId.get(id));
  const ids = [...new Set(ds.flatMap(d => d.actuelles))];
  carte.setFilter("surlignage-fond", ["in", ["get", "id"], ["literal", ids]]);
  carte.setFilter("surlignage-contour", ["in", ["get", "id"], ["literal", ids]]);
  carte.getSource("surlignage-point").setData({type: "FeatureCollection", features: ds.filter(d => !d.actuelles.length && d.lon !== null)
    .map(d => ({type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [d.lon, d.lat]}}))});
}

function selectionner(id, depuisParcelle = null) {  // clic sur une ligne d'autorisation : sélection, ou désélection si elle l'était déjà
  etat.surligne = etat.surligne === id ? null : id;
  etat.retourParcelle = etat.surligne ? depuisParcelle : null;
  if (etat.surligne) etat.parcelle = null;  // une seule fiche à la fois
  appliquerSurlignage();
  majFiche();
  if (etat.surligne) montrerSurCarte(parId.get(etat.surligne));
}

function ouvrirParcelle(id) {  // clic sur une parcelle de la carte : sa fiche, sans zoom ni changement de liste ; un second clic la ferme
  etat.parcelle = id && id !== etat.parcelle ? id : null;
  etat.retourParcelle = null;
  if (etat.parcelle) etat.surligne = null;
  appliquerSurlignage();
  majFiche();
  if (etat.parcelle) montrerEmprises([toutes.get(etat.parcelle).emprise]);
}

function montrerSurCarte(d, forcer = false) {  // parcelles du dossier, ou son point s'il n'est localisé que par l'adresse
  const bornes = d.actuelles.map(p => toutes.get(p)?.emprise).filter(Boolean);
  if (!bornes.length && d.lon !== null) bornes.push([d.lon, d.lat, d.lon, d.lat]);
  montrerEmprises(bornes, forcer);
}

function montrerEmprises(bornes, forcer = false) {  // fait glisser la carte si ces emprises sont cachées par la fiche ou hors champ
  if (!cartePrete || !carteVisible() || !bornes.length) return;
  const b = [Math.min(...bornes.map(e => e[0])), Math.min(...bornes.map(e => e[1])), Math.max(...bornes.map(e => e[2])), Math.max(...bornes.map(e => e[3]))];
  const zone = carte.getContainer().getBoundingClientRect(), fiche = document.getElementById("fiche").getBoundingClientRect();
  const [p0, p1] = [carte.project([b[0], b[3]]), carte.project([b[2], b[1]])];  // coins haut-gauche et bas-droit, en pixels
  const f = {x0: fiche.left - zone.left - 16, y0: fiche.top - zone.top - 16, x1: fiche.right - zone.left, y1: fiche.bottom - zone.top};
  const cachee = fiche.height > 0 && p1.x > f.x0 && p0.x < f.x1 && p1.y > f.y0 && p0.y < f.y1;
  if (!forcer && !cachee && p0.x >= 40 && p0.y >= 40 && p1.x <= zone.width - 56 && p1.y <= zone.height - 40) return;
  const marges = {top: 40, right: 56, bottom: 40, left: 40};
  if (fiche.height > 0 && f.y0 < zone.height && f.x0 < zone.width) {  // la fiche couvre le coin bas-droit : cadrer au-dessus, ou à sa gauche si elle est haute
    if (f.y0 * zone.width >= f.x0 * zone.height) marges.bottom = zone.height - f.y0;
    else marges.right = zone.width - f.x0;
  }
  carte.fitBounds([[b[0], b[1]], [b[2], b[3]]], {padding: marges, maxZoom: forcer ? 17 : carte.getZoom(), duration: 500});
}

function majFiche() {  // fiche de la parcelle cliquée sur la carte, sinon de l'autorisation sélectionnée dans la liste du rapport
  const fiche = document.getElementById("fiche");
  const d = etat.surligne && (etat.vue?.mode === "rapport" || etat.retourParcelle) ? parId.get(etat.surligne) : null;
  fiche.hidden = !etat.parcelle && !d;
  fiche.innerHTML = etat.parcelle ? htmlFicheParcelle(etat.parcelle) : d ? htmlFiche(d) : "";
  fiche.setAttribute("aria-label", etat.parcelle ? "Parcelle sélectionnée" : "Autorisation sélectionnée");
  if (etat.parcelle) annoncer(`${fiche.querySelector(".titre-dossier").textContent} : ${fiche.querySelector(".bilan").textContent}`);
  else if (d) annoncer(`${TYPES[d.type]} : ${fiche.querySelector(".titre-dossier").textContent}`);
  if (cartePrete) carte.setFilter("parcelle-ouverte", ["==", ["get", "id"], etat.parcelle || ""]);
}

function fermerFiche() {  // bouton de fermeture ou Échap ; le focus revient à la ligne de l'autorisation
  const id = etat.surligne, focusDansFiche = document.getElementById("fiche").contains(document.activeElement);
  if (etat.parcelle) ouvrirParcelle(null);
  else if (id) selectionner(id);
  if (focusDansFiche && id) document.querySelector(`#vue .ligne-dossier[data-id="${CSS.escape(id)}"]`)?.focus();
}

const annoncer = texte => { document.getElementById("annonce").textContent = texte; };  // lu par les lecteurs d'écran

function annonceVue() {  // résumé de la vue, à la place de toute la liste
  const v = etat.vue;
  if (v.mode === "rapport") return document.querySelector("#vue .synthese")?.textContent ?? "";
  if (v.mode === "parcelle") return `Parcelle ${nomParcelle(v.id)} : ${nombreAutorisations(...autorisationsParcelle(v.id))}`;
  const c = infoCommune.get(v.insee);
  if (!c) return "Choisissez une commune";
  return `${c.commune} : ${pluriel(dossiers.filter(d => d.insee === v.insee && visible(d)).length, "autorisation")} depuis ${etat.depuis}`;
}

function pointerParcelle(id) {  // survol d'une parcelle sur la carte : ses autorisations du rayon mises en avant dans la liste
  if (id === etat.pointee) return;
  etat.pointee = id;
  const res = etat.resultat;
  const ids = id && res ? [...res.dansRayon.keys()].filter(d => parId.get(d).actuelles.includes(id)) : [];
  carte.setFilter("parcelle-pointee", ["==", ["get", "id"], ids.length ? id : ""]);
  const pointees = [...document.querySelectorAll("#vue [data-id]")].filter(el => {
    el.classList.toggle("pointee", ids.includes(el.dataset.id));
    return ids.includes(el.dataset.id) && el.offsetParent;
  });
  const liste = document.getElementById("panneau");  // la liste défile à côté de la carte (grand écran seulement)
  if (!pointees.length || liste.scrollHeight <= liste.clientHeight) return;
  const b = pointees[0].getBoundingClientRect(), cadre = liste.getBoundingClientRect();
  if (b.top < cadre.top || b.bottom > cadre.bottom) pointees[0].scrollIntoView({block: "center", behavior: "smooth"});
}

function cadrer() {
  const v = etat.vue;
  let b = (v?.mode === "commune" && infoCommune.get(v.insee)?.emprise) || zone.emprise, zoomMax = 16;
  if (v?.mode === "parcelle" && toutes.has(v.id)) { b = toutes.get(v.id).emprise; zoomMax = 18; }
  if (v?.mode === "rapport") b = emprise(cercle(v.lon, v.lat, etat.rayon).geometry);
  carte.fitBounds([[b[0], b[1]], [b[2], b[3]]], {padding: {top: 40, right: 56, bottom: 40, left: 40}, maxZoom: zoomMax, duration: 600});
}

class ControleFond {
  onAdd() {
    this.div = document.createElement("div");
    this.div.className = "maplibregl-ctrl maplibregl-ctrl-group fonds";
    this.div.innerHTML = `<button type="button" aria-pressed="true" data-fond="plan">Plan</button>`
      + `<button type="button" aria-pressed="false" data-fond="photo">Photo</button>`;
    this.div.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      etat.photo = b.dataset.fond === "photo";
      this.div.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      carte.setLayoutProperty("photo", "visibility", etat.photo ? "visible" : "none");
      carte.setPaintProperty("parcelles-autorisations", "fill-opacity", etat.photo ? .5 : .7);
      carte.setPaintProperty("parcelles-contour", "line-color", etat.photo ? "#ffffff" : "#8f8d86");
    });
    return this.div;
  }
  onRemove() { this.div.remove(); }
}

class ControleRecentrer {
  onAdd() {
    this.div = document.createElement("div");
    this.div.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.div.innerHTML = `<button type="button" aria-label="Recentrer" title="Recentrer">`
      + `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">`
      + `<circle cx="9" cy="9" r="4.5"/><path d="M9 1.5v3M9 13.5v3M1.5 9h3M13.5 9h3"/></svg></button>`;
    this.div.addEventListener("click", () => cadrer());
    return this.div;
  }
  onRemove() { this.div.remove(); }
}

const enVueZone = () => etat.vue?.mode === "commune" && !infoCommune.has(etat.vue.insee);  // aucune commune choisie

function initCarte() {
  carte = new maplibregl.Map({
    container: "carte", style: STYLE_PLAN, bounds: zone.emprise, fitBoundsOptions: {padding: 20},
    minZoom: 9, maxZoom: 19.5, attributionControl: false,
  });
  carte.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-right");
  carte.addControl(new ControleRecentrer(), "top-right");
  carte.addControl(new ControleFond(), "top-right");
  carte.addControl(new maplibregl.ScaleControl({unit: "metric"}), "bottom-left");
  carte.addControl(new maplibregl.AttributionControl({compact: true, customAttribution: "Cadastre DGFiP / Etalab · SITADEL SDES"}));

  carte.on("load", () => {
    const couches = carte.getStyle().layers;  // nos couches au-dessus du bâti du fond, sous ses derniers libellés
    const avant = couches.slice(couches.findLastIndex(l => l.type !== "symbol") + 1).find(l => l.type === "symbol")?.id;
    carte.addSource("photo", {type: "raster", tiles: [TUILES_PHOTO], tileSize: 256, maxzoom: 19, attribution: "IGN"});
    carte.addLayer({id: "photo", type: "raster", source: "photo", layout: {visibility: "none"}}, avant);
    carte.addSource("parcelles", {type: "geojson", data: geoParcelles, promoteId: "id"});
    carte.addSource("anciennes", {type: "geojson", data: geoAnciennes, promoteId: "id"});
    carte.addSource("rayon", {type: "geojson", data: {type: "FeatureCollection", features: []}});
    carte.addSource("communes", {type: "geojson", data: contours});
    carte.addLayer({id: "communes-contour", type: "line", source: "communes",  // limites des communes couvertes : le bord de zone se voit
      paint: {"line-color": "#3f4349", "line-opacity": .45, "line-width": ["interpolate", ["linear"], ["zoom"], 9, .8, 15, 1.6]}}, avant);
    carte.addLayer({id: "parcelles-clic", type: "fill", source: "parcelles", paint: {"fill-color": TRANSPARENT}}, avant);
    carte.addLayer({id: "parcelles-autorisations", type: "fill", source: "parcelles", filter: ["in", ["get", "id"], ["literal", []]],
      paint: {"fill-color": COULEUR_AUTORISATION, "fill-opacity": .7}}, avant);
    carte.addLayer({id: "parcelles-contour", type: "line", source: "parcelles", minzoom: 14.5,
      paint: {"line-color": "#8f8d86", "line-width": ["interpolate", ["linear"], ["zoom"], 14.5, .3, 18, 1]}}, avant);
    carte.addLayer({id: "rayon-fond", type: "fill", source: "rayon", paint: {"fill-color": ENCRE, "fill-opacity": .045}}, avant);
    carte.addLayer({id: "rayon-contour", type: "line", source: "rayon",
      paint: {"line-color": ENCRE, "line-opacity": .6, "line-width": 2, "line-dasharray": [3, 2]}}, avant);
    carte.addLayer({id: "surlignage-fond", type: "fill", source: "parcelles", filter: ["in", ["get", "id"], ["literal", []]],
      paint: {"fill-color": SURLIGNAGE, "fill-opacity": .95}}, avant);
    carte.addLayer({id: "surlignage-contour", type: "line", source: "parcelles", filter: ["in", ["get", "id"], ["literal", []]],
      paint: {"line-color": ENCRE, "line-width": 1.5}}, avant);
    carte.addSource("surlignage-point", {type: "geojson", data: {type: "FeatureCollection", features: []}});
    carte.addLayer({id: "surlignage-point", type: "circle", source: "surlignage-point",
      paint: {"circle-radius": 8, "circle-color": SURLIGNAGE, "circle-stroke-color": ENCRE, "circle-stroke-width": 1.5}});
    carte.addLayer({id: "anciennes-choix", type: "line", source: "anciennes", filter: ["in", ["get", "id"], ["literal", []]],
      paint: {"line-color": "#3f4349", "line-width": 1.5, "line-dasharray": [2, 1.5]}}, avant);
    carte.addLayer({id: "parcelles-choix", type: "line", source: "parcelles", filter: ["in", ["get", "id"], ["literal", []]],
      paint: {"line-color": ENCRE, "line-width": 3}}, avant);
    carte.addLayer({id: "parcelle-pointee", type: "line", source: "parcelles", filter: ["==", ["get", "id"], ""],
      paint: {"line-color": ENCRE, "line-width": 2.5}}, avant);
    carte.addLayer({id: "parcelle-ouverte", type: "line", source: "parcelles", filter: ["==", ["get", "id"], ""],
      paint: {"line-color": ENCRE, "line-width": 3}}, avant);
    carte.addSource("adresses", {type: "geojson", data: geoAdresses});
    carte.addLayer({id: "numeros", type: "symbol", source: "adresses", minzoom: 16.5,  // numéros de rue, pour se repérer
      layout: {"text-field": ["get", "n"], "text-font": ["Source Sans Pro Regular"], "text-size": 11.5},
      paint: {"text-color": "#3d3c39", "text-halo-color": "#ffffff", "text-halo-width": 1.4}});
    cartePrete = true;
    majCarte();
    cadrer();
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");  // sources repliées (bouton i)
  });

  infobulle = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px"});
  carte.on("mousemove", e => {  // carte de toutes les communes : nom de la commune survolée
    if (!enVueZone()) return;
    const c = infoCommune.get(communeAuPoint(e.lngLat.lng, e.lngLat.lat));
    carte.getCanvas().style.cursor = c ? "pointer" : "";
    if (c) infobulle.setLngLat(e.lngLat).setHTML(`<strong>${esc(c.commune)}</strong><br>Cliquer pour voir la commune`).addTo(carte);
    else infobulle.remove();
  });
  carte.on("click", e => {
    if (!enVueZone()) return;
    const insee = communeAuPoint(e.lngLat.lng, e.lngLat.lat);
    if (insee) { infobulle.remove(); naviguer(`explorer=${insee}`); }
  });
  carte.on("mousemove", "parcelles-clic", e => {
    if (enVueZone()) return;
    const id = e.features[0].properties.id, [liste, anciennes] = autorisationsParcelle(id);
    const autres = !liste.length && anciennes ? ` (${pluriel(anciennes, "plus ancienne", "plus anciennes")})` : "";
    carte.getCanvas().style.cursor = "pointer";
    infobulle.setLngLat(e.lngLat).setHTML(`Parcelle <strong>${esc(nomParcelle(id))}</strong><br>${nombreAutorisations(liste, anciennes)}${autres}`).addTo(carte);
    pointerParcelle(id);
  });
  carte.on("mouseleave", "parcelles-clic", () => { carte.getCanvas().style.cursor = ""; infobulle.remove(); pointerParcelle(null); });
  carte.on("click", "parcelles-clic", e => { if (!enVueZone()) ouvrirParcelle(e.features[0].properties.id); });
}

/* ---------- Avant l'ouverture : aperçu, liste d'attente, accès bêta ---------- */
// Tant que la plateforme n'est pas ouverte, une recherche n'affiche qu'un aperçu (nombre et types d'autorisations)
// avec l'inscription à la liste d'attente ; un code d'accès débloque les résultats complets. Le verrou vit dans le
// navigateur : ce n'est pas une protection (les données sont publiques), seulement un lancement progressif.

const CODES_BETA = [  // empreintes SHA-256 des codes, en minuscules : python3 -c "import hashlib; print(hashlib.sha256('code'.encode()).hexdigest())"
  "88ea68b3dec5d009a77b0dd3f4487be3ad027c8ef12f73aeda882d14ac5677b2",  // code distribué aux bêta-testeurs le 6 octobre 2026
];
const LISTE_ATTENTE = "";  // adresse du formulaire Brevo (https://….sibforms.com/serve/…) ; vide : inscriptions pas encore branchées
const CLE_BETA = "argos-beta";

function estBeta() {
  try { return localStorage.getItem(CLE_BETA) === "1"; } catch { return false; }  // stockage bloqué : pas d'accès bêta
}

function extraitsProjets(liste, n = 3) {  // objets des plus grands projets, sans adresse ni date ; un même objet n'est cité qu'une fois
  const vus = new Set(), extraits = [];
  for (const d of [...liste].sort(TRIS.ampleur.ordre)) {
    const objet = projet(d);
    if (!objet || d.etat === "annulé" || vus.has(objet)) continue;
    vus.add(objet);
    extraits.push(d);
    if (extraits.length === n) break;
  }
  return extraits;
}

function htmlApercu(v) {  // nombre d'autorisations de la période par défaut, répartition par type, objet de quelques projets
  let liste, ou, lieu;
  const insee = v.mode === "commune" ? v.insee : v.mode === "parcelle" && !toutes.has(v.id) ? v.id.slice(0, 5) : null;
  if (insee !== null && !infoCommune.has(insee)) return `<h2 id="apercu-titre" tabindex="-1">Choisissez une commune</h2>${listeCommunes()}`;
  if (insee) {
    liste = dossiers.filter(d => d.insee === insee && dansPeriode(d));
    ou = `à ${esc(infoCommune.get(insee).commune)}`;
    lieu = `Toute la commune de ${infoCommune.get(insee).commune}`;
  } else {
    const [lon, lat] = v.mode === "parcelle" ? centroide(toutes.get(v.id).geom) : [v.lon, v.lat];
    liste = [...rechercher(lon, lat, etat.rayon).dansRayon.keys()].map(id => parId.get(id));
    ou = `à moins de ${etat.rayon}&nbsp;m`;
    lieu = v.mode === "rapport" ? autourDe(v) : `Autour de la parcelle ${nomParcelle(v.id)}`;
  }
  const parType = Object.fromEntries(ORDRE_TYPES.map(t => [t, liste.filter(d => d.type === t).length]));
  const types = ORDRE_TYPES.filter(t => parType[t]).map(t => `<li>${sigleType(t)}<span>${nombre.format(parType[t])}</span></li>`).join("");
  const extraits = extraitsProjets(liste);
  return `
    <p class="apercu-intro">Argos est en cours de développement. Mais nous pouvons déjà vous dire ce que les autorisations
      d'urbanisme recensent ici.</p>
    <h2 id="apercu-titre" tabindex="-1">${liste.length ? pluriel(liste.length, "autorisation") : "Aucune autorisation recensée"} ${ou} depuis ${etat.depuis}</h2>
    <p class="apercu-lieu">${esc(lieu)}</p>
    ${types ? `<ul class="apercu-types" aria-label="Par type">${types}</ul>` : ""}
    ${extraits.length ? `<div class="apercu-extraits">
      <p>${extraits.length > 1 ? `Les ${extraits.length} plus grands projets` : "Le projet"} :</p>
      <ul>${extraits.map(d => `<li>${sigleType(d.type)}<span>${esc(projet(d))}</span></li>`).join("")}</ul>
    </div>` : ""}
    <p class="apercu-note">Seules les autorisations accordées sont recensées${liste.length ? "" : " : leur absence ne garantit pas qu'aucun projet ne viendra"}.
      Adresses, dates, carte et rapport imprimable ouvriront à tous prochainement.</p>`;
}

function montrerApercu(chargement = false) {  // page de la liste d'attente, à la place des résultats
  const resume = document.querySelector("#apercu .apercu-resume");
  if (chargement) { resume.innerHTML = `<h2 id="apercu-titre" tabindex="-1">Chargement des données…</h2>`; return; }  // lireUrl rappelée une fois chargées
  resume.innerHTML = htmlApercu(etat.vue);
  if (etat.vue.mode === "rapport") document.getElementById("q-accueil").value = etat.vue.libelle;
  document.getElementById("apercu-titre").focus({preventScroll: true});
}

async function empreinte(texte) {
  const octets = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte)));
  return [...octets].map(o => o.toString(16).padStart(2, "0")).join("");
}

function initAvantOuverture() {
  const liste = document.getElementById("liste-attente"), beta = document.getElementById("code-beta");
  if (LISTE_ATTENTE) liste.action = LISTE_ATTENTE;
  liste.addEventListener("submit", e => {  // envoi classique vers Brevo, qui confirme par e-mail (double inscription)
    const champ = liste.querySelector("input[type=email]"), statut = liste.querySelector(".statut");
    if (!champ.checkValidity()) {
      e.preventDefault();
      statut.textContent = "Saisissez une adresse e-mail complète, par exemple prenom@exemple.fr.";
      champ.focus();
    } else if (!LISTE_ATTENTE) {
      e.preventDefault();
      statut.textContent = "Les inscriptions ouvrent dans quelques jours : votre adresse n'a pas été enregistrée. Revenez bientôt.";
    }
  });
  beta.addEventListener("submit", async e => {
    e.preventDefault();
    const champ = beta.querySelector("input"), statut = beta.querySelector(".statut");
    const code = champ.value.trim().toLowerCase();
    if (!code) { statut.textContent = "Saisissez le code reçu."; champ.focus(); return; }
    let valide = false;
    try { valide = CODES_BETA.includes(await empreinte(code)); } catch { /* page hors https : pas de vérification possible */ }
    if (!valide) { statut.textContent = "Code inconnu. Vérifiez-le, en minuscules ou majuscules indifféremment."; champ.select(); return; }
    try { localStorage.setItem(CLE_BETA, "1"); } catch {
      statut.textContent = "Votre navigateur bloque l'enregistrement de l'accès. Autorisez le stockage pour ce site.";
      return;
    }
    statut.textContent = "Accès ouvert.";
    lireUrl();
  });
}

/* ---------- Accueil : démonstration sur de vraies adresses ---------- */
// Quatre adresses fixes et un rayon : nombre d'autorisations, types, plus grands projets (comme l'aperçu public) et plan
// des parcelles réelles autour, en SVG. Les communes ne se chargent que lorsque la section approche de l'écran.

const RAYONS_DEMO = [100, 200, 300, 500];
const PLAN_DEMO = 560;  // m : parcelles dessinées autour de l'adresse, un peu au-delà du plus grand rayon
const FLECHE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const demo = {i: 0, rayon: 300, numero: 0, dessinee: null, vue: 345, nombre: null, animation: 0};
const sobre = matchMedia("(prefers-reduced-motion: reduce)");

function initDemo() {
  const section = document.getElementById("demo");
  const curseur = document.getElementById("demo-rayon");
  document.querySelectorAll('[data-info="debut-recent"]').forEach(el => { el.textContent = debutRecent; });
  section.querySelector(".demo-adresses").addEventListener("click", e => {
    const b = e.target.closest("[data-demo]");
    if (!b || b.getAttribute("aria-pressed") === "true") return;
    section.querySelectorAll("[data-demo]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    demo.i = Number(b.dataset.demo);
    majDemo();
  });
  curseur.addEventListener("input", () => {
    demo.rayon = RAYONS_DEMO[Number(curseur.value)];
    document.getElementById("demo-rayon-valeur").textContent = `${demo.rayon} m`;
    curseur.setAttribute("aria-valuetext", `${demo.rayon} mètres`);
    majDemo();
  });
  new IntersectionObserver((entrees, obs) => {  // pas de téléchargement tant que la section est loin de l'écran
    if (entrees.some(e => e.isIntersecting)) { obs.disconnect(); majDemo(); }
  }, {rootMargin: "400px"}).observe(section);
}

async function majDemo() {
  const b = document.querySelector(`[data-demo="${demo.i}"]`), lon = Number(b.dataset.lon), lat = Number(b.dataset.lat);
  const resultat = document.querySelector(".demo-resultat"), n = ++demo.numero;
  const manquantes = communesAutour(lon, lat, PLAN_DEMO).filter(c => !pretes.has(c));
  if (manquantes.length) {
    resultat.setAttribute("aria-busy", "true");
    try { await Promise.all(manquantes.map(chargerCommune)); }
    catch {
      if (n === demo.numero) resultat.innerHTML = `<p class="demo-attente">Les autorisations n'ont pas pu être chargées. Vérifiez votre connexion.</p>`;
      return;
    }
    if (n !== demo.numero) return;  // une autre adresse a été choisie entre-temps
  }
  resultat.removeAttribute("aria-busy");
  const liste = [...rechercher(lon, lat, demo.rayon).dansRayon.keys()].map(id => parId.get(id));
  const parType = ORDRE_TYPES.map(t => [t, liste.filter(d => d.type === t).length]).filter(([, k]) => k);
  const lien = new URLSearchParams({lon: lon.toFixed(6), lat: lat.toFixed(6), r: demo.rayon, l: b.dataset.libelle, p: "housenumber", c: communeAuPoint(lon, lat) || ""});
  resultat.innerHTML = `
    <p class="demo-nombre"><span class="valeur">${nombre.format(demo.nombre ?? liste.length)}</span>
      ${liste.length > 1 ? "autorisations" : "autorisation"} à moins de ${demo.rayon}&nbsp;m depuis ${etat.depuis}</p>
    ${parType.length ? `<ul class="apercu-types" aria-label="Par type">${parType.map(([t, k]) => `<li>${sigleType(t)}<span>${nombre.format(k)}</span></li>`).join("")}</ul>` : ""}
    ${liste.length ? `<ul class="demo-projets">${extraitsProjets(liste).map(d => `<li>${sigleType(d.type)}<span>${esc(projet(d))}</span></li>`).join("")}</ul>`
      : `<p class="demo-attente">Aucune autorisation si près : élargissez le rayon.</p>`}
    <a class="demo-lien" href="#${lien}">Voir le rapport de cette adresse${FLECHE}</a>`;
  compter(resultat.querySelector(".valeur"), demo.nombre ?? liste.length, liste.length);
  demo.nombre = liste.length;
  if (demo.dessinee !== demo.i) { dessinerPlan(lon, lat); demo.dessinee = demo.i; }
  const avecAutorisation = new Set(liste.flatMap(d => d.actuelles));
  document.querySelectorAll("#demo-svg .parcelles path").forEach(el => el.classList.toggle("autorisee", avecAutorisation.has(el.dataset.id)));
  cadrerPlan(demo.rayon);
}

function compter(el, depuis, vers) {  // le grand chiffre défile jusqu'à sa nouvelle valeur
  if (sobre.matches || depuis === vers) { el.textContent = nombre.format(vers); return; }
  const debut = performance.now(), duree = 450;
  const pas = t => {
    const k = Math.min(1, (t - debut) / duree), e = 1 - Math.pow(2, -10 * k);
    el.textContent = nombre.format(Math.round(depuis + (vers - depuis) * e));
    if (k < 1 && el.isConnected) requestAnimationFrame(pas);
  };
  requestAnimationFrame(pas);
}

function dessinerPlan(lon, lat) {  // parcelles actuelles et limites de communes autour de l'adresse, en mètres, nord en haut
  const kx = Math.PI / 180 * R_TERRE * Math.cos(lat * Math.PI / 180), ky = Math.PI / 180 * R_TERRE;
  const bx0 = lon - PLAN_DEMO / kx, bx1 = lon + PLAN_DEMO / kx, by0 = lat - PLAN_DEMO / ky, by1 = lat + PLAN_DEMO / ky;
  const trace = g => polygones(g).map(poly => poly.map(a => "M" + a.map(([x, y]) =>
    `${((x - lon) * kx).toFixed(1)} ${((lat - y) * ky).toFixed(1)}`).join("L") + "Z").join("")).join("");
  const proche = ([x0, y0, x1, y1]) => x1 >= bx0 && x0 <= bx1 && y1 >= by0 && y0 <= by1;
  const parcelles = [...toutes].filter(([, p]) => p.actuelle && proche(p.emprise))
    .map(([id, p]) => `<path data-id="${id}" d="${trace(p.geom)}"/>`).join("");
  const limites = contours.features.filter(f => proche(f.emprise)).map(f => `<path d="${trace(f.geometry)}"/>`).join("");
  document.getElementById("demo-svg").innerHTML = `<g class="parcelles">${parcelles}</g><g class="limites">${limites}</g>
    <circle class="cercle" r="${demo.rayon}"/><circle class="point" r="4"/>`;
}

function cadrerPlan(rayon) {  // le plan s'éloigne ou se rapproche : le cercle garde sa taille à l'écran, le quartier change d'échelle
  const svg = document.getElementById("demo-svg"), cercle = svg.querySelector(".cercle"), point = svg.querySelector(".point");
  const depart = demo.vue, arrivee = rayon * 1.15, debut = performance.now(), duree = sobre.matches ? 0 : 650, numero = ++demo.animation;
  const poser = v => {
    svg.setAttribute("viewBox", `${-v} ${-v} ${2 * v} ${2 * v}`);
    cercle.setAttribute("r", (v / 1.15).toFixed(1));
    point.setAttribute("r", (v * .024).toFixed(2));
    demo.vue = v;
  };
  const pas = t => {
    if (numero !== demo.animation) return;
    const k = duree ? Math.min(1, (t - debut) / duree) : 1, e = 1 - Math.pow(2, -10 * k);
    poser(depart + (arrivee - depart) * e);
    if (k < 1) requestAnimationFrame(pas);
  };
  if (!duree) poser(arrivee); else requestAnimationFrame(pas);
}

/* ---------- Navigation (l'état de la vue vit dans l'URL : liens partageables) ---------- */

function naviguer(params) {  // objet de paramètres, ou fragment tel quel ("explorer")
  const h = typeof params === "string" ? params : new URLSearchParams(params).toString();
  if (location.hash.slice(1) === h) lireUrl(); else location.hash = h;
}

const ecranCarte = h => h.has("parcelle") || (h.has("lon") && h.has("lat")) || h.has("explorer");

const ECRANS = ["accueil", "attente", "appli"];  // accueil sans carte ; avant l'ouverture, page de la liste d'attente ; liste et carte

function montrerEcran(ecran) {
  if (!document.getElementById(ecran).hidden) return;  // déjà affiché
  for (const e of ECRANS) document.getElementById(e).hidden = e !== ecran;
  window.scrollTo(0, 0);
}

let numeroVue = 0;  // dernière vue demandée : un chargement plus lent ne l'écrase pas

function lireUrl() {
  const h = new URLSearchParams(location.hash.slice(1));
  const r = Number(h.get("r"));
  if (RAYONS.includes(r)) etat.rayon = r;
  if (h.has("parcelle")) etat.vue = {mode: "parcelle", id: h.get("parcelle")};
  else if (h.has("lon") && h.has("lat")) etat.vue = {mode: "rapport", lon: Number(h.get("lon")), lat: Number(h.get("lat")),
    libelle: h.get("l") || "Point choisi", precision: h.get("p") || "", commune: h.get("c") || ""};
  else if (h.has("explorer")) etat.vue = {mode: "commune", insee: h.get("explorer")};
  else etat.vue = null;
  const ouvert = estBeta();  // avant l'ouverture, seuls les bêta-testeurs voient les résultats
  montrerEcran(!etat.vue ? "accueil" : ouvert ? "appli" : "attente");
  if (!etat.vue) {  // accueil : contenu fixe, rempli au démarrage
    if (h.has("donnees")) document.getElementById("donnees").scrollIntoView(); else window.scrollTo(0, 0);
    return;
  }
  if (!zone) { if (!ouvert) montrerApercu(true); return; }  // index en cours de chargement : demarrer() rappelle lireUrl
  const manquantes = communesVue(etat.vue).filter(c => !pretes.has(c)), n = ++numeroVue;
  if (manquantes.length) {  // communes à charger d'abord ; seule la dernière vue demandée s'affiche
    if (!ouvert) montrerApercu(true);
    else document.getElementById("vue").innerHTML = `<p class="chargement">Chargement des données…</p>`;
    Promise.all(manquantes.map(chargerCommune)).then(() => { if (n === numeroVue) lireUrl(); }, () => { if (n === numeroVue) echecChargement(); });
    return;
  }
  if (!ouvert) { montrerApercu(); return; }
  if (!carte) initCarte(); else carte.resize();  // carte créée à la première visite : son conteneur doit avoir une taille
  rendre();
  if (cartePrete) cadrer();
  document.getElementById("adresse").value = etat.vue.mode === "rapport" ? etat.vue.libelle : "";
  document.getElementById("panneau").scrollTop = 0;
  if (PETIT_ECRAN.matches) window.scrollTo(0, 0);
}

function rapportAutourDe(lon, lat, libelle, precision, commune) {
  naviguer({lon: lon.toFixed(6), lat: lat.toFixed(6), r: etat.rayon, l: libelle, p: precision, c: commune});
}

function rapportParcelle(id) {  // rapport centré sur la parcelle
  const [lon, lat] = centroide(toutes.get(id).geom);
  rapportAutourDe(lon, lat, `Parcelle ${nomParcelle(id)}`, "parcelle", id.slice(0, 5));
}

/* ---------- Recherche d'adresse (autocomplétion du géocodeur de l'IGN) ---------- */

function initRecherche(form) {  // barre de l'accueil et barre de l'en-tête
  const champ = form.querySelector("input[type=search]"), liste = form.querySelector(".suggestions");
  let suggestions = [], pour = "", actif = -1, minuteur, numero = 0, panne = false;  // panne : le géocodeur n'a pas répondu
  let ailleurs = false;  // adresses trouvées, mais toutes hors de la zone couverte

  const fermer = () => { liste.hidden = true; champ.setAttribute("aria-expanded", "false"); champ.removeAttribute("aria-activedescendant"); };
  const afficher = () => {
    liste.innerHTML = suggestions.length
      ? suggestions.map((f, i) => `<li role="option" id="${liste.id}-${i}" data-i="${i}" aria-selected="${i === actif}">${esc(f.properties.label)}</li>`).join("")
      : `<li class="aucune" role="option" aria-disabled="true">${panne ? "Le service d'adresses de l'IGN ne répond pas. Réessayez dans un instant."
        : ailleurs ? `Argos ne couvre pour l'instant que la ${esc(Object.values(zone.departements).join(" et le "))}.`
        : "Aucune adresse trouvée : vérifiez le nom de la rue."}</li>`;
    liste.hidden = false;
    champ.setAttribute("aria-expanded", "true");
    if (actif >= 0) champ.setAttribute("aria-activedescendant", `${liste.id}-${actif}`); else champ.removeAttribute("aria-activedescendant");
  };
  const suggerer = async q => {
    const n = ++numero;
    const centre = zone ? {lon: (zone.emprise[0] + zone.emprise[2]) / 2, lat: (zone.emprise[1] + zone.emprise[3]) / 2} : {};  // avant le chargement : sans priorité à la zone
    const url = `${GEOCODEUR}?${new URLSearchParams({q, autocomplete: 1, index: "address", limit: zone ? 15 : 6, ...centre})}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (n !== numero) return [];
      const trouvees = j.features || [];  // le géocodeur ne filtre pas par département : on ne garde que les communes couvertes
      suggestions = zone ? trouvees.filter(f => infoCommune.has(f.properties.citycode)).slice(0, 6) : trouvees;
      ailleurs = trouvees.length > 0 && !suggestions.length;
      pour = q;
      panne = false;
    } catch {
      if (n !== numero) return [];
      suggestions = [];
      panne = true;
    }
    actif = -1;
    afficher();
    return suggestions;
  };
  const choisir = f => {
    const [lon, lat] = f.geometry.coordinates, p = f.properties;
    champ.value = p.label;
    fermer();
    rapportAutourDe(lon, lat, p.label, p.type, p.citycode);
  };

  champ.addEventListener("input", () => {
    clearTimeout(minuteur);
    const q = champ.value.trim();
    if (q.length < 3) { suggestions = []; fermer(); return; }
    minuteur = setTimeout(() => suggerer(q), 200);
  });
  champ.addEventListener("keydown", e => {
    if (liste.hidden || !suggestions.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      actif = (actif + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      afficher();
    } else if (e.key === "Escape") { e.preventDefault(); fermer(); }  // Échap ferme d'abord les suggestions, pas la fiche
  });
  liste.addEventListener("mousedown", e => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choisir(suggestions[Number(li.dataset.i)]); }
  });
  champ.addEventListener("blur", () => setTimeout(fermer, 150));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const q = champ.value.trim();
    if (q.length < 3) return;
    clearTimeout(minuteur);
    const liste = pour === q && suggestions.length ? suggestions : await suggerer(q);  // suggestions de la saisie actuelle
    if (liste.length) choisir(liste[Math.max(actif, 0)]);
  });
  form.addEventListener("click", e => {  // exemples cliquables sous la barre de l'accueil
    const b = e.target.closest("button[data-q]");
    if (b) { champ.value = b.dataset.q; form.requestSubmit(); }
  });
}

/* ---------- Actions : sélection, tri, impression, CSV, lien ---------- */

function exporterCsv() {
  const res = etat.resultat, v = etat.vue;
  if (!res) return;
  const champs = ["distance_m", "sur_parcelle", "parcelle_voisine", "id", "type", "num", "etat", "annee_depot", "date_autorisation",
    "date_ouverture_chantier", "date_achevement", "adresse", "code_postal", "references_cadastrales", "superficie_terrain",
    "demandeur", "siren", "nature_projet", "destination_principale", "type_logements", "residence", "nb_logements_crees",
    "surf_habitation_creee", "surf_habitation_demolie", "surf_non_residentielle_creee", "surf_non_residentielle_demolie",
    "localisation", "lon", "lat"];
  const cellule = x => /[;"\r\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x);
  const lignes = [champs.join(";")];
  for (const d of [...res.dansRayon.keys()].map(id => parId.get(id)).sort(parDateDesc)) {
    const extra = {distance_m: Math.round(res.dansRayon.get(d.id)), sur_parcelle: Number(res.surParcelle.has(d.id)),
      parcelle_voisine: Number(res.voisines.has(d.id))};
    lignes.push(champs.map(c => cellule(extra[c] ?? d[c] ?? "")).join(";"));
  }
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(new Blob(["﻿" + lignes.join("\r\n")], {type: "text/csv;charset=utf-8"}));
  lien.download = `argos-${v.libelle.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${etat.rayon}m.csv`;
  lien.click();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
}

function imprimer() {  // la carte reste rendue hors écran en affichage liste : son image accompagne toujours le rapport
  const img = document.getElementById("carte-impression");
  if (!cartePrete || !img) { window.print(); return; }
  carte.once("render", () => {
    try { img.src = carte.getCanvas().toDataURL("image/png"); } catch { img.remove(); }
    (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).finally(() => window.print());
  });
  carte.triggerRepaint();
}

function initActions() {
  const vue = document.getElementById("vue");
  for (const zone of [vue, document.getElementById("fiche")]) {  // survol d'une autorisation : ses parcelles en jaune le temps du survol
    zone.addEventListener("mouseover", e => {
      const id = e.target.closest("[data-id]")?.dataset.id || null;
      if (cartePrete && id !== etat.survol) { etat.survol = id; appliquerSurlignage(); }
    });
    zone.addEventListener("mouseleave", () => {
      if (cartePrete && etat.survol) { etat.survol = null; appliquerSurlignage(); }
    });
  }
  vue.addEventListener("click", async e => {
    const sigle = e.target.closest(".sigle");
    if (sigle) {
      const t = sigle.dataset.type;
      if (etat.types.has(t) && etat.types.size === 1) return;  // au moins un type
      etat.types.has(t) ? etat.types.delete(t) : etat.types.add(t);
      rendre();
      return;
    }
    const ligne = e.target.closest(".ligne-dossier");
    if (ligne) { selectionner(ligne.dataset.id); return; }
    const resume = e.target.closest(".dossier summary");  // vue parcelle : la ligne se déplie et sa parcelle passe en jaune
    if (resume) {
      const id = resume.closest(".dossier").dataset.id;
      etat.surligne = etat.surligne === id ? null : id;
      appliquerSurlignage();
      return;
    }
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tri) { etat.tri = b.dataset.tri; rendre(); return; }
    if (b.dataset.depuis) { changerPeriode(Number(b.dataset.depuis)); return; }
    const action = b.dataset.action;
    if (action === "commune") naviguer(communeVue(etat.vue) ? `explorer=${communeVue(etat.vue)}` : "explorer");
    if (action === "zone") naviguer("explorer");
    if (action === "rayon-parcelle") rapportParcelle(etat.vue.id);
    if (action === "csv" || action === "imprimer") b.closest("details")?.removeAttribute("open");
    if (action === "csv") exporterCsv();
    if (action === "imprimer") imprimer();
    if (action === "lien") {
      try { await navigator.clipboard.writeText(location.href); b.textContent = "Lien copié"; }
      catch { b.textContent = "Copie impossible : utilisez la barre d'adresse"; }
    }
  });
  document.addEventListener("click", e => {  // le menu « Éditer un rapport » se ferme quand on clique ailleurs
    document.querySelectorAll(".menu-rapport[open]").forEach(m => { if (!m.contains(e.target)) m.removeAttribute("open"); });
  });
  document.addEventListener("keydown", e => {  // Échap : ferme le menu « Éditer un rapport », sinon la fiche ouverte
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const menu = document.querySelector(".menu-rapport[open]");
    if (menu) { menu.removeAttribute("open"); menu.querySelector("summary").focus(); return; }
    if (!document.getElementById("fiche").hidden) fermerFiche();
  });
  document.getElementById("fiche").addEventListener("click", e => {
    const ligne = e.target.closest(".ligne-dossier");  // dans la fiche de parcelle : même geste que dans la liste
    if (ligne) { selectionner(ligne.dataset.id, etat.parcelle); document.querySelector("#fiche .retour")?.focus(); return; }
    const b = e.target.closest("button"), action = b?.dataset.action;
    if (b?.dataset.depuis) changerPeriode(Number(b.dataset.depuis));
    if (action === "retour-parcelle") {  // le focus revient sur la ligne de l'autorisation, dans la fiche de parcelle
      const dossier = etat.surligne;
      ouvrirParcelle(etat.retourParcelle);
      document.querySelector(`#fiche .ligne-dossier[data-id="${CSS.escape(dossier)}"]`)?.focus();
    }
    if (action === "fermer-fiche") fermerFiche();
    if (action === "voir-carte") choisirAffichage("carte");
    if (action === "rayon-parcelle") rapportParcelle(etat.parcelle);
  });
}

/* ---------- Démarrage ---------- */

function echecChargement() {  // données injoignables : le dire, et proposer de réessayer
  const erreur = `<div class="alerte" role="alert"><p>Les données n'ont pas pu être chargées. Vérifiez votre connexion.</p>
    <button type="button" class="action" data-recharger>Réessayer</button></div>`;
  document.getElementById("vue").innerHTML = erreur;
  document.querySelector("#apercu .apercu-resume").innerHTML = erreur;
  if (!zone) document.querySelector("[data-info=bilan]")?.replaceWith(document.createRange().createContextualFragment(erreur));
  document.querySelectorAll("[data-recharger]").forEach(b => b.addEventListener("click", () => location.reload()));
}

async function demarrer() {
  const h = new URLSearchParams(location.hash.slice(1));  // le bon écran s'affiche sans attendre les données
  montrerEcran(!ecranCarte(h) ? "accueil" : estBeta() ? "appli" : "attente");
  initAvantOuverture();
  initAffichage();
  document.querySelectorAll("form[role=search]").forEach(initRecherche);  // la recherche n'attend pas l'index
  window.addEventListener("hashchange", lireUrl);  // une adresse choisie pendant le chargement ouvre l'écran de résultat
  const lire = f => fetch(`${DONNEES}/${f}`).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
  try {
    [zone, contours] = await Promise.all(["communes.json", "contours.json"].map(lire));
  } catch {
    zone = null;
    echecChargement();
    return;
  }
  for (const c of zone.communes) infoCommune.set(c.insee, c);
  for (const f of contours.features) f.emprise = emprise(f.geometry);
  remplirAccueil();
  initFiltres();
  initDemo();
  initActions();
  lireUrl();
}

demarrer();
