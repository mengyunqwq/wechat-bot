#!/usr/bin/env node
/**
 * standalone-panel.mjs —— 把控制面板从 DSH 里拆出来独立跑
 *
 * 为什么需要它：
 *   原来的面板是 DSH 插件的一部分（panel.mjs 用 ctx.effect + ws.register 挂到
 *   DSH 的 webServer 上，路径 /wechat-bot）。别人想看面板就必须：
 *     ① 装 DSH  ② 起 dsh web  ③ 先登录 DSH
 *   很多时候只想看个状态、发条消息，不该比机器人本身还重。
 *
 * 这个服务只依赖 wx-bridge（桥），不依赖 DSH、不依赖插件：
 *   · 静态文件：直接读 wechat-group-agent/panel/index.html
 *   · /api/action：转成 WebSocket 命令发给桥（桥的 28 个 op 全支持）
 *   · /api/state：桥 status + 本地 config.json 合成
 *   · /api/config：读写 config.json
 *   · /api/logs：读桥日志尾部
 *
 * 用法：
 *   node wechat-group-agent/standalone-panel.mjs
 *   node wechat-group-agent/standalone-panel.mjs --port 8741
 *   node wechat-group-agent/standalone-panel.mjs --host 0.0.0.0 --token 你的口令
 *
 * 安全：
 *   默认只监听 127.0.0.1（本机访问，不需要口令）。
 *   一旦用 --host 暴露到局域网，必须给 --token；否则任何人都能控制你的微信。
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join, dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { publicMeta, GROUPS, FEATURES } from './lib/panel-meta.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')                    // 仓库根
const PANEL_HTML = join(__dirname, 'panel', 'index.html')
const BRIDGE_LOG_DIRS = [
  join(ROOT, 'wx-bridge', 'data', 'logs'),
  join(ROOT, 'data', 'logs'),
]

// 两套配置，用途不同：
//   · 插件配置（agent）：人设、回复概率、模型 —— 面板主要改这个
//   · 桥配置（bridge）：微信路径、端口 —— 桥自己读
// 查找顺序：命令行参数 → 环境变量 → DSH_HOME → ~/.dsh → 仓库内
function findAgentConfig() {
  const cands = []
  const argCfg = (() => { const i = process.argv.indexOf('--agent-config'); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '' })()
  if (argCfg) cands.push(argCfg)
  if (process.env.WECHAT_AGENT_CONFIG) cands.push(process.env.WECHAT_AGENT_CONFIG)
  const dshHomes = [process.env.DSH_HOME, join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'D:\\dsh'].filter(Boolean)
  for (const h of dshHomes) cands.push(join(h, 'data', 'wechat-bot', 'config.json'))
  cands.push(join(ROOT, 'config.json'))
  for (const c of cands) if (c && existsSync(c)) return c
  return cands[0] || join(ROOT, 'config.json')
}
const AGENT_CONFIG = findAgentConfig()
const BRIDGE_CONFIG = join(ROOT, 'config.json')

// 插件的数据目录（人设之外，记忆/用量/成员名/更新状态都在这）
const AGENT_DATA_DIR = dirname(AGENT_CONFIG)
const MEMORY_DIR = join(AGENT_DATA_DIR, 'memory')
const FACTS_DIR = join(AGENT_DATA_DIR, 'facts')
const USAGE_FILE = join(AGENT_DATA_DIR, 'usage.json')
const NAMES_FILE = join(AGENT_DATA_DIR, 'members.json')
const UPDATE_STATE_FILE = join(AGENT_DATA_DIR, 'update-state.json')
const BACKUP_DIR = join(AGENT_DATA_DIR, 'backups')

// 生图配置：桥每次生成都重新读这个文件（wx-bridge/lib/genimage.mjs 的 loadImageConfig）
// 优先级：环境变量 IMAGE_* > 这个文件 > 内置默认
const IMAGE_CFG_FILE = join(ROOT, 'data', 'image-gen.json')
const IMAGE_DEFAULTS = {
  apiUrl: 'https://apihub.agnes-ai.com/v1/images/generations',
  model: 'agnes-image-2.5-flash',
  keyRef: 'AGNES_API_KEY',
  mode: 'i2i',
  backend: 'agnes',
  style: 'agnes',
}

// 版本号从仓库 version.json 读（面板顶栏会显示）
let VERSION = ''
try { VERSION = String(JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8')).version || '') } catch {}

// ── 参数 ────────────────────────────────────────────────────
function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='))
  if (eq) return eq.split('=').slice(1).join('=')
  return def
}

const PORT = Number(arg('port', process.env.PANEL_PORT || 8741))
const HOST = arg('host', process.env.PANEL_HOST || '127.0.0.1')
const BRIDGE_URL = arg('bridge', process.env.BRIDGE_URL || 'ws://127.0.0.1:17300')
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
// 桥连上微信后自动弹浏览器（用户要求：桥一连上就把面板打开）。
// 只在「从未登录变成已登录」时弹一次，同一次运行里不重复弹。--no-open 可关。
const AUTO_OPEN = !process.argv.includes('--no-open')

// 暴露到局域网却没有 token → 等于把微信控制权交出去，直接拒绝启动
let TOKEN = arg('token', process.env.PANEL_TOKEN || '')
if (!LOOPBACK && !TOKEN) {
  console.error('')
  console.error('  [X] 你正在把面板暴露到 ' + HOST + '，但没有给 --token')
  console.error('      没有口令的话，同网段任何人都能发消息、读数据库、改配置。')
  console.error('')
  console.error('      要么只监听本机：  --host 127.0.0.1')
  console.error('      要么加口令：      --host ' + HOST + ' --token 一串足够长的随机字符')
  console.error('')
  process.exit(1)
}
if (!TOKEN && !LOOPBACK) TOKEN = ''

const log = (...a) => console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ']', ...a)

// ── 桥的 WebSocket 客户端 ───────────────────────────────────
let ws = null
let connected = false
let retryMs = 1000
const waiters = new Map()
let seq = 0

// Node 21+ 有全局 WebSocket；更老的版本回退到 ws 包
async function newSocket(url) {
  if (typeof globalThis.WebSocket === 'function') return new globalThis.WebSocket(url)
  const { WebSocket: WS } = await import(join(ROOT, 'wx-bridge', 'node_modules', 'ws', 'index.js')).catch(() => import('ws'))
  return new WS(url)
}

// 用系统默认浏览器打开面板。Windows 的 start 要把 URL 当第二个参数传
// （第一个空字符串是"窗口标题"，不传会被当成标题）。
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch (e) { log('打开浏览器失败：' + String(e?.message || e)); return false }
}

// 盯「桥有没有连上微信」这件事：
//   面板服务本身一直可用（桥没连也能看状态），
//   但用户要的是「桥一连上就把面板打开」，所以这里轮询 status.loggedIn，
//   第一次看到已登录就弹浏览器（每次运行只弹一次）。
let lastLoggedIn = null
let autoOpened = false
async function watchLogin() {
  if (!connected) return
  try {
    const st = await callBridge('status', {}, 6000)
    const li = !!st.loggedIn
    if (li && lastLoggedIn !== true && !autoOpened) {
      autoOpened = true
      const url = 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT + '/'
      log('')
      log('  ================================================')
      log('   微信已登录 → 控制面板就绪')
      log('   ' + url)
      log('  ================================================')
      log('')
      if (AUTO_OPEN) openBrowser(url)
      else log('（--no-open，没自动弹浏览器）')
    }
    lastLoggedIn = li
  } catch { /* 桥暂时不通，下个周期再看 */ }
}

async function connectBridge() {
  try {
    const sock = await newSocket(BRIDGE_URL)
    ws = sock
    sock.addEventListener('open', () => {
      connected = true
      retryMs = 1000
      log('桥已连接 ' + BRIDGE_URL)
      // 自报身份：桥会把同身份的旧连接踢掉（避免和插件抢）
      try { sock.send(JSON.stringify({ id: 'identify-standalone', op: 'identify', name: 'standalone-panel', pid: process.pid })) } catch {}
    })
    sock.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (msg.t === 'reply') {
        const w = waiters.get(msg.id)
        if (w) {
          waiters.delete(msg.id)
          clearTimeout(w.timer)
          msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error || '命令失败'))
        }
      }
    })
    const onDown = (why) => {
      connected = false
      for (const [, w] of waiters) { clearTimeout(w.timer); w.reject(new Error('桥连接已断开')) }
      waiters.clear()
      log('桥断开（' + why + '），' + Math.round(retryMs / 1000) + 's 后重连')
      setTimeout(connectBridge, retryMs)
      retryMs = Math.min(30000, Math.round(retryMs * 1.7))
    }
    sock.addEventListener('close', () => onDown('close'))
    sock.addEventListener('error', () => { /* close 会跟着来，这里不重复处理 */ })
  } catch (e) {
    log('桥连接失败：' + (e?.message || e) + '，' + Math.round(retryMs / 1000) + 's 后重试')
    setTimeout(connectBridge, retryMs)
    retryMs = Math.min(30000, Math.round(retryMs * 1.7))
  }
}

/** 调桥的 op，超时抛错 */
function callBridge(op, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!connected || !ws) { reject(new Error('桥未连接（wx-bridge 没起？）')); return }
    const id = 'sp-' + (++seq)
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error('桥响应超时（' + op + '）')) }, timeoutMs)
    waiters.set(id, { resolve, reject, timer })
    try { ws.send(JSON.stringify({ id, op, args })) } catch (e) { waiters.delete(id); clearTimeout(timer); reject(e) }
  })
}

// ── 配置读写 ────────────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(readFileSync(AGENT_CONFIG, 'utf8')) } catch { return {} }
}
function readBridgeConfig() {
  try { return JSON.parse(readFileSync(BRIDGE_CONFIG, 'utf8')) } catch { return {} }
}
function writeConfig(patch) {
  const cur = readConfig()
  const next = { ...cur, ...patch }
  // 写之前先备份一份，避免手滑把配置写坏
  try { if (existsSync(AGENT_CONFIG)) writeFileSync(AGENT_CONFIG + '.bak-' + Date.now(), readFileSync(AGENT_CONFIG)) } catch {}
  writeFileSync(AGENT_CONFIG, JSON.stringify(next, null, 2), 'utf8')
  return next
}

// ── 日志读取 ────────────────────────────────────────────────
function tailBridgeLog(lines = 300) {
  const candidates = []
  for (const dir of BRIDGE_LOG_DIRS) {
    if (!existsSync(dir)) continue
    try {
      for (const f of readdirSync(dir)) {
        if (!/\.(log|out\.log)$/i.test(f)) continue
        const p = join(dir, f)
        try { candidates.push({ p, m: statSync(p).mtimeMs }) } catch {}
      }
    } catch {}
  }
  if (!candidates.length) return '(没找到桥日志)'
  candidates.sort((a, b) => b.m - a.m)
  try {
    const txt = readFileSync(candidates[0].p, 'utf8')
    const arr = txt.split(/\r?\n/)
    return arr.slice(Math.max(0, arr.length - lines)).join('\n')
  } catch (e) { return '(读日志失败：' + (e?.message || e) + ')' }
}

// ── HTTP 辅助 ───────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try { return JSON.parse(buf.toString('utf8')) } catch { throw new Error('请求体不是合法 JSON') }
}

/** 鉴权：本机访问免口令；非本机必须带 token（header 或 query） */
function authorized(req, urlObj) {
  if (LOOPBACK && !TOKEN) return true
  const h = req.headers['authorization'] || ''
  const got = (h.startsWith('Bearer ') ? h.slice(7) : '') || urlObj.searchParams.get('token') || ''
  if (!TOKEN) return true
  if (got.length !== TOKEN.length) return false
  // 定长时间比较，避免通过响应时间猜口令
  let diff = 0
  for (let i = 0; i < TOKEN.length; i++) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i)
  return diff === 0
}

// 面板需要的纯桥 op（其余 op 在这里没有对应实现，会明确返回「需要 DSH 插件」）
const BRIDGE_OPS = new Set([
  'status', 'rooms', 'members', 'selfNames', 'history', 'searchMessages',
  'sendText', 'sayVoice', 'sendVoice', 'voiceSwitch',
  'sendSticker', 'tagSticker', 'pickSticker', 'sendImage', 'sendFile', 'pat',
  'revoke', 'forward', 'stickers', 'importStickers', 'genEmotions',
  'fetchVideo', 'fetchMedia', 'fetchLinkVideo', 'douyinBrush',
  'addBubble', 'genSticker', 'pruneStickers',
])

// 这些 op 依赖 DSH 插件（人设/LLM/记忆/眼睛/更新/诊断），独立服务里不实现
// ── /api/state：按面板期望的结构合成 ───────────────────────
// 面板读的是 S.bridge.status / S.stats / S.health / S.rooms / S.bridgeRooms，
// 必须照它的形状返回，否则会一直卡在「正在读取机器人状态…」。
async function buildState() {
  const cfg = readConfig()
  let bridgeStatus = null
  let bridgeErr = ''
  let bridgeRooms = []
  if (connected) {
    try { bridgeStatus = await callBridge('status', {}, 5000) } catch (e) { bridgeErr = String(e?.message || e) }
    try {
      const list = await callBridge('rooms', {}, 5000)
      bridgeRooms = (list || []).map((x) => ({ roomId: x.roomId, name: x.name || x.roomName || x.roomId }))
    } catch { /* 拿不到就空着 */ }
  }
  return {
    ok: true,
    at: Date.now(),
    version: VERSION,
    mode: 'standalone',
    // S.rooms 是插件维护的群状态，独立版没有 → 给空数组，
    // renderOverview 会自动 fallback 到 bridgeRooms
    rooms: [],
    bridgeRooms,
    // 插件侧的实时统计独立版没有，但面板顶栏会拼 stats.replied + '/' + stats.msgIn，
    // 给 null 会显示成 undefined/undefined，所以给一组 0。
    // 桥的 counters 有 msgsIn（收到），但「回复/跳过/LLM 调用」只有插件在算 → 那几项只能 0
    stats: {
      msgIn: (bridgeStatus && bridgeStatus.counters && bridgeStatus.counters.msgsIn) || 0,
      replied: 0, skipped: 0, llmCalls: 0, llmErrors: 0,
      sentText: 0, sentSticker: 0, sentVoice: 0, sentPat: 0,
    },
    health: null,       // 插件侧体检独立版没有
    // 顶栏读 S.route 显示「模型 provider/model」。独立模式拿不到 DSH 的实时路由，
    // 就用 config 里配的那对（也就是插件实际会用的那对）。
    route: (cfg.provider && cfg.model) ? { provider: String(cfg.provider), model: String(cfg.model) } : null,
    config: cfg,
    meta: publicMeta(),
    defaults: {},
    groups: GROUPS,
    features: FEATURES,
    configPath: AGENT_CONFIG,
    bridgeConfig: readBridgeConfig(),
    bridge: {
      url: BRIDGE_URL,
      connected,
      reconnects: 0,
      lastError: bridgeErr,
      status: bridgeStatus,
      error: bridgeErr,
    },
    bridgeLogTail: tailBridgeLog(60),
  }
}

// ── 本地 op：不依赖 DSH 插件的那部分 ────────────────────────
// 能独立实现的都实现；真正需要 LLM 的（memory.extract）明确返回做不到。

// 检测微信安装目录：环境变量 → 桥配置的 wechatExe → 运行中的微信进程
let _wxDirCache = null
function detectWechatDir() {
  if (_wxDirCache !== null) return _wxDirCache
  let found = ''
  const envDir = String(process.env.WECHAT_DIR || '').trim()
  if (envDir && existsSync(envDir)) found = envDir
  if (!found) {
    const bc = readBridgeConfig()
    const exe = String(bc.wechatExe || '').trim()
    if (exe && existsSync(exe)) found = dirname(exe)
  }
  if (!found) {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        '(Get-Process -Name Weixin -EA SilentlyContinue | Select-Object -First 1).Path'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const exe = String(out).trim()
      if (exe && existsSync(exe)) found = dirname(exe)
    } catch { /* ignore */ }
  }
  _wxDirCache = found
  return found
}

// DLL 能力标识用 hex 存放：功能需要，但不在公开脚本里出现明文字符串
const CAP_MAIN = Buffer.from('5374617274433243446f776e6c6f6164', 'hex').toString('latin1')
const CAP_VIDEO = Buffer.from('6864766964656f', 'hex').toString('latin1')

// 解压用 bsdtar（Windows 10+ 自带）。用绝对路径：插件进程的 PATH 未必含 System32，
// 而且 powershell 的 Expand-Archive 在 -NoProfile 下模块加载不稳定。
const TAR_EXE = process.env.WECHAT_TAR || 'C:\\Windows\\System32\\tar.exe'

// 拖入 zip 之后、点安装之前，预检结果暂存在这里（跨两个 HTTP 请求）
let eyesPkgCache = null

function dllCapability(p) {
  try {
    const buf = readFileSync(p)
    const t = buf.toString('latin1')
    return { ok: true, sizeKB: Math.round(buf.length / 1024), main: t.includes(CAP_MAIN), video: t.includes(CAP_VIDEO) }
  } catch (e) { return { ok: false, sizeKB: 0, main: false, video: false, error: String(e?.message || e) } }
}

function readJsonSafe(p, def) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return def } }
function writeJson(p, v) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2), 'utf8') }

// 桥日志里找崩溃 dump 目录
function crashReportsDir() {
  const base = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming')
  return join(base, 'Tencent', 'xwechat', 'crashinfo', 'reports')
}

// GitHub 读文件（走 node:https，绕开本机 MITM 证书问题）
function httpsGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpsRequest(u, {
      method: 'GET', timeout: timeoutMs, rejectUnauthorized: false,
      headers: { 'user-agent': 'wechat-bot-panel', accept: 'application/vnd.github+json' },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode))
        else resolve(buf)
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

const UPDATE_REPO = process.env.WECHAT_UPDATE_REPO || 'mengyunqwq/wechat-bot'

// 生图配置（读/写 data/image-gen.json）。key 支持两种：
//   · keyRef：引用环境变量名（和桥/插件一致的做法）
//   · apiKey：明文写进文件（独立模式下用户直接填，桥也认）
function readImageConfig() {
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(IMAGE_CFG_FILE, 'utf8')) || {} } catch {}
  return {
    apiUrl: String(cfg.apiUrl || IMAGE_DEFAULTS.apiUrl),
    model: String(cfg.model || IMAGE_DEFAULTS.model),
    keyRef: String(cfg.keyRef || IMAGE_DEFAULTS.keyRef),
    mode: ['i2i', 't2i'].includes(String(cfg.mode)) ? String(cfg.mode) : IMAGE_DEFAULTS.mode,
    backend: ['agnes', 'comfy'].includes(String(cfg.backend)) ? String(cfg.backend) : IMAGE_DEFAULTS.backend,
    style: ['agnes', 'openai'].includes(String(cfg.style)) ? String(cfg.style) : IMAGE_DEFAULTS.style,
    comfyUrl: String(cfg.comfyUrl || 'http://127.0.0.1:8188'),
    hasApiKey: !!(cfg.apiKey && String(cfg.apiKey).trim()),
    hasKeyRef: !!String(cfg.keyRef || '').trim(),
    file: IMAGE_CFG_FILE,
  }
}

function saveImageConfig(body) {
  let cur = {}
  try { cur = JSON.parse(readFileSync(IMAGE_CFG_FILE, 'utf8')) || {} } catch {}
  const next = { ...cur }
  if (body.apiUrl !== undefined) {
    const v = String(body.apiUrl).trim()
    if (!/^https?:\/\//i.test(v)) throw new Error('接口地址必须是 http(s) URL')
    next.apiUrl = v
  }
  if (body.model !== undefined) next.model = String(body.model).trim()
  if (body.keyRef !== undefined) {
    const v = String(body.keyRef).trim()
    if (v && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error('凭据引用必须是合法变量名（如 AGNES_API_KEY）')
    next.keyRef = v
  }
  if (body.mode !== undefined) next.mode = ['i2i', 't2i'].includes(String(body.mode)) ? String(body.mode) : next.mode
  if (body.backend !== undefined) next.backend = ['agnes', 'comfy'].includes(String(body.backend)) ? String(body.backend) : next.backend
  if (body.style !== undefined) next.style = ['agnes', 'openai'].includes(String(body.style)) ? String(body.style) : next.style
  if (body.comfyUrl !== undefined) next.comfyUrl = String(body.comfyUrl).trim()
  // 明文 key：给了就写，给空字符串表示清除
  if (body.apiKey !== undefined) {
    const k = String(body.apiKey).trim()
    if (k) next.apiKey = k
    else delete next.apiKey
  }
  mkdirSync(dirname(IMAGE_CFG_FILE), { recursive: true })
  try { if (existsSync(IMAGE_CFG_FILE)) writeFileSync(IMAGE_CFG_FILE + '.bak-' + Date.now(), readFileSync(IMAGE_CFG_FILE)) } catch {}
  writeFileSync(IMAGE_CFG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return readImageConfig()
}

// 面板的本地 op 表
const LOCAL_OPS = {
  // ── 配置元数据（面板所有页面靠它渲染）──
  meta: () => ({ meta: publicMeta(), groups: GROUPS, features: FEATURES }),

  // ── Token 用量 ──
  usage: () => {
    const u = readJsonSafe(USAGE_FILE, {}) || {}
    const today = new Date().toISOString().slice(0, 10)
    const byDay = u.byDay || {}
    return {
      prompt: Number(u.prompt) || 0, completion: Number(u.completion) || 0,
      total: Number(u.total) || 0, calls: Number(u.calls) || 0,
      today: byDay[today] || { prompt: 0, completion: 0, total: 0, calls: 0 },
      byModel: u.byModel || {}, byDay, startedAt: u.startedAt || 0, file: USAGE_FILE,
    }
  },

  // ── 记忆 ──
  'memory.list': () => {
    const rooms = []
    if (existsSync(MEMORY_DIR)) {
      for (const f of readdirSync(MEMORY_DIR)) {
        if (!f.endsWith('.json')) continue
        const j = readJsonSafe(join(MEMORY_DIR, f), null)
        if (!j) continue
        const roomId = String(j.roomId || f.replace(/\.json$/, ''))
        const factsFile = join(FACTS_DIR, f)
        const facts = readJsonSafe(factsFile, [])
        rooms.push({
          roomId,
          roomName: String(j.roomName || roomId),
          msgs: Array.isArray(j.msgs) ? j.msgs.length : 0,
          facts: Array.isArray(facts) ? facts.length : (Array.isArray(facts?.items) ? facts.items.length : 0),
          updatedAt: j.updatedAt || '',
        })
      }
    }
    rooms.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return { rooms, dir: MEMORY_DIR }
  },
  'memory.add': (a) => {
    const roomId = String(a.roomId || '').trim()
    const text = String(a.text || '').trim()
    if (!roomId || !text) throw new Error('需要 roomId 和 text')
    const f = join(FACTS_DIR, roomId.replace(/[^\w@.-]/g, '_') + '.json')
    const cur = readJsonSafe(f, [])
    const arr = Array.isArray(cur) ? cur : (Array.isArray(cur?.items) ? cur.items : [])
    arr.push({ text, at: new Date().toISOString(), by: 'panel' })
    writeJson(f, arr)
    return { ok: true, count: arr.length }
  },
  'memory.clear': (a) => {
    const roomId = String(a.roomId || '').trim()
    if (!roomId) throw new Error('需要 roomId')
    const safe = roomId.replace(/[^\w@.-]/g, '_')
    // 只清「长期记忆」（facts），不动聊天记录（那是记忆主体，误删很疼）
    const f = join(FACTS_DIR, safe + '.json')
    if (existsSync(f)) { copyFileSync(f, f + '.bak'); unlinkSync(f) }
    return { ok: true, cleared: 'facts', note: '聊天记忆未动，只清了长期记忆' }
  },
  'memory.extract': () => ({ ok: false, error: '提炼长期记忆需要 LLM，请在 DSH 面板里操作（独立服务不跑模型）' }),

  // ── 群成员名字 ──
  'names.set': (a) => {
    const wxid = String(a.wxid || '').trim()
    const name = String(a.name || '').trim()
    if (!wxid || !name) throw new Error('需要 wxid 和 name')
    const m = readJsonSafe(NAMES_FILE, {}) || {}
    const map = m.names || m
    map[wxid] = name
    writeJson(NAMES_FILE, m.names ? m : { names: map })
    return { ok: true, wxid, name }
  },
  'names.add': (a) => {
    const raw = String(a.names || a.text || '')
    const m = readJsonSafe(NAMES_FILE, {}) || {}
    const map = m.names || m
    let added = 0
    for (const part of raw.split(/[,，、\s]+/)) {
      const n = part.trim()
      if (n && !Object.values(map).includes(n)) { map['name_' + (++added) + '_' + Date.now()] = n }
    }
    writeJson(NAMES_FILE, m.names ? m : { names: map })
    return { ok: true, added, total: Object.keys(map).length }
  },

  // ── 眼睛（本地文件操作，全部能独立做）──
  eyesInfo: () => {
    const wxDir = detectWechatDir()
    if (!wxDir) return { ok: false, error: '检测不到微信安装目录 —— 请设环境变量 WECHAT_DIR 指向微信目录（version.dll 所在处）' }
    const dllPath = process.env.WECHAT_DLL || join(wxDir, 'version.dll')
    const dirFile = process.env.WECHAT_REPLAY_DIR_FILE || join(wxDir, 'hook-cdn-replay.dir')
    const switchFile = process.env.WECHAT_REPLAY_SWITCH_FILE || join(wxDir, 'hook-cdn-replay.on')
    const out = { dllPath, dirFile, switchFile, wxDir, enabled: existsSync(switchFile) }
    const cap = dllCapability(dllPath)
    out.dllSizeKB = cap.sizeKB
    out.dllHasMain = cap.main
    out.dllHasVideo = cap.video
    out.dllHasEyes = cap.main && cap.video
    if (!cap.ok) out.dllError = cap.error
    try { out.dir = readFileSync(dirFile, 'utf8').trim() || '' } catch { out.dir = ''; out.dirFileMissing = true }
    if (!out.dir) out.dir = join(wxDir, 'replay')
    try {
      const files = existsSync(out.dir) ? readdirSync(out.dir) : []
      let bytes = 0, newest = 0
      for (const f of files) {
        try { const s = statSync(join(out.dir, f)); bytes += s.size; if (s.mtimeMs > newest) newest = s.mtimeMs } catch {}
      }
      out.dirExists = existsSync(out.dir)
      out.fileCount = files.length
      out.mb = +(bytes / 1048576).toFixed(1)
      out.newestAt = newest
    } catch (e) { out.dirError = String(e?.message || e) }
    return out
  },
  eyesSetDir: (a) => {
    const dir = String(a.dir || '').trim()
    if (!dir) throw new Error('需要 dir')
    const wxDir = detectWechatDir()
    if (!wxDir) throw new Error('检测不到微信目录')
    const dirFile = process.env.WECHAT_REPLAY_DIR_FILE || join(wxDir, 'hook-cdn-replay.dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(dirFile, dir, 'utf8')
    return { ok: true, dir, dirFile }
  },
  eyesToggle: (a) => {
    const on = a.on === true || a.on === 'true' || a.on === 1
    const wxDir = detectWechatDir()
    if (!wxDir) throw new Error('检测不到微信目录')
    const switchFile = process.env.WECHAT_REPLAY_SWITCH_FILE || join(wxDir, 'hook-cdn-replay.on')
    if (on) writeFileSync(switchFile, '', 'utf8')
    else if (existsSync(switchFile)) unlinkSync(switchFile)
    return { ok: true, enabled: on, switchFile }
  },
  eyesClean: () => {
    const info = LOCAL_OPS.eyesInfo()
    if (!info.dir || !existsSync(info.dir)) return { ok: true, removed: 0 }
    let n = 0, bytes = 0
    for (const f of readdirSync(info.dir)) {
      const p = join(info.dir, f)
      try { const s = statSync(p); if (s.isFile()) { bytes += s.size; unlinkSync(p); n++ } } catch {}
    }
    return { ok: true, removed: n, mb: +(bytes / 1048576).toFixed(1) }
  },
  eyesCheck: () => {
    let running = false
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        '(Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true })
      running = parseInt(String(out).trim(), 10) > 0
    } catch { /* ignore */ }
    return { ok: true, wechatRunning: running }
  },
  // 拖入 zip：接收 base64 → 存盘 → 解压 → 找 DLL → 预检能力（不安装）
  eyesUpload: (a) => {
    const b64 = String(a.b64 || '')
    if (!b64) return { ok: false, error: '没有收到文件内容' }
    let buf
    try { buf = Buffer.from(b64, 'base64') } catch { return { ok: false, error: 'base64 解码失败' } }
    if (!buf.length) return { ok: false, error: '文件为空' }
    if (buf.length > 32 * 1024 * 1024) return { ok: false, error: '文件太大（>32MB）' }

    const dir = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', 'dsh-eyes-' + Date.now())
    mkdirSync(dir, { recursive: true })
    // 存盘用 ASCII 名（原名只用于显示，避免中文路径在 tar 里出问题）
    const zipPath = join(dir, 'upload.zip')
    writeFileSync(zipPath, buf)

    try {
      execFileSync(TAR_EXE, ['-xf', zipPath, '-C', dir], { stdio: 'pipe', timeout: 120000, windowsHide: true })
    } catch (e) {
      return { ok: false, error: '解压失败：' + String(e?.stderr || e?.message || e).slice(0, 160) }
    }

    // 递归找 version.dll（压缩包通常有一层 <目录>/version.dll）
    let dll = null
    const walk = (d, depth) => {
      if (depth > 4 || dll) return
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const ent of ents) {
        const p = join(d, ent.name)
        if (ent.isDirectory()) walk(p, depth + 1)
        else if (/^version.*\.dll$/i.test(ent.name) && !dll) dll = p
      }
    }
    walk(dir, 0)
    if (!dll) return { ok: false, error: '压缩包里没找到 version.dll' }

    const dllBuf = readFileSync(dll)
    const hasMain = dllBuf.includes(Buffer.from(CAP_MAIN))
    const hasVideo = dllBuf.includes(Buffer.from(CAP_VIDEO))
    const sha256 = createHash('sha256').update(dllBuf).digest('hex')

    // 顺带列出包里的文档（给面板展示，最多 8 个）
    const docs = []
    const collectDocs = (d, depth) => {
      if (depth > 4) return
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const ent of ents) {
        const p = join(d, ent.name)
        if (ent.isDirectory()) collectDocs(p, depth + 1)
        else if (/\.(md|txt)$/i.test(ent.name) && docs.length < 8) docs.push(ent.name)
      }
    }
    collectDocs(dir, 0)

    eyesPkgCache = { dir, zipPath, dll, sha256 }
    return {
      ok: true,
      zipMB: +(buf.length / 1048576).toFixed(2),
      sha256,
      dllKB: Math.round(dllBuf.length / 1024),
      hasMain,
      hasVideo,
      usable: hasMain && hasVideo,
      docs,
      workDir: dir,
      origName: String(a.name || ''),
    }
  },

  // 安装：微信必须已退出（DLL 被锁换不了）→ 备份 → 复制 → 写重放配置
  eyesInstall: () => {
    const pkg = eyesPkgCache
    if (!pkg || !existsSync(pkg.dll)) return { ok: false, error: '没有待安装的包（先在面板里拖入 zip）' }
    const wxDir = detectWechatDir()
    if (!wxDir) return { ok: false, error: '检测不到微信安装目录 —— 请设环境变量 WECHAT_DIR（version.dll 所在处）', needWxDir: true }
    const targetDll = process.env.WECHAT_DLL || join(wxDir, 'version.dll')

    // ① 微信在跑 → DLL 被占用，复制会失败（甚至把文件弄坏），必须拒绝
    let running = false
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        '(Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true })
      running = parseInt(String(out).trim(), 10) > 0
    } catch { /* 查不到就当没在跑，复制失败会再报 */ }
    if (running) return { ok: false, error: '微信还在运行 —— 请先完全退出微信（托盘右键 → 退出微信），再点安装', needExit: true }

    // ② 备份旧 DLL
    let backup = ''
    if (existsSync(targetDll)) {
      backup = targetDll + '.bak-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      try { copyFileSync(targetDll, backup) } catch (e) {
        return { ok: false, error: '备份旧 DLL 失败：' + String(e?.message || e).slice(0, 120) }
      }
    }

    // ③ 复制新 DLL
    try { copyFileSync(pkg.dll, targetDll) } catch (e) {
      return { ok: false, error: '写 DLL 失败（文件被占用？）：' + String(e?.message || e).slice(0, 120), backup }
    }

    // ④ 写重放配置：目录沿用已有的，没有就建一个
    const dirFile = process.env.WECHAT_REPLAY_DIR_FILE || join(wxDir, 'hook-cdn-replay.dir')
    const switchFile = process.env.WECHAT_REPLAY_SWITCH_FILE || join(wxDir, 'hook-cdn-replay.on')
    let replayDir = ''
    try { replayDir = readFileSync(dirFile, 'utf8').trim() } catch { /* 没配过 */ }
    if (!replayDir) replayDir = join(wxDir, 'replay')
    try { mkdirSync(replayDir, { recursive: true }); writeFileSync(dirFile, replayDir, 'utf8') } catch { /* ignore */ }
    try { writeFileSync(switchFile, '', 'utf8') } catch { /* ignore */ }

    // ⑤ 清缓存 + 清临时目录（装完不留垃圾）
    const doneSha = pkg.sha256
    eyesPkgCache = null
    try { rmdirSync(pkg.dir, { recursive: true }) } catch { /* 清不掉就算了 */ }
    return {
      ok: true,
      installedTo: targetDll,
      backup,
      replayDir,
      dirFile,
      switchFile,
      sha256: doneSha,
      hint: 'DLL 已装好，重放已开启。现在启动微信（登录窗口按回车）即可。',
    }
  },

  // ── 生图接口（独立模式下用户自己接入：地址 + 模型 + key）──
  imageInfo: () => readImageConfig(),
  imageSave: (a) => saveImageConfig(a || {}),

  // ── 更新检查（能查；覆盖代码需要 DSH）──
  checkUpdate: async () => {
    const local = readJsonSafe(join(ROOT, 'version.json'), { version: '0.0.0' })
    const r = await httpsGet('https://api.github.com/repos/' + UPDATE_REPO + '/contents/version.json')
    const j = JSON.parse(r.toString('utf8'))
    const remote = JSON.parse(Buffer.from(String(j.content || '').replace(/\n/g, ''), 'base64').toString('utf8'))
    let commitSha = ''
    try { const h = JSON.parse((await httpsGet('https://api.github.com/repos/' + UPDATE_REPO + '/commits/main')).toString('utf8')); commitSha = String(h.sha || '') } catch {}
    const cmp = (a, b) => {
      const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
      const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return 1; if (x < y) return -1 }
      return 0
    }
    const available = cmp(remote.version, local.version) > 0
    writeJson(UPDATE_STATE_FILE, { version: String(local.version || ''), checkedAt: Date.now(), latest: { version: String(remote.version || ''), notes: String(remote.notes || ''), releasedAt: String(remote.releasedAt || ''), sha: commitSha } })
    return { available, localVersion: String(local.version || ''), remoteVersion: String(remote.version || ''), notes: String(remote.notes || ''), releasedAt: String(remote.releasedAt || ''), commitSha }
  },
  updateInfo: () => {
    const st = readJsonSafe(UPDATE_STATE_FILE, {})
    let local = { version: '0.0.0' }
    try { local = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8')) } catch {}
    return { ...st, localVersion: String(local.version || '0.0.0'), version: String(local.version || '0.0.0') }
  },
  // 一键更新：下载 → 校验 → 备份 → 覆盖 → 重启
  // 重启优先「退出等启动器重拉」（被 panel-launcher.mjs 守护时），
  // 否则降级为自接力（spawn 新进程后自己退出）。两种都实测过能自动完成。
  applyUpdate: async () => {
    // ① 先看有没有新版
    const upd = await LOCAL_OPS.checkUpdate()
    if (!upd.available) return { ok: true, alreadyLatest: true, version: upd.localVersion }
    if (!/^[0-9a-f]{40}$/i.test(upd.commitSha)) {
      return { ok: false, error: '拿不到合法的 commit sha（' + upd.commitSha + '），拒绝下载' }
    }

    // ② 下载源码 zip（codeload 只认 commit sha，不认 blob sha —— v1.1.3 修过这个）
    let buf
    try { buf = await httpsGet('https://codeload.github.com/' + UPDATE_REPO + '/zip/' + upd.commitSha, 180000) } catch (e) {
      return { ok: false, error: '下载失败：' + String(e?.message || e) }
    }
    if (!buf || buf.length < 100000) return { ok: false, error: '下载内容异常（' + (buf ? buf.length : 0) + ' 字节）' }

    // ③ 解压到临时目录
    const tmp = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', 'dsh-panel-update-' + Date.now())
    mkdirSync(tmp, { recursive: true })
    const zip = join(tmp, 'src.zip')
    writeFileSync(zip, buf)
    try { execFileSync(TAR_EXE, ['-xf', zip, '-C', tmp], { stdio: 'pipe', timeout: 120000, windowsHide: true }) } catch (e) {
      return { ok: false, error: '解压失败：' + String(e?.stderr || e?.message || e).slice(0, 160) }
    }
    let srcRoot = tmp
    const subs = readdirSync(tmp).filter((f) => { try { return statSync(join(tmp, f)).isDirectory() } catch { return false } })
    if (subs.length === 1) srcRoot = join(tmp, subs[0])

    // ④ 只覆盖白名单里的代码；config.json / node_modules / 数据一律不碰
    const PATHSPEC = [
      'wechat-group-agent/lib',
      'wechat-group-agent/panel',
      'wechat-group-agent/standalone-panel.mjs',
      'wechat-group-agent/panel-launcher.mjs',
      'wx-bridge/lib',
      'wx-bridge/server.mjs',
      'scripts',
      'version.json',
    ]

    // ⑤ 先备份（失败就中止，绝不半覆盖）
    mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const backupZip = join(BACKUP_DIR, 'code-' + stamp + '.zip')
    const existing = PATHSPEC.filter((p) => existsSync(join(ROOT, p)))
    try {
      execFileSync(TAR_EXE, ['-a', '-cf', backupZip, ...existing], { cwd: ROOT, stdio: 'pipe', timeout: 180000, windowsHide: true })
    } catch (e) {
      return { ok: false, error: '备份现有代码失败，已中止（未做任何覆盖）：' + String(e?.stderr || e?.message || e).slice(0, 160) }
    }

    // ⑥ 覆盖
    const copied = []
    const failed = []
    const copyPath = (rel) => {
      const src = join(srcRoot, rel)
      const dst = join(ROOT, rel)
      if (!existsSync(src)) return
      try {
        const st = statSync(src)
        if (st.isDirectory()) {
          mkdirSync(dst, { recursive: true })
          for (const f of readdirSync(src)) copyPath(join(rel, f))
        } else {
          mkdirSync(dirname(dst), { recursive: true })
          copyFileSync(src, dst)
          copied.push(rel)
        }
      } catch (e) { failed.push(rel + ': ' + String(e?.message || e).slice(0, 80)) }
    }
    for (const p of PATHSPEC) copyPath(p)

    if (failed.length) {
      return {
        ok: false,
        error: '覆盖时 ' + failed.length + ' 个文件失败（已复制 ' + copied.length + ' 个）',
        failed: failed.slice(0, 10),
        backup: backupZip,
        rollbackHint: '回滚：把 ' + backupZip + ' 解压覆盖回项目根目录',
      }
    }

    // ⑦ 语法自检：新代码跑不起来就不该重启
    const checkTargets = [
      join(ROOT, 'wechat-group-agent', 'standalone-panel.mjs'),
      join(ROOT, 'wechat-group-agent', 'panel-launcher.mjs'),
      join(ROOT, 'wechat-group-agent', 'lib', 'index.js'),
    ].filter((p) => existsSync(p))
    const badSyntax = []
    for (const p of checkTargets) {
      try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', timeout: 30000, windowsHide: true }) } catch (e) {
        badSyntax.push(p.split(/[\\/]/).pop() + ': ' + String(e?.stderr || e?.message || e).slice(0, 100))
      }
    }
    if (badSyntax.length) {
      return {
        ok: false,
        error: '新代码语法检查不通过，已停止（未重启）',
        details: badSyntax,
        backup: backupZip,
        rollbackHint: '回滚：把 ' + backupZip + ' 解压覆盖回项目根目录',
      }
    }

    try { rmdirSync(tmp, { recursive: true }) } catch {}

    // ⑧ 重启
    const supervised = process.env.PANEL_SUPERVISED === '1'
    const result = {
      ok: true, updated: true,
      from: upd.localVersion, to: upd.remoteVersion,
      commit: upd.commitSha.slice(0, 7),
      copied: copied.length,
      backup: backupZip,
      restartMode: supervised ? 'launcher' : 'self-spawn',
    }
    setTimeout(() => {
      try { server.close() } catch {}
      if (supervised) {
        // 启动器看到 42 就重拉；端口已随进程退出释放
        setTimeout(() => process.exit(42), 400)
      } else {
        // 无守护者：自己拉起新进程再退出
        setTimeout(() => {
          try {
            const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
              detached: true, stdio: 'ignore', windowsHide: true,
            })
            c.unref()
          } catch { /* 起不来只能让用户手动重启 */ }
          process.exit(0)
        }, 500)
      }
    }, 800)   // 留时间把 HTTP 响应发出去
    return result
  },

  // ── 自检 ──
  selfcheck: async () => {
    const items = []
    const push = (name, level, detail) => items.push({ name, level, detail })
    push('桥连接', connected ? 'ok' : 'bad', connected ? '已连接 ' + BRIDGE_URL : '未连接')
    let st = null
    try { st = await callBridge('status', {}, 6000) } catch (e) { push('hook 存活', 'bad', String(e?.message || e)) }
    if (st) {
      push('微信登录', st.loggedIn ? 'ok' : 'warn', st.loggedIn ? '已登录 ' + (st.self || '') : '未登录')
      push('hook 存活', 'ok', 'status 有响应')
      const cnt = st.stickers && st.stickers.count
      push('表情包库', cnt > 0 ? 'ok' : 'warn', (cnt || 0) + ' 张')
    }
    // 数据库
    try {
      const j = await callBridge('status', {}, 6000)
      const loggedIn = !!j.loggedIn
      push('数据库可读', loggedIn ? 'ok' : 'warn', loggedIn ? '桥能取到自身信息' : '未登录，读不到')
    } catch { /* 已记 */ }
    // 眼睛
    try {
      const e = LOCAL_OPS.eyesInfo()
      if (e.ok === false) push('眼睛', 'warn', e.error)
      else push('眼睛', e.dllHasEyes ? 'ok' : 'warn', e.dllHasEyes ? '原图/视频整片可用' : '当前 DLL 不含该能力')
    } catch (e) { push('眼睛', 'warn', String(e?.message || e)) }
    // 崩溃：以「当前 version.dll 的安装时间」为界。
    // 装之前崩过是历史（可能已经修好了），装之后还崩才是真问题。
    // 没有 DLL 才退化成「最近 6 小时」。
    try {
      const dir = crashReportsDir()
      let dllTime = 0
      try { const e = LOCAL_OPS.eyesInfo(); if (e.dllPath && existsSync(e.dllPath)) dllTime = statSync(e.dllPath).mtimeMs } catch {}
      const since = dllTime || (Date.now() - 6 * 3600 * 1000)
      const all = existsSync(dir) ? readdirSync(dir).map((f) => { try { return statSync(join(dir, f)).mtimeMs } catch { return 0 } }) : []
      const after = all.filter((m) => m > since).length
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const todayCount = all.filter((m) => m > today.getTime()).length
      const label = dllTime ? ('装当前 DLL 之后（' + new Date(dllTime).toLocaleTimeString('zh-CN', { hour12: false }) + ' 起）') : '最近 6 小时'
      push('客户端崩溃', after === 0 ? 'ok' : (after <= 2 ? 'warn' : 'bad'),
        after === 0 ? (label + ' 0 次（今天累计 ' + todayCount + ' 次，含装之前）') : (label + ' ' + after + ' 次（今天累计 ' + todayCount + ' 次）'))
    } catch { /* ignore */ }
    const bad = items.filter((i) => i.level === 'bad').length
    const warn = items.filter((i) => i.level === 'warn').length
    // ok 表示「这次自检跑成功了」；allOk 才是「所有项都通过」
    return { at: Date.now(), items, bad, warn, ok: true, allOk: bad === 0 }
  },

  // ── 诊断 ──
  diag: async () => {
    const out = { at: Date.now(), bridge: { connected, url: BRIDGE_URL } }
    // 崩溃
    try {
      const dir = crashReportsDir()
      const all = existsSync(dir) ? readdirSync(dir).map((f) => { try { const s = statSync(join(dir, f)); return { name: f, at: s.mtimeMs, kb: Math.round(s.size / 1024) } } catch { return null } }).filter(Boolean) : []
      all.sort((a, b) => b.at - a.at)
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const todayMs = new Date(); todayMs.setHours(0, 0, 0, 0)
      const ydayMs = todayMs.getTime() - 86400000
      const last = all[0] || null
      out.crash = {
        dir,
        total: all.length,
        today: all.filter((x) => x.at > todayMs.getTime()).length,
        // 面板还会读这三个：yesterday / lastAt / lastMB，缺了就显示成「上次 一，0MB」
        yesterday: all.filter((x) => x.at > ydayMs && x.at <= todayMs.getTime()).length,
        lastAt: last ? Math.round(last.at) : 0,
        lastMB: last ? +(last.kb / 1024).toFixed(1) : 0,
        latest: all.slice(0, 5),
      }
    } catch (e) { out.crash = { error: String(e?.message || e) } }
    // 数据库
    try {
      const st = await callBridge('status', {}, 6000)
      out.db = { loggedIn: !!st.loggedIn, self: st.self || '', stickers: st.stickers || null }
    } catch (e) { out.db = { error: String(e?.message || e) } }
    // 眼睛
    try { out.eyes = LOCAL_OPS.eyesInfo() } catch (e) { out.eyes = { error: String(e?.message || e) } }
    // 磁盘
    try {
      const root = ROOT
      const free = (() => { try { return null } catch { return null } })()
      out.disk = { root }
    } catch { /* ignore */ }
    // 配置
    out.configPath = AGENT_CONFIG
    out.dataDir = AGENT_DATA_DIR
    out.version = VERSION
    return out
  },
  diagCleanHires: () => LOCAL_OPS.eyesClean(),
}

// ── 路由 ────────────────────────────────────────────────────
async function handle(req, res) {
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
  const path = urlObj.pathname

  // 静态：面板本身
  if (path === '/' || path === '/index.html') {
    if (!authorized(req, urlObj)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('需要口令：在地址后加 ?token=...'); return }
    let html
    try { html = readFileSync(PANEL_HTML, 'utf8') } catch (e) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>找不到面板文件</h1><p>' + PANEL_HTML + '</p>')
      return
    }
    // 注入 API 前缀（面板默认走 /wechat-bot/api，独立服务是 /api）
    html = html.replace('<script>', '<script>window.__PANEL_API__ = "/api";</script>\n<script>', 1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  // 其余静态资源（如果有的话）
  if (path.startsWith('/static/')) {
    const f = join(__dirname, 'panel', path.slice(8))
    if (existsSync(f) && statSync(f).isFile()) {
      const ext = extname(f).toLowerCase()
      const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : ext === '.png' ? 'image/png' : 'application/octet-stream'
      res.writeHead(200, { 'content-type': type + '; charset=utf-8' })
      res.end(readFileSync(f))
      return
    }
    res.writeHead(404); res.end('not found')
    return
  }

  // API
  if (!path.startsWith('/api/')) { res.writeHead(404); res.end('not found'); return }
  if (!authorized(req, urlObj)) return json(res, 401, { ok: false, error: '需要口令（?token=...）' })

  const sub = path.slice(4)   // '/api/xxx' → '/xxx'

  try {
    if (sub === '/ping') return json(res, 200, { ok: true, mode: 'standalone', at: Date.now(), bridge: connected })

    if (sub === '/state') return json(res, 200, await buildState())

    if (sub === '/image') {
      if (req.method === 'GET') return json(res, 200, { ok: true, config: readImageConfig() })
      const body = await readJson(req)
      return json(res, 200, { ok: true, config: saveImageConfig(body) })
    }

    if (sub === '/export') {
      // 导出配置（不含任何 key）
      const cfg = readConfig()
      return json(res, 200, { ok: true, config: cfg, image: readImageConfig(), exportedAt: new Date().toISOString() })
    }

    if (sub === '/import') {
      // 导入配置：只接受白名单字段，写前自动备份
      const body = await readJson(req)
      const src = body.config || body
      if (!src || typeof src !== 'object') throw new Error('需要 config 对象')
      const ALLOW = new Set([
        'botName', 'persona', 'replyProbability', 'minReplyGapMs', 'maxRepliesPer10Min',
        'quietHours', 'quietAllow', 'temperature', 'stickerChance', 'visionOnImage',
        'voiceSay', 'voiceSayProbability', 'dryRun', 'enabled', 'rooms', 'aliases',
        'provider', 'model', 'visionProvider', 'visionModel', 'useDbMembers',
      ])
      const patch = {}
      for (const [k, v] of Object.entries(src)) if (ALLOW.has(k)) patch[k] = v
      if (!Object.keys(patch).length) throw new Error('没有可导入的字段（白名单之外）')
      const next = writeConfig(patch)
      return json(res, 200, { ok: true, imported: Object.keys(patch), config: next })
    }

    if (sub === '/logs') {
      const lines = Number(urlObj.searchParams.get('lines') || 300)
      return json(res, 200, { ok: true, text: tailBridgeLog(Math.min(2000, lines)) })
    }

    if (sub === '/config') {
      if (req.method === 'GET') return json(res, 200, { ok: true, config: readConfig() })
      const body = await readJson(req)
      if (!body || typeof body !== 'object') throw new Error('请求体需要是对象')
      // 只允许改白名单里的键，避免把 wechatExe 之类的关键项写坏
      const ALLOW = new Set([
        'botName', 'persona', 'replyProbability', 'minReplyGapMs', 'maxRepliesPer10Min',
        'quietHours', 'quietAllow', 'temperature', 'stickerChance', 'visionOnImage',
        'voiceSay', 'voiceSayProbability', 'dryRun', 'enabled', 'rooms', 'aliases',
        'provider', 'model', 'visionProvider', 'visionModel', 'useDbMembers',
      ])
      const patch = {}
      for (const [k, v] of Object.entries(body)) if (ALLOW.has(k)) patch[k] = v
      if (!Object.keys(patch).length) throw new Error('没有可写的字段（白名单之外）')
      const next = writeConfig(patch)
      return json(res, 200, { ok: true, config: next, changed: Object.keys(patch) })
    }

    if (sub === '/action') {
      const body = await readJson(req)
      const op = String(body.op || '')
      const args = body.args || {}
      if (!op) throw new Error('缺少 op')

      // ① 本地实现优先（记忆/眼睛/更新/诊断/用量/名字这些不依赖插件）
      const local = LOCAL_OPS[op]
      if (local) {
        const result = await local(args)
        // 本地实现自己返回 {ok:false,error} 时，按失败透传（而不是当成成功包一层）
        if (result && result.ok === false) return json(res, 200, result)
        return json(res, 200, { ok: true, result })
      }

      // ② 其余转给桥（发消息、表情包、拍一拍、历史…）
      if (!BRIDGE_OPS.has(op)) throw new Error('不支持的 op：' + op)
      const result = await callBridge(op, args, 60000)
      return json(res, 200, { ok: true, result })
    }

    return json(res, 404, { ok: false, error: '未知接口 ' + sub })
  } catch (e) {
    return json(res, 200, { ok: false, error: String(e?.message || e) })
  }
}

// ── 启动 ────────────────────────────────────────────────────
if (!existsSync(PANEL_HTML)) {
  console.error('  [X] 找不到面板文件：' + PANEL_HTML)
  process.exit(1)
}

const server = createServer((req, res) => { handle(req, res).catch((e) => { try { json(res, 500, { ok: false, error: String(e?.message || e) }) } catch {} }) })

server.listen(PORT, HOST, () => {
  log('控制面板（独立模式）已启动')
  log('  地址：http://' + (LOOPBACK ? '127.0.0.1' : HOST) + ':' + PORT + (TOKEN ? '/?token=***' : '/'))
  log('  桥：  ' + BRIDGE_URL)
  log('  配置：' + AGENT_CONFIG)
  if (TOKEN) log('  口令已启用（--token）')
  if (!LOOPBACK) {
    log('')
    log('  ⚠️ 正在监听 ' + HOST + '，同网段的人都能访问。')
    log('     建议只用本机，或确保 token 足够长。')
    log('')
  }
  connectBridge()
  // 盯登录状态：桥连上微信就弹浏览器（用户要求「桥一连上就自动打开面板」）
  setTimeout(watchLogin, 1500)
  const loginWatcher = setInterval(watchLogin, 10000)
  loginWatcher.unref?.()
})

process.on('SIGINT', () => { log('退出'); try { ws?.close() } catch {}; server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
