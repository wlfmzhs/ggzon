// 골갑존 서비스워커
//
// 페이지를 옮길 때마다 Firebase SDK(수백 KB)와 이미지를 다시 받아오느라 생기던
// 로딩 버퍼링을 없애기 위한 캐시. 두 가지 원칙:
//   1) HTML 문서는 절대 캐시하지 않는다 — 배포 직후 옛 화면이 뜨는 사고를 막는다.
//   2) 나머지(외부 라이브러리·이미지·스크립트)만 캐시한다. 라이브러리 주소에는
//      버전이 박혀 있어(.../10.12.0/...) 내용이 바뀌지 않으므로 캐시 우선이 안전하다.
const VERSION = 'v3';
const CORE   = 'ggzon-core-' + VERSION;    // 우리 정적 파일 (js/css/이미지)
const VENDOR = 'ggzon-vendor-' + VERSION;  // gstatic·CDN 라이브러리

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
        keys.filter(k => k !== CORE && k !== VENDOR).map(k => caches.delete(k))
      ))
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

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 페이지 이동(HTML)은 손대지 않는다 — 항상 최신 배포본을 받는다
  if (req.mode === 'navigate') return;

  const url = req.url;

  if (VENDOR_PREFIX.some(p => url.startsWith(p))) {
    e.respondWith(cacheFirst(req, VENDOR));
    return;
  }

  if (!url.startsWith(self.location.origin)) return;   // 그 외 외부 도메인은 통과
  if (!ASSET_RE.test(url)) return;                     // HTML·API 응답은 통과

  e.respondWith(staleWhileRevalidate(req, CORE));
});
