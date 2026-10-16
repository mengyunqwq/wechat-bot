/**
 * 拟人回复策略 —— 纯逻辑，零依赖，可独立单测（node lib/test-policy.mjs）。
 *
 * 为什么单独成文件：策略是这个项目里最需要反复调参的部分。
 * 与 DSH/微信解耦后，改策略不需要动接入层，也能脱离微信跑回归。
 */

/** 解析安静时段，如 '01:00-07:30' 或 '23:30-06:00,12:00-13:30'；'off' 表示不设 */
export function parseQuietWindows(spec) {
  if (!spec || spec === 'off' || spec === 'none') return []
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s)
    if (!m) return null
    const toMin = (h, mi) => (Number(h) % 24) * 60 + Number(mi)
    return { start: toMin(m[1], m[2]), end: toMin(m[3], m[4]), raw: s }
  }).filter(Boolean)
}

/** 当前是否处于安静时段（支持跨零点） */
export function isQuiet(windows, date = new Date()) {
  const min = date.getHours() * 60 + date.getMinutes()
  return windows.some((w) => (w.start <= w.end ? (min >= w.start && min < w.end) : (min >= w.start || min < w.end)))
}

/**
 * 触发优先级：
 *  at           被 @（必须回）
 *  name         文本里出现昵称/别名（很可能在叫我）
 *  continuation 对话延续：上一条我回过的人又说话了（一来一回，必须接）
 *  question     问句（可能是在问大家）
 *  ambient      纯闲聊
 */
export function detectTrigger(msg, { aliases = [], selfNames = [] } = {}) {
  if (msg.isAtMe) return 'at'
  const text = String(msg.text || '')
  const names = [...aliases, ...selfNames].filter(Boolean)
  for (const n of names) if (text.includes(n)) return 'name'
  if (msg.atAll) return 'question'
  const t = text.trim()
  if (/[?？]$/.test(t)) return 'question'
  if (/(吗|嘛|咋|怎么|为什么|为啥|如何|谁|几点|在哪|有没有|是不是|能不能|要不要|好不好)$/.test(t)) return 'question'
  return 'ambient'
}

/** 拟人打字延迟：字数越多越慢 + 随机抖动；被@时略快（真人看到点名会更快回） */
export function humanDelayMs(text, priority = 'ambient', rand = Math.random()) {
  const len = [...String(text)].length
  // 实测反馈"回复慢"后整体压缩：原来 base 600/900 + 45~70ms/字 + 最多 1.5s 抖动，
  // 现在更接近真人"看到就回"的节奏（长句仍然会明显更慢）。
  const perChar = 28 + rand * 17
  const base = priority === 'at' ? 400 : 600
  let ms = base + len * perChar + rand * 900
  // 偶尔"走神/在忙"：延迟拉长（真人不会每次匀速回）
  if (rand > 0.9) ms *= 1.4 + rand * 0.8
  return Math.max(500, Math.min(15_000, Math.round(ms)))
}

/**
 * 敷衍短句库 —— 真人群聊里绝大多数回复其实都是这种低信息量的反应。
 * 全交给 LLM 生成会让每条都"太聪明"，反而不像人；这里直接短路掉。
 */
export const CANNED_AMBIENT = [
  '哈哈', '哈哈哈', '确实', '6', '笑死', '？', '嗯嗯', '真的假的', '啊这', '牛',
  '行', '好家伙', '草', '别吧', '可以', '哦哦', '离谱', '嗯', '啥', '。。',
  '牛的', '有点东西', '那没事了', '你说得对',
]

export const CANNED_AT = [
  '在的', '咋了', '在', '啊？', '怎么了', '嗯嗯', '哈哈', '你说', '在呢', '干嘛',
]

/**
 * 解析模型输出里的"表情指令"，并把它从正文里**抠掉**。
 *
 * 为什么必须这么写（踩坑记录）：模型并不会乖乖只输出一行 `[表情]`，
 * 它真实的输出长这样：
 *   "那个能画，理想中的我嘛……\n[表情:得意]"
 *   "那可能是我这边的问题…我再发一次试试 [表情:得意]"
 *   "[表情:无语]\n喏，现画的"
 * 早期只判断"整条是不是就是指令"，于是这些指令**被当正文发到微信里**，
 * 群里就会看到一串 "[表情:得意]" 的括号文字（用户当场抓到）。
 *
 * 支持：`[表情]`、`[表情包]`、`[表情:情绪]`、`[表情:情绪|场景描述]`、`[表情:情绪|场景描述|气泡文字]`
 * @returns {{text:string, hasSticker:boolean, stickerOnly:boolean, emotion:string, scene:string, bubble:string}}
 */
export function parseStickerDirective(raw) {
  const src = String(raw ?? '')
  let emotion = ''
  let scene = ''
  let bubble = ''
  let hasSticker = false
  const re = /\[表情(?:包)?(?:\s*[:：]\s*([^\]|]{1,12})(?:\|([^\]|]{1,80}))?(?:\|([^\]]{1,30}))?)?\]/g
  const stripped = src.replace(re, (_m, e, s, b) => {
    hasSticker = true
    if (e && !emotion) emotion = String(e).trim()
    if (s && !scene) scene = String(s).trim()
    if (b && !bubble) bubble = String(b).trim()
    return ''
  })
  const text = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n').trim()
  return { text, hasSticker, stickerOnly: hasSticker && !text, emotion, scene, bubble }
}

/** 兜底：任何情况下都不允许把 [表情…] 这种指令当正文发出去 */
export function stripStickerDirective(text) {
  return String(text ?? '').replace(/\[表情(?:包)?(?:\s*[:：][^\]]{0,90})?\]/g, '').trim()
}

/**
 * 解析"联网搜索"指令：`[搜索:关键词]` / `【搜索：关键词】`，并从正文里抠掉。
 * 让模型自己判断什么时候需要联网（新闻、天气、价格、事实核实…）；
 * 日常闲聊不该搜 —— 提示词里会写清什么时候才用。
 * @returns {{text:string, query:string}}
 */
export function parseSearchDirective(raw) {
  const src = String(raw ?? '')
  let query = ''
  const stripped = src.replace(/[[【]\s*搜索\s*[:：]\s*([^\]】]{1,60})\s*[\]】]/g, (_m, q) => {
    if (!query) query = String(q).trim()
    return ''
  })
  const text = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n').trim()
  return { text, query }
}

/** 兜底：正文里绝不允许残留搜索指令 */
export function stripSearchDirective(text) {
  return String(text ?? '').replace(/[[【]\s*搜索\s*[:：][^\]】]{0,60}[\]】]/g, '').trim()
}

/**
 * 解析"长期记忆"指令：`[记住:xxx]` —— 模型主动把值得长期记住的事写进记忆库。
 * @returns {{text:string, facts:string[]}}
 */
export function parseMemoryDirective(raw) {
  const src = String(raw ?? '')
  const facts = []
  const stripped = src.replace(/[[【]\s*记住\s*[:：]\s*([^\]】]{1,120})\s*[\]】]/g, (_m, f) => {
    const t = String(f).trim()
    if (t) facts.push(t)
    return ''
  })
  const text = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n').trim()
  return { text, facts }
}

/**
 * 低信息量消息（嗯/哦/哈哈/6 之类）——真人在群里也不会对每一声"嗯"都回话。
 * 被@或被点名时不算（那是在跟它说话）。
 */
const LOW_CONTENT = new Set([
  '嗯', '恩', '哦', '噢', '啊', '哈', '哈哈', '哈哈哈', '呵呵', '嘿', '诶', '唉',
  '6', '666', '行', '好的', '好', '是', '对', '确实', '可以', 'ok', '在', '在吗',
  '草', '牛', '笑死', '真的', '啥', '啊这', '这', '那个', '然后', '所以', '就是',
])

export function isLowContent(text) {
  const t = String(text || '')
    .replace(/[\s，。！？!?~…,.、""''（）()\[\]{}]/g, '')
    .toLowerCase()
  if (!t) return false                 // 没文本（图片/表情包等）不算低信息量，交给别的判断
  if ([...t].length <= 6 && LOW_CONTENT.has(t)) return true
  return false
}

/**
 * 挑一条敷衍短句（被@时给相对正经一点的短回复） */
export function pickCanned(priority, rand = Math.random()) {
  const pool = priority === 'at' ? CANNED_AT : CANNED_AMBIENT
  return pool[Math.min(pool.length - 1, Math.floor(rand * pool.length))]
}

/**
 * 主动找话题时的兜底台词（LLM 不可用时用）。
 * 真人主动冒泡往往就是这种没营养但自然的话。
 */
export const PROACTIVE_FALLBACK = [
  '有人吗', '都干嘛呢', '好无聊啊', '今天好冷', '饿了', '没人说话我就潜水了',
  '都在忙？', '来个人聊天', '刚睡醒，有人吗', '群里好安静',
]

export function pickProactive(rand = Math.random()) {
  return PROACTIVE_FALLBACK[Math.min(PROACTIVE_FALLBACK.length - 1, Math.floor(rand * PROACTIVE_FALLBACK.length))]
}

/**
 * 判断"当前是否在允许主动发言的时间段"。
 * 注意语义：spec 描述的是**活跃窗口**（如 '09:00-23:30' 表示这段时间内可以主动冒泡），
 * 所以直接复用 isQuiet 的"是否落在窗口内"判断（这里窗口 = 活跃期，不是安静期）。
 */
export function inActiveHours(spec, date = new Date()) {
  if (!spec || spec === 'off') return true
  return isQuiet(parseQuietWindows(spec), date)
}

/** 要不要把一条回复拆成两条发（真人常这样），以及怎么拆 */
const SENTENCE_END = /(?<=[。！？!?~…\n])/;
const SOFT_END = /(?<=[，、,;；:：])/;

/** 按分隔符切句，去空白、丢空段 */
function cutBy(t, re) {
  return t.split(re).map((s) => s.trim()).filter(Boolean);
}

/** 把过短的碎段并进相邻段（避免出现"嗯。"这种一两个字的独立消息） */
function mergeTiny(parts, hardMax) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && [...p].length < 8 && [...last].length + [...p].length <= hardMax) {
      out[out.length - 1] = last + p;
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 仍然超过 hardMax 的段按长度硬切 */
function splitOversize(parts, hardMax) {
  const out = [];
  for (const p of parts) {
    const cs = [...p];
    if (cs.length <= hardMax) { out.push(p); continue; }
    for (let i = 0; i < cs.length; i += hardMax) out.push(cs.slice(i, i + hardMax).join(''));
  }
  return out;
}

/** 段数超上限：多余的尾巴并进最后一段 */
function capParts(parts, maxParts) {
  const cap = Math.max(1, Number(maxParts) || 1);
  if (parts.length <= cap) return parts;
  return [...parts.slice(0, cap - 1), parts.slice(cap - 1).join('')];
}

/**
 * 把一条回复拆成多条消息（真人常常分两三条发）。
 *
 * 规则（**长度优先**，其次才是概率）：
 *   ① 文本超过 splitMinLen（默认 30 字）→ **必定拆**。
 *      长回复一次发出去又长又不像人；拆开更像在打字聊天。
 *   ② 短文本 → 按 splitChance 概率拆（保留"偶尔分两条"的拟人感）。
 *   ③ 断句优先级：句末标点（。！？!?~… 换行）> 逗号顿号 > 按长度硬切。
 *   ④ 每段尽量不超过 splitHardMax（默认 40 字）；过短的碎段与相邻段合并。
 *   ⑤ 段数上限 maxParts（默认 3），超出的尾巴并入最后一段。
 *
 * @returns {string[]} 至少 1 条
 */
export function splitMessage(text, {
  chance = 0.15,
  rand = Math.random(),
  maxParts = 3,
  minLen = 30,
  hardMax = 40,
} = {}) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const len = [...t].length;

  if (len < minLen) {
    if (rand >= chance) return [t];
    // 单句短文本只有句末标点，切不出 2 段 → 退到逗号顿号，否则概率拆永远不生效
    let sp = cutBy(t, SENTENCE_END);
    if (sp.length < 2) sp = cutBy(t, SOFT_END);
    if (sp.length < 2) return [t];
    return capParts(sp, maxParts);
  }

  let parts = cutBy(t, SENTENCE_END);
  if (parts.length < 2) parts = cutBy(t, SOFT_END);
  if (parts.length < 2) {
    // 连标点都没有：按"长度的一半"硬切，保证长文本至少拆成 2 条
    // （原来直接用 hardMax 切，40 字刚好不超上限 → 仍然一整条发出去）
    parts = splitOversize([t], Math.max(1, Math.min(hardMax, Math.ceil(len / 2))));
  }
  parts = mergeTiny(parts, hardMax);
  parts = splitOversize(parts, hardMax);
  parts = capParts(parts, maxParts);
  // 段数上限只是"尽量"：合并尾巴后若某条仍超过 hardMax，宁可多一条也不要发巨长的一条
  parts = splitOversize(parts, hardMax);
  return parts;
}

/** 两条消息之间的间隔（拆句/文字后补表情包用） */
export function gapMs(rand = Math.random()) {
  return Math.round(700 + rand * 1300)
}

/** 每个群一份的发言节流状态 */
export class RoomPolicy {
  /**
   * @param {object} cfg
   * @param {number} cfg.replyProbability 闲聊插话概率
   * @param {number} cfg.minReplyGapMs 同群两次回复的最小间隔
   * @param {number} cfg.maxRepliesPer10Min 同群 10 分钟回复上限
   */
  constructor(cfg) {
    this.cfg = cfg
    this.replyTimes = []
    this.lastReplyAt = 0
    this.selfStreak = 0
  }

  /**
   * 决策：这条消息要不要回。
   * @returns {{reply:boolean, reason:string, priority:string}}
   */
  decide({ priority, now = Date.now(), rand = Math.random(), quiet = false, text = '' }) {
    // 睡觉时段（默认 23:00-08:00）：**不主动插话**，但被叫到还是要回。
    // 用户要求："睡觉时@依旧回复，只是不主动插话了" → 允许清单默认 ['at','name']。
    if (quiet) {
      const allow = Array.isArray(this.cfg.quietAllow)
        ? this.cfg.quietAllow
        : (this.cfg.quietAllowAt ? ['at'] : [])
      if (!allow.includes(priority)) {
        return { reply: false, reason: `睡觉时段（${priority === 'ambient' ? '不主动插话' : priority + ' 不回'}）`, priority }
      }
      // 允许的（被@/被点名）继续往下走，走正常逻辑（@ 必回、点名 2s 防抖）
    }
    if (priority === 'at') return { reply: true, reason: '被@（必回）', priority }

    // 被点名/提到（"大肥鱼""肥鱼"…）→ **一定要回**：
    // 跳过冷却和 10 分钟上限，只留 2s 防抖（避免同一句话被拆成多条时连回）
    if (priority === 'name') {
      const g = now - this.lastReplyAt
      if (g < 2000) return { reply: false, reason: '被点名但 2s 内刚回过（防抖）', priority }
      return { reply: true, reason: '被点名（必回）', priority }
    }

    // 低信息量消息不值得回（"嗯""哦""哈哈""6"…）——真人也不会句句都接。
    // 但**只对纯闲聊/问句**生效：对方在跟你对话（continuation）时，"对""好""嗯"就是回答，不能吞掉
    // （用户反馈"我回复了它还不理我"，就是短回答被这条过滤掉的）。
    if ((priority === 'ambient' || priority === 'question') && isLowContent(text)) {
      return { reply: false, reason: '低信息量消息（嗯/哦/哈哈之类，不必句句回）', priority }
    }

    const windowMs = 10 * 60 * 1000
    this.replyTimes = this.replyTimes.filter((t) => now - t < windowMs)
    if (this.replyTimes.length >= this.cfg.maxRepliesPer10Min) {
      return { reply: false, reason: `10分钟已达上限 ${this.cfg.maxRepliesPer10Min} 条`, priority }
    }
    if (this.selfStreak >= 2) return { reply: false, reason: '刚连续发言，避免刷屏', priority }

    // ── 对话延续：对方在跟我一来一回，冷却缩到最小 ──
    // 但**不是无脑接**：有概率、有连续轮数上限，否则就变成"每句都回"的客服
    if (priority === 'continuation') {
      const cap = this.cfg.maxConsecutiveTurns ?? 4
      if (this.turnStreak >= cap) {
        return { reply: false, reason: `已连续对聊 ${this.turnStreak} 轮（等对方@或点名再继续）`, priority }
      }
      const p = this.cfg.continuationChance ?? 0.7
      if (rand > p) return { reply: false, reason: `对话延续未命中（p=${p}）`, priority }
      const gap = now - this.lastReplyAt
      if (gap < 2000) return { reply: false, reason: `接话太快（${Math.round(gap)}ms<2000ms）`, priority }
      return { reply: true, reason: `对话延续（第 ${this.turnStreak + 1} 轮）`, priority }
    }

    const gap = now - this.lastReplyAt
    const minGap = this.cfg.minReplyGapMs
    if (gap < minGap) {
      return { reply: false, reason: `冷却中 ${Math.round(gap / 1000)}s<${Math.round(minGap / 1000)}s`, priority }
    }

    // 识别出内容的图片/表情包：比纯闲聊更值得接一句
    if (priority === 'image') {
      const p = Math.min(1, this.cfg.imageReplyProbability ?? 0.5)
      return rand < p
        ? { reply: true, reason: `图片命中（p=${p}）`, priority }
        : { reply: false, reason: `图片未命中（p=${p}）`, priority }
    }

    if (priority === 'question') {
      const p = Math.min(0.85, this.cfg.replyProbability * 2.2)
      return rand < p
        ? { reply: true, reason: `问句命中（p=${p.toFixed(2)}）`, priority }
        : { reply: false, reason: `问句未命中（p=${p.toFixed(2)}）`, priority }
    }

    return rand < this.cfg.replyProbability
      ? { reply: true, reason: `闲聊命中（p=${this.cfg.replyProbability}）`, priority }
      : { reply: false, reason: `闲聊未命中（p=${this.cfg.replyProbability}）`, priority }
  }

  noteReplied(now = Date.now(), sender = '') {
    this.replyTimes.push(now)
    this.lastReplyAt = now
    this.selfStreak = 0
    // 连续对聊轮数：同一个人接着聊才累加，换人则重置
    if (sender && sender === this.lastReplyTo) this.turnStreak = (this.turnStreak || 0) + 1
    else this.turnStreak = 1
    if (sender) this.lastReplyTo = sender
  }

  noteSelf() { this.selfStreak += 1 }
  noteOther() { this.selfStreak = 0 }

  snapshot() {
    const windowMs = 10 * 60 * 1000
    const recent = this.replyTimes.filter((t) => Date.now() - t < windowMs)
    return {
      replies10m: recent.length,
      maxRepliesPer10Min: this.cfg.maxRepliesPer10Min,
      lastReplyAt: this.lastReplyAt || null,
      selfStreak: this.selfStreak,
    }
  }
}

/**
 * 清洗模型输出：去掉引号、前缀、舞台提示、超长截断。
 * 支持**多行 = 多条消息**：真人经常分两三条发（"哈哈哈哈" / "笑死我了" / "真的"），
 * 所以这里保留最多 maxLines 行，交给投递层逐条发送。
 */
export function cleanReply(raw, { maxLen = 60, maxLines = 1 } = {}) {
  let t = String(raw ?? '').trim()
  if (!t) return ''
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim()
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const kept = lines.slice(0, Math.max(1, maxLines))
  const out = []
  for (const line of kept) {
    out.push(cleanOneLine(line, maxLen))
  }
  return out.filter(Boolean).join('\n')
}

/** 清洗单行 */
function cleanOneLine(raw, maxLen) {
  let t = String(raw ?? '').trim()
  if (!t) return ''
  // 去"我：""回复："这类前缀
  t = t.replace(/^(我|回复|答|输出|发送)\s*[:：]\s*/, '')
  // 去包裹引号
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  // 去括号舞台提示（整句都是括号时保留内容）
  t = t.replace(/^[（(](.{0,20})[)）]$/, '$1').trim()
  if ([...t].length > maxLen) {
    const chars = [...t]
    const cut = chars.slice(0, maxLen).join('')
    // 在限长内找**最后一个**句末标点收尾（取第一个会把长回复砍得过短）
    const marks = [...cut.matchAll(/[。！？!?~…]/g)]
    t = (marks.length ? cut.slice(0, marks[marks.length - 1].index + 1) : cut).trim()
  }
  return t
}
