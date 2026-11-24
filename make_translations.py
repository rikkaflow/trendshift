#!/usr/bin/env python3
"""把 /tmp/ts_corpus.json 的英文文本批量翻成中文，产出静态译表。

通道：本地模型组 codebuddy-global/deepseek-v4.1-flash（1M 上下文，免费）
      一次喂 200 条 / ~2 万字符，实测 16s/150 条；多并发再线性加速。

断点续跑：已翻好的写进 /tmp/ts_translated.json，中断后重跑只补缺口。
并发：-j N 同时跑 N 个 minis-model-use 进程（默认 6）。

用法：
  python3 make_translations.py            # 增量补齐
  python3 make_translations.py -j 8       # 8 并发
  python3 make_translations.py --status   # 只看进度
  python3 make_translations.py --rebuild  # 全量重跑
"""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

CORPUS = Path('/tmp/ts_corpus.json')
DONE = Path('/tmp/ts_translated.json')
TMPDIR = Path('/tmp/trwork')
MODEL = 'codebuddy-global/deepseek-v4.1-flash'
BATCH_ITEMS = 100
BATCH_CHARS = 10000
SPLIT = '<|SPLIT|>'

SYS = (
    'You are a translation engine. Translate each numbered item into natural Simplified Chinese. '
    'Items may contain multiple lines; preserve their internal line breaks. '
    'Keep repo names, product names, code identifiers, version numbers, URLs and license names '
    'unchanged. If an item is already Chinese, output it unchanged. '
    'Output exactly the same number of items separated by the marker ' + SPLIT + ' on its own line. '
    'No explanations, no extra blank items.'
)

lock = threading.Lock()
state = {'done': 0, 'total': 0, 'fails': 0, 'batches': 0, 'nbatch': 0, 't0': 0.0}


def strip_index(seg, expect):
    """剥掉模型自作主张加的序号，只剥与预期序号完全一致的那一个。

    精确匹配索引而非裸正则，避免把「3.5 倍提升」截成「5 倍提升」。
    """
    m = re.match(r'^\s*(\d{1,4})\s*[.、)）]\s*', seg)
    if m and int(m.group(1)) == expect:
        return seg[m.end():]
    return seg.lstrip('\n')


def pack(todo):
    batch, chars = [], 0
    for t in todo:
        if batch and (len(batch) >= BATCH_ITEMS or chars + len(t) > BATCH_CHARS):
            yield batch
            batch, chars = [], 0
        batch.append(t)
        chars += len(t)
    if batch:
        yield batch


def translate(batch, slot, tries=3):
    payload = {
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': SYS},
            {'role': 'user', 'content': ('\n' + SPLIT + '\n').join(
                '%d. %s' % (i + 1, t) for i, t in enumerate(batch))},
        ],
        'temperature': 0,
    }
    src = TMPDIR / ('in_%d.json' % slot)
    dst = TMPDIR / ('out_%d.txt' % slot)
    src.write_text(json.dumps(payload, ensure_ascii=False))

    last = ''
    for attempt in range(tries):
        if dst.exists():
            dst.unlink()
        try:
            r = subprocess.run(
                ['minis-model-use', 'run', '--model', MODEL,
                 '--input', str(src), '--output', str(dst)],
                capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            last = 'timeout'
            continue
        if r.returncode != 0:
            last = 'rc=%d %s' % (r.returncode, (r.stderr or r.stdout)[:160])
            time.sleep(3)
            continue
        out = dst.read_text(encoding='utf-8') if dst.exists() else ''
        if not out.strip():
            last = 'empty'
            time.sleep(3)
            continue
        parts = [strip_index(p, i + 1) for i, p in enumerate(out.split(SPLIT))]
        parts = [p.strip('\n') for p in parts]
        if len(parts) != len(batch):
            last = 'align %d/%d' % (len(parts), len(batch))
            time.sleep(2)
            continue
        return parts
    raise RuntimeError(last or 'failed')


def save(done):
    DONE.write_text(json.dumps(done, ensure_ascii=False, indent=0))


def worker(slot, queue, done):
    while True:
        with lock:
            if not queue:
                return
            batch = queue.pop(0)
        try:
            got = translate(batch, slot)
        except Exception as e:
            with lock:
                state['fails'] += 1
                state['batches'] += 1
                print('  [%d/%d] 失败：%s（跳过 %d 条）'
                      % (state['batches'], state['nbatch'], e, len(batch)), flush=True)
            continue
        with lock:
            for src_t, zh in zip(batch, got):
                if zh and zh.strip():
                    done[src_t] = zh.strip()
            save(done)
            state['batches'] += 1
            state['done'] = len(done)
            print('  [%d/%d] 累计 %d/%d  %.0fs'
                  % (state['batches'], state['nbatch'], len(done),
                     state['total'], time.time() - state['t0']), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-j', '--jobs', type=int, default=6)
    ap.add_argument('--status', action='store_true')
    ap.add_argument('--rebuild', action='store_true')
    args = ap.parse_args()

    corpus = json.loads(CORPUS.read_text())
    texts = corpus['texts']

    done = {}
    if DONE.exists() and not args.rebuild:
        try:
            done = json.loads(DONE.read_text())
        except Exception:
            done = {}

    if args.status:
        miss = [t for t in texts if t not in done]
        print('语料 %d 条，已译 %d 条，剩余 %d 条' % (len(texts), len(done), len(miss)))
        return 0

    todo = [t for t in texts if t not in done]
    if not todo:
        print('全部已译完：%d 条' % len(done))
        return 0

    queue = list(pack(todo))
    TMPDIR.mkdir(parents=True, exist_ok=True)
    state.update({'total': len(texts), 'nbatch': len(queue), 't0': time.time()})
    print('待译 %d / %d 条，共 %d 批，并发 %d'
          % (len(todo), len(texts), len(queue), args.jobs), flush=True)

    threads = [threading.Thread(target=worker, args=(i, queue, done), daemon=True)
               for i in range(min(args.jobs, len(queue)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    save(done)
    print('完成：%d 条 → %s（失败批 %d，%.0fs）'
          % (len(done), DONE, state['fails'], time.time() - state['t0']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
