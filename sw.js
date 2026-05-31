const CACHE = 'ggzon-v2';
const STATIC = ['/index.html', '/ptr.js', '/ggzon-auth.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // 페이지 이동(navigate) 및 외부 도메인은 SW 개입 없이 직접 통신
  if (e.request.mode === 'navigate') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request);
    })
  );
});
