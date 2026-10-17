/**
 * 表情包库 —— 自动收藏群友发的表情包，按"出现语境"打标签，供回复时反手甩图。
 *
 * 设计要点（为什么这样做）：
 * - 无法直接理解表情包画面内容，所以用**语境标签**代替语义理解：
 *   谁在什么话题下发了这张图 → 记下当时前后文的词 → 我们要说类似话题时就能挑出它。
 * - 去重按内容 sha1：同一张图被多人多次发，只存一份，但累加使用热度与来源。
 * - 使用后记 lastUsedAt / uses，挑选时做"冷热均衡"（避免永远只发同一张）。
 */
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, statSync, readdirSync, unlinkSync,
} from 'node:fs'
import { join, extname, basename } from 'node:path'

const IMG_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** 中文/英文分词：粗粒度即可，用于语境标签匹配 */
export function tokenize(text) {
  if (!text) return []
  const cleaned = String(text)
    .replace(/@[^\s@]+/g, ' ')          // 去掉 @某人
    .replace(/\[[^\]]{1,8}\]/g, ' ')    // 去掉 [微笑] 这类内置表情码
    .replace(/https?:\/\/\S+/g, ' ')
  const words = []
  // 中文滑窗（无词典分词的廉价替代）：短词保留整词，同时补 2-gram，
  // 这样"哈哈哈"能匹配到"哈哈"、"笑死我了"能匹配到"笑死"。
  for (const seg of cleaned.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length <= 4) words.push(seg)
    if (seg.length >= 3) {
      for (let i = 0; i + 2 <= seg.length; i++) words.push(seg.slice(i, i + 2))
    }
    if (seg.length >= 5) {
      for (let i = 0; i + 3 <= seg.length; i++) words.push(seg.slice(i, i + 3))
    }
  }
  for (const w of cleaned.toLowerCase().match(/[a-z0-9]{2,}/g) || []) words.push(w)
  return [...new Set(words)]
}

export class StickerLibrary {
  constructor(dir) {
    this.dir = dir
    this.filesDir = join(dir, 'files')
    this.indexFile = join(dir, 'index.json')
    mkdirSync(this.filesDir, { recursive: true })
    this.items = this.#load()
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      if (Array.isArray(raw?.items)) return raw.items
    } catch { /* 首次运行 */ }
    return []
  }

  save() {
    try {
      writeFileSync(this.indexFile, JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        items: this.items,
      }, null, 2))
    } catch (e) { /* 落盘失败不影响运行 */ }
  }

  get size() { return this.items.length }

  /**
   * 归档一张表情包。两种形态：
   *  ① 有本地文件（图片/表情文件，走 sendImg / sendEmotion(file)）
   *  ② 只有 XML（微信自定义表情 type47，发的时候用 ForwardXMLMsg 原样转发 ——
   *     这样对方收到的是**真表情包**，而不是一张图片）
   * @param {object} p
   * @param {string} [p.srcPath] 本地文件路径
   * @param {string} [p.xml] 表情的 XML 内容（形态②）
   * @param {string} [p.sender] 发送者 wxid
   * @param {string} [p.senderName] 发送者昵称
   * @param {string} [p.roomId]
   * @param {string} [p.context] 当时前后文（用于语境标签）
   * @param {string} [p.kind] 'emoticon' | 'image'
   * @returns {object|null} 库条目
   */
  /**
   * 加一张表情。
   * @param {object} p
   * @param {string} [p.srcPath] 本地图片（图片型表情）
   * @param {string} [p.xml] 微信表情 XML（收藏来的原生表情）
   * @param {string} [p.sender] 发送者 wxid
   * @param {string} [p.senderName] 发送者昵称
   * @param {string} [p.roomId] 来源群
   * @param {string} [p.context] 语境（会切成标签）
   * @param {string} [p.kind] 'emoticon' | 'image'
   * @param {string} [p.source] 来源：'gen'(Agnes生成) | 'import'(用户投递) | 'collected'(群里收藏) | 'mock'(测试)
   */
  add({ srcPath, xml = '', sender, senderName, roomId, context, kind = 'emoticon', source }) {
    if (!srcPath && !xml) return null
    let buf = null
    let ext = ''
    if (srcPath && existsSync(srcPath)) {
      const e = (extname(srcPath) || '').toLowerCase()
      try {
        const st = statSync(srcPath)
        if (st.size > 0 && st.size <= 8 * 1024 * 1024) { buf = readFileSync(srcPath); ext = IMG_EXT.has(e) ? e : '.gif' }
      } catch { buf = null }
    }
    if (!buf && !xml) return null

    const sha = createHash('sha1').update(buf || xml).digest('hex')
    const id = sha.slice(0, 16)
    const existing = this.items.find((it) => it.id === id)
    const tags = tokenize(context)

    if (existing) {
      existing.seenCount = (existing.seenCount || 1) + 1
      existing.lastSeenAt = new Date().toISOString()
      existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(-60)
      if (xml && !existing.xml) existing.xml = xml
      if (sender && !(existing.senders || []).includes(sender)) (existing.senders ||= []).push(sender)
      if (roomId && !(existing.rooms || []).includes(roomId)) (existing.rooms ||= []).push(roomId)
      this.save()
      return existing
    }

    let file = ''
    if (buf) {
      file = join(this.filesDir, id + ext)
      try { copyFileSync(srcPath, file) } catch { return null }
    }
    const item = {
      id,
      file,
      xml,
      ext,
      bytes: buf ? buf.length : xml.length,
      kind,
      tags,
      // 来源：决定它能不能被机器人挑出来发（用户要求：只用"生成的"和"自己投递的"）
      source: source || (kind === 'emoticon' || !file ? 'collected' : 'import'),
      senders: sender ? [sender] : [],
      senderNames: senderName ? [senderName] : [],
      rooms: roomId ? [roomId] : [],
      seenCount: 1,
      uses: 0,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.items.push(item)
    this.save()
    return item
  }

  /**
   * 迁移历史数据：给没有 source 字段的旧条目推断来源。
   * gen      = Agnes 生成（标签里有 agnes/生成）
   * collected= 群里收藏的原生表情（无文件 / kind=emoticon）
   * mock     = 早期测试图（房间是 mock-room-1）
   * import   = 其余有文件的（用户投递或预置）
   */
  migrateSources() {
    let n = 0
    for (const it of this.items) {
      if (it.source) continue
      const tags = it.tags || []
      if (it.kind === 'emoticon' || !it.file) it.source = 'collected'
      else if (tags.includes('agnes') || tags.includes('生成')) it.source = 'gen'
      else if ((it.rooms || []).includes('mock-room-1')) it.source = 'mock'
      else it.source = 'import'
      n++
    }
    if (n) this.save()
    return n
  }

  /** 各来源的数量（排查"机器人为什么挑了这张"用） */
  sourceStats() {
    const out = {}
    for (const it of this.items) out[it.source || 'unknown'] = (out[it.source || 'unknown'] || 0) + 1
    return out
  }

  get(id) { return this.items.find((it) => it.id === id) }

  /**
   * 批量导入"投递目录"里的表情包图片（用户把自己的表情包丢进去即可用）。
   * 文件名可当语境标签：如 "哈哈哈.gif"、"无语 服了.png"。
   * @returns {{added:number, skipped:number, total:number}}
   */
  importFromDir(dir) {
    let added = 0
    let skipped = 0
    if (!existsSync(dir)) { try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ } return { added, skipped, total: 0 } }
    let files = []
    try { files = readdirSync(dir) } catch { return { added, skipped, total: 0 } }
    for (const f of files) {
      const full = join(dir, f)
      const ext = (extname(f) || '').toLowerCase()
      if (!IMG_EXT.has(ext)) { skipped++; continue }
      const tag = basename(f, ext)                      // 文件名当标签
      const before = this.items.length
      const it = this.add({ srcPath: full, context: tag, kind: 'image', source: 'import', senderName: '手动导入' })
      if (it && this.items.length > before) added++
      else skipped++
    }
    if (added) this.save()
    return { added, skipped, total: files.length }
  }

  list(limit = 50) {
    return [...this.items]
      .sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.seenCount || 0) - (a.seenCount || 0))
      .slice(0, limit)
  }

  /**
   * 按语境挑一张表情包。
   * 打分 = 标签命中数 * 3 + 同群加成 + 热度(封顶) - 最近用过的惩罚
   * @param {object} p
   * @param {string} [p.text] 我们即将说/刚看到的话
   * @param {string} [p.roomId]
   * @param {number} [p.minScore] 低于此分不发（避免乱发图）
   * @param {number} [p.random] 0-1 随机数（便于测试注入）
   */
  pick({ text = '', roomId, minScore = 3, requireTag = false, random = Math.random(), onlySendable = true, allowedSources = ['gen', 'import'] } = {}) {
    // 只发"指定来源"的表情（默认：Agnes 生成的 + 用户自己投递的），
    // 群里自动收藏的原生表情和早期测试图都不参与挑选。
    const allow = new Set(allowedSources || [])
    const pool = this.items.filter((it) => {
      if (onlySendable && !it.file) return false
      if (allow.size && !allow.has(it.source || 'unknown')) return false
      return true
    })
    if (!pool.length) return null
    if (!pool.length) return null
    // requireTag：只考虑"至少命中一个语境标签"的图。
    // 为什么需要它：见过次数(最多+2)和用过次数(最多+3)的加分能让**完全不相关**的图
    // 拿到 5 分，轻松越过 minScore —— 表现就是"拿一张莫名其妙的旧图糊弄"。
    // 打开它以后：不匹配就返回 null（宁可不发图，也不乱发）。
    let candidates = pool
    if (requireTag) {
      const wantSet = new Set(tokenize(text))
      candidates = pool.filter((it) => (it.tags || []).some((t) => wantSet.has(t)))
      if (!candidates.length) return null
    }
    const want = new Set(tokenize(text))
    const now = Date.now()
    const scored = candidates.map((it) => {
      let score = 0
      for (const t of it.tags || []) if (want.has(t)) score += 3
      if (roomId && (it.rooms || []).includes(roomId)) score += 1
      score += Math.min(it.seenCount || 0, 5) * 0.4
      score += Math.min(it.uses || 0, 10) * 0.3
      const last = it.lastUsedAt ? Date.parse(it.lastUsedAt) : 0
      if (last) {
        const hours = (now - last) / 3.6e6
        if (hours < 0.5) score -= 6          // 刚发过，短期别重复
        else if (hours < 6) score -= 2
      }
      return { it, score: score + random * 1.5 }   // 抖动，避免每次同一张
    }).sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (!best || best.score < minScore) return null
    return best.it
  }

  markUsed(id) {
    const it = this.get(id)
    if (!it) return
    it.uses = (it.uses || 0) + 1
    it.lastUsedAt = new Date().toISOString()
    this.save()
  }

  /** 清理索引里已丢失文件的条目（只有 XML 的表情不依赖文件，保留） */
  prune() {
    const before = this.items.length
    this.items = this.items.filter((it) => (it.file ? existsSync(it.file) : !!it.xml))
    if (this.items.length !== before) this.save()
    return before - this.items.length
  }

  stats() {
    const kinds = {}
    let bytes = 0
    for (const it of this.items) {
      kinds[it.kind || 'emoticon'] = (kinds[it.kind || 'emoticon'] || 0) + 1
      bytes += it.bytes || 0
    }
    return { count: this.items.length, kinds, mb: +(bytes / 1048576).toFixed(2) }
  }
}
