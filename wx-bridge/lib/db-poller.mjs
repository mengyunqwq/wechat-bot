/**
 * 数据库轮询收消息 —— 替代 hook 的"回调推送"。
 *
 * 为什么需要它：
 *   我们自编译的 version.dll 修好了 QueryDB（群成员昵称），但**公开源码里没有回调推送的实现**
 *   （g_CallBack_Url 只赋值、从不使用；git 历史里也从未出现）。官方 release 有这段，但它的 QueryDB 是坏的。
 *   二选一不如绕开：**消息本来就存在数据库里**，直接轮询数据库即可 ——
 *   而且能顺手拿到发送者 wxid → 真实昵称（比回调更全，回调里没有昵称字段）。
 *
 * 产出的事件结构与 hook 回调完全一致，所以桥和插件都不需要改。
 */
import { createHash } from 'node:crypto'
import { decompress as zstdDecompress } from 'fzstd'
import { resolveDataRoot } from './wechat-image.mjs'
import { voiceEnabled, findVoiceFile, decodeVoice, decodeVoiceBytes, xmlVoiceMeta } from './wechat-voice.mjs'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const TYPE_NAMES = {
  1: 'text', 3: 'image', 34: 'voice', 37: 'friend', 42: 'card', 43: 'video',
  47: 'emoticon', 48: 'location', 49: 'link', 50: 'call', 10000: 'system',
}
const MEDIA_TYPES = [3, 43, 47, 48, 49, 34]

const md5 = (s) => createHash('md5').update(String(s)).digest('hex')

/** hex 字符串 → 原文（zstd 自动解压；不是 hex 就原样返回） */
export function decodeContent(raw) {
  if (raw == null) return ''
  const s = String(raw)
  if (!s) return ''
  let buf
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    buf = Buffer.from(s, 'hex')
  } else {
    return s                       // 已经是明文
  }
  if (buf.length > 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      return Buffer.from(zstdDecompress(buf)).toString('utf8')
    } catch {
      return ''
    }
  }
  // 非 zstd：可能是 utf8 明文（含中文时 hex 解出来就是 utf8）
  const asText = buf.toString('utf8')
  return /[\u0000-\u0008\u000e-\u001f]/.test(asText) ? '' : asText
}

export class DbPoller {
  /**
   * @param {object} o
   * @param {(path:string, body:any, method?:string, timeout?:number)=>Promise<any>} o.api  hook HTTP 调用
   * @param {(m:object)=>void} o.emit  收到一条消息
   * @param {(s:string)=>void} o.log
   * @param {number} [o.intervalMs]
   * @param {(path:string,body:any,method?:string,timeout?:number)=>Promise<any>} [o.onReadFail] 读库失败回调（给上层进"禁止发送"窗口用）
   */
  constructor({ api, emit, log, intervalMs = 2500, onReady = null, onReadFail = null }) {
    this.api = api
    this.emit = emit
    this.log = log
    this.intervalMs = intervalMs
    this.tables = new Map()      // table → { roomId, lastId }
    this.senderMap = new Map()   // real_sender_id(rowid) → wxid
    this.seq = 0
    this.stopped = true
    this._timer = null
    this.onReady = onReady
    this.onReadFail = onReadFail
    this.selfWxid = ''       // 机器人自己的 wxid（自动从数据目录名推出来）
    this.stats = { polls: 0, msgs: 0, errors: 0, pauses: 0 }
    // ── 健康度 / 暂停（不健康时**停止轮询**，别拿失败的查询去压微信）──
    //  连续 5 次读失败 → 暂停 60 秒；还失败 → 指数退避，最多 5 分钟。
    //  恢复时**先做一次单表探测**，成功才继续正常轮询。
    this._consecFail = 0        // 连续读失败次数
    this._pauseUntil = 0        // 暂停到什么时候（ms）
    this._pauseMs = 0           // 本次暂停时长（日志用）
    this._backoffMs = 60000     // 下次暂停时长（60s → 120s → 240s → 300s 封顶）
    this._lastReadErr = ''
  }

  /** 当前是否处于"暂停轮询"窗口 */
  paused() { return this._pauseUntil > 0 && Date.now() < this._pauseUntil }

  /** 暂停剩余秒数（0 = 没暂停） */
  pauseLeftSec() { return this.paused() ? Math.ceil((this._pauseUntil - Date.now()) / 1000) : 0 }

  /** 读库失败：连续 5 次 → 暂停 + 指数退避 */
  _noteReadFail(e) {
    this.stats.errors++
    this._consecFail++
    this._lastReadErr = String(e?.message || e)
    if (typeof this.onReadFail === 'function') {
      try { this.onReadFail(this._lastReadErr) } catch { /* ignore */ }
    }
    if (this._consecFail >= 5 && !this.paused()) {
      this._pauseMs = this._backoffMs
      this._pauseUntil = Date.now() + this._pauseMs
      this._backoffMs = Math.min(this._backoffMs * 2, 300000)   // 60s → … → 最多 5 分钟
      this.stats.pauses++
      this.log(`轮询暂停（连续 ${this._consecFail} 次失败，${Math.round(this._pauseMs / 1000)} 秒后重试）：`
        + this._lastReadErr.slice(0, 120))
    }
  }

  /** 读库成功：清零失败计数，出暂停窗口时打"轮询恢复" */
  _noteReadOk() {
    if (this._consecFail > 0 || this._pauseUntil > 0) {
      this._consecFail = 0
      this._pauseUntil = 0
      this._backoffMs = 60000          // 恢复后重置退避
      this.log('轮询恢复')
    }
  }

  async q(db, sql, timeout = 20000) {
    // ── 分片自动发现 ────────────────────────────────────────────────
    // ⚠️ 实测坑：微信的消息库是【分片】的（message_0.db / message_1.db / …）。
    //    哪个分片存在取决于微信自己（我们把 message_0.db 删掉后，它就把消息写到 message_1.db 了）。
    //    以前这里写死 'message_0.db' → 一旦微信换了分片，桥就永远读不到消息（静默失聪）。
    //    现在：调用方仍写 'message_0.db' 当"逻辑名"，这里透明解析成真实存在的那个分片。
    if (db === 'message_0.db') { db = await this.resolveShard(timeout); if (!db) throw new Error('消息库分片暂不可用（客户端句柄还没挂载）') }
    const r = await this.api('/QueryDB/execute', { optDbName: db, SQL: sql }, 'POST', timeout)
    // status 一定要带上：21 = SQLITE_MISUSE（句柄已关闭）、1 = SQL 写错/表不存在、5/6 = 忙
    if (!r || r.status !== 0) throw new Error(`SQL 失败(${db}) status=${r?.status}: ${r?.desc || 'unknown'} :: ${sql.slice(0, 60)}`)
    return r.data || []
  }

  /**
   * 解析"消息库真实分片"：从 message_0.db 起依次试，返回第一个能列出 Msg_ 表的。
   * 结果缓存 30 秒（避免每次查询都探测）；探测失败就退回缓存的/默认值，绝不抛。
   */
  async resolveShard(timeout = 20000) {
    const now = Date.now()
    if (this._shard && now - (this._shardAt || 0) < 30_000) return this._shard
    // ★ 2026-10-21：先问 hook「到底有哪些库名」，只探测真实存在的分片。
    //   原因：查不存在的 message_0.db 会让 hook 缓存一个坏句柄，之后连 message_1.db 也读不了
    //   （实测：桥每次重启探测 message_0.db 之后就整库读不到，得重启微信才能恢复）。
    let shardNames = []
    try {
      const dd = await this.api('/QueryDB/debug', null, 'GET', 6000)
      const all = Array.isArray(dd?.dbs) ? dd.dbs : []
      shardNames = all.map((x) => x?.dbName).filter((n) => n && /^message_\d+\.db$/.test(n))
    } catch { /* 拿不到就退回盲试 */ }
    if (shardNames.length) {
      for (const name of shardNames) {
        try {
          const r = await this.api('/QueryDB/execute',
            { optDbName: name, SQL: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'" },
            'POST', Math.min(timeout, 10000))
          if (r && r.status === 0 && Number((r.data || [])[0]?.n) > 0) {
            if (this._shard !== name) this.log(`消息库分片：${name}（${Number((r.data || [])[0].n)} 张会话表）`)
            this._shard = name; this._shardAt = now
            return name
          }
        } catch { /* 试下一个 */ }
      }
    }
    // ★ 2026-10-21：探测不到就【不要盲试】message_0/1/2/3.db
    //   盲试不存在的库会让 hook 缓存坏句柄，之后连正确的分片也读不了（实测整库失聪）。
    //   这里返回 null，让调用方当作「暂时读不到」重试。
    if (shardNames.length) this.log(`消息库分片探测失败（候选 ${shardNames.join(",")}），下次再试`)
    return null
  }

  /** 发现会话表、建立 hash→roomId 映射、记录各表当前最大 local_id */
  async init() {
    // 1) 所有会话表
    const tabs = await this.q('message_0.db', "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
    // 2) hash → wxid（把联系人/群的 username 都算一遍 md5）
    // ⚠️ 这一步【必须可失败】：contact.db 有时拿不到句柄（微信懒加载 / 刚重启），
    //    而它只用来把 hash 映射成 wxid。以前它是硬失败 → init() 抛错 → 轮询起不来。
    // ⚠️ 更严重的坑（实测）：contact.db 拿不到时，若映射表为空，
    //    roomId 会退化成"发送者 wxid" → 【群里被叫，却私聊回复】✗✗
    //    → 所以必须用 session.db 兜底（它列着所有会话的 username，不依赖 contact.db）。
    const byHash = new Map()
    // ── ★ 映射持久化（磁盘）───────────────────────────────────────────────
    //  ⚠️ 实测：contact.db / session.db 会被微信【反复卸载】（懒加载），
    //  映射表一空，table→roomId 就退化成"发送者 wxid"，
    //  于是【群里被叫、却私聊回复】（2026-10-20 用户实际踩到）。
    //  所以把映射写盘：DB 读不到时用上次的，读得到就更新。
    const MAP_FILE = process.cwd() + '/../data/table-map.json'
    try {
      const fs = await import('node:fs')
      const saved = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
      for (const [h, u] of Object.entries(saved || {})) if (h && u) byHash.set(h, u)
      if (byHash.size) this.log(`会话映射：从磁盘缓存载入 ${byHash.size} 条（DB 不可用时的保底）`)
    } catch { /* 没有缓存就算了 */ }
    try {
      const contacts = await this.q('contact.db', 'SELECT username FROM contact')
      for (const c of contacts) {
        const u = String(c.username || '')
        if (u) byHash.set(md5(u), u)
      }
    } catch (e) {
      this.log(`联系人库暂不可用（${String(e?.message || e).slice(0, 60)}）→ 改用 session.db 兜底`)
    }
    if (byHash.size === 0) {
      // 兜底：session.db 的 SessionTable 里有全部会话（群 + 个人），足够算出 hash→roomId
      for (const db of ['session.db', 'contact.db']) {
        try {
          const rs = await this.q(db, 'SELECT username FROM SessionTable')
          for (const r of rs) {
            const u = String(r.username || '')
            if (u) byHash.set(md5(u), u)
          }
          if (byHash.size > 0) { this.log(`会话映射：用 ${db} 兜底成功（${byHash.size} 条）`); break }
        } catch { /* 换下一个 */ }
      }
      if (byHash.size === 0) this.log('会话映射为空（contact.db / session.db / 磁盘缓存 都不可用）→ roomId 会退化成发送者')
    }
    // 把映射写回磁盘（下次 contact.db 被卸载时还能用 → 避免群消息被当成私聊）
    if (byHash.size > 0) {
      try {
        const fs = await import('node:fs')
        const dir = process.cwd() + '/../data'
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(MAP_FILE, JSON.stringify(Object.fromEntries(byHash)), 'utf8')
        this.log(`会话映射：已缓存 ${byHash.size} 条到磁盘`)
      } catch (e) { this.log('会话映射缓存写入失败：' + String(e?.message || e).slice(0, 80)) }
    }
    // 3) 发送者映射：**用消息库自己的 Name2Id**（不是 contact.db 的那个！）
    //    contact.db.Name2Id 的 rowid 是全局联系人编号，跟 real_sender_id 对不上，实测会映射成 weixin/notifymessage）
    try {
      const n2i = await this.q('message_0.db', 'SELECT rowid AS rid, user_name FROM Name2Id')
      for (const r of n2i) this.senderMap.set(String(r.rid), String(r.user_name || ''))
    } catch (e) {
      this.log(`Name2Id 暂不可用（${String(e?.message || e).slice(0, 60)}）→ 发送者退化为 id，轮询照常`)
    }

    // 4) 自己的 wxid：从数据目录名 wxid_xxx_hash 里取（用于标记 isSelf，避免它回自己）
    if (!this.selfWxid) {
      try {
        const root = await this.api('/QueryDB/execute',
          { optDbName: 'contact.db', SQL: 'PRAGMA database_list' }, 'POST', 20000)
        const file = String(root?.data?.[0]?.file || '')
        const m = file.match(/xwechat_files[\\/](wxid_[0-9a-z]+)_/i)
        if (m) this.selfWxid = m[1]
      } catch { /* ignore */ }
    }

    this.tables.clear()
    let unknown = 0
    for (const t of tabs) {
      const table = String(t.name || '')
      const hash = table.replace(/^Msg_/, '')
      const roomId = byHash.get(hash) || ''
      if (!roomId) unknown++
      let lastId = 0
      try {
        const mx = await this.q('message_0.db', `SELECT COALESCE(MAX(local_id),0) AS m FROM ${table}`)
        lastId = Number(mx[0]?.m || 0)
      } catch { /* ignore */ }
      // 必须保证是有限数字：坏值会让 pollTableOnce 的 SQL 直接 prepare 失败（见那里的注释）
      if (!Number.isFinite(lastId) || lastId < 0) lastId = 0
      this.tables.set(table, { roomId, lastId })
    }
    if (typeof this.onReady === 'function') { try { this.onReady(this.selfWxid) } catch { /* ignore */ } }
    this.log(`数据库轮询就绪：${this.tables.size} 个会话（${unknown} 个未匹配到 wxid）｜发送者映射 ${this.senderMap.size} 条`)
    // 关键：0 个会话**不算成功** —— 微信会把闲置的数据库关掉，这时列表就是空的。
    // 以前把它当成功返回，轮询器便空转、永不重试 → 永久失聪（实测就是"不理我"）。
    // 抛错让它走重试；重试到第 4 次会触发 onNeedWake（机器人自己发一句把库唤醒）。
    if (this.tables.size === 0) {
      throw new Error('没找到任何会话表（数据库可能还没打开，等唤醒后重试）')
    }
    return this.tables.size
  }

  /**
   * 检索历史消息 —— 长记忆的"提起了就查"。
   *
   * 数据来源就是**微信自己的数据库**（不用另建库：历史本来就在里面）。
   * 关键词匹配在 JS 里做 —— 消息内容是 hex/zstd 压缩的，SQL LIKE 匹配不到。
   *
   * @param {string} roomId  群/会话 id
   * @param {string} query   关键词（空格/逗号分隔多个，任一命中即可）；空串 = 只要最近的
   * @param {number} limit   最多返回多少条
   * @param {number} scan    最多回溯多少条原始消息（越大越慢，默认 800）
   */
  async searchMessages(roomId, query, limit = 20, scan = 800) {
    let table = ''
    for (const [t, info] of this.tables) {
      if (info.roomId === roomId) { table = t; break }
    }
    if (!table) {
      // 兜底①：直接用 md5(roomId) 拼表名（不依赖 hash→roomId 映射 —— 映射可能因版本差异对不上）
      const guess = `Msg_${md5(roomId)}`
      if (this.tables.has(guess)) {
        table = guess
      } else {
        // 兜底②：表可能存在但没登记，问一次数据库
        try {
          const r = await this.q('message_0.db',
            `SELECT name FROM sqlite_master WHERE type='table' AND name='${guess}'`)
          if (r.length) table = guess
        } catch { /* ignore */ }
      }
    }
    if (!table) {
      const known = [...this.tables.values()].map((v) => v.roomId).filter(Boolean)
      throw new Error('没找到这个会话的表；已知会话：' + known.join(', ') + '；本表名猜测：' + `Msg_${md5(roomId)}`)
    }
    const n = Math.max(50, Math.min(3000, Number(scan) || 800))
    const rows = await this.q('message_0.db',
      'SELECT local_id, local_type, create_time, real_sender_id, message_content, source'
      + ` FROM ${table} ORDER BY local_id DESC LIMIT ${n}`, 30000)
    const kws = String(query || '').trim().split(/[\s,，、]+/).filter(Boolean)
    const out = []
    for (const r of rows) {
      const text = decodeContent(r.message_content)
      const xml = decodeContent(r.source)
      const hay = text + ' ' + xml
      if (kws.length && !kws.some((k) => hay.includes(k))) continue
      const wxid = this.senderMap.get(String(r.real_sender_id)) || ''
      let ts = Number(r.create_time) || 0
      if (ts && ts < 1e12) ts *= 1000          // 秒 → 毫秒（不同版本存的不一样）
      out.push({
        localId: Number(r.local_id) || 0,
        ts,
        sender: wxid,
        senderName: wxid === this.selfWxid ? '我' : (wxid || '未知'),
        isSelf: wxid === this.selfWxid,
        text: String(text || '').slice(0, 200),
      })
      if (out.length >= limit) break
    }
    return out
  }

  /** 轮询一轮 */
  async tick() {
    if (this.stopped) return 0

    // ── 暂停窗口内：一次查询都不发（不拿失败查询去压微信）──────────────
    if (this.paused()) return 0

    // ── 暂停到点了 → 先做**一次单表探测**，成功才回到正常轮询 ──────────
    if (this._pauseUntil > 0) {
      this._pauseUntil = 0
      try {
        await this.q('message_0.db', 'SELECT COUNT(*) AS c FROM sqlite_master', 10000)
        this._noteReadOk()                       // 会打"轮询恢复"
      } catch (e) {
        this._pauseMs = this._backoffMs
        this._pauseUntil = Date.now() + this._pauseMs
        this._backoffMs = Math.min(this._backoffMs * 2, 300000)
        this.stats.pauses++
        this.log(`轮询暂停（探测仍失败，${Math.round(this._pauseMs / 1000)} 秒后重试）：`
          + String(e?.message || e).slice(0, 120))
        return 0
      }
    }

    // ── 每 5 分钟重扫会话表（防"拿着过期列表静默空转"）──────────────
    // 微信会重建/更换数据库文件；轮询器一旦拿着过期的表列表，就会一直空转，
    // 日志还显示"就绪"，但一条消息都收不到（实测踩过）。
    {
      const now = Date.now()
      if (!this._lastReinitAt || now - this._lastReinitAt > 300000) {
        this._lastReinitAt = now
        const oldIds = new Map()
        for (const [t, info] of this.tables) oldIds.set(t, info.lastId)
        try {
          const n = await this.init()
          // 同表沿用旧进度，避免把这段时间的消息漏掉
          for (const [t, info] of this.tables) {
            const old = oldIds.get(t)
            if (old !== undefined && old < info.lastId) info.lastId = old
          }
          this.log(`已重扫会话表：${n} 个会话（防止过期列表空转）`)
        } catch (e) {
          this.log('重扫会话表失败（继续按原列表轮询）：' + String(e?.message || e))
        }
      }
    }


    if (this.stopped) return 0
    let got = 0
    for (const [table, info] of this.tables) {
      if (this.paused()) break                    // 本轮中途进入暂停 → 立刻收手
      try {
        got += await this.pollTableOnce(table, info)
      } catch (e) {
        if (this.stats.errors % 10 === 1) this.log(`轮询失败（${table}）：${String(e?.message || e).slice(0, 120)}`)
        // 失败计数 / 暂停判定由 pollTableOnce 里的 _noteReadFail 负责（那里知道是不是"读失败"）
      }
    }
    // 每轮只要成功读到数据库，就刷新登录状态：
    // 登录标志会被 hook 的 login/logout 事件重置，而"能读到库"才是最强证据
    if (got > 0 || this.tables.size > 0) {
      if (typeof this.onReady === "function") { try { this.onReady(this.selfWxid) } catch { /* ignore */ } }
    }
    this.stats.polls++
    return got
  }

  /**
   * 读**一张表**的新消息并发事件（tick 与 pollRoom 共用同一套游标与读法）。
   *
   * 同表串行：tick（每 2.5s）与"推送通知触发的 pollRoom"可能同时进来，
   * 两边都读 `local_id > lastId` 会把同一段消息发两遍（插件虽按 msgid 去重，但重复事件没意义）
   * → 用 in-flight 标记让后到的那次直接返回 0，由先到的那次负责。
   *
   * @returns {Promise<number>} 本次取到几条
   */
  async pollTableOnce(table, info) {
    if (!this._inflight) this._inflight = new Map()
    if (this._inflight.has(table)) return 0          // 该表已有一次读取在跑 → 让那一次负责
    this._inflight.set(table, true)
    try {
      // ⚠️ 实测坑：info.lastId 一旦变成 undefined/NaN，拼进 SQL 就是
      //    `WHERE local_id > undefined` → sqlite3_prepare failed → 该表**永久读不出消息**
      //    （实测症状：机器人完全不回复，日志每 5 秒一条"轮询失败"）。
      //    这里强制收敛成有限数字，顺手把坏值修回 0。
      let cur = Number(info.lastId)
      if (!Number.isFinite(cur) || cur < 0) { cur = 0; info.lastId = 0 }
      let rows
      try {
        rows = await this.q('message_0.db',
          `SELECT local_id, local_type, create_time, real_sender_id, server_id, message_content, source`
          + ` FROM ${table} WHERE local_id > ${cur} ORDER BY local_id ASC LIMIT 30`, 15000)
      } catch (e) {
        // 读失败：记账（连续 5 次 → 上层暂停轮询 + 桥侧进"禁止发送"窗口）
        this._noteReadFail(e)
        throw e
      }
      this._noteReadOk()            // 读到了（哪怕 0 条）就是健康证据
      if (!rows.length) return 0
      let got = 0
      for (const row of rows) {
        info.lastId = Math.max(Number(info.lastId) || 0, Number(row.local_id || 0))
        const m = this.toEvent(table, info, row)
        if (m) {
          // 语音（34）：音频是磁盘文件，先旁路定位+解码成 16k WAV（失败只记日志）
          await this.enrichVoice(m)
          this.emit(m); got++; this.stats.msgs++
        }
      }
      return got
    } finally {
      this._inflight.delete(table)
    }
  }

  /**
   * **立刻**轮询单个会话 —— 给 hook 的"写库通知"用（推送通道）。
   *
   * 为什么这才是"根治聋窗"的点：通知来自 hook 的 step 探针，触发那一刻微信刚写完库、
   * **库必然是开着的** —— 不用等下一个 2.5s tick，也不会撞上"库没打开"的空窗。
   * 与 tick 共用同一套游标（info.lastId）+ 同表串行锁 → 不会重复发消息、不会漏。
   *
   * @param {string} roomId
   * @returns {Promise<number>} 取到几条（0 = 没有新消息 / 表还没登记）
   */
  async pollRoom(roomId) {
    if (!roomId) return 0
    let hit = null
    for (const [t, info] of this.tables) {
      if (info.roomId === roomId) { hit = [t, info]; break }
    }
    if (!hit) {
      // 兜底：直接用 md5(roomId) 拼表名（hash→roomId 映射可能因版本差异对不上）
      const guess = `Msg_${md5(roomId)}`
      if (this.tables.has(guess)) hit = [guess, this.tables.get(guess)]
    }
    if (!hit) return 0
    return this.pollTableOnce(hit[0], hit[1])
  }

  /** 数据库行 → 与 hook 回调一致的消息事件 */
  toEvent(table, info, row) {
    const type = Number(row.local_type || 0)
    const content = decodeContent(row.message_content)
    const xml = decodeContent(row.source)
    const roomId = info.roomId || ''
    const isGroup = roomId.endsWith('@chatroom')
    const sender = this.senderMap.get(String(row.real_sender_id)) || ''
    const ts = Number(row.create_time || 0) * 1000
    const text = type === 1 ? content : (type === 47 ? '[表情]' : type === 3 ? '[图片]' : `[${TYPE_NAMES[type] || type}]`)
    if (!content && !xml) return null
    return {
      seq: ++this.seq,
      id: String(row.server_id || row.local_id || ''),
      localId: Number(row.local_id) || 0,   // 语音要拿它去 media_0.db 的 VoiceInfo 取音频（同一个值）
      type,
      typeName: TYPE_NAMES[type] || String(type),
      ts,
      isSelf: !!this.selfWxid && sender === this.selfWxid,   // 自己发的必须标出来，否则它会回自己
      isGroup,
      roomId: isGroup ? roomId : (roomId || sender),
      roomName: roomId,
      sender,
      senderName: sender,
      content,
      text,
      isAtMe: /@(蓝色大肥鱼|大肥鱼|肥鱼|蓝鱼)/.test(content),
      atAll: content.includes('@所有人'),
      xml: MEDIA_TYPES.includes(type) ? (content || xml) : '',
      // 语音（34）：音频**不在数据库里**（DB 里只有 368B 的 XML 元数据），是磁盘文件。
      // 由 enrichVoice() 在发事件前异步定位+解码，成功后填这里；拿不到就保持空串
      // → 插件侧照旧走 [语音] 降级（语音处理是纯旁路，绝不阻塞消息）。
      voiceWav: '',
      _fromDb: true,
    }
  }

  /**
   * 语音（type 34）旁路：拿到音频 → 解码成 ASR 硬要求格式（16k/单声道/PCM16 WAV）
   * → 挂到事件的 voiceWav 上。
   *
   * **主路是查库**（2026-10-18 真机确认）：音频不在文件系统里，在 `media_0.db` 的
   * `VoiceInfo.voice_data`（BLOB，hook 返回 hex）。磁盘那条路留作兜底（老逻辑不动）。
   *
   * 为什么不写在 toEvent 里：查库/解码都是异步的（还要起 Python 子进程），而 toEvent 是同步的，
   * 且被 hook 的推送通道复用。放这里，事件结构与原字段一个不动，只是多一个 voiceWav。
   *
   * **所有失败都只记日志**：库里没有、解码失败、V2 密钥失效 → 事件照旧发，text 仍是 [语音]。
   * 开关：WECHAT_VOICE=0 关闭。
   */
  async enrichVoice(m) {
    if (!m || Number(m.type) !== 34) return m
    if (!voiceEnabled()) return m
    const tag = `voice-${m.id || 'noid'}-${m.ts || 0}`
    try {
      // ── ① 主路：media_0.db / VoiceInfo.voice_data（用 local_id 关联消息）──
      let blob = null
      try {
        blob = await this.fetchVoiceBlob(m.localId, m.roomId)
      } catch (e) {
        this.log('语音：查 VoiceInfo 失败（继续走磁盘兜底）：' + String(e?.message || e).slice(0, 160))
      }
      if (blob && blob.length) {
        // XML 的 length 属性 = voice_data 总字节数（含 1 字节前缀）→ 顺手校验，不符只记日志
        const meta = xmlVoiceMeta(m.xml)
        this.log(`语音：VoiceInfo 命中 ${blob.length} 字节（local_id=${m.localId}）`
          + (meta.length ? `｜XML length=${meta.length}${meta.length === blob.length ? ' ✓一致' : ' ✗不一致'}`
            : '')
          + (meta.voicelength ? `｜时长约 ${(meta.voicelength / 1000).toFixed(1)}s` : ''))
        const r = decodeVoiceBytes(blob, { tag, log: (s) => this.log(s) })
        if (r?.wav) { m.voiceWav = r.wav; return m }
        this.log('语音：库里的 blob 没解出 WAV（继续走磁盘兜底）')
      } else {
        this.log(`语音：VoiceInfo 里没有 local_id=${m.localId} 的音频（可能没同步/已被清理）`)
      }

      // ── ② 兜底：磁盘（老逻辑：按群 hash+月份 / mtime ±30 分钟找）──
      if (!this._voiceRoot) this._voiceRoot = await resolveDataRoot(this.api.bind(this))
      const root = this._voiceRoot
      if (!root) {
        this.log('语音：拿不到微信数据根（PRAGMA database_list 无返回），跳过磁盘兜底')
        return m
      }
      const f = findVoiceFile(root, m.roomId, { nearTs: Number(m.ts) || 0, log: (s) => this.log(s) })
      if (!f) return m
      const r = decodeVoice(f.path, { tag, log: (s) => this.log(s) })
      if (r?.wav) m.voiceWav = r.wav
    } catch (e) {
      this.log('语音处理异常（不影响消息，照旧按 [语音] 走）：' + String(e?.message || e).slice(0, 200))
    }
    return m
  }

  /**
   * 从 `media_0.db` 的 `VoiceInfo` 取一条语音的音频字节。
   *
   * 实测结构：`VoiceInfo(chat_name_id, create_time, local_id, svr_id, voice_data, data_index)`
   *   - `local_id` 与消息表 `Msg_<hash>.local_id` **同一个值**（这就是关联键）
   *   - `chat_name_id` = media_0.db **自己的** `Name2Id.rowid`，其 `user_name` 就是会话 id
   *     （每个会话表的 local_id 是独立自增的，所以必须带上 chat_name_id 才不会串群）
   *   - `voice_data` 是 BLOB，hook 把它返回成 **hex 字符串** → 还原成字节
   *
   * @returns {Buffer|null} 取不到返回 null（调用方降级）
   */
  async fetchVoiceBlob(localId, roomId) {
    const lid = Number(localId) || 0
    if (!lid) return null
    let chatId = 0
    if (roomId) {
      const esc = String(roomId).replace(/'/g, "''")
      const r = await this.q('media_0.db', `SELECT rowid AS rid FROM Name2Id WHERE user_name = '${esc}' LIMIT 1`, 20000)
      chatId = Number(r?.[0]?.rid || 0)
    }
    const where = chatId ? `chat_name_id = ${chatId} AND local_id = ${lid}` : `local_id = ${lid}`
    const rows = await this.q('media_0.db',
      `SELECT voice_data FROM VoiceInfo WHERE ${where} ORDER BY create_time DESC LIMIT 1`, 30000)
    const v = rows?.[0]?.voice_data
    if (v == null) return null
    const s = String(v)
    if (!s) return null
    // hook 把 blob 转成 hex；万一某版本直接给原始二进制串，就按 latin1 还原
    const isHex = s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)
    return isHex ? Buffer.from(s, 'hex') : Buffer.from(s, 'latin1')
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    const loop = async () => {
      if (this.stopped) return
      try { await this.tick() } catch { /* 已在 tick 内记 */ }
      if (!this.stopped) this._timer = setTimeout(loop, this.intervalMs)
    }
    this._timer = setTimeout(loop, this.intervalMs)
    this.log(`数据库轮询已启动（每 ${this.intervalMs}ms 一次）`)
  }

  stop() {
    this.stopped = true
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
  }
}
