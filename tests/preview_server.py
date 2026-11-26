#!/usr/bin/env python3
"""本地预览：用真实样本喂 /api/mentions 与 /api/list，验证过滤器在浏览器里的实际表现。
不联网、不改线上。用法：python3 tests/preview_server.py [port]
"""
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIX = pathlib.Path(__file__).resolve().parent / 'fixtures'

MENTIONS = json.loads((FIX / 'mentions-2026-11-26.json').read_text(encoding='utf-8'))
DAILY = json.loads((FIX / 'daily-all-2026-11-26.json').read_text(encoding='utf-8'))

def slim(e):
    return {
        'r': e['rank'], 'n': e['full_name'], 'u': e['github_url'], 'd': e.get('description') or '',
        'l': e.get('language') or '', 's': e['stars_total'], 'g': e['stars_gained'],
        'f': e['forks_total'], 'fg': e.get('forks_gained') or 0, 'c': e.get('created_at') or '',
        't': e.get('tags') or [], 'm': e.get('social_mention_platforms') or [], 'sc': e.get('score'),
    }

PERIODS = sorted({e['period_key'] for e in DAILY}, reverse=True)
BY_PERIOD = {}
for e in DAILY:
    BY_PERIOD.setdefault(e['period_key'], []).append(e)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.send_header('access-control-allow-origin', '*')
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path

        if p in ('/', '/index.html'):
            b = (ROOT / 'index.html').read_bytes()
            self.send_response(200)
            self.send_header('content-type', 'text/html; charset=utf-8')
            self.send_header('content-length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == '/api/mentions':
            items = [{
                'id': x['id'], 'plat': x['platform'], 'repo': x['repository_full_name'],
                'title': x.get('title') or '', 'text': (x.get('content') or '')[:2000],
                'author': x.get('author_handle') or '', 'link': x.get('link'), 'at': x.get('posted_at'),
            } for x in MENTIONS]
            return self._json({'items': items})
        if p == '/api/list':
            period = (q.get('period') or [PERIODS[0]])[0]
            items = [slim(e) for e in sorted(BY_PERIOD.get(period, []), key=lambda x: x['rank'])]
            idx = PERIODS.index(period) if period in PERIODS else 0
            prevp = PERIODS[idx + 1] if idx + 1 < len(PERIODS) else None
            prev = {e['full_name']: e['rank'] for e in BY_PERIOD.get(prevp, [])} if prevp else {}
            return self._json({
                'tf': 'daily', 'lang': 'all', 'period': period, 'sort': 'rank',
                'periods': PERIODS, 'total': len(items), 'items': items, 'prev': prev,
            })
        if p == '/api/langs':
            langs = sorted({(e.get('language') or 'Unknown') for e in DAILY})
            return self._json({'tf': 'daily', 'langs': [{'name': l, 'count': 1} for l in langs], 'periods': len(PERIODS)})
        if p == '/api/periods':
            return self._json({'tf': 'daily', 'periods': PERIODS, 'count': len(DAILY)})
        if p == '/tr.json':
            return self._json({})
        if p == '/api/tr':
            return self._json({'zh': []})
        self._json({'error': 'mock: not implemented ' + p}, 404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    print('preview on http://127.0.0.1:%d/' % port, flush=True)
    srv.serve_forever()
