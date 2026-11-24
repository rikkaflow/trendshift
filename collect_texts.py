#!/usr/bin/env python3
"""收集 Trendshift 全站所有需要翻译的英文文本，输出 /tmp/ts_corpus.json。

数据源（全部经由 Worker 的只读接口拿）：
  weekly / daily / monthly 全部期次的 items[].d
  topics 的 display_name
  devs 的 bio
  mentions 的 text
  ghtrending 的 d

两条加速：
  ① 并发抓取（-j 16），200 个期次从几分钟降到十几秒
  ② 期次级缓存：历史期次内容不再变化，抓过一次存进 periods_cache.json，
     日常增量只抓新期次 + 最近 REFRESH_RECENT 期（可能仍在更新）

输出：{"texts": [...唯一文本...]}
"""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = 'https://trendshift-lite.logos7313.workers.dev'
OUT = Path('/tmp/ts_corpus.json')
CACHE = Path(__file__).resolve().parent.parent / 'periods_cache.json'
REFRESH_RECENT = 2          # 每类最近 N 期每次都重抓（可能还在涨）

KANA = re.compile(r'[\u3040-\u30ff]')
HANGUL = re.compile(r'[\uac00-\ud7af]')
HAN = re.compile(r'[\u4e00-\u9fa5]')
LAT = re.compile(r'[A-Za-z]')

MAXLEN = 600                # 超长推文不翻，前端也不翻


def is_zh(t):
    """已经是中文的就不用翻了（日文/韩文含汉字，不能只看汉字）。"""
    if not t:
        return False
    if KANA.search(t) or HANGUL.search(t):
        return False
    h = len(HAN.findall(t))
    l = len(LAT.findall(t))
    return h > 0 and h >= l


def get(path, timeout=60, retries=5):
    """用 curl 子进程抓：urllib 在 PRoot 下对较大响应会报 Errno 38（sendfile 不可用）。"""
    last = None
    for i in range(retries):
        try:
            r = subprocess.run(
                ['curl', '-s', '--noproxy', '*', '-m', str(timeout),
                 '-H', 'user-agent: ts-collect/1.0', BASE + path],
                capture_output=True, text=True, timeout=timeout + 15)
            if r.returncode == 0 and r.stdout.strip():
                return json.loads(r.stdout)
            last = RuntimeError('curl rc=%d %s' % (r.returncode, r.stderr[:100]))
        except Exception as e:
            last = e
        time.sleep(2.0 * (i + 1))
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-j', '--jobs', type=int, default=8)
    ap.add_argument('--full', action='store_true', help='忽略缓存全量重抓')
    args = ap.parse_args()

    texts = {}
    lock = threading.Lock()

    def add(t):
        t = (t or '').strip()
        if not t or is_zh(t) or len(t) > MAXLEN:
            return
        with lock:
            texts[t] = 1

    cache = {}
    if CACHE.exists() and not args.full:
        try:
            cache = json.loads(CACHE.read_text())
        except Exception:
            cache = {}

    t0 = time.time()
    jobs = []

    # ① 三个榜单：先拿期次列表，再决定哪些需要抓
    for tf in ('weekly', 'daily', 'monthly'):
        try:
            d = get('/api/list?tf=%s&lang=all&limit=5' % tf)
        except Exception as e:
            print('skip %s 期次列表: %s' % (tf, e), flush=True)
            continue
        periods = d.get('periods') or []
        need = periods[:REFRESH_RECENT] + [
            p for p in periods[REFRESH_RECENT:] if ('%s:%s' % (tf, p)) not in cache]
        print('%s: %d 期，需抓 %d 期（缓存命中 %d）'
              % (tf, len(periods), len(need), len(periods) - len(need)), flush=True)
        jobs += [(tf, p) for p in need]
        # 缓存里已有的先灌进来，保证语料完整
        for p in periods:
            for t in cache.get('%s:%s' % (tf, p), []):
                add(t)

    # ② 其他栏目每次都抓（只有 4 个请求）
    def other(path, key):
        try:
            d = get(path)
        except Exception as e:
            print('skip %s: %s' % (path, e), flush=True)
            return
        for it in d.get(key) or []:
            if path == '/api/topics':
                add(it.get('display_name') or it.get('name'))
            elif path == '/api/devs':
                add(it.get('bio'))
            elif path == '/api/mentions':
                add(it.get('text'))
            else:
                add(it.get('d'))

    # ③ 并发抓期次
    done = [0]

    def fetch(job):
        tf, p = job
        key = '%s:%s' % (tf, p)
        try:
            dd = get('/api/list?tf=%s&lang=all&period=%s&limit=1000' % (tf, p))
        except Exception as e:
            print('  skip %s: %s' % (key, e), flush=True)
            return
        vals = []
        for it in dd.get('items', []):
            v = (it.get('d') or '').strip()
            if v and not is_zh(v) and len(v) <= MAXLEN:
                vals.append(v)
                add(v)
        with lock:
            cache[key] = vals
            done[0] += 1
            if done[0] % 40 == 0:
                print('  抓取 %d/%d 累计 %d 条  %.0fs'
                      % (done[0], len(jobs), len(texts), time.time() - t0), flush=True)

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        list(ex.map(fetch, jobs))

    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(lambda a: other(*a), [
            ('/api/topics', 'topics'),
            ('/api/devs', 'items'),
            ('/api/mentions', 'items'),
            ('/api/ghtrending', 'items'),
        ]))

    CACHE.write_text(json.dumps(cache, ensure_ascii=False, separators=(',', ':')),
                     encoding='utf-8')

    items = sorted(texts.keys())
    chars = sum(len(t) for t in items)
    OUT.write_text(json.dumps({'texts': items}, ensure_ascii=False), encoding='utf-8')
    print('\n唯一待译 %d 条 / %d 字符  用时 %.0fs' % (len(items), chars, time.time() - t0))
    print('输出 %s (%d bytes)；期次缓存 %d 期 %d bytes'
          % (OUT, OUT.stat().st_size, len(cache), CACHE.stat().st_size))


if __name__ == '__main__':
    main()
