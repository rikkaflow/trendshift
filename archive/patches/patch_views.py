#!/usr/bin/env python3
"""给 index.html 增加五个栏目：主题 / GitHub 热门 / 开发者 / 统计 / 主题详情。"""
import pathlib

p = pathlib.Path('/var/minis/workspace/trendshift-app/index.html')
s = p.read_text(encoding='utf-8')

# ---------- 1. 标签栏：加五个栏目 ----------
s = s.replace(
"const TFS = [['daily','今日'],['weekly','本周'],['monthly','本月'],['yearly','今年'],['mentions','热议']];",
"""const TFS = [
  ['daily','今日'],['weekly','本周'],['monthly','本月'],['yearly','今年'],
  ['mentions','热议'],['topics','主题'],['ghtrend','热门'],['devs','开发者'],['stats','统计'],
];
const BOARD = new Set(['daily','weekly','monthly','yearly']);
const FILTERED = new Set(['topics','ghtrend','devs','stats','mentions']);""")

# ---------- 2. 新增状态 ----------
s = s.replace(
"""const st = {
  tf:'daily', lang:'', sort:'rank', period:null, q:'',
  data:null, err:null, langs:null, zh:true, cur:null,
};""",
"""const st = {
  tf:'daily', lang:'', sort:'rank', period:null, q:'',
  data:null, err:null, langs:null, zh:true, cur:null,
  metric:'stars', statYear:null, statMonth:null,
};""")

# ---------- 3. render：分发到新视图 ----------
s = s.replace(
"""  if (d.mentions) {""",
"""  if (d.topics) { renderTopics(d.topics); return; }
  if (d.topic)  { renderTopic(d.topic);  return; }
  if (d.ghtrend) { renderGh(d.ghtrend);  return; }
  if (d.devs)   { renderDevs(d.devs);    return; }
  if (d.stats)  { renderStats(d.stats);  return; }

  if (d.mentions) {""")

# ---------- 4. 五个渲染函数（插到 render 之前） ----------
s = s.replace(
"""function render(){
  const d = st.data;""",
"""/* ---------- 主题 ---------- */
function renderTopics(topics){
  if (!topics || !topics.length) { $('#list').innerHTML = '<div class="empty">暂无主题</div>'; return; }
  const groups = new Map();
  for (const t of topics) {
    const ch = (t.n[0] || '#').toUpperCase();
    if (!groups.has(ch)) groups.set(ch, []);
    groups.get(ch).push(t);
  }
  const keys = [...groups.keys()].sort();
  $('#list').innerHTML = keys.map(ch =>
    '<div class="grp"><div class="grp-h">' + esc(ch) + '</div>' +
      groups.get(ch).map(t =>
        '<button class="tag" data-slug="' + esc(t.s) + '">' + esc(t.n) + '</button>'
      ).join('') +
    '</div>').join('');
}

/* ---------- 主题下的仓库 ---------- */
function renderTopic(d){
  const head = '<div class="grp"><div class="grp-h">' + esc(d.slug) +
    ' · ' + d.items.length + ' 个仓库</div></div>';
  if (!d.items.length) { $('#list').innerHTML = head + '<div class="empty">该主题暂无仓库</div>'; return; }
  $('#list').innerHTML = head + d.items.map(e =>
    '<article class="card" data-name="' + esc(e.n) + '">' +
      '<div class="body">' +
        '<div class="l1"><span class="name">' + esc(e.n) + '</span>' +
          '<span class="gain">' + k(e.s) + '★</span></div>' +
        '<div class="meta">' + k(e.s) + '★ · ' + k(e.f) + ' fork' +
          (e.c ? ' · 建于 ' + esc(String(e.c).slice(0, 10)) : '') + '</div>' +
        (e.d ? '<div class="desc">' + esc(e.d) + '</div>' : '') +
        (e.l ? '<div class="chips"><span class="chip lang">' + esc(e.l) + '</span></div>' : '') +
      '</div></article>').join('');
}

/* ---------- GitHub 热门仓库（长期反复上榜） ---------- */
function renderGh(items){
  if (!items || !items.length) { $('#list').innerHTML = '<div class="empty">暂无数据</div>'; return; }
  $('#list').innerHTML = items.map((e, i) =>
    '<article class="card" data-name="' + esc(e.n) + '">' +
      '<div class="rank' + (i === 0 ? ' r1' : i === 1 ? ' r2' : i === 2 ? ' r3' : '') + '">' + (i + 1) + '</div>' +
      '<div class="body">' +
        '<div class="l1"><span class="name">' + esc(e.n) + '</span>' +
          '<span class="gain">上榜 ' + e.cnt + ' 次</span></div>' +
        '<div class="meta">历史最好第 ' + e.best + ' 名</div>' +
        (e.d ? '<div class="desc">' + esc(e.d) + '</div>' : '') +
      '</div></article>').join('');
}

/* ---------- 开发者 ---------- */
function renderDevs(items){
  if (!items || !items.length) { $('#list').innerHTML = '<div class="empty">暂无数据</div>'; return; }
  $('#list').innerHTML = items.map((d, i) =>
    '<article class="card">' +
      '<div class="rank' + (i === 0 ? ' r1' : i === 1 ? ' r2' : i === 2 ? ' r3' : '') + '">' + (i + 1) + '</div>' +
      '<div class="body">' +
        '<div class="l1">' +
          (d.avatar ? '<img class="av" src="' + esc(d.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') +
          '<span class="name">' + esc(d.name || d.login) + '</span>' +
          '<a class="gain" href="https://github.com/' + esc(d.login) + '" target="_blank" rel="noopener">@' + esc(d.login) + '</a>' +
        '</div>' +
        '<div class="meta">' + k(d.followers) + ' 关注者 · ' + k(d.repos) + ' 仓库' +
          ' · 上榜 ' + d.cnt + ' 次</div>' +
        (d.bio ? '<div class="desc">' + esc(d.bio) + '</div>' : '') +
        ((d.company || d.location) ? '<div class="chips">' +
          (d.company ? '<span class="chip">' + esc(d.company) + '</span>' : '') +
          (d.location ? '<span class="chip">' + esc(d.location) + '</span>' : '') +
          '</div>' : '') +
      '</div></article>').join('');
}

/* ---------- 统计（语言榜） ---------- */
function renderStats(d){
  const items = d.items || [];
  if (!items.length) { $('#list').innerHTML = '<div class="empty">该月暂无数据</div>'; return; }
  const max = Math.max(...items.map(x => x.v)) || 1;
  const label = d.metric === 'forks' ? 'fork' : 'star';
  $('#list').innerHTML =
    '<div class="grp"><div class="grp-h">' + d.year + ' 年 ' + d.month + ' 月 · 各语言新增 ' + label + '</div></div>' +
    items.map(x => {
      const w = Math.max(2, Math.round(x.v / max * 100));
      return '<div class="bar-row">' +
        '<div class="bar-l">' + esc(x.l) + '</div>' +
        '<div class="bar-t"><div class="bar-f" style="width:' + w + '%"></div></div>' +
        '<div class="bar-v">' + k(x.v) + '</div>' +
      '</div>';
    }).join('');
}

function render(){
  const d = st.data;""")

# ---------- 5. refresh：分发 ----------
s = s.replace(
"""    if (st.tf === 'mentions') {
      st.data = { mentions: await api('api/mentions') };
    } else if (st.q) {""",
"""    if (st.tf === 'mentions') {
      st.data = { mentions: await api('api/mentions') };
    } else if (st.tf === 'topics') {
      st.data = st.topicSlug
        ? { topic: await api('api/topic', { slug: st.topicSlug }) }
        : { topics: (await api('api/topics')).topics };
    } else if (st.tf === 'ghtrend') {
      st.data = { ghtrend: (await api('api/ghtrending')).items };
    } else if (st.tf === 'devs') {
      st.data = { devs: (await api('api/devs')).items };
    } else if (st.tf === 'stats') {
      const now = new Date();
      const y = st.statYear || now.getUTCFullYear();
      const m = st.statMonth || (now.getUTCMonth() + 1);
      st.data = { stats: await api('api/stats', { year: y, month: m, metric: st.metric }) };
    } else if (st.q) {""")

# ---------- 6. 翻译只对榜单生效 ----------
s = s.replace(
"""  if (st.data && !st.data.mentions) translateList();""",
"""  if (st.data && BOARD.has(st.tf) && !st.q) translateList();""")

# ---------- 7. 控件：非榜单隐藏筛选条，新增排序项 ----------
s = s.replace(
"""  const isM = st.tf === 'mentions';
  $('#rowSort').style.display = isM ? 'none' : '';
  $('#rowPeriod').style.display = isM ? 'none' : '';""",
"""  const hide = FILTERED.has(st.tf);
  $('#rowSort').style.display = hide ? 'none' : '';
  $('#rowPeriod').style.display = hide ? 'none' : '';
  $('#rowStats').style.display = st.tf === 'stats' ? '' : 'none';""")

# ---------- 8. 切栏目时清空子状态 ----------
s = s.replace(
"""    st.tf = b.dataset.tf; st.period = null; st.q = ''; $('#q').value = '';
    buildControls(); loadLangs(); refresh(false);""",
"""    st.tf = b.dataset.tf; st.period = null; st.q = ''; $('#q').value = ''; st.topicSlug = null;
    buildControls();
    if (BOARD.has(st.tf)) loadLangs();
    refresh(false);""")

p.write_text(s, encoding='utf-8')
print('js patched')
