#!/usr/bin/env node
/* 离线快照键与淘汰策略的回归测试（从 index.html 抽真实实现）。
   运行：node tests/test_snapshot_key.js */
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

let fails = 0;
const check = (n, c, e) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : '')); if (!c) fails++; };

// ---- 抽出 snapKey / pruneSnapshots / save 里相关片段 ----
function pick(re, name) {
  const m = html.match(re);
  if (!m) { console.error('✗ 无法抽取 ' + name); process.exit(2); }
  return m[0];
}
const snapKeySrc = pick(/function snapKey\(s\)\{[\s\S]*?\n\}/, 'snapKey');
const KEEP = +(/const KEEP_SNAPSHOTS = (\d+);/.exec(html) || [0, 6])[1];

// 用假 localStorage 跑 pruneSnapshots
/* localStorage 的 Object.keys() 必须能看到已存的键（真实实现如此）。
   普通对象做不到，用 Proxy 把内部 Map 的键投影成自有可枚举属性。 */
function makeStore() {
  const m = new Map();
  const api = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => [...m.keys()][i] ?? null,
    clear: () => m.clear(),
    _keys: () => [...m.keys()],
  };
  return new Proxy(api, {
    get(t, prop) {
      if (prop === 'length') return m.size;
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && m.has(prop)) return m.get(prop);
      return undefined;
    },
    set(t, prop, v) { m.set(String(prop), String(v)); return true; },
    has(t, prop) { return prop in t || (typeof prop === 'string' && m.has(prop)); },
    ownKeys() { return [...m.keys()]; },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'string' && m.has(prop)) {
        return { value: m.get(prop), enumerable: true, configurable: true, writable: true };
      }
      return Object.getOwnPropertyDescriptor(t, prop);
    },
  });
}
const store = makeStore();
const localStorage = store;
const st = { statYear: 2026, statMonth: 3 };
const pruneSrc = pick(/function pruneSnapshots\(\)\{[\s\S]*?\n\}/, 'pruneSnapshots');
const pruneSnapshots = new Function('localStorage', 'KEEP_SNAPSHOTS',
  pruneSrc + '\nreturn pruneSnapshots;')(store, KEEP);
const snapKey = new Function('st', snapKeySrc + '\nreturn snapKey;')(st);

console.log('[1] snapKey 区分内容维度');
{
  const base = snapKey({ tf: 'weekly', lang: '' });
  check('基础键格式不变', base === 'ts:last:weekly:', base);
  check('搜索词进入键', snapKey({ tf: 'weekly', lang: '', q: 'rust' }) !== base);
  check('搜索键含 q=', /:q=rust$/.test(snapKey({ tf: 'weekly', lang: '', q: 'rust' })));
  check('主题二级页进入键', /:topic=ai-agent$/.test(snapKey({ tf: 'topics', lang: '', topicSlug: 'ai-agent' })));
  check('全部主题页不带 topic', !/:topic=/.test(snapKey({ tf: 'topics', lang: '' })));
  check('统计年月进入键', /:ym=2026-3$/.test(snapKey({ tf: 'stats', lang: '' })));
  check('不同搜索词互不覆盖',
    snapKey({ tf: 'weekly', lang: '', q: 'rust' }) !== snapKey({ tf: 'weekly', lang: '', q: 'go' }));
}

console.log('[2] pruneSnapshots 按写入时间淘汰，不按 key 顺序');
{
  // 必须先超过 KEEP 条才触发淘汰（KEEP 默认 6），否则 prune 直接 return
  store.setItem('ts:last:weekly:', JSON.stringify({ ts: 1000, items: [] }));      // 最旧，但 key 排第一
  store.setItem('ts:last:daily:', JSON.stringify({ ts: 5000, items: [] }));
  store.setItem('ts:last:monthly:', JSON.stringify({ ts: 9000, items: [] }));
  store.setItem('ts:last:yearly:', JSON.stringify({ ts: 7000, items: [] }));
  for (let i = 0; i < KEEP; i++) store.setItem('ts:last:filler' + i + ':', JSON.stringify({ ts: 9000 + i }));
  pruneSnapshots();
  const left = store._keys();
  check('条目数不超过 KEEP_SNAPSHOTS', left.length <= KEEP, 'left=' + left.length);
  check('最旧的一条被淘汰', !left.includes('ts:last:weekly:'), left.join(','));
  // KEEP=6 时只会保留最新 6 条，monthly(9000)/yearly(7000) 都在 filler(9000+) 之后被淘汰
  const newest = ['ts:last:filler' + (KEEP - 1) + ':'];
  check('最新的一条保留', left.includes(newest[0]), left.join(','));
  check('淘汰的确实是最旧的', left.length === KEEP && !left.includes('ts:last:weekly:'));
}
{
  // 反向：最新写入的 key 名字排在前面，也不该被删
  const s2 = makeStore();
  const prune2 = new Function('localStorage', 'KEEP_SNAPSHOTS',
    pruneSrc + '\nreturn pruneSnapshots;')(s2, 3);
  s2.setItem('ts:last:aaa:', JSON.stringify({ ts: 9e12 }));   // 最新但字典序最前
  s2.setItem('ts:last:bbb:', JSON.stringify({ ts: 1 }));
  s2.setItem('ts:last:ccc:', JSON.stringify({ ts: 2 }));
  s2.setItem('ts:last:ddd:', JSON.stringify({ ts: 3 }));
  prune2();
  check('最新条目（字典序最前）被保留', s2._keys().includes('ts:last:aaa:'), s2._keys().join(','));
}

console.log('[3] 无 ts 字段的老快照优先淘汰，不会导致崩溃');
{
  const s3 = makeStore();
  const prune3 = new Function('localStorage', 'KEEP_SNAPSHOTS',
    pruneSrc + '\nreturn pruneSnapshots;')(s3, 2);
  s3.setItem('ts:last:legacy:', JSON.stringify({ items: [] }));   // 无 ts
  s3.setItem('ts:last:new1:', JSON.stringify({ ts: 5 }));
  s3.setItem('ts:last:new2:', JSON.stringify({ ts: 6 }));
  let threw = false;
  try { prune3(); } catch (e) { threw = true; }
  check('不抛异常', !threw);
  check('无 ts 的老快照被淘汰', !s3._keys().includes('ts:last:legacy:'), s3._keys().join(','));
}

console.log('[4] pruneGh 也按写入时间淘汰');
{
  const ghSrc = pick(/function pruneGh\(\)\{[\s\S]*?\n\}/, 'pruneGh');
  const KEEP_GH = +(/const KEEP_GH = (\d+);/.exec(html) || [0, 80])[1];
  const s4 = makeStore();
  const pruneGh = new Function('localStorage', 'KEEP_GH', ghSrc + '\nreturn pruneGh;')(s4, 3);
  s4.setItem('gh:aaa/oldest', JSON.stringify({ t: 1, v: {} }));     // 字典序最前 + 最旧
  s4.setItem('gh:zzz/newest', JSON.stringify({ t: 9e12, v: {} }));
  s4.setItem('gh:mmm/mid', JSON.stringify({ t: 5e12, v: {} }));
  s4.setItem('gh:bbb/newer', JSON.stringify({ t: 8e12, v: {} }));
  pruneGh();
  const left = s4._keys();
  check('最新的一条保留', left.includes('gh:zzz/newest'), left.join(','));
  check('第二新的保留', left.includes('gh:bbb/newer'), left.join(','));
  check('最旧的被淘汰', !left.includes('gh:aaa/oldest'), left.join(','));
}

console.log('[5] save() 给快照打 ts');
{
  check('save 里给 ts:last:* 补 ts', /if \(key\.startsWith\('ts:last:'\) && val && typeof val === 'object' && !val\.ts\) val\.ts = Date\.now\(\);/.test(html));
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
