#!/usr/bin/env bash
# 把本地示例文件灌入 R2 桶，便于快速体验。
# 会遍历 $SRC 目录，保持相对目录结构作为 R2 key。
#
# 用法：
#   BUCKET=filo-files SRC=/path/to/files bash scripts/seed.sh
#
# 默认：桶名 filo-files，源目录 ../filo/sample-files（若存在）。
set -euo pipefail

BUCKET="${FILO_STORAGE_BUCKET:-${BUCKET:-filo-media}}"
SRC="${FILO_SEED_SOURCE:-${SRC:-../filo/sample-files}}"

[ -d "$SRC" ] || { echo "源目录不存在: $SRC（可用 SRC=/path/to/files 指定）"; exit 1; }

echo "将把 $SRC 下的文件上传到 R2 桶 '$BUCKET'（保持目录结构）..."
count=0
while IFS= read -r f; do
  rel="${f#$SRC/}"
  # 跳过隐藏文件、源码包、临时文件
  case "$rel" in
    .* | filo-source/* | _files* | *.tmp ) continue ;;
  esac
  echo "  -> $rel"
  wrangler r2 object put "$BUCKET/$rel" --file="$f" >/dev/null
  count=$((count + 1))
done < <(find "$SRC" -type f -not -path '*/.*' -not -path '*/filo-source/*')

echo "完成，共上传 $count 个文件到桶 '$BUCKET'。"
