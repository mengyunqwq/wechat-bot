/**
 * WCF（WeChatFerry）封装：SDK 生命周期 + 消息归一化 + 发送动作 + 表情包抓取。
 *
 * 关键事实（来自 @wechatferry/core 的实现，别凭猜改）：
 * - `WxInitSDK(debug, port)` 由 sdk.dll 注入微信进程，起 NNG 双端口：
 *     port   = 发指令（RPC）    port+1 = 收消息（推送流，实时）
 * - 微信必须**已启动且已登录**，且版本必须与 sdk.dll 匹配（3.9.12.17 ↔ sdk v39.4.5）。
 * - 附件下载：`wcf.downloadAttach(id, thumb, extra)` 返回 0 后，文件出现在 `extra`（视频在 `thumb`）
 *   指定的本地路径上，需要轮询等待落盘；图片是加密 .dat，走 `decryptImage(extra, dir)`。
 * - 表情包（type 47）不是 agent.downloadFile 支持的类型，必须自己走 downloadAttach。
 */
import { existsSync, statSync, copyFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { WechatferryAgent } from '@wechatferry/agent'
import { WechatMessageType } from '@wechatferry/core'

export const TYPE_NAMES = {
  [WechatMessageType.Text]: 'text',
  [WechatMessageType.Image]: 'image',
  [WechatMessageType.Voice]: 'voice',
  [WechatMessageType.Video]: 'video',
  [WechatMessageType.Emoticon]: 'emoticon',
  [WechatMessageType.App]: 'app',
  [WechatMessageType.File]: 'file',
  [WechatMessageType.SysNotice]: 'sys',
  [WechatMessageType.Sys]: 'sys',
  [WechatMessageType.Recalled]: 'recalled',
  [WechatMessageType.GroupInvite]: 'groupInvite',
  [WechatMessageType.Transfer]: 'transfer',
  [WechatMessageType.RedEnvelope]: 'redEnvelope',
  [WechatMessageType.MiniProgram]: 'miniProgram',
  [WechatMessageType.ShareCard]: 'shareCard',
  [WechatMessageType.Location]: 'location',
}

export function typeName(t) { return TYPE_NAMES[t] || ('type' + t) }

/** 去掉群聊文本里的 @昵称 前缀，得到"人话" */
export function stripMentions(content, selfNames = []) {
  let text = String(content || '')
  text = text.replace(/^(@[^\s\u2005]+[\s\u2005]+)+/u, '')
  for (const n of selfNames) {
    if (!n) continue
    text = text.split('@' + n).join('')
  }
  return text.trim()
}

export class WcfBridge {
  /**
   * @param {object} opts
   * @param {number} [opts.port] SDK 端口（默认 10086）
   * @param {boolean} [opts.debug]
   * @param {(evt:string, payload:any)=>void} [opts.emit] 事件回调
   * @param {object} [opts.stickers] StickerLibrary 实例
   * @param {string} [opts.stickerCtxFile] 语境快照文件（给新收藏的表情打标签用）
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 10086
    this.debug = !!opts.debug
    this.emit = opts.emit || (() => {})
    this.stickers = opts.stickers || null
    this.agent = null
    this.selfWxid = ''
    this.loggedIn = false
    this.lastError = ''
    this._memberCache = new Map()   // roomId -> {at, members, nameMap}
    this._roomCache = new Map()     // roomId -> {at, room}
    this._recentText = new Map()    // roomId -> 最近几条文本（给表情包打语境标签）
    this._msgSeq = 0
  }

  /** 启动 SDK（微信没开/没登录时抛错，由上层重试） */
  start() {
    if (this.agent) return
    const agent = new WechatferryAgent({ keepalive: 30 })
    this.agent = agent

    agent.on('login', (user) => {
      this.loggedIn = true
      this.selfWxid = user?.wxid || agent.wcf.getSelfWxid?.() || ''
      this.emit('login', { self: this.selfWxid, name: user?.name, mobile: user?.mobile })
    })
    agent.on('logout', () => {
      this.loggedIn = false
      this.emit('logout', {})
    })
    agent.on('error', (err) => {
      this.lastError = String(err?.message || err)
      this.emit('error', { message: this.lastError })
    })
    agent.on('message', (msg) => { void this.#onMessage(msg) })

    agent.start()
    this.loggedIn = !!agent.wcf?.isLogin?.()
    this.selfWxid = this.selfWxid || (this.loggedIn ? agent.wcf.getSelfWxid() : '')
    this.emit('started', { port: this.port, loggedIn: this.loggedIn, self: this.selfWxid })
  }

  stop() {
    try { this.agent?.stop() } catch { /* ignore */ }
    this.agent = null
    this.loggedIn = false
  }

  get ok() { return !!this.agent && this.loggedIn }

  isLogin() {
    try { return !!this.agent?.wcf?.isLogin?.() } catch { return false }
  }

  /** 群成员（带昵称映射），缓存 5 分钟 */
  members(roomId, ttlMs = 300_000) {
    const hit = this._memberCache.get(roomId)
    if (hit && Date.now() - hit.at < ttlMs) return hit
    let members = []
    try { members = this.agent?.getChatRoomMembers(roomId) || [] } catch { members = [] }
    const nameMap = {}
    for (const m of members) {
      nameMap[m.userName] = m.displayName || m.nickName || m.remark || m.userName
    }
    const entry = { at: Date.now(), members, nameMap }
    this._memberCache.set(roomId, entry)
    return entry
  }

  nameOf(roomId, wxid) {
    if (!roomId) return wxid
    const { nameMap } = this.members(roomId)
    return nameMap[wxid] || wxid
  }

  /** 自己在群里的显示名（用于识别 @我） */
  selfNamesIn(roomId) {
    const names = []
    if (!roomId) return names
    const { nameMap } = this.members(roomId)
    if (this.selfWxid && nameMap[this.selfWxid]) names.push(nameMap[this.selfWxid])
    try {
      const me = this.agent?.getContactInfo?.(this.selfWxid)
      if (me?.nickName) names.push(me.nickName)
      if (me?.remark) names.push(me.remark)
    } catch { /* ignore */ }
    return [...new Set(names.filter(Boolean))]
  }

  roomName(roomId, ttlMs = 600_000) {
    const hit = this._roomCache.get(roomId)
    if (hit && Date.now() - hit.at < ttlMs) return hit.name
    let name = roomId
    try {
      const info = this.agent?.getChatRoomInfo?.(roomId)
      if (info?.nickName) name = info.nickName
    } catch { /* ignore */ }
    this._roomCache.set(roomId, { at: Date.now(), name })
    return name
  }

  async #onMessage(msg) {
    try {
      const norm = await this.normalize(msg)
      if (!norm) return
      this.emit('msg', norm)
    } catch (e) {
      this.emit('error', { message: 'normalize failed: ' + String(e?.message || e) })
    }
  }

  /** WxMsg → 归一化消息对象 */
  async normalize(msg) {
    const type = msg.type
    const tn = typeName(type)
    const isGroup = !!msg.is_group
    const roomId = isGroup ? msg.roomid : (msg.sender || '')
    const sender = msg.sender || ''
    const content = msg.content || ''

    // 语境快照：给表情包打标签
    const recent = this._recentText.get(roomId) || []
    const context = recent.slice(-4).join(' ')

    let text = content
    let isAtMe = false
    let atAll = false
    const selfNames = isGroup ? this.selfNamesIn(roomId) : []

    if (tn === 'text') {
      atAll = content.includes('@所有人')
      for (const n of selfNames) {
        if (n && content.includes('@' + n)) { isAtMe = true; break }
      }
      text = stripMentions(content, selfNames)
      recent.push(text)
      while (recent.length > 6) recent.shift()
      this._recentText.set(roomId, recent)
    } else if (tn === 'recalled') {
      text = '[撤回了一条消息]'
    } else if (tn === 'emoticon') {
      text = '[表情包]'
    } else if (tn === 'image') {
      text = '[图片]'
    } else if (tn === 'voice') {
      text = '[语音]'
    } else if (tn === 'video') {
      text = '[视频]'
    } else if (tn === 'file') {
      text = '[文件]'
    } else if (tn === 'sys') {
      text = content
    }

    const norm = {
      seq: ++this._msgSeq,
      id: msg.id,
      type,
      typeName: tn,
      ts: msg.ts ? msg.ts * 1000 : Date.now(),
      isSelf: !!msg.is_self,
      isGroup,
      roomId,
      roomName: isGroup ? this.roomName(roomId) : (sender || '私聊'),
      sender,
      senderName: isGroup ? this.nameOf(roomId, sender) : (sender || '私聊'),
      content,
      text,
      isAtMe,
      atAll,
      thumb: msg.thumb,
      extra: msg.extra,
    }

    // 表情包/图片：抓取归档（异步，不阻塞消息分发）
    if (tn === 'emoticon' || tn === 'image') {
      void this.captureSticker(msg, norm, context).then((st) => {
        if (st) this.emit('sticker', { id: st.id, roomId, sender, senderName: norm.senderName, context })
      }).catch((e) => this.emit('error', { message: 'sticker capture: ' + String(e?.message || e) }))
    }

    return norm
  }

  /**
   * 抓取表情包/图片到本地并归档。
   * 表情包走 downloadAttach + 等 extra 落盘；图片走 downloadAttach + decryptImage。
   */
  async captureSticker(msg, norm, context, waitMs = 6000) {
    if (!this.stickers || !this.agent) return null
    const wcf = this.agent.wcf
    let target = ''

    try {
      const rc = wcf.downloadAttach(msg.id, msg.thumb, msg.extra)
      if (rc !== 0) {
        this.emit('error', { message: `downloadAttach rc=${rc} (type=${msg.type})` })
      }
      // 视频走 thumb，其余走 extra
      target = (msg.thumb || '').toLowerCase().endsWith('.mp4') ? msg.thumb : (msg.extra || '')
      const deadline = Date.now() + waitMs
      while (target && Date.now() < deadline) {
        if (existsSync(target) && statSync(target).size > 0) break
        await sleep(250)
      }
    } catch (e) {
      this.emit('error', { message: 'downloadAttach threw: ' + String(e?.message || e) })
    }

    // 图片是加密 .dat → 解密
    let srcPath = target
    if (norm.typeName === 'image') {
      try {
        if (target && existsSync(target)) {
          const dec = wcf.decryptImage(target, this.stickers.filesDir)
          if (dec && existsSync(dec)) srcPath = dec
        }
      } catch (e) {
        this.emit('error', { message: 'decryptImage failed: ' + String(e?.message || e) })
      }
    }

    if (!srcPath || !existsSync(srcPath)) {
      this.emit('sticker-miss', {
        type: msg.type, id: msg.id, thumb: msg.thumb, extra: msg.extra,
      })
      return null
    }
    return this.stickers.add({
      srcPath,
      sender: norm.sender,
      senderName: norm.senderName,
      roomId: norm.roomId,
      context,
      kind: norm.typeName === 'image' ? 'image' : 'emoticon',
    })
  }

  // ── 发送动作 ──────────────────────────────────────────────

  /** 发文本；mentions 为 wxid 数组（@人） */
  sendText(roomId, text, mentions = []) {
    if (!this.agent) throw new Error('SDK 未启动')
    return this.agent.sendText(roomId, text, mentions)
  }

  /** 发图片（本地路径） */
  async sendImage(roomId, filePath) {
    const { FileBox } = await import('file-box')
    return this.agent.sendImage(roomId, FileBox.fromFile(filePath))
  }

  /** 发表情包（本地路径）—— 走 core 的 sendEmotion */
  async sendEmotion(roomId, filePath) {
    const { FileBox } = await import('file-box')
    const rc = await this.agent.wcf.sendEmotion(FileBox.fromFile(filePath), roomId)
    return rc
  }

  /** 发文件 */
  async sendFile(roomId, filePath) {
    const { FileBox } = await import('file-box')
    return this.agent.sendFile(roomId, FileBox.fromFile(filePath))
  }

  /** 拍一拍 */
  pat(roomId, wxid) {
    return this.agent.wcf.sendPatMsg(roomId, wxid)
  }

  /** 撤回自己的消息 */
  revoke(messageId) {
    return this.agent.revokeMsg(messageId)
  }

  /** 转发消息 */
  forward(messageId, roomId) {
    return this.agent.forwardMsg(roomId, messageId)
  }

  rooms() {
    try {
      return (this.agent?.getChatRoomList?.() || []).map((r) => ({
        roomId: r.userName,
        name: r.nickName || r.userName,
        owner: r.ownerUserName,
        members: (r.memberIdList || []).length,
      }))
    } catch { return [] }
  }

  /** 历史消息（最近的），用于冷启动给 agent 喂上下文 */
  history(roomId, limit = 20) {
    try {
      const rows = this.agent.getHistoryMessageList(roomId, (q) => q.orderBy('CreateTime', 'desc').limit(limit))
      return rows.map((r) => ({
        ts: (r.createTime || 0) * 1000,
        isSelf: !!r.isSender,
        sender: r.talkerWxid,
        type: r.type,
        text: r.strContent,
      })).reverse()
    } catch { return [] }
  }

  status() {
    return {
      loggedIn: this.isLogin(),
      self: this.selfWxid,
      port: this.port,
      lastError: this.lastError,
      stickers: this.stickers ? this.stickers.stats() : null,
      rooms: this.rooms().length,
    }
  }
}
