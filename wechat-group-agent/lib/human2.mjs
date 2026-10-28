/**
 * human2.mjs —— 第二轮"更像人"（承诺 / 纠错 / 沉默 / 追话 / 联想 / 自己的事）
 *
 * 全部纯函数：不读写磁盘、不调网络、不依赖 ctx。这样能脱离插件单测，
 * 也方便以后换实现（比如把规则换成小模型判断）。
 *
 * 对应方案编号：
 *   2 承诺追踪   detectPromise / duePromises / promiseExpired
 *   3 纠错改记忆 detectCorrection / applyCorrection
 *   4 沉默艺术   silenceDecision
 *   6 连续追击   planFollowUp
 *   7 自己的事   planActivity
 *   9 联想浮现   cueWords / pickAssociation
 */

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)
const MIN = 60_000
const HOUR = 3_600_000

// ══════════════════════════════════════════════════════════════════════
//  2. 承诺追踪 —— 她说"等下帮你找"，到点真的回来
// ══════════════════════════════════════════════════════════════════════

/** 从她的一句回复里认出"承诺"（宁可少认，不要乱认） */
export function detectPromise(text, now = Date.now()) {
  const t = String(text || '')
  if (!t || t.length > 200) return null
  // 必须同时有"延后" + "动作"，才当承诺
  const later = /(等会|等下|待会|一会儿|稍后|马上|回头|明天|晚点|过会)/.test(t)
  const act = /(帮你|给你|替你|帮你找|找找|看看|查查|问问|发你|告诉你|整理|找一下|翻一下)/.test(t)
  if (!later || !act) return null
  // 立刻就能做完的不算（"等下哦"这种口头禅不算承诺）
  if (!/(帮你|给你|替你|发你|告诉你)/.test(t)) return null
  let dueMin = 25
  if (/马上|稍后|过会/.test(t)) dueMin = 8
  if (/明天/.test(t)) dueMin = 12 * 60
  return {
    text: t.slice(0, 120),
    at: now,
    dueAt: now + dueMin * MIN,
    ttlAt: now + 26 * HOUR,      // 超过这个时间还不兑现就静默作废（别三天后突然回）
    done: false,
  }
}

/** 哪些承诺到点了（该去兑现） */
export function duePromises(promises, now = Date.now()) {
  return (promises || []).filter((p) => p && !p.done && now >= num(p.dueAt, 0) && now < num(p.ttlAt, Infinity))
}

/** 哪些承诺过期作废（不兑现也不提了） */
export function expirePromises(promises, now = Date.now()) {
  return (promises || []).filter((p) => p && !p.done && now >= num(p.ttlAt, Infinity) || (p && p.done && now - num(p.at, 0) > 2 * 86_400_000))
}

/** 兑现时说什么（先给模板，模型可用可不用） */
export function promiseFulfillPrompt(promise) {
  return `你之前答应过对方：「${String(promise && promise.text || '').slice(0, 80)}」\n`
    + '现在该回头说一句了。像真人那样简短交代结果（如果其实还没查，就老实说"还没弄好，等下"），不要长篇解释。'
}

// ══════════════════════════════════════════════════════════════════════
//  3. 纠错 —— 被纠正后改记忆，而不是嘴硬到底
// ══════════════════════════════════════════════════════════════════════

/** 识别"群友在纠正她" */
export function detectCorrection(text) {
  const t = String(text || '')
  if (!t || t.length > 300) return null
  // "不是X，是Y" / "说错了" / "你记错了" / "纠正一下"
  const m1 = t.match(/不是\s*([^，。；,;\s]{1,20})\s*[，,]?\s*(?:是|而是)\s*([^，。；,;\s]{1,20})/)
  if (m1) return { wrong: m1[1], right: m1[2], raw: t.slice(0, 120) }
  if (/(你记错|记错了|说错了|搞错了|搞混了|纠正一下|不是这样)/.test(t)) {
    return { wrong: '', right: '', raw: t.slice(0, 120) }
  }
  return null
}

/**
 * 把纠正应用到记忆列表。
 * @returns {{items, changed, target}}
 */
export function applyCorrection(items, correction, now = Date.now()) {
  const list = Array.isArray(items) ? items.slice() : []
  const c = correction || {}
  const wrong = String(c.wrong || '').trim()
  const right = String(c.right || '').trim()
  if (!list.length) return { items: list, changed: false, target: null }
  // 找出"最像被纠正的那条"：优先含 wrong 的，其次最近一小时新建的
  let idx = -1
  if (wrong) idx = list.findIndex((x) => x && String(x.text || '').includes(wrong))
  if (idx < 0) {
    const recent = list.map((x, i) => ({ i, age: now - num(x && x.createdAt, now) }))
      .filter((x) => x.age < 2 * HOUR).sort((a, b) => a.age - b.age)
    if (recent.length) idx = recent[0].i
  }
  if (idx < 0) return { items: list, changed: false, target: null }
  const old = list[idx]
  const oldText = String(old.text || '')
  let newText = oldText
  if (wrong && right) newText = oldText.split(wrong).join(right)
  if (newText === oldText && c.raw) newText = oldText + '（更正：' + String(c.raw).slice(0, 40) + '）'
  const item = {
    ...old,
    text: newText.slice(0, 200),
    correctedAt: now,
    correctionCount: num(old.correctionCount, 0) + 1,
    // 被纠正过的记忆稍微降一点重要度（说明我们记错过），但不要打成垃圾
    importance: clamp01(num(old.importance, 0.45) - 0.05),
    updatedAt: now,
  }
  list[idx] = item
  return { items: list, changed: true, target: item }
}

// ══════════════════════════════════════════════════════════════════════
//  4. 沉默的艺术 —— 知道什么时候不该说话
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {object} ctx { recent:[{isSelf,sender,text,ts}], trigger, energy, affinityToSender, lastSelfAt, now }
 * @returns {{silent:boolean, reason:string, chance:number}} chance = 沉默概率（0~1）
 */
export function silenceDecision(ctx = {}) {
  const now = ctx.now || Date.now()
  const recent = (ctx.recent || []).slice(-12)
  const trg = ctx.trigger || {}
  const text = String(trg.text || '')
  const energy = Number(ctx.energy)
  const hour = new Date(now).getHours()
  const atBot = /大肥鱼|肥鱼|鲸鱼娘/.test(text)
  let silence = 0
  const reasons = []

  // ① 群里在吵架（两个人连续互相攻击）→ 闭嘴
  const fight = recent.filter((m) => !m.isSelf && /滚|傻|闭嘴|妈的|烦死|有病|去死|草/.test(String(m.text || '')))
  if (!atBot && fight.length >= 2) { silence = Math.max(silence, 0.9); reasons.push('群里在吵架') }

  // ★ 逃生阀：她已经沉默超过 30 分钟 → 不再拿"别人在聊/上句没人接"当理由，
  //   否则活跃群里她会一直插不上话，看起来像坏了（比话多更糟）。
  const lastSelf = recent.filter((m) => m.isSelf).slice(-1)[0]
  const sinceSelfMin = lastSelf ? (now - Number(lastSelf.ts)) / MIN : 999
  const canUseChatRules = sinceSelfMin < 30

  // ② 别人在互相聊天（连续三条都不是冲她，且至少有两个人）→ 别插嘴
  const notForMe = recent.slice(-3).filter((m) => !m.isSelf && !/大肥鱼|肥鱼|鲸鱼娘/.test(String(m.text || '')))
  const senders = new Set(notForMe.map((m) => String(m.sender || '')))
  if (canUseChatRules && !atBot && notForMe.length >= 3 && senders.size >= 2) {
    silence = Math.max(silence, 0.75); reasons.push('别人在互聊')
  }

  // ③ 她刚说完一句没人接 → 不硬追（连续追击另算）
  if (canUseChatRules && lastSelf && recent.filter((m) => !m.isSelf && Number(m.ts) > Number(lastSelf.ts)).length === 0) {
    const gapMin = (now - Number(lastSelf.ts)) / MIN
    if (!atBot && gapMin < 20) { silence = Math.max(silence, 0.85); reasons.push('上句没人接') }
  }

  // ④ 深夜 + 精力低 → 只看不说
  if (hour >= 1 && hour < 6 && Number.isFinite(energy) && energy < 0.35 && !atBot) {
    silence = Math.max(silence, 0.9); reasons.push('深夜精力低')
  }

  // ⑤ 有人正在被怼，别跟着起哄
  const target = String(trg.sender || '')
  if (!atBot && target && recent.some((m) => !m.isSelf && m.sender === target && /傻|滚|闭嘴|烦/.test(String(m.text || '')))) {
    silence = Math.max(silence, 0.6); reasons.push('对方正在被怼')
  }

  // 冲着她来的（@/点名）永远不沉默
  if (atBot) return { silent: false, reason: '被点名', chance: 0 }

  return { silent: silence >= 0.5, reason: reasons.join('；'), chance: clamp01(silence) }
}

// ══════════════════════════════════════════════════════════════════════
//  6. 连续追击 —— 说完一句，过一会儿自己补一句
// ══════════════════════════════════════════════════════════════════════
export const FOLLOWUP_LINES = [
  '对了', '话说', '诶我刚想起来', '哦对', '还有',
]
/**
 * @returns {null|{delayMs, seed, reason}}  null = 这次不追
 */
export function planFollowUp({ text = '', sentAt = Date.now(), energy = 0.7, isVoice = false, alreadyFollowed = 0, rnd = Math.random } = {}) {
  if (isVoice) return null
  const len = [...String(text)].length
  if (len < 6 || len > 80) return null           // 太短/太长的都不适合补一句
  if (num(alreadyFollowed, 0) >= 2) return null  // 一轮最多追两次
  const base = 0.18 + (energy > 0.6 ? 0.06 : 0)
  if (rnd() > base) return null
  const delayMs = (40 + Math.floor(rnd() * 140)) * 1000   // 40~180 秒
  const seed = FOLLOWUP_LINES[Math.floor(rnd() * FOLLOWUP_LINES.length)]
  return { delayMs, seed, reason: '想到就补一句' }
}

// ══════════════════════════════════════════════════════════════════════
//  7. 自己的事 —— 她真的在看/在听什么（只用真实素材，不编）
// ══════════════════════════════════════════════════════════════════════
/**
 * @param {object} o { tastes:[], goals:[], lastAt, quietMin, rnd }
 * @returns {null|{topic, delayMs}}
 */
export function planActivity({ tastes = [], goals = [], lastAt = 0, quietMin = 0, rnd = Math.random } = {}) {
  const now = Date.now()
  if (now - num(lastAt, 0) < 3 * HOUR) return null   // 3 小时最多一次
  if (num(quietMin, 0) < 15) return null             // 群里正在聊就别自顾自
  if (rnd() > 0.10) return null
  const pool = [...tastes.map((x) => String(x && x.text || '')), ...goals.map((g) => String(g && g.text || ''))].filter(Boolean)
  if (!pool.length) return null
  const topic = pool[Math.floor(rnd() * pool.length)]
  return { topic, delayMs: 5_000 }
}

/** 让她"分享点什么"时的提示词（必须真实：可不带事实，只说自己在看/在听） */
export function activityPrompt(topic) {
  return `你刚自己在看/在听和「${topic}」有关的东西。`
    + '如果群里正安静，可以随口说一句（不要编造具体的新闻事实、数据、人名；'
    + '可以说"刚看到个…""在听…"这种分享，也可以问别人的看法）。'
}

// ══════════════════════════════════════════════════════════════════════
//  9. 联想浮现 —— 被线索勾起来的回忆（不是抽奖）
// ══════════════════════════════════════════════════════════════════════
/** 从最近聊天里抽"线索词"：人名/好恶里的词/较长的中文片段 */
export function cueWords({ recent = [], tastes = [], limit = 6 } = {}) {
  const out = []
  const push = (w) => {
    const v = String(w || '').trim()
    if (v.length < 2 || v.length > 8) return
    if (!out.includes(v)) out.push(v)
  }
  const text = (recent || []).slice(-4).map((m) => String(m && m.text || '')).join(' ')
  // 好恶词优先（她敏感的东西最容易勾起回忆）
  for (const t of tastes || []) if (text.includes(String(t && t.text || ''))) push(t.text)
  // 常见人名（群里出现过的 2~4 字中文片段里，取在 tastes/成员里出现过的）
  for (const mm of text.match(/[\u4e00-\u9fa5]{2,4}/g) || []) {
    if (/^(因为|所以|就是|这个|那个|什么|怎么|可以|不是|没有|现在|时候|一个|知道)/.test(mm)) continue
    push(mm)
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

/**
 * 从候选记忆里挑一条"被线索勾起的"，且不在已选列表里。
 * @returns {null|{text, cue}}
 */
export function pickAssociation(memories, { cues = [], exclude = [], now = Date.now(), rnd = Math.random } = {}) {
  if (!cues.length) return null
  const ex = new Set((exclude || []).map((x) => String(x).slice(0, 40)))
  const cands = (memories || []).filter((m) => {
    if (!m || !m.text || m.archived) return false
    if (ex.has(String(m.text).slice(0, 40))) return false
    return cues.some((c) => String(m.text).includes(c))
  })
  if (!cands.length) return null
  // 越重要、越久没被用过的更可能"忽然想起"
  cands.sort((a, b) => {
    const sa = num(a.importance, 0.45) / (1 + num(a.recallCount, 0))
    const sb = num(b.importance, 0.45) / (1 + num(b.recallCount, 0))
    return sb - sa
  })
  const pick = cands[Math.min(cands.length - 1, Math.floor(rnd() * Math.min(3, cands.length)))]
  const cue = cues.find((c) => String(pick.text).includes(c)) || cues[0]
  return { text: String(pick.text), cue, id: pick.id || '' }
}

/**
 * 9（改进版）：产出"候选旧事"列表，**不做随机选择** —— 挑哪条交给模型。
 *
 * 为什么改：以前是本地按分数排序后随机取一条塞进提示词，等于替她决定"想起什么"，
 * 经常出现"提了一件跟当前话题八竿子打不着的旧事"。现在本地只负责快速缩小范围
 * （省 token、免得分心），真正的取舍交给模型（它会把标记写在回复末尾）。
 *
 * 排序依据（确定性）：线索命中数 > 重要度 > 越久没被用过的稍微优先。
 */
export function associationCandidates(memories, { cues = [], exclude = [], now = Date.now(), limit = 5 } = {}) {
  if (!cues.length) return []
  const ex = new Set((exclude || []).map((x) => String(x).slice(0, 40)))
  const scored = []
  for (const m of (memories || [])) {
    if (!m || !m.text || m.archived || m.pinned) continue
    if (ex.has(String(m.text).slice(0, 40))) continue
    const text = String(m.text)
    const hits = cues.filter((c) => text.includes(c))
    if (!hits.length) continue
    const imp = num(m.importance, 0.45)
    const used = num(m.recallCount, 0)
    const ageD = Math.max(0, (now - num(m.createdAt, now)) / 86_400_000)
    const score = hits.length * 2 + imp * 3 + Math.min(1, ageD / 14) - used * 0.15
    scored.push({ id: m.id || '', text, hits, score: +score.toFixed(3), imp, used })
  }
  scored.sort((a, b) => b.score - a.score)
  // 去重（不同记忆可能文字高度重叠）
  const out = []
  const seen = new Set()
  for (const x of scored) {
    const key = x.text.slice(0, 20)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
    if (out.length >= limit) break
  }
  return out
}

/** 从模型回复里解析 [想起:N] 标记（返回去掉标记的文本 + 序号） */
export function parseRecallDirective(text) {
  const raw = String(text || '')
  const m = raw.match(/\[想起\s*[:：]\s*(\d{1,2})\s*\]/)
  let out = raw
  let index = 0
  if (m) {
    index = Number(m[1])
    out = raw.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim()
  }
  return { text: out, index }
}
