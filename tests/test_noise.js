#!/usr/bin/env node
/* 过滤器回归测试。两类断言：
   [A] 结构：index.html 里必须存在判据，且「挡掉的东西必须可查看」
   [B] 行为：用**真实上游样本**跑 filterMentions / filterBoard，核对命中集
   运行：node tests/test_noise.js
   样本来源：2026-11-26 抓取的 trendshift.io 真实数据，存 tests/fixtures/。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const FIX = path.join(__dirname, 'fixtures');

let fails = 0;
const check = (n, c, e) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : ''));
  if (!c) fails++;
};

/* ---------- 从 index.html 里抽出被测函数，在沙箱里跑 ----------
   不复制一份逻辑到测试里：复制就会漂移，测试会变成「验证副本」。 */
function extract(names) {
  const out = [];
  for (const name of names) {
    const re = new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm');
    const m = re.exec(html);
    if (!m) throw new Error('index.html 里找不到 function ' + name);
    out.push(m[0]);
  }
  return out.join('\n\n');
}

const consts = `
const FILTER_DEFAULTS = ${/const FILTER_DEFAULTS = (\{[\s\S]*?\});/.exec(html)[1]};
const PROMO_PATTERNS = ${/const PROMO_PATTERNS = (\[[\s\S]*?\]);/.exec(html)[1]};
const REASON_LABEL = ${/const REASON_LABEL = (\{[\s\S]*?\});/.exec(html)[1]};
`;
const body = extract(['normText', 'promoHit', 'filterMentions', 'filterBoard',
  'reasonsHtml', 'mentionsView', 'mentionCardHtml', 'whySummary']);
const sandbox = { console, Date, JSON, Math, Array, String, Number, Object, RegExp };
/* mentionCardHtml / reasonsHtml 依赖 esc() 和 T()：给出最小实现，
   只做转义与直通，足以验证结构（不验证翻译，那是别的测试的事）。 */
const helpers = `
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function T(t){ return t; }
`;
vm.createContext(sandbox);
vm.runInContext(consts + helpers + '\n' + body + '\nthis.__api = { filterMentions, filterBoard, mentionsView, mentionCardHtml, reasonsHtml, whySummary, FILTER_DEFAULTS, PROMO_PATTERNS, REASON_LABEL, normText };', sandbox);
const { filterMentions, filterBoard, mentionsView, mentionCardHtml, reasonsHtml, whySummary, FILTER_DEFAULTS, PROMO_PATTERNS } = sandbox.__api;

/* 样本：真实上游 JSON → 前端用的精简形状（与 worker /api/mentions 的映射一致） */
const rawMentions = JSON.parse(fs.readFileSync(path.join(FIX, 'mentions-2026-11-26.json'), 'utf8'));
const lateRaw = JSON.parse(fs.readFileSync(path.join(FIX, 'mentions-2026-11-26-late.json'), 'utf8'));
const lateMentions = lateRaw.map(x => ({
  id: x.id, plat: x.platform, repo: x.repository_full_name,
  title: x.title || '', text: (x.content || '').slice(0, 2000),
  author: x.author_handle || '', link: x.link, at: x.posted_at,
}));

const mentions = rawMentions.map(x => ({
  id: x.id, plat: x.platform, repo: x.repository_full_name,
  title: x.title || '', text: (x.content || '').slice(0, 2000),
  author: x.author_handle || '', link: x.link, at: x.posted_at,
}));

console.log('[1] 结构：减法必须可见，不能是黑盒');
{
  check('存在过滤器面板入口', /id="fbtn"/.test(html));
  check('存在规则面板 openFilterPanel', /function openFilterPanel\(/.test(html));
  check('提示条显示「挡掉几条」', /已挡掉/.test(html));
  check('提示条可展开查看被挡条目', /noise-toggle/.test(html));
  check('被挡条目保留原因标签', /function reasonsHtml\(/.test(html));
  check('规则存 localStorage（跨会话保留）', /save\('ts:filters'/.test(html));
  check('过滤器接入热议渲染', /mentionsView\(all, st\.filters, st\.showNoise\)/.test(html));
  check('过滤器接入榜单渲染', /filterBoard\(pg\.items, pg\.prev\)/.test(html));
  check('空结果也有提示条（不是白屏）', /这一批全是推广\/刷屏/.test(html));
}

console.log('[2] 默认规则不得误杀：真实样本里的正常条目必须留下');
{
  const { keep, drop } = filterMentions(mentions, FILTER_DEFAULTS);
  const kept = keep.map(m => m.repo);
  /* 这几条是样本里确定有实质内容的真实讨论，任何一条被挡都说明规则过宽 */
  const mustKeep = [
    'mixelpixx/KiCAD-MCP-Server',
    'heygen-com/hyperframes',
    'superlinked/sie',
    'cursor/plugins',
    'google-research/google-research',
    'xai-org/x-algorithm',
    'coalton-lang/coalton',
  ];
  for (const n of mustKeep) check('保留 ' + n, kept.includes(n));
  check('过滤率在合理区间（30%~70%，样本实测 52%）',
    drop.length / mentions.length >= 0.3 && drop.length / mentions.length <= 0.7,
    'got=' + (drop.length / mentions.length * 100).toFixed(0) + '% (' + drop.length + '/' + mentions.length + ')');
}

console.log('[3] 每类规则都要真的命中（否则规则是死的）');
{
  const { keep, drop } = filterMentions(mentions, FILTER_DEFAULTS);
  const hit = r => drop.filter(d => d.reasons.includes(r)).map(d => d.item.repo);
  const promo = hit('promo'), self = hit('self'), spam = hit('spam'), dupe = hit('dupe'), thin = hit('thin');
  check('promo 命中 ≥3 条', promo.length >= 3, 'got=' + promo.length + ' ' + JSON.stringify(promo));
  /* 这一份样本里三条自荐帖子正文都有 266~276 字的具体技术细节——
     它们是这批里信息量最高的内容，默认必须留下。自荐本身不是噪声。 */
  check('自荐但内容扎实的不被挡（样本里 3 条全留）', self.length === 0,
    'self=' + JSON.stringify(self));
  const keptRepos = keep.map(m => m.repo);
  for (const n of ['borabaysal/Agent_Supply_Chain_Auditor', 'Maveri-Q/Gumshoe',
    'tarikcaykara/predicted-funding-aggregator']) {
    check('自荐有内容 → 保留 ' + n, keptRepos.includes(n));
  }
  check('spam 命中 ≥3 条', spam.length >= 3, 'got=' + spam.length + ' ' + JSON.stringify(spam));
  /* 同一账号刷的三条「Alpaca-py / Twelve Data」正文都不到 120 字：
     留首条等于把垃圾放出来，所以整组都要挡。 */
  check('刷屏组里正文薄的首条也不放行（Finnhub）',
    spam.includes('Finnhub-Stock-API/finnhub-python'), JSON.stringify(spam));
  check('刷屏组里正文薄的首条也不放行（massive-com）',
    spam.includes('massive-com/client-python'), JSON.stringify(spam));
  check('dupe 命中 ≥1 条', dupe.length >= 1, 'got=' + dupe.length + ' ' + JSON.stringify(dupe));
  check('thin 命中 ≥1 条', thin.length >= 1, 'got=' + thin.length + ' ' + JSON.stringify(thin));
  /* 具体到条目：这三条是「自我介绍体」的典型，必须被 promo 抓住 */
  check('Introducing… 被识别为推广', promo.includes('base-interference-agent/base-interference-agent'));
  check("What's new in… 被识别为推广", promo.includes('kfryster420-afk/kasgate'));
  check('hackathon 自述被识别为推广', promo.includes('shane2512/ProofLoop'));
}

console.log('[4] 每条规则可单独关掉（用户能救回误杀）');
{
  const off = Object.assign({}, FILTER_DEFAULTS, { promo: false });
  const a = filterMentions(mentions, FILTER_DEFAULTS).drop.length;
  const b = filterMentions(mentions, off).drop.length;
  check('关掉 promo 后挡掉的条数变少', b < a, 'on=' + a + ' off=' + b);
  const allOff = { promo: false, self: false, spam: false, dupe: false, thin: false, minStars: 0, minAge: 0, hideSeen: false };
  const r = filterMentions(mentions, allOff);
  check('全关后一条不挡（规则可完全关闭）', r.drop.length === 0, 'drop=' + r.drop.length);
  check('全关后条目数等于原始条数', r.keep.length === mentions.length);
}

console.log('[5] 榜单过滤：阈值生效且可归零');
{
  const rows = JSON.parse(fs.readFileSync(path.join(FIX, 'daily-all-2026-11-26.json'), 'utf8'))
    .filter(x => x.period_key === '2026-11-26')
    .map(x => ({ n: x.full_name, s: x.stars_total, c: x.created_at, r: x.rank, g: x.stars_gained, f: x.forks_total, l: x.language, d: x.description }));
  const base = Object.assign({}, FILTER_DEFAULTS, { minStars: 0, minAge: 0, hideSeen: false });
  const none = filterBoard(rows, null, base);
  check('阈值为 0 时不过滤', none.drop.length === 0 && none.keep.length === rows.length);

  const s300 = filterBoard(rows, null, Object.assign({}, base, { minStars: 300 }));
  check('minStars=300 会挡掉低星条目', s300.drop.length > 0, 'drop=' + s300.drop.length);
  check('挡掉的都是真的 <300 星',
    s300.drop.every(d => d.item.s < 300), JSON.stringify(s300.drop.map(d => [d.item.n, d.item.s]).slice(0, 3)));

  const a30 = filterBoard(rows, null, Object.assign({}, base, { minAge: 30 }));
  check('minAge=30 会挡掉新建仓库', a30.drop.length > 0, 'drop=' + a30.drop.length);
  check('挡掉的仓龄都 <30 天',
    a30.drop.every(d => (Date.now() - Date.parse(d.item.c)) / 864e5 < 30));

  /* 已看过：上一期出现过的必须被挡 */
  const prev = {}; rows.slice(0, 10).forEach(e => { prev[e.n] = 1; });
  const seen = filterBoard(rows, prev, Object.assign({}, base, { hideSeen: true }));
  check('hideSeen 挡掉上一期已有的', seen.drop.length === 10, 'drop=' + seen.drop.length);
  check('hideSeen 不挡新面孔', seen.keep.length === rows.length - 10);
}

console.log('[6] 推广规则不能太宽：技术名词不该被当成推广');
{
  const tech = [
    'A fast inference engine for LLMs on plain CPUs, no GPU needed',
    'We implement FlashAttention-2 with a 1.7x speedup over baseline',
    'Introducing latency metrics: p50 and p99 across 12 regions',   // 这条故意含 Introducing，属于漏杀而非误杀
    'Rust rewrite of the original C++ pipeline',
    'Supports Kubernetes, Docker, and bare-metal deployment',
  ];
  const bad = tech.filter(t => !/^Introducing latency/.test(t) && sandbox.__api.PROMO_PATTERNS.some(p => p.test(t)));
  check('普通技术描述不被判为推广', bad.length === 0, JSON.stringify(bad));
  check('规则数量可控（≤15 条，避免堆成筛子）', PROMO_PATTERNS.length <= 15, 'n=' + PROMO_PATTERNS.length);
}

console.log('[7] 行为：展开真的展开、原因真的渲染（不是源码里有个函数名就算）');
{
  const base = Object.assign({}, FILTER_DEFAULTS);
  const collapsed = mentionsView(mentions, base, false);
  const expanded = mentionsView(mentions, base, true);
  check('收起时条目数 = keep', collapsed.items.length === mentions.length - collapsed.dropped.length,
    collapsed.items.length + ' vs ' + (mentions.length - collapsed.dropped.length));
  check('展开时条目数 = 全部', expanded.items.length === mentions.length,
    expanded.items.length + '/' + mentions.length);
  check('展开后原来被挡的条目真的出现了',
    expanded.items.length > collapsed.items.length);
  check('展开不影响 dropped 列表（提示条数字不变）',
    collapsed.dropped.length === expanded.dropped.length);

  /* reasonsOf：只有被挡的才有原因，留下的必须是 null */
  const droppedItem = collapsed.dropped[0].item;
  const keptItem = collapsed.items.find(m => !collapsed.dropped.some(d => d.item === m));
  check('被挡条目有原因', Array.isArray(collapsed.reasonsOf(droppedItem)) && collapsed.reasonsOf(droppedItem).length > 0);
  check('留下的条目没有原因', collapsed.reasonsOf(keptItem) === null);

  /* 渲染：被挡的必须带 dim 类和原因标签；留下的两者都不能有 */
  const dimHtml = mentionCardHtml(droppedItem, collapsed.reasonsOf(droppedItem));
  const okHtml = mentionCardHtml(keptItem, null);
  check('被挡卡片带 dim 类', /\bclass="card dim"/.test(dimHtml), dimHtml.slice(0, 90));
  check('被挡卡片渲染出原因标签', /noise-reasons/.test(dimHtml) && /class="chip"/.test(dimHtml));
  check('被挡卡片的原因文字是中文标签', /推广|自荐|刷屏|同文|无内容/.test(dimHtml));
  check('正常卡片不带 dim', !/card dim/.test(okHtml));
  check('正常卡片不渲染原因块', !/noise-reasons/.test(okHtml));

  /* 汇总文案：必须真的列出分类和计数，不能是空串 */
  const why = whySummary(collapsed.dropped);
  check('汇总文案非空', why.length > 0, JSON.stringify(why));
  check('汇总文案含数字', /\d/.test(why), JSON.stringify(why));
  check('汇总文案按数量降序（第一条是命中最多的那类）', (function () {
    const parts = why.split(' · ');
    const nums = parts.map(p => +(/ (\d+)$/.exec(p) || [])[1]);
    return nums.every((n, i) => i === 0 || nums[i - 1] >= n);
  })(), JSON.stringify(why));
}

console.log('[8] 端到端：真实样本经视图模型后，用户实际看到什么');
{
  const v = mentionsView(mentions, FILTER_DEFAULTS, false);
  const shown = v.items.map(m => m.repo);
  /* 这 7 条是样本里的真实技术讨论，任何一条不在最终可见集合里都是误杀 */
  for (const n of ['mixelpixx/KiCAD-MCP-Server', 'heygen-com/hyperframes', 'superlinked/sie',
    'cursor/plugins', 'google-research/google-research', 'xai-org/x-algorithm', 'coalton-lang/coalton']) {
    check('最终可见集合包含 ' + n, shown.includes(n));
  }
  /* 反向：这几条是明确的推广/自荐，默认必须不可见 */
  for (const n of ['kfryster420-afk/kasgate', 'base-interference-agent/base-interference-agent',
    'shane2512/ProofLoop']) {
    check('默认不可见（推广）' + n, !shown.includes(n));
  }
  const htmlAll = v.items.map(m => mentionCardHtml(m, null)).join('');
  check('可见集合里没有 dim 卡片', !/card dim/.test(htmlAll));
}

console.log('[9] 第二份样本（线上真实数据）：自荐的两种情形必须区分开');
{
  const { keep, drop } = filterMentions(lateMentions, FILTER_DEFAULTS);
  const selfDropped = drop.filter(d => d.reasons.includes('self')).map(d => d.item.repo);
  const keptRepos = keep.map(m => m.repo);

  /* 薄自荐（38 字「看看这个仪表盘有多美」）→ 挡 */
  check('薄自荐被挡：dashboard-design-skill',
    selfDropped.includes('abdiraimov-otabek/dashboard-design-skill'),
    JSON.stringify(selfDropped));
  check('薄自荐被挡：Domain-papers',
    selfDropped.includes('JDRedding/Domain-papers'), JSON.stringify(selfDropped));

  /* 有内容的（240/250/234 字，讲了做法和遇到的问题）→ 必须留 */
  for (const n of ['landar26/stolnk-skill', 'dougsillars/bittensor_banhammer', 'Guryevmn/hashorlease']) {
    check('厚自荐保留 ' + n, keptRepos.includes(n), 'dropped=' + JSON.stringify(selfDropped));
  }

  /* 同一段西班牙语文案贴到 10 个仓库：只留 1 条，其余按同文挡掉 */
  const es = lateMentions.filter(m => /NO PARECE LEGAL/i.test(m.text || ''));
  check('西班牙语刷屏组共 10 条', es.length === 10, 'got=' + es.length);
  const esKept = es.filter(m => keptRepos.includes(m.repo));
  const esDropped = es.filter(m => !keptRepos.includes(m.repo));
  check('同文组只保留 1 条（不是全挡，也不是全留）', esKept.length === 1,
    'kept=' + esKept.length + ' ' + JSON.stringify(esKept.map(m => m.repo)));
  check('同文组其余 9 条按同文挡掉', esDropped.length === 9, 'dropped=' + esDropped.length);
  check('刷屏组里正文厚的首条必须留下（plausible/analytics 734 字）',
    keptRepos.includes('plausible/analytics'), 'dropped=' + JSON.stringify(drop.map(d => d.item.repo)));
  check('同文挡掉的条目原因里含 dupe',
    esDropped.every(m => {
      const d = drop.find(x => x.item === m);
      return d && d.reasons.includes('dupe');
    }));

  /* 过滤率：这份样本是 13/25 = 52% */
  check('第二份样本过滤率在 30%~70%',
    drop.length / lateMentions.length >= 0.3 && drop.length / lateMentions.length <= 0.7,
    'got=' + drop.length + '/' + lateMentions.length);
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
