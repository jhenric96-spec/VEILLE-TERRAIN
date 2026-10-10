/* Veille GMS basée sur le catalogue produits : une étape par catégorie, photos du rayon,
   assortiment et prix repris de la dernière visite. Les facings seront calculés à partir des photos
   (ou saisis, selon le réglage). Données envoyées en format long (une ligne par référence relevée).
   S'appuie sur app.js (h, DB, toast, Reglages…) et recensement.js (catalogue). */
'use strict';

const Veille = (() => {
  const FORM = 'veille-gms';
  const TITRE = 'Veille GMS';
  const CATEGORIES = ['EAU PLATE', 'EAU GAZEUSE', 'JUS 100%', 'JUS NECTAR', 'JUS BOISSON AUX FRUITS', 'LAIT BLANC', 'LAIT AROMATISE', 'BOISSON GAZEUSE', 'BOISSON ENERGISANTE'];
  const ETAPES = ['IDENTIFICATION', ...CATEGORIES, 'EQUIPEMENTS'];
  const ETAPE_EQUIP = ETAPES.length - 1;
  // Équipements repris de l'ancien formulaire Kobo : photos avant / après réaménagement de chaque appareil
  const EQUIPEMENTS = [
    { cle: 'frigos', nom: 'FRIGO', titre: 'Nombre de frigos présents', aide: 'PEPSI / PEPSI MAX / 7 UP / MIRINDA / KIRENE / PRESSEA' },
    { cle: 'canCoolers', nom: 'CAN COOLER', titre: 'Nombre de can coolers présents', aide: 'PEPSI / 7 UP' },
  ];
  const NB_MAX_EQUIP = 4;
  const MOMENTS = ['AVANT', 'APRES'];
  const AGE_MAX_JOURS = 120;
  // Une même catégorie peut être exposée à plusieurs endroits du magasin : chaque photo est rattachée à un emplacement.
  const EMPLACEMENTS = ['RAYON PRINCIPAL', 'FRIGO', 'DEVANTURE CAISSE', 'TETE DE GONDOLE', 'ILOT / PALETTE', 'AUTRE'];
  const empDe = (f, c, i) => ((f.emp || {})[c] || [])[i] || EMPLACEMENTS[0];
  // Seul le rayon principal entre dans le facing total ; les autres emplacements sont des emplacements secondaires.
  const EMPLACEMENT_PRINCIPAL = EMPLACEMENTS[0];
  const aSecondaire = (f, c) => ((f.emp || {})[c] || []).some(e => e !== EMPLACEMENT_PRINCIPAL) || ((V && V.empOuverts && V.empOuverts[c]) || []).length > 0;

  // La liste des magasins et des merchandisers vient du formulaire GMS importé de Kobo.
  const F = () => FORMS.gms;
  const modeFacing = () => Reglages.lire().facingMode || 'photo';
  const champMerch = () => F().sections[0].champs.find(c => c.t === 'select_one' && !c.casc);
  const merchandisers = () => F().listes[champMerch().liste] || [];
  const nomMerch = code => ((merchandisers().find(m => m[0] === code) || [])[1]) || '';
  let magasinsCache = null;
  function magasins() {
    if (!magasinsCache) magasinsCache = F().cascade.options.map(o => ({
      cle: o.map(p => p[1]).join('/'), nom: o[o.length - 1][2], chemin: o.slice(0, -1).map(p => p[2]),
      recherche: o.cle,
    }));
    return magasinsCache;
  }
  const magasin = cle => magasins().find(m => m.cle === cle);

  let V = null;   // visite en cours : { fiche, cat, parId, etape, montrer, minuteur }

  // Un prix à 0 (rencontré dans l'historique Kobo) n'est pas un prix : il reste à saisir.
  const prixValide = x => (vide(x) || !(Number(x) > 0) ? '' : Number(x));

  /* ---------- Historique : dernière visite du magasin ---------- */

  function depuisKobo(valeurs, cat) {
    const lignes = {};
    for (const p of cat) {
      if (p.KOBO_PRESENCE && valeurs[p.KOBO_PRESENCE] === 'oui') lignes[p.ID] = { prix: prixValide(valeurs[p.KOBO_PRIX]) };
    }
    return lignes;
  }

  async function derniereVisite(cleMag, exclureId, cat) {
    const cands = [];
    for (const f of await DB.tout()) {
      if (f.form !== FORM || f.id === exclureId || f.statut === 'brouillon' || f.valeurs.MAGASIN !== cleMag) continue;
      const lignes = {};
      for (const id in f.lignes) if (f.lignes[id].present === true) lignes[id] = { prix: f.lignes[id].prix };
      cands.push({ date: f.valeurs.DATE, source: 'appareil', par: nomMerch(f.valeurs.MERCH), lignes });
    }
    const s = await DB.histLire(`${FORM}|${cleMag}`);
    if (s) cands.push({ date: s.date, source: 'serveur', par: s.par || '', lignes: s.lignes });
    const k = await DB.histLire(`gms|${cleMag}`);
    if (k) cands.push({ date: k.date, source: 'Kobo', par: k.par || '', lignes: depuisKobo(k.valeurs, cat) });
    cands.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.source === 'appareil') - (a.source === 'appareil'));
    const limite = new Date(Date.now() - AGE_MAX_JOURS * 86400000).toISOString().slice(0, 10);
    return cands[0] && cands[0].date >= limite && Object.keys(cands[0].lignes).length ? cands[0] : null;
  }

  async function telechargerHistorique({ force = false } = {}) {
    const r = Reglages.lire();
    if (!r.url || !navigator.onLine) return;
    if (!force && r.histVeilleMaj && Date.now() - new Date(r.histVeilleMaj) < 6 * 3600 * 1000) return;
    try {
      const j = await appelServeur(r.url, { action: 'historiqueVeille', jeton: r.jeton });
      if (!j.ok) return;
      await DB.histMettre((j.visites || []).map(v => ({ cle: `${FORM}|${v.magasin}`, form: FORM, magasin: v.magasin, date: v.date, par: v.par, lignes: v.lignes })));
      if ((j.visites || []).length) Reglages.maj(x => { x.histVeilleMaj = maintenant(); });   // vide : nouvel essai au prochain envoi
    } catch (e) { /* nouvel essai à la prochaine synchronisation */ }
  }

  /* ---------- Accueil ---------- */

  async function carte() {
    const cat = await Recensement.catalogue();
    const r = Reglages.lire();
    const quand = Recensement.dateMajCatalogue();
    if (cat.length && r.url) {
      return h('section', { class: 'carte-form' },
        h('div', {}, h('h2', {}, TITRE),
          h('p', { class: 'discret' }, `${CATEGORIES.length} catégories · ${cat.filter(p => p.STATUT !== 'EXCLU').length} références · facings ${modeFacing() === 'photo' ? 'par photo' : 'saisis'}`),
          quand ? h('p', { class: 'discret' }, `Catalogue mis à jour ${quand}`) : null),
        h('div', { class: 'carte-actions' },
          h('button', { class: 'btn primaire', onclick: nouvelle }, '+ Nouvelle visite'),
          Recensement.boutonActualiser(() => telechargerHistorique({ force: true }))));
    }
    return h('section', { class: 'carte-form' },
      h('div', {}, h('h2', {}, TITRE),
        h('p', { class: 'discret' }, cat.length
          ? `${CATEGORIES.length} catégories · ${cat.filter(p => p.STATUT !== 'EXCLU').length} références · facings ${modeFacing() === 'photo' ? 'par photo' : 'saisis'}`
          : Reglages.lire().url ? 'Catalogue pas encore chargé sur cet appareil.' : 'Catalogue non chargé : scannez d\'abord le QR code de connexion.')),
      cat.length || !Reglages.lire().url
        ? h('button', { class: 'btn primaire', disabled: !cat.length, onclick: nouvelle }, '+ Nouvelle visite')
        : h('button', { class: 'btn primaire', onclick: async ev => {
            ev.target.disabled = true; ev.target.textContent = 'Chargement…';
            await Recensement.telechargerCatalogue({ silencieux: false });
            await Veille.telechargerHistorique({ force: true });
            afficherAccueil();
          } }, '⟳ Charger le catalogue'));
  }

  function resume(f) {
    const m = magasin(f.valeurs.MAGASIN);
    const n = Object.values(f.lignes || {}).filter(l => l.present === true).length;
    return { titre: m ? m.nom : 'Magasin non choisi', detail: [dateFr(f.valeurs.DATE), nomMerch(f.valeurs.MERCH), `${n} réf.`].filter(Boolean).join(' · ') };
  }

  /* ---------- Création / ouverture ---------- */

  async function nouvelle() {
    const memo = ((Reglages.lire().memo || {})[FORM]) || {};
    const fiche = {
      id: uuid(), form: FORM, statut: 'brouillon', creeLe: maintenant(), modifieLe: maintenant(), appareil: idAppareil(),
      valeurs: { DATE: aujourdhui(), MERCH: memo.MERCH || '', MAGASIN: '', GPS: '', DEBUT: maintenant() },
      lignes: {}, confirme: {}, photos: {}, liens: {}, emp: {}, absentes: {}, inconnus: [], prerempli: null,
      equip: { frigos: '', canCoolers: '', photos: {}, liens: {} },
    };
    await DB.mettre(fiche);
    ouvrir(fiche.id, true);
  }

  async function ouvrir(id, nouvelleVisite = false) {
    const fiche = await DB.lire(id);
    fiche.equip = fiche.equip || { frigos: '', canCoolers: '', photos: {}, liens: {} };   // visites créées avant l'étape Équipements
    const cat = (await Recensement.catalogue()).filter(p => p.STATUT !== 'EXCLU' && p.ID && !String(p.ID).startsWith('('));
    V = { fiche, cat, parId: Object.fromEntries(cat.map(p => [p.ID, p])), etape: 0, montrer: false, mini: await Recensement.miniatures() };
    history.pushState({ vue: 'veille' }, '');
    construire();
    if (nouvelleVisite) capturerGps();
  }

  function sauver() {
    V.fiche.modifieLe = maintenant();
    clearTimeout(V.minuteur);
    const fiche = V.fiche;
    V.minuteur = setTimeout(() => DB.mettre(fiche), 400);
  }

  /* ---------- Contrôles ---------- */

  const uniteDe = p => `${p.CATEGORIE}|${p.MARQUE}`;
  // photos[c] (sur l'appareil) et liens[c] (déjà envoyées) sont parallèles ; après envoi, seules les liens restent.
  const photosDe = c => Math.max((V.fiche.photos[c] || []).length, (V.fiche.liens[c] || []).filter(Boolean).length);

  function unitesAVerifier() {
    const res = new Set();
    if (!V.fiche.prerempli) return res;
    for (const id in V.fiche.lignes) {
      const l = V.fiche.lignes[id], p = V.parId[id];
      if (l.repris && p && !V.fiche.absentes[p.CATEGORIE] && !V.fiche.confirme[uniteDe(p)]) res.add(uniteDe(p));
    }
    return res;
  }

  const photoEquip = (f, cle) => !!(f.equip.photos[cle] || f.equip.liens[cle]);

  /* ---------- Éviter de compter un produit deux fois ----------
     1. Prise guidée : chaque module suivant recouvre le précédent d'une bande de largeur fixe (RECOUVREMENT),
        enregistrée avec la photo. Règle de comptage : un produit dont le centre est dans cette bande
        appartient à la photo précédente et n'est pas recompté.
     2. Empreinte visuelle : une photo presque identique à une photo déjà prise (même module photographié
        deux fois) est signalée avant d'être ajoutée. */
  const RECOUVREMENT = 0.15;
  const SEUIL_DOUBLON = 5;   // bits différents sur 64

  // Empreinte « dHash » : 64 bits comparant la luminosité de pixels voisins sur une image réduite à 9×8
  function empreinte(data) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas'); cv.width = 9; cv.height = 8;
        const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 9, 8);
        const d = g.getImageData(0, 0, 9, 8).data;
        const lum = i => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        let bits = '';
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += lum((y * 9 + x) * 4) > lum((y * 9 + x + 1) * 4) ? '1' : '0';
        res(bits);
      };
      img.onerror = () => res('');
      img.src = data;
    });
  }
  const ecart = (a, b) => { let n = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++; return n; };

  const cameraDispo = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const metaDe = (f, c, i) => ((f.meta || {})[c] || [])[i] || { prise: 'libre', direction: '', recouvrement: 0 };

  // Caméra intégrée : le bord du module précédent s'affiche en transparence pour cadrer le suivant.
  async function cameraGuidee(c, e) {
    let flux;
    try {
      flux = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
    } catch (err) { toast('Caméra indisponible : utilisez « Appareil photo du téléphone »', 5000); return; }
    const f = V.fiche;
    let direction = V.direction || 'droite';
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    video.srcObject = flux;
    const guide = h('div', { class: 'camera-guide' });
    const scene = h('div', { class: 'camera-scene' }, video, guide);
    const cadre = h('div', { class: 'camera-cadre' }, scene);
    const info = h('p', { class: 'camera-info' });
    const flash = h('div', { class: 'camera-flash' });
    const dirs = h('div', { class: 'puces camera-dir' },
      h('button', { type: 'button', 'data-dir': 'droite' }, 'Suite à droite →'),
      h('button', { type: 'button', 'data-dir': 'bas' }, 'Suite en dessous ↓'));
    const indices = () => (f.photos[c] || []).map((x, i) => i).filter(i => empDe(f, c, i) === e && f.photos[c][i]);
    // La vidéo est affichée en entier (contain) : la bande guide doit suivre le rectangle réellement visible.
    const placer = () => {
      if (!video.videoWidth) return;
      const W = cadre.clientWidth, H = cadre.clientHeight, r = video.videoWidth / video.videoHeight;
      const w = Math.min(W, H * r), hh = w / r;
      Object.assign(scene.style, { width: w + 'px', height: hh + 'px', left: (W - w) / 2 + 'px', top: (H - hh) / 2 + 'px' });
    };
    const maj = () => {
      const idx = indices();
      const prec = idx.length ? f.photos[c][idx[idx.length - 1]] : null;
      guide.hidden = !prec; dirs.hidden = !prec;
      if (prec) {
        guide.className = 'camera-guide ' + direction;
        guide.style.backgroundImage = `url(${prec})`;
        guide.style.setProperty('--recouvrement', (RECOUVREMENT * 100) + '%');
        guide.style.setProperty('--zoom', (100 / RECOUVREMENT) + '%');
      }
      dirs.querySelectorAll('button').forEach(b => b.classList.toggle('actif', b.dataset.dir === direction));
      info.textContent = prec
        ? `Module ${idx.length + 1} : faites coïncider la bande transparente avec le ${direction === 'droite' ? 'bord droit' : 'bas'} du module ${idx.length}. Les produits de cette bande ne seront pas recomptés.`
        : 'Module 1 : cadrez le premier module en entier, de face.';
    };
    const fermer = () => { flux.getTracks().forEach(t => t.stop()); window.removeEventListener('resize', placer); voile.remove(); rendre(); };
    const declencher = async () => {
      if (!video.videoWidth) return;
      const cv = document.createElement('canvas');
      const r = Math.min(1, 2000 / Math.max(video.videoWidth, video.videoHeight));
      cv.width = Math.round(video.videoWidth * r); cv.height = Math.round(video.videoHeight * r);
      cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
      const suite = indices().length > 0;
      flash.classList.remove('actif'); void flash.offsetWidth; flash.classList.add('actif');
      const ok = await ajouterPhoto(c, e, cv.toDataURL('image/jpeg', 0.8),
        { prise: 'guidee', direction: suite ? direction : '', recouvrement: suite ? RECOUVREMENT : 0 });
      if (ok) { V.direction = direction; maj(); toast(`Module ${indices().length} enregistré`, 1500); }
    };
    dirs.addEventListener('click', ev => { const b = ev.target.closest('button'); if (b) { direction = b.dataset.dir; maj(); } });
    video.addEventListener('loadedmetadata', placer);
    window.addEventListener('resize', placer);
    const voile = h('div', { class: 'camera', role: 'dialog', 'aria-label': 'Prise de vue guidée' },
      h('div', { class: 'camera-haut' }, h('strong', {}, `${c} · ${e}`), h('button', { class: 'btn petit', onclick: fermer }, 'Terminer')),
      cadre, info, dirs,
      h('button', { class: 'camera-declencheur', 'aria-label': 'Prendre la photo', onclick: declencher }), flash);
    document.body.append(voile);
    maj();
  }

  // Ajoute une photo à un emplacement, après contrôle de doublon. Renvoie false si le merchandiser renonce.
  async function ajouterPhoto(c, e, data, meta) {
    const f = V.fiche;
    f.emp = f.emp || {}; f.meta = f.meta || {};
    const n = (f.photos[c] || []).length;
    f.emp[c] = Array.from({ length: n }, (x, i) => empDe(f, c, i));
    f.meta[c] = Array.from({ length: n }, (x, i) => ((f.meta[c] || [])[i]) || { prise: 'libre' });
    const hash = await empreinte(data);
    if (hash) {
      for (const c2 of Object.keys(f.meta)) {
        const k = (f.meta[c2] || []).findIndex(m => m && m.hash && ecart(m.hash, hash) <= SEUIL_DOUBLON);
        if (k < 0) continue;
        const ok = confirm(`Cette photo est presque identique à la photo ${numeroModule(f, c2, k)} « ${empDe(f, c2, k)} » de ${c2}.\n`
          + 'Si c\'est le même module, ses produits seraient comptés deux fois.\n\nOK = la garder quand même · Annuler = ne pas l\'ajouter');
        if (!ok) return false;
        break;
      }
    }
    (f.photos[c] = f.photos[c] || []).push(data);
    f.emp[c].push(e);
    f.meta[c].push(Object.assign({ hash }, meta));
    sauver();
    return true;
  }

  // Liste des problèmes bloquants, par étape
  function problemes() {
    const f = V.fiche, pb = ETAPES.map(() => []);
    if (!f.valeurs.MERCH) pb[0].push('merchandiser');
    if (!f.valeurs.MAGASIN) pb[0].push('magasin');
    if (!f.valeurs.GPS) pb[0].push('position GPS');
    const aVerif = unitesAVerifier();
    CATEGORIES.forEach((c, i) => {
      if (f.absentes[c]) return;
      if (!photosDe(c)) pb[i + 1].push('photo du rayon');
      for (const id in f.lignes) {
        const l = f.lignes[id], p = V.parId[id];
        if (!p || p.CATEGORIE !== c || l.present !== true) continue;
        if (!(Number(l.prix) > 0)) pb[i + 1].push(`prix ${p.NOM_SYSTEME}`);
        if (modeFacing() === 'saisie' && vide(l.facing)) pb[i + 1].push(`facing ${p.NOM_SYSTEME}`);
      }
      aVerif.forEach(u => { if (u.startsWith(c + '|')) pb[i + 1].push('marque ' + u.split('|')[1] + ' à vérifier'); });
    });
    // Équipements : nombre obligatoire (0 compris), puis photo avant et après pour chaque appareil
    for (const q of EQUIPEMENTS) {
      const n = f.equip[q.cle];
      if (n === '' || n == null) { pb[ETAPE_EQUIP].push(q.titre.toLowerCase()); continue; }
      for (let k = 1; k <= n; k++) {
        for (const m of MOMENTS) if (!photoEquip(f, `${q.nom} ${k} ${m}`)) pb[ETAPE_EQUIP].push(`photo ${q.nom} ${k} ${m.toLowerCase()}`);
      }
    }
    return pb;
  }

  /* ---------- Écran ---------- */

  function construire() {
    vider();
    const nav = h('button', { class: 'nav-etape', onclick: sommaire });
    V.nav = nav;
    V.corps = h('main', { class: 'editeur' });
    V.prec = h('button', { class: 'btn', onclick: () => aller(V.etape - 1) }, '← Précédent');
    V.suiv = h('button', { class: 'btn primaire', onclick: () => (V.etape === ETAPES.length - 1 ? terminer() : aller(V.etape + 1)) });
    racineApp.append(
      h('header', { class: 'barre collante' }, h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: () => history.back() }, '←'), nav),
      V.corps, h('footer', { class: 'pied' }, V.prec, V.suiv));
    V.corps.addEventListener('click', surClic);
    V.corps.addEventListener('input', surSaisie);
    V.corps.addEventListener('change', surChangement);
    aller(0);
  }

  function aller(i) {
    if (i < 0 || i >= ETAPES.length) return;
    V.etape = i;
    rendre();
    window.scrollTo(0, 0);
  }

  function majNav() {
    const pb = problemes();
    const n = pb[V.etape].length;
    V.nav.replaceChildren(h('small', {}, `Étape ${V.etape + 1}/${ETAPES.length}`), h('span', {}, ETAPES[V.etape], ' ▾'),
      h('small', { class: n ? 'a-faire' : 'fait' }, n ? `${n} point(s) à compléter` : '✓ complet'));
    V.prec.disabled = V.etape === 0;
    V.suiv.textContent = V.etape === ETAPES.length - 1 ? 'Terminer ✓' : 'Suivant →';
  }

  function sommaire() {
    const pb = problemes();
    const fermer = () => voile.remove();
    const voile = h('div', { class: 'voile', onclick: e => { if (e.target === voile) fermer(); } },
      h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Étapes' }, h('h3', {}, 'Étapes'),
        ETAPES.map((t, i) => h('button', { class: 'sommaire-ligne' + (i === V.etape ? ' actif' : ''), onclick: () => { fermer(); aller(i); } },
          h('span', {}, `${i + 1}. ${t}`),
          h('small', { class: pb[i].length ? 'a-faire' : 'fait' }, V.fiche.absentes[t] ? 'absente' : pb[i].length ? `${pb[i].length} à compléter` : '✓'))),
        h('button', { class: 'btn', onclick: fermer }, 'Fermer')));
    document.body.append(voile);
  }

  function rendre() {
    const y = window.scrollY;
    V.corps.replaceChildren(V.etape === 0 ? etapeIdentification() : V.etape === ETAPE_EQUIP ? etapeEquipements() : etapeCategorie(CATEGORIES[V.etape - 1]));
    window.scrollTo(0, y);
    majNav();
  }

  /* ----- Identification ----- */

  function etapeIdentification() {
    const f = V.fiche, v = f.valeurs;
    const m = magasin(v.MAGASIN);
    const blocs = [h('h2', { class: 'section-tete' }, 'IDENTIFICATION')];

    const [lat, lon, , acc] = String(v.GPS || '').split(' ').map(Number);
    blocs.push(h('div', { class: 'champ' + (V.montrer && !v.GPS ? ' manque' : '') },
      h('span', { class: 'champ-lib' }, 'Localisation PDV', h('span', { class: 'req' }, ' *')),
      V.gpsMsg ? h('div', { class: 'discret' }, V.gpsMsg) : null,
      v.GPS ? h('div', {}, h('strong', {}, `${lat.toFixed(6)}, ${lon.toFixed(6)}`), ` · précision ±${Math.round(acc)} m`) : h('div', { class: 'discret' }, 'Aucune position.'),
      v.GPS && acc > 50 ? h('div', { class: 'avert' }, 'Précision faible : sortez du bâtiment ou réessayez.') : null,
      h('button', { class: 'btn', 'data-act': 'gps' }, 'Capturer la position')));

    blocs.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Date', h('span', { class: 'req' }, ' *')),
      h('input', { type: 'date', value: v.DATE, 'data-champ': 'DATE' })));

    blocs.push(h('div', { class: 'champ' + (V.montrer && !v.MERCH ? ' manque' : '') },
      h('span', { class: 'champ-lib' }, 'Merchandiser', h('span', { class: 'req' }, ' *')),
      h('div', { class: 'puces' }, merchandisers().map(([code, lib]) => h('button', { type: 'button', class: v.MERCH === code ? 'actif' : '', 'data-act': 'merch', 'data-v': code }, lib)))));

    const recherche = h('input', { type: 'search', class: 'recherche', placeholder: 'Rechercher (ex. auchan mermoz, shell, edk…)', autocomplete: 'off' });
    const liste = h('div', { class: 'casc-liste' });
    const remplir = () => {
      const mots = sansAccents(recherche.value).split(/\s+/).filter(Boolean);
      const res = magasins().filter(x => mots.every(w => x.recherche.includes(w)));
      liste.replaceChildren(...res.slice(0, 60).map(x => h('button', { type: 'button', class: 'casc-option', 'data-act': 'magasin', 'data-v': x.cle },
        h('strong', {}, x.nom), h('small', {}, x.chemin.join(' › ')))));
    };
    recherche.addEventListener('input', remplir);
    blocs.push(h('div', { class: 'champ' + (V.montrer && !v.MAGASIN ? ' manque' : '') },
      h('span', { class: 'champ-lib' }, 'Magasin', h('span', { class: 'req' }, ' *')),
      m ? h('div', { class: 'casc-choisi' }, h('div', {}, h('strong', {}, m.nom), h('small', { class: 'discret' }, m.chemin.join(' › '))),
        h('button', { class: 'btn petit', 'data-act': 'changer-magasin' }, 'Changer')) : [recherche, liste]));
    if (!m) setTimeout(remplir, 0);

    if (f.prerempli) {
      blocs.push(h('div', { class: 'bandeau-repris' },
        `Assortiment et prix repris de la visite du ${dateFr(f.prerempli.date)}${f.prerempli.par ? ' (' + f.prerempli.par + ')' : ''}, source ${f.prerempli.source} : `,
        `${f.prerempli.nb} référence(s). Dans chaque catégorie, marquez les absents, corrigez les prix et touchez « ✓ Conforme » pour les marques identiques.`));
    } else if (m) {
      blocs.push(h('div', { class: 'bandeau-repris' }, 'Pas de visite récente connue pour ce magasin : ajoutez les produits présents dans chaque catégorie.'));
    }
    return h('section', {}, blocs);
  }

  async function choisirMagasin(cle) {
    const f = V.fiche;
    if (f.valeurs.MAGASIN === cle) return;
    f.valeurs.MAGASIN = cle;
    f.lignes = {}; f.confirme = {}; f.prerempli = null;
    const d = await derniereVisite(cle, f.id, V.cat);
    if (d) {
      let nb = 0;
      for (const id in d.lignes) {
        if (!V.parId[id]) continue;
        const prix = prixValide(d.lignes[id].prix);
        f.lignes[id] = { present: true, prix, facing: '', repris: { prix } };
        nb++;
      }
      f.prerempli = { date: d.date, par: d.par, source: d.source, nb };
      toast(`${nb} référence(s) reprise(s) de la visite du ${dateFr(d.date)}`);
    }
    sauver();
    rendre();
  }

  /* ----- Catégorie ----- */

  function etapeCategorie(c) {
    const f = V.fiche;
    const absente = !!f.absentes[c];
    const aVerif = unitesAVerifier();
    const blocs = [h('div', { class: 'section-tete' }, h('h2', {}, c))];

    blocs.push(h('label', { class: 'case champ' }, h('input', { type: 'checkbox', checked: absente, 'data-act': 'absente', 'data-v': c }),
      ' Aucun produit de cette catégorie dans le magasin'));
    if (absente) return h('section', {}, blocs);

    // Photos, par emplacement (rayon principal, frigo, devanture caisse…)
    const photos = (f.photos[c] || []).map((data, i) => ({ src: data, i, emp: empDe(f, c, i) }));
    const envoyees = (f.photos[c] || []).length ? 0 : (f.liens[c] || []).filter(Boolean).length;
    V.empOuverts = V.empOuverts || {};
    const ouverts = new Set([EMPLACEMENTS[0], ...photos.map(p => p.emp), ...(V.empOuverts[c] || [])]);
    blocs.push(h('div', { class: 'champ' + (V.montrer && !photosDe(c) ? ' manque' : '') },
      h('span', { class: 'champ-lib' }, 'Photos', h('span', { class: 'req' }, ' *')),
      h('small', { class: 'aide' }, 'Photographiez chaque endroit où la catégorie est exposée : une photo par module, de face, en entier, '
        + 'porte du frigo ouverte, sans reflet. Ne photographiez pas deux fois le même module. '
        + 'RAYON PRINCIPAL = emplacement principal de la catégorie (en station-service, souvent le frigo boissons) : '
        + 'seul lui compte dans le facing total ; les autres emplacements sont suivis à part.'
        + (modeFacing() === 'photo' ? ' Les facings seront comptés sur ces photos.' : '')),
      h('details', { class: 'consignes' }, h('summary', {}, 'Rayon trop grand pour une seule photo ?'),
        h('ul', {},
          h('li', {}, 'Utilisez la prise guidée : une photo par module, de gauche à droite. Pour le module suivant, faites coïncider '
            + 'la bande transparente avec le bord du module précédent : les produits de cette bande ne seront pas recomptés.'),
          h('li', {}, 'Rayon trop haut : faites d\'abord le haut, puis choisissez « Suite en dessous ↓ » pour le bas.'),
          h('li', {}, 'Avec l\'appareil photo du téléphone (sans guide) : coupez aux montants et aux étagères, sans aucun chevauchement entre deux photos.'),
          h('li', {}, 'Une photo presque identique à une photo déjà prise est signalée : c\'est souvent le même module photographié deux fois.'),
          h('li', {}, 'Reculez autant que l\'allée le permet ; téléphone en hauteur pour un module haut, en largeur pour un module large.'),
          h('li', {}, 'Pas de mode panorama : il déforme le rayon et fausse le comptage.'))),
      EMPLACEMENTS.filter(e => ouverts.has(e)).map(e => {
        const siennes = photos.filter(p => p.emp === e);
        return h('div', { class: 'emplacement' },
          h('div', { class: 'emplacement-tete' }, h('strong', {}, e), h('small', { class: 'discret' }, siennes.length ? `${siennes.length} photo(s)` : 'aucune photo')),
          h('div', { class: 'vignettes' }, siennes.map((p, k) => h('div', { class: 'vignette' }, h('img', { src: p.src, alt: `Photo ${e} module ${k + 1}` }),
            h('span', { class: 'numero-module', title: metaDe(f, c, p.i).prise === 'guidee' ? 'Prise guidée' : 'Photo libre' },
              String(k + 1) + ({ droite: ' →', bas: ' ↓' }[metaDe(f, c, p.i).direction] || '')),
            h('button', { class: 'btn petit danger', 'data-act': 'suppr-photo', 'data-v': c, 'data-i': p.i }, '×')))),
          h('div', { class: 'ligne' },
            cameraDispo() ? h('button', { type: 'button', class: 'btn primaire', 'data-act': 'camera', 'data-v': c, 'data-e': e },
              siennes.length ? '📷 Module suivant (guidé)' : '📷 Prise guidée') : null,
            h('label', { class: 'btn' + (cameraDispo() ? ' petit' : '') }, cameraDispo() ? 'Appareil photo du téléphone' : '📷 Ajouter une photo',
              h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque', 'data-photo': c, 'data-emp': e }))));
      }),
      EMPLACEMENTS.some(e => !ouverts.has(e)) ? h('div', {}, h('small', { class: 'discret' }, 'Produits exposés ailleurs dans le magasin ?'),
        h('div', { class: 'puces' }, EMPLACEMENTS.filter(e => !ouverts.has(e)).map(e =>
          h('button', { type: 'button', 'data-act': 'emplacement', 'data-v': c, 'data-e': e }, '+ ' + e)))) : null,
      envoyees ? h('small', { class: 'discret' }, `${envoyees} photo(s) déjà envoyée(s)`) : null));

    // Produits relevés, groupés par marque
    const ids = Object.keys(f.lignes).filter(id => V.parId[id] && V.parId[id].CATEGORIE === c)
      .sort((a, b) => V.parId[a].MARQUE.localeCompare(V.parId[b].MARQUE) || V.parId[a].NOM_SYSTEME.localeCompare(V.parId[b].NOM_SYSTEME));
    const parMarque = {};
    ids.forEach(id => { (parMarque[V.parId[id].MARQUE] = parMarque[V.parId[id].MARQUE] || []).push(id); });
    const presents = ids.filter(id => f.lignes[id].present === true).length;
    blocs.push(h('p', { class: 'discret' }, `${presents} produit(s) présent(s)` + (ids.length > presents ? ` · ${ids.length - presents} absent(s)` : '')));
    for (const marque in parMarque) {
      const u = `${c}|${marque}`;
      const av = aVerif.has(u);
      blocs.push(h('div', { class: 'groupe' + (av ? ' a-verifier' : '') },
        h('div', { class: 'groupe-tete' }, h('span', { class: 'groupe-nom' }, marque)),
        h('div', { class: 'groupe-corps' }, parMarque[marque].map(id => ligneProduit(id, marque))),
        av ? h('div', { class: 'verif' }, h('span', { class: 'verif-texte' }, `Repris du ${dateFr(f.prerempli.date)}`),
          h('button', { class: 'btn petit conforme', 'data-act': 'conforme', 'data-v': u }, '✓ Conforme')) : null));
    }

    // Facing total par segment (affiché quand les facings sont saisis)
    const segs = Recensement.SEGMENTS.filter(s => s.cat === c);
    if (modeFacing() === 'saisie' && ids.length) {
      const totaux = totauxFacing(f, V.parId);
      blocs.push(h('div', { class: 'champ total' }, h('span', { class: 'champ-lib' }, 'Facing total'),
        segs.map(s => h('div', { class: 'ligne-total' }, h('span', {}, s.nom), h('strong', { 'data-total': s.nom }, String(totaux[s.nom] || 0))))));
    }

    // Ajout d'un produit du catalogue
    const recherche = h('input', { type: 'search', class: 'recherche', placeholder: 'Ajouter un produit présent : marque, parfum, format…', autocomplete: 'off' });
    const res = h('div', { class: 'casc-liste' });
    recherche.addEventListener('input', () => {
      const mots = sansAccents(recherche.value).split(/\s+/).filter(Boolean);
      if (!mots.length) { res.replaceChildren(); return; }
      const trouves = V.cat.filter(p => p.CATEGORIE === c && !f.lignes[p.ID] && mots.every(w => p.cle.includes(w)));
      res.replaceChildren(...trouves.slice(0, 30).map(p => h('button', { type: 'button', class: 'casc-option avec-photo', 'data-act': 'ajouter', 'data-v': p.ID },
        (V.mini || {})[p.ID] ? h('img', { class: 'mini-photo', src: V.mini[p.ID].data, alt: '' }) : h('span', { class: 'mini-photo vide' }, '📷'),
        h('span', {}, h('strong', {}, p.NOM_SYSTEME), h('small', {}, p.ID)))),
      trouves.length ? '' : h('p', { class: 'discret' }, 'Introuvable dans le catalogue : utilisez « Produit absent du catalogue ».'));
    });
    blocs.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Ajouter un produit présent en rayon'), recherche, res,
      h('button', { class: 'btn', 'data-act': 'inconnu', 'data-v': c }, '+ Produit absent du catalogue')));

    // Produits hors catalogue (à vérifier)
    const inconnus = f.inconnus.filter(x => x.categorie === c);
    if (inconnus.length) {
      blocs.push(h('div', { class: 'groupe' }, h('div', { class: 'groupe-tete' }, h('span', { class: 'groupe-nom' }, 'Hors catalogue (à vérifier)')),
        h('div', { class: 'groupe-corps' }, inconnus.map(x => h('div', { class: 'produit' },
          h('div', { class: 'produit-tete' }, h('span', { class: 'produit-nom' }, x.description + (vide(x.prix) ? '' : ` · ${x.prix} F`)),
            h('button', { class: 'btn petit danger', 'data-act': 'suppr-inconnu', 'data-v': x.id }, 'Retirer')))))));
    }
    return h('section', {}, blocs);
  }

  /* ----- Équipements (frigos, can coolers) ----- */

  function etapeEquipements() {
    const f = V.fiche, e = f.equip;
    const blocs = [h('div', { class: 'section-tete' }, h('h2', {}, 'ÉQUIPEMENTS'))];
    for (const q of EQUIPEMENTS) {
      const n = e[q.cle];
      blocs.push(h('div', { class: 'champ' + (V.montrer && (n === '' || n == null) ? ' manque' : '') },
        h('span', { class: 'champ-lib' }, q.titre, h('span', { class: 'req' }, ' *')),
        h('small', { class: 'aide' }, q.aide),
        h('div', { class: 'puces' }, Array.from({ length: NB_MAX_EQUIP + 1 }, (x, k) =>
          h('button', { type: 'button', class: n === k ? 'actif' : '', 'data-act': 'equip-nb', 'data-v': q.cle, 'data-n': k }, String(k))))));
      for (let k = 1; k <= (Number(n) || 0); k++) {
        blocs.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, `${q.nom} ${k}`),
          h('div', { class: 'avant-apres' }, MOMENTS.map(m => {
            const cle = `${q.nom} ${k} ${m}`;
            const data = e.photos[cle];
            const manque = V.montrer && !photoEquip(f, cle);
            return h('div', { class: 'emplacement' + (manque ? ' manque' : '') },
              h('div', { class: 'emplacement-tete' }, h('strong', {}, m === 'AVANT' ? 'Avant réaménagement' : 'Après réaménagement')),
              data ? h('div', { class: 'vignette' }, h('img', { src: data, alt: cle }),
                h('button', { class: 'btn petit danger', 'data-act': 'suppr-equip', 'data-v': cle }, '×'))
                : e.liens[cle] ? h('small', { class: 'discret' }, 'Photo envoyée') : null,
              data ? null : h('label', { class: 'btn' }, '📷 Photo',
                h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque', 'data-equip': cle })));
          }))));
      }
    }
    return h('section', {}, blocs);
  }

  // Photo de référence du produit, pour ne pas confondre deux références voisines au moment du prix
  function vignetteProduit(id) {
    const m = (V.mini || {})[id];
    if (!m) return h('span', { class: 'mini-photo vide', title: 'Pas encore de photo de référence (recensement)' }, '📷');
    return h('button', { type: 'button', class: 'mini-photo', 'data-act': 'apercu', 'data-v': id, 'aria-label': 'Agrandir la photo' },
      h('img', { src: m.data, alt: V.parId[id] ? V.parId[id].NOM_SYSTEME : id }));
  }

  function apercuProduit(id) {
    const m = (V.mini || {})[id], p = V.parId[id];
    if (!m) return;
    const fermer = () => voile.remove();
    const voile = h('div', { class: 'voile centre', onclick: fermer },
      h('div', { class: 'apercu-produit' }, h('img', { src: m.data, alt: p.NOM_SYSTEME }), h('strong', {}, p.NOM_SYSTEME), h('small', {}, `${p.ID} · ${p.CATEGORIE}`)));
    document.body.append(voile);
  }

  function ligneProduit(id, marque) {
    const l = V.fiche.lignes[id], p = V.parId[id];
    const court = p.NOM_SYSTEME.startsWith(marque + ' ') ? p.NOM_SYSTEME.slice(marque.length + 1) : p.NOM_SYSTEME;
    const absent = l.present === false;
    // Prix : obligatoire et > 0 ; facing rayon : obligatoire (0 admis si le produit n'est qu'en emplacement secondaire)
    const manque = champ => champ === 'prix' ? !(Number(l.prix) > 0) : champ === 'facing' ? vide(l.facing) : false;
    const mini = (lib, champ, info) => h('label', { class: 'mini' + (V.montrer && manque(champ) ? ' manque' : '') }, h('span', { class: 'mini-lib' }, lib),
      h('input', { type: 'text', inputmode: 'numeric', value: l[champ] ?? '', 'data-ref': id, 'data-champ': champ, autocomplete: 'off' }),
      info ? h('small', { class: 'mini-info' }, info) : null);
    return h('div', { class: 'produit' + (absent ? ' absent' : '') },
      h('div', { class: 'produit-tete' }, vignetteProduit(id), h('span', { class: 'produit-nom' }, court),
        h('button', { class: 'btn petit' + (absent ? ' danger' : ''), 'data-act': 'absent', 'data-v': id },
          absent ? 'Absent · remettre' : l.repris ? 'Absent' : 'Retirer')),
      absent ? null : h('div', { class: 'valeurs' },
        mini('Prix', 'prix', l.repris ? (vide(l.repris.prix) ? 'prix précédent inconnu' : `dernier : ${l.repris.prix} F`) : null),
        modeFacing() === 'saisie' ? mini('Facing rayon', 'facing') : null,
        modeFacing() === 'saisie' && aSecondaire(V.fiche, p.CATEGORIE) ? mini('Facing hors rayon', 'facingSec', 'non compté dans le total') : null));
  }

  /* ----- Événements ----- */

  function toucher(id) {
    const p = V.parId[id];
    if (p && V.fiche.prerempli) V.fiche.confirme[uniteDe(p)] = true;
  }

  function surClic(ev) {
    const b = ev.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const f = V.fiche, v = b.dataset.v;
    switch (b.dataset.act) {
      case 'gps': capturerGps(); return;
      case 'merch': f.valeurs.MERCH = v; break;
      case 'magasin': choisirMagasin(v); return;
      case 'changer-magasin':
        if (Object.keys(f.lignes).length && !confirm('Changer de magasin efface les produits déjà relevés. Continuer ?')) return;
        f.valeurs.MAGASIN = ''; f.prerempli = null; f.lignes = {}; f.confirme = {};
        break;
      case 'conforme': f.confirme[v] = true; break;
      case 'ajouter': f.lignes[v] = { present: true, prix: '', facing: '' }; toucher(v); break;
      case 'absent': {
        const l = f.lignes[v];
        if (!l.repris) delete f.lignes[v];          // ajouté par erreur : on le retire
        else l.present = l.present === false;        // repris : bascule présent / absent
        toucher(v);
        break;
      }
      case 'suppr-photo': {
        const i = Number(b.dataset.i);
        f.photos[v].splice(i, 1);
        if (f.liens[v]) f.liens[v].splice(i, 1);
        if (f.emp && f.emp[v]) f.emp[v].splice(i, 1);
        if (f.meta && f.meta[v]) f.meta[v].splice(i, 1);
        break;
      }
      case 'camera': cameraGuidee(v, b.dataset.e); return;
      case 'apercu': apercuProduit(v); return;
      case 'emplacement':
        V.empOuverts[v] = (V.empOuverts[v] || []).concat(b.dataset.e);
        break;
      case 'equip-nb': {
        const n = Number(b.dataset.n), q = EQUIPEMENTS.find(x => x.cle === v);
        f.equip[v] = n;
        // Les photos des appareils retirés ne sont plus utiles
        for (const cle of Object.keys(f.equip.photos)) {
          const m = cle.match(new RegExp(`^${q.nom} (\\d+) `));
          if (m && Number(m[1]) > n) { delete f.equip.photos[cle]; delete f.equip.liens[cle]; }
        }
        break;
      }
      case 'suppr-equip': delete f.equip.photos[v]; delete f.equip.liens[v]; break;
      case 'inconnu': saisirInconnu(v); return;
      case 'suppr-inconnu': f.inconnus = f.inconnus.filter(x => x.id !== v); break;
      default: return;
    }
    sauver();
    rendre();
  }

  function surSaisie(ev) {
    const t = ev.target;
    if (t.dataset.ref) {
      const val = t.value.replace(/\D/g, '');
      if (val !== t.value) t.value = val;
      V.fiche.lignes[t.dataset.ref][t.dataset.champ] = val === '' ? '' : Number(val);
      toucher(t.dataset.ref);
      sauver();
      majNav();
      if (t.dataset.champ === 'facing') {   // totaux (rayon principal) mis à jour sans redessiner : le curseur reste dans le champ
        const totaux = totauxFacing(V.fiche, V.parId);
        V.corps.querySelectorAll('[data-total]').forEach(el => { el.textContent = String(totaux[el.dataset.total] || 0); });
      }
    } else if (t.dataset.champ === 'DATE') { V.fiche.valeurs.DATE = t.value; sauver(); }
  }

  async function surChangement(ev) {
    const t = ev.target;
    if (t.dataset.act === 'absente') {
      V.fiche.absentes[t.dataset.v] = t.checked;
      sauver(); rendre(); return;
    }
    if (t.dataset.equip && t.files[0]) {
      try {
        V.fiche.equip.photos[t.dataset.equip] = await compresserImage(t.files[0], 1600, 0.8);
        delete V.fiche.equip.liens[t.dataset.equip];
        sauver(); rendre();
      } catch (e) { toast('Photo illisible, réessayez'); }
      return;
    }
    if (t.dataset.photo && t.files[0]) {
      const c = t.dataset.photo;
      try {
        const data = await compresserImage(t.files[0], 2000, 0.8);   // résolution suffisante pour compter les facings
        // Photo libre (appareil photo du téléphone) : pas de recouvrement guidé, consigne « aucun chevauchement »
        await ajouterPhoto(c, t.dataset.emp || EMPLACEMENTS[0], data, { prise: 'libre', direction: '', recouvrement: 0 });
        rendre();
      } catch (e) { toast('Photo illisible, réessayez'); }
    }
  }

  function saisirInconnu(c) {
    let photo = null;
    const apercu = h('div', { class: 'photo-apercu' });
    const entree = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque' });
    entree.addEventListener('change', async () => {
      if (!entree.files[0]) return;
      photo = await compresserImage(entree.files[0], 1600, 0.85);
      apercu.replaceChildren(h('img', { src: photo, alt: 'Produit' }));
    });
    const desc = h('input', { type: 'text', class: 'maj', placeholder: 'Marque, parfum, format, emballage', autocomplete: 'off' });
    const prix = h('input', { type: 'text', inputmode: 'numeric', class: 'court', placeholder: 'Prix' });
    const fermer = () => voile.remove();
    const voile = h('div', { class: 'voile' }, h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Produit hors catalogue' },
      h('h3', {}, `Produit hors catalogue · ${c}`),
      h('small', { class: 'aide' }, 'Il ne sera pas compté tant qu\'il n\'est pas validé et ajouté au catalogue.'),
      apercu, h('label', { class: 'btn' }, '📷 Photo de face *', entree),
      h('span', { class: 'champ-lib' }, 'Description *'), desc,
      h('span', { class: 'champ-lib' }, 'Prix relevé'), prix,
      h('div', { class: 'actions-bas' }, h('button', { class: 'btn', onclick: fermer }, 'Annuler'),
        h('button', { class: 'btn primaire', onclick: () => {
          if (!photo || !desc.value.trim()) return toast('Photo et description obligatoires');
          V.fiche.inconnus.push({ id: uuid(), categorie: c, description: sansAccents(desc.value).toUpperCase().trim(), prix: Number(prix.value.replace(/\D/g, '')) || '', photo });
          fermer(); sauver(); rendre();
        } }, 'Ajouter'))));
    document.body.append(voile);
  }

  /* ----- GPS ----- */

  function capturerGps() {
    if (!navigator.geolocation) return toast('GPS indisponible sur cet appareil');
    const fiche = V.fiche;
    let meilleur = null;
    V.gpsMsg = 'Recherche de la position…';
    if (V.etape === 0) rendre();
    const fin = msg => {
      navigator.geolocation.clearWatch(id); clearTimeout(limite);
      if (!V || V.fiche !== fiche) return;
      V.gpsMsg = '';
      if (meilleur) { fiche.valeurs.GPS = meilleur; sauver(); } else toast(msg || 'Position introuvable');
      if (V.etape === 0) rendre(); else majNav();
    };
    const id = navigator.geolocation.watchPosition(p => {
      const c = p.coords;
      if (!meilleur || c.accuracy < Number(meilleur.split(' ')[3])) meilleur = `${c.latitude} ${c.longitude} ${c.altitude || 0} ${c.accuracy}`;
      if (V && V.fiche === fiche) { V.gpsMsg = `Affinage… ±${Math.round(c.accuracy)} m`; if (V.etape === 0) rendre(); }
      if (c.accuracy <= 15) fin();
    }, err => fin(err.code === 1 ? 'Autorisez l\'accès à la position dans le navigateur' : 'Position introuvable : réessayez à l\'extérieur'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    const limite = setTimeout(() => fin(), 30000);
  }

  /* ----- Fin de visite ----- */

  async function terminer() {
    const pb = problemes();
    const i = pb.findIndex(x => x.length);
    if (i >= 0) {
      V.montrer = true;
      aller(i);
      const total = pb.reduce((t, x) => t + x.length, 0);
      toast(`${total} point(s) à compléter : ${pb[i].slice(0, 3).join(', ')}${pb[i].length > 3 ? '…' : ''}`, 6000);
      return;
    }
    const f = V.fiche;
    f.valeurs.FIN = maintenant();
    f.statut = 'finalisee';
    f.finaliseLe = maintenant();
    clearTimeout(V.minuteur);
    await DB.mettre(f);
    Reglages.maj(r => { r.memo = r.memo || {}; r.memo[FORM] = { MERCH: f.valeurs.MERCH }; });
    toast('Visite terminée ✓');
    V = null;
    history.back();
    if (navigator.onLine && Reglages.lire().url) synchroniser({ silencieux: true });
  }

  window.addEventListener('popstate', () => {
    if (!V) return;
    clearTimeout(V.minuteur);
    const f = V.fiche;
    if (f.statut === 'finalisee' && problemes().some(x => x.length)) { f.statut = 'brouillon'; toast('Visite incomplète : replacée dans les brouillons'); }
    DB.mettre(f);
    V = null;
    document.querySelectorAll('.voile').forEach(x => x.remove());
  });

  /* ---------- Export (format long) et envoi ---------- */

  // Somme des facings des références présentes, par segment de facing total
  function totauxFacing(f, parId) {
    const t = {};
    for (const id in f.lignes) {
      const l = f.lignes[id], p = parId[id];
      if (!p || l.present !== true || f.absentes[p.CATEGORIE]) continue;
      const s = Recensement.segmentFacing(p);
      t[s] = (t[s] || 0) + (Number(l.facing) || 0);
    }
    return t;
  }

  function lignesExport(f, cat) {
    const parId = Object.fromEntries(cat.map(p => [p.ID, p]));
    const m = magasin(f.valeurs.MAGASIN) || { nom: '', chemin: [] };
    const [lat, lon, , acc] = String(f.valeurs.GPS || '').split(' ');
    const lignes = Object.entries(f.lignes).filter(([id]) => parId[id]);
    const repris = lignes.filter(([, l]) => l.repris && l.present === true);
    const inchanges = repris.filter(([, l]) => String(l.prix) === String(l.repris.prix));
    const visite = {
      _id: f.id, DATE: f.valeurs.DATE, SOUMIS_LE: f.finaliseLe || '', APPAREIL: f.appareil || '', MERCHANDISEUR: nomMerch(f.valeurs.MERCH),
      CANAL: m.chemin[0] || '', ENSEIGNE: m.chemin[1] || '', MAGASIN: m.nom, MAGASIN_CODE: f.valeurs.MAGASIN,
      LATITUDE: Number(lat) || '', LONGITUDE: Number(lon) || '', PRECISION_GPS: Number(acc) || '',
      NB_REFS_PRESENTES: lignes.filter(([, l]) => l.present === true).length, NB_HORS_CATALOGUE: f.inconnus.length,
      CATEGORIES_ABSENTES: CATEGORIES.filter(c => f.absentes[c]).join(', '),
      NB_FRIGOS: f.equip ? f.equip.frigos : '', NB_CAN_COOLERS: f.equip ? f.equip.canCoolers : '',
      MODE_FACING: modeFacing() === 'photo' ? 'PHOTO' : 'SAISIE',
      PREREMPLI_DEPUIS: f.prerempli ? f.prerempli.date : '', PREREMPLI_SOURCE: f.prerempli ? f.prerempli.source : '',
      PRIX_INCHANGES_PCT: repris.length ? Math.round(100 * inchanges.length / repris.length) : '',
      DEBUT: f.valeurs.DEBUT || '', FIN: f.valeurs.FIN || '',
    };
    // Facing total par segment (base de la part de linéaire) ; vide tant que les facings viennent des photos
    const totaux = totauxFacing(f, parId);
    for (const s of Recensement.SEGMENTS) visite['FACING_TOTAL ' + s.nom] = modeFacing() === 'saisie' ? (totaux[s.nom] || 0) : '';
    const releves = lignes.filter(([id]) => !f.absentes[parId[id].CATEGORIE]).map(([id, l]) => {
      const p = parId[id];
      return {
        _id_visite: f.id, DATE: f.valeurs.DATE, MAGASIN: m.nom, MAGASIN_CODE: f.valeurs.MAGASIN, CANAL: visite.CANAL, ENSEIGNE: visite.ENSEIGNE,
        MERCHANDISEUR: visite.MERCHANDISEUR, REF_ID: id, NOM_SYSTEME: p.NOM_SYSTEME, CATEGORIE: p.CATEGORIE, MARQUE: p.MARQUE, GAMME: p.GAMME,
        FORMAT: p.FORMAT, EMBALLAGE: p.EMBALLAGE, UNITES_PAR_LOT: p.UNITES_PAR_LOT, SEGMENT_FACING: Recensement.segmentFacing(p),
        PRESENT: l.present === true ? 'OUI' : 'NON', PRIX: l.present === true ? l.prix : '',
        // FACING = rayon principal, seul compté dans le facing total ; FACING_SECONDAIRE = autres emplacements
        FACING: l.present === true && modeFacing() === 'saisie' ? l.facing : '',
        FACING_SECONDAIRE: l.present === true && modeFacing() === 'saisie' ? (Number(l.facingSec) || 0) : '',
        FACING_SOURCE: l.present === true ? visite.MODE_FACING : '',
        PRIX_REPRIS: l.present !== true ? '' : l.repris ? (String(l.prix) === String(l.repris.prix) ? 'INCHANGE' : 'MODIFIE') : 'NOUVEAU',
      };
    });
    return { visite, releves };
  }

  // Photos d'équipements utiles : seulement pour les appareils déclarés (FRIGO 1 AVANT, FRIGO 1 APRES…)
  function equipCles(f) {
    const cles = [];
    for (const q of EQUIPEMENTS) for (let k = 1; k <= (Number(f.equip[q.cle]) || 0); k++) for (const mo of MOMENTS) cles.push(`${q.nom} ${k} ${mo}`);
    return cles;
  }

  // Numéro du module dans son emplacement : FRIGO 1, FRIGO 2, RAYON PRINCIPAL 1…
  function numeroModule(f, c, i) {
    const e = empDe(f, c, i);
    let n = 0;
    for (let k = 0; k <= i; k++) if (empDe(f, c, k) === e) n++;
    return n;
  }

  async function nbAEnvoyer() { return (await DB.tout()).filter(f => f.form === FORM && f.statut === 'finalisee').length; }

  async function envoyer(r) {
    const cat = await Recensement.catalogue();
    let ok = 0;
    for (const f of (await DB.tout()).filter(x => x.form === FORM && x.statut === 'finalisee')) {
      const m = magasin(f.valeurs.MAGASIN) || { nom: '' };
      f.equip = f.equip || { frigos: '', canCoolers: '', photos: {}, liens: {} };
      // 1. Photos une par une (évite une requête trop lourde ; reprise possible après coupure)
      for (const c of Object.keys(f.photos)) {
        f.liens[c] = f.liens[c] || [];
        for (let i = 0; i < f.photos[c].length; i++) {
          if (f.liens[c][i] || !f.photos[c][i]) continue;
          const j = await appelServeur(r.url, { action: 'photoVeille', jeton: r.jeton, id: f.id, date: f.valeurs.DATE, magasin: m.nom, categorie: c,
            emplacement: empDe(f, c, i), n: numeroModule(f, c, i), data: f.photos[c][i] });
          if (!j.ok) throw new Error(j.erreur || 'photo refusée');
          f.liens[c][i] = j.lien;
          await DB.mettre(f);
        }
      }
      for (const cle of equipCles(f)) {
        if (f.equip.liens[cle] || !f.equip.photos[cle]) continue;
        const [, nom, k, moment] = cle.match(/^(.*) (\d+) (AVANT|APRES)$/);
        const j = await appelServeur(r.url, { action: 'photoVeille', jeton: r.jeton, id: f.id, date: f.valeurs.DATE, magasin: m.nom, categorie: 'EQUIPEMENTS',
          emplacement: `${nom} ${k}`, n: moment, data: f.equip.photos[cle] });
        if (!j.ok) throw new Error(j.erreur || 'photo refusée');
        f.equip.liens[cle] = j.lien;
        await DB.mettre(f);
      }
      for (const x of f.inconnus) {
        if (x.lien || !x.photo) continue;
        const j = await appelServeur(r.url, { action: 'photoVeille', jeton: r.jeton, id: f.id, date: f.valeurs.DATE, magasin: m.nom, categorie: x.categorie, n: 'hors-catalogue', data: x.photo });
        if (!j.ok) throw new Error(j.erreur || 'photo refusée');
        x.lien = j.lien;
        await DB.mettre(f);
      }
      // 2. La visite et ses relevés
      const { visite, releves } = lignesExport(f, cat);
      const photos = [];
      for (const c in f.liens) f.liens[c].forEach((lien, i) => {
        if (!lien) return;
        const e = empDe(f, c, i);
        const mt = metaDe(f, c, i);
        photos.push({ _id_visite: f.id, DATE: f.valeurs.DATE, MAGASIN: m.nom, CATEGORIE: c, EMPLACEMENT: e, MODULE: numeroModule(f, c, i), MOMENT: '',
          COMPTE_FACING_TOTAL: e === EMPLACEMENT_PRINCIPAL ? 'OUI' : 'NON',
          // Bande déjà comptée sur la photo précédente : ne pas y recompter les produits (centre dans la bande)
          PRISE: mt.prise === 'guidee' ? 'GUIDEE' : 'LIBRE', RECOUVREMENT_COTE: { droite: 'GAUCHE', bas: 'HAUT' }[mt.direction] || '',
          RECOUVREMENT_PCT: mt.recouvrement ? Math.round(mt.recouvrement * 100) : 0,
          LIEN: lien, FACINGS_CALCULES: '' });
      });
      for (const cle of equipCles(f)) {
        const lien = f.equip.liens[cle];
        if (!lien) continue;
        const [, nom, k, moment] = cle.match(/^(.*) (\d+) (AVANT|APRES)$/);
        photos.push({ _id_visite: f.id, DATE: f.valeurs.DATE, MAGASIN: m.nom, CATEGORIE: 'EQUIPEMENTS', EMPLACEMENT: nom, MODULE: Number(k), MOMENT: moment,
          COMPTE_FACING_TOTAL: 'NON', LIEN: lien, FACINGS_CALCULES: '' });
      }
      const inconnus = f.inconnus.map(x => ({ _id: x.id, DATE: f.valeurs.DATE, APPAREIL: f.appareil, CATEGORIE: x.categorie, NOM_PROPOSE: x.description,
        PHOTO: x.lien || '', ORIGINE: 'VEILLE ' + m.nom, PRIX_RELEVE: x.prix }));
      const j = await appelServeur(r.url, { action: 'visite', jeton: r.jeton, visite, releves, photos, inconnus });
      if (!j.ok) throw new Error(j.erreur || 'visite refusée');
      f.statut = 'envoyee'; f.envoyeLe = maintenant();
      f.photos = {}; f.equip.photos = {}; f.inconnus.forEach(x => { x.photo = null; });   // photos libérées : elles sont sur le Drive
      await DB.mettre(f);
      ok++;
    }
    return ok;
  }

  return { FORM, TITRE, carte, resume, ouvrir, nouvelle, nbAEnvoyer, envoyer, telechargerHistorique, lignesExport, depuisKobo, derniereVisite,
    _etat: () => V, _problemes: () => problemes() };
})();
window.Veille = Veille;
