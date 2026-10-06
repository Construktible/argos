"use strict";
/* Essai Montreuil : curseur avant / après (input range natif : souris, doigt, clavier, lecteurs d'écran).
   Tant qu'on n'y a pas touché, le carré « guette » : la couture va et vient (animation CSS de --position).
   Les questions apparaissent une à une quand le carré entre dans l'écran. Quand la couture dépasse une
   question vers la gauche (seuil propre à chacune, data-seuil), sa réponse apparaît dessous. */

const preuve = document.querySelector(".preuve"), curseur = preuve.querySelector(".curseur");
const paires = [...preuve.querySelectorAll(".paire")];
const calme = matchMedia("(prefers-reduced-motion: reduce)").matches;

function poser(v) {
  preuve.style.setProperty("--position", `${v}%`);
  paires.forEach(p => p.classList.toggle("repondue", v < Number(p.dataset.seuil)));
  curseur.setAttribute("aria-valuetext", v >= 97 ? "Avant seulement" : v <= 3 ? "Après seulement"
    : `Autorisations révélées sur ${Math.round(100 - v)} % du plan`);
}

function prendre() { preuve.classList.remove("guette"); }
curseur.addEventListener("pointerdown", () => { prendre(); preuve.classList.add("glisse"); });
addEventListener("pointerup", () => preuve.classList.remove("glisse"));
curseur.addEventListener("input", () => { prendre(); poser(Number(curseur.value)); });
poser(Number(curseur.value));

if (!calme && "IntersectionObserver" in window) {
  paires.forEach(p => p.classList.add("cachee"));
  new IntersectionObserver((entrees, obs) => {
    if (!entrees[0].isIntersecting) return;
    obs.disconnect();
    paires.forEach(p => p.classList.remove("cachee"));
    preuve.classList.add("guette");
  }, {threshold: .5}).observe(preuve);
}
