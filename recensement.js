/* Recensement des références produits : photo de face + fiche produit, pour constituer
   la base qui servira à reconnaître les produits sur les photos de rayon.
   S'appuie sur les utilitaires de app.js (h, DB, toast, Reglages, appelServeur…). */
'use strict';

const Recensement = (() => {
  const CATEGORIES = ['EAU PLATE', 'EAU GAZEUSE', 'JUS 100%', 'JUS NECTAR', 'JUS BOISSON AUX FRUITS', 'LAIT BLANC', 'LAIT AROMATISE', 'BOISSON GAZEUSE', 'BOISSON ENERGISANTE'];
  const EMBALLAGES = ['PET', 'VERRE', 'CANETTE', 'BRIQUE', 'BRIQUETTE', 'BERLINGOT', 'SACHET', 'BONBONNE'];
  const LOTS = [1, 4, 6, 12, 24];
  const FORM = 'recensement';
  const majuscules = s => sansAccents(s).toUpperCase().replace(/\s+/g, ' ').trim();

  // Jus : la catégorie se déduit de la teneur en fruits lue sur la liste des ingrédients.
  const JUS = ['JUS 100%', 'JUS NECTAR', 'JUS BOISSON AUX FRUITS'];
  const CHOIX_CATEGORIES = ['EAU PLATE', 'EAU GAZEUSE', 'JUS', 'LAIT BLANC', 'LAIT AROMATISE', 'BOISSON GAZEUSE', 'BOISSON ENERGISANTE'];
  const A_CLASSER = 'JUS A CLASSER';
  const estJus = c => c === 'JUS' || c === A_CLASSER || JUS.includes(c);
  function categorieJus(teneur) {
    const t = Number(String(teneur ?? '').replace(',', '.'));
    if (teneur === '' || teneur == null || isNaN(t)) return '';
    return t >= 80 ? 'JUS 100%' : t >= 25 ? 'JUS NECTAR' : 'JUS BOISSON AUX FRUITS';
  }

  // Même règle que la colonne NOM_SYSTEME du catalogue
  function nomSysteme(p) {
    const base = [p.MARQUE, p.GAMME, p.VARIANTE, p.FORMAT, p.EMBALLAGE].map(x => majuscules(x || '')).filter(Boolean).join(' ');
    return base + (Number(p.UNITES_PAR_LOT) > 1 ? ` PACK X${Number(p.UNITES_PAR_LOT)}` : '');
  }

  /* Segments de facing total (part de linéaire) : par format pour l'eau plate, le lait blanc et les boissons
     gazeuses, par catégorie pour le reste. Un format entre deux tranches rejoint la tranche supérieure
     (ex. 750 ML → 800ML-2L, comme « 1,5L + 1L + 75CL » dans l'ancien formulaire Kobo). */
  const SEGMENTS = [
    { cat: 'EAU PLATE', nom: 'EAU PLATE 250ML-700ML', max: 700 },
    { cat: 'EAU PLATE', nom: 'EAU PLATE 800ML-2L', max: 2000 },
    { cat: 'EAU PLATE', nom: 'EAU PLATE 3L-12L', max: 12000 },
    { cat: 'EAU PLATE', nom: 'EAU PLATE 15L-20L', max: Infinity },
    { cat: 'EAU GAZEUSE', nom: 'EAU GAZEUSE' },
    { cat: 'JUS 100%', nom: 'JUS 100%' },
    { cat: 'JUS NECTAR', nom: 'JUS NECTAR' },
    { cat: 'JUS BOISSON AUX FRUITS', nom: 'JUS BOISSON AUX FRUITS' },
    { cat: 'LAIT BLANC', nom: 'LAIT BLANC 100ML-300ML', max: 300 },
    { cat: 'LAIT BLANC', nom: 'LAIT BLANC 400ML-700ML', max: 700 },
    { cat: 'LAIT BLANC', nom: 'LAIT BLANC 800ML-1L', max: Infinity },
    { cat: 'LAIT AROMATISE', nom: 'LAIT AROMATISE' },
    { cat: 'BOISSON GAZEUSE', nom: 'BOISSON GAZEUSE CANETTE', canette: true },
    { cat: 'BOISSON GAZEUSE', nom: 'BOISSON GAZEUSE PET 200ML-600ML', max: 600 },
    { cat: 'BOISSON GAZEUSE', nom: 'BOISSON GAZEUSE PET 700ML-1,5L', max: 1500 },
    { cat: 'BOISSON GAZEUSE', nom: 'BOISSON GAZEUSE PET PLUS DE 1,5L', max: Infinity },
    { cat: 'BOISSON ENERGISANTE', nom: 'BOISSON ENERGISANTE' },
  ];
  // « 330ML » → 330 ; « 1,5L » → 1500
  function enMl(format) {
    const m = String(format || '').match(/^(\d+(?:[.,]\d+)?)\s*(ML|CL|L)$/i);
    if (!m) return null;
    const q = Number(m[1].replace(',', '.'));
    return /^L$/i.test(m[2]) ? q * 1000 : /^CL$/i.test(m[2]) ? q * 10 : q;
  }
  function segmentFacing(p) {
    const segs = SEGMENTS.filter(s => s.cat === p.CATEGORIE);
    if (!segs.length) return '';
    if (segs.length === 1) return segs[0].nom;
    if (p.CATEGORIE === 'BOISSON GAZEUSE' && p.EMBALLAGE === 'CANETTE') return segs.find(s => s.canette).nom;
    const ml = enMl(p.FORMAT);
    if (ml == null) return `${p.CATEGORIE} (FORMAT INCONNU)`;
    return segs.find(s => !s.canette && ml <= s.max).nom;
  }

  // 33 + CL → « 330ML » ; 1.5 + L → « 1,5L »
  function formatNormalise(qte, unite) {
    const q = Number(String(qte).replace(',', '.'));
    if (!q) return '';
    const ml = unite === 'CL' ? q * 10 : unite === 'L' ? q * 1000 : q;
    return ml < 1000 ? `${Math.round(ml)}ML` : `${String(ml / 1000).replace('.', ',')}L`;
  }

  /* ---------- Catalogue ---------- */

  async function catalogue() { return (await DB.diversLire('catalogue')) || []; }

  async function importerCatalogue(produits) {
    const liste = (produits || []).filter(p => p.ID).map(p => ({
      ID: String(p.ID), CATEGORIE: p.CATEGORIE || '', MARQUE: p.MARQUE || '', GAMME: p.GAMME || '', VARIANTE: p.VARIANTE || '',
      FORMAT: p.FORMAT || '', EMBALLAGE: p.EMBALLAGE || '', UNITES_PAR_LOT: Number(p.UNITES_PAR_LOT) || 1,
      NOM_SYSTEME: p.NOM_SYSTEME || nomSysteme(p), CODE_BARRES: String(p.CODE_BARRES || ''), STATUT: p.STATUT || '',
      // Lien avec l'ancien formulaire Kobo : sert à préremplir la veille avec l'historique Kobo
      KOBO_PRESENCE: p.KOBO_PRESENCE || '', KOBO_PRIX: p.KOBO_PRIX || '',
      // Un jus n'est complet qu'avec la photo de ses ingrédients (classement par teneur en fruits).
      PHOTO: !!p.PHOTO && (!JUS.includes(p.CATEGORIE) || !!p.PHOTO_INGREDIENTS),
    }));
    liste.forEach(p => { p.cle = sansAccents([p.ID, p.NOM_SYSTEME, p.CATEGORIE, p.CODE_BARRES].join(' ')); });
    await DB.diversMettre('catalogue', liste);
    Reglages.maj(x => { x.catalogueMaj = maintenant(); });
    return liste.length;
  }

  /* ---------- Miniatures des produits (affichées pendant la veille, y compris hors ligne) ----------
     Stockées sur l'appareil : { ID: { mid, data } } ; mid = identifiant du fichier Drive, ou « local:… »
     pour une miniature créée sur cet appareil au recensement (remplacée ensuite par celle du serveur). */
  const MINI_PX = 320;
  async function miniatures() { return (await DB.diversLire('miniatures')) || {}; }

  function reduire(data, max = MINI_PX, qualite = 0.7) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        const r = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', qualite));
      };
      img.onerror = () => res('');
      img.src = data;
    });
  }

  async function enregistrerMiniature(id, data, mid) {
    const m = await miniatures();
    m[id] = { mid, data };
    await DB.diversMettre('miniatures', m);
  }

  // Ne télécharge que les miniatures absentes ou modifiées, par lots (le serveur lit des fichiers Drive).
  async function telechargerMiniatures() {
    const r = Reglages.lire();
    if (!r.url || !navigator.onLine) return;
    try {
      for (let tour = 0; tour < 20; tour++) {
        const m = await miniatures();
        const connus = Object.fromEntries(Object.entries(m).map(([id, x]) => [id, x.mid]));
        const j = await appelServeur(r.url, { action: 'miniatures', jeton: r.jeton, connus });
        if (!j.ok || !j.miniatures || !j.miniatures.length) return;
        for (const x of j.miniatures) m[x.ID] = { mid: x.mid, data: x.data };
        await DB.diversMettre('miniatures', m);
        if (!j.reste) return;
      }
    } catch (e) { /* nouvel essai à la prochaine synchronisation */ }
  }

  async function telechargerCatalogue({ silencieux = true } = {}) {
    const r = Reglages.lire();
    if (!r.url || !navigator.onLine) return;
    try {
      const j = await appelServeur(r.url, { action: 'catalogue', jeton: r.jeton });
      if (!j.ok) throw new Error(j.erreur || 'refus du serveur');
      // Onglet Catalogue absent ou vide côté serveur : on garde le catalogue de l'appareil.
      if (!j.produits || !j.produits.length) { if (!silencieux) toast('Catalogue vide sur le serveur : catalogue de l\'appareil conservé'); return; }
      const n = await importerCatalogue(j.produits);
      await telechargerMiniatures();
      if (!silencieux) toast(`Catalogue mis à jour : ${n} référence(s)`);
    } catch (e) { if (!silencieux) toast('Catalogue non téléchargé : ' + e.message, 6000); }
  }

  /* ---------- Fiches de recensement ---------- */

  async function fiches() { return (await DB.tout()).filter(f => f.form === FORM); }
  async function nbAEnvoyer() { return (await fiches()).filter(f => f.statut === 'finalisee').length; }

  async function envoyer(r) {
    let ok = 0;
    for (const f of (await fiches()).filter(x => x.statut === 'finalisee')) {
      const j = await appelServeur(r.url, { action: 'recenser', jeton: r.jeton, id: f.id, ligne: f.valeurs, photo: f.photo,
        photoIngredients: f.photoIngredients, miniature: f.miniature || (f.photo ? await reduire(f.photo) : '') });
      if (!j.ok) throw new Error(j.erreur || 'refus du serveur');
      f.statut = 'envoyee'; f.envoyeLe = maintenant(); f.photo = null; f.photoIngredients = null; f.miniature = null;   // les photos sont désormais sur le Drive
      await DB.mettre(f);
      ok++;
    }
    return ok;
  }

  /* ---------- Carte d'accueil ---------- */

  async function carte() {
    const cat = await catalogue();
    const locales = await fiches();
    const photographiees = new Set(locales.map(f => f.valeurs.REF_EXISTANTE).filter(Boolean));
    const avecPhoto = cat.filter(p => p.PHOTO || photographiees.has(p.ID)).length;
    const attente = locales.filter(f => f.statut === 'finalisee').length;
    return h('section', { class: 'carte-form' },
      h('div', {},
        h('h2', {}, 'Recensement produits'),
        h('p', { class: 'discret' }, cat.length
          ? `Catalogue : ${cat.length} réf. · ${avecPhoto} avec photo` + (attente ? ` · ${attente} à envoyer` : '')
          : 'Catalogue non chargé : Paramètres > Importer un fichier, ou serveur')),
      h('button', { class: 'btn primaire', onclick: () => ouvrir() }, '📷 Recenser'));
  }

  /* ---------- Écran de recensement ---------- */

  let etat = null;   // { cat, choisie, valeurs, photo, codeLu }

  async function ouvrir(retourHistorique = true) {
    const cat = await catalogue();
    const locales = await fiches();
    const faites = new Set(locales.map(f => f.valeurs.REF_EXISTANTE).filter(Boolean));
    etat = { cat, faites, nb: locales.filter(f => f.creeLe && f.creeLe.slice(0, 10) === aujourdhui()).length };
    if (retourHistorique) history.pushState({ vue: 'recensement' }, '');
    ecranRecherche();
  }

  function entete(titre, sousTitre) {
    return h('header', { class: 'barre collante' },
      h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: () => history.back() }, '←'),
      h('div', { class: 'barre-titre' }, h('strong', {}, titre), sousTitre ? h('span', { class: 'pastille' }, sousTitre) : null));
  }

  function ecranRecherche() {
    vider();
    const recherche = h('input', { type: 'search', class: 'recherche', placeholder: 'Rechercher : marque, parfum, format, code-barres…', autocomplete: 'off' });
    const filtreCat = h('select', { class: 'recherche' }, h('option', { value: '' }, 'Toutes catégories'), CATEGORIES.map(c => h('option', { value: c }, c)));
    const sansPhoto = h('input', { type: 'checkbox' });
    const liste = h('div', { class: 'casc-liste longue' });
    const remplir = () => {
      const mots = sansAccents(recherche.value).split(/\s+/).filter(Boolean);
      const res = etat.cat.filter(p => p.STATUT !== 'EXCLU'
        && (!filtreCat.value || p.CATEGORIE === filtreCat.value)
        && (!sansPhoto.checked || !(p.PHOTO || etat.faites.has(p.ID)))
        && mots.every(m => p.cle.includes(m)));
      liste.replaceChildren(...res.slice(0, 100).map(p => {
        const fait = p.PHOTO || etat.faites.has(p.ID);
        return h('button', { type: 'button', class: 'casc-option', onclick: () => ecranFiche(p) },
          h('strong', {}, p.NOM_SYSTEME),
          h('small', {}, `${p.ID} · ${p.CATEGORIE}`, ' · ', h('span', { class: fait ? 'fait-texte' : 'a-faire-texte' }, fait ? '✓ photo' : 'photo manquante')));
      }));
      if (res.length > 100) liste.append(h('p', { class: 'discret' }, `${res.length - 100} autres… affinez la recherche.`));
      if (!res.length) liste.append(h('p', { class: 'discret' }, 'Aucune référence trouvée.'));
    };
    recherche.addEventListener('input', remplir);
    filtreCat.addEventListener('change', remplir);
    sansPhoto.addEventListener('change', remplir);
    racineApp.append(
      entete('Recensement produits', etat.nb ? `${etat.nb} aujourd'hui` : null),
      h('main', {},
        h('div', { class: 'bandeau-repris' }, 'Le produit est-il déjà au catalogue ? Cherchez-le et ajoutez sa photo. Sinon, créez une nouvelle référence.'),
        h('button', { class: 'btn primaire large', onclick: () => ecranFiche(null) }, '+ Nouvelle référence (absente du catalogue)'),
        h('div', { class: 'champ' }, recherche, filtreCat,
          h('label', { class: 'case' }, sansPhoto, ' Seulement les références sans photo'), liste)));
    remplir();
  }

  // p = référence existante du catalogue, ou null pour une nouvelle référence
  function ecranFiche(p) {
    etat.choisie = p;
    etat.photo = null;
    etat.photoIngredients = null;
    etat.valeurs = p
      ? { CATEGORIE: p.CATEGORIE, MARQUE: p.MARQUE, GAMME: p.GAMME, VARIANTE: p.VARIANTE, FORMAT: p.FORMAT, EMBALLAGE: p.EMBALLAGE, UNITES_PAR_LOT: p.UNITES_PAR_LOT, CODE_BARRES: p.CODE_BARRES }
      : { CATEGORIE: estJus(etat.derniereCategorie) ? 'JUS' : etat.derniereCategorie || '', MARQUE: '', GAMME: '', VARIANTE: '', FORMAT: '', EMBALLAGE: '', UNITES_PAR_LOT: 1, CODE_BARRES: '' };
    Object.assign(etat.valeurs, { TENEUR_FRUITS: '', TENEUR_NON_INDIQUEE: false });
    vider();
    history.pushState({ vue: 'recensement-fiche' }, '');

    const v = etat.valeurs;
    const apercuNom = h('div', { class: 'nom-systeme' });
    const alerte = h('div', { class: 'avert', hidden: true });
    const majNom = () => {
      apercuNom.textContent = nomSysteme(v) || '—';
      if (p) return;
      const nom = nomSysteme(v);
      const doublon = etat.cat.find(x => (nom && x.NOM_SYSTEME === nom) || (v.CODE_BARRES && x.CODE_BARRES === v.CODE_BARRES));
      alerte.hidden = !doublon;
      if (doublon) alerte.replaceChildren(`Existe déjà au catalogue : ${doublon.ID} ${doublon.NOM_SYSTEME}. `,
        h('button', { class: 'lien', onclick: () => { history.back(); setTimeout(() => ecranFiche(doublon), 50); } }, 'Utiliser cette référence'));
    };

    // Photo de face
    const apercu = h('div', { class: 'photo-apercu' });
    const entreePhoto = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque' });
    entreePhoto.addEventListener('change', async () => {
      const f = entreePhoto.files[0];
      if (!f) return;
      try {
        etat.photo = await compresserImage(f, 1600, 0.85);
        apercu.replaceChildren(h('img', { src: etat.photo, alt: 'Photo du produit' }));
        if (!v.CODE_BARRES) lireCodeBarres(f).then(code => { if (code) { v.CODE_BARRES = code; champCode.value = code; majNom(); toast('Code-barres lu : ' + code); } });
      } catch (e) { toast('Photo illisible, réessayez'); }
      entreePhoto.value = '';
    });

    // Code-barres
    const champCode = h('input', { type: 'text', inputmode: 'numeric', value: v.CODE_BARRES || '', placeholder: 'Facultatif', autocomplete: 'off' });
    champCode.addEventListener('input', () => { v.CODE_BARRES = champCode.value.replace(/\D/g, ''); majNom(); });
    const entreeCode = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque' });
    entreeCode.addEventListener('change', async () => {
      const code = entreeCode.files[0] && await lireCodeBarres(entreeCode.files[0]);
      if (code) { v.CODE_BARRES = code; champCode.value = code; majNom(); toast('Code-barres lu : ' + code); }
      else toast('Code-barres non lu : saisissez-le à la main');
      entreeCode.value = '';
    });

    // Jus : photo des ingrédients + teneur en fruits → catégorie (≥ 80 % : 100 % ; 25 à 80 % : nectar ; < 25 % : boisson aux fruits)
    const apercuIngr = h('div', { class: 'photo-apercu' });
    const entreeIngr = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'masque' });
    entreeIngr.addEventListener('change', async () => {
      const f = entreeIngr.files[0];
      if (!f) return;
      try {
        etat.photoIngredients = await compresserImage(f, 2000, 0.85);   // plus grande : le texte doit rester lisible
        apercuIngr.replaceChildren(h('img', { src: etat.photoIngredients, alt: 'Photo des ingrédients' }));
      } catch (e) { toast('Photo illisible, réessayez'); }
      entreeIngr.value = '';
    });
    const champTeneur = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'ex. 50', class: 'court' });
    const nonIndiquee = h('input', { type: 'checkbox' });
    const resultatJus = h('div', { class: 'nom-systeme' });
    const blocJus = h('div', { class: 'champ' },
      h('span', { class: 'champ-lib' }, 'Photo des ingrédients', h('span', { class: 'req' }, ' *')),
      h('small', { class: 'aide' }, 'Côté de l\'emballage où figure la teneur en fruits (ex. « jus de fruits : 50 % minimum »).'),
      apercuIngr, h('label', { class: 'btn' }, '📷 Photo des ingrédients', entreeIngr),
      h('span', { class: 'champ-lib' }, 'Teneur en fruits (%)', h('span', { class: 'req' }, ' *')),
      h('div', { class: 'ligne' }, champTeneur, h('span', {}, '%')),
      h('label', { class: 'case' }, nonIndiquee, ' Teneur non indiquée sur l\'emballage'),
      resultatJus);
    const majJus = () => {
      const jus = estJus(p ? p.CATEGORIE : v.CATEGORIE);
      blocJus.hidden = !jus;
      if (!jus) return;
      champTeneur.disabled = v.TENEUR_NON_INDIQUEE;
      const cat = categorieJus(v.TENEUR_FRUITS);
      resultatJus.textContent = cat
        ? `→ ${cat}` + (p && cat !== p.CATEGORIE ? ` (au catalogue : ${p.CATEGORIE})` : '')
        : v.TENEUR_NON_INDIQUEE ? '→ À classer par le validateur' : 'Saisissez la teneur pour classer le jus';
    };
    champTeneur.addEventListener('input', () => {
      const t = champTeneur.value.replace(',', '.').replace(/[^\d.]/g, '');
      v.TENEUR_FRUITS = t === '' || isNaN(t) || Number(t) > 100 ? '' : Number(t);
      majJus();
    });
    nonIndiquee.addEventListener('change', () => { v.TENEUR_NON_INDIQUEE = nonIndiquee.checked; if (nonIndiquee.checked) { champTeneur.value = ''; v.TENEUR_FRUITS = ''; } majJus(); });

    const corps = [];
    corps.push(h('div', { class: 'champ' },
      h('span', { class: 'champ-lib' }, 'Photo de face', h('span', { class: 'req' }, ' *')),
      h('small', { class: 'aide' }, 'Produit entier, de face, étiquette lisible, fond neutre, sans reflet.'),
      apercu, h('label', { class: 'btn' }, '📷 Prendre la photo', entreePhoto)));

    if (p) {
      corps.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Référence'),
        h('div', { class: 'nom-systeme' }, p.NOM_SYSTEME), h('small', { class: 'discret' }, `${p.ID} · ${p.CATEGORIE}`)), blocJus);
    } else {
      const puces = (cle, options, lib, apres) => {
        const box = h('div', { class: 'puces' }, options.map(o => h('button', { type: 'button', 'data-v': o, class: String(v[cle]) === String(o) ? 'actif' : '' }, lib ? lib(o) : o)));
        box.addEventListener('click', ev => {
          const b = ev.target.closest('button'); if (!b) return;
          v[cle] = cle === 'UNITES_PAR_LOT' ? Number(b.dataset.v) : b.dataset.v;
          box.querySelectorAll('button').forEach(x => x.classList.toggle('actif', x === b));
          majNom();
          if (apres) apres();
        });
        return box;
      };
      const texte = (cle, liste, placeholder) => {
        const id = 'dl-' + cle;
        const el = h('input', { type: 'text', class: 'maj', value: v[cle] || '', list: liste ? id : null, placeholder: placeholder || '', autocomplete: 'off', autocapitalize: 'characters' });
        el.addEventListener('input', () => { v[cle] = majuscules(el.value); majNom(); });
        return [el, liste ? h('datalist', { id }, liste.map(x => h('option', { value: x }))) : null];
      };
      const marques = [...new Set(etat.cat.map(x => x.MARQUE).filter(Boolean))].sort();
      const gammes = [...new Set(etat.cat.map(x => x.GAMME).filter(Boolean))].sort();
      const qte = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'ex. 33', class: 'court' });
      let unite = 'CL';
      const unites = h('div', { class: 'puces' }, ['ML', 'CL', 'L'].map(u => h('button', { type: 'button', class: u === unite ? 'actif' : '' }, u)));
      const majFormat = () => { v.FORMAT = formatNormalise(qte.value, unite); majNom(); };
      qte.addEventListener('input', majFormat);
      unites.addEventListener('click', ev => {
        const b = ev.target.closest('button'); if (!b) return;
        unite = b.textContent; unites.querySelectorAll('button').forEach(x => x.classList.toggle('actif', x === b)); majFormat();
      });
      const lotAutre = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'autre', class: 'court' });
      lotAutre.addEventListener('input', () => { v.UNITES_PAR_LOT = Number(lotAutre.value) || 1; majNom(); });

      corps.push(
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Catégorie', h('span', { class: 'req' }, ' *')),
          h('small', { class: 'aide' }, 'Pour un jus, choisir JUS : la catégorie exacte dépend de la teneur en fruits.'),
          puces('CATEGORIE', CHOIX_CATEGORIES, null, majJus)),
        blocJus,
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Marque', h('span', { class: 'req' }, ' *')), texte('MARQUE', marques, 'ex. PRESSEA')),
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Gamme'), h('small', { class: 'aide' }, 'Sous-marque éventuelle (FRESH, SELECTION 100%, LE JUS…)'), texte('GAMME', gammes)),
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Variante / parfum'), texte('VARIANTE', null, 'ex. MANGUE, DEMI ECREME')),
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Format', h('span', { class: 'req' }, ' *')), h('div', { class: 'ligne' }, qte, unites)),
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Emballage', h('span', { class: 'req' }, ' *')), puces('EMBALLAGE', EMBALLAGES)),
        h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Unités par lot'), h('small', { class: 'aide' }, '1 = unité seule. Un pack est une référence distincte.'),
          h('div', { class: 'ligne' }, puces('UNITES_PAR_LOT', LOTS, x => (x === 1 ? 'Unité' : `Pack ×${x}`)), lotAutre)));
    }

    corps.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Code-barres'),
      h('div', { class: 'ligne' }, champCode, 'BarcodeDetector' in window ? h('label', { class: 'btn' }, 'Scanner', entreeCode) : null)));
    if (!p) corps.push(h('div', { class: 'champ' }, h('span', { class: 'champ-lib' }, 'Nom système'), apercuNom, alerte));

    const enregistrer = h('button', { class: 'btn primaire', onclick: () => enregistrerFiche() }, 'Enregistrer ✓');
    racineApp.append(entete(p ? 'Photo de référence' : 'Nouvelle référence'), h('main', { class: 'editeur' }, corps),
      h('footer', { class: 'pied' }, h('button', { class: 'btn', onclick: () => history.back() }, 'Annuler'), enregistrer));
    majNom();
    majJus();
  }

  async function enregistrerFiche() {
    const v = etat.valeurs, p = etat.choisie;
    if (!etat.photo) return toast('La photo de face est obligatoire');
    if (!p) {
      const manque = ['CATEGORIE', 'MARQUE', 'FORMAT', 'EMBALLAGE'].filter(k => !v[k]);
      if (manque.length) return toast('À compléter : ' + manque.join(', ').toLowerCase());
    }
    const jus = estJus(p ? p.CATEGORIE : v.CATEGORIE);
    let categorie = p ? p.CATEGORIE : v.CATEGORIE;
    if (jus) {
      if (!etat.photoIngredients) return toast('Jus : la photo des ingrédients est obligatoire');
      if (v.TENEUR_FRUITS === '' && !v.TENEUR_NON_INDIQUEE) return toast('Jus : saisissez la teneur en fruits, ou cochez « non indiquée »');
      categorie = categorieJus(v.TENEUR_FRUITS) || (p ? p.CATEGORIE : A_CLASSER);
    }
    const valeurs = Object.assign({}, v, {
      CATEGORIE: categorie,
      CATEGORIE_CATALOGUE: p ? p.CATEGORIE : '',
      TENEUR_FRUITS: jus ? v.TENEUR_FRUITS : '',
      REF_EXISTANTE: p ? p.ID : '',
      NOM_PROPOSE: p ? p.NOM_SYSTEME : nomSysteme(v),
      DATE: aujourdhui(),
      APPAREIL: idAppareil(),
    });
    delete valeurs.TENEUR_NON_INDIQUEE;
    const miniature = await reduire(etat.photo);
    const fiche = { id: uuid(), form: FORM, statut: 'finalisee', valeurs, photo: etat.photo, photoIngredients: jus ? etat.photoIngredients : null,
      miniature, creeLe: maintenant(), modifieLe: maintenant(), finaliseLe: maintenant() };
    await DB.mettre(fiche);
    // Référence existante : sa photo est utilisable tout de suite sur cet appareil, sans attendre le serveur
    if (p && miniature) await enregistrerMiniature(p.ID, miniature, 'local:' + fiche.id);
    if (p) etat.faites.add(p.ID);
    else { etat.derniereCategorie = v.CATEGORIE; etat.cat.push(Object.assign({}, valeurs, { ID: '(en attente)', NOM_SYSTEME: valeurs.NOM_PROPOSE, cle: sansAccents(valeurs.NOM_PROPOSE), PHOTO: true })); }
    etat.nb++;
    toast(`Enregistré : ${valeurs.NOM_PROPOSE}`);
    history.back();   // retour à la recherche, prêt pour le produit suivant
    if (navigator.onLine && Reglages.lire().url) synchroniser({ silencieux: true });
  }

  async function lireCodeBarres(fichier) {
    if (!('BarcodeDetector' in window)) return '';
    try {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      const codes = await det.detect(await createImageBitmap(fichier));
      return codes.length ? codes[0].rawValue : '';
    } catch (e) { return ''; }
  }

  // Retour arrière : depuis une fiche → recherche ; depuis la recherche → accueil (géré par app.js)
  window.addEventListener('popstate', ev => {
    if (ev.state && ev.state.vue === 'recensement' && etat) setTimeout(() => ecranRecherche(), 0);
  });

  return { carte, nbAEnvoyer, envoyer, telechargerCatalogue, importerCatalogue, catalogue, nomSysteme, formatNormalise,
    segmentFacing, SEGMENTS: SEGMENTS.map(s => ({ cat: s.cat, nom: s.nom })), miniatures, telechargerMiniatures, enregistrerMiniature };
})();
window.Recensement = Recensement;
