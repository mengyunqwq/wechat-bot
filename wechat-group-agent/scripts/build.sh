#!/bin/bash
# @dsh-external/dsh-wechat-bot —— 纯 ESM 插件，**无需编译**。
#
# 为什么不用 tsc：本机 DSH 是 npx 缓存安装（只有 node_modules，没有源码 checkout 的
# node_modules/.bin/tsc），脚手架默认的 tsc 构建链在这里跑不起来。插件只依赖
# @deepseek-ai/dsh-llm 的运行时导出，JS 直接可加载，因此 lib/ 就是产物。
#
# 本脚本 = 语法校验 + 策略回归，保证 dev_build_plugin / dev_reload_package 有确定结果。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 语法校验 ==="
shopt -s nullglob
found=0
for f in lib/*.mjs lib/*.js; do
  node --check "$f"
  echo "  ok  $f"
  found=$((found + 1))
done
if [ "$found" -eq 0 ]; then
  echo "build: lib/ 下没有可加载的源文件" >&2
  exit 1
fi

echo "=== 策略回归测试 ==="
node lib/test-policy.mjs

echo "=== Build complete（lib/ 即产物，无需编译）==="
