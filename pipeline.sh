#!/bin/sh
# Trendshift 增量更新流水线：抓取 → 增量翻译 → 导出译表 → 打包 → 部署 → 验证
#
# 设计要点：
#   * 全流程幂等。已译过的文本永不重译（译表按原文哈希存档），
#     所以每天跑一次通常只需翻新增的几十条，几十秒结束。
#   * 断点续跑。任一步失败直接 exit 非零，重跑会从断点继续，
#     不会重复消耗模型额度。
#   * 译表存档在 src/translations.json，随代码一起版本化，
#     新机器 clone 下来就自带全部历史译文。
#
# 用法：
#   ./pipeline.sh              # 全量流水线
#   ./pipeline.sh --no-deploy  # 只跑到打包，不上传
#
# 建议每天跑一次（crontab / 定时任务 / 手动）：
#   0 4 * * * cd /path/to/src && ./pipeline.sh >> /var/minis/shared/trendshift-lite/pipeline.log 2>&1
set -e

cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
LOG="$ROOT/pipeline.log"

log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== 开始 ==="

# ── 1. 抓取全站语料（走线上 Worker 只读接口）────────────────
log "1/5 抓取语料"
if ! python3 collect_texts.py >>"$LOG" 2>&1; then
  log "✗ 抓取失败，中止"
  exit 1
fi
CORPUS_N=$(python3 -c "import json;print(len(json.load(open('/tmp/ts_corpus.json'))['texts']))")
log "    语料 $CORPUS_N 条"

# ── 2. 增量翻译（只翻新增，已译的跳过）─────────────────────
log "2/5 增量翻译"
MISS=$(python3 make_translations.py --status | sed -n 's/.*剩余 \([0-9]*\) 条.*/\1/p')
log "    待译 $MISS 条"
if [ "${MISS:-0}" -gt 0 ]; then
  JOBS=${TR_JOBS:-8}
  if ! python3 -u make_translations.py -j "$JOBS" >>"$LOG" 2>&1; then
    log "✗ 翻译失败，中止（已翻部分已存盘，重跑会续）"
    exit 1
  fi
else
  log "    无新增，跳过"
fi

# ── 3. 导出静态译表 ────────────────────────────────────
log "3/5 导出译表"
python3 export_translations.py >>"$LOG" 2>&1

# ── 4. 打包（静态资源 + 译表内联进 Worker）────────────────
log "4/5 打包"
python3 build_worker.py >>"$LOG" 2>&1
if ! node --check /tmp/ts_worker.js 2>>"$LOG"; then
  log "✗ Worker 语法检查失败，中止"
  exit 1
fi
SZ=$(wc -c < /tmp/ts_worker.js)
GZ=$(gzip -c /tmp/ts_worker.js | wc -c)
log "    产物 ${SZ}B / gzip ${GZ}B"

if [ "$1" = "--no-deploy" ]; then
  log "=== 完成（未部署）==="
  exit 0
fi

# ── 5. 部署 + 验证 ─────────────────────────────────────
log "5/5 部署"
if [ -z "$CF_API_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; then
  log "✗ 缺少 CF_API_TOKEN / CF_ACCOUNT_ID"
  exit 1
fi

# urllib 在本机偶发 SSL UNEXPECTED_EOF，用 curl 更稳
HTTP=$(curl -s --noproxy '*' -m 180 -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/trendshift-lite" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @/tmp/ts_worker.js \
  -o /tmp/_dep.json -w '%{http_code}')
if [ "$HTTP" != "200" ]; then
  log "✗ 上传失败 http=$HTTP"
  head -c 400 /tmp/_dep.json | tee -a "$LOG"
  exit 1
fi

B=https://trendshift-lite.logos7313.workers.dev
sleep 3
curl -sf --noproxy '*' -m 30 "$B/health" -o /tmp/_h.json
grep -q '"ok":true' /tmp/_h.json || { log "✗ /health 异常"; exit 1; }

curl -sf --noproxy '*' -m 60 "$B/tr.json" -o /tmp/_tr2.json
TR_N=$(python3 -c "import json;print(len(json.load(open('/tmp/_tr2.json'))))")
log "    线上译表 $TR_N 条"

curl -sf --noproxy '*' -m 40 "$B/api/list?tf=weekly&lang=all&limit=2" -o /tmp/_l.json
grep -q '"items"' /tmp/_l.json || { log "✗ /api/list 异常"; exit 1; }

log "=== 完成：$B/ ==="
