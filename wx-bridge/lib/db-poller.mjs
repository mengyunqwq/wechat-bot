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
   */
  constructor({ api, emit, log, intervalMs = 2500, onReady = null }) {
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
    this.selfWxid = ''       // 机器人自己的 wxid（自动从数据目录名推出来）
    this.stats = { polls: 0, msgs: 0, errors: 0 }
  }

  async q(db, sql, timeout = 20000) {
    const r = await this.api('/QueryDB/execute', { optDbName: db, SQL: sql }, 'POST', timeout)
    if (!r || r.status !== 0) throw new Error(`SQL 失败(${db}): ${r?.desc || 'unknown'} :: ${sql.slice(0, 60)}`)
    return r.data || []
  }

  /** 发现会话表、建立 hash→roomId 映射、记录各表当前最大 local_id */
  async init() {
    // 1) 所有会话表
    const tabs = await this.q('message_0.db', "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
    // 2) hash → wxid（把联系人/群的 username 都算一遍 md5）
    const contacts = await this.q('contact.db', 'SELECT username FROM contact')
    const byHash = new Map()
    for (const c of contacts) {
      const u = String(c.username || '')
      if (u) byHash.set(md5(u), u)
    }
    // 3) 发送者映射：**用 message_0.db 自己的 Name2Id**（不是 contact.db 的那个！
    //    contact.db.Name2Id 的 rowid 是全局联系人编号，跟 real_sender_id 对不上，实测会映射成 weixin/notifymessage）
    const n2i = await this.q('message_0.db', 'SELECT rowid AS rid, user_name FROM Name2Id')
    for (const r of n2i) this.senderMap.set(String(r.rid), String(r.user_name || ''))

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
      this.tables.set(table, { roomId, lastId })
    }
    if (typeof this.onReady === 'function') { try { this.onReady(this.selfWxid) } catch { /* ignore */ } }
    this.log(`数据库轮询就绪：${this.tables.size} 个会话（${unknown} 个未匹配到 wxid）｜发送者映射 ${this.senderMap.size} 条`)
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
    let got = 0
    for (const [table, info] of this.tables) {
      try {
        const rows = await this.q('message_0.db',
          `SELECT local_id, local_type, create_time, real_sender_id, server_id, message_content, source`
          + ` FROM ${table} WHERE local_id > ${info.lastId} ORDER BY local_id ASC LIMIT 30`, 15000)
        if (!rows.length) continue
        for (const row of rows) {
          info.lastId = Math.max(info.lastId, Number(row.local_id || 0))
          const m = this.toEvent(table, info, row)
          if (m) { this.emit(m); got++; this.stats.msgs++ }
        }
      } catch (e) {
        this.stats.errors++
        if (this.stats.errors % 10 === 1) this.log(`轮询失败（${table}）：${String(e?.message || e).slice(0, 120)}`)
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
      _fromDb: true,
    }
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
