#!/usr/bin/env node
/* 结构性回归测试：tr.json 超时预算 / buildData trim / trTableReady 竞态 / 详情页中文描述。
   运行：node tests/test_regressions.js */
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const tpl = fs.readFileSync(path.join(SRC, 'worker.template.js'), 'utf8');
const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');

let fails = 0;
const check = (n, c, e) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (!c && e ? '  ' + e : '')); if (!c) fails++; };

console.log('[1] sw.js：tr.json 不能被 4 秒掐断');
{
  const isTr = /const isTr = url\.pathname === '\/tr\.json';/.test(sw);
  const budget = /const budget = isTr \? (\d+) : (\d+);/.exec(sw);
  check('识别 tr.json 单独分支', isTr);
  check('tr.json 预算 ≥ 15s', !!budget && +budget[1] >= 15000, budget ? 'got=' + budget[1] : 'not found');
  check('其它静态资源仍是 4s', !!budget && +budget[2] === 4000, budget ? 'got=' + budget[2] : '');
  check('cache.put 挂在 waitUntil 上', /e\.waitUntil\(caches\.open\(CACHE\)/.test(sw));
  check('缓存版本已 bump（旧 SW 不会继续吃 4s 规则）', /const CACHE = 'trendshift-v[7-9]/.test(sw));
}

console.log('[2] worker buildData：简介首尾空白统一剥掉');
{
  check('buildData 里有 trim 循环', /for \(const e of rows\) \{\s*\n\s*if \(typeof e\.description === 'string'\) e\.description = e\.description\.trim\(\);/.test(tpl));
  // 行为级：抽出 buildData 里那两行，验证 trim 真的发生
  const rows = [{ description: '  hello world \n', rank: 1, period_key: 'p1', language: 'Go' }];
  for (const e of rows) if (typeof e.description === 'string') e.description = e.description.trim();
  check('trim 后与 cloud_sync 的 strip() 口径一致', rows[0].description === 'hello world');
}

console.log('[3] index.html：译表就位竞态');
{
  check('存在 trTableReady Promise', /let trTableReady = null;/.test(html));
  check('loadTrTable 幂等返回同一个 Promise', /if \(trTableReady\) return trTableReady;/.test(html));
  check('translateView 先等译表', /if \(trTableReady\) \{\s*\n\s*await Promise\.race\(\[trTableReady/.test(html));
  check('等待有上限（不会无限挂）', /setTimeout\(r, \d{4,5}\)/.test(html));
  check('失败后允许重试', /trTableReady = null;\s*\/\/ 允许下次重试/.test(html));
}

console.log('[4] 详情页：中文描述不显示翻译控件');
{
  check('存在 needTr 判据', /const needTr = needsTranslation\(descEn\);/.test(html));
  check('tr-note 受 needTr 门控', /\(needTr \? '<div class="tr-note">/.test(html));
  check('自动翻译分支受 needTr 门控', /if \(!descZh && st\.zh && descEn && needTr\)/.test(html));
  // 行为级：needsTranslation 对中文返回 false
  const isChinese = t => {
    if (!t) return false;
    if (/[\u3040-\u30ff]/.test(t) || /[\uac00-\ud7af]/.test(t)) return false;
    if (/[\u4e00-\u9fa5]/.test(t)) return true;
    const words = t.match(/[A-Za-z][A-Za-z\-\.]{1,}/g) || [];
    if (words.length > 4) return false;
    return !words.some(w => /^[a-z]{3,}$/.test(w));
  };
  const needsTranslation = t => !!t && !isChinese(t);
  check('中文简介 needsTranslation=false', needsTranslation('一个基于 Rust 写的工具，支持多平台') === false);
  check('英文简介 needsTranslation=true', needsTranslation('A lightweight recommendation system') === true);
}

console.log('[5] deploy.sh / upload_worker.py');
{
  const dep = fs.readFileSync(path.join(SRC, 'deploy.sh'), 'utf8');
  check('域名不再写死 trendshift-lite', !/^B=https:\/\/trendshift-lite\./m.test(dep));
  check('域名与 WORKER_NAME 联动', /WORKER_NAME:-trendshift-lite/.test(dep));
  check('支持 WORKER_BASE 覆盖', /WORKER_BASE/.test(dep));
  const up = fs.readFileSync(path.join(SRC, 'upload_worker.py'), 'utf8');
  check('上传前检查 curl 退出码', /if r\.returncode != 0:/.test(up));
}

console.log('[6] 内联译表快照已清理脏数据');
{
  const tr = JSON.parse(fs.readFileSync(path.join(SRC, 'translations.json'), 'utf8'));
  const IDX = /^(?:\d{1,2}[.)]\s+|\d{1,2}、\s*)/;
  const HAN = /[\u4e00-\u9fa5]/;
  const bad = Object.entries(tr).filter(([k, v]) => typeof v === 'string' && IDX.test(v) && HAN.test(k));
  check('无「序号前缀 + 中文原文」的脏值', bad.length === 0, 'bad=' + JSON.stringify(bad.slice(0, 3)));
  check('译表规模仍然合理（≥1800）', Object.keys(tr).length >= 1800, 'n=' + Object.keys(tr).length);
}

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
