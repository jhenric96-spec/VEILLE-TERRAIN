/* VEILLE TERRAIN : saisie hors ligne de formulaires issus de KoboToolbox.
   Aucune dépendance. Les fiches sont stockées dans IndexedDB sur l'appareil
   et envoyées vers une Google Sheet (serveur/Code.gs) quand le réseau est là. */
'use strict';

const VERSION_APP = '1.17.5';
const AGE_MAX_HISTORIQUE_JOURS = 120;
const VERSION_SERVEUR_MIN = 2.0;   // version minimale de serveur/Code.gs (magasins, appareils, prix du marché)
const TYPES_META = new Set(['start', 'end', 'today', 'deviceid', 'username', 'phonenumber', 'audit', 'calculate', 'begin_group', 'end_group', 'begin_repeat', 'end_repeat']);

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function h(tag, attrs, ...enfants) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat(Infinity)) if (e != null && e !== false) el.append(e.nodeType ? e : String(e));
  return el;
}

const vide = v => v == null || v === '';
const sansAccents = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nombre = s => Number(String(s).replace(/[\s.]/g, ''));
const nomMarque = l => String(l || '').replace(/^PRESENCE\s+/i, '');
const maintenant = () => new Date().toISOString();
const aujourdhui = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

let toastTimer;
function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), ms);
}

const Reglages = {
  lire() { try { return JSON.parse(localStorage.getItem('ct-reglages')) || {}; } catch (e) { return {}; } },
  ecrire(r) { try { localStorage.setItem('ct-reglages', JSON.stringify(r)); } catch (e) { /* stockage indisponible */ } },
  maj(fn) { const r = this.lire(); fn(r); this.ecrire(r); return r; },
};

function idAppareil() {
  let r = Reglages.lire();
  if (!r.appareil) r = Reglages.maj(x => { x.appareil = 'APP-' + uuid().slice(0, 6).toUpperCase(); });
  return r.appareil;
}

/* ------------------------------------------------------------------ */
/* Stockage local (IndexedDB)                                          */
/* ------------------------------------------------------------------ */

const DB = (() => {
  let ouverture;
  function ouvrir() {
    if (!ouverture) ouverture = new Promise((res, rej) => {
      const r = indexedDB.open('collecte-terrain', 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('fiches')) db.createObjectStore('fiches', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('historique')) db.createObjectStore('historique', { keyPath: 'cle' });
        if (!db.objectStoreNames.contains('divers')) db.createObjectStore('divers', { keyPath: 'cle' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return ouverture;
  }
  async function tx(magasin, mode, fn) {
    const db = await ouvrir();
    return new Promise((res, rej) => {
      const t = db.transaction(magasin, mode);
      const req = fn(t.objectStore(magasin));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    mettre: f => tx('fiches', 'readwrite', s => s.put(f)),
    lire: id => tx('fiches', 'readonly', s => s.get(id)),
    supprimer: id => tx('fiches', 'readwrite', s => s.delete(id)),
    tout: () => tx('fiches', 'readonly', s => s.getAll()),
    // Dernière visite connue de chaque point de vente (clé : « form|CANAL/ENSEIGNE/MAGASIN »)
    histMettre: liste => tx('historique', 'readwrite', s => { liste.forEach(x => s.put(x)); return null; }),
    histLire: cle => tx('historique', 'readonly', s => s.get(cle)),
    histTout: () => tx('historique', 'readonly', s => s.getAll()),
    // Données de référence (catalogue produits…)
    diversLire: cle => tx('divers', 'readonly', s => s.get(cle)).then(x => x && x.valeur),
    diversMettre: (cle, valeur) => tx('divers', 'readwrite', s => s.put({ cle, valeur })),
  };
})();

/* ------------------------------------------------------------------ */
/* Moteur de formulaire                                                */
/* ------------------------------------------------------------------ */

// Traduit une condition Kobo/XLSForm (« ${A} = 'oui' or ${B} >= 1 ») en fonction JS.
function compiler(expr) {
  if (!expr) return null;
  const js = expr
    .replace(/selected\(\s*\$\{(\w+)\}\s*,\s*('[^']*'|"[^"]*")\s*\)/g, 'sel(v("$1"),$2)')
    .replace(/\$\{(\w+)\}/g, 'v("$1")')
    .replace(/\bor\b/g, '||')
    .replace(/\band\b/g, '&&')
    .replace(/\bnot\s*\(/g, '!(')
    .replace(/(^|[^<>!=])=(?!=)/g, '$1==');
  try { return new Function('v', 'sel', 'return (' + js + ');'); }
  catch (e) { console.warn('Condition non reconnue :', expr); return null; }
}
const sel = (val, opt) => (' ' + (val || '') + ' ').includes(' ' + opt + ' ');

function titreSection(lib) {
  let t = String(lib || '').replace(/^\s*FACING\s+TOTAL\s*:?\s*/i, '');
  if (t.includes(' - ')) t = t.split(' - ').pop();
  return t.replace(/\(.*?\)/g, '')
    .replace(/\b\d+([.,]\d+)?\s*(CL|ML|L)\b/gi, '')
    .replace(/(\+\s*)+/g, '+ ')
    .replace(/^[\s+]+|[\s+]+$/g, '')
    .replace(/^FORMAT\s+/i, '')
    .replace(/\s{2,}/g, ' ') || 'Section';
}

// Aplatit la cascade CANAL → ENSEIGNE → MAGASIN en une seule liste de points de vente.
function construireCascade(entete, listes) {
  const sels = entete.filter(c => c.t === 'select_one');
  const parNom = Object.fromEntries(sels.map(c => [c.n, c]));
  sels.forEach(c => {
    const m = c.rel && c.rel.match(/^\s*\$\{(\w+)\}\s*=\s*'([^']*)'\s*$/);
    if (m && parNom[m[1]]) { c.cParent = m[1]; c.cVal = m[2]; }
  });
  const racine = sels.find(c => !c.cParent && sels.some(e => e.cParent === c.n));
  if (!racine) return null;
  const options = [], membres = new Set([racine.n]);
  let feuille = racine;
  (function descendre(champ, chemin) {
    for (const [code, lib] of listes[champ.liste] || []) {
      const pas = chemin.concat([[champ.n, code, lib]]);
      const enfants = sels.filter(e => e.cParent === champ.n && e.cVal === code);
      if (!enfants.length) options.push(pas);
      else enfants.forEach(e => { membres.add(e.n); feuille = e; descendre(e, pas); });
    }
  })(racine, []);
  options.forEach(o => { o.cle = sansAccents(o.map(p => p[2]).join(' ')); });
  options.sort((a, b) => a[a.length - 1][2].localeCompare(b[b.length - 1][2], 'fr'));
  membres.forEach(n => { parNom[n].casc = true; });
  return { racine, options, membres: [...membres], titre: feuille.l || 'Point de vente' };
}

function preparer(def) {
  const champs = def.champs
    .filter(c => !['begin_group', 'end_group', 'begin_repeat', 'end_repeat'].includes(c.t))
    .map((c, i) => Object.assign({}, c, { i, relFn: compiler(c.rel), enfants: [] }));
  const index = Object.fromEntries(champs.map(c => [c.n, c]));
  const listes = def.listes;
  const estOuiNon = l => { const x = listes[l]; return !!x && x.length === 2 && sansAccents(x[0][0]) === 'oui'; };

  champs.forEach(c => {
    c.ouiNon = c.t === 'select_one' && estOuiNon(c.liste);
    if (c.ouiNon) { c.vOui = listes[c.liste][0][0]; c.vNon = listes[c.liste][1][0]; }
    if (c.t === 'integer' || c.t === 'decimal') {
      const aide = c.h || '';
      const p = aide.match(/entre\s*<?\s*(\d[\d\s.]*?)\s*F?\s*et\s*(\d[\d\s.]*?)\s*F/i);
      if (p) c.plage = [nombre(p[1]), nombre(p[2])];
      const k = aide.match(/CONSEILL\w*\s*:?\s*(\d[\d\s.]*?)\s*F/i);
      if (k) c.conseil = nombre(k[1]);
    }
    if (c.rel && /\bor\b/.test(c.rel)) c.refs = [...c.rel.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
  });
  // Rattachement « produit → marque » : un champ affiché seulement si un OUI/NON vaut « oui ».
  champs.forEach(c => {
    const m = c.rel && c.rel.match(/^\s*\$\{(\w+)\}\s*=\s*'([^']*)'\s*$/);
    const p = m && index[m[1]];
    if (p && p.ouiNon && m[2] === p.vOui) { c.parent = p.n; p.enfants.push(c); }
  });

  // Découpage en étapes : identification, puis un rayon par groupe de « FACING TOTAL ».
  const debut = champs.findIndex(c => c.ouiNon);
  const k = debut < 0 ? champs.length : debut;
  const entete = champs.slice(0, k).filter(c => !TYPES_META.has(c.t));
  const cascade = construireCascade(entete, listes);
  const sections = [{ titre: 'Identification', champs: entete, entete: true }];
  const estFermeur = c => (c.t === 'integer' || c.t === 'decimal') && c.refs;
  const reste = champs.slice(k).filter(c => !TYPES_META.has(c.t));
  let cour = [], premierFermeur = null;
  reste.forEach((c, j) => {
    cour.push(c);
    if (estFermeur(c)) {
      premierFermeur = premierFermeur || c;
      const suiv = reste[j + 1];
      if (!suiv || !estFermeur(suiv)) { sections.push({ titre: titreSection(premierFermeur.l), champs: cour }); cour = []; premierFermeur = null; }
    }
  });
  if (cour.length) sections.push({ titre: cour.some(c => c.t === 'image') ? 'ÉQUIPEMENTS ET PHOTOS' : 'COMPLÉMENTS', champs: cour });
  sections.forEach((s, i) => { s.i = i; s.champs.forEach(c => { c.section = i; }); });

  // Unités de confirmation : une marque, un produit isolé, ou des produits voisins de même marque
  // (ex. les références CANDIA du lait blanc), regroupés pour ne demander qu'un « Conforme ».
  const estProduitSeul = c => c.ouiNon && !c.rel && !c.enfants.some(e => e.ouiNon);
  const premierMot = c => nomMarque(c.l).split(/\s+/)[0].toUpperCase();
  const affecter = (c, u) => { c.unite = u; c.enfants.forEach(e => affecter(e, u)); };
  sections.forEach(s => {
    s.unites = [];
    const haut = s.champs.filter(c => !c.parent && !c.casc);
    for (let j = 0; j < haut.length; j++) {
      const c = haut[j];
      if (estProduitSeul(c)) {
        const lot = [c];
        while (haut[j + 1] && estProduitSeul(haut[j + 1]) && premierMot(haut[j + 1]) === premierMot(c)) lot.push(haut[++j]);
        if (lot.length > 1) {
          const u = { id: 'v_' + c.n, titre: premierMot(c), champs: lot, virtuel: true };
          lot.forEach(x => affecter(x, u.id));
          s.unites.push(u);
          continue;
        }
      }
      affecter(c, c.n);
      s.unites.push({ id: c.n, champs: [c] });
    }
  });

  return { def, cle: def.cle, titre: def.titre, version: def.version, champs, index, listes, sections, cascade };
}

// Champs repris d'une visite à l'autre : les relevés des rayons, jamais l'identification, le GPS ni les photos.
const TYPES_REPRIS = new Set(['select_one', 'select_multiple', 'integer', 'decimal', 'text']);
const estRepris = c => c.section > 0 && TYPES_REPRIS.has(c.t);

function clePdv(F, valeurs) {
  const o = optionCascade(F, valeurs);
  return o ? o.map(p => p[1]).join('/') : null;
}

function visibilite(F, valeurs) {
  const vis = {};
  const v = n => (vis[n] ? (valeurs[n] ?? '') : '');
  for (const c of F.champs) {
    let ok = c.parent ? vis[c.parent] : true;
    if (ok && c.relFn) { try { ok = !!c.relFn(v, sel); } catch (e) { ok = true; } }
    vis[c.n] = ok;
  }
  return vis;
}

function manquants(F, valeurs, vis) {
  return F.champs.filter(c => c.req && vis[c.n] && !TYPES_META.has(c.t) && c.t !== 'note' && vide(valeurs[c.n]));
}

function libelle(F, c, code) {
  const x = (F.listes[c.liste] || []).find(o => String(o[0]) === String(code));
  return x ? x[1] : code;
}

function optionCascade(F, valeurs) {
  const K = F.cascade;
  if (!K) return null;
  return K.options.find(o => o.every(([n, code]) => valeurs[n] === code)) || null;
}

function resume(F, fiche) {
  const o = optionCascade(F, fiche.valeurs);
  const ent = F.sections[0].champs.find(c => c.t === 'select_one' && !c.casc && !vide(fiche.valeurs[c.n]));
  const date = F.sections[0].champs.find(c => c.t === 'date');
  return {
    titre: o ? o[o.length - 1][2] : 'Point de vente non choisi',
    detail: [date && fiche.valeurs[date.n], ent && libelle(F, ent, fiche.valeurs[ent.n])].filter(Boolean).join(' · '),
  };
}

// Ligne d'export au format des exports Kobo (mêmes noms de colonnes, libellés des choix).
function ligneExport(F, fiche) {
  const vis = visibilite(F, fiche.valeurs);
  const entetes = ['_id', '_soumis_le', '_appareil', '_version_formulaire', '_prerempli_depuis', '_prerempli_inchange_pct'];
  const ligne = { _id: fiche.id, _soumis_le: fiche.finaliseLe || '', _appareil: fiche.appareil || '', _version_formulaire: F.version || '',
    _prerempli_depuis: '', _prerempli_inchange_pct: '' };
  // Supervision : part des valeurs reprises de la visite précédente et laissées telles quelles.
  if (fiche.prerempli) {
    const repris = Object.keys(fiche.prerempli.champs).filter(n => vis[n]);
    const inchanges = repris.filter(n => String(fiche.valeurs[n] ?? '') === String(fiche.prerempli.champs[n]));
    ligne._prerempli_depuis = fiche.prerempli.date || '';
    ligne._prerempli_inchange_pct = repris.length ? Math.round(100 * inchanges.length / repris.length) : '';
  }
  for (const c of F.champs) {
    if (c.t === 'note') continue;
    entetes.push(c.n);
    const brut = vis[c.n] ? fiche.valeurs[c.n] : '';
    let val = brut ?? '';
    if (!vide(brut)) {
      if (c.t === 'select_one') val = libelle(F, c, brut);
      else if (c.t === 'select_multiple') val = String(brut).split(' ').map(x => libelle(F, c, x)).join(' ');
      else if (c.t === 'integer' || c.t === 'decimal') val = Number(brut);
    }
    ligne[c.n] = val;
    if (c.t === 'geopoint') {
      const p = String(brut || '').split(' ');
      ['latitude', 'longitude', 'altitude', 'precision'].forEach((s, i) => {
        const k = `_${c.n}_${s}`;
        entetes.push(k);
        ligne[k] = vide(p[i]) ? '' : Number(p[i]);
      });
    }
  }
  return { entetes, ligne };
}

/* ------------------------------------------------------------------ */
/* Historique des visites (préremplissage)                             */
/* ------------------------------------------------------------------ */

// Convertit une visite (codes Kobo, ou libellés de la Google Sheet) en valeurs de l'application.
function normaliser(F, brut, libelles) {
  const valeurs = {};
  for (const c of F.champs) {
    const v = brut[c.n];
    if (vide(v)) continue;
    if (c.t === 'select_one') {
      const liste = F.listes[c.liste] || [];
      const o = liste.find(x => String(libelles ? x[1] : x[0]) === String(v)) || liste.find(x => String(x[0]) === String(v));
      if (o) valeurs[c.n] = o[0];
    } else if (c.t === 'integer' || c.t === 'decimal') {
      const n = Number(String(v).replace(',', '.'));
      if (!isNaN(n)) valeurs[c.n] = n;
    } else valeurs[c.n] = String(v);
  }
  return valeurs;
}

function auteur(F, valeurs) {
  const c = F.sections[0].champs.find(x => x.t === 'select_one' && !x.casc && !vide(valeurs[x.n]));
  return c ? libelle(F, c, valeurs[c.n]) : '';
}

// Ne garde que la visite la plus récente de chaque point de vente.
async function importerHistorique(F, { seed, lignes }) {
  const entrees = [];
  for (const v of (seed && seed.visites) || []) entrees.push({ valeurs: normaliser(F, v.valeurs, false), date: v.date, source: 'Kobo' });
  for (const l of lignes || []) entrees.push({ valeurs: normaliser(F, l, true), date: l.DATE || String(l._soumis_le || '').slice(0, 10), source: 'serveur' });
  const plusRecentes = {};
  for (const e of entrees) {
    const k = clePdv(F, e.valeurs);
    if (!k || !e.date) continue;
    if (!plusRecentes[k] || e.date > plusRecentes[k].date) plusRecentes[k] = e;
  }
  const existants = Object.fromEntries((await DB.histTout()).filter(x => x.form === F.cle).map(x => [x.magasin, x]));
  const aEcrire = [];
  for (const k in plusRecentes) {
    const e = plusRecentes[k];
    if (existants[k] && existants[k].date > e.date) continue;
    aEcrire.push({ cle: `${F.cle}|${k}`, form: F.cle, magasin: k, date: e.date, par: auteur(F, e.valeurs), source: e.source, valeurs: e.valeurs });
  }
  await DB.histMettre(aEcrire);
  return Object.keys(plusRecentes).length;
}

// Dernière visite d'un point de vente : historique téléchargé ou fiches déjà faites sur cet appareil.
async function derniereVisite(F, cle, exclureId) {
  const candidats = [];
  const h0 = await DB.histLire(`${F.cle}|${cle}`);
  if (h0) candidats.push(h0);
  const dateChamp = F.sections[0].champs.find(c => c.t === 'date');
  for (const f of await DB.tout()) {
    if (f.id === exclureId || f.form !== F.cle || f.statut === 'brouillon' || clePdv(F, f.valeurs) !== cle) continue;
    candidats.push({ date: (dateChamp && f.valeurs[dateChamp.n]) || String(f.finaliseLe || '').slice(0, 10), par: auteur(F, f.valeurs), valeurs: f.valeurs, source: 'appareil', finaliseLe: f.finaliseLe });
  }
  candidats.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.source === 'appareil') - (a.source === 'appareil'));
  // Une visite trop ancienne induirait en erreur plus qu'elle n'aiderait.
  const limite = new Date(Date.now() - AGE_MAX_HISTORIQUE_JOURS * 86400000).toISOString().slice(0, 10);
  return candidats[0] && candidats[0].date >= limite ? candidats[0] : null;
}

async function telechargerHistorique({ force = false, silencieux = true } = {}) {
  const r = Reglages.lire();
  if (!r.url || !navigator.onLine) { if (!silencieux) toast('Serveur non configuré ou pas de réseau'); return; }
  // Le fichier pèse environ 1 Mo : une mise à jour toutes les 6 heures suffit.
  if (!force && r.histMaj && Date.now() - new Date(r.histMaj) < 6 * 3600 * 1000) return;
  try {
    let total = 0;
    for (const cle in FORMS) {
      const F = FORMS[cle];
      const j = await appelServeur(r.url, { action: 'historique', jeton: r.jeton, formulaire: F.cle, titre: F.titre });
      if (!j.ok) throw new Error(j.erreur || 'refus du serveur');
      total += await importerHistorique(F, j);
    }
    // Rien reçu (serveur encore vide) : on retentera à la prochaine synchronisation au lieu d'attendre 6 heures
    if (total > 0) Reglages.maj(x => { x.histMaj = maintenant(); });
    if (!silencieux) toast(`Historique mis à jour : ${total} point(s) de vente`);
  } catch (e) { if (!silencieux) toast('Historique non téléchargé : ' + e.message, 6000); }
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

const FORMS = {};
for (const cle in (window.FORMULAIRES || {})) FORMS[cle] = preparer(window.FORMULAIRES[cle]);

const racineApp = document.getElementById('app');
let E = null;              // fiche en cours d'édition
let ongletAccueil = 'brouillon';

function vider() { racineApp.replaceChildren(); window.scrollTo(0, 0); }
// Rafraîchit l'accueil seulement s'il est à l'écran (pas pendant une fiche, un recensement ou les paramètres).
const accueilAffiche = () => !E && !!racineApp.querySelector('main.accueil');

/* ---------- Accueil ---------- */

async function afficherAccueil() {
  E = null;
  const estVeille = f => window.Veille && f.form === Veille.FORM;
  const fiches = (await DB.tout()).filter(f => FORMS[f.form] || estVeille(f)).sort((a, b) => (b.modifieLe || '').localeCompare(a.modifieLe || ''));
  const parStatut = s => fiches.filter(f => f.statut === s);
  const r = Reglages.lire();
  vider();

  const enLigne = navigator.onLine;
  racineApp.append(
    h('header', { class: 'barre' },
      h('div', { class: 'barre-titre' },
        h('span', { class: 'logo' }, h('img', { src: 'logo-siagro.png', alt: 'SIAGRO' })),
        h('strong', {}, 'VEILLE TERRAIN'),
        h('span', { class: 'pastille ' + (enLigne ? 'ok' : 'off') }, enLigne ? 'En ligne' : 'Hors ligne')),
      h('button', { class: 'btn-icone', 'aria-label': 'Paramètres (code requis)', onclick: ouvrirReglages }, '⚙')),
  );

  const main = h('main', { class: 'accueil' });
  racineApp.append(main);

  if (!r.url) main.append(h('div', { class: 'bandeau' }, 'Téléphone non connecté : les fiches restent sur cet appareil. '
    + 'Scannez le QR code de connexion fourni par votre responsable. ',
    h('button', { class: 'btn petit', onclick: collerLienConnexion }, '📋 Coller le lien de connexion'), ' ',
    h('button', { class: 'lien', onclick: ouvrirReglages }, 'Responsable : configurer')));
  const bandeauIos = bandeauInstallationIphone(r);
  if (bandeauIos) main.append(bandeauIos);

  // La veille GMS sur catalogue remplace le formulaire Kobo « gms », gardé pour la liste des magasins et l'historique.
  if (window.Veille) main.append(await Veille.carte());
  for (const cle in FORMS) {
    const F = FORMS[cle];
    if (window.Veille && cle === 'gms') continue;
    main.append(h('section', { class: 'carte-form' },
      h('div', {}, h('h2', {}, F.titre),
        h('p', { class: 'discret' }, `${F.champs.length} questions · ${F.sections.length} étapes`)),
      h('button', { class: 'btn primaire', onclick: () => nouvelleFiche(cle) }, '+ Nouvelle fiche')));
  }
  if (!Object.keys(FORMS).length) main.append(h('p', {}, 'Aucun formulaire chargé.'));
  if (window.Recensement) main.append(await Recensement.carte());

  const onglets = [['brouillon', 'Brouillons'], ['finalisee', 'À envoyer'], ['envoyee', 'Envoyées']];
  main.append(h('div', { class: 'onglets', role: 'tablist' }, onglets.map(([s, lib]) =>
    h('button', { role: 'tab', class: s === ongletAccueil ? 'actif' : '', 'aria-selected': String(s === ongletAccueil),
      onclick: () => { ongletAccueil = s; afficherAccueil(); } }, `${lib} (${parStatut(s).length})`))));

  const liste = h('ul', { class: 'liste-fiches' });
  const visibles = parStatut(ongletAccueil);
  if (!visibles.length) liste.append(h('li', { class: 'vide' }, 'Aucune fiche.'));
  for (const f of visibles) {
    const F = estVeille(f) ? { titre: Veille.TITRE } : FORMS[f.form];
    if (!F) continue;
    const s = estVeille(f) ? Veille.resume(f) : resume(F, f);
    const ouvrir = () => (estVeille(f) ? Veille.ouvrir(f.id) : ouvrirFiche(f.id));
    const actions = [];
    if (f.statut !== 'envoyee') actions.push(h('button', { class: 'btn', onclick: ouvrir }, f.statut === 'brouillon' ? 'Continuer' : 'Modifier'));
    if (f.statut === 'brouillon') actions.push(h('button', { class: 'btn danger', onclick: async () => {
      if (confirm(`Supprimer le brouillon « ${s.titre} » ?`)) { await DB.supprimer(f.id); afficherAccueil(); }
    } }, 'Supprimer'));
    liste.append(h('li', {},
      h('div', { class: 'fiche-info' }, h('strong', {}, s.titre), h('span', { class: 'discret' }, `${F.titre} · ${s.detail}`)),
      h('div', { class: 'fiche-actions' }, actions)));
  }
  main.append(liste);

  const aEnvoyer = parStatut('finalisee').length + (window.Recensement ? await Recensement.nbAEnvoyer() : 0);   // les visites sont dans parStatut
  main.append(h('div', { class: 'actions-bas' },
    h('button', { class: 'btn primaire', disabled: !aEnvoyer, onclick: () => synchroniser() }, `Envoyer (${aEnvoyer})`)));
  if (aEnvoyer && r.url) main.append(h('p', { class: 'discret centre etat-envoi' }, !navigator.onLine
    ? `Hors ligne : ${aEnvoyer} fiche(s) partiront automatiquement au retour du réseau.`
    : r.envoiEchec ? `Envoi automatique en attente (${r.envoiEchec.message}) : nouvel essai toutes les 2 minutes.`
      : `${aEnvoyer} fiche(s) en cours d'envoi automatique.`));
  if (r.dernierEnvoi) main.append(h('p', { class: 'discret centre' }, `Dernier envoi : ${new Date(r.dernierEnvoi).toLocaleString('fr-FR')}`));
}

/* ---------- Paramètres ---------- */

/* Verrou des paramètres : seul le responsable y accède. Le code n'est jamais stocké en clair :
   seule son empreinte PBKDF2-SHA256 figure ici (pour la changer : outils\changer-code-parametres.ps1). */
const VERROU = { sel: '232e4e7cbdda44c040da061c2ce86655', iterations: 150000, empreinte: 'ad935e8fe0c9dd7c005545b1105a8b8c908d7832085e252e393940d276fd21dd' };
const DUREE_DEVERROUILLAGE = 60 * 1000;   // reste ouvert 1 minute, jamais mémorisé au-delà de la session
let deverrouilleJusqua = 0, essaisRates = 0, bloqueJusqua = 0;

async function empreinteCode(code) {
  const octets = new Uint8Array(VERROU.sel.match(/../g).map(x => parseInt(x, 16)));
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: octets, iterations: VERROU.iterations }, cle, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function ouvrirReglages() {
  if (Date.now() < deverrouilleJusqua) return afficherReglages();
  if (!(window.crypto && crypto.subtle)) return toast('Paramètres indisponibles : ouvrez l\'application par son adresse https', 6000);
  const champ = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Code des paramètres', 'aria-label': 'Code des paramètres' });
  const erreur = h('small', { class: 'avert', hidden: true });
  // Afficher / masquer le code saisi, pour éviter les fautes de frappe
  const voir = h('button', { type: 'button', class: 'btn voir-code', 'aria-label': 'Afficher le code', 'aria-pressed': 'false', onclick: () => {
    const visible = champ.type === 'password';
    champ.type = visible ? 'text' : 'password';
    voir.textContent = visible ? '🙈 Masquer' : '👁 Afficher';
    voir.setAttribute('aria-label', visible ? 'Masquer le code' : 'Afficher le code');
    voir.setAttribute('aria-pressed', String(visible));
    champ.focus();
  } }, '👁 Afficher');
  const valider = async () => {
    if (Date.now() < bloqueJusqua) {
      erreur.hidden = false; erreur.textContent = `Trop d'essais : réessayez dans ${Math.ceil((bloqueJusqua - Date.now()) / 1000)} s.`;
      return;
    }
    const ok = (await empreinteCode(champ.value)) === VERROU.empreinte;
    if (ok) {
      essaisRates = 0; deverrouilleJusqua = Date.now() + DUREE_DEVERROUILLAGE;
      voile.remove(); afficherReglages();
      return;
    }
    essaisRates++;
    if (essaisRates >= 5) { bloqueJusqua = Date.now() + 60000; essaisRates = 0; }
    erreur.hidden = false;
    erreur.textContent = Date.now() < bloqueJusqua ? 'Code incorrect. Trop d\'essais : patientez 1 minute.' : 'Code incorrect.';
    champ.value = ''; champ.focus();
  };
  champ.addEventListener('keydown', ev => { if (ev.key === 'Enter') valider(); });
  const voile = h('div', { class: 'voile centre' },
    h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Paramètres verrouillés' },
      h('h3', {}, '🔒 Paramètres verrouillés'),
      h('div', { class: 'mot-de-passe' }, champ, voir),
      erreur,
      h('div', { class: 'actions-bas' },
        h('button', { class: 'btn', onclick: () => voile.remove() }, 'Annuler'),
        h('button', { class: 'btn primaire', onclick: valider }, 'Déverrouiller'))));
  document.body.append(voile);
  setTimeout(() => champ.focus(), 50);
}

function verrouillerReglages() { deverrouilleJusqua = 0; toast('Paramètres verrouillés 🔒'); afficherAccueil(); }

function afficherReglages() {
  const r = Reglages.lire();
  vider();
  const champ = (id, lib, val, aide, type = 'text') => h('label', { class: 'champ' },
    h('span', { class: 'champ-lib' }, lib), h('input', { id, type, value: val || '', autocomplete: 'off' }),
    aide ? h('small', { class: 'discret' }, aide) : null);
  racineApp.append(
    h('header', { class: 'barre' }, h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: afficherAccueil }, '←'),
      h('div', { class: 'barre-titre' }, h('strong', {}, 'Paramètres')),
      h('button', { class: 'btn-icone', 'aria-label': 'Verrouiller les paramètres', title: 'Verrouiller', onclick: verrouillerReglages }, '🔒')),
    h('main', { class: 'reglages' },
      champ('r-url', 'Adresse du serveur (Google Apps Script)', r.url, 'URL se terminant par /exec, fournie par l\'administrateur.', 'url'),
      champ('r-jeton', 'Clé d\'accès', r.jeton, 'Même valeur que JETON dans le script serveur.'),
      champ('r-app', 'Nom de cet appareil', idAppareil(), 'Permet de savoir d\'où vient chaque fiche (ex. TEL-ALE-DIOP).'),
      h('div', { class: 'actions-bas' },
        h('button', { class: 'btn primaire', onclick: () => {
          Reglages.maj(x => {
            x.url = document.getElementById('r-url').value.trim();
            x.jeton = document.getElementById('r-jeton').value.trim();
            x.appareil = document.getElementById('r-app').value.trim() || x.appareil;
          });
          toast('Paramètres enregistrés'); afficherAccueil();
        } }, 'Enregistrer'),
        h('button', { class: 'btn', onclick: testerServeur }, 'Tester la connexion')),
      blocQrConnexion(r),
      blocReferentiels(r),
      h('hr'),
      h('h3', {}, 'Facings (Veille GMS)'),
      h('label', { class: 'case' }, h('input', { type: 'radio', name: 'facing', checked: (r.facingMode || 'photo') === 'photo',
        onchange: () => { Reglages.maj(x => { x.facingMode = 'photo'; }); toast('Facings : calculés à partir des photos'); } }),
        ' Calculés à partir des photos du rayon (le merchandiser ne saisit que les prix)'),
      h('label', { class: 'case' }, h('input', { type: 'radio', name: 'facing', checked: r.facingMode === 'saisie',
        onchange: () => { Reglages.maj(x => { x.facingMode = 'saisie'; }); toast('Facings : saisis par le merchandiser'); } }),
        ' Saisis par le merchandiser'),
      h('hr'),
      h('h3', {}, 'Analyse des photos par l\'IA'),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: r.iaPhotos !== false,
        onchange: ev => { Reglages.maj(x => { x.iaPhotos = ev.target.checked; delete x.iaIndispo; }); toast(ev.target.checked ? 'Analyse IA activée' : 'Analyse IA désactivée'); } }),
        ' Proposer la liste des produits à partir des photos du rayon (en ligne)'),
      h('small', { class: 'aide' }, 'Chaque photo est analysée par le serveur : produits reconnus, facings et prix lisibles sont proposés, '
        + 'le merchandiser vérifie et corrige. Sans réseau, la saisie reste classique.'),
      h('hr'),
      h('button', { class: 'btn danger', onclick: async () => {
        const env = (await DB.tout()).filter(f => f.statut === 'envoyee');
        if (!env.length) return toast('Aucune fiche envoyée à nettoyer');
        if (confirm(`Retirer de l'appareil ${env.length} fiche(s) déjà envoyée(s) ? Elles restent sur le serveur.`)) {
          for (const f of env) await DB.supprimer(f.id);
          toast('Appareil nettoyé');
        }
      } }, 'Retirer les fiches envoyées de l\'appareil'),
      h('hr'),
      h('h3', {}, 'Historique des visites'),
      h('p', { class: 'discret', id: 'r-hist' }, '…'),
      h('div', { class: 'actions-bas' },
        h('button', { class: 'btn', onclick: async () => {
          if (window.Recensement) await Recensement.telechargerCatalogue({ silencieux: false });
          await telechargerHistorique({ force: true, silencieux: false });
          if (window.Veille) await Veille.telechargerHistorique({ force: true });
          majEtatHistorique();
        } }, 'Mettre à jour depuis le serveur'),
        h('label', { class: 'btn' }, 'Importer un fichier…',
          h('input', { type: 'file', accept: '.json,application/json', class: 'masque', onchange: async ev => {
            const fichier = ev.target.files[0];
            if (!fichier) return;
            try {
              const texte = await fichier.text();
              const seed = JSON.parse(texte);
              if (seed.type === 'catalogue' && window.Recensement) {
                const k = await Recensement.importerCatalogue(seed.produits);
                toast(`Catalogue importé : ${k} référence(s)`);
                ev.target.value = '';
                return;
              }
              const F = FORMS[seed.form];
              if (!F) throw new Error(`formulaire « ${seed.form} » inconnu`);
              const n = await importerHistorique(F, { seed });
              // Envoyé aussi au serveur : préremplissage des autres téléphones, prix du marché et coordonnées GPS des magasins
              const r = Reglages.lire();
              let envoi = '';
              if (r.url && navigator.onLine) {
                try {
                  const j = await appelServeur(r.url, { action: 'deposerHistorique', jeton: r.jeton, formulaire: seed.form, titre: F.titre, contenu: texte });
                  envoi = j.ok ? ' et envoyé au serveur ✓' : ` (non envoyé au serveur : ${j.erreur})`;
                } catch (e) { envoi = ` (non envoyé au serveur : ${e.message})`; }
              }
              toast(`Historique importé : ${n} point(s) de vente${envoi}`, 7000);
            } catch (e) { toast('Fichier refusé : ' + e.message, 6000); }
            ev.target.value = '';
            majEtatHistorique();
          } }))),
      h('hr'),
      h('p', { class: 'discret' }, `Version ${VERSION_APP} · ` + Object.values(FORMS).map(F => `${F.titre} (${F.def.importeLe || ''})`).join(', '))));
  majEtatHistorique();
}

async function majEtatHistorique() {
  const el = document.getElementById('r-hist');
  if (!el) return;
  const liste = await DB.histTout();
  const r = Reglages.lire();
  const plusRecente = liste.reduce((m, x) => (x.date > m ? x.date : m), '');
  el.textContent = liste.length
    ? `${liste.length} point(s) de vente connus, visite la plus récente le ${dateFr(plusRecente)}.` + (r.histMaj ? ` Mis à jour le ${new Date(r.histMaj).toLocaleString('fr-FR')}.` : '')
    : 'Aucun historique : les fiches ne seront pas préremplies (sauf magasins déjà visités avec cet appareil).';
}

// Diagnostic détaillé : identifie la cause la plus probable et dit quoi corriger.
async function testerServeur() {
  const url = document.getElementById('r-url').value.trim();
  const jeton = document.getElementById('r-jeton').value.trim();
  let zone = document.getElementById('r-diagnostic');
  if (!zone) {
    zone = h('div', { id: 'r-diagnostic', class: 'diagnostic' });
    document.getElementById('r-jeton').closest('.champ').after(zone);
  }
  const afficher = (ok, titre, ...conseils) => {
    zone.className = 'diagnostic ' + (ok ? 'ok' : 'ko');
    const utiles = conseils.filter(Boolean);
    zone.replaceChildren(...[h('strong', {}, titre), utiles.length ? h('ul', {}, utiles.map(c => h('li', {}, c))) : null].filter(Boolean));
  };
  if (!url) return afficher(false, 'Adresse manquante', 'Collez l\'URL de l\'application Web Google Apps Script.');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/.test(url)) {
    return afficher(false, 'Adresse incorrecte',
      'Elle doit ressembler à : https://script.google.com/macros/s/AKfy…/exec',
      /\/edit|\/home|\/d\//.test(url) ? 'Vous avez copié l\'adresse de l\'éditeur de script. Prenez celle de Déployer > Gérer les déploiements > « URL de l\'application Web ».' : '',
      /\/dev\/?$/.test(url) ? 'Une adresse finissant par /dev ne marche que pour vous : prenez celle qui finit par /exec.' : '');
  }
  if (!jeton) return afficher(false, 'Clé d\'accès manquante', 'Saisissez la même valeur que JETON dans le script.');
  if (/^['"‘’“”]|['"‘’“”]$/.test(jeton)) {
    return afficher(false, 'La clé contient des guillemets', 'Saisissez-la sans guillemets : seulement ce qui se trouve entre les apostrophes de la ligne JETON du script.');
  }
  afficher(true, 'Test en cours…');
  let texte;
  try {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'ping', jeton }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    texte = await r.text();
  } catch (e) {
    // Le navigateur bloque aussi la réponse quand Google renvoie une page d'erreur ou de connexion
    return afficher(false, 'Le serveur ne répond pas au script',
      'Vérifiez la connexion Internet de l\'appareil.',
      'Dans Apps Script : Déployer > Gérer les déploiements > ✏ Modifier : « Qui a accès » doit être « Tout le monde ». Cliquez sur Déployer.',
      'Recopiez l\'« URL de l\'application Web » de ce même écran, en entier : une adresse tronquée ou d\'un ancien déploiement archivé ne répond pas.',
      'Si vous venez de créer le déploiement, autorisez le script quand Google le demande (Paramètres avancés > Accéder au projet).');
  }
  let j = null;
  try { j = JSON.parse(texte); } catch (e) { /* page HTML de Google */ }
  if (!j) {
    return afficher(false, 'Google répond par une page de connexion au lieu du script',
      'Dans Apps Script : Déployer > Gérer les déploiements > ✏ Modifier : « Qui a accès » doit être « Tout le monde » (et non « Tout utilisateur Google » ou « Moi uniquement »).',
      'Après la modification, cliquez sur Déployer, puis recopiez l\'URL /exec.',
      /Script function not found|doPost/i.test(texte) ? 'Le script collé est incomplet : recollez tout le fichier Code.gs.' : '');
  }
  if (j.ok) {
    Reglages.maj(x => { x.url = url; x.jeton = jeton; });
    // Un ancien déploiement répond au test mais ne connaît ni le catalogue ni la veille
    if (!j.version || Number(j.version) < VERSION_SERVEUR_MIN) {
      return afficher(false, `Clé acceptée, mais le script déployé est une ancienne version (${j.version || 'avant 1.9'} ; ${VERSION_SERVEUR_MIN.toFixed(1)} requise)`,
        'Dans Apps Script, remplacez tout le code par la dernière version de Code.gs (en gardant votre ligne JETON), puis enregistrez (Ctrl+S).',
        `Déployer > Gérer les déploiements : modifiez (✏) le déploiement dont l'adresse se termine par …${((url.match(/\/s\/([^/]+)\/exec/) || [])[1] || '').slice(-8)}/exec, `
          + 'Version : « Nouvelle version » > Déployer. L\'adresse reste la même.',
        'Si vous avez créé un « Nouveau déploiement », il a une autre adresse : collez-la dans « Adresse du serveur » ci-dessus (et partagez le nouveau QR code).',
        'Vérification : ouvrez l\'adresse /exec dans le navigateur, elle doit afficher "version":"2.0".',
        'Revenez ensuite ici et touchez à nouveau « Tester la connexion ».');
    }
    if (j.catalogue === -1) {
      return afficher(false, 'Connexion réussie, mais l\'onglet « Catalogue » est introuvable dans la Google Sheet',
        'Onglets trouvés : ' + (j.onglets || []).join(', '),
        'Importez le fichier « Catalogue produits - base initiale.xlsx » (Fichier > Importer > Insérer de nouvelles feuilles), '
        + 'puis renommez son onglet exactement « Catalogue » (C majuscule, sans espace ni chiffre).');
    }
    if (j.catalogue === 0 || (j.colonnesManquantes || []).length) {
      return afficher(false, 'Connexion réussie, mais l\'onglet « Catalogue » est vide ou incomplet',
        j.catalogue === 0 ? 'L\'onglet ne contient aucune référence sous la ligne d\'en-têtes.' : '',
        (j.colonnesManquantes || []).length ? 'Colonnes manquantes en ligne 1 : ' + j.colonnesManquantes.join(', ') : '',
        'Réimportez le fichier Excel du catalogue sans modifier la ligne d\'en-têtes.');
    }
    afficher(true, `Connexion réussie ✓ — ${j.catalogue} référence(s) au catalogue du serveur. Téléchargement en cours…`);
    // Téléchargement immédiat (sinon il n'aurait lieu qu'au prochain démarrage ou au prochain envoi)
    let n = 0;
    try {
      if (window.Recensement) { await Recensement.telechargerCatalogue({ silencieux: true }); n = (await Recensement.catalogue()).length; }
      await telechargerHistorique({ force: true });
      if (window.Veille) { await Veille.telechargerReferentiels(); await Veille.telechargerHistorique({ force: true }); }
    } catch (e) { /* le détail est donné ci-dessous */ }
    majEtatHistorique();
    return afficher(n > 0, n > 0 ? `Connexion réussie ✓ — catalogue chargé sur cet appareil : ${n} référence(s).` : 'Connexion réussie, mais le catalogue n\'a pas pu être téléchargé',
      n > 0 ? 'Historique des magasins et photos des produits mis à jour.' : 'Vérifiez la connexion Internet puis touchez à nouveau « Tester la connexion ».');
  }
  if (/cl[ée]/i.test(j.erreur || '')) {
    return afficher(false, 'Le serveur répond, mais refuse la clé',
      'Le script est bien installé : seule la clé diffère.',
      'Cause la plus fréquente : la clé a été modifiée dans le script sans redéployer. Faites Déployer > Gérer les déploiements > ✏ Modifier > Version : « Nouvelle version » > Déployer. L\'URL reste la même.',
      'Sinon, comparez les deux clés caractère par caractère (majuscules, tirets, 0 et O, l et 1).');
  }
  afficher(false, 'Réponse inattendue du serveur', j.erreur || texte.slice(0, 200));
}

/* ---------- Création / ouverture d'une fiche ---------- */

async function nouvelleFiche(cle) {
  const F = FORMS[cle];
  const r = Reglages.lire();
  const memo = (r.memo || {})[cle] || {};
  const valeurs = { start: maintenant() };
  for (const c of F.sections[0].champs) {
    if (c.t === 'date') valeurs[c.n] = aujourdhui();
    else if (c.t === 'select_one' && !c.casc && memo[c.n]) valeurs[c.n] = memo[c.n];
  }
  const fiche = { id: uuid(), form: cle, statut: 'brouillon', valeurs, photos: {}, creeLe: maintenant(), modifieLe: maintenant(), appareil: idAppareil() };
  await DB.mettre(fiche);
  ouvrirFiche(fiche.id, true);
}

async function ouvrirFiche(id, nouvelle = false) {
  const fiche = await DB.lire(id);
  fiche.confirme = fiche.confirme || {};
  const F = FORMS[fiche.form];
  const geo = F.champs.find(c => c.t === 'geopoint');
  // Brouillon rouvert : la localisation enregistrée est effacée et reprise sur place
  const brouillon = !nouvelle && fiche.statut === 'brouillon';
  if (geo && brouillon && fiche.valeurs[geo.n]) { fiche.valeurs[geo.n] = ''; await DB.mettre(fiche); }
  const autres = (await DB.tout()).filter(f => f.id !== id && f.form === fiche.form);
  E = { F, fiche, etape: 0, blocs: {}, widgets: {}, montrerManquants: false, autres, vis: {} };
  history.pushState({ vue: 'fiche' }, '');
  construireEditeur();
  if (geo && (nouvelle || brouillon)) capturerGps(geo.n);
}

/* ---------- Éditeur ---------- */

function construireEditeur() {
  const { F } = E;
  vider();
  const nav = h('button', { class: 'nav-etape', onclick: ouvrirSommaire });
  const progression = h('div', { class: 'progression' }, h('div', { class: 'progression-barre' }));
  racineApp.append(h('header', { class: 'barre collante' },
    h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: () => history.back() }, '←'),
    nav,
    h('span', { class: 'etat-sauvegarde discret' })), progression);

  const corps = h('main', { class: 'editeur' });
  F.sections.forEach(s => corps.append(construireSection(s)));
  racineApp.append(corps);

  const prec = h('button', { class: 'btn', onclick: () => allerEtape(E.etape - 1) }, '← Précédent');
  const suiv = h('button', { class: 'btn primaire', onclick: () => (E.etape === F.sections.length - 1 ? terminer() : allerEtape(E.etape + 1)) });
  racineApp.append(h('footer', { class: 'pied' }, prec, suiv));
  Object.assign(E, { nav, prec, suiv, progression, corps });

  corps.querySelectorAll('[data-n]').forEach(el => { E.blocs[el.dataset.n] = el; });
  E.unitesEl = {};
  corps.querySelectorAll('[data-unite]').forEach(el => { E.unitesEl[el.dataset.unite] = el; });
  corps.querySelectorAll('[data-yn],[data-ch],[data-in],[data-geo],[data-photo],[data-casc]').forEach(el => {
    const n = el.dataset.yn || el.dataset.ch || el.dataset.in || el.dataset.geo || el.dataset.photo || el.dataset.casc;
    (E.widgets[n] = E.widgets[n] || []).push(el);
  });
  corps.addEventListener('click', surClic);
  corps.addEventListener('input', surSaisie);
  corps.addEventListener('change', surChangement);
  corps.addEventListener('keydown', surTouche);

  for (const n in E.widgets) synchroniserWidget(n);
  rafraichir();
  allerEtape(0);
}

function construireSection(s) {
  const tete = h('div', { class: 'section-tete' }, h('h2', {}, s.titre));
  if (!s.entete && s.champs.some(c => c.ouiNon)) {
    tete.append(h('button', { class: 'btn petit', onclick: () => marquerAbsents(s) }, 'Reste : Non'));
  }
  const el = h('section', { class: 'etape', 'data-etape': s.i, hidden: true }, tete);
  if (s.entete) {
    for (const c of s.champs) if (!c.parent) { const n = noeud(c, null); if (n) el.append(n); }
    el.append(h('div', { class: 'bandeau-repris', hidden: true }));
    return el;
  }
  for (const u of s.unites) {
    const bloc = u.virtuel
      ? h('div', { class: 'groupe virtuel' },
          h('div', { class: 'groupe-tete' }, h('span', { class: 'groupe-nom' }, u.titre)),
          h('div', { class: 'groupe-corps' }, u.champs.map(c => ligneProduit(c, u.titre))))
      : noeud(u.champs[0], null);
    if (!bloc) continue;
    bloc.dataset.unite = u.id;
    bloc.append(h('div', { class: 'verif', hidden: true },
      h('span', { class: 'verif-texte' }),
      h('button', { type: 'button', class: 'btn petit conforme', 'data-action': 'conforme', 'data-cible': u.id }, '✓ Conforme')));
    el.append(bloc);
  }
  return el;
}

function noeud(c, marque) {
  if (c.casc) return c === E.F.cascade.racine ? widgetCascade(E.F.cascade) : null;
  if (c.ouiNon) return c.enfants.some(e => e.ouiNon) ? groupeMarque(c) : ligneProduit(c, marque);
  return champGenerique(c);
}

function raccourcir(l, marque) {
  const L = nomMarque(l);
  return marque && L.toUpperCase().startsWith(marque.toUpperCase() + ' ') ? L.slice(marque.length + 1) : L;
}

function boutonsOuiNon(c) {
  return h('div', { class: 'ouinon', 'data-yn': c.n },
    h('button', { type: 'button', 'data-v': c.vOui }, 'Oui'),
    h('button', { type: 'button', 'data-v': c.vNon }, 'Non'));
}

function groupeMarque(c) {
  const marque = nomMarque(c.l);
  return h('div', { class: 'groupe', 'data-n': c.n },
    h('div', { class: 'groupe-tete' }, h('span', { class: 'groupe-nom' }, marque), boutonsOuiNon(c)),
    h('div', { class: 'groupe-corps' }, c.enfants.map(e => (e.t === 'integer' || e.t === 'decimal') && !e.ouiNon
      ? h('div', { class: 'valeurs' }, miniNombre(e, true)) : noeud(e, marque))));
}

function ligneProduit(c, marque) {
  const nums = c.enfants.filter(e => e.t === 'integer' || e.t === 'decimal');
  const autres = c.enfants.filter(e => !nums.includes(e));
  return h('div', { class: 'produit', 'data-n': c.n },
    h('div', { class: 'produit-tete' }, h('span', { class: 'produit-nom' }, raccourcir(c.l, marque)), boutonsOuiNon(c)),
    nums.length ? h('div', { class: 'valeurs' }, nums.map(e => miniNombre(e))) : null,
    autres.map(e => noeud(e, marque)));
}

function miniNombre(c, long = false) {
  const court = long ? c.l : /^PRIX/i.test(c.l) ? 'Prix' : /^FACING/i.test(c.l) ? 'Facing' : c.l;
  const info = c.plage ? `${c.plage[0]}–${c.plage[1]} F` : c.conseil ? `cons. ${c.conseil} F` : '';
  return h('label', { class: 'mini', 'data-n': c.n },
    h('span', { class: 'mini-lib' }, court),
    h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', enterkeyhint: 'next', autocomplete: 'off', 'data-in': c.n, 'aria-label': c.l }),
    info ? h('small', { class: 'mini-info' }, info) : null);
}

function champGenerique(c) {
  let w;
  const choix = E.F.listes[c.liste] || [];
  switch (c.t) {
    case 'select_one':
      w = choix.length <= 8
        ? h('div', { class: 'puces', 'data-ch': c.n }, choix.map(([v, l]) => h('button', { type: 'button', 'data-v': v }, l)))
        : h('select', { 'data-in': c.n }, h('option', { value: '' }, '— Choisir —'), choix.map(([v, l]) => h('option', { value: v }, l)));
      break;
    case 'integer': case 'decimal':
      w = h('input', { type: 'text', inputmode: c.t === 'integer' ? 'numeric' : 'decimal', enterkeyhint: 'next', autocomplete: 'off', 'data-in': c.n });
      break;
    case 'date': w = h('input', { type: 'date', 'data-in': c.n }); break;
    case 'geopoint': w = widgetGeo(c); break;
    case 'image': w = widgetPhoto(c); break;
    case 'note': w = null; break;
    default: w = h('input', { type: 'text', 'data-in': c.n });
  }
  const somme = c.refs && /FACING/i.test(c.l) ? h('small', { class: 'somme discret', 'data-somme': c.n }) : null;
  return h('div', { class: 'champ' + (c.refs ? ' total' : ''), 'data-n': c.n },
    h('span', { class: 'champ-lib' }, c.l || c.n, c.req ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    c.h && !c.plage ? h('small', { class: 'aide' }, c.h) : null,
    w, somme);
}

/* Point de vente : une seule recherche au lieu de CANAL → ENSEIGNE → MAGASIN */
function widgetCascade(K) {
  const recherche = h('input', { type: 'search', placeholder: 'Rechercher (ex. auchan mermoz, shell, edk…)', class: 'recherche', autocomplete: 'off' });
  const liste = h('div', { class: 'casc-liste' });
  const choisi = h('div', { class: 'casc-choisi' });
  const bloc = h('div', { class: 'champ cascade', 'data-n': K.racine.n, 'data-casc': K.racine.n },
    h('span', { class: 'champ-lib' }, K.titre, h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')), choisi, recherche, liste);
  const remplir = () => {
    const mots = sansAccents(recherche.value).split(/\s+/).filter(Boolean);
    const res = K.options.filter(o => mots.every(m => o.cle.includes(m)));
    liste.replaceChildren(...res.slice(0, 80).map(o => h('button', { type: 'button', class: 'casc-option', onclick: () => choisirCascade(K, o) },
      h('strong', {}, o[o.length - 1][2]), h('small', {}, o.slice(0, -1).map(p => p[2]).join(' › ')))));
    if (res.length > 80) liste.append(h('p', { class: 'discret' }, `${res.length - 80} autres… affinez la recherche.`));
    if (!res.length) liste.append(h('p', { class: 'discret' }, 'Aucun point de vente trouvé.'));
  };
  recherche.addEventListener('input', remplir);
  bloc._remplir = remplir;
  bloc._elements = { recherche, liste, choisi };
  return bloc;
}

function choisirCascade(K, option) {
  for (const n of K.membres) E.fiche.valeurs[n] = '';
  for (const [n, code] of option) E.fiche.valeurs[n] = code;
  synchroniserWidget(K.racine.n);
  apresModification();
  return preremplir();
}

const dateFr = d => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? d.slice(0, 10).split('-').reverse().join('/') : d || '');

// Reprend les relevés de la dernière visite du point de vente choisi.
async function preremplir() {
  const { F, fiche } = E;
  const cle = clePdv(F, fiche.valeurs);
  if (!cle || (fiche.prerempli && fiche.prerempli.magasin === cle)) return;
  const v = await derniereVisite(F, cle, fiche.id);
  if (!E || E.fiche !== fiche) return;
  const saisies = Object.keys(fiche.confirme || {}).length > 0
    || (!fiche.prerempli && F.champs.some(c => estRepris(c) && !vide(fiche.valeurs[c.n])));
  if (saisies && !confirm(v
    ? `Remplacer les réponses des rayons par la visite du ${dateFr(v.date)} de ce magasin ?`
    : 'Aucune visite précédente pour ce magasin. Effacer les réponses des rayons ?')) return;
  for (const c of F.champs) if (estRepris(c)) fiche.valeurs[c.n] = '';
  fiche.confirme = {};
  fiche.prerempli = null;
  if (v) {
    const champs = {};
    for (const c of F.champs) {
      if (estRepris(c) && !vide(v.valeurs[c.n])) { fiche.valeurs[c.n] = v.valeurs[c.n]; champs[c.n] = v.valeurs[c.n]; }
    }
    fiche.prerempli = { magasin: cle, date: v.date, par: v.par, source: v.source, champs };
  }
  E.sansHistorique = !v;
  for (const c of F.champs) if (estRepris(c)) synchroniserWidget(c.n);
  apresModification();
  toast(v ? `Fiche préremplie avec la visite du ${dateFr(v.date)}` : 'Pas de visite précédente : saisie complète');
}

// Une modification dans une marque vaut vérification de cette marque.
function toucher(n) {
  const c = E.F.index[n];
  if (c && c.unite && estRepris(c) && E.fiche.prerempli) (E.fiche.confirme = E.fiche.confirme || {})[c.unite] = true;
}

function unitesAVerifier(F, fiche, vis) {
  const res = new Map();   // id d'unité → n° d'étape
  if (!fiche.prerempli) return res;
  const ok = fiche.confirme || {};
  for (const n in fiche.prerempli.champs) {
    const c = F.index[n];
    if (c && c.unite && vis[n] && !ok[c.unite]) res.set(c.unite, c.section);
  }
  return res;
}

function widgetGeo(c) {
  return h('div', { class: 'geo', 'data-geo': c.n },
    h('div', { class: 'geo-etat' }),
    h('button', { type: 'button', class: 'btn', 'data-action': 'gps', 'data-cible': c.n }, 'Capturer la position'));
}

function widgetPhoto(c) {
  return h('div', { class: 'photo', 'data-photo': c.n },
    h('div', { class: 'photo-apercu' }),
    h('label', { class: 'btn' }, 'Prendre la photo',
      h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'data-fichier': c.n, class: 'masque' })));
}

/* ---------- Synchronisation valeurs ↔ écran ---------- */

function synchroniserWidget(n) {
  const v = E.fiche.valeurs[n];
  for (const el of E.widgets[n] || []) {
    if (el.dataset.yn || el.dataset.ch) {
      for (const b of el.children) { const a = !vide(v) && b.dataset.v === String(v); b.classList.toggle('actif', a); b.setAttribute('aria-pressed', String(a)); }
    } else if (el.dataset.in) {
      if (document.activeElement !== el) el.value = v ?? '';
    } else if (el.dataset.geo) {
      majGeo(n, el);
    } else if (el.dataset.photo) {
      const ap = el.querySelector('.photo-apercu');
      const data = v && E.fiche.photos[v];
      ap.replaceChildren(...(data
        ? [h('img', { src: data, alt: 'Photo' }), h('button', { type: 'button', class: 'btn petit danger', 'data-action': 'suppr-photo', 'data-cible': n }, 'Retirer')]
        : v ? [h('span', { class: 'discret' }, v)] : []));
    } else if (el.dataset.casc) {
      const o = optionCascade(E.F, E.fiche.valeurs);
      const { recherche, liste, choisi } = el._elements;
      if (o) {
        choisi.replaceChildren(h('div', {}, h('strong', {}, o[o.length - 1][2]), h('small', { class: 'discret' }, o.slice(0, -1).map(p => p[2]).join(' › '))),
          h('button', { type: 'button', class: 'btn petit', onclick: () => { choisi.hidden = true; recherche.hidden = false; liste.hidden = false; recherche.focus(); } }, 'Changer'));
        choisi.hidden = false; recherche.hidden = true; liste.hidden = true;
      } else {
        choisi.hidden = true; recherche.hidden = false; liste.hidden = false;
        if (!liste.children.length) el._remplir();
      }
    }
  }
}

function definir(n, v) {
  E.fiche.valeurs[n] = v;
  toucher(n);
  synchroniserWidget(n);
  apresModification();
}

function apresModification() {
  rafraichir();
  E.fiche.modifieLe = maintenant();
  clearTimeout(E.minuteur);
  const etat = racineApp.querySelector('.etat-sauvegarde');
  if (etat) etat.textContent = '…';
  E.minuteur = setTimeout(async () => { await DB.mettre(E.fiche); if (etat) etat.textContent = 'Enregistré'; }, 500);
}

function rafraichir() {
  const { F, fiche } = E;
  const vis = visibilite(F, fiche.valeurs);
  E.vis = vis;
  for (const n in E.blocs) {
    const cache = !vis[n];
    if (E.blocs[n].hidden !== cache) E.blocs[n].hidden = cache;
  }
  const manq = manquants(F, fiche.valeurs, vis);
  const manqSet = new Set(manq.map(c => c.n));
  if (E.montrerManquants || E.manqAffiches) {
    for (const n in E.blocs) E.blocs[n].classList.toggle('manque', E.montrerManquants && manqSet.has(n));
    E.manqAffiches = E.montrerManquants;
  }
  // Fourchettes de prix
  for (const c of F.champs) {
    if (!c.plage || !E.blocs[c.n]) continue;
    const v = fiche.valeurs[c.n];
    E.blocs[c.n].classList.toggle('hors', vis[c.n] && !vide(v) && (v < c.plage[0] || v > c.plage[1]));
  }
  // Aide au calcul des FACING TOTAL
  racineApp.querySelectorAll('[data-somme]').forEach(el => {
    const c = F.index[el.dataset.somme];
    const s = c.refs.reduce((t, r) => t + (vis[r] && !vide(fiche.valeurs[r]) ? Number(fiche.valeurs[r]) || 0 : 0), 0);
    el.textContent = `Somme des facings saisis ci-dessus : ${s}`;
  });
  // Progression
  const parSection = F.sections.map(() => 0);
  manq.forEach(c => { parSection[c.section]++; });
  E.parSection = parSection;
  // Marques reprises de la visite précédente et pas encore vérifiées
  const aVerif = unitesAVerifier(F, fiche, vis);
  E.verifSection = F.sections.map(() => 0);
  aVerif.forEach(s => { E.verifSection[s]++; });
  E.aVerif = aVerif;
  for (const id in E.unitesEl) {
    const el = E.unitesEl[id], a = aVerif.has(id);
    const barre = el.querySelector(':scope > .verif');
    if (el.classList.contains('a-verifier') !== a) { el.classList.toggle('a-verifier', a); barre.hidden = !a; }
    if (a) barre.firstChild.textContent = `Repris du ${dateFr(fiche.prerempli.date)}`;
  }
  const bandeau = E.corps.querySelector('.bandeau-repris');
  if (bandeau) {
    const p = fiche.prerempli;
    bandeau.hidden = !p && !E.sansHistorique;
    bandeau.textContent = p
      ? `Fiche préremplie avec la visite du ${dateFr(p.date)}${p.par ? ' (' + p.par + ')' : ''}. Dans chaque rayon, corrigez ce qui a changé ; touchez « ✓ Conforme » pour les marques identiques.`
      : 'Aucune visite précédente connue pour ce magasin : saisie complète.';
  }
  const total = F.champs.filter(c => c.req && vis[c.n] && !TYPES_META.has(c.t)).length;
  const pct = total ? Math.round(100 * (total - manq.length) / total) : 100;
  E.progression.firstChild.style.width = pct + '%';
  E.progression.title = `${pct} % complété`;
  majNav();
}

function majNav() {
  const { F, etape } = E;
  const s = F.sections[etape];
  const et = etatEtape(etape);
  E.nav.replaceChildren(h('small', {}, `Étape ${etape + 1}/${F.sections.length}`),
    h('span', {}, s.titre, ' ▾'), h('small', { class: et.fait ? 'fait' : 'a-faire' }, et.texte));
  E.prec.disabled = etape === 0;
  E.suiv.textContent = etape === F.sections.length - 1 ? 'Terminer ✓' : 'Suivant →';
}

function etatEtape(i) {
  const r = (E.parSection || [])[i] || 0, v = (E.verifSection || [])[i] || 0;
  const parts = [];
  if (r) parts.push(`${r} à remplir`);
  if (v) parts.push(`${v} à vérifier`);
  return { fait: !parts.length, texte: parts.length ? parts.join(' · ') : '✓ complet' };
}

function allerEtape(i) {
  if (i < 0 || i >= E.F.sections.length) return;
  E.etape = i;
  E.corps.querySelectorAll('.etape').forEach(el => { el.hidden = Number(el.dataset.etape) !== i; });
  majNav();
  window.scrollTo(0, 0);
}

function ouvrirSommaire() {
  const fermer = () => voile.remove();
  const voile = h('div', { class: 'voile', onclick: e => { if (e.target === voile) fermer(); } },
    h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Étapes' },
      h('h3', {}, 'Étapes'),
      E.F.sections.map((s, i) => h('button', { class: 'sommaire-ligne' + (i === E.etape ? ' actif' : ''), onclick: () => { fermer(); allerEtape(i); } },
        h('span', {}, `${i + 1}. ${s.titre}`),
        (et => h('small', { class: et.fait ? 'fait' : 'a-faire' }, et.fait ? '✓' : et.texte))(etatEtape(i)))),
      h('button', { class: 'btn', onclick: fermer }, 'Fermer')));
  document.body.append(voile);
}

function marquerAbsents(s) {
  const vis = visibilite(E.F, E.fiche.valeurs);
  let k = 0;
  for (const c of s.champs) {
    if (c.ouiNon && vis[c.n] && vide(E.fiche.valeurs[c.n])) { E.fiche.valeurs[c.n] = c.vNon; synchroniserWidget(c.n); k++; }
  }
  apresModification();
  toast(k ? `${k} réponse(s) mise(s) à « Non »` : 'Rien à compléter dans cette étape');
}

/* ---------- Événements ---------- */

function surClic(ev) {
  const b = ev.target.closest('button');
  if (!b) return;
  const grp = b.parentElement;
  if (b.dataset.v !== undefined && (grp.dataset.yn || grp.dataset.ch)) {
    const n = grp.dataset.yn || grp.dataset.ch;
    const nouv = E.fiche.valeurs[n] === b.dataset.v ? '' : b.dataset.v;
    definir(n, nouv);
    const c = E.F.index[n];
    // « Oui » sur un produit : on place le curseur sur le prix.
    if (c.ouiNon && nouv === c.vOui) {
      const champ = E.blocs[n] && E.blocs[n].querySelector(':scope > .valeurs input');
      if (champ) setTimeout(() => champ.focus(), 30);
    }
    return;
  }
  if (b.dataset.action === 'gps') capturerGps(b.dataset.cible);
  if (b.dataset.action === 'conforme') {
    (E.fiche.confirme = E.fiche.confirme || {})[b.dataset.cible] = true;
    apresModification();
  }
  if (b.dataset.action === 'suppr-photo') {
    const n = b.dataset.cible;
    delete E.fiche.photos[E.fiche.valeurs[n]];
    definir(n, '');
  }
}

function surSaisie(ev) {
  const n = ev.target.dataset.in;
  if (!n || ev.target.tagName === 'SELECT') return;
  const c = E.F.index[n];
  let v = ev.target.value;
  if (c.t === 'integer') { const p = v.replace(/\D/g, ''); if (p !== v) ev.target.value = p; v = p === '' ? '' : Number(p); }
  else if (c.t === 'decimal') { const p = v.replace(',', '.').replace(/[^\d.]/g, ''); v = p === '' || isNaN(p) ? '' : Number(p); }
  E.fiche.valeurs[n] = v;
  toucher(n);
  apresModification();
}

async function surChangement(ev) {
  const t = ev.target;
  if (t.tagName === 'SELECT' || t.type === 'date') { definir(t.dataset.in, t.value); return; }
  if (t.dataset.fichier && t.files && t.files[0]) {
    const n = t.dataset.fichier;
    try {
      const data = await compresserImage(t.files[0]);
      const ancien = E.fiche.valeurs[n];
      if (ancien) delete E.fiche.photos[ancien];
      const nom = `${n}_${Date.now()}.jpg`;
      E.fiche.photos[nom] = data;
      definir(n, nom);
    } catch (e) { toast('Photo illisible, réessayez'); }
    t.value = '';
  }
}

function surTouche(ev) {
  if (ev.key !== 'Enter' || !ev.target.dataset.in) return;
  ev.preventDefault();
  const champs = [...E.corps.querySelectorAll(`.etape[data-etape="${E.etape}"] input[data-in]`)].filter(i => i.offsetParent);
  const i = champs.indexOf(ev.target);
  if (champs[i + 1]) champs[i + 1].focus(); else ev.target.blur();
}

/* ---------- GPS ---------- */

function majGeo(n, el) {
  const etat = el.querySelector('.geo-etat');
  const v = E.fiche.valeurs[n];
  const lignes = [];
  if (E.gps && E.gps.n === n) lignes.push(h('div', { class: 'discret' }, E.gps.msg));
  if (v) {
    const [lat, lon, , acc] = String(v).split(' ').map(Number);
    lignes.push(h('div', {}, h('strong', {}, `${lat.toFixed(6)}, ${lon.toFixed(6)}`), ` · précision ±${Math.round(acc)} m`));
    if (acc > 50) lignes.push(h('div', { class: 'avert' }, 'Précision faible : sortez du bâtiment ou réessayez.'));
    const proche = E.autres.find(f => {
      const w = f.valeurs[n]; if (!w) return false;
      const [a, b] = String(w).split(' ').map(Number);
      const o1 = optionCascade(E.F, f.valeurs), o2 = optionCascade(E.F, E.fiche.valeurs);
      return o1 && o2 && o1 !== o2 && distance(lat, lon, a, b) < 15;
    });
    if (proche) lignes.push(h('div', { class: 'avert' }, `Position identique à la fiche « ${resume(E.F, proche).titre} ». Le GPS n'a peut-être pas été actualisé : recapturez sur place.`));
  } else if (!E.gps) lignes.push(h('div', { class: 'discret' }, 'Aucune position enregistrée.'));
  etat.replaceChildren(...lignes);
}

function distance(a1, o1, a2, o2) {
  const R = 6371000, r = Math.PI / 180;
  const x = (o2 - o1) * r * Math.cos((a1 + a2) / 2 * r), y = (a2 - a1) * r;
  return Math.sqrt(x * x + y * y) * R;
}

function capturerGps(n) {
  if (!navigator.geolocation) return toast('GPS indisponible sur cet appareil');
  const ficheId = E.fiche.id;
  const debut = Date.now();
  // Positions des autres fiches de l'appareil : le téléphone renvoie souvent d'abord sa dernière position connue
  const anciennes = new Set(E.autres.map(f => String(f.valeurs[n] || '').split(' ').slice(0, 2).map(x => Number(x).toFixed(6)).join(',')));
  let meilleur = null;
  E.gps = { n, msg: 'Recherche de la position…' };
  synchroniserWidget(n);
  const fin = msg => {
    navigator.geolocation.clearWatch(id); clearTimeout(limite);
    if (!E || E.fiche.id !== ficheId) return;
    E.gps = null;
    if (meilleur) definir(n, meilleur); else { synchroniserWidget(n); toast(msg || 'Position introuvable'); }
  };
  // maximumAge: 0 force une nouvelle mesure (évite les positions en cache constatées sous Kobo).
  const id = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    // Position en cache (relevée avant cette capture) ou identique à une autre fiche : ignorée, on attend la position actuelle
    if ((p.timestamp && p.timestamp < debut - 5000) || anciennes.has(`${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`)) {
      if (E && E.fiche.id === ficheId && E.gps) { E.gps.msg = 'Recherche de la position actuelle…'; synchroniserWidget(n); }
      return;
    }
    if (!meilleur || c.accuracy < Number(meilleur.split(' ')[3])) meilleur = `${c.latitude} ${c.longitude} ${c.altitude || 0} ${c.accuracy}`;
    if (E && E.fiche.id === ficheId && E.gps) { E.gps.msg = `Affinage… ±${Math.round(c.accuracy)} m`; synchroniserWidget(n); }
    if (c.accuracy <= 15) fin();
  }, err => fin(err.code === 1 ? 'Autorisez l\'accès à la position dans le navigateur' : 'Position introuvable : réessayez à l\'extérieur'),
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  const limite = setTimeout(() => fin(), 30000);
}

/* ---------- Photos ---------- */

function compresserImage(fichier, max = 1280, qualite = 0.72) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL('image/jpeg', qualite));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    img.src = url;
  });
}

/* ---------- Fin de saisie ---------- */

async function terminer() {
  const { F, fiche } = E;
  const vis = visibilite(F, fiche.valeurs);
  const manq = manquants(F, fiche.valeurs, vis);
  if (manq.length) {
    E.montrerManquants = true;
    rafraichir();
    const c = manq[0];
    allerEtape(c.section);
    const bloc = E.blocs[c.n] || (c.casc && E.blocs[F.cascade.racine.n]);
    if (bloc) setTimeout(() => bloc.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    toast(`${manq.length} réponse(s) manquante(s), surlignées en rouge`);
    return;
  }
  const aVerif = unitesAVerifier(F, fiche, vis);
  if (aVerif.size) {
    const [id, s] = aVerif.entries().next().value;
    allerEtape(s);
    const bloc = E.unitesEl[id];
    if (bloc) setTimeout(() => bloc.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    toast(`${aVerif.size} marque(s) reprise(s) à vérifier : corrigez ou touchez « ✓ Conforme »`, 5000);
    return;
  }
  fiche.valeurs.end = maintenant();
  fiche.statut = 'finalisee';
  fiche.finaliseLe = maintenant();
  clearTimeout(E.minuteur);
  await DB.mettre(fiche);
  Reglages.maj(r => {
    r.memo = r.memo || {}; r.memo[F.cle] = r.memo[F.cle] || {};
    for (const c of F.sections[0].champs) if (c.t === 'select_one' && !c.casc && !vide(fiche.valeurs[c.n])) r.memo[F.cle][c.n] = fiche.valeurs[c.n];
  });
  toast('Fiche terminée ✓');
  E = null;
  ongletAccueil = 'finalisee';
  history.back();
  if (navigator.onLine && Reglages.lire().url) synchroniser({ silencieux: true });
}

/* ------------------------------------------------------------------ */
/* Envoi au serveur et export                                          */
/* ------------------------------------------------------------------ */

async function appelServeur(url, donnees) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    // text/plain évite la requête préalable CORS, refusée par Google Apps Script.
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(donnees), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const texte = await r.text();
    try { return JSON.parse(texte); }
    catch (e) { throw new Error('le serveur n\'a pas répondu correctement : vérifiez le déploiement dans ⚙ Paramètres > Tester la connexion'); }
  } finally { clearTimeout(t); }
}

let envoiEnCours = false;
// Supervision : le téléphone indique au serveur ses fiches en attente, sa version et l'état de son catalogue
// (onglet « Appareils »). Une fiche bloquée sur un téléphone devient ainsi visible du responsable.
async function signalerEtatAppareil(r) {
  if (!r.url || !navigator.onLine) return;
  try {
    const fiches = await DB.tout();
    const merch = ((Reglages.lire().memo || {})['veille-gms'] || {}).MERCH;
    await appelServeur(r.url, { action: 'etatAppareil', jeton: r.jeton, etat: {
      APPAREIL: idAppareil(), MERCHANDISEUR: window.Veille && merch ? Veille.nomMerch(merch) : '', VERSION_APP,
      BROUILLONS: fiches.filter(f => f.statut === 'brouillon').length, A_ENVOYER: fiches.filter(f => f.statut === 'finalisee').length,
      CATALOGUE_REFS: window.Recensement ? (await Recensement.catalogue()).length : '', CATALOGUE_MAJ: Reglages.lire().catalogueMaj || '',
    } });
  } catch (e) { /* sans conséquence : réessayé à la prochaine synchronisation */ }
}

// Fiches terminées (donc complètes) pas encore envoyées, tous formulaires confondus
async function nbFichesEnAttente() { return (await DB.tout()).filter(f => f.statut === 'finalisee').length; }

// actualiser : à l'ouverture / actualisation de la page, l'historique des visites est rechargé sans attendre 6 heures
// envoiSeul : nouvel essai automatique (toutes les 2 minutes, retour au premier plan) : envoi des fiches uniquement
async function synchroniser({ silencieux = false, actualiser = false, envoiSeul = false } = {}) {
  if (envoiEnCours) return;
  const r = Reglages.lire();
  if (!r.url) { if (!silencieux) toast('Configurez d\'abord le serveur dans Paramètres'); return; }
  if (!navigator.onLine) { if (!silencieux) toast('Pas de réseau : les fiches seront envoyées automatiquement au retour du réseau'); return; }
  envoiEnCours = true;
  const fiches = (await DB.tout()).filter(f => f.statut === 'finalisee');
  let ok = 0, erreur = null;
  const noter = e => { erreur = erreur || e; };   // une fiche refusée n'empêche pas l'envoi des suivantes
  for (const f of fiches) {
    const F = FORMS[f.form];
    if (!F) continue;
    try {
      const { entetes, ligne } = ligneExport(F, f);
      const j = await appelServeur(r.url, { action: 'soumettre', jeton: r.jeton, id: f.id, formulaire: F.cle, titre: F.titre, entetes, ligne, photos: f.photos || {} });
      if (!j.ok) throw new Error(j.erreur || 'refus du serveur');
      f.statut = 'envoyee'; f.envoyeLe = maintenant(); f.photos = {};   // photos libérées : elles sont sur le Drive
      await DB.mettre(f);
      ok++;
    } catch (e) { noter(e); }
  }
  for (const module of [window.Veille, window.Recensement]) {
    if (!module) continue;
    try { ok += await module.envoyer(r); } catch (e) { ok += e.envoyees || 0; noter(e); }
  }
  envoiEnCours = false;
  const reste = await nbFichesEnAttente();
  Reglages.maj(x => {
    if (ok) x.dernierEnvoi = maintenant();
    if (erreur && reste) x.envoiEchec = { le: maintenant(), message: erreur.message }; else delete x.envoiEchec;
  });
  // Essais automatiques : pas de message d'erreur à répétition (l'accueil indique l'état de l'envoi)
  if (erreur && !silencieux) toast(`${ok} fiche(s) envoyée(s). Erreur : ${erreur.message}`, 6000);
  else if (ok || !silencieux) toast(ok ? `${ok} fiche(s) envoyée(s) ✓` : erreur ? 'Envoi impossible pour le moment : nouvel essai automatique' : 'Rien à envoyer');
  if (envoiSeul) { if (accueilAffiche()) afficherAccueil(); return; }
  await telechargerHistorique();
  if (window.Recensement) await Recensement.telechargerCatalogue();
  if (window.Veille) { await Veille.telechargerReferentiels(); await Veille.telechargerHistorique({ force: actualiser }); }
  await signalerEtatAppareil(r);
  if (accueilAffiche()) afficherAccueil();
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

window.addEventListener('popstate', async () => {
  if (E) {
    clearTimeout(E.minuteur);
    // Une fiche terminée puis modifiée redevient brouillon si elle n'est plus complète.
    if (E.fiche.statut === 'finalisee' && manquants(E.F, E.fiche.valeurs, visibilite(E.F, E.fiche.valeurs)).length) {
      E.fiche.statut = 'brouillon';
      toast('Fiche incomplète : replacée dans les brouillons');
    }
    await DB.mettre(E.fiche);
  }
  document.querySelectorAll('.voile').forEach(v => v.remove());
  if (history.state && history.state.vue === 'recensement') return;   // géré par recensement.js
  afficherAccueil();
});
window.addEventListener('online', () => { if (accueilAffiche()) afficherAccueil(); synchroniser({ silencieux: true }); });
// Envoi automatique des fiches terminées : le signal « réseau revenu » est peu fiable sur Android (Wi-Fi sans internet,
// données lentes, envoi interrompu) : nouvel essai toutes les 2 minutes tant qu'il reste des fiches, et au retour au premier plan.
const ENVOI_AUTO_MS = 2 * 60 * 1000;
async function envoiAutomatique() {
  if (envoiEnCours || document.hidden || !navigator.onLine || !Reglages.lire().url) return;
  if (await nbFichesEnAttente()) synchroniser({ silencieux: true, envoiSeul: true });
}
setInterval(envoiAutomatique, ENVOI_AUTO_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) envoiAutomatique(); });
window.addEventListener('offline', () => { if (accueilAffiche()) afficherAccueil(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && E) DB.mettre(E.fiche); });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* hors ligne indisponible, l'app reste utilisable */ });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

/* ------------------------------------------------------------------ */
/* Connexion d'un téléphone par QR code                                */
/* ------------------------------------------------------------------ */

// Adresse publique de l'application, utilisée dans le QR code quand on le génère depuis le PC (localhost).
const ADRESSE_PUBLIQUE = 'https://jhenric96-spec.github.io/VEILLE-TERRAIN/';

// Les informations de connexion sont placées après « # » : cette partie du lien n'est jamais envoyée au site.
function lienConnexion(url, jeton) {
  const local = location.protocol !== 'https:' || /^(localhost|127\.)/.test(location.hostname);
  const base = local ? ADRESSE_PUBLIQUE : location.origin + location.pathname.replace(/index\.html$/, '');
  const charge = btoa(unescape(encodeURIComponent(JSON.stringify({ u: url, k: jeton })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}#connexion=${charge}`;
}

function lireLienConnexion(hash) {
  const m = String(hash || '').match(/connexion=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(j.u) && j.k ? { url: j.u, jeton: j.k } : null;
  } catch (e) { return null; }
}

// QR code dessiné sur un canevas, avec marge blanche et légende (image à partager sur WhatsApp ou à imprimer)
function canevasQr(texte, legende) {
  const qr = qrcode(0, 'M');
  qr.addData(texte);
  qr.make();
  const n = qr.getModuleCount(), marge = 4, px = 8, haut = 70, bas = 60;
  const cote = (n + 2 * marge) * px;
  const cv = document.createElement('canvas');
  cv.width = cote; cv.height = cote + haut + bas;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#243e79'; g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('VEILLE TERRAIN', cote / 2, 45);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + marge) * px, haut + (r + marge) * px, px, px);
  g.fillStyle = '#333'; g.font = '20px system-ui, sans-serif';
  g.fillText(legende, cote / 2, haut + cote + 35);
  return cv;
}

// Magasins et merchandisers : onglets de la Google Sheet, créés une première fois à partir des listes Kobo.
function blocReferentiels(r) {
  if (!r.url || !window.Veille) return null;
  const etat = h('small', { class: 'aide' }, '…');
  const majEtat = async () => {
    const x = await DB.diversLire('referentiels');
    etat.textContent = x && x.magasins && x.magasins.length
      ? `Liste en service : Google Sheet — ${x.magasins.length} magasin(s) (${x.magasins.filter(m => m.lat).length} avec GPS), ${x.merchandisers.length} merchandiser(s).`
      : 'Liste en service : ancien formulaire Kobo (onglets « Magasins » et « Merchandisers » pas encore créés).';
  };
  majEtat();
  const resultat = h('div', { class: 'diagnostic', hidden: true });
  const montrer = (ok, texte) => { resultat.hidden = false; resultat.className = 'diagnostic ' + (ok ? 'ok' : 'ko'); resultat.textContent = texte; };
  return h('div', { class: 'champ' },
    h('span', { class: 'champ-lib' }, '🏬 Magasins et merchandisers'),
    h('small', { class: 'aide' }, 'Gérés dans les onglets « Magasins » et « Merchandisers » de la Google Sheet : une ligne ajoutée = un magasin ou un '
      + 'merchandiser de plus (le code se crée tout seul) ; ACTIF = NON le masque. LATITUDE / LONGITUDE permettent de signaler une visite '
      + `saisie à plus de 300 m du magasin.`),
    etat,
    h('button', { class: 'btn', onclick: async ev => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Envoi en cours…';
      resultat.hidden = true;
      try {
        const res = await Veille.initialiserReferentiels();
        const gps = res.gpsRemplis === undefined
          ? ' Coordonnées GPS : mettez le script Google à jour (version 2.1) pour qu\'elles soient complétées automatiquement.'
          : ` Coordonnées GPS complétées : ${res.gpsRemplis} magasin(s)` + (res.gpsManquants
            ? ` ; ${res.gpsManquants} restent sans GPS. Si l'historique Kobo n'a pas encore été importé, importez-le ci-dessous (« Importer un fichier… ») puis recommencez ; `
              + 'sinon, saisissez LATITUDE / LONGITUDE dans l\'onglet Magasins (Google Maps : clic droit sur le magasin > cliquer sur les coordonnées pour les copier).' : '.');
        montrer(true, `✓ Onglets à jour dans la Google Sheet : ${res.magasins} magasin(s) et ${res.merchandisers} merchandiser(s) ajouté(s).${gps}`);
      } catch (e) {
        const msg = /Action inconnue/i.test(e.message) ? 'Le script Google déployé est une ancienne version : recollez la dernière version de Code.gs puis déployez une « Nouvelle version ».' : e.message;
        montrer(false, '✗ ' + msg);
      }
      b.disabled = false; b.textContent = 'Créer / compléter les onglets depuis Kobo';
      majEtat();
    } }, 'Créer / compléter les onglets depuis Kobo'),
    resultat);
}

function blocQrConnexion(r) {
  if (!r.url || !r.jeton) {
    return h('p', { class: 'discret' }, 'Une fois la connexion réussie, un QR code apparaîtra ici pour connecter les téléphones des merchandisers.');
  }
  const lien = lienConnexion(r.url, r.jeton);
  let cv;
  try { cv = canevasQr(lien, 'Scanner avec l\'appareil photo du téléphone'); }
  catch (e) { return h('p', { class: 'avert' }, 'QR code impossible à générer : ' + e.message); }
  cv.className = 'qr-image';
  const png = () => new Promise(res => cv.toBlob(res, 'image/png'));
  const actions = [];
  if (navigator.canShare) {
    actions.push(h('button', { class: 'btn primaire', onclick: async () => {
      const fichier = new File([await png()], 'connexion-veille-terrain.png', { type: 'image/png' });
      try {
        if (navigator.canShare({ files: [fichier] })) await navigator.share({ files: [fichier], title: 'Connexion VEILLE TERRAIN', text: 'Scannez ce code pour connecter l\'application VEILLE TERRAIN.' });
        else await navigator.share({ title: 'Connexion VEILLE TERRAIN', url: lien });
      } catch (e) { /* partage annulé */ }
    } }, 'Partager (WhatsApp…)'));
  }
  actions.push(h('button', { class: 'btn', onclick: async () => {
    const a = h('a', { href: URL.createObjectURL(await png()), download: 'connexion-veille-terrain.png' });
    document.body.append(a); a.click(); a.remove();
  } }, 'Télécharger l\'image'));
  actions.push(h('button', { class: 'btn', onclick: async () => {
    try { await navigator.clipboard.writeText(lien); toast('Lien copié'); } catch (e) { prompt('Copiez ce lien :', lien); }
  } }, 'Copier le lien'));
  return h('details', { class: 'champ qr-connexion' },
    h('summary', { class: 'champ-lib' }, '📱 Connecter un autre téléphone (QR code)'),
    h('small', { class: 'aide' }, 'Le merchandiser scanne ce code avec l\'appareil photo de son téléphone : l\'application s\'ouvre déjà connectée au serveur. '
      + 'Il choisit son nom, le catalogue se télécharge, puis il installe l\'application (menu ⋮ > Installer).'),
    cv,
    h('div', { class: 'actions-bas' }, actions),
    h('small', { class: 'avert' }, 'Ce code contient la clé d\'accès : partagez-le uniquement avec vos merchandisers. En cas de fuite, '
      + 'changez la clé (ligne JETON du script, puis nouvelle version du déploiement), reconnectez cet appareil et partagez le nouveau code.'));
}

// À l'ouverture d'un lien de connexion (scan du QR code) : enregistre le serveur, demande qui utilise le téléphone,
// puis télécharge le catalogue, l'historique et les photos.
/* ---------- iPhone : rester connecté ----------
   Dans un onglet Safari, iOS efface les données d'un site (connexion, brouillons, fiches non envoyées) après quelques jours
   sans l'ouvrir. Installée sur l'écran d'accueil, l'application n'est pas concernée. Mais elle démarre alors avec un
   stockage vide (séparé de Safari) et un QR code scanné s'ouvre dans Safari, pas dans l'application installée :
   la connexion s'y transfère donc par « Copier le lien » (dans Safari) puis « Coller le lien » (dans l'application). */
const estIphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const estInstallee = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function bandeauInstallationIphone(r) {
  if (!estIphone() || estInstallee()) return null;
  return h('div', { class: 'bandeau bandeau-ios' },
    h('strong', {}, 'iPhone : installez l\'application pour rester connecté'),
    h('p', {}, 'Ouverte dans Safari, l\'application est effacée par l\'iPhone après quelques jours sans l\'ouvrir '
      + '(connexion, brouillons et fiches non envoyées). Installée sur l\'écran d\'accueil, elle reste connectée.'),
    h('ol', {},
      r.url ? h('li', {}, 'Touchez ', h('button', { class: 'btn petit', onclick: () => copierLienConnexion(r) }, '📋 Copier le lien de connexion'), '.') : null,
      h('li', {}, 'Touchez Partager ', h('strong', {}, '⬆'), ' en bas de Safari, puis ', h('strong', {}, '« Sur l\'écran d\'accueil »'), '.'),
      h('li', {}, 'Ouvrez VEILLE TERRAIN depuis la nouvelle icône' + (r.url ? ', puis touchez « Coller le lien de connexion ».' : ' et connectez-la.'))));
}

async function copierLienConnexion(r) {
  const lien = lienConnexion(r.url, r.jeton);
  try { await navigator.clipboard.writeText(lien); toast('Lien copié ✓ Installez l\'application puis collez-le à l\'ouverture.', 6000); }
  catch (e) { prompt('Copiez ce lien (il contient la clé d\'accès, ne le partagez pas) :', lien); }
}

// Connexion par un lien collé (application installée sur iPhone, ou lien reçu par message)
async function collerLienConnexion() {
  let texte = '';
  try { texte = await navigator.clipboard.readText(); } catch (e) { /* presse-papiers refusé : saisie manuelle */ }
  if (!/connexion=/.test(texte)) texte = prompt('Collez ici le lien de connexion (copié depuis Safari ou reçu de votre responsable) :') || '';
  const i = texte.indexOf('#connexion=');
  if (i < 0) { if (texte) toast('Ce n\'est pas un lien de connexion VEILLE TERRAIN.', 5000); return; }
  history.replaceState(history.state, '', location.pathname + location.search + texte.slice(i).trim());
  await importerConnexion();
}

// Copie de secours de la connexion dans IndexedDB : si seul le petit stockage (localStorage) a été vidé, elle est restaurée
async function sauvegarderConnexion() {
  const r = Reglages.lire();
  if (r.url) { try { await DB.diversMettre('connexion', { url: r.url, jeton: r.jeton, appareil: r.appareil, memo: r.memo }); } catch (e) { /* sans conséquence */ } }
}
async function restaurerConnexion() {
  if (Reglages.lire().url) return sauvegarderConnexion();
  try {
    const c = await DB.diversLire('connexion');
    if (c && c.url) Reglages.maj(x => { Object.assign(x, c); });
  } catch (e) { /* rien à restaurer */ }
}

async function importerConnexion() {
  const cfg = lireLienConnexion(location.hash);
  if (!/connexion=/.test(location.hash)) return;
  history.replaceState(history.state, '', location.pathname + location.search);   // retire la clé de la barre d'adresse
  if (!cfg) { toast('Lien de connexion invalide : demandez un nouveau QR code', 6000); return; }
  const r = Reglages.lire();
  if (r.url && (r.url !== cfg.url || r.jeton !== cfg.jeton)
    && !confirm('Cet appareil est déjà relié à un autre serveur. Le remplacer par celui du QR code ?')) return;
  Reglages.maj(x => { x.url = cfg.url; x.jeton = cfg.jeton; x.histMaj = null; x.histVeilleMaj = null; });
  // Liste des merchandisers à jour (onglet Merchandisers de la Google Sheet) avant de demander qui utilise le téléphone
  if (window.Veille) { await Veille.telechargerReferentiels(); await Veille.chargerReferentiels(); }
  choisirUtilisateur();
}

function choisirUtilisateur() {
  const F = FORMS.gms;
  const champ = F && F.sections[0].champs.find(c => c.t === 'select_one' && !c.casc);
  const noms = window.Veille ? Veille.merchandisers() : champ ? F.listes[champ.liste] : [];
  const fermer = async (code, nom) => {
    voile.remove();
    if (code) {
      Reglages.maj(x => {
        x.appareil = 'TEL-' + sansAccents(nom).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
        x.memo = x.memo || {};
        x.memo['veille-gms'] = Object.assign({}, x.memo['veille-gms'], { MERCH: code });
        if (champ) x.memo.gms = Object.assign({}, x.memo.gms, { [champ.n]: code });
      });
    }
    toast('Connexion réussie ✓ — téléchargement du catalogue…', 8000);
    try {
      if (window.Recensement) await Recensement.telechargerCatalogue({ silencieux: true });
      await telechargerHistorique({ force: true });
      if (window.Veille) await Veille.telechargerHistorique({ force: true });
    } catch (e) { /* nouvel essai à la prochaine synchronisation */ }
    const n = window.Recensement ? (await Recensement.catalogue()).length : 0;
    const installee = matchMedia('(display-mode: standalone)').matches;
    toast(n ? `Prêt ✓ ${n} références chargées.` + (installee ? '' : ' Installez l\'application : menu ⋮ > Installer l\'application.')
      : 'Connecté, mais le catalogue n\'a pas pu être chargé : vérifiez le réseau puis ouvrez ⚙ Paramètres > Tester la connexion.', 9000);
    if (accueilAffiche()) afficherAccueil();
  };
  const voile = h('div', { class: 'voile centre' },
    h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Qui utilise ce téléphone ?' },
      h('h3', {}, 'Appareil connecté ✓'),
      h('p', {}, 'Qui utilise ce téléphone ?'),
      h('div', { class: 'puces' }, noms.map(([code, nom]) => h('button', { type: 'button', onclick: () => fermer(code, nom) }, nom))),
      h('button', { class: 'btn', onclick: () => fermer(null) }, 'Passer')));
  document.body.append(voile);
}

/* ------------------------------------------------------------------ */
/* Tirer pour actualiser (écran d'accueil, téléphones)                 */
/* ------------------------------------------------------------------ */

// Envoie les fiches en attente puis recharge catalogue, historique et photos.
async function actualiserTout() {
  if (!Reglages.lire().url) return toast('Téléphone non connecté : scannez le QR code de connexion');
  if (!navigator.onLine) return toast('Pas de réseau : actualisation impossible pour le moment');
  const avant = window.Recensement ? (await Recensement.catalogue()).length : 0;
  await synchroniser({ silencieux: true, actualiser: true });
  const apres = window.Recensement ? (await Recensement.catalogue()).length : 0;
  const ecart = apres - avant;
  toast(`Actualisé ✓ — catalogue : ${apres} référence(s)${avant && ecart ? ` (${ecart > 0 ? '+' : ''}${ecart})` : ''}`);
  if (accueilAffiche()) afficherAccueil();
}

(function tirerPourActualiser() {
  const SEUIL = 70;        // px à tirer (après amortissement) pour déclencher
  const indic = h('div', { class: 'ptr', 'aria-hidden': 'true' }, h('span', { class: 'ptr-icone' }, '⟳'));
  document.body.append(indic);
  let depart = null, tire = 0, enCours = false;
  const actif = () => accueilAffiche() && !document.querySelector('.voile, .camera') && !enCours;
  const placer = d => {
    indic.style.transform = `translate(-50%, ${Math.min(d, SEUIL + 20) * 1.35 - 56}px)`;   // descend jusque sous l'en-tête
    indic.style.opacity = String(Math.min(1, d / SEUIL));
    indic.firstChild.style.transform = `rotate(${d * 4}deg)`;
    indic.classList.toggle('pret', d >= SEUIL);
  };
  const remettre = () => { indic.classList.add('retour'); placer(0); setTimeout(() => indic.classList.remove('retour'), 250); };
  addEventListener('touchstart', e => {
    depart = actif() && window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    tire = 0;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (depart === null) return;
    if (window.scrollY > 0) { depart = null; remettre(); return; }
    tire = Math.max(0, (e.touches[0].clientY - depart) * 0.5);   // amortissement : il faut tirer franchement
    placer(tire);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (depart === null) return;
    depart = null;
    if (tire < SEUIL) return remettre();
    enCours = true;
    indic.classList.add('charge'); placer(SEUIL);
    try { await actualiserTout(); } finally { enCours = false; indic.classList.remove('charge'); remettre(); }
  });
  addEventListener('touchcancel', () => { depart = null; remettre(); });
})();

// Import par adresse (usage sur PC) : index.html?importer=catalogue/catalogue.json,historique/historique-gms.json
// Seuls des fichiers servis par l'application elle-même sont acceptés.
async function importerDepuisAdresse() {
  const p = new URLSearchParams(location.search).get('importer');
  if (!p) return;
  // Réservé au PC (localhost) : en ligne, modifier le catalogue passe par le serveur ou par les paramètres verrouillés
  if (!/^(localhost|127\.)/.test(location.hostname)) { history.replaceState(history.state, '', location.pathname); return; }
  history.replaceState(history.state, '', location.pathname);
  const bilan = [];
  for (const chemin of p.split(',').map(x => x.trim()).filter(Boolean)) {
    try {
      const url = new URL(chemin, location.href);
      if (url.origin !== location.origin) throw new Error('adresse extérieure refusée');
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('fichier introuvable (' + r.status + ')');
      const j = await r.json();
      if (j.type === 'catalogue' && window.Recensement) bilan.push(`catalogue : ${await Recensement.importerCatalogue(j.produits)} réf.`);
      else if (FORMS[j.form]) bilan.push(`historique : ${await importerHistorique(FORMS[j.form], { seed: j })} PDV`);
      else throw new Error('contenu non reconnu');
    } catch (e) { bilan.push(`${chemin} : ${e.message}`); }
  }
  toast('Import — ' + bilan.join(' · '), 6000);
}

restaurerConnexion().then(importerDepuisAdresse).then(afficherAccueil).then(importerConnexion).then(() => synchroniser({ silencieux: true, actualiser: true }));
