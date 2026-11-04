/**
 * wxhelper（微信 4.x hook）传输层 —— 与 WcfBridge 接口一致，可直接替换。
 *
 * 链路：
 *   注入 wxhook.dll 到运行中的微信进程
 *     → DLL 读 ./config.ini 起 wxhelper HTTP API（默认 19001）
 *     → 我们 POST /api/hookSyncMsg 注册回调地址
 *     → 微信新消息由 DLL 推给我们的回调服务器（HTTP 或裸 TCP 二选一）
 *   发送：POST /api/sendTextMsg / sendAtText / sendImagesMsg / sendCustomEmotion / sendFileMsg / sendPatMsg
 *
 * 为什么走 HTTP 而不像 wxhook 的 Python 那样用 socket 客户端：
 *   DLL 本身就是 HTTP 服务（mongoose），Node 直接 fetch 即可，无需 Python 常驻进程。
 *   只有"注入"这一步借用 Python（pymem/ctypes 现成且已验证）。
 *
 * 已知要点（实测得出，别凭猜改）：
 *   - 必须先扫码登录，**再**注入 DLL；未登录时调 API 会让微信崩。
 *   - 客户端必须从"可写目录"启动，config.ini 放在其工作目录（4.x 是版本子目录）。
 *   - DLL 与微信版本强相关（特征扫描）：4.1.15.53 实测可加载。
 */
import http from 'node:http'
import { pythonExe, ffmpegExe, wechatExe, wechatClientDir, wxhookDir, hookFile } from './paths.mjs'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { injectDll, findMainPid, isModuleLoaded } from './inject.mjs'

/** 微信原生消息类型 → 我们的语义名（与 WCF 保持一致） */
const TYPE_NAMES = {
  1: 'text', 3: 'image', 34: 'voice', 37: 'friendVerify', 42: 'shareCard',
  43: 'video', 47: 'emoticon', 48: 'location', 49: 'app', 50: 'voip',
  51: 'phoneSync', 10000: 'sys', 10002: 'sys',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class WxhelperBridge {
  constructor(opts = {}) {
    this.apiPort = opts.apiPort ?? 19001
    this.sockPort = opts.sockPort ?? 18999
    this.httpPort = opts.httpPort ?? 18998
    this.emit = opts.emit || (() => {})
    this.stickers = opts.stickers || null
    this.dataDir = opts.dataDir || process.cwd()
    this.dllPath = opts.dllPath || join(wxhookDir() || '', 'wxhook.dll')
    this.pythonExe = opts.pythonExe || 'D:\\Python311\\python.exe'
    this.injector = opts.injector || 'D:\\wxhook\\inject_ctypes.py'
    this.wechatExe = opts.wechatExe || 'D:\\wxhook\\weixin-run\\Weixin.exe'
    this.log = opts.log || (() => {})

    this.selfWxid = ''
    this.selfName = ''
    this.loggedIn = false
    this.lastError = ''
    this.injected = false
    this._seq = 0
    this._contactMap = new Map()      // wxid -> 昵称
    this._roomCache = new Map()
    this._memberCache = new Map()
    this._recentText = new Map()
    this._servers = []
    this._pollTimer = null
  }

  get ok() { return this.injected && this.loggedIn }

  // ── HTTP API ────────────────────────────────────────────────
  async api(path, data, timeoutMs = 8000) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('api timeout')), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data ?? {}),
        signal: ac.signal,
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return { code: res.status, msg: text } }
    } finally {
      clearTimeout(t)
    }
  }

  // ── 进程与注入 ──────────────────────────────────────────────
  findPid(name = 'Weixin.exe') {
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

  /**
   * 取微信"主进程"——必须注入到它，注入到辅助进程不会起 API（实测踩过）。
   * 判据：有主窗口的那个（微信 4.x 是多进程，只有主进程有窗口）。
   */
  mainPid() { return findMainPid('Weixin') }

  isDllLoaded(pid) {
    const name = this.dllPath.replace(/^.*[\\/]/, '')
    return isModuleLoaded(pid, name)
  }

  ensureClient() {
    const pids = this.findPid('Weixin.exe')
    if (pids.length) return
    if (!existsSync(this.wechatExe)) throw new Error('微信客户端不存在：' + this.wechatExe)
    this.log('启动微信客户端 ' + this.wechatExe)
    const dir = this.wechatExe.replace(/[\\/][^\\/]+$/, '')
    // config.ini 决定 DLL 的 API 端口；DLL 按"进程工作目录"找它
    const ini = `[config]\r\nport=${this.apiPort}\r\nip=0.0.0.0\r\n`
    for (const d of [dir, ...this.versionDirs(dir)]) {
      try { writeFileSync(join(d, 'config.ini'), ini) } catch { /* ignore */ }
    }
    spawn(this.wechatExe, [], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
  }

  versionDirs(dir) {
    try {
      return execFileSync('cmd', ['/c', `dir /b /ad "${dir}"`], { encoding: 'latin1' })
        .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+/.test(s))
        .map((s) => join(dir, s))
    } catch { return [] }
  }

  /** 自研注入（纯 Node/koffi），不再依赖 Python */
  inject() {
    const pid = this.mainPid()
    if (!pid) throw new Error('找不到微信主进程（有主窗口的那个）')
    if (this.isDllLoaded(pid)) { this.injected = true; return pid }
    this.log(`注入 ${this.dllPath} 到主进程 pid=${pid}`)
    const r = injectDll(pid, this.dllPath)
    if (!r.ok) throw new Error('注入失败：' + r.error)
    this.log('注入成功 hmod=' + r.hmod)
    this.injected = true
    return pid
  }

  // ── 回调服务器（收消息）──────────────────────────────────────
  startServers() {
    if (this._servers.length) return
    const handle = (raw, reply) => {
      try {
        const ev = JSON.parse(raw)
        this.onEvent(ev)
      } catch (e) { this.log('事件解析失败: ' + String(e?.message || e)) }
      reply()
    }

    // HTTP 模式（enableHttp=1）
    const httpSrv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        handle(body, () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('200 OK') })
      })
    })
    httpSrv.on('error', (e) => this.log('回调 HTTP 服务错误: ' + e.message))
    httpSrv.listen(this.httpPort, '127.0.0.1')

    // 裸 TCP 模式（wxhelper 默认 socket 回调，读到 \n 为止，回 "200 OK"）
    const tcpSrv = net.createServer((sock) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString('utf8')
        if (buf.includes('\n') || buf.length > 0) {
          handle(buf.trim(), () => { try { sock.write('200 OK') } catch { /* ignore */ } })
          buf = ''
        }
      })
      sock.on('error', () => { /* ignore */ })
    })
    tcpSrv.on('error', (e) => this.log('回调 TCP 服务错误: ' + e.message))
    tcpSrv.listen(this.sockPort, '127.0.0.1')

    this._servers.push(httpSrv, tcpSrv)
  }

  async registerHook() {
    // enableHttp=1 + url：DLL 用 HTTP POST 推事件（更省事）；同时给 socket 端口做兜底
    const r = await this.api('/api/hookSyncMsg', {
      port: this.sockPort,
      ip: '127.0.0.1',
      enableHttp: 1,
      url: `http://127.0.0.1:${this.httpPort}`,
      timeout: 30,
    })
    this.log('hookSyncMsg 注册结果: ' + JSON.stringify(r))
    return r
  }

  // ── 生命周期 ────────────────────────────────────────────────
  async start() {
    this.ensureClient()
    // 等客户端就绪（多进程起来需要时间）
    for (let i = 0; i < 30 && !this.mainPid(); i++) await sleep(1000)
    if (!this.mainPid()) throw new Error('微信客户端未能启动')
    // 必须已登录再注入
    const pid = this.inject()
    // 等 HTTP API 起来
    let up = false
    for (let i = 0; i < 30; i++) {
      try { await this.api('/api/checkLogin', {}, 3000); up = true; break } catch { await sleep(1000) }
    }
    if (!up) throw new Error(`wxhelper API(${this.apiPort}) 未就绪`)
    this.startServers()
    await this.registerHook()
    await this.refreshSelf()
    this.startLoginPoll()
    this.emit('started', { port: this.apiPort, loggedIn: this.loggedIn, self: this.selfWxid, transport: 'wxhelper' })
    return true
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer)
    this._pollTimer = null
    for (const s of this._servers) { try { s.close() } catch { /* ignore */ } }
    this._servers = []
    // 不主动卸载 DLL（wxhelper 没有 unload 接口；退出微信即消失）
  }

  async refreshSelf() {
    try {
      const r = await this.api('/api/userInfo')
      const d = r?.data || {}
      this.selfWxid = d.wxid || ''
      this.selfName = d.name || ''
      this.loggedIn = !!this.selfWxid
      this.emit('login', { self: this.selfWxid, name: this.selfName })
    } catch (e) {
      this.log('userInfo 失败: ' + String(e?.message || e))
    }
  }

  startLoginPoll() {
    if (this._pollTimer) return
    this._pollTimer = setInterval(() => {
      void (async () => {
        try {
          const r = await this.api('/api/checkLogin', {}, 4000)
          const ok = r?.code === 200
          if (ok && !this.loggedIn) { await this.refreshSelf() }
          if (!ok && this.loggedIn) { this.loggedIn = false; this.emit('logout', {}) }
        } catch { /* ignore */ }
      })()
    }, 30_000)
  }

  isLogin() { return this.loggedIn }

  // ── 事件归一化 ──────────────────────────────────────────────
  onEvent(ev) {
    try {
      const m = this.normalize(ev)
      if (m) this.emit('msg', m)
    } catch (e) {
      this.emit('error', { message: 'normalize failed: ' + String(e?.message || e) })
    }
  }

  normalize(ev) {
    const type = Number(ev.type ?? 0)
    const tn = TYPE_NAMES[type] || ('type' + type)
    const fromUser = String(ev.fromUser ?? '')
    const isGroup = fromUser.endsWith('@chatroom')
    const roomId = fromUser
    const rawContent = ev.content ?? ''
    let sender = ''
    let text = ''

    if (isGroup) {
      // 群消息 content 形如 "wxid_xxx:\n正文"
      const s = String(rawContent)
      const idx = s.indexOf(':\n')
      if (idx > 0 && s.slice(0, idx).length < 64) {
        sender = s.slice(0, idx)
        text = s.slice(idx + 2)
      } else {
        text = s
      }
    } else {
      sender = fromUser
      text = String(rawContent)
    }

    if (tn === 'text') {
      const recent = this._recentText.get(roomId) || []
      recent.push(text)
      while (recent.length > 6) recent.shift()
      this._recentText.set(roomId, recent)
    } else if (tn === 'emoticon') text = '[表情包]'
    else if (tn === 'image') text = '[图片]'
    else if (tn === 'voice') text = '[语音]'
    else if (tn === 'video') text = '[视频]'

    const selfNames = this.selfNamesIn(roomId)
    let isAtMe = false
    for (const n of selfNames) if (n && String(rawContent).includes('@' + n)) { isAtMe = true; break }

    const norm = {
      seq: ++this._seq,
      id: String(ev.msgId ?? ''),
      type,
      typeName: tn,
      ts: ev.createTime ? Number(ev.createTime) * 1000 : Date.now(),
      isSelf: sender === this.selfWxid || String(ev.toUser ?? '').endsWith('@chatroom') === false && sender === this.selfWxid,
      isGroup,
      roomId,
      roomName: isGroup ? this.roomName(roomId) : (this.nameOf('', sender) || sender),
      sender,
      senderName: this.nameOf(roomId, sender),
      content: String(rawContent),
      text,
      isAtMe,
      atAll: String(rawContent).includes('@所有人'),
      signature: ev.signature || '',
      raw: ev,
    }

    // 表情包/图片：异步抓取归档
    if (tn === 'emoticon' || tn === 'image') {
      void this.captureSticker(ev, norm).then((st) => {
        if (st) this.emit('sticker', { id: st.id, roomId, sender, senderName: norm.senderName, context: '' })
      }).catch((e) => this.emit('error', { message: 'sticker capture: ' + String(e?.message || e) }))
    }
    return norm
  }

  /** 抓取收到的表情/图片到本地并归档 */
  async captureSticker(ev, norm) {
    if (!this.stickers) return null
    let src = ''
    try {
      const r = await this.api('/api/downloadAttach', { msgId: Number(ev.msgId) }, 15000)
      const p = r?.data?.filePath || r?.data?.path || r?.data || ''
      if (typeof p === 'string' && existsSync(p)) src = p
    } catch (e) {
      this.emit('error', { message: 'downloadAttach 失败: ' + String(e?.message || e) })
    }
    if (!src) {
      this.emit('sticker-miss', { type: ev.type, msgId: ev.msgId, content: String(ev.content ?? '').slice(0, 200) })
      return null
    }
    return this.stickers.add({
      srcPath: src, sender: norm.sender, senderName: norm.senderName,
      roomId: norm.roomId, context: (this._recentText.get(norm.roomId) || []).slice(-3).join(' '),
      kind: norm.typeName === 'image' ? 'image' : 'emoticon',
    })
  }

  // ── 名字/群信息 ─────────────────────────────────────────────
  async loadContacts() {
    if (this._contactMap.size) return this._contactMap
    try {
      const r = await this.api('/api/getContactList', {}, 20000)
      for (const c of r?.data || []) {
        if (c.wxid) this._contactMap.set(c.wxid, c.nickname || c.customAccount || c.wxid)
      }
    } catch (e) { this.log('getContactList 失败: ' + String(e?.message || e)) }
    return this._contactMap
  }

  nameOf(roomId, wxid) {
    if (!wxid) return ''
    const cached = this._memberCache.get(roomId)
    if (cached?.nameMap?.[wxid]) return cached.nameMap[wxid]
    return this._contactMap.get(wxid) || wxid
  }

  selfNamesIn(roomId) {
    const names = [this.selfName, this.selfWxid].filter(Boolean)
    const cached = this._memberCache.get(roomId)
    if (cached?.nameMap?.[this.selfWxid]) names.push(cached.nameMap[this.selfWxid])
    return [...new Set(names)]
  }

  roomName(roomId) {
    return this._roomCache.get(roomId) || roomId
  }

  /** 群成员（异步补全昵称） */
  async members(roomId) { return this.loadMembers(roomId) }

  async loadMembers(roomId) {
    const hit = this._memberCache.get(roomId)
    if (hit && Date.now() - hit.at < 300_000) return hit
    await this.loadContacts()
    let ids = []
    try {
      const r = await this.api('/api/getMemberFromChatRoom', { chatRoomId: roomId }, 15000)
      const raw = r?.data?.members || ''
      ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean)
    } catch (e) { this.log('getMemberFromChatRoom 失败: ' + String(e?.message || e)) }
    const members = ids.map((wxid) => ({
      userName: wxid,
      displayName: this._contactMap.get(wxid) || wxid,
      nickName: this._contactMap.get(wxid) || wxid,
      remark: '',
    }))
    const nameMap = Object.fromEntries(members.map((m) => [m.userName, m.displayName]))
    const entry = { at: Date.now(), members, nameMap }
    this._memberCache.set(roomId, entry)
    return entry
  }

  // ── 发送 ────────────────────────────────────────────────────
  async sendText(roomId, text, mentions = []) {
    if (mentions?.length) {
      const r = await this.api('/api/sendAtText', { chatRoomId: roomId, wxids: mentions.join(','), msg: text })
      return r?.code === 200 ? 0 : (r?.code ?? -1)
    }
    const r = await this.api('/api/sendTextMsg', { wxid: roomId, msg: text })
    return r?.code === 200 ? 0 : (r?.code ?? -1)
  }

  async sendImage(roomId, filePath) {
    const r = await this.api('/api/sendImagesMsg', { wxid: roomId, imagePath: filePath })
    return r?.code === 200 ? 0 : (r?.code ?? -1)
  }

  /** 发表情包（微信自定义表情） */
  async sendEmotion(roomId, filePath) {
    const r = await this.api('/api/sendCustomEmotion', { wxid: roomId, filePath })
    return r?.code === 200 ? 0 : (r?.code ?? -1)
  }

  async sendFile(roomId, filePath) {
    const r = await this.api('/api/sendFileMsg', { wxid: roomId, filePath })
    return r?.code === 200 ? 0 : (r?.code ?? -1)
  }

  async pat(roomId, wxid) {
    const r = await this.api('/api/sendPatMsg', { receiver: roomId, wxid })
    return r?.code === 200 ? 1 : (r?.code ?? -1)
  }

  async revoke(msgId) {
    // 该 DLL 版本没有撤回接口
    this.log('revoke 不受支持（当前 DLL 无 /api/revokeMsg）')
    return -1
  }

  async forward(msgId, roomId) {
    const r = await this.api('/api/forwardMsg', { msgId: Number(msgId), wxid: roomId })
    return r?.code === 200 ? 1 : (r?.code ?? -1)
  }

  async rooms() {
    // wxhelper 没有"群列表"接口 → 用联系人里 @chatroom 结尾的项
    await this.loadContacts()
    const out = []
    for (const [wxid, name] of this._contactMap) {
      if (wxid.endsWith('@chatroom')) {
        this._roomCache.set(wxid, name)
        out.push({ roomId: wxid, name, owner: '', members: 0 })
      }
    }
    return out
  }

  history() { return [] }   // 该 DLL 有 execSql 可查库，暂不实现

  status() {
    return {
      loggedIn: this.loggedIn,
      self: this.selfWxid,
      selfName: this.selfName,
      port: this.apiPort,
      transport: 'wxhelper',
      injected: this.injected,
      lastError: this.lastError,
      stickers: this.stickers ? this.stickers.stats() : null,
      contacts: this._contactMap.size,
    }
  }
}
