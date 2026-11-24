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
/* 非榜单数据的实例内缓存。workers.dev 上 caches.default 是 no-op，
   没有这层的话「热议/主题/热门/开发者/统计」每次都回源 trendshift.io。 */
const memText = new Map();     // RSC / 接口 / 热议：key -> { t, text, ttl }
const MEM_MAX = 40;            // 上限，防 128MB 内存溢出
/* 译文单独一个 Map：一次浏览两屏就有 50 条简介，
   和 RSC 共用 40 条上限会把 topics/devs/mentions 全挤掉，导致反复回源 */
const memTr = new Map();
const MEM_TR_MAX = 2000;

function memGet(key) {
  const hit = memText.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > hit.ttl * 1000) { memText.delete(key); return null; }
  return hit.text;
}
function memSet(key, text, ttl) {
  if (memText.size >= MEM_MAX) {
    // 简单 FIFO 淘汰
    const first = memText.keys().next().value;
    if (first) memText.delete(first);
  }
  memText.set(key, { t: Date.now(), text, ttl });
}

/* ---------- 云端增量译表（KV） ----------
   译表由 GitHub Actions 每天定时生成并写入 KV，Worker 只读。
   好处：追加几十条译文不需要重新部署 587 KB 的脚本，代码与数据解耦。
   isolate 内缓存 5 分钟，避免每个请求都读一次 KV（KV 读有延迟但很快）。 */
const memKvTr = { t: 0, table: null };
const KV_TR_TTL = 300;   // 秒

async function kvTrTable(env) {
  if (!env || !env.TR_KV) return null;
  const now = Date.now();
  if (memKvTr.table && now - memKvTr.t < KV_TR_TTL * 1000) return memKvTr.table;
  try {
    const raw = await env.TR_KV.get('tr.json', { type: 'text', cacheTtl: 300 });
    if (!raw) return null;
    const t = JSON.parse(raw);
    memKvTr.table = t;
    memKvTr.t = now;
    return t;
  } catch (e) {
    return memKvTr.table;   // 读失败用旧表，别让翻译整条挂掉
  }
}

/* 译文专用读写，和 memText 隔离 */
function trGet(k) {
  const hit = memTr.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > hit.ttl * 1000) { memTr.delete(k); return null; }
  return hit.text;
}
function trSet(k, text, ttl) {
  if (memTr.size >= MEM_TR_MAX) {
    const first = memTr.keys().next().value;
    if (first) memTr.delete(first);
  }
  memTr.set(k, { t: Date.now(), text, ttl });
}

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
  const mk = 'rsc:' + path;
  const mem = memGet(mk);
  if (mem) return mem;
  const res = await cached('https://ts.internal/rsc/' + path, ttl, async () => {
    const url = TS + '/' + path + (path.includes('?') ? '&' : '?') + '_rsc';
    const r = await fetch(url, {
      headers: { 'user-agent': UA, RSC: '1', accept: 'text/x-component' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!r.ok) throw new Error('rsc ' + path + ' ' + r.status);
    return await r.text();
  }, ctx);
  const text = await res.text();
  memSet(mk, text, ttl);
  return text;
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
  const mk = 'ts:' + path;
  const mem = memGet(mk);
  if (mem) return new Response(mem, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  const res = await cached('https://ts.internal/api/' + path, ttl, async () => {
    const r = await fetch(TS + path, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!r.ok) throw new Error('ts ' + path + ' ' + r.status);
    return await r.text();
  }, ctx);
  const text = await res.text();
  memSet(mk, text, ttl);
  return new Response(text, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* 热议：原站公开接口无 CORS，靠 Worker 代理 */
async function mentions(ctx) {
  const mem = memGet('mentions');
  if (mem) return new Response(mem, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  const res = await cached('https://ts.internal/mentions', 300, async () => {
    const r = await fetch(TS + '/api/social-mentions/latest', {
      headers: { 'user-agent': UA, accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
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
  const text = await res.text();
  memSet('mentions', text, 300);
  return new Response(text, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- Groq 翻译（主通道） ----------
   一次请求翻译一整批，包括含换行的长文本（用 <|SPLIT|> 分隔，不依赖换行对齐）。
   免费额度：1000 请求/日、8000 token/分钟、约 20 万 token/日。 */
const GROQ_MODEL = 'qwen/qwen3.8-27b';     // 非推理模型，token 省、格式稳
const GROQ_SPLIT = '<|SPLIT|>';

/* 剥掉模型加的序号前缀。必须要求序号后跟空白，
   否则「3.5 倍提升」会被切成「5 倍提升」、「2026.1 发布」切成「1 发布」。 */
function stripIndex(x) {
  /* 顿号在中文里后面不加空格，单独放行；「.」和「)」必须跟空白，
     否则「3.5 倍提升」会被切成「5 倍提升」 */
  let m = /^(\d{1,2})[.)]\s+/.exec(x) || /^(\d{1,2})、\s*/.exec(x);
  return m ? x.slice(m[0].length) : x;
}

/* ---- Gemini 多 key 轮换 ----
   免费档硬限：单 key 10 RPM / 500 RPD / 250K 上下文。
   单 key 10 RPM 对首屏 25 条明显不够，所以用多 key 轮流发，
   每个 key 各自计数，撞 429 就换下一个，全撞了才降级。 */
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
const GEMINI_RPM = 10;
const TR_MAX_ITEMS = 40;   // 单次翻译条目上限（前端按字符预算打包，通常 10~25 条）

function geminiKeys(env) {
  const raw = (env && (env.GEMINI_KEYS || env.GEMINI_API_KEY)) || '';
  return String(raw).split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
}

/* 每个 key 的滑动窗口请求时刻，用来主动限速，减少撞 429 的概率 */
const gqHits = new Map();
function keyReady(k, now) {
  const arr = (gqHits.get(k) || []).filter(t => now - t < 60000);
  gqHits.set(k, arr);
  return arr.length < GEMINI_RPM;
}
function markHit(k, now) {
  const arr = gqHits.get(k) || [];
  arr.push(now);
  gqHits.set(k, arr);
}

async function geminiTranslate(texts, keys) {
  if (!texts.length) return null;
  if (!keys.length) throw new Error('no gemini key');

  const sys = 'You are a translation engine. Translate each numbered item to Simplified Chinese. ' +
    'Items may contain multiple lines; preserve their internal line breaks. ' +
    'Separate output items with the exact marker ' + GROQ_SPLIT + ' on its own line. ' +
    'Keep code identifiers, repo names, versions, URLs and product names unchanged. ' +
    'No numbering, no commentary — output translations only.';
  const user = texts.map((t, i) => (i + 1) + '. ' + t).join('\n' + GROQ_SPLIT + '\n');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: sys + '\n\n' + user }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  });

  let lastErr = null;
  const now = Date.now();
  /* 优先挑这个分钟窗口内还有余量的 key，没有余量就按轮转顺序硬试 */
  const order = keys.map((k, i) => ({ k, i })).sort((a, b) => {
    const ra = keyReady(a.k, now) ? 0 : 1, rb = keyReady(b.k, now) ? 0 : 1;
    return ra - rb || a.i - b.i;
  });

  for (const { k } of order) {
    for (const model of GEMINI_MODELS) {
      let r;
      try {
        r = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model +
          ':generateContent?key=' + encodeURIComponent(k),
          { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body });
      } catch (e) { lastErr = e; continue; }

      if (r.status === 429) {
        /* 只 push 一条的话 1 < RPM，keyReady 仍然 true，下一个请求还会撞它。
           直接把窗口填满，这个 key 在一分钟内不会再被优先选中。 */
        const now2 = Date.now();
        const arr = (gqHits.get(k) || []).filter(t => now2 - t < 60000);
        for (let i = arr.length; i < GEMINI_RPM; i++) arr.push(now2);
        gqHits.set(k, arr);
        lastErr = new Error('gemini 429');
        break;
      }
      if (r.status === 404) { lastErr = new Error('gemini 404 ' + model); continue; }
      if (!r.ok) { lastErr = new Error('gemini ' + r.status); break; }

      const d = await r.json();
      const cand = (d.candidates && d.candidates[0]) || {};
      const out = ((cand.content && cand.content.parts) || []).map(x => x.text || '').join('');
      let parts = out.split(GROQ_SPLIT).map(x => x.trim()).map(stripIndex);
      if (parts.length !== texts.length) { lastErr = new Error('gemini align ' + parts.length + '/' + texts.length); continue; }
      /* 单条时 split 长度恒为 1，空串也能过长度校验 → 必须单独判内容 */
      if (!parts.some(x => x && x.trim())) { lastErr = new Error('gemini empty'); continue; }
      markHit(k, Date.now());
      return parts;
    }
  }
  throw lastErr || new Error('gemini failed');
}

async function groqTranslate(texts, key) {
  if (!key || !texts.length) return null;
  const sys = 'You are a translation engine. Translate each numbered item to Simplified Chinese. ' +
    'Items may contain multiple lines; preserve their internal line breaks. ' +
    'Separate output items with the exact marker ' + GROQ_SPLIT + ' on its own line. ' +
    'Keep code identifiers, repo names, versions, URLs and product names unchanged. ' +
    'No numbering, no commentary — output translations only.';
  const user = texts.map((t, i) => (i + 1) + '. ' + t).join('\n' + GROQ_SPLIT + '\n');
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: 4096,
  });
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      'user-agent': UA,
    },
    body,
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  const d = await r.json();
  const out = (d.choices && d.choices[0] && d.choices[0].message &&
    d.choices[0].message.content) || '';
  let parts = out.split(GROQ_SPLIT).map(x => x.trim());
  parts = parts.map(stripIndex);
  if (parts.length !== texts.length) throw new Error('groq align ' + parts.length + '/' + texts.length);
  if (!parts.some(x => x && x.trim())) throw new Error('groq empty');
  return parts;
}

async function api(url, ctx, env, request) {
  const p = url.searchParams;
  const path = url.pathname;

  if (path === '/api/mentions') return await mentions(ctx);

  /* 翻译代理：Gemini 多 key 优先，Groq 备用（key 都在 Worker secret）。
     ★ 译文缓存是刚需：免费额度按分钟计，不缓存的话每次刷新都重翻。
     ★ 支持 POST {texts:[...]}，避免长文本把 GET URL 撑到几 KB。 */
  if (path === '/api/tr') {
    let raw = [];
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        if (body && Array.isArray(body.texts)) raw = body.texts.map(x => String(x || ''));
      } catch (e) { return json({ error: 'bad json', zh: [] }, 0, 400); }
    } else {
      raw = (p.get('t') || '').split('\u0001');
    }
    raw = raw.filter(Boolean).slice(0, TR_MAX_ITEMS);
    if (!raw.length) return json({ zh: [] }, 60);

    const keys = geminiKeys(env);
    const hasGroq = !!(env && env.GROQ_API_KEY);
    if (!keys.length && !hasGroq) return json({ error: 'no key', zh: [] }, 60, 503);

    const zh = new Array(raw.length).fill('');
    const missing = [];
    /* 先查 KV 里的预翻译表（云端每天增量生成），再退到 isolate 缓存 */
    const kvTable = await kvTrTable(env);
    for (let i = 0; i < raw.length; i++) {
      const pre = kvTable ? kvTable[raw[i]] : null;
      if (pre) { zh[i] = pre; continue; }
      const hit = trGet(raw[i]);
      if (hit) zh[i] = hit;
      else missing.push(i);
    }
    if (!missing.length) return json({ zh, src: 'cache' }, 86400);

    let src = 'gemini';
    try {
      let got = null;
      if (keys.length) {
        try { got = await geminiTranslate(missing.map(i => raw[i]), keys); }
        catch (ge) { got = null; }
      }
      if (!got) {
        if (!hasGroq) throw new Error('gemini failed, no groq fallback');
        src = 'groq';
        got = await groqTranslate(missing.map(i => raw[i]), env.GROQ_API_KEY);
      }
      if (!Array.isArray(got)) throw new Error('no translation');
      missing.forEach((idx, n) => {
        const v = got[n];
        if (v && v !== raw[idx]) { zh[idx] = v; trSet(raw[idx], v, 30 * 86400); }
      });
      /* 一条都没翻出来 = 上游异常，别用 200 骗前端 */
      if (!zh.some(Boolean)) return json({ error: 'all empty', zh: [] }, 0, 502);
      return json({ zh, src }, 86400);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const partial = zh.some(Boolean);
      if (partial) return json({ zh, src, error: msg }, 86400);
      /* 把 429 如实透传，前端才能走短退避而不是一律 60 秒 */
      const code = /429/.test(msg) ? 429 : 502;
      return json({ error: msg, zh: [] }, 0, code);
    }
  }

  /* --- 主题列表 --- */
  if (path === '/api/topics') {
    const text = await rscText('topics', ctx);
    const hit = findOne(rscObjects(text), o =>
      Array.isArray(o.tags) && o.tags.length > 3 &&
      o.tags.every(t => t && typeof t === 'object' && t.display_name && t.slug));
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
    const cy = new Date().getUTCFullYear();
    const year = Math.min(Math.max(+(p.get('year') || cy) || cy, 2020), cy + 1);
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
  const noFilter = !lang || lang === 'all';
  // 无筛选时直接用预计算好的 g / periods，避免每次请求重跑 groupBy + 排序
  const langRows = noFilter ? rows : rows.filter(e => (e.language || 'Unknown') === lang);

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
    const limit = Math.min(Math.max(+(p.get('limit') || 40) || 40, 1), 100);
    if (q.length < 2) return json({ q, items: [] }, 60);
    const gl = noFilter ? g : groupBy(langRows);
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
  const gl = noFilter ? g : groupBy(langRows);
  const available = noFilter ? periods : [...gl.keys()].sort().reverse();
  const period = p.get('period') || available[0];
  const sort = p.get('sort') || 'rank';
  const limit = Math.min(Math.max(+(p.get('limit') || 100) || 100, 1), 100);
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
  // service-worker 格式：每个 secret / KV 绑定都是独立全局常量，这里聚合成对象
  const env = {};
  if (typeof GEMINI_KEYS !== 'undefined') env.GEMINI_KEYS = GEMINI_KEYS;
  if (typeof GEMINI_API_KEY !== 'undefined') env.GEMINI_API_KEY = GEMINI_API_KEY;
  if (typeof GROQ_API_KEY !== 'undefined') env.GROQ_API_KEY = GROQ_API_KEY;
  if (typeof TR_KV !== 'undefined') env.TR_KV = TR_KV;
  event.respondWith(handle(event.request, event, env));
});

async function handle(request, event, env) {
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
      return await api(url, event, env, request);
    } catch (e) {
      // 必须用非 2xx：否则前端 api() 放行、sw 缓存错误对象、渲染时 undefined 崩溃
      return json({ error: String((e && e.message) || e) }, 0, 502);
    }
  }
  if (url.pathname === '/tr.json') {
    /* 优先返回 KV 里的最新译表（云端每天更新），KV 不可用时回落到内联快照 */
    const t = await kvTrTable(env);
    if (t) {
      return new Response(JSON.stringify(t), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=1800',
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff',
        },
      });
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
        : isIcon ? 'public, max-age=86400'
        : url.pathname === '/tr.json' ? 'public, max-age=86400' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
