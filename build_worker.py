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
# ★ 产物在全部门禁通过后才落盘：门失败时不能留下一个「看起来可用」的旧/新产物，
#   deploy.sh 后面的 upload_worker.py 会照单全收。

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

    # sw.js 同样是「静默失效」高危面：语法错不会让页面白屏，
    # 但 Service Worker 注册失败 → 离线全废、tr.json 超时保护全废，
    # 而 build/deploy 的 HTTP 探针全都照常 200。同一道门顺手覆盖它。
    sw_path = SRC / 'sw.js'
    r2 = subprocess.run([node, '--check', str(sw_path)], capture_output=True, text=True)
    if r2.returncode != 0:
        print('✗ sw.js 语法错误：\n' + (r2.stderr or '')[:800], file=sys.stderr)
        sys.exit(1)
    print('✓ sw.js 语法检查通过（%d 字符）' % len(sw))
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

# ---- 判据一致性门：前端 isChinese() 必须与云端 cloud_sync.is_zh() 逐条一致 ----
# 2026-11-25：两侧判据不同（前端 han >= latin，云端含汉字即中文）时，
# 云端跳过的条目会在前端每次刷新都被送去实时翻译，白耗 Gemini 额度、首屏变慢，
# 而两边各自看起来都「没问题」。判据只有一份语义，就只该有一处实现。
def check_zh_parity():
    import importlib.util
    if not node:
        print('! 未安装 node，跳过判据一致性检查')
        return
    sys.path.insert(0, str(SRC))
    spec = importlib.util.spec_from_file_location('cloud_sync', SRC / 'cloud_sync.py')
    cs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cs)

    m = re.search(r'const CJK = [^\n]+\n', html)
    m2 = re.search(r'const KANA = [^\n]+\n', html)
    m3 = re.search(r'const HANGUL = [^\n]+\n', html)
    m4 = re.search(r'function isChinese\(t\)\{[\s\S]*?\n\}', html)
    if not (m and m2 and m3 and m4):
        print('✗ 无法从 index.html 提取 isChinese()/CJK/KANA/HANGUL', file=sys.stderr)
        sys.exit(1)

    samples = [
        'Visual Studio Code', 'SAM 3D Objects', 'Nano vLLM', 'GitHub Agentic Workflows',
        'A hive mind communication platform', 'Self-hosted deployment platform',
        'A lightweight recommendation system for cold start users',
        'MCP for xiaohongshu.com', 'eBPF-based security platform', 'Agent skills',
        '一键将 Markdown 粘贴到 Word', '中文混排 with English words here',
        '日本語のツール', '한국어 도구', 'Fast Python web framework',
        'Open source CRM', 'A Tiny biped duck robot 🦆', 'Linux kernel source tree',
        'A modern alternative to ls', 'The open-source CapCut alternative',
    ]
    probe = pathlib.Path('/tmp/_zh_parity.json')
    probe.write_text(json.dumps([{'t': t, 'zh': bool(cs.is_zh(t))} for t in samples],
                                ensure_ascii=False), encoding='utf-8')
    js_path = pathlib.Path('/tmp/_zh_parity.js')
    js_path.write_text(
        "const fs=require('fs');\n"
        "const html=fs.readFileSync(%r,'utf8');\n" % str(SRC / 'index.html') +
        "const pick=(re,n)=>{const m=html.match(re);if(!m)throw new Error('extract '+n);return m[0];};\n"
        "const code=pick(/const CJK = [^\\n]+\\n/,'CJK')"
        "+pick(/const KANA = [^\\n]+\\n/,'KANA')"
        "+pick(/const HANGUL = [^\\n]+\\n/,'HANGUL')"
        "+pick(/function isChinese\\(t\\)\\{[\\s\\S]*?\\n\\}/,'isChinese');\n"
        "const sb={};new Function('sb',code+'sb.f=isChinese;')(sb);\n"
        "const rows=JSON.parse(fs.readFileSync('/tmp/_zh_parity.json','utf8'));\n"
        "const bad=rows.filter(r=>sb.f(r.t)!==r.zh);\n"
        "if(bad.length){console.error('✗ 前后端中文判据不一致 '+bad.length+' 条:');"
        "for(const b of bad.slice(0,5))console.error('   '+JSON.stringify(b.t)+' py='+b.zh+' js='+sb.f(b.t));"
        "process.exit(1);}\n"
        "console.log('✓ 前后端中文判据一致（'+rows.length+' 条样本）');\n",
        encoding='utf-8')

    r = subprocess.run([node, str(js_path)], capture_output=True, text=True)
    if r.returncode != 0:
        print((r.stderr or r.stdout).strip(), file=sys.stderr)
        sys.exit(1)
    print((r.stdout or '').strip())


check_zh_parity()

OUT.write_text(script, encoding='utf-8')
print('wrote', OUT, OUT.stat().st_size, 'bytes')
