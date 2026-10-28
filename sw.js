const CACHE = 'qingchoumaka-v63';
const ASSETS = [
  './',
  'index.html',
  // js/css 的網址帶版本（index.html 的 APP_V），第一次開啟時由下面的 fetch 處理存進快取，這裡不用列
  'manifest.json',
];
// 只有這些外部網站（圖表程式庫等固定不變的檔案）可以「先用快取」。
// 2026-10-27 修：原本「所有外部網站一律先用快取」→ 鉅亨的報價網址每次都一樣，第一次抓到的報價被存起來後，
// 手機就一直拿那份舊的、不再上網（定錨停 10/16、我的持股停 10/19，每次發新版清快取才短暫恢復）。
const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];

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
  if (e.request.method !== 'GET') return;

  // 外部網站：只有固定的程式庫走「先用快取」；報價、K 線、後端等即時資料一律不經過這裡（直接上網、不存）
  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.includes(url.hostname)) return;
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      }))
    );
    return;
  }

  // 自己的檔案（HTML/JS/CSS/資料檔）：網路優先，離線才用快取。
  // 資料檔（mk/、wb/）網址後面帶時間參數 → 快取時去掉參數只存一份，不會越存越多。
  const isData = /\/(mk|wb)\//.test(url.pathname);
  const key = isData ? url.origin + url.pathname : e.request;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    // 離線：用快取；只有「開頁面」才退回 index.html（資料檔 .json 不可以拿 HTML 頂替，會變成解析錯誤）
    }).catch(() => caches.match(key).then(c => c || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
