const CACHE = 'trendshift-v7';

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
  /* cache: 'no-cache' 强制回源校验：默认缓存模式下，5 分钟内连续部署
     会把旧版 index.html 装进新 SW 的预缓存里。 */
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
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
    /* ★ 这里必须带超时：同源静态资源走网络优先，
       弱网「连上了但不通」时 fetch 会死等到浏览器/系统超时（可达 20 秒以上），
       期间整页停在骨架屏。
    ★★ 但 tr.json 不能套 4 秒：它是 390 KB+ 且每天增长，
       弱网/移动端首次拉取很容易超过 4 秒，超时后本地又没有缓存 → 直接 503，
       index.html 的 20 秒预算形同虚设，整站退化到实时翻译（耗 Gemini 额度 + 慢）。
       首次访问 = 缓存里没有 tr.json，这一档必须给足。 */
    const isTr = url.pathname === '/tr.json';
    const budget = isTr ? 18000 : 4000;
    e.respondWith(
      withTimeout(fetch(req), budget).then(r => {
        if (r.ok) {
          const cp = r.clone();
          /* waitUntil 托底：不挂上去的话，超时/页面跳转会把 put 一起掐掉，
             下次冷启动还是没缓存。 */
          e.waitUntil(caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}));
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