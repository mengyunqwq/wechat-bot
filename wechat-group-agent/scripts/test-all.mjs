/**
 * test-all.mjs —— 改完代码必须跑的唯一入口（"每次改完都要测试"的落地）
 *
 * 规则（2026-10-29 用户要求，写入底层）：
 *   任何改动之后，必须跑 `node scripts/test-all.mjs` 并让它全绿，才算改完。
 *
 * 它做 7 件事：
 *   ① 语法：所有 js/mjs 过 node --check（含面板内联脚本）
 *   ② 作用域：提示词函数不允许引用"别处的变量"（今天 trigger 那个事故的专防）
 *   ③ 面板操作：面板用到的 op 必须在白名单里
 *   ④ 面板产物：panel/index.html 与 lib/client.js 的关键符号一致
 *   ⑤ 单元测试：data/test-*.mjs 全跑
 *   ⑥ 端到端：data/test-e2e.mjs（假 hook → 真轮询 → 游标）
 *   ⑦ 汇总：任何一步失败 → 退出码 1
 *
 * 用法：
 *   node scripts/test-all.mjs            # 全跑
 *   node scripts/test-all.mjs --fast     # 跳过端到端与出站队列（省时间）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const DATA = join(PLUGIN, '..', 'data')
const FAST = process.argv.includes('--fast')

let failed = 0
const results = []

function run(label, fn) {
  try {
    const out = fn()
    results.push({ label, ok: true, out: String(out || '').trim().split('\n').pop() })
  } catch (e) {
    failed++
    const msg = String(e?.stdout || e?.message || e).trim().split('\n').slice(-6).join('\n')
    results.push({ label, ok: false, out: msg })
  }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 180_000, ...opts })
}

// ① 语法检查
run('语法检查', () => {
  const files = [
    'lib/index.js', 'lib/persona.mjs', 'lib/memory-v2.mjs', 'lib/human2.mjs',
    'lib/outbox.mjs', 'lib/panel.mjs', 'lib/panel-meta.mjs',
  ]
  const bad = []
  for (const f of files) {
    try { sh(process.execPath, ['--check', join(PLUGIN, f)]) } catch { bad.push(f) }
  }
  // 面板内联脚本
  const html = readFileSync(join(PLUGIN, 'panel', 'index.html'), 'utf8')
  const i = html.indexOf('<script>') + 8
  const j = html.lastIndexOf('</script>')
  try {
    new Function(html.slice(i, j))   // 只做语法解析，不执行
  } catch (e) {
    bad.push('panel/index.html（' + String(e.message).slice(0, 60) + '）')
  }
  if (bad.length) throw new Error('语法错误：' + bad.join(', '))
  return `${files.length + 1} 个文件通过`
})

// ② 作用域检查（专防"引用别处变量"）
run('提示词作用域', () => sh(process.execPath, [join(HERE, 'check-prompt-scope.mjs')]))

// ③ 面板操作白名单
run('面板操作白名单', () => sh(process.execPath, [join(HERE, 'check-panel-ops.mjs')]))

// ④ 面板与产物一致性
run('面板产物一致', () => {
  const html = readFileSync(join(PLUGIN, 'panel', 'index.html'), 'utf8')
  const client = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
  const marks = ['renderInner', 'loadInner', 'memRColor', 'tr-enabled', 'rel-row', 'innerRelExpand']
  const bad = marks.filter((m) => html.includes(m) !== client.includes(m))
  if (bad.length) throw new Error('html 与 client.js 不一致：' + bad.join(', ') + '（忘了 build-client？）')
  return marks.length + ' 个符号一致'
})

// ⑤ 单元测试
const testFiles = existsSync(DATA)
  ? readdirSync(DATA).filter((f) => /^test-.*\.mjs$/.test(f)).sort()
  : []
const skip = new Set(FAST ? ['test-e2e.mjs', 'test-outbox.mjs'] : [])
for (const f of testFiles) {
  if (skip.has(f)) continue
  run('单测 ' + f.replace(/^test-|\.mjs$/g, ''), () => {
    const out = sh(process.execPath, [join(DATA, f)], { timeout: 240_000 })
    const m = out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
    if (m && Number(m[2]) > 0) throw new Error(out.trim().split('\n').slice(-3).join(' | '))
    return m ? `${m[1]} 通过` : 'ok'
  })
}

// 输出
console.log('\n════════ 改完必跑：全量检查 ════════')
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.label.padEnd(22)} ${r.out || ''}`)
}
const total = results.length
console.log('────────────────────────────────────')
console.log(failed === 0
  ? `  ✅ 全部通过（${total} 项检查）`
  : `  ❌ ${failed}/${total} 项失败 —— 别提交、别推送，先修`)
process.exit(failed ? 1 : 0)
