#!/usr/bin/env python3
"""云端增量翻译任务：抓上游 → 找新增 → 调 Gemini 翻译 → 合并 → 写 KV。

跑在 GitHub Actions（.github/workflows/translate.yml），本地完全不需要开机。
数据来源是上游静态镜像的整份 JSON（一次请求拿到全部期次），
不需要逐期抓 200 次请求。

流程：
  1. 下载 weekly/daily/monthly 三个 JSON（并发，3 个请求）
  2. 抽出所有英文 description，去重
  3. 读 KV 里现有译表，算出新增
  4. 用 Gemini lite 多 key 并发翻译新增条目
  5. 合并写回 KV（只写一份 tr.json）

环境变量：
  CF_ACCOUNT_ID / CF_API_TOKEN / TR_KV_ID / GEMINI_KEYS
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

UP = 'https://quantavil.github.io/trendshift/data/'
UA = 'Mozilla/5.0 (compatible; TrendshiftBot/1.0)'

CF_ACC = os.environ.get('CF_ACCOUNT_ID', '')
CF_TOK = os.environ.get('CF_API_TOKEN', '')
KV_ID = os.environ.get('TR_KV_ID', '6a486ed588b24fb889fbd459668a5341')
GEMINI_KEYS = [k.strip() for k in re.split(r'[\s,;]+', os.environ.get('GEMINI_KEYS', '')) if k.strip()]

MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest']
BATCH_CHARS = 9000          # 单次请求的字符预算
BATCH_ITEMS = 80
SPLIT = '<|SPLIT|>'
MAXLEN = 600                # 超长简介不翻（前端也会跳过）
MAX_RATE_RETRY = 5          # 同一批最多被限流的重试次数（20s × 5 = 100s 上限）

KANA = re.compile(r'[\u3040-\u30ff]')
HANGUL = re.compile(r'[\uac00-\ud7af]')
HAN = re.compile(r'[\u4e00-\u9fa5]')
LAT = re.compile(r'[A-Za-z]')
# 模型偶尔会把条目编号一起回吐（「1. 译文」）。必须剥掉，否则会被当成译文写进 KV。
# 「.」和「)」后必须跟空白，避免把「3.5 倍提升」切成「5 倍提升」。
INDEX_PREFIX = re.compile(r'^(?:\d{1,2}[.)]\s+|\d{1,2}、\s*)')

def log(*a):
    print(*a, flush=True)

def is_zh(t):
    """已经是中文（或中英混排、纯专有名词）就不必翻译。

    判据：含汉字即视为中文；有效英文单词 <= 4 视为纯专有名词。
    前端 index.html 的 isChinese() 用同一套判据——两处不一致会导致
    后台跳过的条目在前端每次都被送去实时翻译，既耗额度又慢。
    """
    if not t:
        return False
    if KANA.search(t) or HANGUL.search(t):
        return False
    # 只要有汉字就认为作者已经在用中文表达；混排里的英文基本都是
    # repo 名 / 产品名 / 版本号，翻它只会把专有名词也译坏。
    if len(HAN.findall(t)) > 0:
        return True
    # 纯专有名词也不必翻：「Visual Studio Code」「Nano vLLM」「SAM 3D Objects」
    words = re.findall(r'[A-Za-z][A-Za-z\-\.]{1,}', t)
    return len(words) <= 4

def strip_index(x):
    m = INDEX_PREFIX.match(x)
    return x[m.end():] if m else x

def http(method, url, data=None, headers=None, timeout=120, stdin_text=None):
    """发送 HTTP 请求。stdin_text 走 --data-binary @-（不落临时文件）。

    ★ 早先所有线程共写 /tmp/_gem.json，并发时会读到别的批次的请求体：
      轻则 JSON 截断报 400，重则把 B 批的译文写进 A 批的键下，永久污染 KV。
      现在请求体只走管道，不再有共享路径。
    """
    cmd = ['curl', '-s', '--noproxy', '*', '-m', str(timeout), '-X', method, url]
    for k, v in (headers or {}).items():
        cmd += ['-H', '%s: %s' % (k, v)]
    if stdin_text is not None:
        cmd += ['--data-binary', '@-']
    elif data is not None:
        cmd += ['--data-binary', '@' + data]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', input=stdin_text)
    return r.returncode, r.stdout

def kv_get(key):
    code, out = http('GET',
                     'https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/%s'
                     % (CF_ACC, KV_ID, key),
                     headers={'Authorization': 'Bearer ' + CF_TOK})
    if code != 0:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None

def kv_put(key, obj):
    code, out = http('PUT',
                     'https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/%s'
                     % (CF_ACC, KV_ID, key),
                     headers={'Authorization': 'Bearer ' + CF_TOK,
                              'Content-Type': 'application/json'},
                     stdin_text=json.dumps(obj, ensure_ascii=False, separators=(',', ':')))
    try:
        return json.loads(out).get('success', False)
    except Exception:
        return False

def fetch_up(tf):
    code, out = http('GET', UP + tf + '/' + tf + '-all.json',
                     headers={'user-agent': UA}, timeout=180)
    if code != 0 or not out.strip():
        raise RuntimeError('%s 下载失败 rc=%d' % (tf, code))
    return json.loads(out)

def collect():
    """从三个上游 JSON 抽出所有待译文本。"""
    texts = set()
    with ThreadPoolExecutor(max_workers=3) as ex:
        datas = list(ex.map(fetch_up, ('weekly', 'daily', 'monthly')))
    for rows in datas:
        for e in rows:
            d = (e.get('description') or '').strip()
            if d and not is_zh(d) and len(d) <= MAXLEN:
                texts.add(d)
    return sorted(texts)

def gemini_translate(batch, key):
    """单 key 翻译一批。返回 list / 'RATE' / None。

    免费档 lite 模型经常 503（high demand），必须退避重试；
    多个模型之间也要轮流试，单一模型被限流时还能救回来。
    """
    body = {
        'contents': [{'parts': [{'text': (
            'Translate each numbered item into natural Simplified Chinese. '
            'Keep repo names, product names, code identifiers, version numbers and URLs unchanged. '
            'Output exactly the same number of items separated by ' + SPLIT +
            ' on its own line. No numbering, no explanations.\n\n' +
            # ★ 分隔符必须插在条目之间：「'\n' + SPLIT + '\n'.join(...)」因运算符
            #   优先级只会在最前面放一个 SPLIT，条目之间全是裸换行。
            ('\n' + SPLIT + '\n').join('%d. %s' % (i + 1, t) for i, t in enumerate(batch))
        )}]}],
        'generationConfig': {'temperature': 0, 'maxOutputTokens': 8192},
    }
    payload = json.dumps(body, ensure_ascii=False)

    saw_rate = False
    for attempt in range(4):
        for model in MODELS:
            url = ('https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s'
                   % (model, key))
            code, out = http('POST', url, headers={'Content-Type': 'application/json'},
                             timeout=180, stdin_text=payload)
            if code != 0 or not out.strip():
                continue
            try:
                d = json.loads(out)
            except Exception:
                continue
            if 'error' in d:
                msg = json.dumps(d['error'], ensure_ascii=False)
                if '429' in msg or 'RESOURCE_EXHAUSTED' in msg:
                    saw_rate = True
                    break            # 换 key 才有意义，别在这把模型都试一遍
                continue             # 503 / 500 / 模型不可用 → 试下一个模型
            try:
                cand = d['candidates'][0]
                txt = cand['content']['parts'][0]['text']
            except Exception:
                continue
            parts = [strip_index(x.strip()).strip() for x in txt.split(SPLIT)]
            if len(parts) != len(batch):
                # 被截断或合并：多半是批次太大，交给上层拆小重试
                continue
            return parts
        if saw_rate:
            return 'RATE'
        time.sleep(3 * (attempt + 1))    # 503 退避：3s / 6s / 9s
    return None

def main():
    if not (CF_ACC and CF_TOK):
        log('缺少 CF_ACCOUNT_ID / CF_API_TOKEN')
        return 1
    if not GEMINI_KEYS:
        log('缺少 GEMINI_KEYS')
        return 1

    t0 = time.time()
    log('1/5 下载上游数据')
    texts = collect()
    log('    待译语料 %d 条 / %d 字符' % (len(texts), sum(len(t) for t in texts)))

    log('2/5 读取现有译表')
    table = kv_get('tr.json') or {}
    log('    已有 %d 条' % len(table))

    # 清理历史脏数据：早期版本没剥序号前缀，会把「1. 原文」当成译文写进 KV。
    # 这些条目的值剥掉序号后与原文一致，等于没翻，删掉让它们下一轮重翻。
    dirty = [k for k, v in table.items()
             if isinstance(v, str) and v.strip() != k.strip() and strip_index(v).strip() == k.strip()]
    for k in dirty:
        del table[k]
    if dirty:
        log('    清理「序号前缀 + 原文」的无效译文 %d 条' % len(dirty))

    todo = [t for t in texts if t not in table]
    log('3/5 新增 %d 条' % len(todo))
    if not todo:
        log('无新增，结束（%.1fs）' % (time.time() - t0))
        return 0

    # 打包
    batches, cur, cc = [], [], 0
    for t in todo:
        if cur and (len(cur) >= BATCH_ITEMS or cc + len(t) > BATCH_CHARS):
            batches.append(cur)
            cur, cc = [], 0
        cur.append(t)
        cc += len(t)
    if cur:
        batches.append(cur)
    log('    共 %d 批' % len(batches))

    log('4/5 翻译')
    q = queue.Queue()
    for b in batches:
        q.put(b)
    added = [0]
    fails = [0]
    lock = threading.Lock()
    stop = threading.Event()

    def worker(idx):
        k = GEMINI_KEYS[idx]
        while not stop.is_set():
            try:
                batch = q.get_nowait()
            except queue.Empty:
                return
            rate = 0
            while True:
                res = gemini_translate(batch, k)
                if res == 'RATE':
                    rate += 1
                    if rate > MAX_RATE_RETRY:
                        with lock:
                            fails[0] += 1
                        log('    key#%d 连续限流 %d 次，放弃该批（%d 条）'
                            % (idx + 1, rate, len(batch)))
                        break
                    wait = min(20 * rate, 90)
                    log('    key#%d 限流，退避 %ds（第 %d 次）' % (idx + 1, wait, rate))
                    time.sleep(wait)
                    continue
                if not res:
                    # 对不齐多半是批次太大被截断：对半拆开重试，最小 1 条
                    if len(batch) > 1:
                        mid = len(batch) // 2
                        q.put(batch[:mid])
                        q.put(batch[mid:])
                        log('    key#%d 对不齐，拆成 %d+%d 重试'
                            % (idx + 1, mid, len(batch) - mid))
                    else:
                        with lock:
                            fails[0] += 1
                        log('    key#%d 单条失败，跳过' % (idx + 1))
                    break
                new = 0
                with lock:
                    for src, zh in zip(batch, res):
                        zh = zh.strip()
                        if zh and zh != src:
                            table[src] = zh
                            new += 1
                    added[0] += new
                log('    key#%d 完成一批 +%d，累计新增 %d' % (idx + 1, new, added[0]))
                break

    with ThreadPoolExecutor(max_workers=len(GEMINI_KEYS)) as ex:
        list(ex.map(worker, range(len(GEMINI_KEYS))))

    log('5/5 写回 KV')
    if added[0] == 0 and not dirty:
        log('    没有新译文，跳过写入')
        return 0
    if kv_put('tr.json', table):
        log('    写入成功，译表共 %d 条' % len(table))
    else:
        log('    写入失败')
        return 1

    log('完成：新增 %d 条，总 %d 条，用时 %.0fs（失败批 %d）'
        % (added[0], len(table), time.time() - t0, fails[0]))
    return 0

if __name__ == '__main__':
    sys.exit(main())