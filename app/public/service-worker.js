const CACHE_NAME = 'du-radar-shell-v8';
const SHELL = [
  './', './index.html', './app.css', './map-style.css', './app.js', './manifest.webmanifest',
  './campus-map.png', './vendor/leaflet.js', './vendor/leaflet.css', './vendor/qrcode.min.js',
  './icons/du-radar.svg', './icons/du-radar-192.png', './icons/du-radar-512.png',
  './data/campus-map.json', './data/facilities.json', './data/spots.json',
  './data/events.json', './data/offices.json', './data/seed.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (/(^|\/)api\/(pins|posts|reports|spot-suggestions|reactions|reservations|weather)(\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline', reason: '인터넷이 연결되어야 글과 예약을 사용할 수 있어요.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  const isScreenFile = request.mode === 'navigate' || /\.(html|css|js|webmanifest)$/.test(url.pathname);
  event.respondWith((isScreenFile ? fetch(request).then(response => { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)); return response; }).catch(() => caches.match(request).then(cached => cached || caches.match(new URL('./index.html', self.registration.scope).href))) : caches.match(request).then(cached => cached || fetch(request))));
});
