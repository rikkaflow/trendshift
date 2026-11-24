#!/usr/bin/env python3
"""① 标签栏可排序/可隐藏（长按进入） ② 翻译小批重试"""
import pathlib

p = pathlib.Path('/var/minis/workspace/trendshift-app/index.html')
s = p.read_text(encoding='utf-8')

# ---------- 1. 默认顺序（按使用频率，时间族连续） ----------
s = s.replace(
"""const TFS = [
  ['daily','今日'],['weekly','本周'],['monthly','本月'],['yearly','今年'],
  ['mentions','热议'],['topics','主题'],['ghtrend','热门'],['devs','开发者'],['stats','统计'],
];""",
"""/* 栏目定义。默认顺序按使用频率：日更榜单最常用，长期/统计类靠后。
   用户可在界面里拖动排序或隐藏（存 localStorage）。 */
const TFS = [
  ['daily','今日'],['weekly','本周'],['mentions','热议'],['topics','主题'],
  ['monthly','本月'],['ghtrend','热门'],['devs','开发者'],['yearly','今年'],['stats','统计'],
];
const DEFAULT_ORDER = TFS.map(t => t[0]);
const TAB_LABEL = Object.fromEntries(TFS);""")

# ---------- 2. 状态里加 order / hidden ----------
s = s.replace(
"""  metric:'stars', statYear:null, statMonth:null,
};""",
"""  metric:'stars', statYear:null, statMonth:null,
  order: null, hidden: null,
};""")

# 启动时读回用户排序
s = s.replace(
"""const $ = s => document.querySelector(s);""",
"""/* 标签顺序与隐藏项（本地持久化） */
function loadTabPrefs(){
  const o = read('ts:order');
  const h = read('ts:hidden');
  st.order = (Array.isArray(o) && o.length ? o : DEFAULT_ORDER.slice())
    .filter(id => DEFAULT_ORDER.includes(id));
  for (const id of DEFAULT_ORDER) if (!st.order.includes(id)) st.order.push(id);
  st.hidden = new Set(Array.isArray(h) ? h.filter(id => DEFAULT_ORDER.includes(id)) : []);
  // 至少要留一个可见，否则界面会空白
  if (st.hidden.size >= DEFAULT_ORDER.length) st.hidden = new Set();
  if (st.hidden.has(st.tf)) st.tf = st.order.find(id => !st.hidden.has(id)) || 'daily';
}
function saveTabPrefs(){
  save('ts:order', st.order);
  save('ts:hidden', [...st.hidden]);
}

const $ = s => document.querySelector(s);""")

# ---------- 3. 标签渲染按 order / hidden ----------
s = s.replace(
"""  $('#tabs').innerHTML = TFS.map(([v, l]) =>
    '<button class="tab' + (st.tf === v ? ' on' : '') + '" data-tf="' + v + '">' + l + '</button>').join('');""",
"""  const visible = st.order.filter(id => !st.hidden.has(id));
  $('#tabs').innerHTML = visible.map(id =>
    '<button class="tab' + (st.tf === id ? ' on' : '') + '" data-tf="' + id + '">' +
      esc(TAB_LABEL[id]) + '</button>').join('');""")

# ---------- 4. 长按进入排序面板 ----------
s = s.replace(
"""  $('#tabs').onclick = ev => {
    const b = ev.target.closest('.tab'); if (!b) return;""",
"""  /* 长按 500ms 进入排序面板；期间若移动或抬起则取消 */
  let pressTimer = null, pressed = false;
  $('#tabs').addEventListener('pointerdown', ev => {
    const b = ev.target.closest('.tab'); if (!b) return;
    pressed = false;
    pressTimer = setTimeout(() => {
      pressed = true;
      pressTimer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      openTabOrder();
    }, 500);
  });
  const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  $('#tabs').addEventListener('pointerup', cancelPress);
  $('#tabs').addEventListener('pointercancel', cancelPress);
  $('#tabs').addEventListener('pointermove', cancelPress);

  $('#tabs').onclick = ev => {
    if (pressed) { pressed = false; return; }   // 长按刚触发，别顺带切换
    const b = ev.target.closest('.tab'); if (!b) return;""")

# ---------- 5. 排序面板 ----------
s = s.replace(
"""function buildPeriods(list, cur){""",
"""/* ---------- 栏目排序面板 ---------- */
let orderDraft = null, hiddenDraft = null;

function openTabOrder(){
  orderDraft = st.order.slice();
  hiddenDraft = new Set(st.hidden);
  document.body.classList.add('detail');
  $('#page').classList.add('on');
  $('#ptitle').textContent = '栏目排序';
  renderOrderPanel();
}

function renderOrderPanel(){
  const rows = orderDraft.map((id, i) => {
    const off = hiddenDraft.has(id);
    return '<div class="orow' + (off ? ' off' : '') + '">' +
      '<div class="oname">' + esc(TAB_LABEL[id]) + '</div>' +
      '<button class="oic" data-up="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="oic" data-down="' + i + '"' + (i === orderDraft.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="oic' + (off ? ' on' : '') + '" data-eye="' + id + '">' + (off ? '隐藏' : '显示') + '</button>' +
    '</div>';
  }).join('');

  $('#pbody').innerHTML =
    '<div class="hint">常用栏目放前面。长按顶部标签也能回到这里。</div>' +
    '<div class="olist">' + rows + '</div>' +
    '<div class="pactions">' +
      '<button class="btn" id="oReset">恢复默认</button>' +
      '<button class="btn pri" id="oDone">完成</button>' +
    '</div>';

  const body = $('#pbody');
  body.onclick = ev => {
    const up = ev.target.closest('[data-up]');
    const dn = ev.target.closest('[data-down]');
    const eye = ev.target.closest('[data-eye]');
    if (up) {
      const i = +up.dataset.up;
      [orderDraft[i - 1], orderDraft[i]] = [orderDraft[i], orderDraft[i - 1]];
      renderOrderPanel();
    } else if (dn) {
      const i = +dn.dataset.down;
      [orderDraft[i + 1], orderDraft[i]] = [orderDraft[i], orderDraft[i + 1]];
      renderOrderPanel();
    } else if (eye) {
      const id = eye.dataset.eye;
      if (hiddenDraft.has(id)) hiddenDraft.delete(id);
      else if (hiddenDraft.size < orderDraft.length - 1) hiddenDraft.add(id);
      renderOrderPanel();
    } else if (ev.target.id === 'oReset') {
      orderDraft = DEFAULT_ORDER.slice();
      hiddenDraft = new Set();
      renderOrderPanel();
    } else if (ev.target.id === 'oDone') {
      st.order = orderDraft.slice();
      st.hidden = new Set(hiddenDraft);
      if (st.hidden.has(st.tf)) st.tf = st.order.find(id => !st.hidden.has(id)) || 'daily';
      saveTabPrefs();
      closeDetail();
      buildControls();
      refresh(false);
    }
  };
}

function buildPeriods(list, cur){""")

# ---------- 6. 启动时加载偏好 ----------
s = s.replace(
"""buildControls();
initStatsControls();""",
"""loadTabPrefs();
buildControls();
initStatsControls();""")

# ---------- 7. 样式 ----------
s = s.replace(
"""/* 详情页：与列表互斥显示的普通文档流，不用 fixed 覆盖层""",
"""/* 排序面板 */
.hint{font-size:12px;color:var(--dim);margin-bottom:14px;line-height:1.6}
.olist{display:flex;flex-direction:column;gap:7px}
.orow{display:flex;align-items:center;gap:7px;background:var(--card);
  border:1px solid var(--line);border-radius:11px;padding:9px 10px}
.orow.off{opacity:.42}
.oname{flex:1;font-size:14px;font-weight:600}
.oic{width:38px;height:32px;border-radius:8px;border:1px solid var(--line);
  background:var(--card2);font-size:12px;color:var(--fg);display:grid;place-items:center}
.oic[disabled]{opacity:.3}
.oic.on{color:var(--dim);border-style:dashed}

/* 详情页：与列表互斥显示的普通文档流，不用 fixed 覆盖层""")

# ---------- 8. 翻译：小批 + 重试 ----------
s = s.replace(
"""  for (let i = 0; i < uniq.length; i += 12) {
    const chunk = uniq.slice(i, i + 12);
    try { await viaGoogle(chunk); }
    catch(e) {
      try { await viaMyMemory(chunk); } catch(e2) {}
    }
  }
  return map;""",
"""  /* 小批 + 重试：一次塞太多段会被 Google 限流，实测 6 段/批最稳 */
  for (let i = 0; i < uniq.length; i += 6) {
    const chunk = uniq.slice(i, i + 6);
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try { await viaGoogle(chunk); done = true; }
      catch(e) {
        if (attempt === 1) { try { await viaMyMemory(chunk); } catch(e2) {} }
        else await new Promise(r => setTimeout(r, 300));
      }
    }
    if (i + 6 < uniq.length) await new Promise(r => setTimeout(r, 150));
  }
  return map;""")

# ---------- 9. 翻译时按视图分批渲染，避免长文本阻塞 ----------
s = s.replace(
"""async function translateView(){
  if (!st.zh) return;
  const pending = collectTexts().filter(t => !(st.tr || {})[t]);
  if (!pending.length) return;
  const map = await translateBatch([...new Set(pending)]);
  if (!Object.keys(map).length) return;
  st.tr = Object.assign(st.tr || {}, map);
  render();
}""",
"""async function translateView(){
  if (!st.zh) return;
  const view = st.tf;
  const pending = collectTexts().filter(t => !(st.tr || {})[t]);
  if (!pending.length) return;
  const map = await translateBatch([...new Set(pending)]);
  if (!Object.keys(map).length) return;
  st.tr = Object.assign(st.tr || {}, map);
  if (st.tf === view) render();          // 用户已切走就别覆盖当前页
}""")

p.write_text(s, encoding='utf-8')
print('order + translate patched')