#!/usr/bin/env node
// 面板操作覆盖检查：panel/index.html 里用到的每个 op 都必须在 lib/panel.mjs 的 ALLOWED_OPS 里。
//
// 为什么要有这个脚本：两边靠人工同步，加功能漏白名单 = 用户点按钮直接 500。
// 真实事故（2026-10-26）：selfReload / pollStatus / pollResume 从未进白名单，
// 「热重载插件」「恢复轮询」按钮一直坏着。
//
// 用法：
//   node scripts/check-panel-ops.mjs        # 只检查，缺失则 exit 1
//   node scripts/check-panel-ops.mjs -v     # 额外列出「白名单里有但面板没用」的项
//
// 插件启动时也会做同样的检查（lib/panel.mjs 顶部自检 + 面板顶部横幅）。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 两种布局都要支持：
//   插件目录内： <plugin>/scripts/check-panel-ops.mjs  → ../panel/index.html
//   发布仓根目录：<repo>/scripts/check-panel-ops.mjs   → ../wechat-group-agent/panel/index.html
const roots = [join(here, '..'), join(here, '..', 'wechat-group-agent')]
const root = roots.find((r) => existsSync(join(r, 'panel', 'index.html')))
if (!root) {
  console.error('❌ 找不到 panel/index.html（试过：' + roots.join(' , ') + '）')
  process.exit(2)
}

const html = readFileSync(join(root, 'panel', 'index.html'), 'utf8')
const pm = readFileSync(join(root, 'lib', 'panel.mjs'), 'utf8')

const used = [...new Set([...html.matchAll(/\bop:\s*['"]([A-Za-z][\w.]*)['"]/g)].map((m) => m[1]))]
const m = pm.match(/const ALLOWED_OPS = new Set\(\[([\s\S]*?)\]\)/)
if (!m) { console.error('❌ 找不到 ALLOWED_OPS'); process.exit(2) }
const allowed = new Set(m[1].match(/'[^']+'/g).map((x) => x.slice(1, -1)))

const missing = used.filter((o) => !allowed.has(o))
const unused = [...allowed].filter((o) => !used.includes(o))

console.log(`面板用到 ${used.length} 个操作，白名单 ${allowed.size} 项`)
if (missing.length) {
  console.error(`❌ 缺失 ${missing.length} 个：${missing.join(', ')}`)
  console.error('   修复：把它们加进 lib/panel.mjs 的 ALLOWED_OPS')
  process.exit(1)
}
console.log('✅ 全部放行')
if (process.argv.includes('-v') && unused.length) {
  console.log(`（白名单里面板没用到：${unused.join(', ')}）`)
}
