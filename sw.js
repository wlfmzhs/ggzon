// 골갑존 서비스워커
//
// 페이지를 옮길 때마다 Firebase SDK(수백 KB)와 이미지를 다시 받아오느라 생기던
// 로딩 버퍼링을 없애기 위한 캐시. 두 가지 원칙:
//   1) HTML 문서는 항상 네트워크 우선 — 배포 직후 옛 화면이 뜨는 사고를 막는다.
//      단, 골프장처럼 신호가 약해 응답이 2.5초 넘게 안 오거나 끊기면
//      마지막으로 받아 둔 같은 페이지를 대신 보여 준다 (하얀 화면으로 멈춰 있는 것보다 낫다).
//   2) 나머지(외부 라이브러리·이미지·스크립트)만 캐시한다. 라이브러리 주소에는
//      버전이 박혀 있어(.../10.12.0/...) 내용이 바뀌지 않으므로 캐시 우선이 안전하다.
const VERSION = 'v3';
const CORE   = 'ggzon-core-' + VERSION;    // 우리 정적 파일 (js/css/이미지)
const VENDOR = 'ggzon-vendor-' + VERSION;  // gstatic·CDN 라이브러리
const PAGES  = 'ggzon-pages';               // 신호 약할 때 대신 보여 줄 마지막 HTML (버전과 무관하게 유지)
const NAV_TIMEOUT = 2500;

const CORE_FILES = ['/ptr.js', '/ggzon-auth.js', '/fs-cache.js', '/ggzon-config.js'];

// 버전이 URL에 고정돼 있어 캐시해도 안전한 외부 주소
const VENDOR_PREFIX = [
  'https://www.gstatic.com/firebasejs/',
  'https://cdnjs.cloudflare.com/',
  'https://t1.kakaocdn.net/kakao_js_sdk/',
  'https://fonts.gstatic.com/',
];

const ASSET_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|js|css|woff2?)(?:$|\?)/i;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CORE).then(c =>
      // 한 파일이 없어도 설치 자체는 성공해야 한다
      Promise.all(CORE_FILES.map(f => c.add(f).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CORE && k !== VENDOR && k !== PAGES).map(k => caches.delete(k))
      ))
      // 서비스워커가 깨어나는 동안 HTML 요청을 먼저 보내 두는 기능 (지원 브라우저만)
      .then(() => self.registration.navigationPreload?.enable().catch(() => {}))
      .then(() => clients.claim())
  );
});

// 캐시가 있으면 즉시 주고, 뒤에서 조용히 새 버전을 받아 둔다
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then(res => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

// 버전 고정 URL — 한 번 받으면 다시 받을 필요가 없다
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

// 페이지(HTML): 네트워크 우선. 제때 오면 그걸 쓰고 사본을 저장, 늦거나 실패하면 저장본.
// 저장 키는 주소에서 ?id= 같은 검색어를 뺀 경로 — score.html?id=A 사본으로 ?id=B 도 띄울 수 있다
// (데이터는 페이지가 주소를 읽어 따로 받으므로 HTML 틀은 같다).
async function pageNetworkFirst(e) {
  const req = e.request;
  const url = new URL(req.url);
  const key = url.origin + url.pathname;
  const network = Promise.resolve(e.preloadResponse).catch(() => null)
    .then(pre => pre || fetch(req))
    .then(res => {
      if (res && res.ok && res.type === 'basic') {
        const save = caches.open(PAGES).then(c => c.put(key, res.clone())).catch(() => {});
        try { e.waitUntil(save); } catch (_) {}   // 저장본으로 이미 응답한 뒤면 waitUntil 이 막힌다
      }
      return res;
    });
  const cached = caches.open(PAGES).then(c => c.match(key)).catch(() => undefined);
  const timeout = new Promise(r => setTimeout(r, NAV_TIMEOUT));
  try {
    const first = await Promise.race([network, timeout.then(() => cached)]);
    if (first) return first;   // 제때 온 네트워크 응답, 또는 시간 초과 시 저장본
  } catch (_) {
    const c = await cached;    // 네트워크 실패(오프라인 등)
    if (c) return c;
  }
  return network;              // 저장본이 없으면 끝까지 네트워크를 기다린다
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    const url = new URL(req.url);
    if (url.origin === self.location.origin) e.respondWith(pageNetworkFirst(e));
    return;
  }

  const url = req.url;

  if (VENDOR_PREFIX.some(p => url.startsWith(p))) {
    e.respondWith(cacheFirst(req, VENDOR));
    return;
  }

  if (!url.startsWith(self.location.origin)) return;   // 그 외 외부 도메인은 통과
  if (!ASSET_RE.test(url)) return;                     // HTML·API 응답은 통과

  e.respondWith(staleWhileRevalidate(req, CORE));
});

// ── 라운드 시작 웹 푸시 ─────────────────────────────────────
// 서버(functions notifyRoundStart)는 FCM 'data' 만 보낸다: { title, body, url, tag }.
// Firebase 메시징 SDK 를 서비스워커에 넣지 않고 여기서 직접 알림을 그린다
// (위 캐시 처리와 분리, iOS 는 push 마다 알림을 꼭 띄워야 한다).
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = { data: { body: e.data && e.data.text() } }; }
  const d = p.data || {};
  const n = p.notification || {};
  const title = d.title || n.title || '골갑존';
  const opts = {
    body: d.body || n.body || '',
    icon: '/image/icon-512.png',
    badge: '/image/icon-512.png',
    data: { url: d.url || '/' },
  };
  if (d.tag) opts.tag = d.tag;   // 같은 조인 알림이 겹쳐 오면 하나로
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 알림을 누르면 그 라운드의 스코어(관전) 화면을 연다. 이미 열린 창이 있으면 그 창을 쓴다.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || '/';
  const target = new URL(raw, self.location.origin);
  if (target.origin !== self.location.origin) return;   // 우리 사이트 주소만 연다
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url === target.href);
    if (same) return same.focus();
    const ours = wins.find(w => new URL(w.url).origin === target.origin && 'navigate' in w);
    if (ours) {
      try { const w = await ours.navigate(target.href); if (w) return w.focus(); } catch (_) {}
    }
    return clients.openWindow(target.href);
  })());
});
