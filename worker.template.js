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
const memKvTr = { t: 0, table: null, raw: '' };
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
    /* 原文也留着：/tr.json 直接吐 raw 字符串，省掉「parse 成对象再 stringify」
       的整趟 CPU（免费版 10ms 上限，1.9 MB 级别的表往返很贵）。 */
    memKvTr.raw = raw;
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
  /* ★ 简介首尾空白必须在这里统一剥掉（唯一入口）。
     cloud_sync.py 入库时用 `description.strip()` 当 key，而 Worker/前端直接用
     原始字符串查表 → 原文末尾带空格/换行的条目**永远 miss 译表**，每次刷新都
     重新走 /api/tr 实时翻译（白耗 Gemini 额度），界面也一直是英文。
     实测上游 4920 条简介里有 59 条带首尾空白，其中 58 条的 trim 版本在表里。 */
  for (const e of rows) {
    if (typeof e.description === 'string') e.description = e.description.trim();
  }
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
    const body = await r.text();
    /* 200 不等于内容正确：Cloudflare 质询页 / 5xx 降级页都是 text/html，
       rscObjects() 会静默返回 []，然后空结果被缓存 6 小时（整站数据「静默变空」）。
       先校验它确实像 RSC 流（`<hex id>:<json>`）再进缓存。 */
    if (!body || !/^[0-9a-f]+:/m.test(body)) {
      throw new Error('rsc malformed ' + path + ' ' + (r.headers.get('content-type') || '?'));
    }
    return body;
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
  if (mem) return new Response(mem, { headers: jsonHeaders(ttl) });
  const res = await cached('https://ts.internal/api/' + path, ttl, async () => {
    const r = await fetch(TS + path, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!r.ok) throw new Error('ts ' + path + ' ' + r.status);
    const body = await r.text();
    /* 200 不等于内容是 JSON：Cloudflare 质询页 / 维护页都是 text/html + 200。
       rscText 已经防了这一手，tsJson 也必须防 —— 否则非法 JSON 会被写进
       memText 与 caches.default 各 6 小时，调用方 res.json() 抛错 → /api/stats 恒 502。 */
    try { JSON.parse(body); } catch (e) {
      throw new Error('ts ' + path + ' 非 JSON（' + (r.headers.get('content-type') || '?') + '）');
    }
    return body;
  }, ctx);
  const text = await res.text();
  memSet(mk, text, ttl);
  return new Response(text, { headers: jsonHeaders(ttl) });
}

/* JSON 代理响应的统一头：漏了 cache-control 会让边缘缓存按默认策略走，
   漏了 CORS 会让浏览器直连的自建客户端读不到 body。 */
function jsonHeaders(maxAge) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=' + maxAge,
    'access-control-allow-origin': '*',
  };
}

/* 热议：原站公开接口无 CORS，靠 Worker 代理 */
async function mentions(ctx) {
  const mem = memGet('mentions');
  if (mem) return new Response(mem, { headers: jsonHeaders(300) });
  const res = await cached('https://ts.internal/mentions', 300, async () => {
    const r = await fetch(TS + '/api/social-mentions/latest', {
      headers: { 'user-agent': UA, accept: 'application/json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) throw new Error('mentions ' + r.status);
    /* 同 tsJson：200 也可能是 HTML 质询页，r.json() 抛错会让 /api/mentions 恒 502，
       而「热议」是首页可见栏目。先按文本取再校验。 */
    const body = await r.text();
    let rows;
    try { rows = JSON.parse(body); } catch (e) {
      throw new Error('mentions 非 JSON（' + (r.headers.get('content-type') || '?') + '）');
    }
    if (!Array.isArray(rows)) throw new Error('mentions 不是数组');
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
  return new Response(text, { headers: jsonHeaders(300) });
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
const TR_MAX_CHARS = 4000; // 单条文本上限（简介/推文都在 2000 以内）
const TR_MAX_TOTAL = 20000; // 单次请求总字符预算
const TR_MAX_BODY_BYTES = 256 * 1024; // 限制JSON解析前的请求体内存

async function readBoundedText(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

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
      if (!r.ok) {
        lastErr = new Error('gemini ' + r.status);
        /* 5xx = 模型过载/临时故障，换下一个模型通常能救回来（cloud_sync 同款退避）；
           4xx（401 无效 key / 400 请求错）换模型没有意义。 */
        if (r.status >= 500) continue;
        break;
      }

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
      const payload = await readBoundedText(request, TR_MAX_BODY_BYTES);
      if (payload === null) return json({ error: 'request body too large', zh: [] }, 0, 413);
      let body;
      try { body = JSON.parse(payload); }
      catch (e) { return json({ error: 'bad json', zh: [] }, 0, 400); }
      if (!body || !Array.isArray(body.texts)) return json({ error: 'texts must be an array', zh: [] }, 0, 400);
      if (body.texts.length > TR_MAX_ITEMS) return json({ error: 'too many texts', zh: [] }, 0, 413);
      if (body.texts.some(x => typeof x !== 'string')) return json({ error: 'texts must contain strings', zh: [] }, 0, 400);
      raw = body.texts;
    } else if (request.method === 'GET') {
      raw = (p.get('t') || '').split('\\u0001');
    } else {
      return json({ error: 'method not allowed', zh: [] }, 0, 405);
    }
    /* ★ 返回数组长度必须与请求条数严格相等：前端用 d.zh.length === texts.length
       校验对齐，少一个槽就会整批判为失败并熔断 15~60 秒。
       所以超限的条目只能留空槽，不能截短数组 ——
       旧实现 `new Array(Math.min(raw.length, TR_MAX_ITEMS))` 让长度变成 40，
       与这条契约自相矛盾（注释写着「不能过滤掉」，代码却在截断）。 */
    if (raw.length > TR_MAX_ITEMS) return json({ error: 'too many texts', zh: [] }, 0, 413);
    /* 总字符超预算时不拒绝整批：那会让前端整条翻译通道熔断 60 秒，
       反而比「该条留空槽、前端逐条兜底」更糟。请求体已有 256 KiB 硬上限，
       加上条数 ≤ 40，响应数组尺寸天然有界。 */
    const n = raw.length;
    let budget = TR_MAX_TOTAL;
    const zh = new Array(raw.length).fill('');
    const missing = [];
    const keys = geminiKeys(env);
    const hasGroq = !!(env && env.GROQ_API_KEY);
    if (!keys.length && !hasGroq) return json({ error: 'no key', zh }, 60, 503);

    /* 先查 KV 里的预翻译表（云端每天增量生成），再退到 isolate 缓存 */
    const kvTable = await kvTrTable(env);
    for (let i = 0; i < n; i++) {
      const src0 = String(raw[i] || '');
      if (!src0) continue;
      const pre = kvTable ? kvTable[src0] : null;
      if (pre) { zh[i] = pre; continue; }
      const hit = trGet(src0);
      if (hit) { zh[i] = hit; continue; }
      /* 单条过长 / 总量超预算：留空槽，前端会走兜底，不会误判对齐失败 */
      if (src0.length > TR_MAX_CHARS || budget < src0.length) continue;
      budget -= src0.length;
      missing.push(i);
    }
    if (!missing.length) return json({ zh, src: 'cache' }, 86400);

    let src = 'gemini';
    try {
      let got = null;
      let lastGeminiError = '';
      if (keys.length) {
        try { got = await geminiTranslate(missing.map(i => raw[i]), keys); }
        catch (ge) { got = null; lastGeminiError = String((ge && ge.message) || ge); }
      }
      if (!got) {
        if (!hasGroq) {
          /* ★ 必须把 Gemini 的原始错误带出去：旧实现只抛
             'gemini failed, no groq fallback'，把真正的 429 吞掉了，
             下面 /429/ 判定恒假 → 前端拿到 502 走 60 秒退避而不是 15 秒。 */
          throw new Error('gemini failed, no groq fallback' +
            (lastGeminiError ? ': ' + lastGeminiError : ''));
        }
        src = 'groq';
        got = await groqTranslate(missing.map(i => raw[i]), env.GROQ_API_KEY);
      }
      if (!Array.isArray(got)) throw new Error('no translation');
      missing.forEach((idx, n) => {
        const v = got[n];
        if (v && v !== raw[idx]) { zh[idx] = v; trSet(raw[idx], v, 30 * 86400); }
      });
      /* 一条都没翻出来 = 上游异常，别用 200 骗前端。
         但 zh 仍要按请求长度返回（全空槽），否则前端对齐校验先失败，
         拿到的是 'gq align' 而不是真实原因。 */
      if (!zh.some(Boolean)) return json({ error: 'all empty', zh }, 0, 502);
      return json({ zh, src }, 86400);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const partial = zh.some(Boolean);
      /* 部分失败不能缓存：空槽位被边缘缓存 24 小时，用户整天看到同一批没翻的条目 */
      if (partial) return json({ zh, src, error: msg }, 0);
      /* 把 429 如实透传，前端才能走短退避而不是一律 60 秒 */
      const code = /429/.test(msg) ? 429 : 502;
      return json({ error: msg, zh }, 0, code);
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
  /* tf=all 只对 /api/repo 有意义：从主题/热门/开发者等页面进详情时，
     调用方不知道这个仓库上的是哪个榜，不能硬回退成 weekly。 */
  if (!TFS.has(tf) && !(tf === 'all' && path === '/api/repo')) {
    return json({ error: 'bad tf' }, 0, 400);
  }

  if (path === '/api/repo') {
    const name = (p.get('name') || '').toLowerCase();
    if (!name) return json({ error: 'name required' }, 0, 400);
    /* 依次找第一个有记录的榜单。只返回单个 tf 的 series：
       不同榜单的期次键格式不同（2026-W48 / 2026-11-25 / 2026-11），
       混在一起排序没有意义，前端走势图也会乱。 */
    const order = tf === 'all' ? ['weekly', 'daily', 'monthly', 'yearly'] : [tf];
    for (const src of order) {
      let data;
      try { data = await allData(src, ctx); } catch (e) { continue; }
      const series = [];
      let latestHit = null;               // 最近一次上榜的条目（不一定是最新一期）
      for (const k of data.periods.slice().reverse()) {   // 从最早期次往最新走
        const hit = (data.g.get(k) || []).find(e => e.full_name.toLowerCase() === name);
        if (hit) {
          series.push({ p: k, r: hit.rank, g: hit.stars_gained, s: hit.stars_total, sc: hit.score });
          latestHit = hit;
        }
      }
      if (series.length) {
        return json({
          name, appeared: true, tf: src, series,
          latest: latestHit ? slim(latestHit) : null,
          best: Math.min(...series.map(x => x.r)),
          periods: series.length,
        }, 600);
      }
    }
    return json({ name, series: [], appeared: false, tf }, 300, 404);
  }

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
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400',
      },
    });
  }
  if (url.pathname === '/health') {
    return json({
      ok: true, v: 4, paths: Object.keys(SHELL),
      /* 部署后自检用：secret 绑定丢失时 /api/tr 会 503，
         但旧版 deploy.sh 只验 health/list/tr.json 三项，看不出问题。 */
      bindings: {
        kv: !!(env && env.TR_KV),
        gemini: !!(env && (env.GEMINI_KEYS || env.GEMINI_API_KEY)),
        groq: !!(env && env.GROQ_API_KEY),
      },
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
      return new Response(memKvTr.raw || JSON.stringify(t), {
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
  /* HTML 外壳必须 no-cache：给 300s 的话，5 分钟内连续部署时浏览器 HTTP 缓存
     会先把旧 index.html 交出去，SW 的网络优先也救不回来（它拿到的就是旧的）。 */
  const isHtml = hit.type.startsWith('text/html');
  return new Response(request.method === 'HEAD' ? null : payload, {
    headers: {
      'content-type': hit.type,
      'cache-control': isHtml || url.pathname === '/sw.js' ? 'no-cache'
        : isIcon ? 'public, max-age=86400'
        : url.pathname === '/tr.json' ? 'public, max-age=86400' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
