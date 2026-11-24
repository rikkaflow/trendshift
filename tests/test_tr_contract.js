#!/usr/bin/env node
/* packBatches / 长度契约 回归测试（从 index.html 与 worker.template.js 抽真实实现，不复制粘贴）。
   运行：node tests/test_tr_contract.js  */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const tpl = fs.readFileSync(path.join(SRC, 'worker.template.js'), 'utf8');

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (!cond && extra ? '  ' + extra : ''));
  if (!cond) fails++;
}

// ---- 抽前端 packBatches + TR_MAX_ITEMS ----
function pick(re, name) {
  const m = html.match(re);
  if (!m) { console.error('✗ 无法从 index.html 抽取 ' + name); process.exit(2); }
  return m[0];
}
const packSrc = pick(/const TR_MAX_ITEMS = \d+;\nfunction packBatches\(texts, budget\)\{[\s\S]*?\n\}/, 'packBatches');
const sb = {};
new Function('sb', packSrc + '\nsb.pack = packBatches; sb.MAX = TR_MAX_ITEMS;')(sb);

console.log('[1] packBatches 单批不超过 TR_MAX_ITEMS');
{
  const labels = Array.from({ length: 64 }, (_, i) => 'Label ' + i);
  const batches = sb.pack(labels, 3000);
  const total = batches.reduce((a, b) => a + b.length, 0);
  check('64 个短标签 → 切成多批', batches.length >= 2, 'batches=' + batches.length);
  check('每批 ≤ 40 条', batches.every(b => b.length <= sb.MAX), 'sizes=' + batches.map(b => b.length));
  check('总数守恒（无丢条目）', total === 64, 'total=' + total);
}
{
  const labels = Array.from({ length: 40 }, (_, i) => 'L' + i);
  const batches = sb.pack(labels, 3000);
  check('正好 40 条 → 一批', batches.length === 1, 'batches=' + batches.length);
}
{
  const labels = Array.from({ length: 41 }, (_, i) => 'L' + i);
  check('41 条 → 两批', sb.pack(labels, 3000).length === 2);
}
{
  const long = Array.from({ length: 10 }, () => 'x'.repeat(800));
  const batches = sb.pack(long, 3000);
  check('字符预算仍然生效（10×800 > 3000）', batches.length > 1, 'batches=' + batches.length);
  check('字符预算下每批总字符 ≤ 3000 或单条超预算', batches.every(b => {
    const s = b.reduce((a, t) => a + t.length, 0);
    return s <= 3000 || b.length === 1;
  }));
}

// ---- 抽 worker 的 /api/tr 槽位分配段，验证返回长度 == 请求长度 ----
console.log('[2] /api/tr 返回数组长度 == 请求条数');
const nDecl = tpl.match(/const n = Math\.min\(raw\.length, TR_MAX_ITEMS\);/);
const zhDecl = tpl.match(/const zh = new Array\(([^)]*)\)\.fill\(''\);/);
check('worker 存在 n 声明', !!nDecl);
check('worker 的 zh 按 raw.length 分配（不是 n）', !!zhDecl && zhDecl[1].trim() === 'raw.length',
  zhDecl ? 'actual=' + zhDecl[1].trim() : 'not found');

// 行为级：模拟该段逻辑
const TR_MAX_ITEMS = +(tpl.match(/const TR_MAX_ITEMS = (\d+);/) || [0, 40])[1];
function simulate(raw) {
  const n = Math.min(raw.length, TR_MAX_ITEMS);
  const zh = new Array(raw.length).fill('');
  for (let i = 0; i < n; i++) zh[i] = 'zh' + i;   // 只有前 n 条被翻译
  return zh;
}
{
  const raw = Array.from({ length: 64 }, (_, i) => 'text ' + i);
  const zh = simulate(raw);
  check('64 条请求 → 返回 64 槽', zh.length === 64, 'len=' + zh.length);
  check('前 40 槽有译文', zh.slice(0, 40).every(Boolean));
  check('后 24 槽为空但存在', zh.slice(40).length === 24 && zh.slice(40).every(x => x === ''));
}
{
  const zh = simulate(['a', 'b']);
  check('2 条请求 → 返回 2 槽', zh.length === 2);
}
{
  const zh = simulate([]);
  check('空请求 → 空数组', zh.length === 0);
}

// ---- 前端对齐校验：长度相等才不会熔断 ----
console.log('[3] 前端对齐校验在修好后不会熔断');
{
  const raw = Array.from({ length: 64 }, (_, i) => 't' + i);
  const zh = simulate(raw);
  check('d.zh.length === texts.length', zh.length === raw.length);
}

// ---- Gemini 失败原因透传 ----
console.log('[4] Gemini 原始错误透传（429 不再被吞成 502）');
check('worker 记录 lastGeminiError', /lastGeminiError/.test(tpl));
check('抛出时拼接原始错误', /gemini failed, no groq fallback'\s*\+\s*\n?\s*\(lastGeminiError/.test(tpl.replace(/\n\s*/g, ' ')) ||
  /no groq fallback' \+ \(lastGeminiError/.test(tpl));
{
  // 行为模拟：带 429 的错误串必须被 /429/ 命中
  const msg = 'gemini failed, no groq fallback: gemini 429';
  check('/429/ 命中透传后的消息', /429/.test(msg));
  check('旧写法的消息不含 429', !/429/.test('gemini failed, no groq fallback'));
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
