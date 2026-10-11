// Mise en cache de l'application pour l'utiliser sans réseau.
// Changer CACHE à chaque mise à jour des fichiers pour forcer le rafraîchissement sur les téléphones.
const CACHE = 'collecte-terrain-v31';
const FICHIERS = ['./', 'index.html', 'style.css', 'app.js', 'recensement.js', 'veille.js', 'forms/gms.js', 'manifest.webmanifest', 'icone-192.png', 'icone-512.png', 'logo-siagro.png', 'lib/qrcode.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Réseau d'abord, pour avoir toujours la dernière version ; le cache prend le relais
// sans réseau ou si la réponse tarde plus de 3 secondes (réseau faible en magasin).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const reseau = fetch(req).then(rep => { if (rep.ok) cache.put(req, rep.clone()); return rep; }).catch(() => null);
    const delai = new Promise(r => setTimeout(r, 3000, null));
    const rep = await Promise.race([reseau, delai]);
    if (rep) return rep;
    return (await cache.match(req, { ignoreSearch: true })) || (await reseau) || new Response('Hors ligne', { status: 503 });
  }));
});
