/**
 * check-prompt-scope.mjs —— 拦住"拼提示词时引用未定义变量"这类错误
 *
 * 为什么要有它（2026-10-29 真实事故）：
 *   把好感度/印象卡/世界书塞进 buildSystem(r) 时用了 `trigger.sender`，
 *   但 buildSystem 只接 r，`trigger` 在它的作用域里不存在 →
 *   每次要回话都 ReferenceError → 她完全不说话。
 *   纯函数单测发现不了，因为这是"作用域/接线"问题，不是逻辑问题。
 *
 * 做法：把关键函数的源码切出来，扫"自由变量"（用了但没在参数/局部声明/外层作用域出现）。
 *   只对白名单里的容器函数（buildSystem 等）严格检查，避免误报。
 *
 * 退出码：0 = 通过；1 = 发现问题
 */
import { readFileSync } from 'node:fs'

const FILE = process.argv[2] || 'lib/index.js'
const src = readFileSync(FILE, 'utf8')
const lines = src.split('\n')

// 需要严格检查的函数（这些函数体里出现的自由变量最容易导致"整条生成失败"）
const TARGETS = ['buildSystem', 'buildMemoryBlock', 'describeImage', 'renderPersonaBlock']

// 允许的自由变量（模块级/内建/常见全局）
const BUILTIN = new Set([
  'r', 'm', 'args', 'opts', 'ctx', 'config', 'log', 'client', 'process', 'console', 'JSON', 'Math',
  'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'Promise', 'Error',
  'undefined', 'null', 'true', 'false', 'this', 'require', 'import', 'globalThis', 'Buffer',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'await', 'async', 'return',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'new', 'typeof', 'instanceof', 'delete', 'void', 'in', 'of', 'let', 'const',
  'var', 'function', 'class', 'extends', 'super', 'yield', 'debugger', 'with', 'export', 'default',
])

function findFunction(name) {
  const re = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{')
  const m = re.exec(src)
  if (!m) return null
  const params = m[1].split(',').map((x) => x.trim().split('=')[0].trim()).filter(Boolean)
  // 从 { 开始做括号配平，取出函数体
  let i = m.index + m[0].length - 1
  let depth = 0
  let end = -1
  let inStr = null
  let inTpl = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    const prev = src[j - 1]
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
  }
  if (end < 0) return null
  const body = src.slice(i + 1, end)
  const startLine = src.slice(0, i).split('\n').length
  return { name, params, body, startLine }
}

/** 把注释和字符串字面量抹掉（模板里的 ${...} 保留），避免把中文/文案当成变量名 */
function stripNonCode(body) {
  let out = ''
  let i = 0
  const n = body.length
  const tpl = []   // 模板嵌套深度栈：'`' 进来 push，出去 pop；>0 时遇 ${ 进入代码态
  let inTplCode = 0
  let quote = null
  while (i < n) {
    const c = body[i]
    const next = body[i + 1]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) { quote = null; out += ' '; i++; continue }
      i++; continue
    }
    if (tpl.length && !inTplCode) {
      // 模板字面量态：只关心 ${ 和结束反引号
      if (c === '\\') { i += 2; continue }
      if (c === '$' && next === '{') { inTplCode = 1; tpl.push('code'); out += ' ('; i += 2; continue }
      if (c === '`') { tpl.pop(); out += ' '; i++; continue }
      i++; continue
    }
    if (inTplCode) {
      // 模板插值内部是代码：需要处理括号配平与字符串
      if (c === '{') { inTplCode++; out += c; i++; continue }
      if (c === '}') { inTplCode--; out += ')'; i++; if (inTplCode === 0) { tpl.pop(); } continue }
      if (c === '"' || c === "'" ) { quote = c; i++; continue }
      if (c === '`') { tpl.push('tpl'); inTplCode = 0; out += ' '; i++; continue }
      out += c; i++; continue
    }
    if (c === '/' && next === '/') { while (i < n && body[i] !== '\n') i++; continue }
    if (c === '/' && next === '*') { const e = body.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c === '`') { tpl.push('tpl'); inTplCode = 0; out += ' '; i++; continue }
    out += c; i++
  }
  return out
}

/** 收集函数体内声明的局部名 */
function locals(body) {
  const set = new Set()
  const push = (s) => { if (s) set.add(s) }
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) push(m[1])
  for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) push(part.split(':').pop().trim())
  }
  for (const m of body.matchAll(/\b(?:const|let|var)\s*\[([^\]]+)\]/g)) {
    for (const part of m[1].split(',')) push(part.trim())
  }
  for (const m of body.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) push(part.trim().split('=')[0].trim())
  }
  for (const m of body.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) push(m[1])
  for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) push(m[1])
  for (const m of body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) push(m[1])
  return set
}

// 盯住"容易从别的函数漏进来"的变量：这些都是 evaluate/deliver 的参数，
// 一旦被塞进不含它们的函数里，就是今天那种"只在运行时炸"的错。
const WATCH = ['trigger', 'batch', 'priority', 'reply', 'reason', 'outcome', 'plan', 'promise']

const problems = []
for (const name of TARGETS) {
  const fn = findFunction(name)
  if (!fn) continue
  const code = stripNonCode(fn.body)
  const decl = locals(code)
  for (const p of fn.params) decl.add(p)
  for (const w of WATCH) {
    if (!new RegExp('\\b' + w + '\\b').test(code)) continue
    if (decl.has(w)) continue
    // 只有【模块顶层】（行首无缩进）的声明才算有来源；
    // 别处的同名局部变量不算 —— 那正是今天 bug 被掩盖的原因。
    const topLevel = new RegExp('^(?:const|let|var|function)\\s+' + w + '\\b', 'm')
    if (topLevel.test(src)) continue
    problems.push({ fn: name, id: w, line: fn.startLine })
  }
}

if (!problems.length) {
  console.log('✅ 提示词函数作用域检查通过（' + TARGETS.join(' / ') + '）')
  process.exit(0)
}
console.log('❌ 发现可疑的自由变量（很可能在运行时 ReferenceError）：')
for (const p of problems) console.log(`   ${p.fn}() 第 ${p.line} 行起用了「${p.id}」，但函数内没有声明、参数里也没有`)
process.exit(1)
