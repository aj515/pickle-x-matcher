// Pickle X Matcher service worker.
// Network-first for the app's own files (new deploys show up immediately),
// falling back to the cache when offline. Supabase API calls are never cached.
importScripts('version.js'); // defines self.PXM_VERSION (generated at build time)
const CACHE = 'pxm-' + (self.PXM_VERSION || 'dev');
const SHELL = ['./', 'index.html', 'app.html', 'landing.css', 'landing.js', 'styles.css', 'eta.js', 'cloud.js', 'app.js', 'config.js', 'vendor/supabase.js', 'vendor/qrcode.js',
  'board.html', 'board.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
