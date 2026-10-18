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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataRoot, findLatestDat, decryptDat } from './wechat-image.mjs'
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
    this.lastError = ''
    this.ready = false
    this._seq = 0
    this._srv = null
    this._contactMap = new Map()
    this._roomCache = new Map()
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
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('api timeout')), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
        signal: ac.signal,
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return { raw: text } }
    } finally { clearTimeout(t) }
  }

  async apiAlive() {
    try {
      const r = await this.api('/QueryDB/status', null, 'GET', 3000)
      return !!(r && (r.IsLogin !== undefined || r.hWeixin !== undefined))
    } catch { return false }
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
      this.loggedIn = true
      this.emit('login', { self: this.selfWxid, name: this.selfName })
      this.log('回调在线判定：客户端已登录（回调 #' + this._cbCount + '）')
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
    // 期间发送会被守卫拦住（例如 23:00 的晚安就发不出去）
    try {
      await this.probeSelfWxid()
      // 新版自编译 DLL 的 /GetSelfProfile 返回空（上游那段 profile hook 在仓库里也是坏的），
      // 所以再加一条判据：数据库能读到东西 = 已经登录（QueryDB 是我们修好的）
      if (!this.selfWxid && await this.dbReady()) {
        this.loggedIn = true
        this.log('启动探测：数据库可读 → 判定已登录（self 待定，等回调或插件侧识别）')
        this.emit('login', { self: this.selfWxid, name: this.selfName })
      }
      if (this.selfWxid && !this.loggedIn) {
        this.loggedIn = true
        this.log('启动探测：已登录 ' + this.selfWxid)
        this.emit('login', { self: this.selfWxid, name: this.selfName })
      }
    } catch { /* ignore */ }
    void this.loadContacts()
    // 消息来源：**数据库轮询**（公开源码里没有回调推送实现，见 lib/db-poller.mjs 顶部说明）
    if (!this.poller) {
      this.poller = new DbPoller({
        api: (p, b, m, to) => this.api(p, b, m, to),
        emit: (msg) => this.emit('msg', msg),
        log: (s) => this.log(s),
        intervalMs: Number(process.env.DB_POLL_MS || 2500),
        // 能轮询到数据库 = 一定已登录（比探测 /GetSelfProfile 可靠，那个接口这个构建是坏的）
        onReady: (self) => {
          if (self && !this.selfWxid) this.selfWxid = self
          if (!this.loggedIn) {
            this.loggedIn = true
            this.log('数据库轮询成功 → 判定已登录' + (self ? '，self=' + self : ''))
            this.emit('login', { self: this.selfWxid, name: this.selfName })
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
        // 所以"失败就放弃"是错的 —— 必须一直重试，等群里来消息（或自己发一条）后自然就绪。
        // 连续失败到第 4 次 → 请上层"唤醒"一下数据库（让机器人自己发条消息，
        // 微信就会写库、打开 message_0.db，轮询随即恢复）。这样**不用重启客户端**，
        // 也就不会触发"要手机确认登录"那一步。
        if ((attempt === 4 || attempt % 10 === 0) && typeof this.onNeedWake === 'function') {
          try { this.onNeedWake() } catch { /* ignore */ }
        }
        const wait = attempt <= 5 ? 15000 : 60000
        if (attempt <= 3 || attempt % 10 === 0) {
          this.log('数据库轮询等待中就绪（第 ' + attempt + ' 次，' + (wait / 1000) + 's 后重试）：' + String(e?.message || e).slice(0, 70))
        }
        setTimeout(() => { void startPoller(attempt + 1) }, 15000)
      }
    }
    void startPoller()
    this.emit('started', { port: this.apiPort, loggedIn: this.loggedIn, self: this.selfWxid, transport: 'wechat-hook' })
    return true
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
          this.log('检测到客户端已退出 → 自动重新拉起（带回调参数）')
          this.loggedIn = false
          this.ready = false
          this._apiDeadSince = 0
          try { this.launchClient() } catch (e) { this.log('拉起失败: ' + String(e?.message || e)) }
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
  // 重要：未登录时调这些接口会把微信弄崩（实测踩过），所以先拦一道
  #guard() {
    if (!this.loggedIn) {
      this.log('未登录，拒绝调用发送接口（未登录时调 API 会导致微信崩溃）')
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
    try { root = await resolveDataRoot(this.api.bind(this)) } catch { /* ignore */ }
    const meta = xmlVideoMeta(xml)
    const tag = `video-${Number(nearTs) || Date.now()}-${Math.random().toString(36).slice(2, 6)}`

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
    // ── 普通图片（type 3）：回调里没有下载地址，走"本地 .dat 解密"这条路 ──
    // 微信把收到的图片以 V2 加密存在
    //   <数据目录>\msg\attach\<md5(群id)>\<年-月>\Img\<md5>[_t|_h].dat
    // 密钥在微信进程内存里（需客户端解密过一次图片）。hook 的 /Decode_Pic 对这个构建失效，
    // 所以我们自己解密（lib/wechat-image.mjs）。
    if (type === 3 && roomId) {
      try {
        const root = await resolveDataRoot(this.api.bind(this))
        const f = findLatestDat(root, roomId, { nearTs: Number(nearTs) || 0, toleranceMs: 6 * 60_000 })
        if (f) {
          let out = decryptDat(f.path, { tag: 'chat' })
          if (!out) {
            // 密钥可能轮换了（换登录/重启后会变）→ 重扫一次内存再试
            this.log('解密失败，尝试重新扫描图片密钥…')
            try { execFileSync(process.env.PYTHON_EXE || 'D:\\Python311\\python.exe', [join(dirname(fileURLToPath(import.meta.url)), 'decode-wechat-image.py'), '--find-key'], { timeout: 300_000, stdio: 'ignore' }) } catch { /* ignore */ }
            out = decryptDat(f.path, { tag: 'chat-retry' })
          }
          if (out) {
            this.log(`本地解密图片成功：${f.name} → ${out}（${Math.round(f.size / 1024)}KB）`)
            return out
          }
          this.log(`本地解密失败（密钥可能失效）：${f.name}`)
        } else {
          this.log('本地没找到这张图对应的 .dat（可能未下载）')
        }
      } catch (e) {
        this.log('本地解密路径异常：' + String(e?.message || e))
      }
    }

    if (!xml) return null
    const attr = (k) => {
      const m = new RegExp(`${k}="([^"]*)"`).exec(xml)
      return m ? m[1].replace(/&amp;/g, '&') : ''
    }
    const cands = type === 47
      ? ['cdnurl', 'cdnthumburl', 'encrypturl']
      : ['cdnbigimgurl', 'cdnmidimgurl', 'cdnthumburl', 'cdnurl']
    const url = cands.map(attr).find((u) => /^https?:\/\//i.test(u))
    if (!url) return null
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'MicroMessenger' }, signal: AbortSignal.timeout(30_000) })
      if (!r.ok) { this.log(`取图失败 HTTP ${r.status}`); return null }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 100) { this.log('取图内容过小，放弃'); return null }
      const head = buf.slice(0, 4)
      const ext = head[0] === 0xff && head[1] === 0xd8 ? 'jpg'
        : head[0] === 0x89 ? 'png'
          : buf.slice(0, 3).toString('latin1') === 'GIF' ? 'gif' : 'bin'
      const dir = join(this.dataDir, 'wechat-media')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${Date.now()}-${type}.${ext}`)
      writeFileSync(file, buf)
      this.log(`取到媒体图：${file}（${Math.round(buf.length / 1024)}KB，${ext}）`)
      return file
    } catch (e) {
      this.log('取图异常：' + String(e?.message || e))
      return null
    }
  }

  /** 群列表：库里读不到，就返回"见过的群"（回调出现过的 + 表情包库记录的） */
  async rooms() {
    if (this.stickers?.items) {
      for (const it of this.stickers.items) {
        for (const rid of it.rooms || []) if (rid && !this._roomCache.has(rid)) this._roomCache.set(rid, rid)
      }
    }
    const out = []
    for (const [roomId, name] of this._roomCache) {
      if (roomId === 'mock-room-1') continue        // mock 模拟群不该出现在真实群列表里
      out.push({ roomId, name: name || roomId, owner: '', members: 0 })
    }
    return out
  }

  history() { return [] }

  status() {
    return {
      loggedIn: this.loggedIn, self: this.selfWxid, selfName: this.selfName,
      port: this.apiPort, cbPort: this.cbPort, transport: 'wechat-hook', ready: this.ready,
      lastError: this.lastError,
      stickers: this.stickers ? this.stickers.stats() : null,
      contacts: this._contactMap.size,
      callbacks: this._cbCount, messages: this._msgCount,
    }
  }
}
