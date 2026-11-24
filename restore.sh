#!/bin/sh
# 从 GitHub 或 bundle 恢复 Trendshift 源码，并校验完整性
#
# 用法：
#   ./restore.sh github     # 从 GitHub 克隆（推荐，跨设备可用）
#   ./restore.sh bundle     # 从本地 bundle 恢复（离线/无 token 时）
#
# 恢复后可直接 ./deploy.sh 重新部署。
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-}"
MODE="${2:-github}"

if [ -z "$DEST" ]; then
  echo "用法：$0 <目标目录> [github|bundle]" >&2
  exit 1
fi

if [ "$MODE" = "bundle" ]; then
  for cand in "$HERE/trendshift-v6.bundle" "$HERE/backup/trendshift-v6.bundle" \
              "$HERE/../backup/trendshift-v6.bundle"; do
    [ -f "$cand" ] && BUNDLE="$cand" && break
  done
  [ -n "$BUNDLE" ] || {
    echo "找不到 trendshift-v6.bundle（bundle 不进 git，需从备份目录复制）" >&2
    echo "改用：$0 <目录> github" >&2
    exit 1
  }
  echo "→ 从 bundle 恢复"
  git clone -q "$BUNDLE" "$DEST"
else
  echo "→ 从 GitHub 克隆"
  git clone -q https://github.com/rikkaflow/trendshift.git "$DEST"
fi

cd "$DEST"
echo "→ 恢复完成，提交：$(git rev-parse --short HEAD)"
echo "→ 标签：$(git tag | tr '\n' ' ')"
echo
echo "下一步："
echo "  cd $DEST && ./deploy.sh"
