/**
 * paths.mjs —— 统一解析"外部依赖在哪"，别再到处写死 D:\Python311
 *
 * 为什么（2026-10-30 用户反馈）：
 *   桥里十几处写死了 `D:\Python311\python.exe`、`D:\wxhook\wx4110\Weixin.exe`、
 *   `D:\Python311\Lib\site-packages\imageio_ffmpeg\...`。
 *   换台电脑（没有 D 盘 / Python 装在别处 / 微信装在默认目录）→ 直接崩或者全功能失效。
 *
 * 策略（优先级从高到低）：
 *   ① 环境变量（PYTHON_EXE / FFMPEG_EXE / WECHAT_EXE / WECHAT_CLIENT_DIR / WXHOOK_DIR）
 *   ② 常见安装位置自动探测
 *   ③ PATH 里找（python / py / ffmpeg）
 *   ④ 都没有 → 返回 ''，调用方**优雅降级并打一条可操作的日志**，绝不抛
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BRIDGE_DIR = join(HERE, '..')
export const DATA_DIR = process.env.WECHAT_DATA_DIR || join(BRIDGE_DIR, '..', 'data')

const cache = new Map()
function memo(key, fn) {
  if (cache.has(key)) return cache.get(key)
  const v = fn()
  cache.set(key, v)
  return v
}

/** 从 PATH 里找一个可执行文件（不执行它，只看哪能找到） */
function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const first = String(out || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]
    return first || ''
  } catch { return '' }
}

/**
 * Python 解释器。
 * @returns {string} 可用路径；找不到返回 ''
 */
export function pythonExe() {
  return memo('py', () => {
    const env = String(process.env.PYTHON_EXE || '').trim()
    if (env && existsSync(env)) return env
    const cands = []
    // 常见安装位置（按盘符扫，别写死 D:）
    for (const drive of ['C', 'D', 'E', 'F']) {
      cands.push(`${drive}:\\Python311\\python.exe`)
      cands.push(`${drive}:\\Python312\\python.exe`)
      cands.push(`${drive}:\\Program Files\\Python311\\python.exe`)
      cands.push(`${drive}:\\Program Files\\Python312\\python.exe`)
      cands.push(`${drive}:\\Program Files (x86)\\Python311\\python.exe`)
      cands.push(`${drive}:\\Users\\${process.env.USERNAME || ''}\\AppData\\Local\\Programs\\Python\\Python311\\python.exe`)
      cands.push(`${drive}:\\Users\\${process.env.USERNAME || ''}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`)
    }
    for (const p of cands) { try { if (p && existsSync(p)) return p } catch { } }
    // PATH
    const w = which('python') || which('python3') || which('py')
    return w || ''
  })
}

/** ffmpeg 可执行文件（本机没有系统 ffmpeg 时，用 imageio-ffmpeg 自带的） */
export function ffmpegExe() {
  return memo('ff', () => {
    const env = String(process.env.FFMPEG_EXE || '').trim()
    if (env && existsSync(env)) return env
    const py = pythonExe()
    if (py) {
      try {
        const out = execFileSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], {
          encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
        })
        const p = String(out || '').trim().split(/\r?\n/).pop()
        if (p && existsSync(p)) return p
      } catch { /* 没装 imageio-ffmpeg */ }
    }
    return which('ffmpeg') || ''
  })
}

/** 微信客户端目录（含 Weixin.exe） */
export function wechatClientDir() {
  return memo('wxc', () => {
    const envDir = String(process.env.WECHAT_CLIENT_DIR || '').trim()
    if (envDir && existsSync(envDir)) return envDir
    const envExe = String(process.env.WECHAT_EXE || '').trim()
    if (envExe && existsSync(envExe)) return dirname(envExe)
    const cands = []
    for (const drive of ['C', 'D', 'E', 'F']) {
      cands.push(`${drive}:\\Program Files\\Tencent\\Weixin`)
      cands.push(`${drive}:\\Program Files (x86)\\Tencent\\Weixin`)
      cands.push(`${drive}:\\Program Files\\Tencent\\WeChat`)
      cands.push(`${drive}:\\Program Files (x86)\\Tencent\\WeChat`)
      cands.push(`${drive}:\\Tencent\\Weixin`)
    }
    for (const d of cands) {
      try { if (d && existsSync(join(d, 'Weixin.exe'))) return d } catch { }
    }
    return ''
  })
}

/** Weixin.exe 路径 */
export function wechatExe() {
  const env = String(process.env.WECHAT_EXE || '').trim()
  if (env && existsSync(env)) return env
  const dir = wechatClientDir()
  return dir ? join(dir, 'Weixin.exe') : ''
}

/** wxhook（version.dll / 日志 / 开关文件）所在目录 */
export function wxhookDir() {
  return memo('hook', () => {
    const env = String(process.env.WXHOOK_DIR || '').trim()
    if (env && existsSync(env)) return env
    // 桥旁边的 wxhook（发布包里就是这么放的）
    const local = join(BRIDGE_DIR, '..', 'wxhook')
    if (existsSync(local)) return local
    for (const drive of ['C', 'D', 'E', 'F']) {
      const p = `${drive}:\\wxhook`
      try { if (existsSync(p)) return p } catch { }
    }
    const dir = wechatClientDir()
    return dir || ''
  })
}

/** 把 wxhook 目录下的某个文件（日志/开关）解析出来 */
export function hookFile(name, envKey = '') {
  const env = envKey ? String(process.env[envKey] || '').trim() : ''
  if (env) return env
  const d = wxhookDir()
  return d ? join(d, name) : join(DATA_DIR, name)
}

/** 给日志用：把解析结果打出来，方便"为什么功能不工作"的排查 */
export function describePaths() {
  const py = pythonExe()
  const ff = ffmpegExe()
  const wx = wechatClientDir()
  const hk = wxhookDir()
  return [
    `python    ${py || '（找不到，可设 PYTHON_EXE）'}`,
    `ffmpeg    ${ff || '（找不到，可设 FFMPEG_EXE）'}`,
    `微信目录  ${wx || '（找不到，可设 WECHAT_CLIENT_DIR）'}`,
    `wxhook    ${hk || '（找不到，可设 WXHOOK_DIR）'}`,
    `data      ${DATA_DIR}`,
  ].join('｜')
}
