#!/usr/bin/env node
/**
 * wx-bridge 的 MCP Server —— 让**任意支持 MCP 的 agent**（Claude Desktop / Cursor / Cline /
 * Windsurf / 自研 agent…）直接操作这个微信机器人。
 *
 * 传输：stdio，换行分隔的 JSON-RPC 2.0（MCP 标准）
 * 后端：连本机 wx-bridge 的 WebSocket（ws://127.0.0.1:17300），不直接碰微信
 *
 * 用法（在 MCP 客户端里配置）：
 *   {
 *     "mcpServers": {
 *       "wechat": { "command": "node", "args": ["D:/微信deepseek/wx-bridge/mcp-server.mjs"] }
 *     }
 *   }
 *
 * 环境变量：
 *   WX_BRIDGE_URL  桥地址，默认 ws://127.0.0.1:17300
 *   WX_DEFAULT_ROOM 默认群（群名或 roomId），多数工具不传 room 时用它
 */
import { WebSocket } from 'ws'
import { createInterface } from 'node:readline'

const BRIDGE_URL = process.env.WX_BRIDGE_URL || 'ws://127.0.0.1:17300'
const DEFAULT_ROOM = process.env.WX_DEFAULT_ROOM || ''

// ── 与桥的 WebSocket 连接（按需重连，请求-应答配对） ──────────────
class Bridge {
  constructor(url) {
    this.url = url
    this.ws = null
    this.seq = 0
    this.waiters = new Map()
    this.connecting = null
    this.lastRooms = []
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      const to = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('连接桥超时：' + this.url)) }, 8000)
      ws.on('open', () => {
        clearTimeout(to)
        this.ws = ws
        this.connecting = null
        ws.send(JSON.stringify({ id: 'mcp-identify', op: 'identify', name: 'wx-mcp-server', pid: process.pid }))
        resolve()
      })
      ws.on('message', (raw) => {
        let m
        try { m = JSON.parse(raw.toString()) } catch { return }
        if (m.t === 'msg' && m.m) this.lastMsg = m.m            // 事件流（可选订阅）
        if (m.t !== 'reply') return
        const w = this.waiters.get(m.id)
        if (w) {
          this.waiters.delete(m.id)
          clearTimeout(w.timer)
          m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || '桥返回失败'))
        }
      })
      ws.on('error', (e) => { clearTimeout(to); this.connecting = null; reject(new Error('桥连接错误：' + e.message)) })
      ws.on('close', () => { this.ws = null; this.connecting = null })
    })
    return this.connecting
  }

  async call(op, args = {}, timeoutMs = 60000) {
    await this.connect()
    const id = 'mcp-' + (++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`桥操作超时（${op}）`)) }, timeoutMs)
      this.waiters.set(id, { resolve, reject, timer })
      try { this.ws.send(JSON.stringify({ id, op, ...args })) } catch (e) { clearTimeout(timer); this.waiters.delete(id); reject(e) }
    })
  }

  /** 把 room（群名或 id）解析成 roomId */
  async resolveRoom(room) {
    const want = String(room || DEFAULT_ROOM || '').trim()
    let rooms = this.lastRooms
    try { rooms = await this.call('rooms'); this.lastRooms = rooms } catch { /* 用缓存 */ }
    const list = Array.isArray(rooms) ? rooms : (rooms?.rooms || [])
    if (!want) {
      if (list.length === 1) return list[0].roomId || list[0].id
      throw new Error('没指定群，且不止一个群。可用群：' + list.map((r) => r.name || r.roomName || r.roomId).join('、'))
    }
    const hit = list.find((r) => (r.roomId || r.id) === want
      || (r.name || r.roomName || '') === want
      || String(r.name || r.roomName || '').includes(want))
    return hit ? (hit.roomId || hit.id) : want
  }
}

const bridge = new Bridge(BRIDGE_URL)

// ── 工具定义（对 agent 暴露的能力） ──────────────────────────────
const TOOLS = [
  {
    name: 'wechat_status',
    description: '查看微信机器人状态：是否登录、连接数、收到的消息数、表情包库大小、所在群列表。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = await bridge.call('status')
      let rooms = []
      try { rooms = await bridge.call('rooms') } catch { /* ignore */ }
      const list = Array.isArray(rooms) ? rooms : (rooms?.rooms || [])
      return { ...s, rooms: list.map((r) => ({ roomId: r.roomId || r.id, name: r.name || r.roomName || '' })) }
    },
  },
  {
    name: 'wechat_list_rooms',
    description: '列出机器人所在的所有群聊/会话。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => bridge.call('rooms'),
  },
  {
    name: 'wechat_read_messages',
    description: '读取某个群最近的消息记录（机器人记忆里的上下文）。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
        limit: { type: 'number', description: '条数，默认 20' },
      },
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      return bridge.call('history', { roomId, limit: Number(a.limit) || 20 })
    },
  },
  {
    name: 'wechat_send_text',
    description: '以机器人身份往群里发一条文字消息。可直接 @ 某人（在文字里写 @昵称 即可）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的文字' },
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
      },
      required: ['text'],
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      return bridge.call('sendText', { roomId, text: String(a.text) })
    },
  },
  {
    name: 'wechat_list_members',
    description: '列出某个群的全部成员及其真实昵称（从微信数据库读，备注优先）。',
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' } },
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      return bridge.call('members', { roomId })
    },
  },
  {
    name: 'wechat_list_stickers',
    description: '查看机器人收藏的表情包库（含标签与使用次数）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '列出前 N 张，默认 15' } },
    },
    run: async (a) => bridge.call('stickers', { limit: Number(a.limit) || 15 }),
  },
  {
    name: 'wechat_send_sticker',
    description: '挑一张表情包发到群里。给了 text 就按语境挑，不给就随机挑一张可发的。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '可选：用来匹配语境的文字' },
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
      },
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      const picked = await bridge.call('pickSticker', { text: String(a.text || ''), roomId, minScore: 0 })
      if (!picked?.id) throw new Error('表情包库里没有可发的（检查来源限制）')
      const sent = await bridge.call('sendSticker', { roomId, stickerId: picked.id })
      return { ...sent, stickerId: picked.id, tags: picked.tags || [] }
    },
  },
  {
    name: 'wechat_generate_sticker',
    description: '用 Agnes 图生图现场生成一张表情包（主体是机器人的固定角色，只换题材/场景），'
      + '生成后入库。题材可以是情绪（大笑/无语/委屈…）或生活活动（吃饭/睡觉/摸鱼…），'
      + '还能加文字气泡（气泡由本地绘制，字一定清楚）。同题材默认复用已生成的。',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '题材：情绪或活动，如 委屈 / 摸鱼 / 吃饭' },
        scene: { type: 'string', description: '可选：具体场景动作，如"瘫在办公椅上刷手机"' },
        bubble: { type: 'string', description: '可选：画面气泡里的字，如"别叫我"' },
        room: { type: 'string', description: '可选：生成后直接发到这个群' },
        force: { type: 'boolean', description: 'true = 强制重画（默认复用同题材）' },
      },
      required: ['subject'],
    },
    run: async (a) => {
      const gen = await bridge.call('genSticker', {
        emotion: String(a.subject),
        extra: String(a.scene || ''),
        bubble: String(a.bubble || ''),
        force: !!a.force,
      }, 240000)
      if (a.room && gen?.stickerId) {
        const roomId = await bridge.resolveRoom(a.room)
        await bridge.call('sendSticker', { roomId, stickerId: gen.stickerId })
      }
      return gen
    },
  },
  {
    name: 'wechat_get_image',
    description: '取群里某个会话最近的一张图片，**自动解密**（微信本地是加密存储的），'
      + '返回可读的图片文件路径（调用方自行识别，识别完可删）。也可传 ts 精确指定某条图片消息的时间。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
        ts: { type: 'number', description: '可选：图片消息的时间戳（毫秒），用于精确匹配' },
      },
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      const file = await bridge.call('fetchMedia', { xml: '', type: 3, roomId, ts: Number(a.ts) || 0 }, 120000)
      if (!file?.file) throw new Error('没取到图片（可能未下载或解密密钥失效）')
      return { file: file.file, note: '这是解密后的临时文件，识别完请删除' }
    },
  },
  {
    name: 'wechat_pat',
    description: '拍一拍群里的某个人（真人小动作）。',
    inputSchema: {
      type: 'object',
      properties: {
        wxid: { type: 'string', description: '对方 wxid（可用 wechat_list_members 查）' },
        room: { type: 'string', description: '群名或 roomId；只有一个群时可留空' },
      },
      required: ['wxid'],
    },
    run: async (a) => {
      const roomId = await bridge.resolveRoom(a.room)
      return bridge.call('pat', { roomId, wxid: String(a.wxid) })
    },
  },
]

// ── JSON-RPC over stdio ──────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'wx-bridge-mcp', version: '1.0.0' },
      instructions: '这是本机微信机器人的控制接口。发消息用 wechat_send_text，'
        + '看群里在聊什么用 wechat_read_messages，认人用 wechat_list_members，'
        + '发表情包用 wechat_send_sticker 或 wechat_generate_sticker。'
        + '注意：机器人自己的拟人节流（回复间隔、频率上限、作息）由 wx-bridge 或 DSH 插件负责，'
        + '直接调 send 会立刻发出去，请自行控制节奏。',
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments || {}
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return replyErr(id, -32602, '未知工具：' + name)
    try {
      const out = await tool.run(args)
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
      return reply(id, { content: [{ type: 'text', text }], isError: false })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '执行失败：' + String(e?.message || e) }], isError: true })
    }
  }
  if (id !== undefined) replyErr(id, -32601, '不支持的方法：' + method)
}

const rl = createInterface({ input: process.stdin })
let inflight = 0
let closing = false

function maybeExit() {
  if (closing && inflight === 0) process.exit(0)
}

rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try { msg = JSON.parse(s) } catch { return }
  inflight++
  handle(msg)
    .catch((e) => {
      if (msg?.id !== undefined) replyErr(msg.id, -32603, String(e?.message || e))
    })
    .finally(() => { inflight--; maybeExit() })
})

// MCP 客户端关闭 stdin → 等正在执行的调用跑完再退（否则调用结果会丢）
rl.on('close', () => {
  closing = true
  maybeExit()
  setTimeout(() => process.exit(0), 15000).unref?.()   // 兜底：最多再等 15 秒
})
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
