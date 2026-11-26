#!/usr/bin/env node
/* 一次性诊断脚本：把真实样本跑过过滤器，逐条打印「留/挡 + 原因 + 正文长度」，
   用来人工判断有没有误杀。不是回归测试（回归在 test_noise.js）。
   用法：node tests/audit_filter.js [样本路径...] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
function ex(n) {
  const m = new RegExp('^function ' + n + '\\([\\s\\S]*?^\\}', 'm').exec(html);
  if (!m) throw new Error('missing function ' + n);
  return m[0];
}
const consts = `
const FILTER_DEFAULTS = ${/const FILTER_DEFAULTS = (\{[\s\S]*?\});/.exec(html)[1]};
const PROMO_PATTERNS = ${/const PROMO_PATTERNS = (\[[\s\S]*?\]);/.exec(html)[1]};
const REASON_LABEL = ${/const REASON_LABEL = (\{[\s\S]*?\});/.exec(html)[1]};
`;
const s = { console, Date, JSON, Math, Array, String, Number, Object, RegExp };
vm.createContext(s);
vm.runInContext(consts + '\n' + [ex('normText'), ex('promoHit'), ex('filterMentions')].join('\n\n') +
  '\nthis.f = filterMentions; this.L = REASON_LABEL; this.D = FILTER_DEFAULTS;', s);

const files = process.argv.slice(2);
if (!files.length) {
  files.push(path.join(__dirname, 'fixtures', 'mentions-2026-11-26.json'));
}

for (const f of files) {
  let raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (raw.items) raw = raw.items;
  const items = raw.map(x => ({
    repo: x.repository_full_name || x.repo || '',
    author: x.author_handle || x.author || '',
    text: x.content || x.text || '',
    title: x.title || '',
  }));
  const { keep, drop } = s.f(items, s.D);
  const dropMap = new Map(drop.map(d => [d.item, d.reasons]));
  console.log('\n=== ' + path.basename(f) + ' ===');
  console.log('总计 ' + items.length + '  保留 ' + keep.length + '  挡掉 ' + drop.length);
  const rows = items.map(m => {
    const rs = dropMap.get(m);
    const bare = m.text.replace(/https?:\/\/\S+/g, '').trim();
    return {
      keep: !rs,
      repo: m.repo,
      author: m.author,
      len: bare.length,
      why: rs ? rs.map(r => s.L[r] || r).join(',') : '',
      text: bare.slice(0, 90).replace(/\n/g, ' '),
    };
  });
  console.log('\n-- 保留 --');
  for (const r of rows.filter(x => x.keep)) {
    console.log('  ' + r.repo.slice(0, 40).padEnd(42) + ' ' + String(r.len).padStart(4) + '字  ' + r.text);
  }
  console.log('\n-- 挡掉 --');
  for (const r of rows.filter(x => !x.keep)) {
    console.log('  ' + r.repo.slice(0, 40).padEnd(42) + ' ' + String(r.len).padStart(4) + '字  [' + r.why + ']  ' + r.text);
  }
}
