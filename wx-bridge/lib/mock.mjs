/**
 * Mock 桥 —— 没有微信登录也能把整条链路跑通。
 *
 * 为什么需要它：真实注入要等账号/扫码，而"拟人策略 + 表情包 + 限流 + LLM"这些逻辑
 * 完全可以在模拟群聊里先调好。MockBridge 与 WcfBridge 对外接口一致，插件无需感知差异。
 *
 * 它会：按剧本在群里发言（含表情包）→ 收到我们的回复后偶尔接话 → 生成若干 PNG 表情包
 * 让表情包库有真实素材。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

// ── 极简 PNG 编码器（只为造 mock 表情包，零依赖）────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 生成纯色 + 斜条纹 PNG */
export function makePng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      const stripe = ((x + y) % 24) < 12
      raw[o++] = stripe ? r : Math.min(255, r + 40)
      raw[o++] = stripe ? g : Math.min(255, g + 40)
      raw[o++] = stripe ? b : Math.min(255, b + 40)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SCRIPT = [
  { who: 'u_laowang', name: '老王', text: '今晚谁打游戏，缺一个' },
  { who: 'u_xiaomei', name: '小美', text: '我不打，我要早睡' },
  { who: 'u_aqiang', name: '阿强', text: '我我我，几点开始', sticker: 0 },
  { who: 'u_laowang', name: '老王', text: '十点吧，先吃饭' },
  { who: 'u_xiaomei', name: '小美', text: '你们天天打游戏，眼睛不要了？', sticker: 1 },
  { who: 'u_aqiang', name: '阿强', text: '哈哈哈笑死', sticker: 2 },
  { who: 'u_laowang', name: '老王', text: '@{me} 你在干嘛呢' },
]

export class MockBridge {
  constructor(opts = {}) {
    this.emit = opts.emit || (() => {})
    this.stickers = opts.stickers || null
    this.dataDir = opts.dataDir || join(process.cwd(), 'data')
    this.roomId = 'mock-room-1'
    this.roomName = '摸鱼群（模拟）'
    this.selfWxid = 'u_me'
    this.selfName = '我'
    this.members = [
      { userName: 'u_me', displayName: this.selfName },
      { userName: 'u_laowang', displayName: '老王' },
      { userName: 'u_xiaomei', displayName: '小美' },
      { userName: 'u_aqiang', displayName: '阿强' },
    ]
    this._seq = 0
    this._timers = []
    this._stickerFiles = []
    this._scriptIdx = 0
    this.sent = []
    this.loggedIn = true
    this.autoChat = opts.autoChat !== false
  }

  start() {
    mkdirSync(join(this.dataDir, 'mock-stickers'), { recursive: true })
    const colors = [[255, 120, 120], [120, 200, 255], [255, 220, 120], [160, 255, 170]]
    this._stickerFiles = colors.map((c, i) => {
      const p = join(this.dataDir, 'mock-stickers', `mock-${i}.png`)
      if (!existsSync(p)) writeFileSync(p, makePng(160, 160, c))
      // 塞进表情包库（模拟"群友发过这些表情"）
      this.stickers?.add({
        srcPath: p, sender: 'u_' + i, senderName: '群友' + i,
        roomId: this.roomId, context: ['哈哈 笑死', '无语 服了', '晚安 睡了', '打游戏 开黑'][i],
        kind: 'image',
      })
      return p
    })
    this.emit('started', { mock: true, port: 0, loggedIn: true, self: this.selfWxid })
    this.emit('login', { self: this.selfWxid, name: this.selfName })
    if (this.autoChat) this.#scheduleScript()
  }

  #scheduleScript() {
    const tick = () => {
      const step = SCRIPT[this._scriptIdx % SCRIPT.length]
      this._scriptIdx++
      this.#emitMsg({
        who: step.who, name: step.name,
        text: step.text.replace('{me}', this.selfName),
        sticker: step.sticker != null ? this._stickerFiles[step.sticker % this._stickerFiles.length] : null,
      })
      const wait = 12_000 + Math.random() * 10_000
      this._timers.push(setTimeout(tick, wait))
    }
    this._timers.push(setTimeout(tick, 800))
  }

  #emitMsg({ who, name, text, sticker, isSelf = false }) {
    const base = {
      seq: ++this._seq,
      id: 'mock-' + Date.now() + '-' + this._seq,
      ts: Date.now(),
      isSelf,
      isGroup: true,
      roomId: this.roomId,
      roomName: this.roomName,
      sender: who,
      senderName: name,
      isAtMe: text.includes('@' + this.selfName),
      atAll: text.includes('@所有人'),
      content: text,
      text,
    }
    if (sticker) {
      const m = { ...base, type: 3, typeName: 'image', text: '[图片]', content: '[图片]', extra: sticker, thumb: sticker }
      this.emit('msg', m)
      const st = this.stickers?.add({
        srcPath: sticker, sender: who, senderName: name, roomId: this.roomId,
        context: text, kind: 'image',
      })
      if (st) this.emit('sticker', { id: st.id, roomId: this.roomId, sender: who, senderName: name, context: text })
    } else {
      this.emit('msg', { ...base, type: 1, typeName: 'text' })
    }
  }

  stop() {
    for (const t of this._timers) clearTimeout(t)
    this._timers = []
  }

  isLogin() { return true }
  get ok() { return true }

  sendText(roomId, text, mentions = []) {
    this.sent.push({ op: 'text', roomId, text, mentions, at: Date.now() })
    this.emit('sended', { op: 'text', roomId, text })
    // 模拟群里有人接话（约 35% 概率），让"多轮对话"可测
    if (Math.random() < 0.35) {
      const replies = ['哈哈哈', '有道理', '你说得对', '嗯嗯', '真的假的', '笑死我了']
      const who = this.members[1 + Math.floor(Math.random() * 3)]
      this._timers.push(setTimeout(() => {
        this.#emitMsg({ who: who.userName, name: who.displayName, text: replies[Math.floor(Math.random() * replies.length)] })
      }, 2500 + Math.random() * 3000))
    }
    return 0
  }

  async sendImage(roomId, filePath) {
    this.sent.push({ op: 'image', roomId, filePath, at: Date.now() })
    this.emit('sended', { op: 'image', roomId, filePath })
    return 0
  }

  async sendEmotion(roomId, filePath) {
    this.sent.push({ op: 'emotion', roomId, filePath, at: Date.now() })
    this.emit('sended', { op: 'emotion', roomId, filePath })
    return 0
  }

  async sendFile(roomId, filePath) {
    this.sent.push({ op: 'file', roomId, filePath, at: Date.now() })
    return 0
  }

  pat(roomId, wxid) {
    this.sent.push({ op: 'pat', roomId, wxid, at: Date.now() })
    this.emit('sended', { op: 'pat', roomId, wxid })
    return 1
  }

  revoke(id) { this.sent.push({ op: 'revoke', id, at: Date.now() }); return 0 }
  forward(id, roomId) { this.sent.push({ op: 'forward', id, roomId, at: Date.now() }); return 1 }

  rooms() {
    return [{ roomId: this.roomId, name: this.roomName, owner: 'u_laowang', members: this.members.length }]
  }

  members0(roomId) {
    return { members: this.members, nameMap: Object.fromEntries(this.members.map((m) => [m.userName, m.displayName])) }
  }

  membersOf(roomId) { return this.members }

  history() { return [] }

  status() {
    return {
      loggedIn: true, mock: true, self: this.selfWxid, port: 0, lastError: '',
      stickers: this.stickers ? this.stickers.stats() : null,
      rooms: 1, sent: this.sent.length,
    }
  }
}
