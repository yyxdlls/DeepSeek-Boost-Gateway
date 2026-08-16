#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

printf '\n DeepSeek Boost Gateway\n ======================\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' \
    '[错误] 未检测到 Node.js。' \
    '请安装 Node.js 22 或更高版本，然后重新运行此脚本：' \
    'https://nodejs.org/en/download' >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    printf '%s\n' '[错误] 无法确定 Node.js 版本。' >&2
    exit 1
    ;;
esac

if [ "$NODE_MAJOR" -lt 22 ]; then
  printf '%s\n' \
    "[错误] Node.js $NODE_MAJOR 版本过低，需要 22 或更高版本。" \
    '请安装当前 LTS 版本，然后重新运行此脚本：' \
    'https://nodejs.org/en/download' >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' \
    '[错误] 未检测到 npm；标准 Node.js 安装包会自带 npm。' \
    '请重新安装 Node.js 22 或更高版本：' \
    'https://nodejs.org/en/download' >&2
  exit 1
fi

printf '[1/4] 已检测到 Node.js %s。\n' "$NODE_MAJOR"

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    printf '%s\n' '[错误] 缺少 .env.example，请恢复完整项目后重试。' >&2
    exit 1
  fi
  cp .env.example .env
  printf '%s\n' '[2/4] 已从 .env.example 创建 .env。'
else
  printf '%s\n' '[2/4] 已保留现有 .env 配置。'
fi

RUNTIME_DEPS=$(node -e "const p=require('./package.json'); const d={...(p.dependencies||{}),...(p.optionalDependencies||{})}; process.stdout.write(String(Object.keys(d).length))")
if [ "$RUNTIME_DEPS" -eq 0 ]; then
  printf '%s\n' '[3/4] 当前没有第三方运行时依赖。'
elif npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
  printf '%s\n' '[3/4] 运行时依赖已经就绪。'
else
  printf '%s\n' '[3/4] 正在自动安装缺失的运行时依赖...'
  if [ -f package-lock.json ]; then
    npm install --omit=dev --no-audit --no-fund
  else
    npm install --omit=dev --no-audit --no-fund --no-package-lock
  fi
fi

printf '%s\n' \
  '[4/4] 正在启动 Gateway，请保持此终端开启。' \
  '      WebUI: http://127.0.0.1:8642/' \
  '      已配置的数据 API 地址会显示在下方。' \
  ''

if [ "${GATEWAY_NO_OPEN:-0}" = "1" ]; then
  exec node scripts/launch-gateway.mjs --no-open
fi
exec node scripts/launch-gateway.mjs
