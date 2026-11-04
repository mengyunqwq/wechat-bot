/**
 * 取证日志（forensics）—— 只写日志，不改任何行为。
 *
 * 目的：微信崩溃是"几秒到一分钟前某个操作"引发的，普通日志太散。
 * 这里把关键动作按时间顺序追加到 data\logs\forensics.log：
 *   <ISO 时间>\t<类别>\t<详情>
 * 内存里同时保留最近 600 条；检测到客户端退出时，把内存快照另存一份
 * forensics-<时间>.log，方便直接对照"崩溃前 60 秒到底做了什么"。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let dir = join(process.cwd(), 'data', 'logs')
let maxBytes = 8 * 1024 * 1024
const ring = []
const RING_MAX = 600

export function setForensicsDir(d, opts = {}) {
  if (d) dir = d
  if (opts.maxBytes) maxBytes = opts.maxBytes
}

function rotateIfNeeded(file) {
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      renameSync(file, file + '.' + Date.now())
    }
  } catch { /* ignore */ }
}

/** 记一条取证事件（永不抛错、永不阻塞） */
export function mark(cat, detail) {
  try {
    const ts = new Date().toISOString()
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
    const line = ts + '\t' + cat + '\t' + text.replace(/[\r\n]+/g, ' ') + '\n'
    ring.push(line)
    if (ring.length > RING_MAX) ring.shift()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'forensics.log')
    rotateIfNeeded(file)
    appendFileSync(file, line)
  } catch { /* 取证永远不影响主流程 */ }
}

/** 把内存里的最近事件另存一份快照，返回文件路径（失败返回 ''） */
export function snapshot(reason) {
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = join(dir, 'forensics-' + stamp + '.log')
    writeFileSync(out, '# snapshot: ' + reason + ' @ ' + new Date().toISOString() + '\n' + ring.join(''), 'utf8')
    return out
  } catch { return '' }
}

/** 最近 N 条（调试用） */
export function tail(n = 50) {
  return ring.slice(-n)
}
