"use strict";
/* Argos · site public : autorisations d'urbanisme parcelle par parcelle, et dans un rayon autour d'une adresse.
   Même logique que scripts/recherche.py : point d'adresse rapproché dans la parcelle actuelle la plus proche,
   parcelles actuelles et anciennes au point, parcelles voisines, distance au contour des parcelles pour le rayon.
   Données préparées par scripts/05_site.py. Direction visuelle : design/DESIGN.md. */

const INSEE = "93048";
const DONNEES = `data/${INSEE}`;
const GEOCODEUR = "https://data.geopf.fr/geocodage/search";
const STYLE_PLAN = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/gris.json";
const TUILES_PHOTO = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS"
  + "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
const R_TERRE = 6371008.8;
const TOLERANCE_VOIE = 25;  // m : distance max entre le point de l'adresse et la parcelle la plus proche
const RENTREE = 0.5;        // m : le point rapproché est placé à cette distance à l'intérieur du contour
const VOISINAGE = 10;       // m : au-delà de la parcelle la plus proche, parcelles dites voisines
const RAYONS = [100, 200, 300, 500];
const COULEUR_AUTORISATION = "#2a78d6";  // parcelles du rayon portant au moins une autorisation
const ENCRE = "#1d2125";       // adresse choisie, rayon, parcelle choisie (la carte reste claire en mode sombre)
const SURLIGNAGE = "#ffe600";  // autorisation sélectionnée dans la liste
const TYPES = {PC: "permis de construire", DP: "déclaration préalable", PA: "permis d'aménager", PD: "permis de démolir"};
const TYPES_PLURIEL = {PC: "permis de construire", DP: "déclarations préalables", PA: "permis d'aménager", PD: "permis de démolir"};
const TYPES_COURTS = {PC: "Construire", PA: "Aménager", PD: "Démolir", DP: "Déclaration préalable"};  // ordre des puces
const TRANSPARENT = "rgba(0,0,0,0)";
const PETIT_ECRAN = matchMedia("(max-width: 820px)");

const etat = {types: new Set(Object.keys(TYPES)), depuis: 0, rayon: 300, vue: null, resultat: null, photo: false,
  tri: "ampleur", affichage: "split",  // tri de la liste du rayon ; affichage : liste + carte, liste seule, carte seule
  surligne: null, survol: null,  // autorisation sélectionnée (fixe) et autorisation survolée dans la liste
  pointee: null};                // parcelle survolée sur la carte : ses autorisations sont mises en avant dans la liste
const toutes = new Map();          // idu -> {geom, emprise, actuelle, contenance | premier, dernier, successeurs}
const predecesseurs = new Map();   // idu actuelle -> [idu anciennes]
const parParcelle = new Map();     // idu actuelle -> [dossiers]
const parId = new Map();
let meta, dossiers, geoParcelles, geoAnciennes, carte, marqueur, infobulle;
let cartePrete = false;  // nos couches ajoutées ; isStyleLoaded() reste faux tant qu'une icône du fond IGN manque

/* ---------- Mise en forme ---------- */

const nombre = new Intl.NumberFormat("fr-FR");
const formatDate = new Intl.DateTimeFormat("fr-FR", {day: "numeric", month: "short", year: "numeric"});
const formatMois = new Intl.DateTimeFormat("fr-FR", {month: "long", year: "numeric"});
const dateFr = s => s ? formatDate.format(new Date(`${s}T12:00:00`)) : "";
const moisFr = s => s ? formatMois.format(new Date(`${s.slice(0, 7)}-15T12:00:00`)) : "";  // "2026-09" -> "septembre 2026"
const milliers = s => s >= 10000 ? `${nombre.format(Math.round(s / 1000))} 000` : nombre.format(s);
const nomType = (t, n) => n > 1 ? TYPES_PLURIEL[t] : TYPES[t];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const pluriel = (n, mot, motPluriel = `${mot}s`) => `${nombre.format(n)} ${n > 1 ? motPluriel : mot}`;
const numeroDossier = d => `${d.type} ${d.num.slice(0, 3)} ${d.num.slice(3, 6)} ${d.num.slice(6, 8)} ${d.num.slice(8)}`;
const nomParcelle = id => `${id.slice(8, 10).replace(/^0/, "")} ${Number(id.slice(10))}`;
const annee = s => s ? s.slice(0, 4) : "";
const parDateDesc = (a, b) => (b.date_autorisation || "").localeCompare(a.date_autorisation || "") || a.id.localeCompare(b.id);
const dansPeriode = d => Number(annee(d.date_autorisation) || etat.depuis) >= etat.depuis;
const visible = d => etat.types.has(d.type) && dansPeriode(d);

const projet = d => d.objet || d.nature_projet || "";  // objet en clair, écrit par scripts/04_dossiers.py
const surfaceCreee = d => Number(d.surf_habitation_creee || 0) + Number(d.surf_non_residentielle_creee || 0);
const surfaceDemolie = d => Number(d.surf_habitation_demolie || 0) + Number(d.surf_non_residentielle_demolie || 0);
const ampleur = d => Math.max(surfaceCreee(d), surfaceDemolie(d));

const TRIS = {  // liste du rayon ; l'impression et le CSV restent groupés par adresse
  ampleur: {libelle: "Ampleur", aide: "Les plus grandes surfaces d'abord.",
    ordre: (a, b) => ampleur(b) - ampleur(a) || Number(b.nb_logements_crees || 0) - Number(a.nb_logements_crees || 0) || parDateDesc(a, b)},
  distance: {libelle: "Distance", aide: "Les plus proches d'abord, regroupées par adresse."},
  date: {libelle: "Date", aide: "Les décisions les plus récentes d'abord.", ordre: parDateDesc},
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
  for (const d of dossiers) {
    if (!dansPeriode(d)) continue;
    let dist = Infinity;
    if (d.localisation === "adresse" || d.localisation === "voie") dist = Math.hypot((d.lon - lon0) * kx, (d.lat - lat0) * ky);
    else for (const p of d.parcelles) if (proches.has(p)) dist = Math.min(dist, proches.get(p)[0]);
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
  return {auPoint, rapproche, surParcelle, voisines, dansRayon, dansRayonTous};
}

/* ---------- Rendu de la liste ---------- */

function tuile(valeur, libelle) {
  return `<div class="tuile"><span class="valeur">${valeur}</span><span class="libelle">${libelle}</span></div>`;
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
      <span class="type" data-type="${d.type}" title="${esc(TYPES[d.type])}">${d.type}</span>
      <span class="ligne1">${esc(ligne)}</span>
      <span class="distance">${distance === null ? "" : `${approx}${nombre.format(Math.round(distance))} m`}</span>
      <span class="adresse">${esc(d.adresse || "Adresse non renseignée")}</span>
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

function enteteGroupe(adresse, ds, proche) {
  return `<span>${esc(adresse)}</span><span class="distance">${ds.some(d => d.localisation === "voie") ? "≈ " : ""}${nombre.format(Math.round(proche))} m · ${pluriel(ds.length, "autorisation")}</span>`;
}

function parAdresse(liste, distances) {  // version imprimable
  if (!liste.length) return `<p class="vide">Aucune autorisation avec les filtres actuels.</p>`;
  return grouperParAdresse(liste, distances).map(([adresse, ds, proche]) => `
    <section class="groupe"><h4>${enteteGroupe(adresse, ds, proche)}</h4>${listeDossiers(ds)}</section>`).join("");
}

/* Carte de dossier (rapport) : un bouton ; la sélection surligne ses parcelles et ouvre la fiche */

function chiffresDossier(d) {
  const logements = Number(d.nb_logements_crees || 0), creee = surfaceCreee(d), demolie = surfaceDemolie(d);
  return [logements > 0 && pluriel(logements, "logement créé", "logements créés"),
    creee > 0 && `${nombre.format(creee)} m² créés`, demolie > 0 && `${nombre.format(demolie)} m² démolis`].filter(Boolean).join(" · ");
}

function quandDossier(d) {  // « Autorisé le 27 mai 2025 · commencé · CAMPUS 3M »
  const decision = d.date_autorisation ? `${d.type === "DP" ? "Non-opposition le" : "Autorisé le"} ${dateFr(d.date_autorisation)}` : "";
  return [decision, d.etat !== "autorisé" && d.etat, d.demandeur].filter(Boolean).join(" · ");
}

function registreDossier(d) {  // n° de dossier et parcelles actuelles
  const ps = d.actuelles.map(nomParcelle);
  const parcelles = ps.length ? `${ps.length > 1 ? "Parcelles" : "Parcelle"} ${ps.slice(0, 4).join(", ")}${ps.length > 4 ? ` +${ps.length - 4}` : ""}` : "";
  return `<span>${esc(numeroDossier(d))}</span>${parcelles ? `<span>${esc(parcelles)}</span>` : ""}`;
}

function htmlCarteDossier(d, distance = null) {
  const approx = d.localisation === "voie" ? "≈ " : "", chiffres = chiffresDossier(d);
  return `<button type="button" class="carte-dossier${d.etat === "annulé" ? " annule" : ""}" data-id="${esc(d.id)}" aria-pressed="${d.id === etat.surligne}">
    <span class="haut"><span class="badge" data-type="${d.type}" title="${esc(TYPES[d.type])}">${d.type}</span>${distance === null ? ""
      : `<span class="distance">${approx}${nombre.format(Math.round(distance))} m</span>`}</span>
    <span class="titre-dossier">${esc(projet(d).split(" · ")[0] || TYPES[d.type])}</span>
    ${chiffres ? `<span class="detail">${esc(chiffres)}</span>` : ""}
    <span class="adresse">${esc(d.adresse || "Adresse non renseignée")}</span>
    <span class="quand">${esc(quandDossier(d))}</span>
    <span class="registre">${registreDossier(d)}</span>
  </button>`;
}

function grille(liste, distance = () => null) {
  return `<div class="grille">${liste.map(d => htmlCarteDossier(d, distance(d))).join("")}</div>`;
}

function htmlFiche(d) {  // fiche du dossier sélectionné, en surimpression sur la carte
  const dist = etat.resultat?.dansRayon.get(d.id), chiffres = chiffresDossier(d);
  return `
    <div class="fiche-haut">
      <span class="badge" data-type="${d.type}" title="${esc(TYPES[d.type])}">${d.type}</span>
      ${dist === undefined ? "" : `<span class="distance">à ${d.localisation === "voie" ? "≈ " : ""}${nombre.format(Math.round(dist))} m</span>`}
      <button type="button" class="fermer" data-action="fermer-fiche" aria-label="Fermer la fiche">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
      </button>
    </div>
    <p class="titre-dossier${d.etat === "annulé" ? " annule" : ""}">${esc(projet(d).split(" · ")[0] || TYPES[d.type])}</p>
    ${chiffres ? `<p class="detail">${esc(chiffres)}</p>` : ""}
    <p class="adresse">${esc(d.adresse || "Adresse non renseignée")}</p>
    <p class="quand">${esc(quandDossier(d))}</p>
    <p class="registre">${registreDossier(d)}</p>
    <details><summary>Toutes les informations</summary><dl>${detailsDossier(d)}</dl></details>
    ${carteVisible() ? "" : `<button type="button" class="action" data-action="voir-carte">Voir sur la carte</button>`}`;
}

/* ---------- Vues : toute la commune, une parcelle, un rapport dans un rayon ---------- */

function vueCommune() {  // carte de toute la commune, sans adresse
  const visibles = dossiers.filter(visible);
  const {logements, surface} = totaux(visibles);
  const parType = Object.keys(TYPES).map(t => [t, visibles.filter(d => d.type === t).length]).filter(([, n]) => n);
  return `
    <h2>Toute la commune</h2>
    <p>Cliquez sur une parcelle de la carte pour voir ses autorisations, y compris celles déposées sous d'anciens numéros,
       ou cherchez une adresse pour voir celles d'un rayon autour.</p>
    <div class="chiffres">
      ${tuile(nombre.format(visibles.length), `autorisations accordées depuis ${etat.depuis}`)}
      ${tuile(nombre.format(logements), "logements créés")}
      ${tuile(milliers(surface), "m² de surface de plancher créés")}
    </div>
    <p class="precision-chiffres">${parType.map(([t, n]) => `${nombre.format(n)} ${nomType(t, n)}`).join(" · ")}.
      Logements et surfaces hors autorisations annulées.</p>
    <p class="note"><a href="#donnees">Ce que contiennent les données, et ce qu'elles ne contiennent pas</a></p>`;
}

function remplirAccueil() {  // chiffres et dates de l'accueil, lus dans les données
  const {logements, surface} = totaux(dossiers);
  const nonLocalises = dossiers.filter(d => d.localisation === "aucune").sort(parDateDesc);
  const n = nonLocalises.length;
  const info = {
    commune: meta.commune,
    insee: meta.insee,
    premiere_annee: meta.premiere_annee,
    sitadel: moisFr(meta.sitadel),
    cadastre: moisFr(meta.cadastre),
    genere: dateFr(meta.genere),
    bilan: `À ${meta.commune} : ${pluriel(dossiers.length, "autorisation accordée", "autorisations accordées")} depuis ${meta.premiere_annee},
      ${pluriel(logements, "logement créé", "logements créés")} et ${milliers(surface)} m² de surface de plancher créés.`,
    "non-localisees": `${pluriel(n, "autorisation n'a", "autorisations n'ont")} pas pu être localisée${n > 1 ? "s" : ""}
      (ni adresse exploitable, ni parcelle retrouvée).`,
  };
  document.querySelectorAll("[data-info]").forEach(el => { if (el.dataset.info in info) el.textContent = info[el.dataset.info]; });
  document.querySelectorAll("[data-compte]").forEach(el => {
    el.textContent = `${pluriel(dossiers.filter(d => d.type === el.dataset.compte).length, "autorisation")} depuis ${meta.premiere_annee}`;
  });
  document.getElementById("liste-non-localisees").innerHTML = n
    ? `<details><summary>${n > 1 ? "Voir les autorisations non localisées" : "Voir l'autorisation non localisée"}</summary>${listeDossiers(nonLocalises)}</details>` : "";
}

function origineDans(d, idParcelle) {
  if (d.parcelles.includes(idParcelle)) return "";
  const ancienne = d.parcelles.find(p => (predecesseurs.get(idParcelle) || []).includes(p));
  if (ancienne) return `Déposée sous l'ancienne parcelle ${nomParcelle(ancienne)}`;
  if (d.localisation === "adresse") return "Rattachée par son adresse (pas de référence cadastrale exploitable)";
  return "";
}

function vueParcelle(id) {
  const p = toutes.get(id);
  const liste = (parParcelle.get(id) || []).filter(visible).sort(parDateDesc);
  const preds = (predecesseurs.get(id) || []).map(a => toutes.get(a) && `${nomParcelle(a)} (au cadastre de ${annee(toutes.get(a).premier)} à ${annee(toutes.get(a).dernier)})`);
  const {logements, surface} = totaux(liste);
  return `
    <button class="retour" data-action="commune">← Toute la commune</button>
    <h2>Parcelle ${nomParcelle(id)}</h2>
    <p class="sous-titre">${p.contenance ? `${nombre.format(p.contenance)} m² · ` : ""}<span class="mono">${id}</span></p>
    ${preds.length ? `<p class="note">Issue d'une division ou d'une fusion : ${preds.join(", ")}. Les autorisations
      déposées sous ${preds.length > 1 ? "ces anciens numéros" : "cet ancien numéro"} sont incluses.</p>` : ""}
    ${liste.length ? `<div class="chiffres">
      ${tuile(nombre.format(liste.length), liste.length > 1 ? "autorisations" : "autorisation")}
      ${tuile(nombre.format(logements), "logements créés")}
      ${tuile(nombre.format(surface), "m² créés")}
    </div>` : ""}
    <div class="actions">
      <button class="action" data-action="rayon-parcelle">Autorisations dans un rayon de ${etat.rayon} m</button>
    </div>
    <h3>${liste.length ? "Autorisations sur cette parcelle" : "Aucune autorisation recensée sur cette parcelle"}</h3>
    ${liste.length ? listeDossiers(liste, d => ({origine: origineDans(d, id)})) : ""}`;
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
  const horsCommune = v.commune && v.commune !== INSEE
    ? `<p class="alerte">Adresse hors de ${esc(meta.commune)} : seules les autorisations de ${esc(meta.commune)} sont prises en compte.</p>` : "";
  const titreParcelle = `Sur la parcelle${parcellesAuPoint.length > 1 ? "s" : ""} ${parcellesAuPoint.join(", ")}${anciennesAuPoint.length
    ? ` <span class="note">(et ancienne${anciennesAuPoint.length > 1 ? "s" : ""} ${anciennesAuPoint.join(", ")})</span>` : ""}`;
  const distance = d => res.dansRayon.get(d.id) ?? null;
  const notePied = `≈ : autorisation localisée à la rue seulement. Distances mesurées jusqu'au contour des parcelles.
      Seules les autorisations accordées qui créent des logements ou de la surface de plancher, et les permis d'aménager
      et de démolir, figurent dans la source. Données ${esc(meta.sitadel)}.`;

  let liste;
  if (!enRayon.length) liste = `<p class="vide-bloc">Aucune autorisation ne correspond. Élargissez le rayon, changez de période ou réactivez un type.</p>`;
  else if (etat.tri === "distance") liste = grouperParAdresse(enRayon, res.dansRayon).map(([adresse, ds, proche]) => `
      <section class="groupe-adresse"><h3>${enteteGroupe(adresse, ds, proche)}</h3>${grille(ds, distance)}</section>`).join("");
  else liste = grille([...enRayon].sort(TRIS[etat.tri].ordre), distance);

  const ecran = `
    <div class="resume">
      <button class="retour" data-action="commune">← Toute la commune</button>
      <p class="surtitre">${esc(autourDe(v))}</p>
      <h1 class="synthese">${enRayon.length ? pluriel(enRayon.length, "autorisation") : "Aucune autorisation"} à moins de ${etat.rayon} m</h1>
      <p class="ligne-synthese">${pluriel(logements, "logement créé", "logements créés")} · ${nombre.format(surface)} m² de surface de plancher créés</p>
      <p class="note">${localisation} ${filtres}</p>
      ${horsCommune}
      <div class="actions">
        <button class="action" data-action="imprimer">Imprimer ou enregistrer en PDF</button>
        <button class="action" data-action="csv">Télécharger le tableau (CSV)</button>
        <button class="action" data-action="lien">Copier le lien</button>
      </div>
    </div>
    <section class="bloc">
      <h2>${titreParcelle}</h2>
      ${!res.auPoint.length ? `<p class="vide">Aucune parcelle à moins de ${TOLERANCE_VOIE} m de ce point.</p>`
        : surParcelle.length ? grille(surParcelle) : `<p class="vide">Aucune autorisation sur cette parcelle avec les filtres actuels.</p>`}
    </section>
    ${voisines.length ? `<section class="bloc"><h2>Sur les parcelles voisines <span class="note">(moins de ${VOISINAGE} m)</span></h2>${grille(voisines, distance)}</section>` : ""}
    <section class="bloc">
      <div class="tri-barre">
        <h2>Dans le rayon de ${etat.rayon} m</h2>
        <div class="tri">
          <span class="aide">${TRIS[etat.tri].aide}</span>
          <span id="lbl-tri">Trier par</span>
          <div class="segmente" role="group" aria-labelledby="lbl-tri">
            ${Object.entries(TRIS).map(([k, t]) => `<button type="button" data-tri="${k}" aria-pressed="${k === etat.tri}">${t.libelle}</button>`).join("")}
          </div>
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
  if (v.mode === "parcelle" && !toutes.has(v.id)) etat.vue = {mode: "commune"};
  etat.resultat = null;
  etat.surligne = etat.survol = etat.pointee = null;
  document.getElementById("vue").innerHTML = etat.vue.mode === "commune" ? vueCommune()
    : etat.vue.mode === "parcelle" ? vueParcelle(etat.vue.id) : vueRapport(etat.vue);
  rendreFiltres();
  majFiche();
  if (cartePrete) majCarte();
}

/* ---------- Barre de filtres : types (avec leur nombre dans la vue), rayon, période ---------- */

function rendreFiltres() {
  const v = etat.vue, res = etat.resultat;
  const base = res ? [...res.dansRayonTous.keys()].map(id => parId.get(id))
    : v.mode === "parcelle" ? (parParcelle.get(v.id) || []).filter(dansPeriode) : dossiers.filter(dansPeriode);
  document.getElementById("filtre-types").innerHTML = Object.entries(TYPES_COURTS).map(([t, nom]) => `
    <button type="button" class="puce" data-type="${t}" aria-pressed="${etat.types.has(t)}" title="${esc(TYPES[t])}">
      <span class="code">${t}</span><span>${nom}</span><span class="compte">${nombre.format(base.filter(d => d.type === t).length)}</span>
    </button>`).join("");
  document.getElementById("filtre-rayon").hidden = !res;
  document.getElementById("rayons").innerHTML = RAYONS.map(r =>
    `<button type="button" data-rayon="${r}" aria-pressed="${r === etat.rayon}">${r} m</button>`).join("");
}

function initFiltres() {
  const derniere = Math.max(...dossiers.map(d => Number(annee(d.date_autorisation)) || 0));
  const choix = document.getElementById("filtre-depuis");
  for (let a = Number(meta.premiere_annee); a <= derniere; a++) choix.add(new Option(String(a), String(a)));
  etat.depuis = Number(meta.premiere_annee);
  choix.addEventListener("change", () => { etat.depuis = Number(choix.value); rendre(); });
  document.getElementById("filtres").addEventListener("click", e => {
    const puce = e.target.closest(".puce"), rayon = e.target.closest("[data-rayon]");
    if (puce) {
      const t = puce.dataset.type;
      if (etat.types.has(t) && etat.types.size === 1) return;  // au moins un type
      etat.types.has(t) ? etat.types.delete(t) : etat.types.add(t);
      rendre();
    }
    if (rayon) {
      etat.rayon = Number(rayon.dataset.rayon);
      const v = etat.vue;
      rapportAutourDe(v.lon, v.lat, v.libelle, v.precision, v.commune);
    }
  });
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
  choisirAffichage(PETIT_ECRAN.matches ? "liste" : "split");
  document.querySelector(".affichage").addEventListener("click", e => {
    const b = e.target.closest("[data-affichage]");
    if (b) choisirAffichage(b.dataset.affichage);
  });
  PETIT_ECRAN.addEventListener("change", e => { if (e.matches && etat.affichage === "split") choisirAffichage("liste"); });
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
  if (res) lignes.push(["autorisee", "Parcelle avec au moins une autorisation"], ["rayon", `Rayon de ${etat.rayon} m`],
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
    if (el.classList.contains("carte-dossier")) el.setAttribute("aria-pressed", String(choisi));
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

function selectionner(id) {  // clic sur une carte de dossier : sélection, ou désélection si elle l'était déjà
  etat.surligne = etat.surligne === id ? null : id;
  appliquerSurlignage();
  majFiche();
  if (etat.surligne) montrerSurCarte(parId.get(etat.surligne));
}

function montrerSurCarte(d, forcer = false) {  // fait glisser la carte si les parcelles du dossier sont cachées par la fiche ou hors champ
  if (!cartePrete || !carteVisible()) return;
  const bornes = d.actuelles.map(p => toutes.get(p)?.emprise).filter(Boolean);
  if (!bornes.length && d.lon !== null) bornes.push([d.lon, d.lat, d.lon, d.lat]);
  if (!bornes.length) return;
  const b = [Math.min(...bornes.map(e => e[0])), Math.min(...bornes.map(e => e[1])), Math.max(...bornes.map(e => e[2])), Math.max(...bornes.map(e => e[3]))];
  const zone = carte.getContainer().getBoundingClientRect(), fiche = document.getElementById("fiche").getBoundingClientRect();
  const bas = fiche.height && fiche.top < zone.bottom ? zone.bottom - fiche.top + 16 : 40;  // la fiche couvre le bas de la carte
  const [p0, p1] = [carte.project([b[0], b[3]]), carte.project([b[2], b[1]])];  // coins haut-gauche et bas-droit, en pixels
  if (!forcer && p0.x >= 40 && p0.y >= 40 && p1.x <= zone.width - 56 && p1.y <= zone.height - bas) return;
  carte.fitBounds([[b[0], b[1]], [b[2], b[3]]], {padding: {top: 40, right: 56, bottom: bas, left: 40},
    maxZoom: forcer ? 17 : carte.getZoom(), duration: 500});
}

function majFiche() {
  const fiche = document.getElementById("fiche");
  const d = etat.vue?.mode === "rapport" && etat.surligne ? parId.get(etat.surligne) : null;
  fiche.hidden = !d;
  fiche.innerHTML = d ? htmlFiche(d) : "";
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
  let b = meta.emprise, zoomMax = 16;
  if (v?.mode === "parcelle") { b = toutes.get(v.id).emprise; zoomMax = 18; }
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

function initCarte() {
  carte = new maplibregl.Map({
    container: "carte", style: STYLE_PLAN, bounds: meta.emprise, fitBoundsOptions: {padding: 20},
    minZoom: 11, maxZoom: 19.5, attributionControl: false,
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
    carte.addSource("adresses", {type: "geojson", data: `${DONNEES}/adresses.json`});
    carte.addLayer({id: "numeros", type: "symbol", source: "adresses", minzoom: 16.5,  // numéros de rue, pour se repérer
      layout: {"text-field": ["get", "n"], "text-font": ["Source Sans Pro Regular"], "text-size": 11.5},
      paint: {"text-color": "#3d3c39", "text-halo-color": "#ffffff", "text-halo-width": 1.4}});
    cartePrete = true;
    majCarte();
    cadrer();
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");  // sources repliées (bouton i)
  });

  infobulle = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px"});
  carte.on("mousemove", "parcelles-clic", e => {
    const id = e.features[0].properties.id, n = (parParcelle.get(id) || []).filter(visible).length;
    carte.getCanvas().style.cursor = "pointer";
    infobulle.setLngLat(e.lngLat).setHTML(`Parcelle <strong>${esc(nomParcelle(id))}</strong><br>${n ? pluriel(n, "autorisation") : "Aucune autorisation recensée"}`).addTo(carte);
    pointerParcelle(id);
  });
  carte.on("mouseleave", "parcelles-clic", () => { carte.getCanvas().style.cursor = ""; infobulle.remove(); pointerParcelle(null); });
  carte.on("click", "parcelles-clic", e => {  // vue parcelle ; depuis la carte seule, on revient à la liste pour la montrer
    if (etat.affichage === "carte") choisirAffichage(PETIT_ECRAN.matches ? "liste" : "split");
    naviguer({parcelle: e.features[0].properties.id});
  });
}

/* ---------- Navigation (l'état de la vue vit dans l'URL : liens partageables) ---------- */

function naviguer(params) {  // objet de paramètres, ou fragment tel quel ("explorer")
  const h = typeof params === "string" ? params : new URLSearchParams(params).toString();
  if (location.hash.slice(1) === h) lireUrl(); else location.hash = h;
}

const ecranCarte = h => h.has("parcelle") || (h.has("lon") && h.has("lat")) || h.has("explorer");

function montrerEcran(carteVisible) {  // accueil sans carte, ou liste et carte
  const appli = document.getElementById("appli"), accueil = document.getElementById("accueil");
  if (appli.hidden === !carteVisible && accueil.hidden === carteVisible) return;  // déjà affiché
  appli.hidden = !carteVisible;
  accueil.hidden = carteVisible;
  window.scrollTo(0, 0);
}

function lireUrl() {
  const h = new URLSearchParams(location.hash.slice(1));
  const r = Number(h.get("r"));
  if (RAYONS.includes(r)) etat.rayon = r;
  if (h.has("parcelle")) etat.vue = {mode: "parcelle", id: h.get("parcelle")};
  else if (h.has("lon") && h.has("lat")) etat.vue = {mode: "rapport", lon: Number(h.get("lon")), lat: Number(h.get("lat")),
    libelle: h.get("l") || "Point choisi", precision: h.get("p") || "", commune: h.get("c") || ""};
  else if (h.has("explorer")) etat.vue = {mode: "commune"};
  else etat.vue = null;
  montrerEcran(Boolean(etat.vue));
  if (!etat.vue) {  // accueil : contenu fixe, rempli au démarrage
    if (h.has("donnees")) document.getElementById("donnees").scrollIntoView(); else window.scrollTo(0, 0);
    return;
  }
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

/* ---------- Recherche d'adresse (autocomplétion du géocodeur de l'IGN) ---------- */

function initRecherche(form) {  // barre de l'accueil et barre de l'en-tête
  const champ = form.querySelector("input[type=search]"), liste = form.querySelector(".suggestions");
  const [x0, y0, x1, y1] = meta.emprise;
  let suggestions = [], pour = "", actif = -1, minuteur, numero = 0;

  const fermer = () => { liste.hidden = true; champ.setAttribute("aria-expanded", "false"); champ.removeAttribute("aria-activedescendant"); };
  const afficher = () => {
    liste.innerHTML = suggestions.length
      ? suggestions.map((f, i) => `<li role="option" id="${liste.id}-${i}" data-i="${i}" aria-selected="${i === actif}">${esc(f.properties.label)}</li>`).join("")
      : `<li class="aucune" role="option" aria-disabled="true">Aucune adresse trouvée</li>`;
    liste.hidden = false;
    champ.setAttribute("aria-expanded", "true");
    if (actif >= 0) champ.setAttribute("aria-activedescendant", `${liste.id}-${actif}`); else champ.removeAttribute("aria-activedescendant");
  };
  const suggerer = async q => {
    const n = ++numero;
    const url = `${GEOCODEUR}?${new URLSearchParams({q, autocomplete: 1, index: "address", limit: 6, lon: (x0 + x1) / 2, lat: (y0 + y1) / 2})}`;
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (n !== numero) return [];
      suggestions = j.features || [];
      pour = q;
    } catch {
      suggestions = [];
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
    } else if (e.key === "Escape") fermer();
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
  vue.addEventListener("mouseover", e => {  // survol d'une autorisation : ses parcelles en jaune le temps du survol
    const id = e.target.closest("[data-id]")?.dataset.id || null;
    if (cartePrete && id !== etat.survol) { etat.survol = id; appliquerSurlignage(); }
  });
  vue.addEventListener("mouseleave", () => {
    if (cartePrete && etat.survol) { etat.survol = null; appliquerSurlignage(); }
  });
  vue.addEventListener("click", async e => {
    const carteDossier = e.target.closest(".carte-dossier");
    if (carteDossier) { selectionner(carteDossier.dataset.id); return; }
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
    const action = b.dataset.action;
    if (action === "commune") naviguer("explorer");
    if (action === "rayon-parcelle") {
      const id = etat.vue.id, [lon, lat] = centroide(toutes.get(id).geom);
      rapportAutourDe(lon, lat, `Parcelle ${nomParcelle(id)}`, "parcelle", INSEE);
    }
    if (action === "csv") exporterCsv();
    if (action === "imprimer") imprimer();
    if (action === "lien") {
      try { await navigator.clipboard.writeText(location.href); b.textContent = "Lien copié"; }
      catch { b.textContent = "Copie impossible : utilisez la barre d'adresse"; }
    }
  });
  document.getElementById("fiche").addEventListener("click", e => {
    const action = e.target.closest("button")?.dataset.action;
    if (action === "fermer-fiche") selectionner(etat.surligne);
    if (action === "voir-carte") choisirAffichage("carte");
  });
}

/* ---------- Démarrage ---------- */

async function demarrer() {
  montrerEcran(ecranCarte(new URLSearchParams(location.hash.slice(1))));  // l'accueil s'affiche sans attendre les données
  initAffichage();
  const lire = f => fetch(`${DONNEES}/${f}`).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
  try {
    [meta, geoParcelles, geoAnciennes, dossiers] = await Promise.all(["meta.json", "parcelles.json", "anciennes.json", "dossiers.json"].map(lire));
  } catch {
    const erreur = `<p class="alerte">Les données n'ont pas pu être chargées.</p>`;
    document.getElementById("vue").innerHTML = erreur;
    document.querySelector("[data-info=bilan]").outerHTML = erreur;
    return;
  }
  for (const f of geoParcelles.features) {
    toutes.set(f.properties.id, {geom: f.geometry, emprise: emprise(f.geometry), actuelle: true, contenance: f.properties.c});
  }
  for (const f of geoAnciennes.features) {
    const p = f.properties;
    toutes.set(p.id, {geom: f.geometry, emprise: emprise(f.geometry), actuelle: false, premier: p.premier, dernier: p.dernier});
    for (const s of p.successeurs) predecesseurs.set(s, [...(predecesseurs.get(s) || []), p.id]);
  }
  for (const d of dossiers) {
    d.lon = d.lon === "" ? null : Number(d.lon);
    d.lat = d.lat === "" ? null : Number(d.lat);
    parId.set(d.id, d);
    for (const p of d.actuelles) parParcelle.set(p, [...(parParcelle.get(p) || []), d]);
  }
  remplirAccueil();
  initFiltres();
  document.querySelectorAll("form[role=search]").forEach(initRecherche);
  initActions();
  window.addEventListener("hashchange", lireUrl);
  lireUrl();
}

demarrer();
