/**
 * 托管模式 —— 让"别的 agent"也能享受桥的拟人行为。
 *
 * 问题：外部 agent（Cursor/Claude/自研）只会"说什么"，不会做"像不像人"：
 *   回复间隔、频率上限、作息、防重复、防追问、打字延迟、拆条、长期记忆。
 * 做法：这些统统交给桥；桥只在**判定该回**时，把上下文 POST 给 agent 的 webhook，
 *   agent 回一段文字（可选带表情包题材/要记的事实），桥负责拟人投递与记忆。
 *
 * 配置：data/bridge-config.json
 *   {
 *     "hosted": {
 *       "enabled": true,
 *       "webhookUrl": "http://127.0.0.1:9999/reply",
 *       "timeoutMs": 20000,
 *       "secret": "",
 *       "rooms": [],              // 白名单（roomId）；空=所有群
 *       "botName": "蓝色大肥鱼",
 *       "aliases": ["大肥鱼", "肥鱼"],
 *       "replyProbability": 0.3,
 *       "minReplyGapMs": 6000,
 *       "maxRepliesPer10Min": 15,
 *       "quietHours": "23:00-08:00",
 *       "quietAllow": ["at", "name"],
 *       "splitChance": 0.3,
 *       "maxLines": 3,
 *       "stickerChance": 0.2
 *     }
 *   }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RoomPolicy, detectTrigger, humanDelayMs, splitMessage, gapMs,
  parseQuietWindows, isQuiet, cleanReply,
} from './policy.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class HostedMode {
  constructor({ handle, log, dataDir, onEvent = null }) {
    this.handle = handle          // 桥的 op 分发器（发消息用）
    this.log = log
    this.dataDir = dataDir
    this.onEvent = onEvent        // 可选：把托管事件推给面板/日志
    this.cfgFile = join(dataDir, 'bridge-config.json')
    this.memDir = join(dataDir, 'hosted-memory')
    this.rooms = new Map()        // roomId → { policy, msgs, facts, pendingQuestion, sentTexts, lastAt }
    this.stats = { seen: 0, asked: 0, replied: 0, skipped: 0, errors: 0 }
    this.load()
  }

  // ── 配置 ────────────────────────────────────────────────────
  load() {
    let all = {}
    try { all = JSON.parse(readFileSync(this.cfgFile, 'utf8')) } catch { all = {} }
    this.all = all
    const h = all.hosted || {}
    this.cfg = {
      enabled: !!h.enabled,
      webhookUrl: String(h.webhookUrl || ''),
      timeoutMs: Number(h.timeoutMs) || 20000,
      secret: String(h.secret || ''),
      rooms: Array.isArray(h.rooms) ? h.rooms : [],
      botName: String(h.botName || '蓝色大肥鱼'),
      aliases: Array.isArray(h.aliases) ? h.aliases : ['大肥鱼', '肥鱼'],
      replyProbability: h.replyProbability ?? 0.3,
      minReplyGapMs: h.minReplyGapMs ?? 6000,
      maxRepliesPer10Min: h.maxRepliesPer10Min ?? 15,
      quietHours: String(h.quietHours ?? '23:00-08:00'),
      quietAllow: Array.isArray(h.quietAllow) ? h.quietAllow : ['at', 'name'],
      splitChance: h.splitChance ?? 0.3,
      maxLines: h.maxLines ?? 3,
      stickerChance: h.stickerChance ?? 0.2,
      maxReplyChars: h.maxReplyChars ?? 60,
    }
    this.quietWindows = parseQuietWindows(this.cfg.quietHours)
    return this.cfg
  }

  save(patch = {}) {
    this.all = { ...this.all, hosted: { ...(this.all.hosted || {}), ...patch } }
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.cfgFile, JSON.stringify(this.all, null, 2))
    } catch (e) { this.log('保存托管配置失败：' + String(e?.message || e)) }
    return this.load()
  }

  status() {
    return {
      ...this.cfg,
      secret: this.cfg.secret ? '***' : '',
      stats: this.stats,
      rooms: [...this.rooms.keys()],
    }
  }

  // ── 房间状态 ────────────────────────────────────────────────
  room(roomId) {
    let r = this.rooms.get(roomId)
    if (r) return r
    r = {
      roomId, msgs: [], facts: [], pendingQuestion: null, sentTexts: [],
      lastActivityAt: 0, lastReplyAt: 0,
      policy: new RoomPolicy({
        replyProbability: this.cfg.replyProbability,
        minReplyGapMs: this.cfg.minReplyGapMs,
        maxRepliesPer10Min: this.cfg.maxRepliesPer10Min,
        quietHours: this.cfg.quietHours,
        quietAllow: this.cfg.quietAllow,
      }),
    }
    // 载入长期记忆
    try {
      const j = JSON.parse(readFileSync(join(this.memDir, roomId.replace(/[^\w@.-]/g, '_') + '.json'), 'utf8'))
      r.facts = Array.isArray(j.facts) ? j.facts : []
      r.msgs = Array.isArray(j.msgs) ? j.msgs.slice(-100) : []
    } catch { /* 首次 */ }
    this.rooms.set(roomId, r)
    return r
  }

  saveRoom(r) {
    try {
      mkdirSync(this.memDir, { recursive: true })
      writeFileSync(join(this.memDir, r.roomId.replace(/[^\w@.-]/g, '_') + '.json'),
        JSON.stringify({ facts: r.facts.slice(-80), msgs: r.msgs.slice(-100) }, null, 2))
    } catch { /* ignore */ }
  }

  addFact(r, text) {
    const t = String(text || '').trim()
    if (!t || t.length > 120) return false
    if (r.facts.some((f) => f.text === t)) return false
    r.facts.push({ text: t, at: Date.now() })
    return true
  }

  // ── 收到消息（由桥的轮询器驱动） ─────────────────────────────
  async onMessage(m) {
    if (!this.cfg.enabled) return
    if (!m || m.isSelf) return                       // 自己发的不处理（否则会回自己）
    if (this.cfg.rooms.length && !this.cfg.rooms.includes(m.roomId)) return
    this.stats.seen++
    const r = this.room(m.roomId)
    r.lastActivityAt = Date.now()
    if (r.pendingQuestion) r.pendingQuestion = null   // 有人接话了 → 不再追问

    const text = String(m.text || m.content || '')
    r.msgs.push({ ts: m.ts || Date.now(), isSelf: false, senderName: m.senderName || m.sender, text })
    if (r.msgs.length > 200) r.msgs = r.msgs.slice(-200)
    this.saveRoom(r)

    const priority = detectTrigger(m, { aliases: this.cfg.aliases, selfNames: [this.cfg.botName] })
    const quiet = isQuiet(this.quietWindows)
    const d = r.policy.decide({ priority, now: Date.now(), quiet, text })
    if (!d.reply) { this.stats.skipped++; return this.emit('skip', { roomId: m.roomId, reason: d.reason, priority }) }

    const reply = await this.askAgent(r, m, priority)
    if (!reply) { this.stats.skipped++; return this.emit('skip', { roomId: m.roomId, reason: 'agent 没给内容', priority }) }

    // agent 可以顺手让桥记点长期事实
    if (Array.isArray(reply.facts)) {
      let n = 0
      for (const f of reply.facts) if (this.addFact(r, f)) n++
      if (n) { this.saveRoom(r); this.log(`托管：记下 ${n} 条长期记忆`) }
    }
    await this.deliver(r, reply, priority)
  }

  /** 问 agent 该说什么（webhook） */
  async askAgent(r, m, priority) {
    if (!this.cfg.webhookUrl) { this.log('托管模式没配 webhookUrl'); return null }
    const body = {
      room: { id: r.roomId, name: m.roomName || r.roomId },
      trigger: {
        sender: m.sender, senderName: m.senderName, text: m.text, typeName: m.typeName,
        isAtMe: !!m.isAtMe, atAll: !!m.atAll, ts: m.ts,
      },
      recent: r.msgs.slice(-12).map((x) => ({ senderName: x.senderName, text: x.text })),
      memory: { facts: r.facts.slice(-10).map((f) => f.text), pendingQuestion: r.pendingQuestion?.text || '' },
      priority,
    }
    this.stats.asked++
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('agent 超时')), this.cfg.timeoutMs)
    try {
      const res = await fetch(this.cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.secret ? { 'x-wx-secret': this.cfg.secret } : {}) },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) { this.log(`agent 返回 HTTP ${res.status}`); this.stats.errors++; return null }
      const j = await res.json()
      const text = cleanReply(String(j.text || ''), { maxLen: this.cfg.maxReplyChars, maxLines: this.cfg.maxLines })
      if (!text && !j.sticker) return null
      return { text, sticker: j.sticker || null }
    } catch (e) {
      this.log('问 agent 失败：' + String(e?.message || e))
      this.stats.errors++
      return null
    } finally { clearTimeout(timer) }
  }

  /** 拟人投递：打字延迟 + 拆条 + 可选表情包 */
  async deliver(r, reply, priority) {
    const parts = reply.text
      ? splitMessage(reply.text, { chance: this.cfg.splitChance, maxParts: this.cfg.maxLines })
      : []
    if (parts.length) {
      const delay = humanDelayMs(parts[0], priority)
      this.log(`托管：打字中… ${Math.round(delay / 1000)}s 后发送（${parts.length} 条）`)
      await sleep(delay)
      for (let i = 0; i < parts.length; i++) {
        try {
          await this.handle('sendText', { roomId: r.roomId, text: parts[i] })
          this.stats.replied++
        } catch (e) { this.log('托管发送失败：' + String(e?.message || e)); this.stats.errors++; return }
        r.msgs.push({ ts: Date.now(), isSelf: true, senderName: '我', text: parts[i] })
        if (i < parts.length - 1) await sleep(gapMs())
      }
      // 记下"我刚问了问题"，回答过就不再追问
      const asked = parts.join(' ')
      if (/[?？]/.test(asked)) r.pendingQuestion = { text: asked.slice(0, 80), at: Date.now() }
    }
    // 表情包
    const wantSticker = reply.sticker || Math.random() < this.cfg.stickerChance
    if (wantSticker) {
      try {
        let stickerId = ''
        if (reply.sticker?.subject) {
          const gen = await this.handle('genSticker', {
            emotion: String(reply.sticker.subject),
            extra: String(reply.sticker.scene || ''),
            bubble: String(reply.sticker.bubble || ''),
          })
          stickerId = gen?.stickerId || ''
        }
        if (!stickerId) {
          const picked = await this.handle('pickSticker', { text: reply.text || '', roomId: r.roomId, minScore: 0 })
          stickerId = picked?.id || ''
        }
        if (stickerId) {
          if (parts.length) await sleep(gapMs())
          await this.handle('sendSticker', { roomId: r.roomId, stickerId })
          r.msgs.push({ ts: Date.now(), isSelf: true, senderName: '我', text: '[表情包]' })
        }
      } catch (e) { this.log('托管发表情包失败：' + String(e?.message || e)) }
    }
    r.lastReplyAt = Date.now()
    r.policy.noteReplied(Date.now(), r.msgs.at(-1)?.senderName || '')
    this.saveRoom(r)
    this.emit('replied', { roomId: r.roomId, parts, sticker: !!wantSticker })
  }

  emit(type, data) {
    try { this.onEvent?.({ type, ...data }) } catch { /* ignore */ }
  }
}
