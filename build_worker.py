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

assets = {
    '/': {'body': html, 'type': 'text/html; charset=utf-8'},
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
