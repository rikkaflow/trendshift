const CACHE = 'trendshift-v5';

/* 弱网/假连接时 fetch 可能长时间不返回，用户会被卡在骨架屏 */
function withTimeout(promise, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 外壳：网络优先（保证更新立即生效），失败才回缓存 */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && !url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return r;
      }).catch(() => caches.match(req).then(h => h || new Response('离线', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      })))
    );
    return;
  }

  /* API：网络优先，失败回缓存（离线看上次内容） */
  /* 翻译请求不缓存：URL/POST body 里的文本组合近乎无限，
     而且前端 localStorage 已经存了译文，再进 Cache Storage 只会无限膨胀 */
  if (url.pathname.startsWith('/api/tr')) {
    e.respondWith(withTimeout(fetch(req), 20000).catch(() =>
      new Response('{"error":"timeout","zh":[]}', {
        status: 503, headers: { 'content-type': 'application/json; charset=utf-8' },
      })));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      withTimeout(fetch(req), 15000).then(r => {
        // 只缓存成功响应：502/400 存进去会让离线时读出报错
        if (r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return r;
      }).catch(() => caches.match(req).then(h => h || new Response('{"error":"offline"}', {
        status: 503, headers: { 'content-type': 'application/json; charset=utf-8' },
      })))
    );
  }
});
