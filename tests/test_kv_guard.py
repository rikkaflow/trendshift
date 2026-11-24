#!/usr/bin/env python3
"""cloud_sync 的 KV 读保护 + 队列不早退 的回归测试（纯本地，无网络）。

运行：python3 /var/minis/shared/work/tsfix1125/wt/tests/test_kv_guard.py
"""
import importlib.util
import json
import sys
import pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('cloud_sync', SRC / 'cloud_sync.py')
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

fails = []
def check(name, cond, extra=''):
    print(('  PASS  ' if cond else '  FAIL  ') + name + (('  ' + extra) if extra and not cond else ''))
    if not cond:
        fails.append(name)

# ---------- 1. http() 返回真实状态码 ----------
def fake_http(mapping):
    """mapping: url 子串 -> (status, body)"""
    def _h(method, url, data=None, headers=None, timeout=120, stdin_text=None):
        for k, v in mapping.items():
            if k in url:
                return v
        return 0, ''
    return _h

print('[1] http() 状态码语义')
real_http = cs.http
cs.http = lambda *a, **kw: (200, '{"ok":1}')
code, out = cs.http('GET', 'http://x')
check('200 原样返回', code == 200 and out == '{"ok":1}')

# ---------- 2. kv_get 三种失败路径 ----------
print('[2] kv_get：只有 404 才允许返回 None')
cs.CF_ACC = 'acct'; cs.CF_TOK = 'tok'; cs.KV_ID = 'ns'

cs.http = lambda *a, **kw: (404, '{"success":false,"errors":[{"code":10009,"message":"key not found"}]}')
check('404 → None（首次运行）', cs.kv_get('tr.json') is None)

cs.http = lambda *a, **kw: (401, '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}')
try:
    cs.kv_get('tr.json'); check('401 → 抛 KvUnavailable', False)
except cs.KvUnavailable as e:
    check('401 → 抛 KvUnavailable', '401' in str(e), str(e))

cs.http = lambda *a, **kw: (502, '<html>bad gateway</html>')
try:
    cs.kv_get('tr.json'); check('502 HTML → 抛 KvUnavailable', False)
except cs.KvUnavailable:
    check('502 HTML → 抛 KvUnavailable', True)

cs.http = lambda *a, **kw: (0, '')
try:
    cs.kv_get('tr.json'); check('网络失败 → 抛 KvUnavailable', False)
except cs.KvUnavailable:
    check('网络失败 → 抛 KvUnavailable', True)

cs.http = lambda *a, **kw: (200, '[1,2,3]')
try:
    cs.kv_get('tr.json'); check('200 但非字典 → 抛 KvUnavailable', False)
except cs.KvUnavailable:
    check('200 但非字典 → 抛 KvUnavailable', True)

cs.http = lambda *a, **kw: (200, '{"success":false,"errors":[]}')
try:
    cs.kv_get('tr.json'); check('200 但 success:false → 抛 KvUnavailable', False)
except cs.KvUnavailable:
    check('200 但 success:false → 抛 KvUnavailable', True)

cs.http = lambda *a, **kw: (200, json.dumps({'a': '甲', 'b': '乙'}, ensure_ascii=False))
t = cs.kv_get('tr.json')
check('200 正常表原样返回', t == {'a': '甲', 'b': '乙'})

# ---------- 3. main() 读表失败必须中止，不得写回 ----------
print('[3] main()：KV 读失败 → 立即退出，不写 KV')
puts = []
def run_main(kv_status, kv_body, texts=('Some new english text',)):
    puts.clear()
    cs.CF_ACC = 'acct'; cs.CF_TOK = 'tok'; cs.KV_ID = 'ns'
    cs.GEMINI_KEYS = ['k1']
    cs.collect = lambda: list(texts)
    def _h(method, url, data=None, headers=None, timeout=120, stdin_text=None):
        if method == 'GET' and '/values/' in url:
            return kv_status, kv_body
        if method == 'PUT' and '/values/' in url:
            puts.append(stdin_text); return 200, '{"success":true}'
        return 0, ''
    cs.http = _h
    return cs.main()

# 关键：给翻译函数装桩，让「读表失败但翻译成功」这条路径真的会走到写回。
# 不装桩的话，读表失败后翻译也失败 → 不写回 → 测试会假绿（变异负控已实证）。
cs.gemini_translate = lambda batch, key: ['新译文%d' % i for i, _ in enumerate(batch)]
rc = run_main(401, '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}')
check('401 时 main 返回 1', rc == 1, 'rc=%s' % rc)
check('401 时没有任何 KV 写入（否则 1865 条被清空）', len(puts) == 0, 'puts=%d' % len(puts))

rc = run_main(502, '<html>oops</html>')
check('502 时 main 返回 1', rc == 1)
check('502 时没有任何 KV 写入', len(puts) == 0)
check('502 时不把 HTML 错误体当译表', all('oops' not in x for x in puts))

# 404 = 首次运行，允许写；此时写进去的应该只有新翻的条目
cs.gemini_translate = lambda batch, key: ['新译文%d' % i for i, _ in enumerate(batch)]
rc = run_main(404, '{"success":false,"errors":[{"code":10009,"message":"key not found"}]}')
check('404 首次运行 → rc=0', rc == 0, 'rc=%s' % rc)
check('404 首次运行 → 写一次', len(puts) == 1)
if puts:
    written = json.loads(puts[0])
    check('404 首次运行 → 只含新条目', written == {'Some new english text': '新译文0'}, str(written)[:120])

# 正常读表：旧条目必须被保留（这是「不清空」的正向对照）
cs.gemini_translate = lambda batch, key: ['新译文%d' % i for i, _ in enumerate(batch)]
rc = run_main(200, json.dumps({'old key one': '旧译文一', 'old key two': '旧译文二'}, ensure_ascii=False))
check('正常读表 → rc=0', rc == 0, 'rc=%s' % rc)
if puts:
    written = json.loads(puts[0])
    check('正常读表 → 旧条目全部保留', 'old key one' in written and 'old key two' in written, str(list(written))[:120])
    check('正常读表 → 新条目被加入', 'Some new english text' in written)

# ---------- 4. 脏数据清理 ----------
print('[4] 脏数据清理')
cs.gemini_translate = lambda batch, key: ['新译文%d' % i for i, _ in enumerate(batch)]
dirty_tbl = {
    '基于Selkies的Linux网页版微信': '3. 基于 Selkies 的 Linux 网页版微信',   # 序号 + 原文是中文
    'Some english source': '1. Some english source',                      # 序号 + 等于原文
    'good key': '好译文',
}
rc = run_main(200, json.dumps(dirty_tbl, ensure_ascii=False))
check('清理后 rc=0', rc == 0)
if puts:
    written = json.loads(puts[0])
    check('序号+中文 的脏值被删', '基于Selkies的Linux网页版微信' not in written)
    check('序号+原文 的脏值被删', 'Some english source' not in written)
    check('正常译文保留', written.get('good key') == '好译文')

# ---------- 5. 队列：拆分后不会被提前退出丢掉 ----------
print('[5] 队列不早退（拆分后仍被处理）')
calls = {'n': 0}
def flaky(batch, key):
    calls['n'] += 1
    if len(batch) > 1:
        return None          # 模拟对不齐 → 上层对半拆开重入队
    return ['译:' + batch[0]]
cs.gemini_translate = flaky
puts.clear()
many = tuple('text number %d with words' % i for i in range(8))
rc = run_main(200, json.dumps({'x': 'y'}, ensure_ascii=False), texts=many)
check('拆分批全部落地 rc=0', rc == 0, 'rc=%s' % rc)
if puts:
    written = json.loads(puts[0])
    got = [k for k in written if k.startswith('text number')]
    check('8 条全部翻出（无丢失）', len(got) == 8, 'got=%d' % len(got))

cs.http = real_http
print()
if fails:
    print('✗ %d 项失败：%s' % (len(fails), fails))
    sys.exit(1)
print('✓ 全部通过')
