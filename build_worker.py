#!/usr/bin/env python3
"""把 trendshift-app 静态文件内联进 Worker 模板，输出可上传的脚本。

文本资源直接内联；PNG 等二进制资源转 base64，Worker 侧解码后返回。
"""
import base64
import json
import pathlib

SRC = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path('/tmp/ts_worker.js')

html = (SRC / 'index.html').read_text(encoding='utf-8')
manifest = (SRC / 'manifest.webmanifest').read_text(encoding='utf-8')
sw = (SRC / 'sw.js').read_text(encoding='utf-8')
icon_svg = (SRC / 'icon.svg').read_text(encoding='utf-8')
png192 = base64.b64encode((SRC / 'icon-192.png').read_bytes()).decode()
png512 = base64.b64encode((SRC / 'icon-512.png').read_bytes()).decode()
png_mask = base64.b64encode((SRC / 'icon-512-maskable.png').read_bytes()).decode()

# 预翻译表：构建期一次性生成，前端只查表不再实时翻译
tr_file = SRC / 'translations.json'
if tr_file.exists():
    tr_json = tr_file.read_text(encoding='utf-8')
else:
    tr_json = '{}'
    print('警告：translations.json 不存在，前端将退化为实时翻译')

assets = {
    '/': {'body': html, 'type': 'text/html; charset=utf-8'},
    '/tr.json': {'body': tr_json, 'type': 'application/json; charset=utf-8'},
    '/index.html': {'body': html, 'type': 'text/html; charset=utf-8'},
    '/manifest.webmanifest': {'body': manifest, 'type': 'application/manifest+json; charset=utf-8'},
    '/sw.js': {'body': sw, 'type': 'application/javascript; charset=utf-8'},
    '/icon.svg': {'body': icon_svg, 'type': 'image/svg+xml'},
    '/icon-192.png': {'b64': png192, 'type': 'image/png'},
    '/icon-512.png': {'b64': png512, 'type': 'image/png'},
    '/icon-512-maskable.png': {'b64': png_mask, 'type': 'image/png'},
}

tpl = (SRC / 'worker.template.js').read_text(encoding='utf-8')
script = tpl.replace('__ASSETS__', json.dumps(assets, ensure_ascii=False))
OUT.write_text(script, encoding='utf-8')
print('wrote', OUT, OUT.stat().st_size, 'bytes')

# ---- 语法门：前端整段 script 必须能被 JS 解析 ----
# 2026-11-24 事故：index.html 里同一作用域重复 `let googleDownUntil`，
# SyntaxError 让整个脚本不执行，页面只剩骨架且列表永远空白，
# 而构建/部署/接口验证全部通过——静态资源能返回 ≠ 前端能运行。
# 这里在构建期做一次解析 + 顶层重复声明检查，把这类错误挡在部署之前。
import re
import shutil
import subprocess
import sys

blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
if not blocks:
    print('✗ index.html 里没找到内联 script，检查模板是否被改坏', file=sys.stderr)
    sys.exit(1)
js = '\n'.join(blocks)
check = pathlib.Path('/tmp/_ts_check.js')
check.write_text(js, encoding='utf-8')

node = shutil.which('node')
if node:
    r = subprocess.run([node, '--check', str(check)], capture_output=True, text=True)
    if r.returncode != 0:
        print('✗ 前端 JS 语法错误：\n' + (r.stderr or '')[:800], file=sys.stderr)
        sys.exit(1)
    print('✓ JS 语法检查通过（%d 个 script 块，%d 字符）' % (len(blocks), len(js)))
else:
    print('! 未安装 node，跳过语法检查（部署前请手动 node --check）')

# 顶层重复声明：同一个 let/const/var 名字出现两次以上即为 SyntaxError 隐患
seen = {}
for name in re.findall(r'^(?:let|const|var)\s+([A-Za-z_$][\w$]*)', js, re.M):
    seen[name] = seen.get(name, 0) + 1
dups = {k: v for k, v in seen.items() if v > 1}
if dups:
    print('✗ 顶层重复声明（会导致 SyntaxError）：%s' % dups, file=sys.stderr)
    sys.exit(1)
print('✓ 无顶层重复声明')
