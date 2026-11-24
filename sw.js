const CACHE = 'trendshift-v3';
const SHELL = ['./index.html', './manifest.webmanifest',
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
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp));
        return r;
      }).catch(() => caches.match(req))
    );
  }
});
