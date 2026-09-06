const CACHE = 'kioku-v31';
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

// キャッシュしてよい外部オリジン。**内容が変わらないものだけ**を並べること。
// ここに Supabase の API を入れてはいけません。
const CDN = [
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// アプリ本体は network-first（更新をすぐ拾う）、それ以外は cache-first。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // 同一オリジンと上の CDN 以外（＝ Supabase の API）は、何もせずネットワークに任せます。
  // **この判定を外さないでください。** クラウドからの取り込みは GET なので、
  // ここで拾うとキャッシュに載った古い応答が返り続けます。問い合わせURLは毎回同じなので、
  // 一度載ると永久に古いままです。実際にこれで「PCで作ったデッキがスマホに出てこない」
  // 状態になりました（書き込みは POST なので通り、読み取りだけが止まるので気づきにくい）。
  if (url.origin !== location.origin && CDN.indexOf(url.origin) < 0) return;

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
