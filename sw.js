const CACHE = 'qingchoumaka-v55';
const ASSETS = [
  './',
  'index.html',
  // js/css 的網址帶版本（index.html 的 APP_V），第一次開啟時由下面的 fetch 處理存進快取，這裡不用列
  'manifest.json',
];

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the HTTP cache so a new SW never stores stale files.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls — always go to network for live data.
  if (url.hostname.includes('finmindtrade.com')) return;
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) return;
  if (e.request.method !== 'GET') return;

  // Own files (HTML/JS/CSS): network first so a new deploy shows up on the next open;
  // fall back to the cached copy when offline. Other origins (CDN libs): cache first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      // 離線：用快取；只有「開頁面」才退回 index.html（資料檔 .json 不可以拿 HTML 頂替，會變成解析錯誤）
      }).catch(() => caches.match(e.request).then(c => c || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }))
  );
});
