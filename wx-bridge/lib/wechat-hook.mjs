/**
 * aixed/WeChat-Hook（4.1.10.27）传输层 —— 与 WcfBridge 接口一致。
 *
 * 为什么用它（而不是注入式方案）：
 *   它以 **version.dll 代理**方式加载：把 version.dll 放进客户端目录，微信启动时自己加载，
 *   **完全不需要注入**，因此没有"注入后服务崩/微信崩"的问题。
 *
 * 实测结论（这些是踩出来的，别凭猜改）：
 *   - 收消息：必须带启动参数 `RecvType=1 CallBackURL=http://127.0.0.1:<cbPort>` 启动客户端，
 *     之后 DLL 会把每条消息 POST 到该地址。运行时 /set_callback 只改配置、不装钩子。
 *   - 回调格式：{event_type:1001, msgid, type, timestamp, wxid, sender, roomid, content}
 *       type: 1=文本 3=图片 47=表情 51/10002=系统同步（要过滤掉，量大）
 *       wxid = 收消息的账号（即机器人自己）；sender = 发送者；roomid 非空 = 群消息
 *   - /QueryDB/* 与 IsLogin 在这套构建上是坏的（GetAllDBName 恒空、句柄取不到），
 *     所以登录态不能信它，用"是否收到过回调"来判断。
 *   - 发送：/SendTextMsg、/SendImgMsg、/ForwardXMLMsg（发表情包用 XML 转发）
 */
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mark as fMark } from './forensics.mjs'
import { tmpdir } from 'node:os'

// ── 高分辨率图片提供者（hires provider）────────────────────────────────────
//   本机可选安装一个「提供者」（不随本项目分发），它会把全分辨率的图写到这个目录。
//   会把全尺寸的图（明文 JPEG）写到这个目录。
//   实测 1260x2800 / 1.46MB —— 不用解密、不用 HEVC 解码，直接就是能识别的原图。
//   文件名约定 = <roomId>_<unix秒>_<localId>_<序号>_<任意标记>.dat
// ── 眼睛（hires provider）目录：**动态解析**，面板改了就生效 ──────
//  优先级：① 环境变量 WECHAT_HIRES_DIR  ② DLL 写的 hook-cdn-replay.dir  ③ 默认 D:\cdndl-replay
//  为什么不缓存成常量：面板里"选个文件夹就想立马能用"，缓存了就得重启桥。
const REPLAY_DIR_FILE = process.env.WECHAT_REPLAY_DIR_FILE || 'D:\\wxhook\\wx4110\\hook-cdn-replay.dir'
const REPLAY_SWITCH_FILE = process.env.WECHAT_REPLAY_SWITCH_FILE || 'D:\\wxhook\\wx4110\\hook-cdn-replay.on'
function hiresDir() {
  const env = process.env.WECHAT_HIRES_DIR
  if (env) return env
  try {
    const s = readFileSync(REPLAY_DIR_FILE, 'utf8').trim()
    if (s) return s
  } catch { /* 文件不存在就回退 */ }
  return 'D:\\cdndl-replay'
}

async function waitHiresImage(roomId, tsIn, timeoutMs = 8000) {
  if (!roomId || !tsIn) return null
  // ★ ts 单位坑：插件传【毫秒】(1792571878000)，文件名里是【秒】(1792571878)
  let ts = Number(tsIn)
  if (ts > 1e12) ts = Math.round(ts / 1000)
  try { pruneHiresDir() } catch { /* ignore */ }
  const seenSize = new Map()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      let best = null
      for (const f of readdirSync(hiresDir())) {
        // 契约：<roomId>_<unix秒>_<localId>_<序号>_<任意标记>.dat（内容必须是明文 JPEG）
        const m = f.match(/^(.+)_(\d{10})_(\d+)_(\d+)_.*\.dat$/)
        if (f.includes('hdvideo')) continue          // 视频文件别当图片
        if (!m) continue
        if (m[1] !== roomId) continue
        if (Math.abs(Number(m[2]) - ts) > 5) continue     // 允许 5 秒偏差
        const p = join(hiresDir(), f)
        let sz = 0
        try { sz = statSync(p).size } catch { continue }
        if (sz < 3000) continue
        {
          const prev = seenSize.get(f)
          seenSize.set(f, sz)
          if (prev === undefined || prev !== sz) continue   // 还在写，等下一轮
        }
        if (!best || sz > best.size) best = { path: p, name: f, size: sz }
      }
      if (best) return best
    } catch { /* 目录还没建 */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/** 把重放出来的 .dat（其实是 JPEG）复制成 .jpg —— DSH 的图片入库按扩展名判断，.dat 会被拒 */
function hiresToJpg(src) {
  const tmpDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'wechat-image-tmp')
  try { mkdirSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  const dst = join(tmpDir, `hires-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`)
  copyFileSync(src, dst)
  return dst
}

/** 清理重放目录：删掉 2 小时前的文件（每张图 0.1~1.5MB，不清理会一直涨） */
let g_lastPrune = 0
function pruneHiresDir(maxAgeMs = 2 * 3600_000, keepLatest = 60) {
  const now = Date.now()
  if (now - g_lastPrune < 60_000) return
  g_lastPrune = now
  let files = []
  try { files = readdirSync(hiresDir()) } catch { return }
  let removed = 0
  const stat = []
  for (const f of files) {
    try { stat.push({ f, t: statSync(join(hiresDir(), f)).mtimeMs }) } catch { /* ignore */ }
  }
  stat.sort((a, b) => b.t - a.t)
  stat.forEach((x, idx) => {
    if (idx < keepLatest) return
    if (now - x.t < maxAgeMs) return
    try { unlinkSync(join(hiresDir(), x.f)); removed++ } catch { /* ignore */ }
  })
  return removed
}
// ── 表情包图片收藏（2026-10-21）──────────────────────────────────────────────
//   收到群友发来的表情包（type=47）时：
//     ① 老逻辑：只存 XML（原生表情转发用，但本构建的 ForwardXMLMsg 会崩，所以发不出去）
//     ② 新逻辑：顺手把 cdnurl 的图片本体下下来存进表情库 → 之后就能用 /SendImgMsg 发出去
//   表情的 cdnurl 是明文（vweixinf.tc.qq.com），不需要解密、不需要 aeskey。
async function collectStickerImage(xml, lib, meta) {
  try {
    const s = String(xml || '')
    const m = s.match(/cdnurl="([^"]+)"/) || s.match(/cdnthumburl="([^"]+)"/)
    if (!m) return
    const url = m[1].replace(/&amp;/g, '&')
    if (!/^https?:\/\//i.test(url)) return
    const tmpDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'wechat-image-tmp')
    try { mkdirSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) { meta.log(`表情包下载失败：HTTP ${res.status}`); return }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 8 * 1024 * 1024) return
    // 按魔数定扩展名（表情常见 gif/png/jpg/webp）
    let ext = '.gif'
    if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg'
    else if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png'
    else if (buf.slice(0, 3).toString() === 'GIF') ext = '.gif'
    else if (buf.length > 12 && buf.slice(8, 12).toString() === 'WEBP') ext = '.webp'
    const tmp = join(tmpDir, `stk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
    writeFileSync(tmp, buf)
    const item = lib.add({
      srcPath: tmp, xml, kind: 'emoticon', source: 'collected',
      sender: meta.sender, senderName: meta.senderName, roomId: meta.roomId, context: meta.context,
    })
    if (item) {
      meta.log(`表情包已收藏：${item.id}${item.file ? '（含图片，可发送）' : '（仅 XML）'} ${Math.round(buf.length / 1024)}KB`)
    }
    try { unlinkSync(tmp) } catch { /* ignore */ }
  } catch (e) {
    try { meta.log('表情包下载异常：' + String(e?.message || e).slice(0, 100)) } catch { /* ignore */ }
  }
}

/** 找 hires provider 写的【视频】文件（文件名含 _hdvideo_），等它写完才返回
 *  ★ 2026-10-21 修复：以前一看到 >50KB 就复制，结果拿到半截文件 → 抽帧/音轨全错。
 *    现在要求：① 与消息时间差 ≤5 秒  ② 大小与 XML 声明值接近  ③ 连续两次采样大小不变
 */
async function waitHiresVideo(roomId, tsIn, timeoutMs = 20000, declaredBytes = 0) {
  if (!roomId || !tsIn) return null
  let ts = Number(tsIn)
  if (ts > 1e12) ts = Math.round(ts / 1000)
  const t0 = Date.now()
  const seen = new Map()
  const want = Number(declaredBytes) || 0
  while (Date.now() - t0 < timeoutMs) {
    let best = null
    let bestDelta = Infinity
    try {
      for (const f of readdirSync(hiresDir())) {
        if (!f.includes('hdvideo')) continue
        const m = f.match(/^(.+)_(\d{10})_(\d+)_(\d+)_/)
        if (!m || m[1] !== roomId) continue
        const delta = Math.abs(Number(m[2]) - ts)
        if (delta > 5) continue
        const p = join(hiresDir(), f)
        let sz = 0
        try { sz = statSync(p).size } catch { continue }
        if (sz < 50_000) continue
        const prev = seen.get(f)
        seen.set(f, sz)
        const stable = prev !== undefined && prev === sz
        if (!stable) continue                        // 还在写，等下一轮
        if (want > 0 && sz < want * 0.55) continue   // 明显小于声明大小 → 还没写完
        if (delta < bestDelta || (delta === bestDelta && sz > (best ? best.size : 0))) {
          best = { path: p, name: f, size: sz }
          bestDelta = delta
        }
      }
    } catch { /* 目录还没建 */ }
    if (best) return best
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

/** 把 hires 视频复制成 .mp4（ffmpeg 需要已知扩展名）*/
function hiresVideoToMp4(src) {
  const tmpDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'wechat-video-tmp')
  try { mkdirSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  const dst = join(tmpDir, `hires-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`)
  copyFileSync(src, dst)
  return dst
}
// ── 读图片实际分辨率（判断拿到的是不是缩略图）──
//   JPEG 扫 SOF 段；PNG 读 IHDR；GIF 读逻辑屏；WebP 读 VP8X/VP8/VP8L。
//   为什么要它：微信 CDN 对无鉴权请求经常只回缩略图（8~30KB），
//   光看「字段存在与否」判断不出清晰度，必须看真实像素。
function imageDims(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue }
        const mk = buf[i + 1]
        if (mk === 0xd8 || mk === 0xd9 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (len < 2) { i += 2; continue }
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
        }
        i += 2 + len
      }
      return null
    }
    if (buf.slice(0, 3).toString('latin1') === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
    }
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const kind = buf.slice(12, 16).toString('latin1')
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
      if (kind === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
      }
    }
  } catch { /* ignore */ }
  return null
}

import { fileURLToPath } from 'node:url'
import { resolveDataRoot, findLatestDat, findDatCandidates, decryptDat } from './wechat-image.mjs'
import { xmlVideoMeta, findVideoCover, findVideoFile, probeVideo } from './wechat-video.mjs'
import { DbPoller } from './db-poller.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TYPE_NAMES = {
  1: 'text', 3: 'image', 34: 'voice', 42: 'shareCard', 43: 'video', 47: 'emoticon',
  48: 'location', 49: 'app', 50: 'voip', 51: 'sync', 10000: 'sys', 10002: 'sys',
}
/** 真正要当"消息"处理并向上抛的类型；其余（51/10002 等同步包）只用于判断在线 */
const REAL_MSG_TYPES = new Set([1, 3, 34, 43, 47, 48, 49])

export class WeChatHookBridge {
  constructor(opts = {}) {
    this.apiPort = opts.apiPort ?? 30001
    this.cbPort = opts.cbPort ?? 18998
    this.emit = opts.emit || (() => {})
    this.stickers = opts.stickers || null
    this.dataDir = opts.dataDir || process.cwd()
    this.wechatExe = opts.wechatExe || 'D:\\wxhook\\wx4110\\Weixin.exe'
    this.clientDir = this.wechatExe.replace(/[\\/][^\\/]+$/, '')
    this.log = opts.log || (() => {})

    this.selfWxid = ''
    this.selfName = ''
    this.loggedIn = false
    this._loggedInAt = 0          // loggedIn 最近一次被**权威依据**确认的时刻
    this._sendBanUntil = 0        // fail-closed：这个时刻之前一律不允许发送
    this._sendBanReason = ''
    this._sendBanLogged = false
    this.lastError = ''
    this.ready = false
    this._seq = 0
    this._srv = null
    this._contactMap = new Map()
    this._roomCache = new Map()
    this._roomNamesAt = 0
    this._roomNamesFailAt = 0
    this._memberCache = new Map()
    this._recentText = new Map()
    this._seen = new Set()
    this._cbCount = 0
    this._msgCount = 0
    // 推送通道计数（onPush 里用）。**必须在这里初始化**：onPush 第一行就读 this.stats.pushed，
    // 而它被 onCallback 的 try/catch 包着 → 少了这行会变成"每条推送都抛错、被静默吞掉"
    // （表现为推送通道永远没日志，极难排查 —— 实测踩到过）。
    this.stats = { pushed: 0 }
    // 群列表：该 hook 构建读不到，只能靠"见过的群"持久化下来
    this._roomsFile = join(this.dataDir, 'rooms.json')
    try {
      const saved = JSON.parse(readFileSync(this._roomsFile, 'utf8'))
      for (const r of saved?.rooms || []) if (r?.roomId) this._roomCache.set(r.roomId, r.name || r.roomId)
    } catch { /* 首次 */ }
  }

  saveRooms() {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this._roomsFile, JSON.stringify({
        updatedAt: new Date().toISOString(),
        rooms: [...this._roomCache].map(([roomId, name]) => ({ roomId, name })),
      }, null, 2))
    } catch { /* ignore */ }
  }

  get ok() { return this.ready && this.loggedIn }

  // ── HTTP（发送类接口）───────────────────────────────────────
  async api(path, data, method = 'POST', timeoutMs = 10000) {
    const t0 = Date.now()
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('api timeout')), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'connection': 'close' },
        body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
        signal: ac.signal,
      })
      const text = await res.text()
      const ms = Date.now() - t0
      // 取证：只记录路径/耗时/结果（SQL 内容不进日志）
      // 取证细节：/QueryDB/execute 带上库名（不带 SQL，避免把消息内容写进日志）
      let extra = ''
      try {
        if (path.includes('/QueryDB/execute') && data && data.optDbName) extra = ' [' + String(data.optDbName) + ']'
        else if (path.includes('/SendTextMsg') && data && data.wxidorgid) extra = ' [to ' + String(data.wxidorgid).slice(0, 20) + ']'
      } catch { }
      fMark('api', method + ' ' + path + extra + ' ' + ms + 'ms ' + (res.ok ? 'ok' : 'http' + res.status))
      try { return JSON.parse(text) } catch { return { raw: text } }
    } catch (e) {
      fMark('api', method + ' ' + path + ' ' + (Date.now() - t0) + 'ms FAIL ' + String(e?.message || e).slice(0, 60))
      throw e
    } finally { clearTimeout(t) }
  }

  async apiAlive() {
    try {
      const r = await this.api('/QueryDB/status', null, 'GET', 3000)
      const ok = !!(r && (r.IsLogin !== undefined || r.hWeixin !== undefined))
      if (!ok) this.noteProbeFailure('apiAlive: /QueryDB/status 返回异常')
      return ok
    } catch (e) {
      this.noteProbeFailure('apiAlive: ' + String(e?.message || e))
      return false
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  fail-closed 发送守卫（2026-10-19）
  //
  //  为什么要有它：未登录/半死状态下调发送接口会把微信弄崩（实测踩过两次），
  //  而"崩了自动重启"会让用户看到微信反复掉线。所以判定必须**宁可错杀**：
  //    · 任何一次 hook/DB 探测失败 → 进入 30 秒「禁止发送」窗口；
  //    · 窗口内所有发送类 op 直接返回错误，**连 HTTP 都不发**；
  //    · 能不能发只看**权威判据**：GET /QueryDB/status 的 IsLogin / hWeixin；
  //    · loggedIn 超过 60 秒没被刷新 → 同样视为不可发（数据过期就当作不可信）。
  // ══════════════════════════════════════════════════════════════════

  /** 记一次探测失败 → 打开 30 秒禁止发送窗口 */
  noteProbeFailure(reason) {
    const wasOpen = this._sendBanUntil > Date.now()
    this._sendBanUntil = Date.now() + 30_000
    this._sendBanReason = String(reason || '').slice(0, 160)
    if (!wasOpen || !this._sendBanLogged) {
      this._sendBanLogged = true
      this.log('发送已临时禁止（30 秒）：探测失败 → ' + this._sendBanReason)
    }
  }

  /** 权威判据确认"已登录"（同时刷新时间戳，供 60 秒新鲜度判定） */
  markLoggedIn(reason) {
    const was = this.loggedIn
    this.loggedIn = true
    this._loggedInAt = Date.now()
    if (!was) {
      this.log('判定已登录：' + String(reason || ''));
      this.emit('login', { self: this.selfWxid, name: this.selfName })
    }
  }

  /**
   * 刷新登录状态 —— **只用权威判据**：GET /QueryDB/status 的 IsLogin / hWeixin。
   * 不再依赖"数据库能不能查到东西"（那个会假死：库没打开不代表没登录）。
   */
  async refreshLoginState() {
    let r = null
    try {
      r = await this.api('/QueryDB/status', null, 'GET', 3000)
    } catch (e) {
      this.noteProbeFailure('refreshLoginState: ' + String(e?.message || e))
      return false
    }
    if (!r || typeof r !== 'object') {
      this.noteProbeFailure('refreshLoginState: /QueryDB/status 返回非 JSON')
      return false
    }
    const isLogin = Number(r.IsLogin) === 1
    const hWeixin = Number(r.hWeixin) > 0
    if (isLogin && hWeixin) {
      if (!this.loggedIn) this.markLoggedIn('/QueryDB/status IsLogin=1 且 hWeixin>0')
      else this._loggedInAt = Date.now()          // 只是刷新新鲜度，不重复打日志
      return true
    }
    this.loggedIn = false
    return false
  }

  // ── 客户端进程 ──────────────────────────────────────────────
  findPids(name = 'Weixin.exe') {
    try {
      const out = execFileSync('tasklist', ['/fi', `imagename eq ${name}`, '/fo', 'csv', '/nh'], { encoding: 'latin1' })
      const pids = []
      for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
        if (m && m[1].toLowerCase() === name.toLowerCase()) pids.push(Number(m[2]))
      }
      return pids
    } catch { return [] }
  }

  /** 必须带回调参数启动，否则收不到消息 */
  launchClient() {
    const dir = this.wechatExe.replace(/[\\/][^\\/]+$/, '')
    if (!existsSync(this.wechatExe)) throw new Error('客户端不存在：' + this.wechatExe)
    this.log(`启动客户端（带回调参数）RecvType=1 CallBackURL=http://127.0.0.1:${this.cbPort}`)
    spawn(this.wechatExe, [
      `StartPort=${this.apiPort}`,
      'RecvType=1',
      `CallBackURL=http://127.0.0.1:${this.cbPort}`,
    ], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
  }

  // ── 回调服务器（收消息）─────────────────────────────────────
  startCallbackServer() {
    if (this._srv) return
    this._srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        try { this.onCallback(JSON.parse(body)) } catch (e) {
          this.emit('error', { message: '回调解析失败: ' + String(e?.message || e) })
        }
      })
    })
    this._srv.on('error', (e) => this.log('回调服务错误: ' + e.message))
    this._srv.listen(this.cbPort, '127.0.0.1', () => this.log(`回调服务监听 127.0.0.1:${this.cbPort}`))
  }

  /**
   * 处理 hook 在 SQLite 层抓到的"消息写入"（我们的推送通道）。
   *
   * 为什么复用 poller.toEvent：这样推送出来的事件与轮询**逐字段一致**，
   * 插件一行都不用改，也便于"影子模式"逐条对比两边是否一致。
   *
   * 影子模式（默认）：只记日志、不发事件 → 零功能风险。
   * 接管模式：环境变量 WECHAT_PUSH=1 启动 bridge 才真正发事件。
   */
  onPush(ev) {
    const p = this.poller
    if (!p || typeof p.toEvent !== 'function') { this.log('推送：轮询器未就绪，丢弃一条'); return }
    const table = String(ev.table || '')
    const cols = ev.cols || null
    this.stats.pushed = (this.stats.pushed || 0) + 1

    // ── ① 通知式（第三轮改造的主路）：载荷只有 db/table/ts，**没有 cols/值** ──
    //    为什么：hook 侧"标记 + bind 抓值"走不通（缓存语句标记保持不住 → 值永远抓不到）。
    //    通知式不传值：按表找到会话 → **立刻**针对该群轮询一次即可 —— 那正是轮询做的事，
    //    只是被即时触发（而且通知那一刻库必然是开着的）。
    if (!cols || !Object.keys(cols).length) {
      const info = p.tables.get(table)
      const roomId = info?.roomId || ''
      if (!roomId) {
        this.log(`推送（通知）：表 ${table} 还没映射到会话（会话表可能刚重建/未登记）→ 跳过`)
        return
      }
      if (process.env.WECHAT_PUSH !== '1') {
        // 影子模式：只记日志，**不真轮询**（保持"零功能风险"；常规轮询照旧由 tick 跑）
        if (this.stats.pushed <= 20) {
          this.log(`推送（影子）：收到 Msg_ 写入通知 → 触发单群轮询（${roomId}）`)
        }
        return
      }
      if (typeof p.pollRoom !== 'function') { this.log('推送（通知）：轮询器没有 pollRoom → 跳过'); return }
      void p.pollRoom(roomId)
        .then((n) => this.log(`推送→单群轮询 ${roomId}：取到 ${n} 条`))
        .catch((e) => this.log('推送→单群轮询失败：' + String(e?.message || e).slice(0, 120)))
      return
    }

    // ── ② 旧的值抓取路径（保留兼容：万一将来 hook 真带上 cols，仍按原样走 toEvent）──
    const info = p.tables.get(table) || { roomId: '' }
    // hook 推来的 cols 就是数据库列（hex 原样），toEvent 内部用 decodeContent 解 hex+zstd
    const row = {
      local_type: cols.local_type,
      message_content: cols.message_content,
      source: cols.source,
      real_sender_id: cols.real_sender_id,
      create_time: cols.create_time,
      server_id: cols.server_id,
      local_id: cols.local_id,
    }
    const m = p.toEvent(table, info, row)
    if (!m) { this.log(`推送：内容为空，丢弃（table=${table}）`); return }
    const brief = `${m.roomName || m.roomId}｜${m.senderName || m.sender}｜${String(m.text).slice(0, 40)}`
    const publish = () => {
      if (process.env.WECHAT_PUSH === '1') {
        this.log(`推送→发事件：${brief}`)
        this.emit('msg', m)
      } else if (this.stats.pushed <= 20) {
        this.log(`推送（影子，只记不发）：${brief}`)   // 前 20 条足够对比，避免刷屏
      }
    }
    // 语音（34）：音频是磁盘文件，要先定位+解码成 16k WAV（enrichVoice 内部失败只记日志，
    // 绝不抛错、绝不阻塞）。非语音保持原来的同步顺序 —— 推送通道的行为一个字节都不变。
    if (Number(m.type) === 34 && typeof p.enrichVoice === 'function') {
      void p.enrichVoice(m).catch(() => {}).then(publish)
    } else {
      publish()
    }
  }

  onCallback(ev) {
    // ── 我们的推送通道：{t:'msg', db, table, cols}（与上面的 hook 回调格式不同）──
    // 必须最先处理，免得落进下面的"按 type 数字分发"逻辑
    if (ev && ev.t === 'msg') {
      try { this.onPush(ev) } catch (e) { this.log('推送处理失败：' + String(e?.message || e)) }
      return
    }
    this._cbCount++
    const type = Number(ev.type ?? 0)
    const recvWxid = String(ev.wxid ?? '')
    // 图片/视频/表情/文件类回调：把原始字段完整打出来（研究"能不能拿到图"用）
    if ([3, 43, 47, 48, 49, 34].includes(type)) {
      try { this.log(`原始回调[type=${type}]：` + JSON.stringify(ev).slice(0, 6000)) } catch { /* ignore */ }
    }
    // 文本消息也打一条样本：找有没有"发送者昵称"字段（DB 坏了，昵称只能从消息里学）
    if (type === 1 && String(ev.roomid || '').endsWith('@chatroom') && this._rawTextLogged !== true) {
      this._rawTextLogged = true
      try { this.log('原始文本回调样本：' + JSON.stringify(ev).slice(0, 2000)) } catch { /* ignore */ }
    }

    // 收到任何回调 = 客户端在线且 hook 活着 → 判定已登录。
    // （不能只看 wxid：群消息回调里该字段是房间号 @chatroom，会把自己账号认错）
    if (!this.loggedIn) {
      this.markLoggedIn('收到 hook 回调（#' + this._cbCount + '）')
    }
    // 私聊回调里 wxid 就是自己账号，顺手记下来
    if (recvWxid && recvWxid !== 'weixin' && !recvWxid.endsWith('@chatroom') && !this.selfWxid) {
      this.selfWxid = recvWxid
      this.log('机器人账号 wxid=' + this.selfWxid)
    }
    if (!this.selfWxid && !this._selfProbeAt) {
      this._selfProbeAt = Date.now()
      void this.probeSelfWxid()
    }

    // 只把真实消息类型往上抛，过滤同步包
    if (!REAL_MSG_TYPES.has(type)) return

    const key = String(ev.msgid ?? '') + ':' + String(ev.timestamp ?? '')
    if (this._seen.has(key)) return
    this._seen.add(key)
    if (this._seen.size > 5000) this._seen = new Set([...this._seen].slice(-2000))

    const m = this.normalize(ev)
    if (m) { this._msgCount++; this.emit('msg', m) }
  }

  normalize(ev) {
    const type = Number(ev.type ?? 0)
    const tn = TYPE_NAMES[type] || ('type' + type)
    const sender = String(ev.sender ?? '')
    const roomid = String(ev.roomid ?? '')
    const isGroup = !!roomid
    const content = String(ev.content ?? '')
    const ts = Number(ev.timestamp ?? 0) * 1000 || Date.now()

    // 群消息里 content 可能带 "wxid_xxx:\n" 前缀（不同版本不一定有）
    let text = content
    if (isGroup) {
      const i = content.indexOf(':\n')
      if (i > 0 && content.slice(0, i).length < 64) text = content.slice(i + 2)
    }
    if (tn === 'emoticon') text = '[表情包]'
    else if (tn === 'image') text = '[图片]'
    else if (tn === 'voice') text = '[语音]'
    else if (tn === 'video') text = '[视频]'

    const selfNames = this.selfNamesIn(roomid)
    let isAtMe = false
    for (const n of selfNames) if (n && content.includes('@' + n)) { isAtMe = true; break }

    if (tn === 'text' && sender !== this.selfWxid) {
      const recent = this._recentText.get(roomid) || []
      recent.push(text)
      while (recent.length > 6) recent.shift()
      this._recentText.set(roomid, recent)
    }

    const m = {
      seq: ++this._seq,
      id: String(ev.msgid ?? ''),
      type, typeName: tn, ts,
      isSelf: sender === this.selfWxid,
      isGroup,
      roomId: isGroup ? roomid : sender,
      roomName: isGroup ? (this._roomCache.get(roomid) || roomid) : (this._contactMap.get(sender) || sender),
      sender,
      senderName: this._contactMap.get(sender) || sender,
      content, text,
      isAtMe,
      atAll: content.includes('@所有人'),
      // 媒体类消息把原始 XML 带上：表情包能据此下载图片（供图像识别）
      xml: [3, 43, 47, 48, 49, 34].includes(type) ? content : '',
    }
    // 记住见过的群（群列表接口坏了，这是唯一来源）
    if (isGroup && !this._roomCache.has(roomid)) {
      this._roomCache.set(roomid, roomid)
      this.saveRooms()
      this.log('记住新群: ' + roomid)
    }

    // 表情包：存 XML，之后用 ForwardXMLMsg 原样转发（对方收到真表情）
    if (tn === 'emoticon' && !m.isSelf && this.stickers) {
      const st = this.stickers.add({
        xml: content, sender, senderName: m.senderName, roomId: m.roomId,
        context: (this._recentText.get(roomid) || []).slice(-3).join(' '), kind: 'emoticon',
      })
      if (st) this.emit('sticker', { id: st.id, roomId: m.roomId, sender, senderName: m.senderName, context: '' })
        // ★ 顺手把表情图片本体也下下来收藏（XML 那条路在本构建会崩，所以靠图片发送）
        void collectStickerImage(content, this.stickers, {
          sender,
          senderName: m.senderName,
          roomId: m.roomId,
          context: (this._recentText.get(roomid) || []).slice(-3).join(' '),
          log: (s) => this.log(s),
        })
    }
    return m
  }

  // ── 生命周期 ────────────────────────────────────────────────
  async start() {
    this.startCallbackServer()
    // 看门狗要在**就绪之前**就起来：否则 HTTP 服务一开始就是死的，
    // start() 抛错 → 看门狗根本没注册 → 客户端永远救不回来（踩过这个坑）
    this.startWatchdog()
    if (!this.findPids().length) this.launchClient()

    // 等 HTTP 服务
    let up = false
    for (let i = 0; i < 60; i++) {
      await sleep(1000)
      if (await this.apiAlive()) { up = true; break }
    }
    if (!up) throw new Error(`WeChat-Hook HTTP(${this.apiPort}) 未就绪`)
    this.ready = true
    this.log('WeChat-Hook HTTP 就绪（回调口 ' + this.cbPort + '）')
    // 从 data/bridge-config.json 读 selfWxid（配置优先，避免用错"我是谁"）
    try {
      const cfg = JSON.parse(readFileSync(join(this.dataDir, 'bridge-config.json'), 'utf8'))
      if (cfg?.selfWxid) { this.selfWxidCfg = String(cfg.selfWxid); this.log('配置里的 selfWxid=' + this.selfWxidCfg) }
    } catch { /* ignore */ }
    // 运行时再注册一次回调（无害，保证地址正确）
    try { await this.api('/set_callback', { url: `http://127.0.0.1:${this.cbPort}` }) } catch { /* ignore */ }
    // 主动探一次账号：否则要等群里有人说话（回调）才判定"已登录"，
    // 期间发送会被守卫拦住（例如 23:00 的晚安就发不出去）。
    // ★ 登录判定的**权威来源**是 GET /QueryDB/status 的 IsLogin / hWeixin；
    //   selfWxid / 数据库可读都只是"顺带补全信息"，不再作为能否发送的依据。
    try {
      await this.probeSelfWxid()
      await this.refreshLoginState()
      if (!this.loggedIn && this.selfWxid) {
        this.markLoggedIn('启动探测：selfWxid=' + this.selfWxid)
      }
    } catch { /* ignore */ }
    void this.loadContacts()
    void this.refreshRoomNames()
    // 消息来源：**数据库轮询**（公开源码里没有回调推送实现，见 lib/db-poller.mjs 顶部说明）
    if (!this.poller) {
      this.poller = new DbPoller({
        api: (p, b, m, to) => this.api(p, b, m, to),
        // ── 2026-10-27：轮询来的新群也要登记 ─────────────────────────────
        // 回调路径有「记住新群」，轮询路径原来没有 → 群缓存永远缺新群（面板选不到）。
        // 这里补上：第一次见到该群就把 roomId 落盘（名字留给 refreshRoomNames 补）。
        emit: (msg) => {
          try {
            if (msg && msg.isGroup && msg.roomId && !this._roomCache.has(msg.roomId)) {
              const nm = (msg.roomName && msg.roomName !== msg.roomId) ? msg.roomName : msg.roomId
              this._roomCache.set(msg.roomId, nm)
              this.saveRooms()
              this.log('记住新群（轮询）: ' + msg.roomId)
            }
          } catch { /* 登记失败不影响消息分发 */ }
          this.emit('msg', msg)
        },
        log: (s) => this.log(s),
        intervalMs: Number(process.env.DB_POLL_MS || 2500),
        // 读库失败 = hook/DB 探测失败 → 桥侧进入 30 秒禁止发送窗口（fail-closed）
        onReadFail: (why) => this.noteProbeFailure('轮询读库失败：' + String(why || '')),
        // 能轮询到数据库 = 强证据（但发送守卫仍以 /QueryDB/status 为准）
        onReady: (self) => {
          if (self && !this.selfWxid) this.selfWxid = self
          if (!this.loggedIn) {
            this.markLoggedIn('数据库轮询成功' + (self ? '，self=' + self : ''))
          }
        },
      })
    }
    // 轮询启动：DB 可能暂时不可用（hook 重扫很慢/句柄未就绪）→ 失败就反复重试，
    // 一旦数据库可用就自动开始收消息（否则机器人会永久失聪）
    const startPoller = async (attempt = 1) => {
      try {
        await this.poller.init()
        this.poller.start()
        this.log('数据库轮询已启动（第 ' + attempt + ' 次尝试）')
      } catch (e) {
        this.log('数据库轮询启动失败（第 ' + attempt + ' 次）：' + String(e?.message || e).slice(0, 90))
        // message_0.db 是**懒加载**的：微信只有在收发消息之后才会打开它。
        // 所以"失败就放弃"是错的 —— 要重试，等群里来消息后自然就绪。
        // 连续失败到第 4 次 → 请上层"唤醒"一下数据库（让机器人自己发条消息，
        // 微信就会写库、打开 message_0.db，轮询随即恢复）。这样**不用重启客户端**，
        // 也就不会触发"要手机确认登录"那一步。
        // 但**必须设上限**：无限重试每 15 秒戳一次 hook，
        // 而 hook 那侧句柄可能已经不正 → 反复 prepare → 野指针 → 微信崩
        // （实测 2026-10-22 20:13:08 就是这个模式）。所以 6 次（约 90 秒）后硬停。
        if ((attempt === 4 || attempt % 10 === 0) && typeof this.onNeedWake === 'function') {
          try { this.onNeedWake() } catch { /* ignore */ }
        }
        if (attempt >= 6) {
          try { if (this.poller) this.poller._hardGiveUp = true } catch { /* ignore */ }
          this.log('数据库轮询硬停（init 连续失败 ' + attempt + ' 次）—— 不再自动重试，'
            + '避免反复探测把微信搞崩。恢复方式：微信重新登录 / POST /api/pollResume / 重启桥')
          return
        }
        const wait = attempt <= 5 ? 15000 : 60000
        if (attempt <= 3 || attempt === 5) {
          this.log('数据库轮询等待中就绪（第 ' + attempt + ' 次，' + (wait / 1000) + 's 后重试，最多 6 次）：' + String(e?.message || e).slice(0, 70))
        }
        setTimeout(() => { void startPoller(attempt + 1) }, 15000)
      }
    }
    // ★ 2026-10-22：把 startPoller 挂到实例上。
    //  为什么：硬闸（init 连续失败 6 次 → _hardGiveUp=true）触发后，
    //  只有 poller.resume() 会被 login 事件调用清状态，但**没有任何人重新启动轮询**。
    //  实测 15:02 硬停 → 15:05 微信重登 → resume 清了硬闸 → 但 startPoller 再没被调
    //  → 状态看着是「暂停已解除」，实际轮询根本没在跑 → 能读库但 msgsIn 永远 0。
    //  必须留个引用，让 login / /api/pollResume 能把轮询真的拉起来。
    this._startPoller = startPoller
    void startPoller()
    this.emit('started', { port: this.apiPort, loggedIn: this.loggedIn, self: this.selfWxid, transport: 'wechat-hook' })
    return true
  }

  /**
   * 解除硬闸并**真正重启**轮询。
   * login 事件、POST /api/pollResume 都走这里 —— 只 resume() 是不够的（见 _startPoller 注释）。
   * @returns {Promise<boolean>} 是否成功重新启动
   */
  async restartPoller(reason = '') {
    try { this.poller?.resume?.(reason) } catch { /* ignore */ }
    if (typeof this._startPoller !== 'function') {
      this.log('restartPoller：startPoller 引用不存在（桥还没 start()？）')
      return false
    }
    try {
      await this._startPoller(1)
      this.log('轮询已重启（' + (reason || '手动') + '）')
      return true
    } catch (e) {
      this.log('轮询重启失败：' + String(e?.message || e).slice(0, 90))
      return false
    }
  }

  /**
   * 看门狗：客户端被关掉/崩了要自动拉起（否则机器人会静默失联）；
   * 另外 HTTP 服务死了（hook 崩溃但微信还活着）也要重启客户端 —— 否则收发全断。
   */
  startWatchdog() {
    // 自愈：hook 的 DB 扫描会偶发失效（GetAllDBName 返回空）→ 连续几次失败就重启客户端
    this.dbFailStreak = 0
    setInterval(() => {
      void (async () => {
        if (!this.ready || !this.loggedIn) return
        const ok = await this.dbHealthy()
        if (ok) { this.dbFailStreak = 0; return }
        this.dbFailStreak++
        this.noteProbeFailure(`数据库探测失败（第 ${this.dbFailStreak} 次）`)   // → 30 秒禁止发送
        this.log('数据库探测失败（第 ' + this.dbFailStreak + ' 次）')
        // 注意：**不要**在这里自动重启客户端！
        // 教训：DB 重扫本身很慢（全内存扫描），探测超时会被误判成"失效"，
        // 于是每 3 分钟杀一次客户端 → 用户看到微信反复掉线（实测 2 小时重启 31 次）。
        // 现在只告警，由人决定是否重启。
        if (this.dbFailStreak === 5) {
          this.log('数据库连续探测失败 5 次（可能只是重扫很慢，也可能是 Hook 失效）。'
            + '不会自动重启客户端；需要恢复请手动：停桥 → 杀客户端 → 重新启动客户端 → 起桥')
        }
      })()
    }, 300000).unref?.()   // 5 分钟一次，减少对 hook 的压力
    if (this._wd) return
    this._wd = setInterval(() => {
      void (async () => {
        if (this._stopped) return
        this.guardUpdates()               // 每次巡检顺手压住自动更新（客户端会重建，必须反复压）
        if (!this.findPids().length) {
          // ★★ 自动拉起客户端默认【关闭】✗✗（2026-10-20 血的教训）
          //    它会在"用户正停在登录窗口 / 客户端刚被杀准备重开"时再 spawn 一个实例，
          //    两个实例抢同一个数据目录 → 客户端崩溃 / 数据库损坏（实测当晚坏过一次）。
          //    要恢复请【人工】启动客户端（正常退出用 CloseMainWindow，别强杀）。
          //    确实需要自动拉起时，显式设 WECHAT_AUTOLAUNCH=1。
          // 取证：客户端退出 = 很可能刚崩溃 → 把最近事件快照单独存一份
    try {
      const snap = fSnapshot('client-exited')
      fMark('client-exit', snap ? 'snapshot=' + snap : 'snapshot failed')
    } catch { }
    this.log('检测到客户端已退出（不会自动拉起；如需自动请设 WECHAT_AUTOLAUNCH=1）')
          this.loggedIn = false
          this.ready = false
          this._apiDeadSince = 0
          if (process.env.WECHAT_AUTOLAUNCH === '1') {
            this.log('WECHAT_AUTOLAUNCH=1 → 执行自动拉起')
            try { this.launchClient() } catch (e) { this.log('拉起失败: ' + String(e?.message || e)) }
          }
          return
        }
        const up = await this.apiAlive()
        if (!up) {
          this._apiDeadSince ||= Date.now()
          this.ready = false
          this.loggedIn = false
          const deadSec = Math.round((Date.now() - this._apiDeadSince) / 1000)
          if (deadSec >= 30) {
            this.log(`HTTP 服务已死 ${deadSec}s（hook 崩了）→ 重启客户端`)
            this._apiDeadSince = 0
            this.killOwnClient()          // 只杀机器人自己的客户端，绝不动用户日常微信
            await sleep(3000)
            try { this.launchClient() } catch (e) { this.log('拉起失败: ' + String(e?.message || e)) }
          }
          return
        }
        this._apiDeadSince = 0
        // 每 10 秒用**权威判据**刷新一次登录状态：
        //   · 正常时 loggedIn 的新鲜度一直 < 60s → 发送守卫放行
        //   · 一旦刷新失败/超时 → 新鲜度过期 → 发送自动变成 fail-closed（拒绝）
        await this.refreshLoginState()
        if (!this.ready) {
          this.ready = true
          this.log('HTTP 服务恢复')
          try { await this.api('/set_callback', { url: `http://127.0.0.1:${this.cbPort}` }) } catch { /* ignore */ }
        }
      })()
    }, 10_000)
  }

  stop() {
    this._stopped = true
    if (this._wd) clearInterval(this._wd)
    this._wd = null
    if (this._srv) { try { this._srv.close() } catch { /* ignore */ } }
    this._srv = null
    this.ready = false
  }

  isLogin() { return this.loggedIn }

  /**
   * 群成员昵称（来自我们修好的 QueryDB）。
   *
   * 背景：原版 hook 的 QueryDB 永久失效（g_IsLogin 从未被置 1），所以群成员昵称拿不到、
   * 只能靠 @ 提及慢慢学。修好之后可以走 contact.db 的关系查询直接拿到真实昵称。
   * 关系：chatroom_member.room_id/member_id → name2id.rowid → name2id.username，
   *       再用 username 去 contact 取 nick_name / remark。
   */
  async groupMembers(roomId) {
    const rid = String(roomId || '')
    if (!/^[\w@.-]{1,64}$/.test(rid)) throw new Error('roomId 非法：' + rid)
    const sql = 'SELECT c.username AS wxid, c.nick_name AS nick, c.remark AS remark, c.alias AS alias'
      + ' FROM chatroom_member m'
      + ' JOIN name2id r ON r.rowid = m.room_id'
      + ' JOIN name2id u ON u.rowid = m.member_id'
      + ' JOIN contact c ON c.username = u.username'
      + " WHERE r.username = '" + rid + "'"
    const r = await this.api('/QueryDB/execute', { optDbName: 'contact.db', SQL: sql }, 'POST', 20000)
    const rows = Array.isArray(r?.data) ? r.data : []
    if (!rows.length && r?.desc) this.log('群成员查询失败：' + r.desc)
    return rows.map((x) => ({
      wxid: String(x.wxid || ''),
      // 备注优先（真人通讯录里备注更接近平时叫法），其次昵称
      name: String(x.remark || x.nick || '').trim(),
      nick: String(x.nick || '').trim(),
      remark: String(x.remark || '').trim(),
      alias: String(x.alias || '').trim(),
    })).filter((x) => x.wxid)
  }

  /** 数据库是否可用（修好 QueryDB 后应为 true） */
  /** 数据库是否真的可用（不只是 API 活着）——扫描失效时 GetAllDBName 会返回空 */
  async dbHealthy() {
    try {
      const r = await this.api('/QueryDB/GetAllDBName', {}, 'POST', 30000)   // 别太久：会占用 hook，拖慢回调
      return Array.isArray(r) && r.length > 0
    } catch { return false }
  }

  async dbReady() {
    try {
      const r = await this.api('/QueryDB/GetAllDBName', {}, 'POST', 60000)
      return Array.isArray(r) && r.length > 0
    } catch { return false }
  }

  /** 补全自己的 wxid（群消息回调拿不到，用资料接口碰一下；该接口有时返回缓存，不可靠） */
  /**
   * 确定"我是谁"。优先级：
   *   ① 环境变量/配置 WECHAT_SELF_WXID（最可靠）
   *   ② 数据目录名 <xwechat_files>\wxid_xxx_hash（自动）
   *   ③ /GetSelfProfile —— **最后才用**，官方版这个接口会返回别人的缓存数据（实测返回过群成员的 wxid）
   */
  async probeSelfWxid() {
    if (this.selfWxid) return this.selfWxid
    const fromCfg = process.env.WECHAT_SELF_WXID || this.selfWxidCfg || ''
    if (fromCfg) { this.selfWxid = fromCfg; this.log('self 取自配置：' + fromCfg); return fromCfg }
    // 从 xwechat_files 目录名推
    try {
      const roots = [
        join(process.env.USERPROFILE || '', 'xwechat_files'),
        join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
        'D:\\Users\\Administrator\\xwechat_files',
      ]
      for (const r of roots) {
        if (!existsSync(r)) continue
        for (const d of readdirSync(r)) {
          const m = /^(wxid_[0-9a-z]+)_/.exec(d)
          if (m) { this.selfWxid = m[1]; this.log('self 取自数据目录：' + m[1]); return m[1] }
        }
      }
    } catch { /* ignore */ }
    return this._probeSelfLegacy()
  }

  async _probeSelfLegacy() {
    try {
      const p = await this.api('/GetSelfProfile', {}, 'POST', 8000)
      const wxid = String(p?.wxid || '')
      if (wxid.startsWith('wxid_')) {
        this.selfWxid = wxid
        if (p?.nickname && !p.nickname.includes('视频号')) this.selfName = p.nickname
        this.log('资料接口补全账号: ' + this.selfWxid + (this.selfName ? '（' + this.selfName + '）' : ''))
      }
    } catch { /* ignore */ }
  }

  async loadContacts() {
    if (this._contactMap.size) return this._contactMap
    try {
      const r = await this.api('/QueryDB/execute', { optDbName: 'MicroMsg.db', SQL: 'SELECT UserName, NickName, Remark FROM Contact' }, 'POST', 20000)
      for (const c of r?.data || []) {
        const wxid = c.UserName || c.userName
        const nick = c.Remark || c.NickName || c.remark || c.nickName || wxid
        if (wxid) this._contactMap.set(wxid, nick)
      }
      if (this._contactMap.size) this.log(`联系人已缓存 ${this._contactMap.size} 个`)
      else this.log('联系人库不可用（该构建的 /QueryDB 坏了），昵称将退化为 wxid')
    } catch (e) { this.log('读联系人失败: ' + String(e?.message || e)) }
    return this._contactMap
  }

  nameOf(roomId, wxid) { return this._contactMap.get(wxid) || wxid }
  selfNamesIn(roomId) { return [...new Set([this.selfName, this.selfWxid].filter(Boolean))] }
  roomName(roomId) { return this._roomCache.get(roomId) || roomId }

  /** 群成员：该构建的库接口不可用，退化为"见过的发送者" */
  async members(roomId) {
    const hit = this._memberCache.get(roomId)
    if (hit) return hit
    const entry = { at: Date.now(), members: [], nameMap: {} }
    this._memberCache.set(roomId, entry)
    return entry
  }

  // ── 发送 ────────────────────────────────────────────────────
  // 重要：未登录时调这些接口会把微信弄崩（实测踩过），所以先拦一道。
  // 现在是 **fail-closed**：任何一次探测失败都会开一个 30 秒禁止发送窗口，
  // 窗口内连 HTTP 都不发（见 noteProbeFailure 的说明）。
  #guard() {
    const now = Date.now()
    if (this._sendBanUntil > now) {
      const left = Math.ceil((this._sendBanUntil - now) / 1000)
      this.log(`禁止发送窗口内（还剩 ${left}s，原因：${this._sendBanReason}）→ 直接拒绝，不发 HTTP`)
      return false
    }
    if (!this.loggedIn) {
      this.log('未登录，拒绝调用发送接口（未登录时调 API 会导致微信崩溃）')
      return false
    }
    // 登录状态必须是**新鲜的**：超过 60 秒没被权威判据刷新 → 视为不可发
    const age = this._loggedInAt ? (now - this._loggedInAt) : Infinity
    if (!(age <= 60_000)) {
      this.log('登录状态已超过 60 秒没刷新（' + (Number.isFinite(age) ? Math.round(age / 1000) + 's' : '从未确认')
        + '）→ 视为不可发，拒绝发送')
      this.noteProbeFailure('loggedIn 过期（>60s 未刷新）')
      return false
    }
    return true
  }

  /**
   * 发文字。mentions 里放被 @ 的人的 **wxid**（不是昵称）—— 会填进 hook 的 atlist 字段，
   * 这样对方才会真的收到提醒（红点）；否则只是正文里看着像 @。
   */
  async sendText(roomId, text, mentions = []) {
    if (!this.#guard()) return -1
    const atlist = Array.isArray(mentions) ? mentions.filter(Boolean).join(',') : String(mentions || '')
    const payload = { wxidorgid: roomId, msg: text }
    if (atlist) payload.atlist = atlist
    const r = await this.api('/SendTextMsg', payload)
    return Number(r?.ret) === 0 ? 0 : (r?.ret ?? -1)
  }

  async sendImage(roomId, filePath) {
    if (!this.#guard()) return -1
    const r = await this.api('/SendImgMsg', { wxidorgid: roomId, path: filePath })
    return Number(r?.ret) === 0 ? 0 : (r?.ret ?? -1)
  }

  /**
   * 发表情包。
   * 注意：**不要**走 /ForwardXMLMsg —— 该构建上这个接口一调就把微信弄崩（实测两次）。
   * 所以统一用 /SendImgMsg 发本地图片文件（GIF/PNG 视觉上就是表情包）。
   * 想发"微信原生表情"需要 /ForwardXMLMsg 可用，等 hook 项目修复后再打开。
   */
  async sendEmotion(roomId, filePath, _stickerXml) {
    if (!this.#guard()) return -1
    if (filePath && existsSync(filePath)) return this.sendImage(roomId, filePath)
    return -1
  }

  async sendFile(roomId, filePath) { return this.sendImage(roomId, filePath) }

  /**
   * 发**语音气泡**（type 34，微信里点开就播，不是"文件"）。
   *
   * 走上级 agent 新增的 hook 路由 `POST /SendVoiceMsg`。**实测踩过的两个坑**：
   *  ① `str0Mode` **必须 `'bytes'`** —— 它把 SILK 原始字节交给微信（hook 会**自动补一个 0x02 前缀**，
   *     所以我们**不要**自己加 ✗）；用 `'path'` 模式微信会把**路径字符串本身**当音频
   *     （实测 length=17 = 路径长度 ✗ 出的是 17 字节的假语音 ✗）。
   *  ② `durationMs` 要给（SILK 的真实时长，来自 pilk.get_duration）✓。
   *
   * 开关默认**关**：`<客户端目录>\hook-voice-send.on` 存在=开，或 `POST /Debug/VoiceSend {"on":true}`
   * （内存态优先级更高）。关着时返回 **-1001**（一个字节都不碰客户端内存）。
   *
   * @returns {{ret:number, retmsg:string, diag:object|null}} ret=0 只代表"已交给发送器"
   *          （真正的上传是微信异步做的）；其它错误码见 hook 文档。
   */
  async sendVoice(roomId, silkPath, durationMs = 0) {
    if (!this.#guard()) return { ret: -1, retmsg: '未登录，拒绝调用发送接口', diag: null }
    if (!silkPath || !existsSync(silkPath)) {
      this.log(`语音：SILK 文件不存在（${silkPath || '空'}）`)
      return { ret: -1, retmsg: 'silk 不存在', diag: null }
    }

    // ⚠️ 实测坑（-1004 / `CreateFileA failed, GetLastError=3`）：hook 跑在**微信进程**里、用
    //    **CreateFileA（ANSI）**读文件 —— 路径里只要有**非 ASCII 字符**就"找不到文件" ✗
    //    （TTS 的临时目录如果落在含中文的路径下，就正好中招 ✗；实测同一条 SILK 换成
    //     纯 ASCII 路径就 ret=0 ✓）。
    //    → 发送前把 SILK **复制到一个纯 ASCII 的临时目录**再发，发完删副本 ✓（源文件不动）。
    let sendPath = silkPath
    let asciiCopy = ''
    if (/[^\x20-\x7E]/.test(silkPath)) {
      asciiCopy = this.#asciiSafeVoicePath(silkPath)
      if (!asciiCopy) {
        this.log('语音：源路径含非 ASCII 且找不到可用的 ASCII 临时目录 → 放弃（降级发文字）')
        return { ret: -1, retmsg: '路径含非 ASCII，且没有可用的 ASCII 临时目录', diag: null }
      }
      try {
        copyFileSync(silkPath, asciiCopy)
        sendPath = asciiCopy
        this.log(`语音：源路径含非 ASCII → 先复制到 ASCII 路径再发（${asciiCopy}）`)
      } catch (e) {
        this.log('语音：复制到 ASCII 路径失败（降级发文字）：' + String(e?.message || e).slice(0, 140))
        return { ret: -1, retmsg: '复制到 ASCII 路径失败', diag: null }
      }
    }

    let r = null
    try {
      // ⚠️ 字段名就是 str0Mode（不是 strMode）；path 给绝对路径，hook 自己读文件
      r = await this.api('/SendVoiceMsg', {
        wxidorgid: roomId,
        path: sendPath,
        str0Mode: 'bytes',
        durationMs: Number(durationMs) || 0,
      }, 'POST', 30_000)
    } catch (e) {
      this.log('语音：调 /SendVoiceMsg 失败：' + String(e?.message || e).slice(0, 160) + ' | cause=' + (e?.cause ? String(e.cause) : 'none'))
      return { ret: -1, retmsg: String(e?.message || e), diag: null }
    } finally {
      if (asciiCopy) { try { unlinkSync(asciiCopy) } catch { /* ignore */ } }
    }
    const ret = Number(r?.ret ?? -1)
    if (ret === -1001) {
      // 这条一定要打清楚：否则"配置开了但发不出去"会查很久（任务书明确要求）
      this.log('语音：hook 的语音发送开关**没开**（-1001）→ 需要 '
        + `<客户端目录>\\hook-voice-send.on，或 POST /Debug/VoiceSend {"on":true}`)
    } else if (ret !== 0) {
      this.log(`语音：/SendVoiceMsg 返回 ${ret}（${r?.retmsg || ''}）`
        + '｜-1002 参数非法 · -1004 文件读不了/魔数不对/超 4MB · -1005 预检没过 · -1006 工厂调用异常'
        + ' · -1007 后校验没过 · -1008 send_message 抛异常 · -1009 并发')
    }
    return { ret, retmsg: String(r?.retmsg || ''), diag: r?.diag || null }
  }

  /**
   * 给"要交给 hook 读的 SILK"找一个**纯 ASCII** 的落点（hook 用 CreateFileA，非 ASCII 路径读不到）。
   * 优先系统临时目录；它本身含非 ASCII 时退回微信客户端目录（hook 本来就在那里写日志）。
   * @returns {string} 目标文件绝对路径；找不到可用目录返回 ''
   */
  #asciiSafeVoicePath(src) {
    const isAscii = (p) => !/[^\x20-\x7E]/.test(String(p || ''))
    const base = src.replace(/[\\/][^\\/]*$/, '')          // 只为取个文件名前缀，不用于输出
    const name = `${(base.split(/[\\/]/).pop() || 'voice').slice(0, 24)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.silk`
    const dirs = [join(tmpdir(), 'dsh-voice-send'), join(this.clientDir || '', 'dsh-voice-tmp')]
    for (const d of dirs) {
      if (!d || !isAscii(d)) continue
      try {
        mkdirSync(d, { recursive: true })
        return join(d, name)
      } catch { /* 试下一个 */ }
    }
    return ''
  }

  /**
   * 查/改 hook 的语音发送开关（内存态，优先级高于 .on 文件）。
   *
   * ★ 2026-10-23 修：面板切换原来只改 hook 运行时内存，**微信一重启就恢复关闭**，
   *   用户会以为"面板开关不管用"。现在切换成功的同时**同步建/删标记文件**
   *   <客户端目录>\hook-voice-send.on —— 这样重启微信后仍然是用户选的状态。
   */
  async voiceSendSwitch(on) {
    try {
      const body = (on === undefined) ? {} : { on: !!on }
      const r = await this.api('/Debug/VoiceSend', body, 'POST', 8000)
      if (on !== undefined && r) {
        try {
          const marker = join(this.clientDir, 'hook-voice-send.on')
          if (on) {
            if (!existsSync(marker)) writeFileSync(marker, '')
          } else if (existsSync(marker)) {
            unlinkSync(marker)
          }
        } catch (e) {
          this.log('语音：同步标记文件失败：' + String(e?.message || e).slice(0, 120))
        }
      }
      return r || null
    } catch (e) {
      this.log('语音：调 /Debug/VoiceSend 失败：' + String(e?.message || e).slice(0, 120))
      return null
    }
  }

  /**
   * **合成 + 发送**一条语音气泡（给插件用的收口）。
   * 合成失败/发送失败都只记日志并返回 `{ok:false, error}`（调用方降级发文字，绝不阻塞）。
   * 临时 SILK 发完就删（tts 模块本身也有 1 小时兜底清理）。
   */
  async sayVoice(roomId, text, { emotion = 'main' } = {}) {
    // fail-closed：禁止发送窗口内**连合成都省掉**，直接返回错误（不发任何 HTTP）
    if (!this.#guard()) return { ok: false, ret: -1, error: '禁止发送（fail-closed 守卫）' }
    const { synthesizeVoice } = await import('./tts.mjs')
    const t0 = Date.now()
    const v = synthesizeVoice(String(text || ''), { emotion, log: (s) => this.log(s) })
    if (!v?.file) return { ok: false, error: 'TTS 合成失败（见上面的 TTS 日志）' }
    // ★ 2026-10-23：极短/纯标点文本合成出来可能只有几字节（如 "……"），
    //   hook 的 preflight 会拒绝；这里提前判失败，让上层降级发文字，别发个空语音。
    if (!Number(v.bytes) || Number(v.bytes) < 300) {
      try { unlinkSync(v.file) } catch (e) { }
      return { ok: false, error: 'TTS 结果过短（' + (v.bytes || 0) + ' 字节，文本=' + JSON.stringify(String(text || '').slice(0, 20)) + '）→ 改发文字' }
    }
    let sent = null
    try {
      sent = await this.sendVoice(roomId, v.file, v.durationMs)
    } finally {
      try { unlinkSync(v.file) } catch { /* ignore */ }   // 发完删临时 SILK
    }
    if (sent?.ret !== 0) {
      return { ok: false, error: `发送失败 ret=${sent?.ret}（${sent?.retmsg || ''}）`, bytes: v.bytes, durationMs: v.durationMs }
    }
    this.log(`语音气泡已发出：${v.bytes} 字节 / ${v.durationMs}ms（${emotion}，${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    return { ok: true, ret: sent.ret, bytes: v.bytes, durationMs: v.durationMs, emotion, diag: sent.diag }
  }

  async pat() { return -1 }
  async revoke() { return -1 }
  async forward() { return -1 }

  /**
   * 防自动更新守卫。
   *
   * 血泪教训：微信会**自己更新**（4.1.10.27 → 4.1.15.55），把版本目录删掉重建，
   * hook 是按 4.1.10.27 编译的 → 整个接入层静默失效。而且更新器/更新缓存
   * 被改名后客户端会**重新创建**，所以必须周期性检查（自愈）。
   */
  guardUpdates() {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const targets = [
      // 客户端里的更新器（最关键：没有它就没法升级）
      join(this.clientDir, '4.1.10.27', 'WeixinUpdate.exe'),
      // 更新插件与下载缓存（客户端启动时会重建，所以要反复压）
      join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'xplugin', 'plugins', 'WeixinUpdate'),
      join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'update', 'download'),
      join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'update', 'patch'),
    ]
    for (const t of targets) {
      try {
        if (!existsSync(t)) continue
        const off = t + '.disabled'
        // 上一轮的 .disabled 还在 → 先清掉（那只是更新缓存/旧副本，不是用户数据）
        if (existsSync(off)) rmSync(off, { recursive: true, force: true })
        renameSync(t, off)
        this.log('防更新：已禁用 ' + t)
      } catch { /* 被客户端占用就下次巡检再试 */ }
    }
  }

  /**
   * 只结束**机器人自己的**客户端进程。
   * 绝对不能按镜像名 taskkill：这台机器上还跑着用户日常用的微信（另一处安装），
   * 按名字杀会把用户的微信一起干掉（踩过这个坑，必须按可执行文件路径过滤）。
   */
  killOwnClient() {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | `
        + `Where-Object { $_.ExecutablePath -eq '${this.wechatExe.replace(/'/g, "''")}' } | `
        + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', timeout: 20_000 })
      this.log('已结束机器人客户端进程（按路径精确匹配）')
      return out
    } catch (e) {
      this.log('结束客户端失败：' + String(e?.message || e))
    }
  }

  /**
   * 尝试把消息里的媒体图取到本地（供图像识别用）。
   *
   * 现实情况（实测结论）：
   *  - 表情包 type=47：XML 里有**完整 cdnurl**（vweixinf.tc.qq.com），直接能下，且未加密 ✓
   *  - 图片  type=3 ：只有 cdnthumburl/cdnmidimgurl 这类 **fileid 十六进制串**，
   *                   需要客户端内部 CDN 接口才能解析，我们拿不到 ✗
   *  - 该便携客户端不把图片落盘、屏幕截图又是空白（硬件加速）✗
   * 所以这里尽力而为：有 http(s) URL 就下，没有就返回 null。
   */
  /**
   * 视频消息（type 43）：**主路**是拿视频文件本身（抽帧拼联系表 + 抽音轨成 16k WAV），
   * 拿不到视频文件就退回那张**明文封面**（封面兜底路径保留）。
   *
   * 分工：抽帧/拼表/抽音轨在桥侧（本地 ffmpeg，见 video-probe.py）；
   * **音轨转写**在插件侧（DSH 的 speechToText）——桥没有 ASR 服务，所以只把 WAV 路径交给插件。
   *
   * @returns {{file:string, kind:'video'|'cover', wav:string, durationSec:number, frames:number, note:string, srcVideo?:string}|null}
   */
  async fetchVideo(xml, roomId = '', nearTs = 0, frames = 6) {
    const log = (s) => this.log(s)
    let root = ''
    try { root = await resolveDataRoot(this.api.bind(this), this.selfWxid || '') } catch { /* ignore */ }
    const meta = xmlVideoMeta(xml)
    const tag = `video-${Number(nearTs) || Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // ── ⓪ 优先：hires provider 下到的整段视频（不需要点开播放）──
    try {
      const hv = await waitHiresVideo(roomId, Number(nearTs) || 0, 20000, Number(meta.length) || 0)
      if (hv) {
        const mp4 = hiresVideoToMp4(hv.path)
        this.log(`高分辨率视频命中：${hv.name}（${Math.round(hv.size / 1024)}KB）→ ${mp4}`)
        const r = probeVideo(mp4, { frames: Number(frames) || 6, fps: 1, tag, log })
        if (r?.sheet) {
          const sheetCount = (r.sheets || [r.sheet]).length
          this.log(`视频内容已抽取：${r.frames} 帧（每秒 1 帧）→ ${sheetCount} 张联系表`
            + `｜时长 ${r.durationSec}s${r.wav ? `｜音轨 ${r.wavSeconds}s` : '｜无音轨'}`)
          return {
            file: r.sheet, sheets: r.sheets || [r.sheet], kind: 'video', wav: r.wav || '',
            durationSec: r.durationSec || 0, frames: r.frames || 0,
            note: r.wav ? '抽帧+音轨（hires）' : '只有画面（hires）',
            srcVideo: mp4, declaredBytes: hv.size,
          }
        }
      }
    } catch (e) { this.log('hires 视频链路异常：' + String(e?.message || e).slice(0, 120)) }

    // ── ① 主路：视频文件 → 抽帧拼联系表 + 抽音轨 ──
    try {
      const f = findVideoFile(root, roomId, {
        nearTs: Number(nearTs) || 0, declaredBytes: meta.length, log,
      })
      if (f) {
        const r = probeVideo(f.path, { frames: Number(frames) || 6, tag, log })
        if (r?.sheet) {
          this.log(`视频内容已抽取：${r.frames} 帧拼成联系表（${Math.round(r.sheetBytes / 1024)}KB）`
            + `｜时长 ${r.durationSec}s${r.wav ? `｜音轨 ${r.wavSeconds}s → ${r.wav}` : '｜无音轨'}`)
          return {
            file: r.sheet, kind: 'video', wav: r.wav || '',
            durationSec: r.durationSec || 0, frames: r.frames || 0,
            note: r.wav ? '抽帧+音轨' : '只有画面（无音轨）',
            // 把"命中的那个视频原文件"一并交给插件：它按 videoDeleteAfterRead 决定读完是否删掉。
            // 只交出 findVideoFile() 已按 mtime±30min + 大小±10% 校验过的那个，绝不猜。
            srcVideo: f.path, declaredBytes: meta.length,
          }
        }
        this.log('抽帧/拼表失败 → 退回封面兜底')
      }
    } catch (e) {
      this.log('视频文件处理异常（退回封面兜底）：' + String(e?.message || e))
    }

    // ── ② 兜底：明文封面（微信给每条视频都落一张，不需要下载）──
    try {
      const cover = findVideoCover(root, {
        nearTs: Number(nearTs) || 0, declaredBytes: meta.cdnthumblength, log,
      })
      if (cover) {
        this.log(`视频封面已取到（${meta.cdnthumbwidth || '?'}x${meta.cdnthumbheight || '?'}`
          + `，时长 ${meta.playlength || '?'}s）→ ${cover}`)
        return { file: cover, kind: 'cover', wav: '', durationSec: meta.playlength || 0, frames: 0, note: '只有封面' }
      }
      this.log('视频封面也没找到 → 降级成 [视频]')
    } catch (e) {
      this.log('取视频封面异常（降级成 [视频]）：' + String(e?.message || e))
    }
    return null
  }

  async fetchMedia(xml, type, roomId = '', nearTs = 0) {
    this.log(`fetchMedia 收到：type=${type} roomId=${roomId || "(空)"} ts=${nearTs}`)
    // ── 普通图片（type 3）：回调里没有下载地址，走"本地 .dat 解密"这条路 ──
    // 微信把收到的图片以 V2 加密存在
    //   <数据目录>\msg\attach\<md5(群id)>\<年-月>\Img\<md5>[_t|_h].dat
    // 密钥在微信进程内存里（需客户端解密过一次图片）。hook 的 /Decode_Pic 对这个构建失效，
    // 所以我们自己解密（lib/wechat-image.mjs）。
    if (type === 3 && roomId) {
      // ★ 优先用「hires provider」提供的全分辨率图（未加密 JPEG）
      //   本机若装了可选的提供者（不随本项目分发），它会把这个目录填上；没有就自动跳过。
      //   那份是【未加密的普通 JPEG】且是全尺寸（实测 1260x2800 / 1.46MB），不需要解密也不用 HEVC。
      //   文件名约定 = <roomId>_<unix秒>_<localId>_<序号>_<任意标记>.dat
      const replay = await waitHiresImage(roomId, Number(nearTs) || 0)
      if (replay) {
        this.log(`高分辨率缓存命中：${replay.name}（${Math.round(replay.size / 1024)}KB）`)
        return hiresToJpg(replay.path)
      }
      this.log(`高分辨率缓存未命中（ts=${Number(nearTs) || 0}），改走本地 .dat`)
      try {
        const root = await resolveDataRoot(this.api.bind(this), this.selfWxid || '')
        // ★ 候选顺序：_h 高清预览 > _t 缩略图 > 原图(WXGF)
        //   实测原图 .dat 常不完整（45~70KB），解出来是纯白/纯绿花屏；
        //   而 _h/_t 是完整小 JPEG，反而看得清。所以按可靠性试，并校验亮度。
        let cands = findDatCandidates(root, roomId, { nearTs: Number(nearTs) || 0, toleranceMs: 30 * 60_000 })
        // ★ 微信的高清图（_h.dat）常常晚几秒才下完 → 如果这组还没有 _h，等一会儿再查两次
        if (!cands.some((c) => c.label.includes('_h'))) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise((r) => setTimeout(r, 15000))
            const again = findDatCandidates(root, roomId, { nearTs: Number(nearTs) || 0, toleranceMs: 30 * 60_000 })
            if (again.some((c) => c.label.includes('_h'))) {
              this.log('等了 ' + (attempt * 15) + ' 秒，高清图(_h)出现了 → 用高清的')
              cands = again
              break
            }
          }
        }
        if (!cands.length) {
          this.log('本地没找到这张图对应的 .dat（可能未下载）')
        } else {
          let picked = null
          for (const c of cands) {
            let r = decryptDat(c.path, { tag: 'chat' })
            if (!r) {
              this.log(`解密失败（${c.label}），尝试重扫图片密钥…`)
              try {
                execFileSync(process.env.PYTHON_EXE || 'D:\\Python311\\python.exe',
                  [join(dirname(fileURLToPath(import.meta.url)), 'decode-wechat-image.py'), '--find-key'],
                  { windowsHide: true, timeout: 300_000, stdio: 'ignore' })
              } catch { /* ignore */ }
              r = decryptDat(c.path, { tag: 'chat-retry' })
            }
            if (!r) { this.log(`解密失败：${c.name}`); continue }
            const bright = r.brightness
            const neon = (r.neon === undefined) ? -1 : r.neon
            // ★ 判据：纯白（亮度≥250）= 占位帧；霓虹占比≥30% = HEVC 截断导致的花屏
            const unknown = (bright < 0 || neon < 0)   // 测不出指标（转换失败）= 不可用
            const white = bright >= 250
            const glitch = neon >= 30
            const ok = !unknown && !white && !glitch
            this.log(`解密 ${c.label} ${c.name}（${Math.round(c.size / 1024)}KB，亮度${bright}，霓虹${neon}%）`
              + (ok ? ' ✓ 可用' : (unknown ? ' ✗ 转换失败/测不出，换下一个' : (white ? ' ✗ 纯白，换下一个' : ' ✗ 花屏，换下一个'))))
            if (ok) { picked = r; break }
            try { unlinkSync(r.path) } catch { /* ignore */ }
          }
          if (picked) {
            // ★ 修好 XOR 密钥后，同一张图的多份副本都能解出来了 → 全部解一遍，挑【像素面积最大】的
            //   实测：中图(无后缀)解出 1154x1964，而 Bubble 只有 293x500 —— 只取第一个会拿到小的
            const valid = [{ ...picked }]
            for (const c of cands) {
              if (valid.length >= 4) break            // 最多再解 3 个，控制耗时
              if (String(c.path) === String(picked.path)) continue
              const r2 = decryptDat(c.path, { tag: "chat-more" })
              if (!r2) continue
              const bad2 = r2.brightness < 0 || r2.neon < 0 || r2.brightness >= 250 || r2.neon >= 30
              if (bad2) { try { unlinkSync(r2.path) } catch { /* ignore */ } continue }
              valid.push(r2)
              this.log(`  备选 ${c.label}：${r2.dims ? r2.dims.w + "x" + r2.dims.h : "?"}`)
            }
            const area = (r) => (r.dims ? r.dims.w * r.dims.h : 0)
            valid.sort((a, b) => area(b) - area(a))
            const best = valid[0]
            for (const r of valid) { if (r !== best) { try { unlinkSync(r.path) } catch { /* ignore */ } } }
            this.log(`采用分辨率最高的那张：` + (best.dims ? `${best.dims.w}x${best.dims.h}` : "?") + ` → ${best.path}`)
            return best.path
          }
          this.log('本地所有候选都不可用（白图/花屏）→ 试 CDN')
        }
      } catch (e) {
        this.log('本地解密路径异常：' + String(e?.message || e))
      }
    }

    if (!xml) return null
    return await this.tryCdnImages(xml, type)
  }

  /**
   * 从 CDN 候选里挑【实际分辨率最大】的那张（原图 > 中图 > 缩略图）。
   * 为什么：微信 CDN 对无鉴权请求经常只回缩略图，而且很多消息**只有** cdnthumburl。
   * 以前按「第一个存在的 URL 就拿」→ 常常拿到 8KB 缩略图 → 视觉模型看不清细节。
   */
  /** GIF 表情 → 首帧 PNG（识图链路不吃 GIF；GIF 本体仍留给表情库） */
  gifToPng(gifPath) {
    try {
      const ff = process.env.FFMPEG_EXE
        || 'D:\\Python311\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe'
      if (!existsSync(ff)) return ''
      const out = gifPath.replace(/\.gif$/i, '') + '-frame0.png'
      execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', gifPath,
        '-frames:v', '1', out], { timeout: 20_000, stdio: 'ignore' })
      return existsSync(out) ? out : ''
    } catch (e) {
      this.log('GIF 转 PNG 失败：' + String(e?.message || e).slice(0, 80))
      return ''
    }
  }

  async tryCdnImages(xml, type) {
    const attr = (k) => {
      const m = new RegExp(`${k}="([^"]*)"`).exec(xml)
      return m ? m[1].replace(/&amp;/g, '&') : ''
    }
    const list = type === 47
      ? [['cdnurl', '原图'], ['cdnthumburl', '缩略'], ['encrypturl', '加密']]
      : [['cdnbigimgurl', '原图'], ['cdnmidimgurl', '中图'], ['cdnthumburl', '缩略'], ['cdnurl', '链接']]
    const cands = []
    for (const [k, label] of list) {
      const u = attr(k)
      if (/^https?:\/\//i.test(u) && !cands.some((x) => x.url === u)) cands.push({ url: u, label })
    }
    if (!cands.length) {
      const raw = ['cdnbigimgurl','cdnmidimgurl','cdnthumburl','cdnurl','encrypturl']
        .map((k) => k + "=" + (attr(k) ? String(attr(k)).length + "字符" : "空"))
        .filter((s) => !s.endsWith("空"))
      this.log('CDN 候选：' + (raw.length ? raw.join(' ') : 'XML 里一个地址都没有'))
      return null
    }
    let best = null
    for (const c of cands) {
      try {
        const r = await fetch(c.url, { headers: { 'user-agent': 'MicroMessenger' }, signal: AbortSignal.timeout(25_000) })
        if (!r.ok) { this.log(`取图(${c.label}) HTTP ${r.status}`); continue }
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 100) { this.log(`取图(${c.label}) 内容过小`); continue }
        // ★ 魔数校验：加密封装（encrypturl 那条）头是随机的，会污染表情库和识图
        const isImg = (buf[0] === 0xff && buf[1] === 0xd8)
          || (buf[0] === 0x89 && buf[1] === 0x50)
          || buf.slice(0, 3).toString('latin1') === 'GIF'
          || (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP')
        if (!isImg) { this.log(`取图(${c.label}) 不是图片（加密封装？）跳过`); continue }
        const d = imageDims(buf)
        const area = d ? d.w * d.h : buf.length
        this.log(`取图(${c.label}) ${Math.round(buf.length / 1024)}KB` + (d ? ` ${d.w}x${d.h}` : ''))
        if (!best || area > best.area) best = { buf, d, area, label: c.label }
        if (d && Math.max(d.w, d.h) >= 1200) break
      } catch (e) {
        this.log(`取图(${c.label}) 异常：${String(e?.message || e).slice(0, 80)}`)
      }
    }
    if (!best) return null
    const head = best.buf.slice(0, 4)
    const ext = head[0] === 0xff && head[1] === 0xd8 ? 'jpg'
      : head[0] === 0x89 ? 'png'
        : best.buf.slice(0, 3).toString('latin1') === 'GIF' ? 'gif' : 'bin'
    const dir = join(this.dataDir, 'wechat-media')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${type}.${ext}`)
    writeFileSync(file, best.buf)
    this.log(`取到媒体图(${best.label})：${file}（${Math.round(best.buf.length / 1024)}KB`
      + `${best.d ? `，${best.d.w}x${best.d.h}` : ''}）`)
    // ★ 表情包（type=47）：顺手收藏进表情库 —— 插件每次都会为表情调 fetchMedia，
    //   所以这里是最可靠的收藏点（比回调路径稳：数据库轮询来的表情不经过回调）。
    if (type === 47 && this.stickers) {
      try {
        const st = this.stickers.add({
          srcPath: file, xml, kind: 'emoticon', source: 'collected',
            sender: '', senderName: '', roomId: '', context: '',
        })
        if (st) this.log(`表情包已收藏：${st.id}（含图片，可发送）${Math.round(best.buf.length / 1024)}KB`)
          try { (this._stickerByFile ||= new Map()).set(file, st.id) } catch { /* ignore */ }
      } catch (e) { this.log('表情包收藏失败：' + String(e?.message || e).slice(0, 80)) }
    }
      // ★ GIF 动图识图链路不支持 → 转首帧 PNG 返回；GIF 本体已存进表情库
      if (type === 47 && String(file).toLowerCase().endsWith('.gif')) {
        const png = this.gifToPng(file)
        if (png) { this.log(`表情 GIF 转首帧 PNG：${png}`); return png }
      }
    return file
  }

  /**
   * 群名 + 联系人名：contact.db 在微信 4.x 里经常被卸载/句柄失效，但 contact_fts.db 一直可读。
   * 文本在 contact_fts_v5_content.c0（\b 分隔），用 name2id.rowid ↔ username 对上。
   * - username 以 @chatroom 结尾 → 群名（只补 _roomCache 里已知的会话）
   * - 其它 → 联系人昵称（补 _contactMap，消息 senderName 就能显示人名）
   */
  async refreshRoomNames() {
    this._roomNamesAt = Date.now()
    try {
      const sql = 'SELECT n.username AS id, c.c0 AS name '
        + 'FROM name2id n JOIN contact_fts_v5_content c ON c.id = n.rowid'
      const r = await this.api('/QueryDB/execute', { optDbName: 'contact_fts.db', SQL: sql }, 'POST', 15000)
      const rows = Array.isArray(r?.data) ? r.data : []
      let changed = 0
      let people = 0
      for (const row of rows) {
        const id = String(row.id || '')
        if (!id) continue
        const parts = String(row.name || '').split(/\u0008+/).map((s) => s.trim()).filter(Boolean)
        const name = parts[0] || ''
        if (!name) continue
        if (id.endsWith('@chatroom')) {
          if (!this._roomCache.has(id)) continue
          if (this._roomCache.get(id) !== name) {
            this._roomCache.set(id, name)
            changed++
          }
        } else if (!id.endsWith('@openim')) {
          if (this._contactMap.get(id) !== name) {
            this._contactMap.set(id, name)
            people++
          }
        }
      }
      if (changed) this.saveRooms()
      if (changed || people) {
        this.log(`名字已更新：群 ${changed} 个 / 人 ${people} 个（contact_fts.db）`)
      }
    } catch (e) {
      this._roomNamesAt = 0            // 失败不锁 60 秒，下次 rooms() 再试
      this._roomNamesFailAt = Date.now()
      this.log('名字读取失败（保留 roomId/wxid）：' + String(e?.message || e).slice(0, 120))
    }
  }

  /** 群列表：库里读不到，就返回"见过的群"（回调出现过的 + 表情包库记录的） */
  async rooms() {
    // 群名过期（或还是 roomId）→ 后台补一次；不阻塞本次返回
    if (Date.now() - (this._roomNamesAt || 0) > 60_000
      && Date.now() - (this._roomNamesFailAt || 0) > 60_000) {
      void this.refreshRoomNames()
    }
    if (this.stickers?.items) {
      for (const it of this.stickers.items) {
        for (const rid of it.rooms || []) if (rid && !this._roomCache.has(rid)) this._roomCache.set(rid, rid)
      }
    }
    // ── 2026-10-27：把轮询器已发现的会话表并进群列表 ────────────────────
    // 背景：现在唯一在用的消息来源是【数据库轮询】，而它不登记群（不像回调路径）。
    //   → 被拉进新群后 /api/rooms 永远没有它：面板「记忆/群与人/白名单」都选不到，
    //     点「读取」直接报「找不到群：xxx@chatroom」（用户实测踩到）。
    // 轮询器的 tables 里就有 roomId，并进来即可（名字先用 roomId，之后 refreshRoomNames 会补）。
    let addedFromPoller = 0
    try {
      for (const [, info] of (this.poller?.tables || [])) {
        const rid = info && info.roomId
        if (!rid || !String(rid).endsWith('@chatroom')) continue
        if (this._roomCache.has(rid)) continue
        this._roomCache.set(rid, rid)
        addedFromPoller++
      }
      if (addedFromPoller) {
        this.saveRooms()
        this.log('群列表：从轮询会话表补进 ' + addedFromPoller + ' 个新群')
      }
    } catch { /* 拿不到 tables 就算了，别影响群列表返回 */ }

    const out = []
    for (const [roomId, name] of this._roomCache) {
      if (roomId === 'mock-room-1') continue        // mock 模拟群不该出现在真实群列表里
      out.push({ roomId, name: name || roomId, owner: '', members: 0 })
    }
    return out
  }

  history() { return [] }

  /**
   * 轮询器快照（只读）。为什么单独抽出来：自检只调一次 status 就能判断
   * 「轮询到底在不在跑」——硬闸状态下库照样读得动，只看库会全绿。
   */
  pollStatus() {
    const p = this.poller
    if (!p) return { exists: false }
    let tables = 0
    try { tables = p.tables instanceof Map ? p.tables.size : 0 } catch { /* ignore */ }
    return {
      exists: true,
      hardStopped: typeof p.hardStopped === 'function' ? !!p.hardStopped() : false,
      stopped: !!p.stopped,
      paused: typeof p.paused === 'function' ? !!p.paused() : false,
      pauseLeftSec: typeof p.pauseLeftSec === 'function' ? Number(p.pauseLeftSec()) || 0 : 0,
      consecFail: Number(p._consecFail || 0),
      probeFailRounds: Number(p._probeFailRounds || 0),
      polls: Number(p.stats?.polls || 0),
      msgs: Number(p.stats?.msgs || 0),
      errors: Number(p.stats?.errors || 0),
      pauses: Number(p.stats?.pauses || 0),
      tables,
      // 当前在用的消息库分片（message_0/1/…）。微信会轮换分片，
      // 自检文案里如果写死 message_0.db 会把人带偏（2026-10-27 实测已轮换到 message_1.db）。
      shard: String(p._shard || ''),
      lastError: String(p._lastReadErr || ''),
    }
  }

  status() {
    return {
      loggedIn: this.loggedIn, self: this.selfWxid, selfName: this.selfName,
      port: this.apiPort, cbPort: this.cbPort, transport: 'wechat-hook', ready: this.ready,
      lastError: this.lastError,
      stickers: this.stickers ? this.stickers.stats() : null,
      contacts: this._contactMap.size,
      callbacks: this._cbCount, messages: this._msgCount,
      // ★ 2026-10-25：把轮询状态并进 status，自检才看得到「哑没哑」。
      //   之前自检读 br.hardStopped，但 status 根本没这个字段 → 判断是死代码，永远绿。
      poll: this.pollStatus(),
    }
  }
}
