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
ORDINARY_WORD = re.compile(r'^[a-z]{3,}$')

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
    # 纯专有名词也不必翻：「Visual Studio Code」「Nano vLLM」「SAM 3D Objects」。
    # 判据必须比「单词数 <= 4」更严：那个阈值把「A hive mind communication
    # platform」「Self-hosted deployment platform」这类正常短句也当成专有名词跳过了，
    # 于是它们永远进不了云端译表，前端每次刷到都要走实时翻译。
    # 真正的专有名词没有普通小写单词（camelCase / 首字母大写 / 带数字）。
    words = re.findall(r'[A-Za-z][A-Za-z\-\.]{1,}', t)
    if len(words) > 4:
        return False
    return not any(ORDINARY_WORD.match(w) for w in words)

def strip_index(x):
    m = INDEX_PREFIX.match(x)
    return x[m.end():] if m else x

def http(method, url, data=None, headers=None, timeout=120, stdin_text=None):
    """发送 HTTP 请求，返回 (http_status, body)。网络层失败时 http_status = 0。

    ★ stdin_text 走 --data-binary @-（不落临时文件）。
      早先所有线程共写 /tmp/_gem.json，并发时会读到别的批次的请求体：
      轻则 JSON 截断报 400，重则把 B 批的译文写进 A 批的键下，永久污染 KV。
      现在请求体只走管道，不再有共享路径。

    ★★ 返回值第一个元素必须是 **HTTP 状态码**，不是 curl 的 returncode。
      旧实现 `return r.returncode, r.stdout` 且没加 -f/-w，等于永远返回 0：
      401/403/429/502 全都「看起来成功」，调用方只能靠 body 是不是 JSON 猜。
      实测代价：KV 读失败返回 {"success":false,...} 被当成译表写回，
      1865 条译文会在下一轮被覆盖清空（详见 kv_get 的注释）。
    """
    cmd = ['curl', '-s', '--noproxy', '*', '-m', str(timeout),
           '-w', '\n%{http_code}', '-X', method, url]
    for k, v in (headers or {}).items():
        cmd += ['-H', '%s: %s' % (k, v)]
    if stdin_text is not None:
        cmd += ['--data-binary', '@-']
    elif data is not None:
        cmd += ['--data-binary', '@' + data]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', input=stdin_text)
    out = r.stdout or ''
    if r.returncode != 0:
        return 0, out
    # curl -w 把状态码追加在最后一行；body 本身可能含换行，必须 rsplit 一次
    head, sep, tail = out.rstrip('\n').rpartition('\n')
    if not sep:
        return 0, out
    try:
        return int(tail.strip()), head
    except ValueError:
        return 0, out

class KvUnavailable(RuntimeError):
    """KV 读失败（非 404）。绝不能让调用方把它当成「译表是空的」。"""


def kv_get(key):
    """读 KV。返回 dict；key 不存在返回 None；其它任何异常抛 KvUnavailable。

    ★★ 这是整个项目最危险的一处：main() 里写的是 `table = kv_get('tr.json') or {}`。
      只要 kv_get 在「读不到」时返回 None，table 就变成 {}，
      随后本轮翻译出的几十条会作为**整份译表**写回 KV —— 1865 条历史译文一次清空。

      旧实现的三种失败路径全部踩这个坑：
        ① curl 网络失败（旧 http() 返回 returncode，永远 0，看不出失败）
        ② HTTP 502/500 返回 HTML → json.loads 抛异常 → None
        ③ HTTP 401/403/429 返回 {"success":false,"errors":[...]} → json.loads 成功、
           字典 truthy → 直接当译表用，错误字段混进 tr.json 写回线上
      实测：无效 token 时 API 返回 401 + 上述 JSON 形态，旧代码会把它当表。

      现在：404（key 真的不存在，首次运行）才返回 None；其余一律抛异常让任务失败。
      失败是可见的，清空是不可见的 —— 宁可当天不翻译，也不能丢掉已有的表。
    """
    code, out = http('GET',
                     'https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/%s'
                     % (CF_ACC, KV_ID, key),
                     headers={'Authorization': 'Bearer ' + CF_TOK})
    if code == 404:
        return None
    if code != 200:
        raise KvUnavailable('KV GET %s 失败：HTTP %s %s' % (key, code, out[:200]))
    try:
        obj = json.loads(out)
    except Exception as e:
        raise KvUnavailable('KV GET %s 返回非 JSON（HTTP %s）：%s' % (key, code, out[:200]))
    # 结构自检：译表必须是「字符串 → 字符串」的扁平字典。
    # 任何别的形态（API 错误体、数组、嵌套对象）都说明拿到的不是译表。
    if not isinstance(obj, dict):
        raise KvUnavailable('KV GET %s 返回的不是字典：%r' % (key, type(obj).__name__))
    if 'success' in obj and obj.get('success') is False:
        raise KvUnavailable('KV GET %s 返回 API 错误体：%s'
                            % (key, json.dumps(obj.get('errors'), ensure_ascii=False)[:200]))
    return obj


def kv_put(key, obj):
    code, out = http('PUT',
                     'https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/%s'
                     % (CF_ACC, KV_ID, key),
                     headers={'Authorization': 'Bearer ' + CF_TOK,
                              'Content-Type': 'application/json'},
                     stdin_text=json.dumps(obj, ensure_ascii=False, separators=(',', ':')))
    if code != 200:
        return False
    try:
        return json.loads(out).get('success', False)
    except Exception:
        return False

def fetch_up(tf):
    code, out = http('GET', UP + tf + '/' + tf + '-all.json',
                     headers={'user-agent': UA}, timeout=180)
    if code != 200 or not out.strip():
        raise RuntimeError('%s 下载失败 HTTP=%s' % (tf, code))
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
            if code != 200 or not out.strip():
                # 429/5xx 也要看清：旧实现 `code != 0` 恒假，靠 body 里找 "429" 猜
                if code == 429:
                    saw_rate = True
                    break
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
                parts_all = cand['content']['parts']
                # 推理模型会额外返回 thought 块（带 thought:true）；拼进去会污染译文。
                txt = ''.join(p.get('text', '') for p in parts_all if not p.get('thought'))
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
    try:
        table = kv_get('tr.json')
    except KvUnavailable as e:
        # 读不到就立刻失败：绝不能当成空表继续，否则本轮写回会清空历史译文
        log('✗ %s' % e)
        log('✗ 中止：读不到现有译表时写回会覆盖掉全部历史译文')
        return 1
    if table is None:
        log('    KV 里还没有 tr.json（首次运行），从空表开始')
        table = {}
    before = len(table)
    log('    已有 %d 条' % before)

    # 清理历史脏数据：早期版本没剥序号前缀，会把「1. 原文」当成译文写进 KV。
    # 这些条目的值剥掉序号后与原文一致，等于没翻，删掉让它们下一轮重翻。
    dirty = [k for k, v in table.items()
             if isinstance(v, str) and v.strip() != k.strip() and strip_index(v).strip() == k.strip()]
    # 第二类：值带序号前缀，但原文本身就是中文（is_zh 为真 → 永远进不了 todo，
    # 只会一直留在表里当错误译文，前端「看中文」显示「3. 基于 Selkies…」）。
    dirty += [k for k, v in table.items()
              if k not in dirty and isinstance(v, str) and INDEX_PREFIX.match(v) and is_zh(k)]
    for k in dirty:
        del table[k]
    if dirty:
        log('    清理无效译文 %d 条（序号前缀 / 原文已是中文）' % len(dirty))

    todo = [t for t in texts if t not in table]
    log('3/5 新增 %d 条' % len(todo))
    if not todo and not dirty:
        log('无新增，结束（%.1fs）' % (time.time() - t0))
        return 0
    if not todo:
        # 只有脏数据要清：直接写回，不要因为「没有新文本」把清理结果丢掉
        log('5/5 写回清理后的译表')
        if not kv_put('tr.json', table):
            log('    写入失败')
            return 1
        log('完成：清理 %d 条，总 %d 条，用时 %.0fs' % (len(dirty), len(table), time.time() - t0))
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
    # ★ pending = 尚未处理完的批次数（排队中 + 正在跑）。
    #   旧实现用 q.get_nowait()，队列一空线程就 return；而「对不齐 → 对半拆开
    #   重新入队」发生在别的线程已经退出之后，于是拆分出来的两半只能靠最后一个
    #   线程串行善后，若它再撞 5 次限流，剩余批次直接丢弃且不报错。
    pending = [len(batches)]

    def worker(idx):
        k = GEMINI_KEYS[idx]
        while not stop.is_set():
            with lock:
                if pending[0] <= 0:
                    return
            try:
                batch = q.get(timeout=1)
            except queue.Empty:
                continue
            try:
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
                            with lock:
                                pending[0] += 2      # 两半重新排队
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
            finally:
                with lock:
                    pending[0] -= 1

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