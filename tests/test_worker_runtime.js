#!/usr/bin/env node
/* 用 Node 直接跑构建产物里的 Worker 路由，验证 /api/tr 的长度契约与 429 透传。
   不联网：fetch / KV / caches 全部打桩。
   运行：node tests/test_worker_runtime.js */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const script = fs.readFileSync('/tmp/ts_worker.js', 'utf8');   // build_worker.py 的产物

let fails = 0;
const check = (n, c, e) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : '')); if (!c) fails++; };

// ---------- 打桩环境 ----------
const KV = { table: { 'cached english text': '缓存里的中文' } };
let geminiMode = 'ok';       // ok | 429
let geminiCalls = 0;

function makeFetch() {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      const body = JSON.parse(opts.body);
      const userText = body.contents[0].parts[0].text;
      const items = userText.split('\n\n')[1].split('\n<|SPLIT|>\n').map(s => s.replace(/^\d+\.\s*/, ''));
      if (geminiMode === '429') {
        return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
          { status: 429, headers: { 'content-type': 'application/json' } });
      }
      const out = items.map((t, i) => '译' + i).join('\n<|SPLIT|>\n');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.groq.com')) {
      const body = JSON.parse(opts.body);
      const items = body.messages[1].content.split('\n<|SPLIT|>\n').map(s => s.replace(/^\d+\.\s*/, ''));
      const out = items.map((t, i) => '格' + i).join('\n<|SPLIT|>\n');
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
}

const fakeCaches = {
  default: {
    async match() { return undefined; },
    async put() {},
  },
};

// 用 Function 在受控作用域里执行 Worker 脚本，暴露 handle()
function loadWorker(env) {
  const sandbox = {
    addEventListener: (name, fn) => { if (name === 'fetch') sandbox.__handler = fn; },
    caches: fakeCaches,
    fetch: makeFetch(),
    Request, Response, Headers, URL, AbortController, TextEncoder, TextDecoder,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout, console, Math, JSON, Date, Map, Set, Promise, Array, Object, String, Number, Error,
    __ASSETS__: undefined,
  };
  const vm = require('vm');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx, { filename: 'worker.js' });
  return { handle: ctx.handle, env, ctx };
}

async function call(w, pathname, { method = 'GET', body } = {}) {
  const url = new URL('https://x.workers.dev' + pathname);
  const req = new Request(url, method === 'POST'
    ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
    : { method });
  const event = { waitUntil() {}, respondWith(r) { this.res = r; } };
  const res = await w.handle(req, event, w.env);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json: parsed };
}

(async () => {
  console.log('[1] 64 条请求：返回长度必须等于请求长度');
  {
    const w = loadWorker({
      TR_KV: { get: async () => JSON.stringify(KV.table) },
      GEMINI_KEYS: 'k1 k2', GROQ_API_KEY: 'g',
    });
    const texts = Array.from({ length: 64 }, (_, i) => 'probe english text number ' + i);
    const r = await call(w, '/api/tr', { method: 'POST', body: { texts } });
    check('HTTP 200', r.status === 200, 'status=' + r.status + ' body=' + r.text.slice(0, 150));
    check('zh 长度 === 64', r.json && r.json.zh.length === 64, r.json ? 'len=' + r.json.zh.length : 'no json');
    check('前 40 槽有译文', r.json && r.json.zh.slice(0, 40).every(Boolean));
    check('后 24 槽为空串但存在', r.json && r.json.zh.slice(40).every(x => x === ''));
  }

  console.log('[2] 缓存命中：不发上游请求');
  {
    const before = geminiCalls;
    const w = loadWorker({
      TR_KV: { get: async () => JSON.stringify(KV.table) },
      GEMINI_KEYS: 'k1', GROQ_API_KEY: 'g',
    });
    const r = await call(w, '/api/tr', { method: 'POST', body: { texts: ['cached english text'] } });
    check('命中 KV 译表', r.json && r.json.zh[0] === '缓存里的中文', JSON.stringify(r.json));
    check('src=cache', r.json && r.json.src === 'cache');
    check('未调用 Gemini', geminiCalls === before, 'calls=' + (geminiCalls - before));
  }

  console.log('[3] Gemini 429 且无 Groq → 透传 429（不是 502）');
  {
    geminiMode = '429';
    const w = loadWorker({ TR_KV: { get: async () => '{}' }, GEMINI_KEYS: 'k1', GROQ_API_KEY: '' });
    const r = await call(w, '/api/tr', { method: 'POST', body: { texts: ['fresh english text here'] } });
    check('状态码 429', r.status === 429, 'status=' + r.status + ' body=' + r.text.slice(0, 200));
    check('错误信息含 429 证据', /429/.test(r.text), r.text.slice(0, 200));
    check('zh 仍是请求长度', r.json && Array.isArray(r.json.zh) && r.json.zh.length === 1);
    geminiMode = 'ok';
  }

  console.log('[4] 无任何密钥 → 503 但 zh 长度仍对齐');
  {
    const w = loadWorker({ TR_KV: { get: async () => '{}' }, GEMINI_KEYS: '', GROQ_API_KEY: '' });
    const r = await call(w, '/api/tr', { method: 'POST', body: { texts: ['a b c', 'd e f'] } });
    check('状态码 503', r.status === 503, 'status=' + r.status);
    check('zh 长度 === 2', r.json && r.json.zh.length === 2, r.json ? 'len=' + r.json.zh.length : 'no json');
  }

  console.log('[5] KV 读失败时不影响翻译（回退到实时通道）');
  {
    const w = loadWorker({
      TR_KV: { get: async () => { throw new Error('kv down'); } },
      GEMINI_KEYS: 'k1', GROQ_API_KEY: 'g',
    });
    const r = await call(w, '/api/tr', { method: 'POST', body: { texts: ['some new text here'] } });
    check('仍然 200 并给出译文', r.status === 200 && r.json.zh[0], 'status=' + r.status + ' body=' + r.text.slice(0, 150));
  }

  console.log('[6] /health 反映绑定状态');
  {
    const w = loadWorker({ TR_KV: {}, GEMINI_KEYS: 'k', GROQ_API_KEY: '' });
    const r = await call(w, '/health');
    check('health ok', r.json && r.json.ok === true);
    check('bindings.kv=true', r.json && r.json.bindings.kv === true);
    check('bindings.groq=false', r.json && r.json.bindings.groq === false);
  }

  console.log('');
  if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
  console.log('✓ 全部通过');
})();
