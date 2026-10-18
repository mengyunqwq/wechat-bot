#!/usr/bin/env node
/**
 * wx-bridge —— 微信 ↔ WebSocket JSON 桥
 *
 * 职责边界（重要）：本进程只做"接入层"——收消息、发消息、归档表情包。
 * 所有"该不该回、回什么、像不像人"的策略都在 DSH 插件里（wx-group-agent），
 * 这样策略可以随时热改，不用重连微信。
 *
 * 用法：
 *   node server.mjs                # 真实模式（需微信 3.9.12.17 已登录）
 *   node server.mjs --mock         # 模拟模式（无需微信，用于开发/调策略）
 *   node server.mjs --self-test    # 自检：起 mock + WS 往返断言
 *
 * 端口：WS/HTTP 127.0.0.1:17300（--port 可改）；WCF SDK 用 10086/10087。
 */
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { StickerLibrary } from './lib/stickers.mjs'
import { createApiHandler } from './lib/api-http.mjs'
import { HostedMode } from './lib/hosted.mjs'
import { splitMessage, gapMs } from './lib/policy.mjs'
import { WcfBridge } from './lib/wcf.mjs'
import { MockBridge } from './lib/mock.mjs'
import { WxhelperBridge } from './lib/wxhelper.mjs'
import { WeChatHookBridge } from './lib/wechat-hook.mjs'
import { generateStickerImage, listEmotions, autoBubble } from './lib/genimage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}

const MOCK = flag('mock') || flag('self-test')
const SELFTEST = flag('self-test')
const PORT = Number(opt('port', SELFTEST ? '0' : '17300'))
const SDK_PORT = Number(opt('sdk-port', '10086'))
const DEBUG = flag('debug')
const ROOT_DIR = dirname(fileURLToPath(import.meta.url))   // 注意：不能用 new URL().pathname（中文会被 URL 编码）
const DATA_DIR = opt('data-dir', join(HERE, '..', 'data'))
const STICKER_DIR = join(DATA_DIR, 'stickers')
const LOG_DIR = join(DATA_DIR, 'logs')

mkdirSync(STICKER_DIR, { recursive: true })
mkdirSync(LOG_DIR, { recursive: true })

const startedAt = Date.now()
const stickers = new StickerLibrary(STICKER_DIR)
// 历史数据迁移：给老条目补 source（决定能否被挑出来发）
try {
  const migrated = stickers.migrateSources()
  if (migrated) console.log(`[sticker] 已为 ${migrated} 张历史表情补上来源标记：${JSON.stringify(stickers.sourceStats())}`)
} catch { /* ignore */ }
// 启动时导入"投递目录"里用户放的表情包图片
const IMPORT_DIR = join(DATA_DIR, 'stickers', 'import')
try {
  mkdirSync(IMPORT_DIR, { recursive: true })
  const r = stickers.importFromDir(IMPORT_DIR)
  if (r.added) console.log(`[sticker] 从投递目录导入 ${r.added} 张（跳过 ${r.skipped}）`)
} catch { /* ignore */ }
const clients = new Set()
const counters = { msgsIn: 0, msgsOut: 0, stickersCaptured: 0, drops: 0, errors: 0 }

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.map(String).join(' ')
  console.log(line)
  try {
    appendFileSync(join(LOG_DIR, 'bridge-' + new Date().toISOString().slice(0, 10) + '.log'), line + '\n')
  } catch { /* ignore */ }
}

function logMessage(m) {
  try {
    appendFileSync(
      join(LOG_DIR, 'messages-' + new Date().toISOString().slice(0, 10) + '.jsonl'),
      JSON.stringify(m) + '\n',
    )
  } catch { /* ignore */ }
}

/**
 * 广播事件给插件客户端。
 *
 * 只发给"已自报身份的最新那个"（activeClient）：
 * 插件热重载会残留旧实例，它们被踢掉后会自动重连，于是两个实例同时收消息 → 群里重复回答。
 * 只要事件只推给 activeClient，残留实例就永远收不到消息，重复回答从根上消失。
 */
let activeClient = null
function broadcast(evt) {
  const payload = JSON.stringify(evt)
  const targets = activeClient && activeClient.readyState === 1 ? [activeClient] : [...clients]
  for (const ws of targets) {
    try { if (ws.readyState === 1) ws.send(payload) } catch { /* ignore */ }
  }
}

// ── 桥实例（真实 / 模拟）────────────────────────────────────
// 注入只做一次：反复 destroy/init 会让微信不稳。注入成功后只等登录事件。
let wcfInjected = false
let ensureWcf = () => {}

const events = {
  started: (p) => { log('started', JSON.stringify(p)); broadcast({ t: 'started', ...p }) },
  login: (p) => { log('login self=' + p.self); broadcast({ t: 'login', ...p }) },
  logout: (p) => {
    log('logout')
    broadcast({ t: 'logout', ...p })
    // 退出登录后 SDK 的 rpc 会失效，必须重新注入
    wcfInjected = false
    setTimeout(() => ensureWcf(), 5000)
  },
  error: (p) => { counters.errors++; log('error', p.message); broadcast({ t: 'error', ...p }) },
  sticker: (p) => { counters.stickersCaptured++; broadcast({ t: 'sticker', ...p }) },
  'sticker-miss': (p) => { log('sticker-miss', JSON.stringify(p)); broadcast({ t: 'sticker-miss', ...p }) },
  sended: (p) => broadcast({ t: 'sended', ...p }),
  msg: (m) => {
    counters.msgsIn++
    // 丢弃历史积压（WCF 注入时可能回放旧消息；真人不会回复 2 分钟前的话）
    const age = Date.now() - (m.ts || 0)
    if (age > 90_000 && !MOCK) {
      counters.drops++
      return
    }
    logMessage(m)
    broadcast({ t: 'msg', m })
    // 托管模式：判定该不该回 → 问 agent → 拟人投递
    void hosted.onMessage(m).catch((e) => log('[托管] 处理失败：' + String(e?.message || e)))
  },
}

let bridge
const TRANSPORT = opt('transport', MOCK ? 'mock' : 'wxhelper')
if (MOCK) {
  bridge = new MockBridge({ emit: (e, p) => events[e]?.(p), stickers, dataDir: DATA_DIR, autoChat: true })
  bridge.start()
} else if (TRANSPORT === 'wechat-hook') {
  // aixed/WeChat-Hook（4.1.10.27）：version.dll 代理式加载，无需注入，HTTP 30001
  bridge = new WeChatHookBridge({
    apiPort: Number(opt('api-port', '30001')),
    pollMs: Number(opt('poll-ms', '1500')),
    stickers, dataDir: DATA_DIR,
    wechatExe: opt('wechat', 'D:\\wxhook\\hook-run\\Weixin.exe'),
    emit: (e, p) => events[e]?.(p),
    log: (s) => log(s),
  })
  ensureWcf = () => {
    if (wcfInjected) return
    void (async () => {
      try {
        await bridge.start()
        wcfInjected = true
        log('WeChat-Hook 就绪 self=' + bridge.selfWxid + '（' + bridge.selfName + '）')
      } catch (e) {
        const msg = String(e?.message || e)
        log('WeChat-Hook 未就绪：' + msg + ' —— 20s 后重试')
        broadcast({ t: 'error', message: 'WeChat-Hook 未就绪：' + msg })
        try { bridge.stop() } catch { /* ignore */ }
        wcfInjected = false
        setTimeout(() => ensureWcf(), 20_000).unref?.()
      }
    })()
  }
  ensureWcf()
} else if (TRANSPORT === 'wxhelper') {
  // 微信 4.x + wxhelper（wxhook 的 DLL）：DLL 自带 HTTP API，Node 直连
  bridge = new WxhelperBridge({
    apiPort: Number(opt('api-port', '19001')),
    sockPort: Number(opt('sock-port', '18999')),
    httpPort: Number(opt('cb-port', '18998')),
    stickers, dataDir: DATA_DIR,
    dllPath: opt('dll', 'D:\\wxhook\\wxhook.dll'),
    pythonExe: opt('python', 'D:\\Python311\\python.exe'),
    injector: opt('injector', 'D:\\wxhook\\inject_ctypes.py'),
    wechatExe: opt('wechat', 'D:\\wxhook\\weixin-run\\Weixin.exe'),
    emit: (e, p) => events[e]?.(p),
    log: (s) => log(s),
  })
  ensureWcf = () => {
    if (wcfInjected) return
    void (async () => {
      try {
        await bridge.start()
        wcfInjected = true
        log('wxhelper 就绪 self=' + bridge.selfWxid + '（' + bridge.selfName + '）')
      } catch (e) {
        const msg = String(e?.message || e)
        log('wxhelper 未就绪：' + msg + ' —— 20s 后重试')
        broadcast({ t: 'error', message: 'wxhelper 未就绪：' + msg })
        try { bridge.stop() } catch { /* ignore */ }
        wcfInjected = false
        setTimeout(() => ensureWcf(), 20_000).unref?.()
      }
    })()
  }
  ensureWcf()
} else {
  bridge = new WcfBridge({
    port: SDK_PORT, debug: DEBUG, stickers,
    emit: (e, p) => events[e]?.(p),
  })
  // 注入失败（微信没开/版本不符）→ 30s 后重试；
  // 注入成功但未登录 → **保持注入不动**，等微信扫码（agent 的 keepalive 会自己发现登录）
  ensureWcf = () => {
    if (wcfInjected) return
    try {
      bridge.start()
      wcfInjected = true
      if (bridge.isLogin()) log('WCF 就绪 self=' + bridge.selfWxid)
      else {
        log('SDK 已注入，等待微信扫码登录（登录后自动就绪，不会重复注入）')
        broadcast({ t: 'error', message: '等待微信登录：请在弹出的微信里扫码' })
      }
    } catch (e) {
      const msg = String(e?.message || e)
      log('WCF 注入失败：' + msg + ' —— 30s 后重试')
      broadcast({ t: 'error', message: 'WCF 注入失败：' + msg })
      try { bridge.stop() } catch { /* ignore */ }
      wcfInjected = false
      setTimeout(() => ensureWcf(), 30_000).unref?.()
    }
  }
  ensureWcf()
}

// ── 命令处理 ────────────────────────────────────────────────
// ── Agnes 排队爆满时的后台补生成队列 ────────────────────────────
// 503 "image queue is full" 是常态。失败就排进队列，过几分钟自动重试；
// 成功即入库，之后同题材直接命中缓存 —— 机器人回话完全不被阻塞。
// 进程级兜底：桥是独立进程，之前一个漏网的未处理拒绝就会让整个桥退出
// （Node >=15 默认 unhandledRejection=throw）→ 机器人断线，直到有人手动重启桥。
// 现在记录并继续跑 —— 桥是无状态传输层，带病续命比整体死亡好。
process.on('uncaughtException', (e) => log('未捕获异常（桥保持运行）：' + (e?.stack || String(e))))
process.on('unhandledRejection', (e) => log('未处理拒绝（桥保持运行）：' + (e?.stack || String(e))))

const genRetry = new Map()   // 题材 → { extra, bubble, tries, nextAt }

function enqueueGenRetry(emotion, opts = {}) {
  const key = String(emotion || '').trim()
  if (!key) return
  const cur = genRetry.get(key) || { tries: 0 }
  if (cur.tries >= 4) { log(`「${key}」后台重试已达上限，放弃`); return }
  const delayMin = [3, 8, 15, 30][Math.min(cur.tries, 3)]
  genRetry.set(key, { extra: opts.extra || '', bubble: opts.bubble || '', tries: cur.tries + 1, nextAt: Date.now() + delayMin * 60_000 })
  log(`Agnes 忙：「${key}」排进后台补生成队列（${delayMin} 分钟后第 ${cur.tries + 1} 次）`)
}

async function processGenRetry() {
  if (!genRetry.size) return
  for (const [emotion, job] of [...genRetry]) {
    if (Date.now() < job.nextAt) continue
    genRetry.delete(emotion)
    try {
      const r = await generateStickerImage({
        emotion,
        refImage: join(DATA_DIR, 'stickers', 'ref', 'main.jpg'),
        outDir: join(DATA_DIR, 'stickers', 'gen'),
        extra: job.extra,
        log,
      })
      let file = r.file
      const bubble = job.bubble || autoBubble(emotion)
      if (bubble) {
        const out = r.file.replace(/\.(jpg|jpeg|png)$/i, '') + '-bubble.png'
        try {
          execFileSync(process.env.PYTHON_EXE || 'D:\\Python311\\python.exe',
            [join(ROOT_DIR, 'add-bubble.py'), r.file, out, bubble, '--pos', 'top'], { stdio: 'ignore', timeout: 30_000 })
          file = out
        } catch { /* 气泡失败就用原图 */ }
      }
      stickers.add({ srcPath: file, context: ('agnes生成 ' + emotion + ' ' + job.extra + ' ' + bubble).trim(), kind: 'image', source: 'gen', senderName: 'AI 生成' })
      log(`后台补生成成功：「${emotion}」已入库${bubble ? '（气泡：' + bubble + '）' : ''}`)
    } catch (e) {
      const msg = String(e?.message || e)
      if (/503|queue is full|429|timeout|ECONN/i.test(msg)) enqueueGenRetry(emotion, job)
      else log(`后台补生成放弃「${emotion}」：${msg}`)
    }
  }
}
setInterval(() => { void processGenRetry() }, 60_000)

async function handle(op, a = {}) {
  switch (op) {
    case 'status':
      return { ...bridge.status(), startedAt, counters, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }
    case 'rooms':
      return bridge.rooms()
    case 'members': {
      // 缓存：群成员查询要走数据库（较慢），20 秒内重复调用直接返回缓存。
      // 注意**不要**返回空列表 —— 那会让调用方以为"群里没人"。
      {
        const now = Date.now()
        if (globalThis.__membersCache && now - globalThis.__membersCacheAt < 20000) {
          return { ...globalThis.__membersCache, source: (globalThis.__membersCache.source || '') + '+cached' }
        }
      }
      const roomId = a.roomId
      // 修好 hook 的 QueryDB 后，优先走数据库拿真实昵称（备注优先）
      if (typeof bridge.groupMembers === 'function') {
        try {
          const list = await bridge.groupMembers(roomId)
          if (list.length) {
            const nameMap = {}
            for (const m of list) nameMap[m.wxid] = m.name || m.nick || m.wxid
            const out = { members: list, nameMap, selfWxid: bridge.selfWxid, source: 'contact.db' }
            globalThis.__membersCache = out
            globalThis.__membersCacheAt = Date.now()
            return out
          }
        } catch (e) { log('数据库取群成员失败，回退旧路径：' + String(e?.message || e)) }
      }
      if (typeof bridge.members0 === 'function') return bridge.members0(roomId)
      const m = await bridge.members(roomId)
      return { members: m.members, nameMap: m.nameMap, selfWxid: bridge.selfWxid, source: 'legacy' }
    }
    case 'selfNames':
      return typeof bridge.selfNamesIn === 'function' ? bridge.selfNamesIn(a.roomId) : [bridge.selfName || bridge.selfWxid]
    case 'history':
      return bridge.history(a.roomId, a.limit || 20)
    case 'searchMessages': {
      // 检索历史消息（长记忆：群里提起以前说过的，就从微信数据库里查出来）
      // 数据源是微信自己的库（轮询器已经在读），不用另建数据库。
      if (!bridge.poller || typeof bridge.poller.searchMessages !== 'function') {
        return { items: [], error: '轮询器未就绪（数据库不可用）' }
      }
      try {
        const items = await bridge.poller.searchMessages(
          a.roomId, a.query || '', a.limit || 20, a.scan || 800)
        return { items, query: a.query || '' }
      } catch (e) {
        return { items: [], error: String(e?.message || e) }
      }
    }
    case 'sendText': {
      // 真 @：正文里出现 "@昵称" 时，自动查群成员映射转成 wxid 填进 hook 的 atlist，
      // 被 @ 的人才会真的收到提醒（红点）。显式传了 mentions 就用调用方的。
      let mentions = Array.isArray(a.mentions) ? a.mentions.filter(Boolean) : []
      if (!mentions.length) {
        try {
          const nm = globalThis.__membersCache?.nameMap
          if (nm) {
            const rev = {}
            for (const [wxid, name] of Object.entries(nm)) if (name) rev[name] = wxid
            const ats = [...String(a.text || '').matchAll(/@([^\s@]{1,24})/g)].map((m) => m[1])
            mentions = ats.map((n) => rev[n]).filter(Boolean)
            if (mentions.length) log(`真 @：解析出 ${mentions.length} 个 wxid → atlist`)
          }
        } catch { /* 解析失败就退化为纯文本 @ */ }
      }
      // split: true → 长文本自动拆成多条发（每条之间用拟人间隔）
      // chance: 0 表示短文本不拆，长文本靠长度规则必定拆
      const parts = a.split
        ? splitMessage(a.text, { maxParts: a.maxLines || 3, chance: 0 })
        : [a.text]
      let rc = 0
      for (let i = 0; i < parts.length; i++) {
        rc = await bridge.sendText(a.roomId, parts[i], i === 0 ? mentions : [])
        counters.msgsOut++
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, gapMs()))
      }
      return { rc, parts: parts.length }
    }
    case 'sendSticker': {
      const item = a.stickerId ? stickers.get(a.stickerId) : stickers.pick({ text: a.text || '', roomId: a.roomId })
      if (!item) return { rc: -1, error: '没有可用的表情包（库为空或不匹配）' }
      const rc = await bridge.sendEmotion(a.roomId, item.file, item.xml)
      stickers.markUsed(item.id)
      counters.msgsOut++
      return { rc, stickerId: item.id, file: item.file, viaXml: !!item.xml }
    }
    case 'pickSticker': {
      // 只挑"生成接口的 + 用户自己投递的"表情（默认），群里收藏的不参与挑选
      const allowed = Array.isArray(a.allowedSources) && a.allowedSources.length
        ? a.allowedSources
        : (process.env.STICKER_SOURCES || 'gen,import').split(',').map((s) => s.trim()).filter(Boolean)
      const item = stickers.pick({ text: a.text || '', roomId: a.roomId, minScore: a.minScore ?? 3, allowedSources: allowed })
      return item ? { id: item.id, file: item.file, tags: item.tags, source: item.source, uses: item.uses, seen: item.seenCount } : null
    }
    case 'sendImage': {
      const rc = await bridge.sendImage(a.roomId, a.path)
      counters.msgsOut++
      return { rc }
    }
    case 'sendFile': {
      const rc = await bridge.sendFile(a.roomId, a.path)
      counters.msgsOut++
      return { rc }
    }
    case 'pat': {
      const rc = await bridge.pat(a.roomId, a.wxid)
      counters.msgsOut++
      return { rc }
    }
    case 'revoke':
      return { rc: await bridge.revoke(a.id) }
    case 'forward':
      return { rc: await bridge.forward(a.id, a.roomId) }
    case 'stickers':
      return { stats: stickers.stats(), items: stickers.list(a.limit || 30) }
    case 'importStickers': {
      const r = stickers.importFromDir(join(DATA_DIR, 'stickers', 'import'))
      return { ...r, stats: stickers.stats() }
    }
    case 'genEmotions':
      return listEmotions()
    case 'fetchVideo': {
      // 视频（type 43）：主路是"抽帧拼联系表 + 抽音轨 WAV"（本地 ffmpeg，见 lib/wechat-video.mjs），
      // 拿不到视频文件就退回明文封面。**音轨转写由插件侧做**（DSH 的 speechToText，桥没有 ASR 服务）。
      if (typeof bridge.fetchVideo !== 'function') return { file: null, error: '该接入层不支持 fetchVideo' }
      const v = await bridge.fetchVideo(
        String(a.xml || ''), String(a.roomId || ''), Number(a.ts || 0), Number(a.frames || 6))
      return v ? { ...v } : { file: null }
    }
    case 'fetchMedia': {
      // 尽力取到消息里的媒体图（表情包能取到，图片 type=3 通常取不到）
      const file = await bridge.fetchMedia(String(a.xml || ''), Number(a.type || 0), String(a.roomId || ''), Number(a.ts || 0))
      return { file: file || null }
    }
    case 'addBubble': {
      // 给已有表情加文字气泡（验证/手动补气泡用）：AI 不画字，气泡由 Pillow 后画
      const src = String(a.file || '')
      const text = String(a.text || '').trim()
      if (!src || !text) return { ok: false, error: '需要 file 和 text' }
      const out = src.replace(/\.(jpg|jpeg|png)$/i, '') + '-bubble.png'
      const py = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
      try {
        execFileSync(py, [join(ROOT_DIR, 'add-bubble.py'), src, out, text, '--pos', String(a.pos || 'top')], { stdio: 'ignore', timeout: 30_000 })
        const item = stickers.add({ srcPath: out, context: '气泡 ' + text, kind: 'image', source: 'gen', senderName: 'AI 生成' })
        log('加气泡成功「' + text + '」→ ' + out)
        return { ok: true, file: out, stickerId: item?.id }
      } catch (e) { return { ok: false, error: String(e?.message || e) } }
    }
    case 'genSticker': {
      // 用 Agnes 图生图现场生成表情包（主体按参考图）。
      // 同情绪默认复用已生成的（省调用 + 角色一致）；force=true 强制重新生成。
      const emotion = String(a.emotion || '开心').trim()
      const extra = String(a.extra || '').trim()
      const REF = join(DATA_DIR, 'stickers', 'ref', 'main.jpg')
      // 只对"没有额外场景要求"的做复用缓存；带场景描述的要每次现画（否则场景永远一样）
      if (!a.force && !extra && !a.bubble) {
        const cached = stickers.items.find((it) => it.file
          && (it.tags || []).includes('agnes生成')
          && (it.tags || []).includes(emotion))
        if (cached) return { cached: true, stickerId: cached.id, file: cached.file, emotion }
      }
      const r = await generateStickerImage({
        emotion,
        refImage: REF,
        outDir: join(DATA_DIR, 'stickers', 'gen'),
        extra,
        style: a.style || '',
        log: (s) => log(s),
      }).catch((e) => {
        // Agnes 排队爆满是常态：排进后台队列稍后补生成（不阻塞机器人回话）
        const msg = String(e?.message || e)
        if (/503|queue is full|429|timeout|ECONN/i.test(msg)) enqueueGenRetry(emotion, { extra, bubble: String(a.bubble || '') })
        throw e
      })
      // ── 文字气泡：AI 画中文不可靠，所以生成完用 Pillow 后画上去 ──
      let file = r.file
      let bubble = String(a.bubble || '').trim()
      if (!bubble && a.autoBubble !== false && Math.random() < (Number(a.bubbleChance ?? 0.55))) {
        bubble = autoBubble(emotion)
      }
      if (bubble) {
        const out = r.file.replace(/\.(jpg|jpeg|png)$/i, '') + '-bubble.png'
        const py = process.env.PYTHON_EXE || 'D:\\Python311\\python.exe'
        const script = join(ROOT_DIR, 'add-bubble.py')
        try {
          execFileSync(py, [script, r.file, out, bubble, '--pos', String(a.bubblePos || 'top')], { stdio: 'ignore', timeout: 30_000 })
          file = out
          log(`已加文字气泡「${bubble}」→ ${out}`)
        } catch (e) {
          log('加气泡失败（用无气泡版本）：' + String(e?.message || e))
        }
      }
      const item = stickers.add({
        srcPath: file,
        context: `agnes生成 ${emotion} ${extra} ${bubble}`.trim(),
        kind: 'image',
        source: 'gen',
        senderName: 'AI 生成',
      })
      counters.stickersCaptured++
      // ── 入库后删掉中间文件（用户要求：入库后不留原图）──
      // stickers.add 已经把图**复制**进 files/ 了，所以删源文件不会影响库。
      // 实测不删的话，每生成一张就多堆一个 1MB+ 的中间文件（攒了 31 个 / 23.8MB）。
      // 用动态 import 取 fs，避免动文件顶部的导入行。
      try {
        const fsm = await import('node:fs')
        for (const p of [file, r.raw]) {
          const s = String(p || '')
          if (s && fsm.existsSync(s)
              && !s.includes('stickers\\files') && !s.includes('stickers/files')) {
            fsm.unlinkSync(s)
            log('入库后删除中间文件：' + s)
          }
        }
      } catch (e) { log('删中间文件失败（不影响使用）：' + String(e?.message || e)) }
      return { cached: false, emotion, extra, bubble, stickerId: item?.id, file, remoteUrl: r.url }
    }
    case 'pruneStickers':
      return { removed: stickers.prune() }
    default:
      throw new Error('未知命令: ' + op)
  }
}

// ── HTTP + WS 服务 ──────────────────────────────────────────
// 托管模式：别的 agent 只提供"说什么"，桥负责"像不像人"（见 lib/hosted.mjs）
// 数据库长时间打不开时，请插件"自己说一句"来唤醒它（比重启客户端温和，且不需要手机确认）
if (typeof bridge === 'object' && bridge) {
  bridge.onNeedWake = () => {
    log('数据库打不开 → 广播 wake，让插件自己发一句把库唤醒')
    broadcast({ t: 'wake' })
  }
}

const hosted = new HostedMode({
  handle: (op, args) => handle(op, args || {}),
  log: (t) => log('[托管] ' + t),
  dataDir: DATA_DIR,
  onEvent: (e) => broadcast({ t: 'hosted', e }),
})

const apiHandler = createApiHandler({
  hosted,
  handle: (op, args) => handle(op, args || {}),
  rooms: () => bridge.rooms(),
  log: (s) => log(s),
  bridge,
  counters,
  startedAt,
})

const server = http.createServer((req, res) => {
  // ── HTTP API（给只会 HTTP 的 agent/脚本用，见 PROTOCOL.md）──
  try {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname.startsWith('/api')) { void apiHandler(req, res, u); return }
  } catch { /* ignore */ }
  if (req.url === '/status' || req.url === '/') {
    const body = JSON.stringify({
      ...bridge.status(), startedAt, counters, clients: clients.size,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }, null, 2)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
    return
  }
  if (req.url === '/stickers') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ stats: stickers.stats(), items: stickers.list(50) }, null, 2))
    return
  }
  res.writeHead(404); res.end('not found')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  clients.add(ws)
  ws.ident = ''          // 客户端自报的身份（插件会发 identify）
  log('client connected (' + clients.size + ') ' + (req?.url || ''))
  ws.send(JSON.stringify({
    t: 'hello',
    mock: MOCK,
    status: bridge.status(),
    counters,
    self: bridge.selfWxid || bridge.selfName || '',
  }))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const { id, op, ...args } = msg

    // 身份登记 + 去重：同一个身份只允许一个连接活着。
    // 教训：插件热重载会留下旧实例继续连着桥 → 每条消息被处理两遍 → 群里出现重复回答。
    if (op === 'identify') {
      ws.ident = String(args.name || 'unknown')
      log('identify 收到: ' + ws.ident + ' pid=' + (args.pid || '?'))
      let evicted = 0
      // 只有插件本体能接管事件流：调试脚本自报身份时不该把插件顶掉（我自己踩过）
      // 只有"带版本号的新式实例"才允许踢人：
      // 热重载会留下旧实例（旧代码没有 ver），它会不停重连并踢掉新实例 → 新实例连不上 → 不回复消息
        const isModern = args.ver !== undefined && args.ver !== null
        ws.isModern = isModern
        const ver = String(args.ver || '')
        if (ws.ident === 'dsh-wechat-bot' && isModern) {
          // 版本比较：只有 ver 不低于当前活动实例的才允许接管。
          // 热重载会留下旧实例，它会不停重连并踢掉新实例 -> 两个实例 ping-pong 互踢，
          // 谁正在发消息谁就失败（实测消息直接丢失，表现成不动了）。
          // 旧实例这里只拒绝、不踢：踢了它会立刻重连，反而形成重连风暴。
          const curVer = String(activeClient?.ver || '')
          if (curVer && ver && ver < curVer) {
            log(`拒绝旧实例接管（ver=${ver} < 当前 ${curVer}）—— 不踢它，让它安静待着`)
            if (id) ws.send(JSON.stringify({ t: 'reply', id, op, ok: true,
              result: { identified: ws.ident, rejected: true, reason: 'older version', active: false } }))
            return
          }
          ws.ver = ver
        // 防呆：托管模式和 DSH 插件是**两个大脑**，同时开会双重回复
        if (hosted && hosted.cfg.enabled) {
          log('⚠️ 警告：DSH 插件已接管，但托管模式(hosted)也开着 → 会双重回复！'
            + '建议 POST /api/hosted {"enabled":false} 关掉托管')
        }
        activeClient = ws               // 之后所有事件只推给它（防止残留实例重复处理）
        for (const other of clients) {
          // 把其他连接全踢掉：热重载残留的旧实例会继续收消息 → 群里重复回答（实测踩过）
          if (other !== ws) {
            try { other.close(4000, 'replaced by newer instance') } catch { /* ignore */ }
            clients.delete(other)
            evicted++
          }
        }
        if (evicted) log(`踢掉 ${evicted} 个旧连接（保留 ${ws.ident}）—— 防止重复回答`)
      }
      if (id) ws.send(JSON.stringify({ t: 'reply', id, op, ok: true, result: { identified: ws.ident, evicted, active: activeClient === ws } }))
      return
    }

    void (async () => {
      try {
        const result = await handle(op, args)
        ws.send(JSON.stringify({ t: 'reply', id, op, ok: true, result }))
      } catch (e) {
        const message = String(e?.message || e)
        counters.errors++
        log('cmd failed', op, message)
        ws.send(JSON.stringify({ t: 'reply', id, op, ok: false, error: message }))
      }
    })()
  })

  ws.on('close', () => { clients.delete(ws); if (activeClient === ws) activeClient = null; log('client left (' + clients.size + ')') })
  ws.on('error', () => { clients.delete(ws) })
})

server.listen(PORT, '127.0.0.1', async () => {
  const actual = server.address().port
  writeFileSync(join(DATA_DIR, 'bridge-port.txt'), String(actual))
  // 记录 PID：停止脚本按 PID 精确杀进程。
  // 教训：绝不能用 `CommandLine -match 'wx-bridge'` 找进程——DSH 自己的子进程 runner
  // 命令行里会包含调用者的命令文本，会把自己人杀掉（实测踩过）。
  try { writeFileSync(join(DATA_DIR, 'bridge.pid'), String(process.pid)) } catch { /* ignore */ }
  log(`wx-bridge 监听 127.0.0.1:${actual}  mock=${MOCK}  pid=${process.pid}  表情包库=${stickers.size} 张`)
  if (SELFTEST) await selfTest(actual)
})

// ── 自检 ────────────────────────────────────────────────────
async function selfTest(port) {
  const { default: WebSocket } = await import('ws')
  const fails = []
  const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails.push(label) }

  console.log('\n=== wx-bridge 自检 ===')
  ok(stickers.size >= 3, `表情包库已注入素材（${stickers.size} 张）`)

  const picked = stickers.pick({ text: '哈哈哈笑死', roomId: 'mock-room-1', minScore: 1 })
  ok(!!picked, '按语境能挑出表情包：' + (picked ? picked.id : 'null'))

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const waiters = new Map()
  let seq = 0
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = 'st' + (++seq)
    waiters.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, op, ...args }))
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(op + ' 超时')) } }, 8000)
  })
  const gotMsg = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.t === 'reply' && waiters.has(m.id)) {
        const w = waiters.get(m.id); waiters.delete(m.id)
        m.ok ? w.resolve(m.result) : w.reject(new Error(m.error))
      }
      if (m.t === 'msg') resolve(m.m)
    })
  })

  await new Promise((r) => ws.on('open', r))
  ok(true, 'WS 连接成功')

  const status = await call('status')
  ok(status.mock === true, 'status 返回 mock=true')
  ok(status.stickers.count >= 3, `status 报告表情包 ${status.stickers?.count} 张`)

  const m = await Promise.race([gotMsg, new Promise((r) => setTimeout(() => r(null), 20000))])
  ok(!!m, '实时收到群消息：' + (m ? `[${m.senderName}] ${m.text}` : '超时'))

  const sent = await call('sendText', { roomId: 'mock-room-1', text: '自检消息' })
  ok(sent.rc === 0, 'sendText 成功 rc=' + sent.rc)

  const st = await call('sendSticker', { roomId: 'mock-room-1', text: '哈哈哈' })
  ok(st.rc === 0 && !!st.stickerId, 'sendSticker 成功 ' + (st.stickerId || st.error))

  const rooms = await call('rooms')
  ok(rooms.length >= 1, `rooms 返回 ${rooms.length} 个群`)

  ws.close()
  console.log(fails.length ? `\n结果：${fails.length} 项失败\n` : '\n结果：全部通过\n')
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300)
}
