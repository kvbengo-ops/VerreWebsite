// Bump on every change to a SHELL file. The shell is cache-first, so a stale
// version keeps serving the old markup and stylesheet forever — a redesign that
// "did not apply" is almost always this line not having moved.
const VERSION = 'verre-pos-v5';
const SHELL = ['/pos/', '/pos/index.html', '/pos/style.css', '/pos/app.js', '/pos/manifest.json', '/pos/icon.svg', '/assets/verre-photo-atlas.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/pos/products') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok && response.headers.get('content-type')?.includes('json')) {
        caches.open(VERSION).then((cache) => cache.put(event.request, response.clone()));
      }
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  if (url.pathname.startsWith('/pos/') || url.pathname === '/pos') {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
