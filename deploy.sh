#!/bin/sh
# 一键部署 Trendshift 到 Cloudflare Workers
#
# 用法：
#   ./deploy.sh              # 打包并部署
#   ./deploy.sh --dry-run    # 只打包，不部署
#
# 依赖环境变量：CF_API_TOKEN、CF_ACCOUNT_ID
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

echo "→ 上传到 Cloudflare"
python3 - <<'PY'
import os, urllib.request, sys
tok = os.environ['CF_API_TOKEN']
acc = os.environ['CF_ACCOUNT_ID']
body = open('/tmp/ts_worker.js', 'rb').read()
url = f"https://api.cloudflare.com/client/v4/accounts/{acc}/workers/scripts/trendshift-lite"
req = urllib.request.Request(
    url, data=body, method='PUT',
    headers={'Authorization': 'Bearer ' + tok,
             'Content-Type': 'application/javascript'})
try:
    r = urllib.request.urlopen(req, timeout=90)
    print(r.status, 'deployed')
except Exception as e:
    print('ERR', e, getattr(e, 'read', lambda: b'')()[:400], file=sys.stderr)
    sys.exit(1)
PY

echo "→ 验证"
sleep 2
curl -s --noproxy '*' -m 25 https://trendshift-lite.logos7313.workers.dev/health
echo
curl -s --noproxy '*' -m 30 \
  "https://trendshift-lite.logos7313.workers.dev/api/list?tf=weekly&lang=all&limit=2" \
  | head -c 200
echo
echo "✓ 完成：https://trendshift-lite.logos7313.workers.dev/"
