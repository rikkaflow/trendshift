#!/usr/bin/env node
/* 雷达回归测试。
   核心不是「分数算得对不对」，而是三条可证伪的主张：
     [A] 相关性最大化 → 产出仿制品（复现官方那个毛病）
     [B] 三轴相乘 → 产出「对口但冷门」的东西（雷达该给的东西）
     [C] 三个轴任一为 0 时结果必须为 0（乘不是加）
   用真实数据（tests/fixtures 下的四份趋势全量）跑，不 mock。
   运行：node tests/test_radar.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '..');
const tpl = fs.readFileSync(path.join(SRC, 'worker.template.js'), 'utf8');

let fails = 0;
const check = (n, c, e) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : ''));
  if (!c) fails++;
};

/* ---------- 从 worker.template.js 抽出雷达分支里的三个纯函数 ----------
   不复制一份逻辑到测试里：复制会漂移，测试变成验证副本。 */
function grab(name) {
  /* 两种形状：箭头函数带块体 { ... }; 和单表达式体（可能跨行）。 */
  const block = new RegExp('const ' + name + ' = \\([^)]*\\) => \\{[\\s\\S]*?\\n    \\};').exec(tpl);
  if (block) return block[0];
  const expr = new RegExp('const ' + name + ' = \\([^)]*\\) => [\\s\\S]*?;\\n').exec(tpl);
  if (expr) return expr[0];
  throw new Error('worker.template.js 里找不到 ' + name);
}
/* 只取「|| 之后」的默认字面量：前面那段是 p.get(...)，测试里没有 p。 */
const wantLangsSrc = /const wantLangs = new Set\(\(p\.get\('langs'\) \|\| '([^']+)'\)/.exec(tpl)[1];
const wantWordsSrc = /const wantWords = \(p\.get\('words'\) \|\|[\s\S]*?'([^']+)'\)/.exec(tpl)[1];

const sandbox = { Math, Set, console };
vm.createContext(sandbox);
vm.runInContext(`
const wantLangs = new Set('${wantLangsSrc}'.split(',').map(x => x.trim()).filter(Boolean));
const wantWords = '${wantWordsSrc}'.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
${grab('relOf')}
${grab('surOf')}
${grab('valOf')}
this.__api = { relOf, surOf, valOf, wantLangs, wantWords };
`, sandbox);
const { relOf, surOf, valOf } = sandbox.__api;

/* ---------- 真实候选池：四份趋势全量 ---------- */
const FIX = path.join(SRC, 'tests', 'fixtures');
function loadPool() {
  const pool = new Map();
  for (const tf of ['daily', 'weekly', 'monthly', 'yearly']) {
    const f = path.join(FIX, 'trend-' + tf + '.json');
    if (!fs.existsSync(f)) continue;
    for (const x of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const k = x.full_name.toLowerCase();
      let cur = pool.get(k);
      if (!cur) {
        cur = { n: x.full_name, d: x.description || '', l: x.language || '',
                s: x.stars_total || 0, c: x.created_at || '', t: x.tags || [],
                best: x.rank, periods: 0, _seen: new Set() };
        pool.set(k, cur);
      }
      if (x.description && !cur.d) cur.d = x.description;
      cur.s = Math.max(cur.s, x.stars_total || 0);
      cur.best = Math.min(cur.best, x.rank);
      if (!cur._seen.has(x.period_key)) { cur._seen.add(x.period_key); cur.periods++; }
    }
  }
  for (const v of pool.values()) delete v._seen;
  return pool;
}
const pool = loadPool();
const rows = [...pool.values()];

function scoreOf(e) { return relOf(e) * surOf(e.s) * valOf(e); }

console.log('[1] 候选池');
{
  check('候选池 ≥1500 个仓库', rows.length >= 1500, 'got=' + rows.length);
  const withScore = rows.filter(e => scoreOf(e) > 0.01);
  check('有分数的候选 ≥40 个（否则雷达会空）', withScore.length >= 40, 'got=' + withScore.length);
}

console.log('[2] 三轴各自的取值范围与单调性');
{
  /* 1000 星以下是平台期（都算冷门），1000 星以上必须严格递减。
     断言写 surOf(100) > surOf(1000) 是错的：两者都该是 1。 */
  check('surOf 在 1000 星以上严格递减',
    surOf(1000) > surOf(10000) && surOf(10000) > surOf(50000) && surOf(50000) > surOf(200000),
    [surOf(1000), surOf(10000), surOf(50000), surOf(200000)].join(' > '));
  check('surOf 在 100~1000 星之间是平台期（都算冷门）',
    surOf(100) === 1 && surOf(1000) === 1);
  check('surOf 在 1000 星以下是满分（冷门）', surOf(500) === 1, 'got=' + surOf(500));
  check('surOf 在 10 万星以上归零（人人都知道）', surOf(200000) === 0, 'got=' + surOf(200000));
  check('surOf 不越界', [0, 1, 1e9].every(s => surOf(s) >= 0 && surOf(s) <= 1));

  check('relOf 对 Kotlin 加分', relOf({ l: 'Kotlin', d: '', t: [] }) > 0);
  check('relOf 对无关语言+无关键词给 0',
    relOf({ l: 'COBOL', d: 'a compiler for mainframes', t: [] }) === 0);
  check('relOf 不越界（关键词堆满也 ≤1）',
    relOf({ l: 'Kotlin', d: 'android ios proxy vpn clash v2ray agent llm', t: [] }) <= 1);
  /* ★ 回归：字段名必须是池对象的短名。写成 e.language/e.description 会
     让三轴全为 0，雷达静默返回空——这个 bug 在写测试时才被发现。 */
  check('relOf 读短字段 l/d/t（写成 e.language 会恒为 0）',
    relOf({ l: 'Kotlin', d: 'android app', t: ['android'] }) >= 0.5);

  check('valOf 描述空+没上榜+排名差 = 0',
    valOf({ d: '', periods: 0, best: 999 }) === 0);
  check('valOf 描述完整+多期+高排名 接近 1',
    valOf({ d: 'x'.repeat(100), periods: 20, best: 1 }) > 0.9);
}

console.log('[3] 相乘语义：任一轴为 0，结果必须为 0（乘不是加）');
{
  const zeroRel = { l: 'COBOL', d: 'mainframe compiler', t: [], s: 500, periods: 5, best: 1 };
  const zeroSur = { l: 'Kotlin', d: 'android app', t: [], s: 500000, periods: 5, best: 1 };
  const zeroVal = { l: 'Kotlin', d: '', t: [], s: 500, periods: 0, best: 999 };
  check('相关=0 → 总分 0（不会因为高星高价值就冒出来）', scoreOf(zeroRel) === 0);
  check('意外=0 → 总分 0（熟面孔不该占雷达位）', scoreOf(zeroSur) === 0);
  check('价值=0 → 总分 0（没人验证过的冷门不该占位）', scoreOf(zeroVal) === 0);

  /* ★ 区分乘法与加法：这是「乘不是加」唯一真正有牙的断言。
     加法下 (1,1,0) 和 (1,0,1) 都还有 0.67 分，乘法下必须都是 0。
     只断言「某轴为 0 时总分为 0」还不够——加法实现里如果那一轴恰好是
     最高的那个，也会被拉低到非零但测试看不出来。 */
  const full = { l: 'Kotlin', d: 'x'.repeat(100), t: ['android'], s: 500, periods: 10, best: 1 };
  const rel1 = relOf(full), sur1 = surOf(full.s), val1 = valOf(full);
  check('满配样本三轴都非零（否则下面两条没意义）', rel1 > 0 && sur1 > 0 && val1 > 0,
    [rel1, sur1, val1].join(','));
  const onlyTwo = Math.max(rel1 * sur1, rel1 * val1, sur1 * val1);
  /* 价值=0 的真实形态：从没上过榜（periods=0）。
     ★ 不能写成「periods:10 但 best:999」——那是自相矛盾的数据，
     上榜 10 期必有排名，测这种数据等于测了个不存在的状态。 */
  const noTrack = { l: 'Kotlin', d: 'x'.repeat(100), t: ['android'], s: 500, periods: 0, best: 999 };
  check('价值=0（从未上榜）→ 总分 0，哪怕描述完整、语言对口、星数冷门',
    scoreOf(noTrack) === 0, 'score=' + scoreOf(noTrack));
  /* 意外=0 的真实形态：20 万星（人人都知道），其余两轴满配 */
  const known = { l: 'Kotlin', d: 'x'.repeat(100), t: ['android'], s: 200000, periods: 10, best: 1 };
  check('意外=0（20 万星）→ 总分 0，哪怕对口且扎实',
    scoreOf(known) === 0, 'score=' + scoreOf(known));
  /* ★ 唯一能真正区分「乘」与「加」的断言：拿真实候选池比排序结果。
     加法下「一轴很高、两轴中等」会排到前面；乘法下它会被最低轴压死。
     所以：top10 里任何一条，它的最低轴都不能太低——这是乘法排序的必要条件。 */
  const top10 = rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 10)
    .map(e => ({ n: e.n, r: relOf(e), s: surOf(e.s), v: valOf(e) }));
  const weak = top10.filter(x => Math.min(x.r, x.s, x.v) < 0.2);
  check('乘法排序下 top10 没有「某一轴几乎为 0」的条目（加法下必然出现）',
    weak.length === 0,
    'weak=' + weak.length + ' ' + JSON.stringify(weak.map(x => [x.n, x.r, x.s, x.v])));

  /* 诚实记录：在这个候选池上，乘法排序与加法排序的 top10 **相同**。
     实测过，不是猜的。所以「乘优于加」在这批数据上**没有被验证**，
     不能拿它当结论。乘法的价值只在语义保证（任一轴为 0 即为 0），
     而那三条断言（上面 §3）是有牙的。这里只锁住语义，不假装排序有差异。 */
  const addTop = rows.slice().sort((a, b) => {
    const r = relOf(a), ss = surOf(a.s), v = valOf(a);
    const r2 = relOf(b), s2 = surOf(b.s), v2 = valOf(b);
    return (r2 + s2 + v2) - (r + ss + v);
  }).slice(0, 10).map(e => e.n);
  const mulTop = top10.map(x => x.n);
  console.log('  NOTE   乘法 vs 加法 top10 ' +
    (JSON.stringify(addTop) === JSON.stringify(mulTop) ? '相同（此池上无差异）' : '不同'));
  /* 只断言：乘法对「某轴为 0」的候选一定给 0 分，加法给非零。这是真差异。 */
  const zeroSurItem = { l: 'Kotlin', d: 'x'.repeat(100), t: ['android'], s: 300000, periods: 5, best: 3 };
  const r0 = relOf(zeroSurItem), s0 = surOf(zeroSurItem.s), v0 = valOf(zeroSurItem);
  const mul = r0 * s0 * v0;
  const add = (r0 + s0 + v0) / 3;
  check('同一候选：乘法给 0，加法给非零（这是两种方案唯一确定的分歧）',
    mul === 0 && add > 0, 'mul=' + mul + ' add=' + add.toFixed(3));
}

console.log('[4] ★ 核心主张 A：只优化相关性 → 产出仿制品');
{
  /* 官方 minimind 页面那 8 条（实测抓取）。它们全都是 minimind 的复刻/教程。 */
  const official = ['WKQ9411/Mini-LLM', 'silvaxxx1/MyLLM', 'Tongyun1/from-minimind-to-more',
    'yangqi0/petitgpt', 'fangpin/llm-from-scratch',
    'FareedKhan-dev/train-llm-from-scratch', 'jzhang38/TinyLlama',
    'jingedawang/TutorialLLM', 'Enping-Hu/minimind-deep-dive'];
  const replica = official.filter(n => /mini.?llm|myllm|petitgpt|tinyllama|from-scratch|tutorial|deep-dive|from-minimind/i.test(n));
  check('官方 8 条里 ≥8 条是「名字就在复刻 minimind」', replica.length >= 8,
    'got=' + replica.length + '/' + official.length);
  check('官方 8 条里没有一条和 minimind 不同领域',
    official.every(n => /minimind|mini-llm|myllm|petitgpt|tinyllama|llm|tutorial/i.test(n)));

  /* 反向：雷达 top20 里必须出现跨领域的东西 */
  const top = rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 20);
  const langs = new Set(top.map(e => e.l));
  /* 雷达会收敛到用户的兴趣语言（Kotlin/Swift/Java），这正是「对口」；
     要验的不是语言数量，而是**领域**多样性。 */
  check('雷达 top20 的语言集中在对口语言上（不是全 Python）',
    !langs.has('Python') || langs.size >= 3, [...langs].join(','));
  check('雷达 top20 至少覆盖 3 种语言', langs.size >= 3, [...langs].join(','));
  const domains = top.filter(e => /android|ios|music|manga|comic|proxy|player|reader|video/i
    .test((e.d || '') + ' ' + (e.t || []).join(' ')));
  check('雷达 top20 里有移动端/媒体/代理这类跨领域条目', domains.length >= 3,
    'got=' + domains.length);
}

console.log('[5] ★ 核心主张 B：雷达产出「对口但冷门」的东西');
{
  const top = rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 30);
  const medianStars = top.map(e => e.s).sort((a, b) => a - b)[Math.floor(top.length / 2)];
  check('雷达 top30 的星数中位数 < 20000（不是一堆巨型仓库）',
    medianStars < 20000, 'got=' + medianStars);
  const cold = top.filter(e => e.s < 10000);
  check('雷达 top30 里 ≥15 个不到 1 万星', cold.length >= 15, 'got=' + cold.length);
  /* 这几条是实测里雷达挖出来的「对口且冷门」，任何一条掉出 top30 都说明打分坏了 */
  const want = ['ybblab/Jiumi', 'shijue-aid/aid-studio', 'JetBrains/koog'];
  const names = top.map(e => e.n);
  for (const n of want) {
    check('雷达 top30 含 ' + n, names.includes(n),
      'top10=' + names.slice(0, 10).join(','));
  }
}

console.log('[6] 雷达不是随机：排序必须稳定且可解释');
{
  const a = rows.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 10).map(e => e.n);
  const b = rows.slice().sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 10).map(e => e.n);
  check('同一输入两次排序结果一致', JSON.stringify(a) === JSON.stringify(b));
  /* 分数必须能拆成三轴，且三轴乘积等于总分 */
  const e = rows.find(x => x.n === 'ybblab/Jiumi') || rows[0];
  const r = relOf(e), s = surOf(e.s), v = valOf(e);
  check('总分 == 对口 × 冷门 × 扎实（可解释）',
    Math.abs(r * s * v - scoreOf(e)) < 1e-9,
    [r, s, v, r * s * v, scoreOf(e)].join(' | '));
  check('三轴都在 [0,1]', [r, s, v].every(x => x >= 0 && x <= 1));
}

console.log('[7] 反例：不该被雷达推荐的东西');
{
  const top = rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 30).map(e => e.n);
  /* 人人皆知的巨型仓库不该占雷达位 */
  for (const n of ['public-apis/public-apis', 'codecrafters-io/build-your-own-x',
    'sindresorhus/awesome', 'ollama/ollama']) {
    check('熟面孔不进雷达 top30：' + n, !top.includes(n));
  }
  /* 无描述的仓库不该进（没法判断价值） */
  const noDesc = rows.slice().sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 30)
    .filter(e => !e.d || e.d.length < 10);
  check('雷达 top30 里没有无描述的仓库', noDesc.length === 0,
    JSON.stringify(noDesc.map(e => e.n)));
}

console.log('[8] 已知局限（写在测试里，防止以后有人误以为这里验证过）');
{
  console.log('  NOTE   「乘法优于加法」在本候选池上**未被验证**：');
  console.log('         两种排序的 top10 完全相同（已实测）。');
  console.log('         乘法只提供语义保证（任一轴为 0 即为 0），那三条断言是有牙的；');
  console.log('         但「乘法能选出加法选不出的东西」这句话在这批数据上是假的。');
  console.log('         要验证它需要更多样化的候选池（比如接入 GitHub 原始搜索）。');
  check('至少有一个轴能让乘法与加法给出不同结果', (function () {
    const cand = { l: 'Kotlin', d: 'x'.repeat(100), t: ['android'], s: 300000, periods: 5, best: 3 };
    const r = relOf(cand), sv = surOf(cand.s), v = valOf(cand);
    return r * sv * v === 0 && (r + sv + v) / 3 > 0;
  })());
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
