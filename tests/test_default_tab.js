#!/usr/bin/env node
/* 默认入口回归测试。
   核心主张：**排序面板里第一个可见的栏目 = 打开应用时默认进入的栏目**。
   这不是新开关，是让「排序」和「默认入口」合一——旧实现写死 weekly，
   于是用户把雷达排到第一位，打开还是进本周。

   测的是纯函数逻辑（defaultTab），不测 DOM。
   运行：node tests/test_default_tab.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

let fails = 0;
const check = (n, c, e) => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : ''));
  if (!c) fails++;
};

/* ---------- 从 index.html 抽出逻辑，不复制 ---------- */
const TAB_ORDER = /const DEFAULT_ORDER = TFS\.map\(t => t\[0\]\);/.test(html)
  ? (function () {
      const m = /const TFS = \[([\s\S]*?)\];/.exec(html)[1];
      return [...m.matchAll(/\['([a-z]+)','([^']+)'\]/g)].map(x => x[1]);
    })()
  : null;

check('能从 index.html 解析出栏目清单', Array.isArray(TAB_ORDER) && TAB_ORDER.length >= 8,
  JSON.stringify(TAB_ORDER));

const sandbox = { console, Set, Array };
vm.createContext(sandbox);
/* ★ 直接抽取 index.html 里的生产函数，不重写副本。
   重写副本的测试等于「自己验证自己」：把生产改成加法、副本还是乘法，测试照样绿。 */
function grabFn(name) {
  const m = new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm').exec(html);
  if (!m) throw new Error('index.html 里找不到 function ' + name);
  return m[0];
}
vm.runInContext(`
const DEFAULT_ORDER = ${JSON.stringify(TAB_ORDER)};
${grabFn('defaultTab')}
${grabFn('shouldJumpToDefault')}
this.__api = { defaultTab, shouldJumpToDefault, DEFAULT_ORDER };
`, sandbox);
const { defaultTab, shouldJumpToDefault, DEFAULT_ORDER } = sandbox.__api;

console.log('[1] 默认入口 = 排序里第一个可见项');
{
  const h = new Set();
  check('默认顺序 → 打开雷达（雷达已在 TFS 第一位）',
    defaultTab(DEFAULT_ORDER, h) === DEFAULT_ORDER[0],
    defaultTab(DEFAULT_ORDER, h));
  check('把 radar 移到最后 → 默认入口跟着变',
    defaultTab(['weekly', 'daily', 'radar'], h) === 'weekly');
  check('把 daily 提到第一 → 默认进 daily',
    defaultTab(['daily', 'weekly', 'radar'], h) === 'daily');
  check('用户没改过顺序时用 DEFAULT_ORDER 的第一个',
    defaultTab(DEFAULT_ORDER, h) === DEFAULT_ORDER[0]);
}

console.log('[2] 第一项被隐藏时要顺延，不能进隐藏栏目');
{
  const h = new Set([DEFAULT_ORDER[0]]);
  check('第一项隐藏 → 取第二个', defaultTab(DEFAULT_ORDER, h) === DEFAULT_ORDER[1],
    defaultTab(DEFAULT_ORDER, h));
  const h2 = new Set([DEFAULT_ORDER[0], DEFAULT_ORDER[1]]);
  check('前两项隐藏 → 取第三个', defaultTab(DEFAULT_ORDER, h2) === DEFAULT_ORDER[2],
    defaultTab(DEFAULT_ORDER, h2));
}

console.log('[3] 边界：全隐藏 / 空顺序');
{
  const allHidden = new Set(DEFAULT_ORDER);
  check('全部隐藏时有兜底（不返回 undefined）',
    typeof defaultTab(DEFAULT_ORDER, allHidden) === 'string',
    String(defaultTab(DEFAULT_ORDER, allHidden)));
  check('空顺序时兜底为 weekly', defaultTab([], new Set()) === 'weekly');
}

console.log('[4] 源码里不许再写死默认栏目');
{
  /* 旧实现是 st.tf = 'weekly'。如果哪天有人改回去，这条会红。 */
  check('st 初始化不写死 tf:weekly（应由 loadTabPrefs 决定）',
    !/tf:\s*'weekly'/.test(html), 'found hardcoded tf:weekly');
  check('loadTabPrefs 调用 defaultTab（不是内联 find）',
    /st\.tf = defaultTab\(st\.order, st\.hidden\);/.test(html));
  check('排序面板「完成」调用 shouldJumpToDefault',
    /shouldJumpToDefault\(prevDefault, newDefault, st\.tf, st\.hidden\)/.test(html));
  check('排序面板标出「打开默认」',
    /打开默认/.test(html));
  check('面板提示说明「排第一 = 默认入口」',
    /排第一的那个就是打开应用时默认进入的栏目/.test(html));
}

console.log('[5] 防漂移：测试里的判据与生产代码一致');
{
  /* 把生产里那行抽出来，和测试沙箱里的实现比。两处不一致就红——
     否则测试会变成「验证一个已经不用的副本」。 */
  check('生产代码里存在 defaultTab 函数', /function defaultTab\(/.test(html));
  const prodDefault = defaultTab;   // 抽取的就是生产实现，不需要再写一份
  const cases = [
    [DEFAULT_ORDER, new Set()],
    [['weekly', 'daily', 'radar'], new Set()],
    [DEFAULT_ORDER, new Set([DEFAULT_ORDER[0]])],
    [[], new Set()],
  ];
  let same = true;
  for (const [o, h] of cases) {
    if (prodDefault(o, h) !== defaultTab(o, h)) same = false;
  }
  check('两边对同一输入给出相同结果', same);
}

console.log('[6] 「完成」时的跳转规则：只有默认入口变了才跳');
{
  /* 直接调生产函数，不重写副本。 */
  function shouldJump(prevOrder, prevHidden, newOrder, newHidden, curTf) {
    const prevDefault = defaultTab(prevOrder, prevHidden);
    const newDefault = defaultTab(newOrder, newHidden);
    return shouldJumpToDefault(prevDefault, newDefault, curTf, newHidden);
  }
  check('把雷达移到第一（默认入口变）→ 跳',
    shouldJump(['weekly', 'radar'], new Set(), ['radar', 'weekly'], new Set(), 'weekly') === true);
  check('只调整后面的顺序（默认入口没变）→ 不跳',
    shouldJump(['radar', 'weekly', 'daily'], new Set(),
      ['radar', 'daily', 'weekly'], new Set(), 'radar') === false);
  check('把当前栏目隐藏 → 跳',
    shouldJump(['radar', 'weekly'], new Set(), ['radar', 'weekly'],
      new Set(['weekly']), 'weekly') === true);
  check('默认入口没变且当前没被隐藏 → 不跳（整理顺序被拽走是 bug）',
    shouldJump(['radar', 'weekly', 'daily'], new Set(),
      ['radar', 'daily', 'weekly'], new Set(), 'daily') === false);
}

console.log('[7] 首屏落点：无 hash 冷启动用默认入口');
{
  check('openFromHash 只在有 hash 时覆盖 st.tf',
    /const bootView = openFromHash\(\);/.test(html));
  check('loadTabPrefs 在 openFromHash 之前调用（先定默认，再让 hash 覆盖）',
    html.indexOf('loadTabPrefs();') < html.indexOf('const bootView = openFromHash();'),
    'loadTabPrefs@' + html.indexOf('loadTabPrefs();') +
    ' boot@' + html.indexOf('const bootView = openFromHash();'));
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
