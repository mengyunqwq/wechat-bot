/**
 * memory-v2.mjs —— 艾宾浩斯遗忘曲线 + 情绪加权的长期记忆引擎
 *
 * 设计要点（与旧系统对比）
 *   旧：facts 只有 {text,kind,at}，注入靠 `slice(-18)`（按插入顺序），每群硬上限 80 条直接丢弃。
 *   新：每条记忆带 强度 S / 易忘度 D / 情绪 / 重要度 / 被用次数，
 *       保持率 R(t)=exp(-t/S)，被检索进上下文即"复习"→ S 变大（间隔重复），
 *       R 低于阈值且不重要 → 归档（30 天后才真删），超容量时按 R×importance 淘汰而不是按时间。
 *
 * 为什么单独成文件：这套数学与"怎么写记忆"完全解耦，可以脱离插件单测
 *   （node -e "import('./lib/memory-v2.mjs')..."），也方便以后换实现。
 *
 * 全部为纯函数，不读写磁盘、不访问网络。
 */

export const SCHEMA = 2

/** baseDays=7 时：第 7 天保持率 37%、第 14 天 13% */
export const DEFAULTS = {
  baseDays: 7,              // S0 基准（天）。这些是"被提炼过的事实"，不是随机字符串，7 天更合理
  forgetWeight: 0.06,       // 遗忘判据：R × 重要度 低于此值 → 归档（即"忘掉权重低的"）
  minAgeDays: 2,            // 不到这个天数的记忆永不归档（给新记忆被检索到的机会）
  keepImportance: 0.85,     // 重要度 ≥ 此值的"铁律记忆"永不自动归档（身份/约定/承诺）
  forgetThreshold: 0.15,    // 兼容旧配置：仅在外部显式传入时作为额外收紧条件
  archiveGraceDays: 30,     // 归档后多久真删
  maxActive: 120,           // 每群 active 上限
  injectCount: 12,          // 每次带进上下文的条数
  emotionBoost: 0.8,        // 情绪对 S0 的加成上限
  recallGamma: 1.2,         // 复习增益系数
  pinnedMax: 3,             // pinned 必带条数上限
  exploreRate: 0.05,        // 随机探索比例（防"越热门越热门"）
  newTryBoost: 1.15,        // 24h 内新建记忆的检索加成
}

const DAY = 86_400_000

/** 情绪 → (valence, arousal) 的粗略锚点；模型只回 label+intensity 时用它补 */
export const EMOTION_ANCHORS = {
  开心: { valence: 0.8, arousal: 0.6 },
  生气: { valence: -0.7, arousal: 0.85 },
  难过: { valence: -0.75, arousal: 0.25 },
  害羞: { valence: 0.35, arousal: 0.6 },
  惊喜: { valence: 0.7, arousal: 0.9 },
  无语: { valence: -0.25, arousal: 0.3 },
  温柔: { valence: 0.65, arousal: 0.2 },
  平静: { valence: 0.1, arousal: 0.15 },
  未知: { valence: 0, arousal: 0.3 },
}

export const EMOTION_LABELS = Object.keys(EMOTION_ANCHORS)

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)

/** 稳健的情绪归一化：接受 {label,intensity} 或字符串 */
export function normalizeEmotion(raw) {
  let label = '未知'
  let intensity = 0.3
  let valence
  let arousal
  if (typeof raw === 'string') {
    label = raw.trim() || '未知'
  } else if (raw && typeof raw === 'object') {
    label = String(raw.label || raw.emotion || '未知').trim() || '未知'
    if (raw.intensity !== undefined) intensity = clamp01(raw.intensity)
    if (raw.valence !== undefined) valence = Math.max(-1, Math.min(1, num(raw.valence)))
    if (raw.arousal !== undefined) arousal = clamp01(raw.arousal)
  }
  const anchor = EMOTION_ANCHORS[label] || EMOTION_ANCHORS['未知']
  if (valence === undefined) valence = anchor.valence
  if (arousal === undefined) arousal = anchor.arousal
  return { label, intensity, valence, arousal }
}

/** 情绪相似度 0~1（同情绪 → 高），用于 mood-congruent recall */
export function emotionMatch(a, b) {
  const ea = normalizeEmotion(a)
  const eb = normalizeEmotion(b)
  // valence 距离（-1~1）与 arousal 距离（0~1）合并
  const dv = Math.abs(ea.valence - eb.valence) / 2
  const da = Math.abs(ea.arousal - eb.arousal)
  return clamp01(1 - (dv * 0.6 + da * 0.4))
}

/** 一条记忆的"重要度"（0~1）：模型判断为主，情绪与自我相关性做校正 */
export function computeImportance({ modelImportance, emotion, selfRelevant }) {
  const e = normalizeEmotion(emotion)
  const mi = modelImportance === undefined ? 0.45 : clamp01(modelImportance)
  const sr = selfRelevant ? 1 : 0
  return clamp01(0.45 * mi + 0.35 * e.intensity + 0.20 * sr)
}

/** 初始强度 S0（天）：越重要、情绪越强 → 起步越牢 */
export function initialStrength({ importance, emotion, cfg }) {
  const c = cfg || DEFAULTS
  const e = normalizeEmotion(emotion)
  const imp = clamp01(importance === undefined ? 0.45 : importance)
  return Math.max(
    0.5,
    num(c.baseDays, DEFAULTS.baseDays) * (0.5 + imp) * (1 + num(c.emotionBoost, DEFAULTS.emotionBoost) * e.intensity),
  )
}

/** 当前保持率 R(t) = exp(-t/S)，t 单位天 */
export function retention(item, now = Date.now()) {
  const S = Math.max(0.05, num(item && item.strength, 1))
  const t = Math.max(0, (now - num(item && (item.createdAt ?? item.at), now)) / DAY)
  return Math.exp(-t / S)
}

/** 复习：R 越低，涨得越多（间隔重复）。返回新的 S */
export function reinforceStrength(item, now = Date.now(), cfg) {
  const c = cfg || DEFAULTS
  const R = retention(item, now)
  const gamma = num(c.recallGamma, DEFAULTS.recallGamma)
  const D = clamp01(num(item && item.difficulty, 0.3))
  const S = Math.max(0.05, num(item && item.strength, 1))
  return Math.min(3650, S * (1 + gamma * (1 - R) * (1 - D)))
}

/** v1（{text,kind,at}）→ v2。纯函数，幂等 */
export function migrateItem(raw, now = Date.now(), cfg = null) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text || '').trim()
  if (!text) return null
  if (raw.schema === SCHEMA || raw.strength !== undefined) {
    // 已经是 v2：只补缺省字段
    const emotion = normalizeEmotion(raw.emotion)
    const importance = clamp01(raw.importance === undefined ? 0.45 : raw.importance)
    return {
      ...raw,
      schema: SCHEMA,
      kind: raw.kind || 'fact',
      createdAt: num(raw.createdAt ?? raw.at, now),
      at: num(raw.createdAt ?? raw.at, now),
      emotion,
      importance,
      // v1 迁移来的、且从没被检索用过的条目：按"当前参数"重算一次强度（只算一次）
      strength: (raw.migratedFrom === 'v1' && num(raw.recallCount, 0) === 0 && cfg)
        ? initialStrength({ importance, emotion, cfg })
        : num(raw.strength, initialStrength({ importance, emotion, cfg })),
      migratedFrom: raw.migratedFrom === 'v1' ? 'v1-rebased' : raw.migratedFrom,
      difficulty: clamp01(num(raw.difficulty, 0.3)),
      recallCount: num(raw.recallCount, 0),
      hitCount: num(raw.hitCount, 0),
      lastRecallAt: raw.lastRecallAt || null,
      pinned: !!raw.pinned,
      archived: !!raw.archived,
      sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 3) : [],
    }
  }
  // v1 → v2
  const emotion = normalizeEmotion('未知')
  const importance = 0.45   // 老数据没有信号，取中性值
  return {
    schema: SCHEMA,
    id: raw.id || null,
    text,
    kind: raw.kind || 'fact',
    createdAt: num(raw.at, now),
    at: num(raw.at, now),
    emotion,
    importance,
    strength: initialStrength({ importance, emotion }),
    difficulty: 0.3,
    recallCount: 0,
    hitCount: 0,
    lastRecallAt: null,
    pinned: false,
    archived: false,
    sources: [],
    migratedFrom: 'v1',
  }
}

/** 批量迁移；返回 {items, changed} */
export function migrateList(list, now = Date.now(), cfg = null) {
  const out = []
  let changed = 0
  for (const raw of Array.isArray(list) ? list : []) {
    const m = migrateItem(raw, now, cfg)
    if (!m) continue
    if (!(raw.schema === SCHEMA)) changed++
    out.push(m)
  }
  return { items: out, changed }
}

/** 本地零成本相关性：关键词/字重叠（与旧 factSimilar 同源思路，但只用于打分不用于去重） */
export function textRelevance(itemText, queryText) {
  const a = String(itemText || '')
  const b = String(queryText || '')
  if (!a || !b) return 0
  // 中文按 2-gram 覆盖，英文/数字按词
  const grams = (s) => {
    const t = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const set = new Set()
    for (const w of t.split(/\s+/)) {
      if (!w) continue
      if (/^[\x00-\x7F]+$/.test(w)) set.add(w.toLowerCase())
      else for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2))
    }
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.size || !gb.size) return 0
  let hit = 0
  for (const g of gb) if (ga.has(g)) hit++
  // 用 query 侧覆盖率（记忆长不该因为长而占便宜）
  return clamp01(hit / Math.min(gb.size, 40))
}

/**
 * 检索打分。
 * score = 0.30·R + 0.35·relevance + 0.20·importance + 0.10·emotionMatch + 0.05·recency
 */
export function scoreItem(item, ctx = {}) {
  const now = ctx.now || Date.now()
  const R = retention(item, now)
  const rel = textRelevance(item.text, ctx.query || '')
  const imp = clamp01(item.importance)
  const emo = ctx.emotion ? emotionMatch(item.emotion, ctx.emotion) : 0.5
  const ageH = Math.max(0, (now - num(item.createdAt, now)) / 3_600_000)
  const rec = ageH <= 24 ? num(ctx.cfg && ctx.cfg.newTryBoost, DEFAULTS.newTryBoost) : 1
  const base = 0.30 * R + 0.35 * rel + 0.20 * imp + 0.10 * emo
  return base * rec
}

/**
 * 选记忆进上下文。
 * @returns {{ picked: object[], stats: object }}
 *   picked 里每条会被打上 _score（不进磁盘）
 */
export function selectMemories(list, ctx = {}) {
  const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) }
  const now = ctx.now || Date.now()
  const all = (Array.isArray(list) ? list : []).filter((x) => x && !x.archived)
  const n = Math.max(1, num(cfg.injectCount, DEFAULTS.injectCount))

  const scored = all.map((it) => ({ it, score: scoreItem(it, { ...ctx, now, cfg }) }))
  scored.sort((a, b) => b.score - a.score)

  const picked = []
  const seen = new Set()
  const take = (it) => {
    if (!it || seen.has(it)) return
    seen.add(it)
    picked.push(it)
  }
  // ① pinned 必带（最多 pinnedMax 条，按分数取）
  for (const { it } of scored.filter((x) => x.it.pinned).slice(0, Math.max(0, num(cfg.pinnedMax, DEFAULTS.pinnedMax)))) take(it)
  // ② 高情绪记忆保底 2 条（情绪是记忆的钩子）
  for (const { it } of scored.filter((x) => normalizeEmotion(x.it.emotion).intensity >= 0.6).slice(0, 2)) take(it)
  // ③ 剩余按分数补足
  for (const { it } of scored) {
    if (picked.length >= n) break
    take(it)
  }
  // ④ 随机探索：替换掉最末一条（防"越热门越热门"）
  if (all.length > n + 4 && Math.random() < num(cfg.exploreRate, DEFAULTS.exploreRate)) {
    const cold = scored.slice(n).filter((x) => !x.it.pinned)
    if (cold.length) {
      const pick = cold[Math.floor(Math.random() * Math.min(cold.length, 20))]
      if (pick && picked.length) picked[picked.length - 1] = pick.it
    }
  }

  const avgR = all.length ? all.reduce((s, it) => s + retention(it, now), 0) / all.length : 0
  return {
    picked,
    stats: {
      total: all.length,
      picked: picked.length,
      avgRetention: +avgR.toFixed(3),
      pinned: all.filter((x) => x.pinned).length,
      archived: (Array.isArray(list) ? list : []).filter((x) => x && x.archived).length,
    },
  }
}

/** 记住"这批被用过了"：涨 S、记次数、记上次使用时间。返回新数组（不改原对象） */
export function reinforceList(list, pickedIds, now = Date.now(), cfg = DEFAULTS) {
  const ids = new Set((pickedIds || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean))
  return (Array.isArray(list) ? list : []).map((it) => {
    if (!it || !it.id || !ids.has(it.id)) return it
    return {
      ...it,
      strength: reinforceStrength(it, now, cfg),
      recallCount: num(it.recallCount, 0) + 1,
      lastRecallAt: now,
    }
  })
}

/**
 * 一天一次的遗忘巡检：
 *   ① pinned 不动
 *   ② R < 阈值 且 importance < 0.5 且没被用过 → 归档
 *   ③ 归档超过 graceDays → 真删（从数组里移除）
 *   ④ active 超过上限 → 按 R×importance 升序淘汰（归档，不是删除）
 */
export function sweep(list, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  let archived = 0
  let purged = 0
  let evicted = 0
  const grace = num(c.archiveGraceDays, DEFAULTS.archiveGraceDays) * DAY

  const minAge = num(c.minAgeDays, DEFAULTS.minAgeDays) * DAY
  const forgetW = num(c.forgetWeight, DEFAULTS.forgetWeight)
  let out = (Array.isArray(list) ? list : []).filter(Boolean).map((it) => {
    if (it.pinned || it.archived) return it
    // 铁律：重要度极高的记忆（身份/约定/承诺）不因时间被忘掉
    if (clamp01(it.importance) >= num(c.keepImportance, DEFAULTS.keepImportance)) return it
    const age = now - num(it.createdAt ?? it.at, now)
    if (age < minAge) return it                     // 新记忆先留着，给它被检索到的机会
    const R = retention(it, now)
    const weight = R * Math.max(0.05, clamp01(it.importance))
    if (weight >= forgetW) return it
    archived++
    return {
      ...it, archived: true, archivedAt: now,
      archivedReason: `权重 ${weight.toFixed(3)} < ${forgetW}（R=${Math.round(R * 100)}% 重要度=${Math.round(clamp01(it.importance) * 100)}%）`,
    }
  })

  // ③ 归档到期删除
  out = out.filter((it) => {
    if (!it.archived) return true
    const at = num(it.archivedAt, now)
    if (now - at >= grace) { purged++; return false }
    return true
  })

  // ④ 容量淘汰
  const actives = out.filter((x) => !x.archived)
  const maxA = Math.max(10, num(c.maxActive, DEFAULTS.maxActive))
  if (actives.length > maxA) {
    const ranked = actives
      .map((it) => ({ it, w: retention(it, now) * Math.max(0.05, clamp01(it.importance)) }))
      .sort((a, b) => a.w - b.w)
    const drop = new Set(ranked.slice(0, actives.length - maxA).map((x) => x.it))
    out = out.map((it) => {
      if (!drop.has(it) || it.pinned) return it
      // 铁律记忆同样不被容量淘汰
      if (clamp01(it.importance) >= num(c.keepImportance, DEFAULTS.keepImportance)) return it
      evicted++
      return { ...it, archived: true, archivedAt: now, archivedReason: '容量淘汰（R×重要度最低）' }
    })
  }

  return { items: out, archived, purged, evicted }
}

/** 面板用：统计 + 按"未来 7 天会不会被忘"预览 */
export function stats(list, now = Date.now(), cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...(cfg || {}) }
  const all = (Array.isArray(list) ? list : []).filter(Boolean)
  const active = all.filter((x) => !x.archived)
  const archivedList = all.filter((x) => x.archived)
  const rs = active.map((it) => retention(it, now))
  const forgetW = num(c.forgetWeight, DEFAULTS.forgetWeight)
  const t7 = now + 7 * DAY
  const keepImp = num(c.keepImportance, DEFAULTS.keepImportance)
  const willForget = active.filter((it) => {
    if (it.pinned) return false
    if (clamp01(it.importance) >= keepImp) return false
    return retention(it, t7) * Math.max(0.05, clamp01(it.importance)) < forgetW
  }).length
  const ironclad = active.filter((it) => clamp01(it.importance) >= keepImp).length
  return {
    total: all.length,
    active: active.length,
    archived: archivedList.length,
    pinned: active.filter((x) => x.pinned).length,
    ironclad,     // 铁律记忆（重要度 ≥ keepImportance，永不自动忘）
    avgRetention: active.length ? +(rs.reduce((a, b) => a + b, 0) / active.length).toFixed(3) : 0,
    minRetention: rs.length ? +Math.min(...rs).toFixed(3) : 0,
    willForgetIn7d: willForget,
    emotionBuckets: EMOTION_LABELS.reduce((acc, k) => {
      const n = active.filter((it) => normalizeEmotion(it.emotion).label === k).length
      if (n) acc[k] = n
      return acc
    }, {}),
    avgImportance: active.length
      ? +(active.reduce((a, it) => a + clamp01(it.importance), 0) / active.length).toFixed(3)
      : 0,
  }
}

/** 保证每条都有稳定 id（v1 数据没有 id）；纯函数，调用方负责存回 */
export function ensureIds(list, now = Date.now()) {
  let changed = 0
  const out = (Array.isArray(list) ? list : []).map((it, i) => {
    if (!it) return it
    if (it.id) return it
    changed++
    const seed = `${it.createdAt || it.at || now}|${it.text || ''}|${i}`
    let h = 2166136261
    for (let k = 0; k < seed.length; k++) {
      h ^= seed.charCodeAt(k)
      h = Math.imul(h, 16777619)
    }
    return { ...it, id: 'm_' + (h >>> 0).toString(16) }
  })
  return { items: out, changed }
}

/** 给前端画曲线用：按当前参数采样 R(t) */
export function curvePoints(maxDays = 30, stepDays = 1, baseDays = DEFAULTS.baseDays) {
  const base = Math.max(0.5, num(baseDays, DEFAULTS.baseDays))
  const pts = []
  for (let d = 0; d <= maxDays; d += stepDays) pts.push({ day: d, R: +Math.exp(-d / base).toFixed(3) })
  return { base, points: pts }
}

/**
 * 本地情绪猜测（不花 token）：从一句话里粗判情绪，作为"检索线索"。
 * 只用于检索加权（mood-congruent recall），**不写进提示词**，判错也不影响文案。
 */
const EMOTION_WORDS = {
  开心: ['哈哈', '笑死', '开心', '高兴', '嘿嘿', '好耶', '棒', '喜欢', '😄', '😆', '🤣'],
  生气: ['生气', '气死', '烦', '滚', '闭嘴', '妈的', '傻', '草', '怒', '😡', '🤬'],
  难过: ['难过', '难受', '哭', '委屈', '伤心', '呜呜', '唉', '😭', '😢'],
  害羞: ['害羞', '脸红', '不好意思', '羞', '😳', '🥺'],
  惊喜: ['卧槽', '居然', '竟然', '天啊', '真的假的', '惊', '😱', '🤯'],
  无语: ['无语', '服了', '离谱', '离谱', '……', '呵呵', '🙄', '😑'],
  温柔: ['抱抱', '摸头', '乖', '别怕', '辛苦了', '晚安', '早点睡', '🥰', '😊'],
  平静: ['嗯', '好的', '在吗', '收到', '行吧'],
}

export function guessEmotion(text) {
  const t = String(text || '')
  if (!t) return { label: '平静', intensity: 0.2 }
  let best = { label: '平静', intensity: 0.2, hits: 0 }
  for (const [label, words] of Object.entries(EMOTION_WORDS)) {
    let hits = 0
    for (const w of words) if (t.includes(w)) hits++
    if (hits > best.hits) best = { label, intensity: Math.min(0.9, 0.35 + hits * 0.2), hits }
  }
  return { label: best.label, intensity: best.intensity }
}
