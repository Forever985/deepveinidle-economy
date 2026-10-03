#!/usr/bin/env bash
# 把 web/dist 发布到 gh-pages 分支。
#
# 为什么不走 Node 脚本：某些受限环境里 Node 的 spawnSync 派发外部可执行文件
# 会直接 EBUSY，而 git 本身在普通 shell 里是好的。这里用纯 bash 实现。
#
# 用法：bash scripts/publish-gh-pages.sh <仓库地址>
set -euo pipefail

REPO="${1:-}"
DIST_IN="${2:-web/dist}"

if [ -z "$REPO" ]; then
  echo "用法: bash scripts/publish-gh-pages.sh <仓库地址> [构建产物目录]" >&2
  exit 1
fi

# ★ 必须在 cd 之前把路径解析成绝对路径 ——
#   下面会 cd 到临时目录，届时相对路径就失效了。
case "$DIST_IN" in
  /*|[A-Za-z]:*) DIST="$DIST_IN" ;;
  *)               DIST="$(cd "$(dirname "$DIST_IN")" && pwd)/$(basename "$DIST_IN")" ;;
esac

if [ ! -f "$DIST/index.html" ]; then
  echo "构建产物不存在或缺少 index.html: $DIST" >&2
  exit 1
fi

echo "仓库 : $REPO"
echo "产物 : $DIST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
# 关掉自动换行转换：构建产物应原样发布，CRLF 只会无谓地改动文件
git init -q
git config core.autocrlf false
git remote add origin "$REPO"
git checkout -q --orphan gh-pages

cp -r "$DIST"/. .
echo "--- 待发布内容 ---"
find . -type f -not -path './.git/*' | sed 's|^\./|  |'

git add -A
git commit -q -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')"

echo "--- 推送到 gh-pages ---"
for i in 1 2 3; do
  if git push origin gh-pages; then
    echo "PUBLISH_OK"
    exit 0
  fi
  echo "第 $i 次推送失败，3 秒后重试 ..." >&2
  sleep 3
done

echo "PUBLISH_FAIL：连续 3 次推送失败" >&2
exit 1
