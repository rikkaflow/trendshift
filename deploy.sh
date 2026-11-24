#!/bin/sh
# 一键部署 Trendshift 到 Cloudflare Workers
#
# 用法：
#   ./deploy.sh              # 打包并部署（改代码时才需要）
#   ./deploy.sh --dry-run    # 只打包，不部署
#
# 依赖环境变量：CF_API_TOKEN、CF_ACCOUNT_ID（可选 TR_KV_ID）
#
# 注意：日常增量翻译由 GitHub Actions 每天自动写入 KV，不需要跑这个脚本。
#       只有改了 index.html / worker.template.js 等代码才需要重新部署。
set -e

cd "$(dirname "$0")"

if [ -z "$CF_API_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; then
  echo "错误：需要设置 CF_API_TOKEN 和 CF_ACCOUNT_ID 环境变量" >&2
  exit 1
fi

echo "→ 打包静态资源"
python3 build_worker.py

if [ "$1" = "--dry-run" ]; then
  echo "→ dry-run 完成，产物：/tmp/ts_worker.js"
  exit 0
fi

# 必须走 multipart 上传：单文件 PUT 无法携带 TR_KV 绑定，
# 会把 KV 译表读取整条链路弄断（前端退化成实时翻译）。
echo "→ 上传到 Cloudflare（携带 TR_KV 绑定）"
python3 upload_worker.py

echo "→ 验证"
sleep 2
B=https://trendshift-lite.logos7313.workers.dev
# -sf：HTTP 非 2xx 直接失败，避免 Worker 报错时脚本仍打印「完成」
if ! curl -sf --noproxy '*' -m 25 "$B/health" -o /tmp/_h.json; then
  echo "✗ /health 检查失败" >&2; exit 1
fi
if ! grep -q '"ok":true' /tmp/_h.json; then
  echo "✗ /health 返回内容异常" >&2; cat /tmp/_h.json; exit 1
fi
if ! curl -sf --noproxy '*' -m 30 "$B/api/list?tf=weekly&lang=all&limit=2" -o /tmp/_l.json; then
  echo "✗ /api/list 检查失败" >&2; exit 1
fi
if ! grep -q '"items"' /tmp/_l.json; then
  echo "✗ /api/list 返回内容异常" >&2; head -c 300 /tmp/_l.json; exit 1
fi
# 译表必须来自 KV 且条数正常
if ! curl -sf --noproxy '*' -m 40 "$B/tr.json" -o /tmp/_t.json; then
  echo "✗ /tr.json 检查失败" >&2; exit 1
fi
N=$(python3 -c "import json;print(len(json.load(open('/tmp/_t.json'))))")
if [ "$N" -lt 1000 ]; then
  echo "✗ 译表条目异常：$N" >&2; exit 1
fi
echo "✓ 完成：$B/  （译表 $N 条）"
