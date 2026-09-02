const CACHE = 'kioku-v20';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// アプリ本体は network-first（更新をすぐ拾う）、それ以外は cache-first。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isShell =
    url.origin === location.origin && /\/(index\.html|app\.js)?$/.test(url.pathname);

  if (isShell) {
    e.respondWith(
      // GitHub Pages は Cache-Control ヘッダを設定できず、既定で10分ほど HTTP キャッシュが効く。
      // cache: 'reload' でそれを迂回し、更新をこれまでどおりすぐ拾えるようにする。
      fetch(e.request.url, { cache: 'reload', credentials: 'same-origin' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
            return res;
          })
          .catch(() => caches.match('./index.html'))
    )
  );
});
