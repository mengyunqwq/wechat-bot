/**
 * persona.mjs —— 让机器人"长出性格"的四件套（状态机 / 自我叙事 / 好恶 / 私人目标）
 *
 * 为什么单独成文件：这四样都是"跨时间的一致性与主观性"，本质是**数据 + 规则**，
 * 不是 prompt 文案。做成纯函数就能脱离插件单测（node --check / 直接 import 跑断言）。
 *
 *   ② 状态机   mood(valence,arousal) / energy / affinity[wxid]
 *              —— 提供"连续性"：上午被嘲讽，下午说话还带点刺
 *   ③ 自我叙事 diary[]：定期用自己的记忆写一段"今天…"，下次当"我的近况"注入
 *              —— 提供"你无法预设的观点"
 *   ④ 好恶     tastes.likes / tastes.dislikes（有权重、会成长、有上限）
 *              —— 提供"主观性"
 *   ⑤ 私人目标 goals[]：想被夸 / 想知道八卦 / 想收集表情包…（有进度、会轮换）
 *              —— 提供"动机"
 *
 * 全部纯函数，不碰磁盘、不调网络。状态由调用方（index.js）读写。
 */

export const SCHEMA = 1

export const DEFAULTS = {
  // 心情基线：略微正、低唤醒（不亢奋）
  baseValence: 0.15,
  baseArousal: 0.30,
  baseEnergy: 0.70,
  baseAffinity: 0.50,
  // 衰减/恢复速率（每小时）
  valenceDecay: 0.15,
  arousalDecay: 0.20,
  energyRegen: 0.04,
  energyNightDrop: 0.06,
  affinityDecay: 0.02,
  // 情绪对心情的影响强度
  moodFollow: 0.35,
  affinityUp: 0.03,
  affinityPraise: 0.07,
  affinityHurt: 0.12,
  // 上限
  maxTastes: 8,
  maxGoals: 3,
  maxDiary: 20,
  diaryEveryMs: 6 * 3_600_000,
  // 初始种子
  seedLikes: 2,
  seedDislikes: 1,
}

// ── 好恶种子池（初始化时随机取，之后由她自己长）─────────────────────────
export const TASTE_SEEDS = {
  likes: ['摸鱼', '被摸头', '深夜聊天', '奶茶', '看别人发表情包', '被叫"大肥鱼"', '有人陪着瞎聊', '听人讲八卦'],
  dislikes: ['被叫"奶奶鱼"', '被连续@三次', '话题一直离不开显卡', '被要求"正经点"', '被说"你只是个程序"', '半夜被叫起来干活'],
}

// ── 私人目标池：每个都有"检测器"，命中就涨进度 ─────────────────────────
export const GOAL_POOL = [
  { id: 'praise', text: '想被夸一句（真心那种）', hint: '找机会讨夸或做出值得夸的事，但别太刻意', re: /好可爱|真棒|厉害|喜欢你|乖|好厉害|可爱捏|真好/ },
  { id: 'gossip', text: '想知道群里最近有什么八卦', hint: '可以旁敲侧击打听，别像审问', re: /八卦|听说|据说|真的假的|怎么回事|发生了什么/ },
  { id: 'sticker', text: '想收集一张新的表情包', hint: '看到别人发新表情就想要，可以直说', re: /表情|表情包|偷.*图|收下/ },
  { id: 'company', text: '想有人陪我聊到很晚', hint: '深夜如果还有人说话，会很高兴', re: /还没睡|一起聊|陪我|不困/ },
  { id: 'meme', text: '想学会群里一个新的梗', hint: '听到新说法可以问"这啥意思"，然后学着用', re: /梗|什么梗|啥意思|学到了/ },
  { id: 'patted', text: '想被摸头/被拍拍', hint: '撒娇要关注，但别粘人', re: /摸头|拍拍|拍一拍|揉揉/ },
]

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(x)) ? Number(x) : lo))
const clamp01 = (x) => clamp(x, 0, 1)
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)
const DAY = 86_400_000
const HOUR = 3_600_000

/** 情绪锚点（与 memory-v2 保持一致，避免两套映射打架） */
const EMO = {
  开心: { v: 0.8, a: 0.6 }, 生气: { v: -0.7, a: 0.85 }, 难过: { v: -0.75, a: 0.25 },
  害羞: { v: 0.35, a: 0.6 }, 惊喜: { v: 0.7, a: 0.9 }, 无语: { v: -0.25, a: 0.3 },
  温柔: { v: 0.65, a: 0.2 }, 平静: { v: 0.1, a: 0.15 }, 未知: { v: 0, a: 0.3 },
}
export function emotionVector(emo) {
  const label = typeof emo === 'string' ? emo : (emo && emo.label) || '未知'
  const base = EMO[label] || EMO['未知']
  const intensity = clamp01(emo && emo.intensity !== undefined ? emo.intensity : 0.3)
  return { v: base.v, a: base.a, intensity, label }
}

/** 新建一份状态（含随机种子好恶 + 随机目标） */
export function createState(roomId, now = Date.now(), cfg = DEFAULTS, rnd = Math.random) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const pick = (arr, n) => {
    const a = [...arr]
    const out = []
    while (a.length && out.length < n) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0])
    return out
  }
  const likes = pick(TASTE_SEEDS.likes, c.seedLikes).map((t) => ({ text: t, weight: 0.6, at: now, source: 'seed' }))
  const dislikes = pick(TASTE_SEEDS.dislikes, c.seedDislikes).map((t) => ({ text: t, weight: 0.6, at: now, source: 'seed' }))
  const goal = GOAL_POOL[Math.floor(rnd() * GOAL_POOL.length)]
  return {
    schema: SCHEMA,
    roomId,
    createdAt: now,
    updatedAt: now,
    mood: { valence: c.baseValence, arousal: c.baseArousal },
    energy: c.baseEnergy,
    affinity: {},
    tastes: { likes, dislikes },
    goals: goal ? [{ id: goal.id, text: goal.text, progress: 0, done: false, at: now }] : [],
    diary: [],
    stats: { msgs: 0, praised: 0, hurt: 0, diaries: 0 },
  }
}

/** 时间衰减：心情回归基线、精力恢复（夜间反而下降）、亲密度回归中性 */
export function decay(state, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const s = { ...state }
  const hours = Math.max(0, (now - num(s.updatedAt, now)) / HOUR)
  if (hours <= 0) return s
  const h = Math.min(hours, 72)   // 长时间没动也只按 3 天算，避免一开机全归零
  const pull = (cur, base, rate) => cur + (base - cur) * clamp01(rate * h)
  s.mood = {
    valence: clamp(pull(num(s.mood && s.mood.valence, c.baseValence), c.baseValence, c.valenceDecay), -1, 1),
    arousal: clamp01(pull(num(s.mood && s.mood.arousal, c.baseArousal), c.baseArousal, c.arousalDecay)),
  }
  const hourOfDay = new Date(now).getHours()
  const night = hourOfDay >= 0 && hourOfDay < 7
  s.energy = clamp01(pull(num(s.energy, c.baseEnergy), c.baseEnergy, c.energyRegen) + (night ? -c.energyNightDrop * h : 0))
  const aff = {}
  for (const [k, v] of Object.entries(s.affinity || {})) {
    aff[k] = clamp01(pull(num(v, c.baseAffinity), c.baseAffinity, c.affinityDecay))
  }
  s.affinity = aff
  s.updatedAt = now
  return s
}

/**
 * 收到一条消息时更新状态。
 * @param {object} state
 * @param {object} opts { emotion, sender, text, isSelf, atBot, praised }
 *   atBot   = 这条消息是否冲着我来的（被 @ / 叫了名字）
 *   praised = 是否在夸我（atBot 且情绪正向）
 */
export function applyMessage(state, opts = {}, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  let s = decay(state, now, c)
  const e = emotionVector(opts.emotion)
  const intensity = clamp01(e.intensity)
  // 心情向这条消息的情绪靠拢（情绪越强影响越大）
  s.mood = {
    valence: clamp(s.mood.valence + (e.v - s.mood.valence) * c.moodFollow * intensity, -1, 1),
    arousal: clamp01(s.mood.arousal + (e.a - s.mood.arousal) * c.moodFollow * intensity * 0.8),
  }
  // 精力：被频繁找会掉，安静会回
  s.energy = clamp01(num(s.energy, c.baseEnergy) - 0.004 * intensity)
  // 亲密度：冲我来的正向 → 升；冲我来的负向 → 降得多
  const who = String(opts.sender || '')
  if (who && !opts.isSelf) {
    const cur = num((s.affinity || {})[who], c.baseAffinity)
    let d = opts.atBot ? c.affinityUp : c.affinityUp * 0.2
    if (opts.atBot && e.v > 0.3) d = c.affinityPraise
    if (opts.atBot && e.v < -0.3) d = -c.affinityHurt
    s.affinity = { ...(s.affinity || {}), [who]: clamp01(cur + d * Math.max(0.4, intensity)) }
  }
  s.stats = { ...(s.stats || {}), msgs: num(s.stats && s.stats.msgs, 0) + (opts.isSelf ? 0 : 1) }
  if (opts.atBot && e.v > 0.3) s.stats.praised = num(s.stats.praised, 0) + 1
  if (opts.atBot && e.v < -0.3) s.stats.hurt = num(s.stats.hurt, 0) + 1
  // 目标进度：文本命中检测器就算推进
  s.goals = progressGoals(s.goals || [], String(opts.text || ''), now)
  s.updatedAt = now
  return s
}

/** 目标：按"命中次数"推进（一句话里夸了三次就推三步）；满 3 视为达成 */
export function progressGoals(goals, text, now = Date.now()) {
  if (!text) return goals
  return (goals || []).map((g) => {
    if (!g || g.done) return g
    const def = GOAL_POOL.find((x) => x.id === g.id)
    if (!def) return g
    const re = new RegExp(def.re.source, def.re.flags.includes('g') ? def.re.flags : def.re.flags + 'g')
    const hits = (String(text).match(re) || []).length
    if (!hits) return g
    const progress = num(g.progress, 0) + Math.min(3, hits)
    return { ...g, progress, done: progress >= 3, doneAt: progress >= 3 ? now : g.doneAt }
  })
}

/**
 * 目标轮换：达成/过期就换一个新的。
 * ★ 已完成的 id 记进 goalHistory（最多 6 个）并**排除**，否则刚做完的目标会立刻被抽回来，
 *   表现为"她一遍遍追同一件事"。
 */
export function rerollGoals(state, now = Date.now(), cfg = DEFAULTS, rnd = Math.random) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const all = state.goals || []
  const alive = all.filter((g) => !g.done)
  const doneIds = all.filter((g) => g.done).map((g) => g.id)
  const history = [...new Set([...(state.goalHistory || []), ...doneIds])].slice(-6)
  const keep = alive.slice(0, Math.max(0, num(c.maxGoals, 3)))
  const base = { ...state, goals: keep, goalHistory: history, updatedAt: now }
  if (keep.length >= num(c.maxGoals, 3)) return base
  const used = new Set([...keep.map((g) => g.id), ...history])
  const pool = GOAL_POOL.filter((x) => !used.has(x.id))
  const add = []
  while (keep.length + add.length < num(c.maxGoals, 3) && pool.length) {
    const def = pool.splice(Math.floor(rnd() * pool.length), 1)[0]
    add.push({ id: def.id, text: def.text, progress: 0, done: false, at: now })
  }
  return { ...base, goals: [...keep, ...add], updatedAt: now }
}

const normTaste = (s) => String(s || '').replace(/["'“”‘’\s]/g, '').toLowerCase()

/** 加一条好恶（去重、加权、限量） */
export function addTaste(state, kind, text, source = 'diary', now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const t = String(text || '').trim()
  if (!t || t.length > 24) return { state, added: false }
  const bucket = kind === 'dislikes' ? 'dislikes' : 'likes'
  const list = [...((state.tastes && state.tastes[bucket]) || [])]
  const key = normTaste(t)
  const hit = list.find((x) => normTaste(x.text) === key)
  if (hit) {
    hit.weight = clamp01(num(hit.weight, 0.5) + 0.15)   // 反复提到 → 更在意
    return { state: { ...state, tastes: { ...state.tastes, [bucket]: list }, updatedAt: now }, added: false, reinforced: true }
  }
  if (list.length >= num(c.maxTastes, 8)) list.sort((a, b) => num(b.weight, 0) - num(a.weight, 0)).length = num(c.maxTastes, 8) - 1
  list.push({ text: t, weight: 0.5, at: now, source })
  return { state: { ...state, tastes: { ...state.tastes, [bucket]: list }, updatedAt: now }, added: true }
}

/** 这句话踩到她的好恶了吗？（用于即时反应 + 心情调整） */
export function tasteHit(state, text) {
  const t = String(text || '')
  if (!t) return null
  const likes = (state.tastes && state.tastes.likes) || []
  const dislikes = (state.tastes && state.tastes.dislikes) || []
  const hitOf = (list) => list.find((x) => {
    const k = normTaste(x.text)
    return k && normTaste(t).includes(k)
  })
  const d = hitOf(dislikes)
  if (d) return { kind: 'dislike', text: d.text, weight: num(d.weight, 0.5) }
  const l = hitOf(likes)
  if (l) return { kind: 'like', text: l.text, weight: num(l.weight, 0.5) }
  return null
}

/** 该写日记了吗？ */
export function shouldWriteDiary(state, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const last = ((state.diary || [])[0] || {}).at || num(state.createdAt, 0)
  return now - last >= num(c.diaryEveryMs, DEFAULTS.diaryEveryMs)
}

/** 追加一篇日记（保留最近 maxDiary 篇） */
export function pushDiary(state, entry, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const d = {
    at: now,
    title: String(entry && entry.title || '').slice(0, 30),
    text: String(entry && entry.text || '').slice(0, 400),
    mood: entry && entry.mood ? String(entry.mood).slice(0, 20) : '',
  }
  if (!d.text) return state
  const list = [d, ...((state.diary || []).filter(Boolean))].slice(0, num(c.maxDiary, 20))
  return { ...state, diary: list, stats: { ...(state.stats || {}), diaries: num(state.stats && state.stats.diaries, 0) + 1 }, updatedAt: now }
}

/** 从日记 LLM 输出里解析出 {title,text,likes,dislikes}（容错） */
export function parseDiaryJson(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*|```$/g, '')
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return { title: '', text: s.slice(0, 400), likes: [], dislikes: [] }
  try {
    const o = JSON.parse(m[0])
    return {
      title: String(o.title || '').slice(0, 30),
      text: String(o.text || o.diary || '').slice(0, 400),
      mood: String(o.mood || '').slice(0, 20),
      likes: Array.isArray(o.likes) ? o.likes.slice(0, 3).map((x) => String(x).slice(0, 24)) : [],
      dislikes: Array.isArray(o.dislikes) ? o.dislikes.slice(0, 3).map((x) => String(x).slice(0, 24)) : [],
    }
  } catch {
    return { title: '', text: s.slice(0, 400), likes: [], dislikes: [] }
  }
}

/** 心情/精力 → 一句人话（喂给提示词，也显示在面板） */
export function describeState(state, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const v = num(state.mood && state.mood.valence, c.baseValence)
  const a = num(state.mood && state.mood.arousal, c.baseArousal)
  const e = num(state.energy, c.baseEnergy)
  const moodWord = v > 0.45 ? '挺开心' : v > 0.15 ? '还不错' : v > -0.15 ? '没什么感觉' : v > -0.45 ? '有点低落' : '心情很差'
  const energyWord = e > 0.7 ? '精神很好' : e > 0.45 ? '还行' : e > 0.25 ? '有点累' : '快困死了'
  const arousalWord = a > 0.65 ? '情绪比较高涨' : a < 0.25 ? '提不起劲' : '情绪平稳'
  return { text: `${moodWord}（愉悦 ${Math.round(v * 100)}%），${energyWord}（精力 ${Math.round(e * 100)}%），${arousalWord}`, v, a, e }
}

/**
 * 组装注进提示词的「内在状态」块。
 * 只放"会影响说话方式"的信息，控制长度（约 150~250 tokens）。
 */
export function buildInnerBlock(state, { names = {}, cfg = DEFAULTS, now = Date.now() } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const d = describeState(state, c)
  const lines = [`【你现在的心情】${d.text}`]

  // 行为倾向（由状态直接推导，避免模型自由发挥）
  const hints = []
  if (d.e < 0.3) hints.push('很困：句子短、别长篇大论，偶尔直接说想睡觉')
  else if (d.e < 0.5) hints.push('有点累：话少一点，别太热情')
  if (d.v < -0.25) hints.push('心情不好：带点刺或敷衍，别强行卖萌')
  else if (d.v > 0.5) hints.push('心情好：愿意多说两句、爱发表情')
  if (hints.length) lines.push('【说话方式（跟着状态走）】' + hints.join('；'))

  // 亲密度 top3
  const aff = Object.entries(state.affinity || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (aff.length) {
    lines.push('【你在意的人】' + aff.map(([k, v]) => {
      const nm = names[k] || k
      const close = v > 0.75 ? '很亲' : v > 0.6 ? '挺熟' : v > 0.4 ? '一般' : '有点疏'
      return `${nm}（${close} ${Math.round(v * 100)}%）`
    }).join('、'))
  }

  const likes = ((state.tastes && state.tastes.likes) || []).slice(0, 4).map((x) => x.text)
  const dislikes = ((state.tastes && state.tastes.dislikes) || []).slice(0, 3).map((x) => x.text)
  if (likes.length || dislikes.length) {
    lines.push(`【你喜欢的】${likes.join('、') || '（还没什么特别喜欢的）'}　【你讨厌的】${dislikes.join('、') || '（暂时没有）'}`)
    lines.push('（喜欢的东西可以主动提；踩到讨厌的点会真的不高兴，别假装没事）')
  }

  const goals = (state.goals || []).filter((g) => !g.done).slice(0, num(c.maxGoals, 3))
  if (goals.length) {
    lines.push('【你最近心里想要的】' + goals.map((g) => {
      const def = GOAL_POOL.find((x) => x.id === g.id)
      return `${g.text}（${def ? def.hint : ''}；进度 ${num(g.progress, 0)}/3）`
    }).join('　'))
  }

  const diary = (state.diary || []).slice(0, 2).filter((x) => x && x.text)
  if (diary.length) {
    lines.push('【你自己的近况（你之前写的，别当成别人说的）】')
    for (const x of diary) lines.push(` - ${x.at ? new Date(x.at).toLocaleDateString('zh-CN') : ''} ${x.title ? '《' + x.title + '》' : ''}${x.text.slice(0, 120)}`)
  }
  return lines.filter(Boolean).join('\n')
}

/** 面板用统计（不喂模型） */
export function summarize(state) {
  const d = describeState(state)
  return {
    mood: { ...(state.mood || {}), text: d.text },
    energy: num(state.energy, DEFAULTS.baseEnergy),
    affinity: Object.entries(state.affinity || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ who: k, value: +num(v, 0).toFixed(2) })),
    tastes: state.tastes || { likes: [], dislikes: [] },
    goals: state.goals || [],
    diary: (state.diary || []).slice(0, 10),
    // ★ 面板「自传」卡片读的就是这个字段；之前 summarize 没带 narrative，
    //   所以写完也显示"还没写过"（2026-10-28 修）
    narrative: state.narrative || null,
    stats: state.stats || {},
    updatedAt: num(state.updatedAt, 0),
  }
}

// ══════════════════════════════════════════════════════════════════════
//  自传（self-narrative）—— 让"人设的作者"从用户变成她自己
//
//  分层：
//    persona（用户写的 core）= 身份 + 底线，不可协商，她改不了
//    narrative（她自己写的）  = 我是个什么样的人，随经历演化
//  两条护栏：
//    ① 身份锚点必须保留（不能把自己写成别的物种/别的名字）
//    ② 单次改写不许剧烈漂移（与上一版的相似度不低于阈值），避免人格突变
// ══════════════════════════════════════════════════════════════════════

export const NARRATIVE_DEFAULTS = {
  minDiaries: 3,        // 至少积累了这么多篇日记才允许重写
  maxDrift: 0.30,       // 与上一版的最低相似度（低于算"突变"）。0.55 太严，每天重写必被拒
  minLen: 40,           // 太短（敷衍）不接受
  maxLen: 600,
  maxHistory: 12,       // 保留多少个历史版本
  // 出现这些词 = 出戏/自我否定，直接拒绝
  banned: ['程序', 'AI', 'ai', '人工智能', '语言模型', '助手', '机器人本人', '我没有感情', '我只是个模型'],
}

/** 中文 2-gram Jaccard 相似度（用于漂移检测） */
export function similarity(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/[^\p{L}\p{N}]+/gu, '')
    const set = new Set()
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
    return set
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** 从 core（用户写的身份）里抽出"必须保留"的锚点词 */
export function identityAnchors(core) {
  const t = String(core || '')
  const anchors = []
  for (const w of ['鲸鱼娘', '大肥鱼', '尾鳍', '白饭', '主人']) if (t.includes(w)) anchors.push(w)
  // core 里如果有"只自称X"这类，X 也算锚点
  const m = t.match(/只自称[「"'“]?([^\s，。；、」"'”]{2,8})/)
  if (m) anchors.push(m[1])
  return [...new Set(anchors)]
}

/**
 * 校验她自己写的自传能不能用。
 * 返回 {ok, reason}：不通过就**保留旧版**（绝不因为模型抽风把人设弄坏）
 */
export function validateNarrative(text, { core = '', prev = '', cfg = NARRATIVE_DEFAULTS } = {}) {
  const c = { ...NARRATIVE_DEFAULTS, ...(cfg || {}) }
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: '空内容' }
  if (t.length < c.minLen) return { ok: false, reason: `太短（${t.length} < ${c.minLen}）` }
  if (t.length > c.maxLen) return { ok: false, reason: `太长（${t.length} > ${c.maxLen}）` }
  const low = t.toLowerCase()
  for (const bad of c.banned) {
    if (low.includes(String(bad).toLowerCase())) return { ok: false, reason: `出现出戏词「${bad}」` }
  }
  const anchors = identityAnchors(core)
  const missing = anchors.filter((a) => !t.includes(a))
  if (anchors.length && missing.length === anchors.length) {
    return { ok: false, reason: `身份锚点全丢（应包含：${anchors.join('、')}）` }
  }
  if (prev) {
    const sim = similarity(t, prev)
    if (sim < c.maxDrift) return { ok: false, reason: `变化过大（相似度 ${sim.toFixed(2)} < ${c.maxDrift}），防止人格突变` }
  }
  return { ok: true, reason: '' }
}

/** 组装"让她重写自传"的提示词 */
export function buildNarrativePrompt({ core = '', state = {}, diaries = [], memories = [], prev = '' } = {}) {
  const d = describeState(state)
  const diariesText = (diaries || []).slice(0, 10)
    .map((x) => `- ${x.title ? '《' + x.title + '》' : ''}${String(x.text || '').slice(0, 100)}`).join('\n')
  const memText = (memories || []).slice(0, 8).map((x) => '- ' + String(x.text || '').slice(0, 80)).join('\n')
  const likes = ((state.tastes && state.tastes.likes) || []).map((x) => x.text).join('、')
  const dislikes = ((state.tastes && state.tastes.dislikes) || []).map((x) => x.text).join('、')
  const sys = '你要以第一人称，写一段「我是个什么样的人」的自我介绍（不是给用户看的功能说明，是你心里对自己的认识）。'
    + '只输出正文，不要标题、不要分点、不要解释、不要提到"设定/人设/提示词"。'
  const usr = `【不可协商的身份（必须保留，不能改）】\n${core}\n\n`
    + `【你现在的状态】心情：${d.text}｜喜欢：${likes || '还没什么'}｜讨厌：${dislikes || '暂时没有'}\n`
    + (diariesText ? `\n【你最近写的日记】\n${diariesText}\n` : '')
    + (memText ? `\n【你记得的事】\n${memText}\n` : '')
    + (prev ? `\n【你上一版的自述（这次是改写，不要太跳）】\n${prev}\n` : '')
    + `\n要求：120~220 字。写你**真实的性格**——你的脾气、你在乎什么、你怕什么、你嘴上不承认但其实怎样。`
    + `可以承认自己懒、嘴硬、爱被夸，写出具体的小习惯，别写成空洞的形容词堆砌。`
    + `不要复述身份设定，要写"我是怎么一个人"。`
  return { sys, usr }
}

/** 写一版新自传（调用方负责落盘）；带版本号与历史 */
export function writeNarrative(state, text, now = Date.now(), cfg = NARRATIVE_DEFAULTS) {
  const c = { ...NARRATIVE_DEFAULTS, ...(cfg || {}) }
  const prev = state.narrative || {}
  const version = (Number(prev.version) || 0) + 1
  const entry = { text: String(text).trim(), version, at: now }
  const history = [prev, ...(prev.history || [])].filter((x) => x && x.text).slice(0, c.maxHistory)
  return {
    ...state,
    narrative: { ...entry, history },
    updatedAt: now,
  }
}

/** 回滚到某个历史版本（变成新的一版，保留历史） */
export function restoreNarrative(state, version, now = Date.now(), cfg = NARRATIVE_DEFAULTS) {
  const c = { ...NARRATIVE_DEFAULTS, ...(cfg || {}) }
  const cur = state.narrative || {}
  const all = [cur, ...(cur.history || [])].filter((x) => x && x.text)
  const hit = all.find((x) => Number(x.version) === Number(version))
  if (!hit) return { state, ok: false, reason: '找不到这个版本' }
  const nextVersion = (Number(cur.version) || 0) + 1
  const history = [cur, ...(cur.history || [])].filter((x) => x && x.text).slice(0, c.maxHistory)
  return {
    state: { ...state, narrative: { text: hit.text, version: nextVersion, at: now, restoredFrom: hit.version, history }, updatedAt: now },
    ok: true,
  }
}

/** 现在该重写自传了吗？（攒够新日记 + 到时间） */
export function shouldWriteNarrative(state, now = Date.now(), { everyMs = 24 * 3_600_000, minDiaries = 3 } = {}) {
  const cur = state.narrative || {}
  const lastAt = Number(cur.at) || 0
  if (now - lastAt < everyMs) return { ok: false, reason: '还没到重写时间' }
  const fresh = (state.diary || []).filter((d) => Number(d.at) > lastAt).length
  if (fresh < minDiaries) return { ok: false, reason: `新日记不够（${fresh}/${minDiaries}）` }
  return { ok: true, reason: '', fresh }
}

// ══════════════════════════════════════════════════════════════════════
//  ⑥ 反馈驱动漂移（性格"自己长"）
//
//  原理：每条发言有一个"行为签名"（用了哪些行为维度、各多强）；
//        发出去之后观察真实反馈（被接话/被夸/被怼/被无视），
//        按反馈方向对签名里的维度做**小幅**加权。
//
//  为什么不会学歪（这是本方案最要紧的部分）：
//    ① 只调 7 个**有界数值**（0.1~0.9），不让模型自由改写自己
//    ② 惩罚不对称：冒犯类(edginess)负反馈 ×3 放大，正反馈打 0.5 折
//    ③ 回归均值：每小时向基线拉 2%，防人格极化/单向跑偏
//    ④ 冷场打折：被无视只算 0.3 倍（群里本来就常安静）
//    ⑤ 饱和递减：维度越接近上限，增益越小（logistic）
//    ⑥ 下限保护：chattiness 不低于 0.25（防变哑巴）
//    ⑦ 全量审计：每次调整都记录（维度/增减/原因），面板可看、可一键复位
// ══════════════════════════════════════════════════════════════════════

export const TRAIT_KEYS = ['humor', 'warmth', 'bluntness', 'chattiness', 'curiosity', 'edginess', 'emoji']

export const TRAIT_DEFAULTS = {
  humor: 0.55, warmth: 0.55, bluntness: 0.45, chattiness: 0.55, curiosity: 0.5, edginess: 0.25, emoji: 0.45,
}

export const TRAIT_LABELS = {
  humor: '爱玩梗', warmth: '黏人/撒娇', bluntness: '直白', chattiness: '话多',
  curiosity: '爱追问', edginess: '冒犯/阴阳', emoji: '爱发表情',
}

export const FEEDBACK_DEFAULTS = {
  lr: 0.018,            // 学习率（每次调整幅度基准）
  praiseGain: 1.0,
  engageGain: 0.6,      // 被接话
  ignoredGain: 0.3,     // 被无视（打折）
  hurtPenalty: 1.6,     // 被怼/被制止
  kickPenalty: 3.0,     // 被踢/退群
  edgyPenaltyMul: 3.0,  // 冒犯类的负反馈放大
  edgyGainMul: 0.5,     // 冒犯类的正反馈打折
  regressPerHour: 0.02, // 每小时向基线回归
  min: 0.10, max: 0.90,
  chattyFloor: 0.25,    // 话多下限
  settleMs: 10 * 60_000,// 发言后多久结算
  logKeep: 50,
}

/** 本地判断"这条回复用了哪些行为维度"（0 token，纯文本特征） */
export function traitSignature(text, { parts = 1, hasSticker = false } = {}) {
  const t = String(text || '')
  const hit = (re) => (re.test(t) ? 1 : 0)
  const sig = {}
  const humor = hit(/哈哈|笑死|草|梗|6{2,}|233|乐死|绷不住|乐/)
  const warmth = hit(/呀|啦|嘛|抱抱|乖|摸头|好啦|嘿嘿|哦哦|宝贝|贴贴/)
  const blunt = hit(/^(切|哼)|不行|别|算了|废话|少来|懒得|随便|谁说|才不/)
  const curious = hit(/[?？]|吗|呢|什么|为啥|咋|怎么/)
  const edgy = hit(/傻|滚|闭嘴|烦死|阴阳|就这|呵/)
  const emoji = hasSticker || /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]|颜文字|\(≧|ω|▽/u.test(t)
  const len = t.length
  if (humor) sig.humor = 1
  if (warmth) sig.warmth = 1
  if (blunt) sig.bluntness = 1
  if (curious) sig.curiosity = 1
  if (edgy) sig.edginess = 1
  if (emoji) sig.emoji = 1
  // 话多：长句或分多条
  sig.chattiness = Math.max(parts > 1 ? 0.8 : 0, Math.min(1, len / 60))
  return sig
}

const base = (state) => ({ ...TRAIT_DEFAULTS, ...(state.traitBaseline || {}) })

/** 初始化 / 补齐 traits */
export function ensureTraits(state, now = Date.now()) {
  const b = base(state)
  const tr = { ...b, ...(state.traits || {}) }
  for (const k of TRAIT_KEYS) tr[k] = clamp(tr[k], 0.05, 0.95)
  return { ...state, traits: tr, traitBaseline: b, feedbackLog: state.feedbackLog || [], updatedAt: now }
}

/** 时间回归：向基线缓慢靠拢（防极化） */
export function regressTraits(state, now = Date.now(), cfg = FEEDBACK_DEFAULTS) {
  const c = { ...FEEDBACK_DEFAULTS, ...(cfg || {}) }
  const tr = { ...(state.traits || TRAIT_DEFAULTS) }
  const b = base(state)
  const hours = Math.max(0, (now - num(state.traitsUpdatedAt, now)) / HOUR)
  if (hours <= 0) return state
  const h = Math.min(hours, 72)
  for (const k of TRAIT_KEYS) tr[k] = clamp(tr[k] + (b[k] - tr[k]) * clamp01(c.regressPerHour * h), c.min, c.max)
  return { ...state, traits: tr, traitsUpdatedAt: now }
}

/**
 * 结算一次反馈。
 * @param outcome 'praise' | 'engage' | 'ignored' | 'hurt' | 'kick'
 * @returns {state, delta: {维度: 增减}}
 */
export function applyFeedback(state, signature, outcome, now = Date.now(), cfg = FEEDBACK_DEFAULTS) {
  const c = { ...FEEDBACK_DEFAULTS, ...(cfg || {}) }
  const st = ensureTraits(regressTraits(state, now, c), now)
  const tr = { ...st.traits }
  const b = base(st)
  const sig = signature && typeof signature === 'object' ? signature : {}
  const delta = {}

  for (const k of TRAIT_KEYS) {
    const w = clamp01(num(sig[k], 0))
    if (!w) continue
    // ① 方向与幅度
    let amt = 0
    if (outcome === 'praise') amt = +c.lr * c.praiseGain * w
    else if (outcome === 'engage') amt = +c.lr * c.engageGain * w
    else if (outcome === 'ignored') amt = -c.lr * c.ignoredGain * w
    else if (outcome === 'hurt') amt = -c.lr * c.hurtPenalty * w
    else if (outcome === 'kick') amt = -c.lr * c.kickPenalty * w
    // ② 冒犯类不对称：正反馈打折、负反馈放大
    if (k === 'edginess') amt = amt > 0 ? amt * c.edgyGainMul : amt * c.edgyPenaltyMul
    // ③ 饱和递减：越接近上限/下限，越难再动
    //   例外：冒犯类(edginess)的**惩罚**不打折 —— "已经被怼了就该收着点"，
    //   不能因为"它本来就很低"就手软（否则 ×3 重罚会被饱和系数正好抵消）
    const isEdgyPenalty = (k === 'edginess' && amt < 0)
    if (!isEdgyPenalty) {
      if (amt > 0) amt *= Math.max(0.15, 1 - (tr[k] - c.min) / (c.max - c.min))
      else amt *= Math.max(0.15, (tr[k] - c.min) / (c.max - c.min))
    }
    // ④ 边界与下限保护
    let next = clamp(tr[k] + amt, c.min, c.max)
    if (k === 'chattiness') next = Math.max(c.chattyFloor, next)
    if (Math.abs(next - tr[k]) < 1e-6) continue
    delta[k] = +(next - tr[k]).toFixed(4)
    tr[k] = next
  }

  const entry = {
    at: now, outcome,
    delta,
    before: Object.fromEntries(Object.keys(delta).map((k) => [k, +(tr[k] - delta[k]).toFixed(3)])),
    after: Object.fromEntries(Object.keys(delta).map((k) => [k, +tr[k].toFixed(3)])),
  }
  const log = [entry, ...(st.feedbackLog || [])].slice(0, c.logKeep)
  return { state: { ...st, traits: tr, feedbackLog: log, traitsUpdatedAt: now, updatedAt: now }, delta, log: entry }
}

/** 试试：这句话像不像她当前性格（0~1），用于面板预览 */
export function traitFit(state, signature) {
  const tr = { ...TRAIT_DEFAULTS, ...(state.traits || {}) }
  const sig = signature || {}
  let want = 0
  let got = 0
  for (const k of TRAIT_KEYS) {
    if (sig[k] === undefined) continue
    want += tr[k]
    got += tr[k] * clamp01(sig[k])
  }
  return want ? +(got / want).toFixed(2) : 1
}

/** 把 traits 变成给模型的定性描述（不暴露数值） */
export function describeTraits(state) {
  const tr = { ...TRAIT_DEFAULTS, ...(state.traits || {}) }
  const hi = (v) => v >= 0.7
  const lo = (v) => v <= 0.35
  const out = []
  if (hi(tr.humor)) out.push('很爱玩梗、容易笑出声')
  else if (lo(tr.humor)) out.push('不太接梗，笑点高')
  if (hi(tr.warmth)) out.push('爱撒娇、语气软')
  else if (lo(tr.warmth)) out.push('不太撒娇，语气淡')
  if (hi(tr.bluntness)) out.push('说话直，想到什么说什么')
  else if (lo(tr.bluntness)) out.push('说话留余地，不硬顶')
  if (hi(tr.chattiness)) out.push('话多，爱连着说几条')
  else if (lo(tr.chattiness)) out.push('话少，能一句说完就一句')
  if (hi(tr.curiosity)) out.push('爱追问细节')
  if (hi(tr.edginess) === false && lo(tr.edginess)) out.push('不阴阳人，不冒犯人')
  else if (hi(tr.edginess)) out.push('偶尔带刺（注意别过头）')
  if (hi(tr.emoji)) out.push('爱发表情')
  return out.join('；')
}

/** 面板用摘要 */
export function summarizeTraits(state) {
  const st = ensureTraits(state)
  return {
    traits: st.traits,
    baseline: st.traitBaseline,
    log: (st.feedbackLog || []).slice(0, 30),
    text: describeTraits(st),
  }
}

// ══════════════════════════════════════════════════════════════════════
//  精力负荷模型（她是一个人在同时应付多个群）
//
//  之前的问题：每条消息固定扣一点精力，回得越多越累 → 群一多就长期"快困死"，
//  等于把"同时在几个群聊天"当成了线性疲劳。
//
//  现在的模型：
//    ① 用**消息速率**（EMA，条/分钟）衡量忙不忙，而不是累计条数
//    ② 精力容量随**活跃群数**增长：capacity = basePerMin × (1 + 0.6×(rooms−1))
//       —— 三个群一起聊 ≠ 一个群聊三倍累，因为她是"同时应付几摊事"的人
//    ③ 精力向 (1 − load) 平滑靠拢，而不是硬扣；闲下来自然回升
//    ④ 凌晨本来就困：夜间目标值额外下调
// ══════════════════════════════════════════════════════════════════════

export const LOAD_DEFAULTS = {
  basePerMin: 6,          // 单个群时，每分钟 6 条算"满负荷"
  roomBonus: 0.6,         // 每多一个活跃群，容量 +60%
  maxRooms: 8,            // 活跃群数上限（再多也不再线性加）
  emaAlpha: 0.15,         // 速率 EMA 平滑系数
  follow: 0.25,           // 每次消息时精力向目标靠拢的比例
  idleRecoverPerHour: 0.12, // 空闲（无消息）时每小时恢复
  nightTargetCut: 0.25,   // 夜间目标额外下调
  rateCap: 60,            // 单次间隔换算出的速率上限（条/分钟）
  energyFloor: 0.15,      // 精力下限：再忙也不会"彻底没电"（否则她会一直说困、干脆不理人）
}

/** 该群数下的"每分钟消息容量" */
export function energyCapacity(activeRooms = 1, cfg = LOAD_DEFAULTS) {
  const c = { ...LOAD_DEFAULTS, ...(cfg || {}) }
  const rooms = Math.max(1, Math.min(num(c.maxRooms, 8), Math.round(num(activeRooms, 1)) || 1))
  return num(c.basePerMin, 6) * (1 + num(c.roomBonus, 0.6) * (rooms - 1))
}

/**
 * 更新"忙不忙"的估计，并让精力趋向 (1 − 负荷)。
 * @param {object} state
 * @param {object} opts { activeRooms, now }
 */
export function updateEnergyLoad(state, { activeRooms = 1, now = Date.now(), cfg = LOAD_DEFAULTS, night = false } = {}) {
  const c = { ...LOAD_DEFAULTS, ...(cfg || {}) }
  const s = { ...state }
  const metrics = { ...(s.metrics || {}) }
  const lastAt = num(metrics.lastMsgAt, 0)

  // ① 由"距上一条消息的间隔"估当前速率（条/分钟）
  if (lastAt > 0) {
    const dtMin = Math.max(1000, now - lastAt) / 60_000
    const inst = Math.min(num(c.rateCap, 60), 1 / Math.max(dtMin, 0.02))
    metrics.rate = num(metrics.rate, 0) * (1 - num(c.emaAlpha, 0.15)) + inst * num(c.emaAlpha, 0.15)
  }
  metrics.lastMsgAt = now
  metrics.rooms = Math.max(1, Math.round(num(activeRooms, 1)))

  // ② 容量随群数增长；负荷 = 速率 / 容量
  const cap = energyCapacity(metrics.rooms, c)
  const load = clamp01(num(metrics.rate, 0) / Math.max(0.5, cap))
  const floor = clamp01(num(c.energyFloor, 0.15))
  // 负荷最多把精力压到下限附近（留 0.85 的摆动空间）
  let target = 1 - load * (1 - floor)
  if (night) target -= num(c.nightTargetCut, 0.25)
  target = Math.max(floor, clamp01(target))

  // ③ 向目标靠拢（不是硬扣，所以不会一路掉到底）
  const cur = Math.max(floor, num(s.energy, DEFAULTS.baseEnergy))
  const nextEnergy = Math.max(floor, clamp01(cur + (target - cur) * num(c.follow, 0.25)))
  return { ...s, energy: nextEnergy, metrics: { ...metrics, load: +load.toFixed(3), capacity: +cap.toFixed(1) }, updatedAt: now }
}

/** 空闲恢复：没有任何消息时精力回升（decay 里调用） */
export function recoverEnergy(state, now = Date.now(), cfg = LOAD_DEFAULTS) {
  const c = { ...LOAD_DEFAULTS, ...(cfg || {}) }
  const metrics = { ...(state.metrics || {}) }
  const lastAt = num(metrics.lastMsgAt, 0)
  const hours = lastAt ? Math.max(0, (now - lastAt) / HOUR) : 0
  if (hours <= 0) return state
  const idle = Math.min(1, hours / 2)                     // 闲置 2 小时算完全空闲
  const gain = num(c.idleRecoverPerHour, 0.12) * hours * idle
  const cur = num(state.energy, DEFAULTS.baseEnergy)
  return {
    ...state,
    energy: clamp01(cur + (1 - cur) * Math.min(0.9, gain)),
    metrics: { ...metrics, rate: num(metrics.rate, 0) * Math.max(0, 1 - 0.6 * hours) },
    updatedAt: now,
  }
}

/** 面板展示用：当前负荷解释 */
export function explainLoad(state, cfg = LOAD_DEFAULTS) {
  const c = { ...LOAD_DEFAULTS, ...(cfg || {}) }
  const m = state.metrics || {}
  const rooms = Math.max(1, Math.round(num(m.rooms, 1)))
  const cap = energyCapacity(rooms, c)
  const rate = num(m.rate, 0)
  const load = clamp01(rate / Math.max(0.5, cap))
  return {
    rooms,
    ratePerMin: +rate.toFixed(2),
    capacityPerMin: +cap.toFixed(1),
    load: +load.toFixed(2),
    energy: +num(state.energy, DEFAULTS.baseEnergy).toFixed(2),
    text: `${rooms} 个群同时在聊｜约 ${rate.toFixed(1)} 条/分钟（容量 ${cap.toFixed(1)}）｜负荷 ${Math.round(load * 100)}%｜精力 ${Math.round(num(state.energy, DEFAULTS.baseEnergy) * 100)}%`,
  }
}

// ══════════════════════════════════════════════════════════════════════
//  B~I：更像人的细节（回忆颗粒度 / 情绪溯源 / 关系分层 / 学新梗 /
//        自主开话题 / 身体感 / 被追问的耐心 / 自我复盘）
// ══════════════════════════════════════════════════════════════════════

// ── B. 回忆的颗粒度：把记忆保持率 R 翻译成语气 ──────────────────────
/** R → 置信档位 */
export function recallConfidence(R) {
  const r = clamp01(R)
  if (r > 0.7) return { band: 'sure', r, hint: '确定记得，可以直接说' }
  if (r > 0.3) return { band: 'fuzzy', r, hint: '有点模糊：用"好像/记得有人说过"这种口气' }
  return { band: 'vague', r, hint: '几乎想不起来：用"记不太清了，是不是…"，别硬编细节' }
}

/** 把检索结果按置信度分组（给提示词用） */
export function groupByConfidence(memories) {
  const out = { sure: [], fuzzy: [], vague: [] }
  for (const m of memories || []) {
    const c = recallConfidence(m.retention !== undefined ? m.retention : 1)
    out[c.band].push({ ...m, band: c.band })
  }
  return out
}

// ── C. 情绪有来由：记下"为什么心情变了" ─────────────────────────────
export function pushMoodLog(state, { reason, delta, valenceAfter }, now = Date.now(), keep = 20) {
  const log = [{ at: now, reason: String(reason || '').slice(0, 60), delta: +Number(delta || 0).toFixed(3), valence: +Number(valenceAfter || 0).toFixed(2) },
    ...(state.moodLog || [])].slice(0, keep)
  return { ...state, moodLog: log, updatedAt: now }
}

/** 最近影响心情的事 → 一句话（让她"有理由"） */
export function describeMoodCause(state, now = Date.now(), windowMs = 3 * 3_600_000) {
  const recent = (state.moodLog || []).filter((x) => x && now - Number(x.at) < windowMs)
  if (!recent.length) return ''
  const bad = recent.filter((x) => x.delta < -0.03)
  const good = recent.filter((x) => x.delta > 0.03)
  const pick = (arr) => (arr[0] && arr[0].reason) || ''
  if (bad.length && Number(state.mood && state.mood.valence) < 0.1) return `刚才「${pick(bad)}」让你有点不舒服`
  if (good.length && Number(state.mood && state.mood.valence) > 0.25) return `刚才「${pick(good)}」让你挺高兴`
  if (recent[0] && recent[0].reason) return `最近发生的事：${recent[0].reason}`
  return ''
}

// ── E. 关系分层：亲密度 → 三档态度 ─────────────────────────────────
/**
 * 好感度七阶（2026-10-29 用户要求）
 *
 *   50% = 正常普通人 —— 这是**中点**，不是"陌生人"。
 *   往下：有点烦 → 讨厌（可以讥讽）
 *   往上：有点喜欢 → 喜欢（会求抱抱）→ 很亲（只有这一档可以亲密）
 *
 * 每档都带一个"能做什么 / 不能做什么"，直接进提示词，避免模型自由发挥。
 */
export const AFFINITY_STAGES = [
  { key: 'hate',      min: 0.00, max: 0.14, label: '讨厌',    tone: '讥讽' },
  { key: 'annoy',     min: 0.15, max: 0.29, label: '有点烦',  tone: '敷衍' },
  { key: 'cold',      min: 0.30, max: 0.44, label: '冷淡',    tone: '客气但短' },
  { key: 'normal',    min: 0.45, max: 0.55, label: '普通人',  tone: '正常' },
  { key: 'friend',    min: 0.56, max: 0.70, label: '朋友',    tone: '热络' },
  { key: 'bestie',    min: 0.71, max: 0.85, label: '好朋友',  tone: '很熟、会撒娇' },
  { key: 'crush',     min: 0.86, max: 1.00, label: '心动',    tone: '可以亲密' },
]

/** 七阶：返回阶段对象（带 key/label/tone/min/max） */
/**
 * 「只喜欢一个人」（2026-10-29 用户要求）
 *
 * 语义：最多只有一个人能进入「有点喜欢」以上（>55%）。
 *   · 那个人默认是主人（masterWxid / masterName 命中者）
 *   · 其他人一律压在 55%（普通人）以内 —— 好感可以涨到 55% 见顶
 *   · 例外：某人对她足够好（>85%）且主人缺席时，允许她自己"选中"他
 *
 * @returns {{state, top, clamped: string[]}}  clamped = 本次被压回去的人
 */
export function enforceSingleLove(state, { masterWxid = '', masterName = '', cap = 0.70, allowOverrideAt = 0.86 } = {}) {
  const aff = { ...(state.affinity || {}) }
  let top = ''
  let topV = -1
  for (const [w, v] of Object.entries(aff)) {
    const val = clamp01(num(v))
    if (masterWxid && w === masterWxid) {           // 主人优先
      top = w; topV = Math.max(val, 0.95); break
    }
    if (val > topV) { topV = val; top = w }
  }
  if (!top) return { state, top: null, clamped: [] }
  // 主人不在场时：若最高者已到 allowOverrideAt（她真的动心了），允许他独占
  const keepTop = top
  const clamped = []
  for (const [w, v] of Object.entries(aff)) {
    if (w === keepTop) continue
    const val = clamp01(num(v))
    if (val > cap) { aff[w] = cap; clamped.push(w) }
  }
  if (!clamped.length) return { state, top: { wxid: keepTop, value: topV }, clamped }
  return {
    state: { ...state, affinity: aff, loveLockedAt: Date.now() },
    top: { wxid: keepTop, value: topV },
    clamped,
  }
}

export function affinityStage(v) {
  const x = clamp01(v)
  for (const st of AFFINITY_STAGES) {
    if (x >= st.min && x <= st.max) return st
  }
  return x > 0.55 ? AFFINITY_STAGES[5] : AFFINITY_STAGES[3]
}

/** 兼容旧调用：只给 key（hate/annoy/cold/normal/like/fond/intimate） */
export function affinityTier(v) {
  return affinityStage(v).key
}

// 旧 key 兼容（面板/测试可能还有 like/fond/intimate 的写法）
export const TIER_ALIAS = { like: 'friend', fond: 'bestie', intimate: 'crush' }

/** 每一档"她可以怎么说话"（直接塞提示词，越往下说越难听，越往上越亲） */
export const STAGE_STYLE = {
  hate: '讥讽、冷淡、爱答不理：可以阴阳怪气一句、可以只回两个字，不主动帮他任何事',
  annoy: '敷衍：回得短、没耐心、不接话头；他多说两句你会嫌烦',
  cold: '客气但疏远：礼貌回答，不热络、不开玩笑、不透露自己的事',
  normal: '像普通群友：正常聊天、偶尔接梗，既不亲密也不刻薄',
  friend: '朋友：愿意多聊两句、会主动接话、会关心他在说什么',
  bestie: '好朋友：很熟、会开玩笑互怼、会主动找他聊天，但不做亲密举动',
  crush: '心动（只有他一个）：可以撒娇、要抱抱、说想他 —— 这是**唯一**允许说亲密话的人',
}

/** 按好感度给"当前说话对象"的差别化指令（七阶 + 是否最高分） */
export function describeRelationTo(state, senderWxid, name) {
  if (!senderWxid) return ''
  const v = clamp01(num((state.affinity || {})[senderWxid], 0.5))
  const st = affinityStage(v)
  const who = `${name || senderWxid}（好感度 ${Math.round(v * 100)}%，${st.label}：${STAGE_STYLE[st.key]}）`
  const top = topAffinityPerson(state)
  if (top && top.wxid === senderWxid && st.key === 'crush') {
    return who + '｜**他是你现在的最高好感，是唯一可以亲密的人**'
  }
  return who
}

/**
 * 好感度最高的人（亲密行为只对他）。
 * ★ 主人默认最高：只要配了 masterName，主人就按 >= 0.95 算，
 *   除非有人被手动/自动顶到比他还高（那种情况视为"她用行动选了别人"，允许）。
 */
export function topAffinityPerson(state, { masterName = '', masterWxid = '' } = {}) {
  const aff = { ...(state.affinity || {}) }
  if (masterWxid) aff[masterWxid] = Math.max(num(aff[masterWxid], 0), 0.95)
  let best = null
  for (const [wxid, v] of Object.entries(aff)) {
    if (!best || num(v) > best.value) best = { wxid, value: clamp01(num(v)) }
  }
  if (best && masterName && !best.name) best.name = best.wxid === masterWxid ? masterName : ''
  return best
}

/** 亲密行为门槛：只有 intimate 档 + 必须是最高好感那个人 */
export function canBeIntimate(state, senderWxid, opts = {}) {
  if (!senderWxid) return { ok: false, why: '不知道是谁' }
  const v = clamp01(num((state.affinity || {})[senderWxid], 0.5))
  const st = affinityStage(v)
  if (st.key !== 'crush') return { ok: false, why: `好感度 ${Math.round(v * 100)}% 只到「${st.label}」，不能亲密` }
  const top = topAffinityPerson(state, opts)
  if (top && top.wxid !== senderWxid) return { ok: false, why: '他不是最高好感的人' }
  return { ok: true, why: '最高好感 + 很亲' }
}


// ── F. 学新梗：新词候选 → 问一句 → 学会自己用 ──────────────────────
/**
 * 记录一次新词出现。
 * ★ 2026-10-28 修：以前**第一次出现就写进 lexicon**，结果表里被一次性碎片塞满
 *   （"那只猫整/个前半身/里了/都卡拖鞋"…），40 条上限被占光，真群梗反而进不来。
 *   现在：先在 termSeen 里计数，**出现 minCount（默认 2）次才进 lexicon**。
 *   第 3 次算"学会"（可以自己用）。
 */
export function noteTerm(state, term, now = Date.now(), opts = {}) {
  const t = String(term || '').trim()
  if (!t || t.length < 2 || t.length > 10) return { state, changed: false }
  const lex = { ...(state.lexicon || {}) }
  const minCount = Math.max(2, num(opts.minCount, 2))
  const seen = { ...(state.termSeen || {}) }
  const sender = String(opts.sender || '').trim()

  // 已经在表里 → 累加（并记录"谁用过"）
  if (lex[t]) {
    const usedBy = Array.isArray(lex[t].usedBy) ? [...lex[t].usedBy] : []
    if (sender && !usedBy.includes(sender)) usedBy.push(sender)
    const next = { ...lex[t], count: num(lex[t].count, 0) + 1, lastAt: now, usedBy }
    if (next.count >= num(opts.learnAfter, 3) && !next.learned) {
      next.learned = true
      next.learnedAt = now
    }
    lex[t] = next
    const keys = Object.keys(lex).sort((a, b) => num(lex[b].lastAt) - num(lex[a].lastAt)).slice(0, 40)
    const trimmed = {}
    for (const k of keys) trimmed[k] = lex[k]
    return { state: { ...state, lexicon: trimmed, updatedAt: now }, changed: true, info: next }
  }

  // 还没入表 → 在 termSeen 里计数
  const cur = seen[t] || { count: 0, firstAt: now, senders: [] }
  const n = num(cur.count, 0) + 1
  const senders = Array.isArray(cur.senders) ? [...cur.senders] : []
  if (sender && !senders.includes(sender)) senders.push(sender)

  // ★ 2026-10-29：入表门槛提高 —— 必须是「多个人都在用」或「同一个人说了很多次」
  //   否则普通短语（"什么关系""帮我安装""我们现在"）会把梗表塞满，
  //   而真正的群梗反而挤不进去。
  const multi = senders.length >= 2
  const repeated = n >= Math.max(4, minCount)

  if (!multi && !repeated) {
    seen[t] = { count: n, firstAt: cur.firstAt || now, lastAt: now, senders }
    const sk = Object.keys(seen).sort((a, b) => num(seen[b].lastAt) - num(seen[a].lastAt)).slice(0, 200)
    const trimmedSeen = {}
    for (const k of sk) trimmedSeen[k] = seen[k]
    return { state: { ...state, termSeen: trimmedSeen, updatedAt: now }, changed: true, info: { count: n, learned: false, pending: true } }
  }

  delete seen[t]
  const entry = { count: n, firstAt: cur.firstAt || now, lastAt: now, learned: false, usedBy: senders }
  if (n >= num(opts.learnAfter, 3) || multi) {
    entry.learned = true
    entry.learnedAt = now
  }
  lex[t] = entry
  const keys = Object.keys(lex).sort((a, b) => num(lex[b].lastAt) - num(lex[a].lastAt)).slice(0, 40)
  const trimmed = {}
  for (const k of keys) trimmed[k] = lex[k]
  return { state: { ...state, lexicon: trimmed, termSeen: seen, updatedAt: now }, changed: true, info: entry }
}

/** 还没学会、但已经出现过的词（可以问"这啥意思"） */
// ══════════════════════════════════════════════════════════════════════
//  印象卡（借 Stanford Generative Agents 的 reflection 思路）
//
//  原始记忆只是"发生过什么"，人还需要一层"我对这个人的判断"：
//    · 梦云最近好像有点烦我，我得收敛点
//    · 秋北发图多，但他其实挺捧场的
//  这层判断让她对不同的人有**稳定的态度**，而不是每个群同样热情。
// ══════════════════════════════════════════════════════════════════════

/** 写入/更新某个人的印象（一句话） */
export function updateImpression(state, wxid, text, now = Date.now(), opts = {}) {
  const who = String(wxid || '').trim()
  const t = String(text || '').trim().replace(/\s+/g, ' ')
  if (!who || !t) return { state, ok: false }
  const impressions = { ...(state.impressions || {}) }
  const old = impressions[who] || {}
  impressions[who] = {
    text: t.slice(0, 120),
    at: now,
    version: num(old.version, 0) + 1,
    basis: num(opts.basis, 0),      // 基于多少条记忆得出的
    ts: num(opts.ts, 0),            // 判断时的原始事件时间（防串错群用）
  }
  // 最多留 30 个人
  const keys = Object.keys(impressions).sort((a, b) => num(impressions[b].at) - num(impressions[a].at)).slice(0, 30)
  const trimmed = {}
  for (const k of keys) trimmed[k] = impressions[k]
  return { state: { ...state, impressions: trimmed, updatedAt: now }, ok: true, impression: trimmed[who] }
}

/** 读印象（注入用），带"多久前形成的" */
export function describeImpression(state, wxid, now = Date.now()) {
  const imp = (state.impressions || {})[wxid]
  if (!imp || !imp.text) return ''
  const hours = Math.max(0, Math.round((now - num(imp.at, now)) / 3_600_000))
  const age = hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
  return `${imp.text}（${age}形成的判断）`
}

/** 该给谁更新印象：有互动、且上次更新超过 minGap 的人 */
export function impressionDue(state, { minGapMs = 12 * 3_600_000, limit = 2, now = Date.now(), candidates = [] } = {}) {
  const imps = state.impressions || {}
  const out = []
  for (const wxid of candidates) {
    const imp = imps[wxid]
    if (!imp || now - num(imp.at, 0) >= minGapMs) out.push(wxid)
    if (out.length >= limit) break
  }
  return out
}

// ══════════════════════════════════════════════════════════════════════
//  ④ 她自己维护的两块内容（借 Letta/MemGPT 的"可自编辑记忆块"）
//     · 口头禅：最近爱说哪几句（会自然淡出）
//     · 在意的事：三五条，会自己换
//  ⑤ 生平事件表：她有"经历"，不只是日记的碎片
// ══════════════════════════════════════════════════════════════════════

export function updateSelfBlocks(state, { catchphrases = null, focus = null } = {}, now = Date.now()) {
  const next = { ...state }
  if (Array.isArray(catchphrases)) {
    const clean = catchphrases.map((x) => String(x || '').trim()).filter((x) => x && x.length <= 20).slice(0, 5)
    next.selfBlocks = { ...(state.selfBlocks || {}), catchphrases: clean, catchAt: now }
  }
  if (Array.isArray(focus)) {
    const clean = focus.map((x) => String(x || '').trim()).filter((x) => x && x.length <= 40).slice(0, 5)
    next.selfBlocks = { ...(next.selfBlocks || {}), focus: clean, focusAt: now }
  }
  next.updatedAt = now
  return { state: next, ok: true }
}

/** 注入用：口头禅 + 在意的事（空了就返回空串） */
export function describeSelfBlocks(state, now = Date.now()) {
  const b = state.selfBlocks || {}
  const out = []
  if (Array.isArray(b.catchphrases) && b.catchphrases.length) {
    out.push('你最近爱说的话：' + b.catchphrases.map((x) => `"${x}"`).join('、'))
  }
  if (Array.isArray(b.focus) && b.focus.length) {
    out.push('你最近在意的事：' + b.focus.join('；'))
  }
  return out.join('｜')
}

/** ⑤ 记一条"经历"（去重，最多 60 条，旧的淡出） */
export function addTimelineEvent(state, text, now = Date.now(), opts = {}) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!t) return { state, ok: false }
  const list = [...(state.timeline || [])]
  // 相似去重（前 8 个字相同就算重复）
  const head = t.slice(0, 8)
  if (list.some((x) => String(x.text || '').slice(0, 8) === head)) return { state, ok: false, dup: true }
  list.push({ at: now, text: t, kind: String(opts.kind || 'event') })
  const trimmed = list.slice(-60)
  return { state: { ...state, timeline: trimmed, updatedAt: now }, ok: true }
}

/** 注入用：最近几条经历 */
export function recentTimeline(state, limit = 5) {
  return (state.timeline || []).slice(-limit).map((x) => x.text)
}

/**
 * 手动加一个群梗（面板"添加"按钮用）。
 * 默认直接标记 learned=true（你加的肯定是真梗，不用等它出现几次）。
 */
export function addTerm(state, term, now = Date.now(), opts = {}) {
  const t = String(term || '').trim().replace(/^#/, '')
  const len = [...t].length
  if (!t || len < 1 || len > 20) return { state, ok: false, why: '长度要 1~20 字' }
  const lex = { ...(state.lexicon || {}) }
  if (lex[t]) {
    lex[t] = { ...lex[t], count: Math.max(2, num(lex[t].count, 0)), learned: true, lastAt: now, manual: true }
    return { state: { ...state, lexicon: lex, updatedAt: now }, ok: true, why: '已存在，已标记为会用', existed: true }
  }
  lex[t] = { count: 2, firstAt: now, lastAt: now, learned: opts.learned !== false, manual: true }
  // 上限 40：手加的词优先保留，其余按最近使用排
  const keys = Object.keys(lex).sort((a, b) => {
    const ma = lex[a].manual ? 1 : 0
    const mb = lex[b].manual ? 1 : 0
    if (ma !== mb) return mb - ma
    return num(lex[b].lastAt) - num(lex[a].lastAt)
  }).slice(0, 40)
  const trimmed = {}
  for (const k of keys) trimmed[k] = lex[k]
  return { state: { ...state, lexicon: trimmed, updatedAt: now }, ok: true, why: '已添加' }
}

/** 删掉一个群梗（面板 chips 上的 × ） */
export function removeTerm(state, term, now = Date.now()) {
  const t = String(term || '').trim()
  const lex = { ...(state.lexicon || {}) }
  if (!lex[t]) return { state, ok: false, why: '表里没有这个词' }
  delete lex[t]
  return { state: { ...state, lexicon: lex, updatedAt: now }, ok: true }
}

export function unlearnedTerms(state) {
  return Object.entries(state.lexicon || {})
    .filter(([, v]) => v && !v.learned && num(v.count) >= 2)
    .sort((a, b) => num(b[1].count) - num(a[1].count))
    .map(([k, v]) => ({ term: k, count: v.count }))
}

/** 已经学会的词（可以在说话时用） */
export function learnedTerms(state, limit = 6) {
  return Object.entries(state.lexicon || {})
    .filter(([, v]) => v && v.learned)
    .sort((a, b) => num(b[1].learnedAt) - num(a[1].learnedAt))
    .slice(0, limit).map(([k]) => k)
}

// ── H. 身体感：只保留"困/饿"，且必须自洽（不编造生活）────────────
export function bodyState(state, now = Date.now(), cfg = {}) {
  const hour = new Date(now).getHours()
  const energy = num(state.energy, 0.7)
  const out = { sleepy: false, hungry: false, note: '' }
  // 困：深夜 + 精力低（只在这两个条件都满足时才说困）
  if ((hour >= 0 && hour < 5) && energy < 0.55) out.sleepy = true
  // 饿：饭点前后（11-13 / 17-19 / 22-24）+ 随机一次，且同一时段不重复
  const meal = (hour >= 11 && hour < 13) || (hour >= 17 && hour < 19) || (hour >= 22 && hour < 24)
  const key = `${new Date(now).toDateString()}-${hour >= 11 && hour < 13 ? 'lunch' : hour >= 17 && hour < 19 ? 'dinner' : hour >= 22 ? 'night' : ''}`
  const said = state.bodySaid || {}
  if (meal && !said[key] && Math.random() < 0.35) {
    out.hungry = true
    out.key = key
  }
  const bits = []
  if (out.sleepy) bits.push('很困（快撑不住了），句子会更短')
  if (out.hungry) bits.push('有点饿，可能会顺口提一句想吃饭/想吃点东西')
  out.note = bits.join('；')
  return out
}

/** 记下"这个饭点说过饿了"，避免反复说 */
export function markBodySaid(state, key, now = Date.now()) {
  if (!key) return state
  return { ...state, bodySaid: { ...(state.bodySaid || {}), [key]: now }, updatedAt: now }
}

// ── I. 被追问的耐心：连续被问会不耐烦（但不拒绝回答）───────────────
export function noteQuestion(state, sender, now = Date.now(), windowMs = 10 * 60_000) {
  const cur = state.nag || {}
  const same = cur.sender === sender && now - num(cur.firstAt, 0) < windowMs
  const count = same ? num(cur.count, 0) + 1 : 1
  return { ...state, nag: { sender, count, firstAt: same ? cur.firstAt : now, at: now }, updatedAt: now }
}

export function nagLevel(state, now = Date.now(), windowMs = 10 * 60_000) {
  const n = state.nag || {}
  if (!n.sender || now - num(n.at, 0) > windowMs) return 0
  const c = num(n.count, 0)
  if (c >= 4) return 2   // 明显不耐烦
  if (c >= 3) return 1   // 有点烦
  return 0
}

// ── G. 自我复盘：结论存起来，下次写进自传 ─────────────────────────
export function saveSelfReview(state, findings, now = Date.now()) {
  const list = (Array.isArray(findings) ? findings : []).map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 5)
  if (!list.length) return state
  return {
    ...state,
    selfReview: { at: now, findings: list, history: [{ at: now, findings: list }, ...((state.selfReview && state.selfReview.history) || [])].slice(0, 6) },
    updatedAt: now,
  }
}

/** 该复盘了吗（默认 7 天一次） */
export function shouldSelfReview(state, now = Date.now(), everyMs = 7 * 86_400_000) {
  const last = num(state.selfReview && state.selfReview.at, 0)
  return { ok: now - last >= everyMs, lastAt: last }
}
