const CACHE = 'workoutlog3-v8';
const URLS = [
  '/workoutlog3/',
  '/workoutlog3/index.html',
  '/workoutlog3/style.css',
  '/workoutlog3/app.js',
  '/workoutlog3/manifest.webmanifest',
  '/workoutlog3/icon-192.png',
  '/workoutlog3/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(URLS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Supabase へのリクエストはキャッシュしない
  if (url.hostname.endsWith('supabase.co')) return;

  // index.html・CSS・JS はネットワーク優先
  if (url.pathname.match(/\.(html|css|js)$/) ||
      url.pathname === '/workoutlog3/' ||
      url.pathname === '/workoutlog3') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 画像・マニフェストはキャッシュ優先
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
