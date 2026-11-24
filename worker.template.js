// Trendshift — Cloudflare Worker
// 静态外壳 + 数据 API。
// 数据来源：①第三方静态镜像（趋势榜历史）②trendshift.io 官方内部 JSON 接口
// ③trendshift.io 页面 RSC 载荷（主题 / GitHub 热门仓库 / 开发者）

const UP = 'https://quantavil.github.io/trendshift/data/';
const TS = 'https://trendshift.io';
const CACHE_TTL = 6 * 3600;
const TFS = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const UA = 'Mozilla/5.0 (compatible; TrendshiftApp/3.0)';

const SHELL = __ASSETS__;

const json = (obj, maxAge = 300, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=' + maxAge,
    'access-control-allow-origin': '*',
  },
});

async function cached(key, ttl, producer, ctx) {
  const cache = caches.default;
  const req = new Request(key, { method: 'GET' });
  const hit = await cache.match(req);
  if (hit) return hit;
  const body = await producer();
  const res = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + ttl,
      'access-control-allow-origin': '*',
    },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

/* ---------- 上游：第三方镜像（趋势榜历史） ---------- */
/* isolate 内存缓存：解析后的数组直接复用。
   Edge Cache 只省了网络，1.9 MB 的 JSON.parse 仍然每次都跑（Workers 免费版 CPU 上限 10ms）。 */
/* 预计算缓存：rows 之外还存 groupBy 结果、期次表、语言目录。
   groupBy 要遍历数千行并排序，每次请求重跑会吃掉 Free Plan 的 10ms CPU。
   inflight 去重：冷启动并发请求不会同时下载并解析两遍 1.9MB JSON。 */
const memData = new Map();     // tf -> { t, rows, g, periods, langs }
const inflight = new Map();    // tf -> Promise

function buildData(rows) {
  const g = groupBy(rows);
  const periods = [...g.keys()].sort().reverse();
  return { t: Date.now(), rows, g, periods, langs: langCatalog(rows) };
}

async function allData(tf, ctx) {
  const hit = memData.get(tf);
  if (hit && Date.now() - hit.t < CACHE_TTL * 1000) return hit;
  if (inflight.has(tf)) return await inflight.get(tf);

  const p = (async () => {
    const res = await cached('https://ts.internal/up/' + tf, CACHE_TTL, async () => {
      const r = await fetch(UP + tf + '/' + tf + '-all.json', {
        headers: { 'user-agent': UA }, cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });
      if (!r.ok) throw new Error('upstream ' + r.status);
      return await r.text();
    }, ctx);
    const data = buildData(await res.json());
    memData.set(tf, data);
    return data;
  })();
  inflight.set(tf, p);
  try { return await p; } finally { inflight.delete(tf); }
}

function slim(e) {
  return {
    r: e.rank, n: e.full_name, u: e.github_url, d: e.description || '',
    l: e.language || '', s: e.stars_total, g: e.stars_gained,
    f: e.forks_total, fg: e.forks_gained, c: e.created_at || '',
    t: e.tags || [], m: e.social_mention_platforms || [], sc: e.score,
  };
}

function groupBy(rows) {
  const g = new Map();
  for (const e of rows) {
    let a = g.get(e.period_key);
    if (!a) { a = []; g.set(e.period_key, a); }
    a.push(e);
  }
  for (const a of g.values()) a.sort((x, y) => x.rank - y.rank);
  return g;
}

function langCatalog(rows) {
  const c = new Map();
  for (const e of rows) {
    const l = e.language || 'Unknown';
    c.set(l, (c.get(l) || 0) + 1);
  }
  return [...c.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* ---------- 上游：官方页面 RSC 载荷 ---------- */
async function rscText(path, ctx, ttl = CACHE_TTL) {
  const res = await cached('https://ts.internal/rsc/' + path, ttl, async () => {
    const url = TS + '/' + path + (path.includes('?') ? '&' : '?') + '_rsc';
    const r = await fetch(url, {
      headers: { 'user-agent': UA, RSC: '1', accept: 'text/x-component' },
    });
    if (!r.ok) throw new Error('rsc ' + path + ' ' + r.status);
    return await r.text();
  }, ctx);
  return await res.text();
}

/* RSC 是「<id>:<json>」逐行流；跳过模块引用行（I[...] / [..]） */
function rscObjects(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^[0-9a-f]+:(.*)$/.exec(line.trim());
    if (!m) continue;
    const body = m[1];
    const c = body[0];
    if (c !== '{' && c !== '[') continue;
    try { out.push(JSON.parse(body)); } catch (e) {}
  }
  return out;
}

/* 在对象森林里找第一个满足条件的 dict（数组只用于往下钻，不参与判定） */
function walkAll(objs, visit, maxDepth = 24) {
  const stack = objs.map(o => [o, 0]);
  const seen = new Set();
  while (stack.length) {
    const [o, d] = stack.pop();
    if (d > maxDepth || !o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (!Array.isArray(o) && visit(o)) return o;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') stack.push([v, d + 1]);
    }
  }
  return null;
}

function findOne(objs, pred) { return walkAll(objs, pred); }

/* 收集所有满足条件的 dict */
function findAll(objs, pred) {
  const out = [];
  const seen = new Set();
  const stack = objs.map(o => [o, 0]);
  while (stack.length) {
    const [o, d] = stack.pop();
    if (d > 24 || !o || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (!Array.isArray(o)) { if (pred(o)) out.push(o); }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') stack.push([v, d + 1]);
    }
  }
  return out;
}

const unox = v => (v === '$undefined' || v === null || v === undefined) ? '' : v;

/* ---------- 官方 JSON 接口（无 CORS，必须代理） ---------- */
async function tsJson(path, ctx, ttl = 3600) {
  return await cached('https://ts.internal/api/' + path, ttl, async () => {
    const r = await fetch(TS + path, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) throw new Error('ts ' + path + ' ' + r.status);
    return await r.text();
  }, ctx);
}

/* 热议：原站公开接口无 CORS，靠 Worker 代理 */
async function mentions(ctx) {
  return await cached('https://ts.internal/mentions', 300, async () => {
    const r = await fetch(TS + '/api/social-mentions/latest', {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!r.ok) throw new Error('mentions ' + r.status);
    const rows = await r.json();
    return {
      items: rows.map(x => ({
        id: x.id, plat: x.platform, repo: x.repository_full_name,
        title: x.title || '', text: (x.content || '').slice(0, 2000),
        author: x.author_handle || '', link: x.link, at: x.posted_at,
      })),
    };
  }, ctx);
}

async function api(url, ctx) {
  const p = url.searchParams;
  const path = url.pathname;

  if (path === '/api/mentions') return await mentions(ctx);

  /* --- 主题列表 --- */
  if (path === '/api/topics') {
    const text = await rscText('topics', ctx);
    const hit = findOne(rscObjects(text), o => Array.isArray(o.tags) && o.tags.length > 3);
    const topics = (hit ? hit.tags : []).map(t => ({ n: t.display_name, s: t.slug }));
    return json({ topics }, 3600);
  }

  /* --- 单个主题下的仓库 --- */
  if (path === '/api/topic') {
    const slug = (p.get('slug') || '').toLowerCase();
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) return json({ error: 'bad slug' }, 0, 400);
    const text = await rscText('topics/' + slug, ctx, 1800);
    const hit = findOne(rscObjects(text), o => Array.isArray(o.initialRepositories));
    const items = (hit ? hit.initialRepositories : []).map(e => ({
      n: e.full_name, u: 'https://github.com/' + e.full_name,
      d: e.description || '', l: e.language || '',
      s: e.watchers || 0, f: e.forks || 0, c: e.created_at || '',
      t: e.tags || [],
    }));
    return json({ slug, items }, 1800);
  }

  /* --- GitHub 热门仓库（Trendshift 收录过的、长期反复上榜的） --- */
  if (path === '/api/ghtrending') {
    const text = await rscText('github-trending-repositories', ctx);
    const raw = findAll(rscObjects(text), o => o.full_name && o.best_ranking != null);
    const seen = new Map();
    for (const e of raw) if (!seen.has(e.full_name)) seen.set(e.full_name, e);
    const items = [...seen.values()]
      .sort((a, b) => (a.best_ranking - b.best_ranking) || (b.featured_count - a.featured_count))
      .slice(0, 100)
      .map(e => ({
        n: e.full_name, u: 'https://github.com/' + e.full_name,
        d: e.description || '', best: e.best_ranking, cnt: e.featured_count,
      }));
    return json({ items }, 3600);
  }

  /* --- 热门开发者 --- */
  if (path === '/api/devs') {
    const text = await rscText('trending/developers', ctx);
    const hit = findOne(rscObjects(text), o => Array.isArray(o.developers));
    const items = (hit ? hit.developers : []).map(d => ({
      login: d.login, name: unox(d.name), avatar: unox(d.avatar_url),
      bio: unox(d.bio), company: unox(d.company), blog: unox(d.blog),
      location: unox(d.location), repos: d.public_repos, followers: d.followers,
      best: d.best_ranking, cnt: d.featured_count,
    }));
    return json({ items }, 3600);
  }

  /* --- 语言统计 --- */
  if (path === '/api/stats') {
    const year = +(p.get('year') || new Date().getUTCFullYear()) || new Date().getUTCFullYear();
    const month = Math.min(Math.max(+(p.get('month') || new Date().getUTCMonth() + 1) || 1, 1), 12);
    const metric = p.get('metric') === 'forks' ? 'forks' : 'stars';
    const res = await tsJson('/api/stats/languages/monthly?year=' + year +
      '&month=' + month + '&metric=' + metric, ctx, 3600);
    const rows = await res.json();
    const items = (Array.isArray(rows) ? rows : [])
      .filter(r => r.language)
      .map(r => ({ l: r.language, v: r[metric] || 0 }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 30);
    return json({ year, month, metric, items }, 3600);
  }

  /* --- 趋势榜（第三方镜像） --- */
  const tf = p.get('tf') || 'daily';
  if (!TFS.has(tf)) return json({ error: 'bad tf' }, 0, 400);

  const data = await allData(tf, ctx);
  const rows = data.rows, g = data.g, periods = data.periods;

  if (path === '/api/langs') {
    return json({ tf, langs: data.langs, periods: data.periods.length }, 1800);
  }
  if (path === '/api/periods') {
    return json({ tf, periods, count: rows.length }, 600);
  }

  const lang = p.get('lang') || '';
  const langRows = !lang || lang === 'all' ? rows : rows.filter(e => (e.language || 'Unknown') === lang);

  if (path === '/api/repo') {
    const name = (p.get('name') || '').toLowerCase();
    if (!name) return json({ error: 'name required' }, 0, 400);
    const series = [];
    let latestHit = null;                 // 最近一次上榜的条目（不一定是最新一期）
    for (const k of periods.slice().reverse()) {   // 从最早期次往最新走
      const hit = (g.get(k) || []).find(e => e.full_name.toLowerCase() === name);
      if (hit) {
        series.push({ p: k, r: hit.rank, g: hit.stars_gained, s: hit.stars_total, sc: hit.score });
        latestHit = hit;                  // 循环结束即最新一期命中（或最后一次命中）
      }
    }
    // 兜底：全量数据里再找一次（仓库可能在别的语言/期次出现过）
    if (!latestHit) latestHit = rows.find(e => e.full_name.toLowerCase() === name) || null;
    if (!series.length && !latestHit) return json({ name, series: [], appeared: false }, 300, 404);
    return json({
      name, appeared: true, series,
      latest: latestHit ? slim(latestHit) : null,
      best: series.length ? Math.min(...series.map(x => x.r)) : null,
      periods: series.length, tf,
    }, 600);
  }

  if (path === '/api/search') {
    const q = (p.get('q') || '').trim().toLowerCase();
    const limit = Math.min(+(p.get('limit') || 40) || 40, 100);
    if (q.length < 2) return json({ q, items: [] }, 60);
    const gl = groupBy(langRows);
    const seen = new Map();
    for (const k of periods) {
      for (const e of gl.get(k) || []) {
        if (seen.has(e.full_name)) continue;
        const hay = (e.full_name + ' ' + (e.description || '') + ' ' +
          (e.language || '') + ' ' + (e.tags || []).join(' ')).toLowerCase();
        if (hay.includes(q)) seen.set(e.full_name, slim(e));
        if (seen.size >= limit) break;
      }
      if (seen.size >= limit) break;
    }
    return json({ q, items: [...seen.values()] }, 300);
  }

  // /api/list
  const gl = groupBy(langRows);
  const available = [...gl.keys()].sort().reverse();
  const period = p.get('period') || available[0];
  const sort = p.get('sort') || 'rank';
  const limit = Math.min(+(p.get('limit') || 100) || 100, 100);
  const idx = available.indexOf(period);
  let items = (gl.get(period) || []).slice();
  if (sort === 'gain') items.sort((a, b) => (b.stars_gained || 0) - (a.stars_gained || 0));
  else if (sort === 'total') items.sort((a, b) => (b.stars_total || 0) - (a.stars_total || 0));

  const prev = idx >= 0 && idx + 1 < available.length ? (gl.get(available[idx + 1]) || []) : [];
  const prevRank = {};
  for (const e of prev) prevRank[e.full_name] = e.rank;

  return json({
    tf, lang: lang || 'all', period, sort, periods: available,
    total: items.length,
    items: items.slice(0, limit).map(slim),
    prev: prevRank,
  }, 300);
}

addEventListener('fetch', event => {
  event.respondWith(handle(event.request, event));
});

async function handle(request, event) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400',
      },
    });
  }
  if (url.pathname === '/health') {
    return json({
      ok: true, v: 3, paths: Object.keys(SHELL),
      api: ['/api/list', '/api/langs', '/api/periods', '/api/search', '/api/repo',
        '/api/topics', '/api/topic', '/api/ghtrending', '/api/devs', '/api/stats', '/api/mentions'],
    });
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      return await api(url, event);
    } catch (e) {
      // 必须用非 2xx：否则前端 api() 放行、sw 缓存错误对象、渲染时 undefined 崩溃
      return json({ error: String((e && e.message) || e) }, 0, 502);
    }
  }
  const hit = SHELL[url.pathname] || (url.pathname.endsWith('/') ? SHELL['/'] : null);
  if (!hit) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  let payload = hit.body;
  if (hit.b64) {
    const bin = atob(hit.b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    payload = buf;
  }
  const isIcon = url.pathname.startsWith('/icon');
  return new Response(request.method === 'HEAD' ? null : payload, {
    headers: {
      'content-type': hit.type,
      'cache-control': url.pathname === '/sw.js' ? 'no-cache'
        : isIcon ? 'public, max-age=86400' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
