#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

printf '\n DeepSeek Boost Gateway - Stop\n =============================\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '[错误] 未检测到 Node.js，无法安全核验并关闭 Gateway。' >&2
  exit 1
fi

exec node scripts/stop-gateway.mjs
