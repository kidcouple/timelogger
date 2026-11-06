const CACHE_NAME = 'time-logger-v46';
const ASSETS = [
  './',
  './index.html',
  './timer.html',
  './clients.html',
  './projects.html',
  './supabaseClient.js',
  './weeklyReportExcel.js',
  './echoline.js',
  './mailFollowups.js',
  './public-config.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // API 요청, POST 요청은 서비스워커가 캐싱하지 않음
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('supabase.co')) {
    return;
  }

  // 화면(index.html 등) 이동은 브라우저 HTTP 캐시(GitHub Pages max-age=600)를 거치지 않고 항상 새로 받는다 (11-04:
  // 배포 직후 예전 index.html + 새 mailFollowups.js 가 섞여 '할일 화면이 아직 준비되지 않았습니다' 가 뜨던 문제)
  const fresh = event.request.mode === 'navigate'
    ? fetch(event.request.url, { cache: 'no-store', credentials: 'same-origin' })
    : fetch(event.request);
  event.respondWith(
    fresh
      .then((networkResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
          if (event.request.method === 'GET') {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });
      })
      .catch(() => caches.match(event.request))
  );
});
