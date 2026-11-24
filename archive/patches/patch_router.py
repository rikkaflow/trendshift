#!/usr/bin/env python3
"""统一视图路由：repo / mention / topic 三类跳转都走历史栈，返回行为一致。"""
import pathlib

p = pathlib.Path('/var/minis/workspace/trendshift-app/index.html')
s = p.read_text(encoding='utf-8')

# ---------- 1. 函数改名：openDetail → renderRepo, openMention → renderMention ----------
s = s.replace('async function openDetail(name){', 'async function renderRepo(name){')
s = s.replace('function openMention(m){', 'function renderMention(m){')
# 内部自调用
s = s.replace('setTimeout(() => openDetail(m.repo), 60)', 'setTimeout(() => go({ v: "repo", name: m.repo }), 60)')

# ---------- 2. 替换整段历史栈逻辑 ----------
old_start = s.index("/* ---------- 历史栈：手势返回要能退回列表，而不是退出应用 ---------- */")
old_end = s.index("loadTabPrefs();\nloadTrCache();")
new = '''/* ---------- 统一路由：repo / mention / topic 三类跳转都压历史栈 ---------- */
/* 返回行为因此完全一致：手势返回或左上返回键，都是退回上一个视图，不会退出应用。 */

function closeDetail(){
  $('#page').classList.remove('on');
  document.body.classList.remove('detail');
  st.cur = null;
  document.title = 'Trendshift';
  window.scrollTo(0, st.listScroll || 0);
}

/* 热议对象缓存：popstate 时靠 id 找回原对象（列表数据可能已换） */
function rememberMention(m){
  st.mcache = st.mcache || new Map();
  st.mcache.set(String(m.id), m);
}
function findMention(id){
  if (st.mcache && st.mcache.has(String(id))) return st.mcache.get(String(id));
  const list = (st.data && st.data.mentions) ? st.data.mentions.items : [];
  return list.find(x => String(x.id) === String(id)) || null;
}

/* 渲染某个状态对应的视图（不碰历史栈） */
function renderState(state){
  if (!state || !state.v) { closeDetail(); return; }
  if (state.v === 'repo') { renderRepo(state.name); return; }
  if (state.v === 'mention') {
    const m = findMention(state.id);
    if (m) renderMention(m); else closeDetail();
    return;
  }
  if (state.v === 'topic') {
    closeDetail();
    st.topicSlug = state.slug;
    st.tf = 'topics';
    buildControls();
    refresh(false);
    return;
  }
  closeDetail();
}

function hashOf(state){
  if (!state || !state.v) return location.pathname + location.search;
  if (state.v === 'repo') return '#repo=' + encodeURIComponent(state.name);
  if (state.v === 'mention') return '#mention=' + encodeURIComponent(state.id);
  if (state.v === 'topic') return '#topic=' + encodeURIComponent(state.slug);
  return location.pathname + location.search;
}

/* 所有跳转的唯一入口：先压历史，再渲染 */
function go(state){
  st.listScroll = window.scrollY || 0;
  try { history.pushState(state, '', hashOf(state)); } catch(e) {}
  renderState(state);
}

/* 列表点击分发 */
$('#list').addEventListener('click', ev => {
  const tg = ev.target.closest('.tag');
  if (tg) { go({ v: 'topic', slug: tg.dataset.slug }); return; }
  if (ev.target.closest('a')) return;             // 真外链照常跳
  const c = ev.target.closest('.card'); if (!c) return;

  if (c.dataset.mention) {                        // 热议：应用内读全文
    const m = findMention(c.dataset.mention);
    if (m) { rememberMention(m); go({ v: 'mention', id: String(m.id) }); }
    return;
  }
  const name = c.dataset.name;
  if (name) go({ v: 'repo', name });
});

/* 返回键：一律交给浏览器，统一走 popstate */
$('#back').onclick = () => {
  if (history.state && history.state.v) history.back();
  else renderState(null);
};

window.addEventListener('popstate', () => {
  renderState(history.state);
});

/* 冷启动带 hash 直达；replaceState 让返回键直接退出而不是回到同一视图 */
function openFromHash(){
  const h = location.hash || '';
  let state = null;
  let m;
  if ((m = /^#repo=(.+)$/.exec(h))) state = { v: 'repo', name: decodeURIComponent(m[1]) };
  else if ((m = /^#mention=(.+)$/.exec(h))) state = { v: 'mention', id: decodeURIComponent(m[1]) };
  else if ((m = /^#topic=(.+)$/.exec(h))) state = { v: 'topic', slug: decodeURIComponent(m[1]) };
  if (!state) return;
  try { history.replaceState(state, '', h); } catch(e) {}
  renderState(state);
}

'''
s = s[:old_start] + new + s[old_end:]

# ---------- 3. 主题列表页的标题要能回退（topic 视图在列表内，加一条返回提示） ----------
s = s.replace(
"""function renderTopic(d){
  const head = '<div class="grp"><div class="grp-h">' + esc(d.slug) +
    ' · ' + d.items.length + ' 个仓库</div></div>';""",
"""function renderTopic(d){
  const head = '<div class="grp"><div class="grp-h">' +
    '<button class="backlink" id="topicBack">← 全部主题</button>' +
    esc(d.slug) + ' · ' + d.items.length + ' 个仓库</div></div>';""")

# 绑定 topicBack
s = s.replace(
"""  $('#list').innerHTML = head + d.items.map(e =>""",
"""  $('#list').innerHTML = head + d.items.map(e =>""")
s = s.replace(
"""      '</div></article>').join('');
}

/* ---------- GitHub 热门仓库（长期反复上榜） ---------- */""",
"""      '</div></article>').join('');
  const tb = $('#topicBack');
  if (tb) tb.onclick = () => { history.back(); };
}

/* ---------- GitHub 热门仓库（长期反复上榜） ---------- */""")

# ---------- 4. 样式 ----------
s = s.replace("""/* 热议全文 */""",
"""/* 二级列表返回 */
.backlink{color:var(--acc);font-weight:600;font-size:12px;margin-right:8px;
  text-transform:none;letter-spacing:0}

/* 热议全文 */""")

# ---------- 5. 状态里加 mcache ----------
s = s.replace("  order: null, hidden: null,\n};",
              "  order: null, hidden: null, mcache: null,\n};")

p.write_text(s, encoding='utf-8')
print('router unified')
