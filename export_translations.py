#!/usr/bin/env python3
"""把 /tmp/ts_translated.json 落成 src/translations.json（构建期静态资源）。

只保留语料里真实出现的键，并按体积裁剪：单条 > 800 字符的长推文不内联
（前端会退化成实时翻译，但这类文本极少）。

用法：
  python3 export_translations.py
"""
import json
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
CORPUS = Path('/tmp/ts_corpus.json')
DONE = Path('/tmp/ts_translated.json')
OUT = SRC / 'translations.json'

MAX_LEN = 800


def main():
    corpus = json.loads(CORPUS.read_text())['texts']
    done = json.loads(DONE.read_text())

    table = {}
    skipped = 0
    for t in corpus:
        zh = done.get(t)
        if not zh or zh == t:
            continue          # 原文已是中文 / 未译，不必内联
        if len(zh) > MAX_LEN:
            skipped += 1
            continue
        table[t] = zh

    OUT.write_text(json.dumps(table, ensure_ascii=False, separators=(',', ':')),
                   encoding='utf-8')
    raw = OUT.stat().st_size
    print('译表 %d 条，%d 字节（%.1f KB）；跳过超长 %d 条；语料 %d 条'
          % (len(table), raw, raw / 1024, skipped, len(corpus)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
