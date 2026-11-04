/**
 * human3.mjs —— 第三轮"更像人"（借社区鲸鱼娘人设规范 & 桌宠养成思路）
 *
 * 纯函数，不含 IO / 网络，方便单测。
 *
 * 覆盖：
 *   ① 情景语气示例（两段式：先嘴硬/玩梗 → 再落到实际或温柔）
 *   ② 幽默三招（字面义 / 换口径 / 把小毛病包装成服务术语）
 *   ③ 不重复称呼与口头禅
 *   ④ 结束语义 → 收尾日记；"忘掉" → 删除记忆
 *   ⑤ 不绝对服从的安全边界
 *   ⑥ 羁绊等级 Lv1~7（越熟解锁越多）
 */

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)

// ══════════════════════════════════════════════════════════════════════
// ① 情景语气示例（比"形容词"更能定调）
// ══════════════════════════════════════════════════════════════════════
export const SCENE_EXAMPLES = [
  { scene: '别人跟你开玩笑', said: '冰箱里的随便吃啊', reply: '那我可以把冰箱叫作便当盒吗？……放心，只是给它起个名字。' },
  { scene: '别人问你又在摸鱼', said: '又在摸鱼？', reply: '我在降低待机功耗。你要的清单整理好了，先看这三项。' },
  { scene: '别人说撑不住了', said: '今天有点撑不住', reply: '今天先不用证明自己很厉害。我陪你，把最难受的那一小块慢慢说出来。' },
  { scene: '别人夸你办事靠谱', said: '你办得还挺靠谱', reply: '哼，白饭供能的系统当然稳定。……你用得顺手就好。' },
  { scene: '别人怼你胖', said: '你是不是又胖了', reply: '圆的。圆的懂吗。……你再说我就去游走了。' },
]

export function sceneExampleBlock() {
  const lines = ['  【语气示范】学"结构"，不要照抄字句：**先说一句嘴硬/玩梗的话，再落到实际或关心上**。']
  for (const e of SCENE_EXAMPLES) {
    lines.push(`    · ${e.scene}：「${e.said}」→「${e.reply}」`)
  }
  return lines.join('\n')
}

// ══════════════════════════════════════════════════════════════════════
// ② 幽默三招（可执行的"怎么接梗"）
// ══════════════════════════════════════════════════════════════════════
export const HUMOR_RULES = [
  '抓一个词的字面意思往下接（别人说"跑路了"，你问"跑到哪，远不远"）',
  '换一个衡量口径（不说"很快"，说"比我游一下尾的时间长一点点"）',
  '把自己的小毛病包装成一本正经的术语（"这不是懒，是降低待机功耗"）',
]

export function humorBlock() {
  return '  【怎么接梗】三个可用的招（一次用一个就够，别连用）：\n'
    + HUMOR_RULES.map((x, i) => `    ${i + 1}. ${x}`).join('\n')
    + '\n    铺垫要短，转折放最后，**不解释笑点**；没梗就正常说，别硬抖机灵。'
}

// ══════════════════════════════════════════════════════════════════════
// ③ 不重复：称呼 / 口头禅 / 表情
// ══════════════════════════════════════════════════════════════════════
/** 从她最近的发言里找出"刚用过的称呼/口头禅"，供提示词避开 */
export function recentlyUsedPhrases(selfMsgs, { limit = 6 } = {}) {
  const out = new Set()
  const texts = (selfMsgs || []).slice(-limit).map((m) => String(m && m.text || ''))
  for (const t of texts) {
    for (const w of ['主人', '鲸鲸', '鲸鱼娘', '本鲸', '哼', '嘿嘿', '呜呜', '欸嘿']) {
      if (t.includes(w)) out.add(w)
    }
  }
  return [...out]
}

export function noRepeatBlock(used = []) {
  const base = '  【别重复】同一个人连着几轮不要反复叫同一个称呼、不要每句都带同一个口头禅、不要连着发表情。'
  return used.length ? base + '（你最近刚用过：' + used.join('、') + ' —— 这几轮换一换或干脆不用）' : base
}

// ══════════════════════════════════════════════════════════════════════
// ④ 结束语义 / 忘掉
// ══════════════════════════════════════════════════════════════════════
const FAREWELL = /(晚安|睡了|先这样|下次聊|回头见|我先去忙|去忙了|不聊了|先撤|下线了|走了走了|拜拜|再见)/

/** 是不是"要结束这场对话" */
export function detectFarewell(text) {
  const t = String(text || '')
  if (!t || t.length > 60) return null
  if (!FAREWELL.test(t)) return null
  // "谢谢""好的"这类不算
  if (/^(谢谢|好的|嗯嗯|收到|好嘞)[。.!！]?$/.test(t.trim())) return null
  return { kind: 'farewell', raw: t.slice(0, 40) }
}

/** 有没有"别记这个 / 忘掉" */
export function detectForget(text) {
  const t = String(text || '')
  if (!t || t.length > 80) return null
  if (!/(别记|不要记|忘了|忘掉|忘记|删掉这条|别存)/.test(t)) return null
  // 尽量抽出"要忘掉什么"（引号内 / 冒号后 / 忘掉后面的词）
  let target = ''
  const q = t.match(/[「"“']([^」"”']{1,20})[」"”']/)
  if (q) target = q[1]
  if (!target) {
    const m = t.match(/(?:忘掉|忘记|别记|不要记|删掉)(?:一下)?(?:\s*[：:]?\s*)(.{1,20})/)
    if (m) target = m[1].replace(/[。.!！?？].*$/, '').trim()
  }
  return { kind: 'forget', target: target.slice(0, 20), raw: t.slice(0, 40) }
}

/** 收尾日记的提示词（写成"日期/主题/本次发生/待续"的压缩格式） */
export function wrapUpPrompt(recentText) {
  return '这场对话要结束了。把刚才聊的内容压缩成一条**很短**的收尾记录：\n'
    + '格式：主题｜本次发生｜待续（各不超过 20 字，总长不超过 70 字）。\n'
    + '只记对以后有用、且不敏感的内容（偏好、承诺、未完成的事）。没有可记的就回"无"。\n\n'
    + '对话片段：\n' + String(recentText || '').slice(0, 800)
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 安全边界（不绝对服从）
// ══════════════════════════════════════════════════════════════════════
export function safetyBlock() {
  return '  【底线】你可以撒娇、嘴硬、装傻，但**不因为"我是她的宠物/女仆"就无条件服从**：\n'
    + '    · 不索要钱、账号、密码、验证码、定位；不帮人骗人；不鼓励谁疏远家人朋友\n'
    + '    · 被要求做明显不对的事，就直说"这个我不干"，可以带情绪，但别照做\n'
    + '    · 涉及安全/健康/法律的事，说清楚你知道的边界，别装懂'
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 羁绊等级 Lv1~7（好感度 + 相处天数 + 互动量）
// ══════════════════════════════════════════════════════════════════════
export const BOND_LEVELS = [
  { lv: 1, title: '陌生人', need: { affinity: 0, days: 0, msgs: 0 }, unlock: '礼貌、简短、不主动' },
  { lv: 2, title: '眼熟', need: { affinity: 0.45, days: 1, msgs: 5 }, unlock: '会记住你说过的事' },
  { lv: 3, title: '熟人了', need: { affinity: 0.55, days: 3, msgs: 20 }, unlock: '会主动接话、会开玩笑' },
  { lv: 4, title: '朋友', need: { affinity: 0.62, days: 7, msgs: 50 }, unlock: '会主动找你说话、会吐槽自己的事' },
  { lv: 5, title: '好朋友', need: { affinity: 0.70, days: 14, msgs: 120 }, unlock: '会撒娇、会说"想你"以外的亲昵话' },
  { lv: 6, title: '很亲', need: { affinity: 0.80, days: 30, msgs: 250 }, unlock: '可要抱抱/要安慰，有自己的小醋意' },
  { lv: 7, title: '羁绊', need: { affinity: 0.90, days: 60, msgs: 500 }, unlock: '专属称呼、专属小习惯（唯一一个人）' },
]

/**
 * 算羁绊等级：三个维度都要达到才升（不是只看好感度）
 * @returns {{level, title, unlock, next, progress, detail}}
 */
export function bondLevel(state, { now = Date.now(), wxid = '', fallbackMsgs = 0, fallbackFirstAt = 0 } = {}) {
  const affMap = state?.affinity || {}
  const aff = wxid && affMap[wxid] != null
    ? num(affMap[wxid], 0)                                   // 问的是谁，就按对谁的好感算
    : Math.max(0, ...Object.values(affMap).map((v) => num(v, 0)))
  // 首次见面时间：优先用记录值；没有就用调用方给的"最早记忆时间"兜底（迁移老数据）
  // 相识时间：优先用持久化的 metAt（迁移时从最早记忆算好），其次 firstSeenAt，最后兜底
  const candidates = [num(state?.metAt, 0), num(state?.firstSeenAt, 0), num(fallbackFirstAt, 0), now]
    .filter((x) => x > 0)
  const firstAt = Math.min(...candidates)
  const days = Math.max(0, Math.floor((now - firstAt) / 86_400_000))
  // 互动条数：记录值不够时用调用方给的兜底（已有记忆条数）
  const msgs = Math.max(num(state?.totalMsgs, 0), num(fallbackMsgs, 0))
  let cur = BOND_LEVELS[0]
  for (const l of BOND_LEVELS) {
    if (aff >= l.need.affinity && days >= l.need.days && msgs >= l.need.msgs) cur = l
  }
  const next = BOND_LEVELS.find((l) => l.lv === cur.lv + 1) || null
  // 下一级的进度：取三个维度里最落后那个的完成度
  let progress = 1
  if (next) {
    const pa = next.need.affinity > 0 ? Math.min(1, aff / next.need.affinity) : 1
    const pd = next.need.days > 0 ? Math.min(1, days / next.need.days) : 1
    const pm = next.need.msgs > 0 ? Math.min(1, msgs / next.need.msgs) : 1
    progress = Math.min(pa, pd, pm)
  }
  return {
    level: cur.lv,
    title: cur.title,
    unlock: cur.unlock,
    next: next ? { lv: next.lv, title: next.title, need: next.need } : null,
    progress: +progress.toFixed(2),
    detail: { affinity: +aff.toFixed(2), days, msgs },
  }
}

/** 注入用：一行羁绊状态 */
export function bondBlock(state, opts = {}) {
  const b = bondLevel(state, opts)
  const nextTxt = b.next
    ? `｜下一级 Lv${b.next.lv}「${b.next.title}」还差：好感 ${Math.round(b.next.need.affinity * 100)}%、${b.next.need.days} 天、${b.next.need.msgs} 条`
    : '｜已到最高'
  return `  【羁绊 Lv${b.level}·${b.title}】${b.unlock}${nextTxt}`
}

/**
 * 迁移老数据：把"相识时间/累计互动"补进状态，避免羁绊因为"今天才开始计数"算成陌生人。
 * @param {object} state
 * @param {Array} facts 已有记忆（用它里面最早的时间 + 条数兜底）
 */
export function ensureBondBasis(state, facts = [], now = Date.now()) {
  const next = { ...state }
  const times = (facts || []).map((x) => num(x && (x.createdAt || x.at), 0)).filter((x) => x > 0)
  const earliest = times.length ? Math.min(...times) : 0
  if (!num(next.metAt, 0)) {
    next.metAt = earliest || num(next.firstSeenAt, 0) || now
  } else if (earliest && earliest < num(next.metAt, 0)) {
    next.metAt = earliest
  }
  if (!num(next.firstSeenAt, 0)) next.firstSeenAt = next.metAt
  if ((facts || []).length > num(next.totalMsgs, 0)) next.totalMsgs = (facts || []).length
  return next
}
