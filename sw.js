const CACHE = 'invest-v14';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  const isHTML = e.request.mode === 'navigate' || url.endsWith('/') || url.endsWith('index.html');
  if (isHTML) {
    // 主頁面：快取優先即時開啟（秒開），同時背景抓最新版更新快取（stale-while-revalidate）
    e.respondWith(
      caches.match('./index.html').then(cached => {
        const fresh = fetch(e.request).then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return resp;
        }).catch(() => cached || caches.match('./'));
        return cached || fresh; // 有快取秒回、背景更新；無快取才等網路
      })
    );
    return;
  }
  // 其他靜態資源：快取優先
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
