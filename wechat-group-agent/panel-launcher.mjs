#!/usr/bin/env node
/**
 * panel-launcher.mjs —— 独立面板的守护启动器
 *
 * 解决一个很具体的问题：面板要「一键更新」就必须能重启自己。
 * 自己 spawn 自己有两个坑：
 *   ① 端口还没释放，新进程 EADDRINUSE
 *   ② 新进程起不来（比如刚覆盖的代码有语法错），面板就彻底没了
 *
 * 所以让启动器来管：面板要重启时 exit(42)，这里看到 42 就再拉一次。
 * 其它退出码（Ctrl+C、真崩、正常退出）都不重启，避免无限循环。
 *
 * 用法：
 *   node wechat-group-agent/panel-launcher.mjs
 *   node wechat-group-agent/panel-launcher.mjs --port 8741
 *   node wechat-group-agent/panel-launcher.mjs --host 0.0.0.0 --token 口令
 *
 * 面板通过环境变量 PANEL_SUPERVISED=1 知道自己被守护，才会用「退出等重启」
 * 而不是「自接力」。直接跑 standalone-panel.mjs 也能用，只是更新后退化成自接力。
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PANEL = join(__dirname, 'standalone-panel.mjs')

const RESTART_CODE = 42          // 面板用它表示「我更新了代码，请重启我」
const MAX_FAST_RESTARTS = 3      // 60 秒内连续快速退出超过这个数就不再拉起
const FAST_WINDOW_MS = 60_000

const log = (...a) => console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '][launcher]', ...a)

let child = null
let stopping = false
const exits = []                 // 最近的退出时间戳，用来识别「一直起不来」

function start() {
  log('启动面板 ' + PANEL)
  child = spawn(process.execPath, [PANEL, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, PANEL_SUPERVISED: '1' },
    windowsHide: false,          // 面板日志要能看到；用户也可以重定向到文件
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopping) { log('已停止'); process.exit(0) }

    if (code === RESTART_CODE) {
      log('面板请求重启（代码已更新）→ 2 秒后重新拉起')
      setTimeout(start, 2000)
      return
    }

    // 非重启码：可能是崩溃
    if (code === null && signal) { log('面板被信号 ' + signal + ' 终止'); process.exit(1) }
    log('面板退出 code=' + code)

    // 快速连续退出 → 多半是代码有问题，别无限重试
    const now = Date.now()
    exits.push(now)
    while (exits.length && now - exits[0] > FAST_WINDOW_MS) exits.shift()
    if (exits.length > MAX_FAST_RESTARTS) {
      log('  [X] ' + Math.round(FAST_WINDOW_MS / 1000) + ' 秒内已退出 ' + exits.length + ' 次 —— 疑似代码有问题，停止重启')
      log('      修好后手动再跑一次本脚本')
      process.exit(code || 1)
    }

    // 正常退出码 0（用户 Ctrl+C 之类）不重启
    if (code === 0) process.exit(0)
    log('  非 0 退出，3 秒后重试（' + (exits.length) + '/' + MAX_FAST_RESTARTS + '）')
    setTimeout(start, 3000)
  })

  child.on('error', (e) => {
    log('  [X] 拉起失败：' + (e?.message || e))
    process.exit(1)
  })
}

function shutdown(sig) {
  if (stopping) return
  stopping = true
  log('收到 ' + sig + '，正在停止面板')
  try { child?.kill(sig) } catch {}
  // 面板自己的 SIGINT 处理会关服务并退出；这里兜个底
  setTimeout(() => process.exit(0), 3000).unref?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
