/**
 * astro.mjs —— 「星盘」数据层：人际关系 × 记忆关联 × 性格，聚合成一张图
 *
 * 设计（用户 2026-11-02 要求）：
 *   恒星 = 人（亮度=好感度，大小=互动量，颜色=羁绊等级）
 *   行星 = 记忆（亮度=保持率，离中心近=重要）
 *   星座 = 话题/梗（若干记忆聚成一簇，带名字）
 *   连边 = 人↔记忆（提到）、记忆↔话题（同簇）、人↔人（同一段记忆里一起出现）
 *   性格星云 = 7 个性格维度，画在背景弧上，随时间漂移
 *
 * 纯函数、无 IO、确定性（同一个输入永远出同一张图）——
 * 这样面板刷新不会"星盘乱跳"。
 */

import { buildPersonEdges, findCommunities } from './social.mjs'

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)

/** 中文 2-gram 停用词（太常见，做话题名没有区分度） */
const STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '没有', '一个', '现在',
  '时候', '因为', '所以', '但是', '如果', '还是', '已经', '觉得', '知道', '应该', '可能', '真的',
  '自己', '今天', '明天', '昨天', '一下', '有点', '一点', '不是', '这样', '那样', '东西', '事情',
  '看到', '看到', '说的', '说了', '群里', '这里', '那里', '然后', '而且', '或者', '不过', '其实',
])

/** 把文本切成候选词：中文 2-gram + 英文/数字词 */
function grams(text) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = [...m[0]]
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run[i] + run[i + 1]
      if (!STOP.has(g)) out.add(g)
    }
  }
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) out.add(m[0].toLowerCase())
  return [...out]
}

/**
 * 从记忆里挖话题（星座）：统计 2-gram 频次，按共现把记忆聚起来。
 * 简化但不含糊：一个记忆可以属于多个话题（真实话题本来就重叠）。
 * @returns {{key:string,label:string,words:string[],memoryIds:string[],size:number}[]}
 */
export function pickTopics(facts, { minSize = 3, maxTopics = 12 } = {}) {
  const freq = new Map()
  const memGrams = new Map()
  for (const f of facts || []) {
    const gs = grams(f.text)
    memGrams.set(f.id, gs)
    for (const g of gs) freq.set(g, (freq.get(g) || 0) + 1)
  }
  const total = Math.max(1, (facts || []).length)
  const ranked = [...freq.entries()]
    // 频次下限：至少 minSize 条记忆提到
    // 频次上限：不超过全部记忆的 40%（超过说明是"说明""在群"这种通用词，做星座名没意义）
    .filter(([, c]) => c >= minSize && c <= Math.max(minSize, total * 0.4))
    // 词本身不能是虚词组合
    .filter(([w]) => !/[的了是在有我你他她它不都会就也还和与把被给让从向对及或而但所以如若]/.test(w))
    .filter(([w]) => !/^(说明|在群|明我|群友|群里|事情|东西|时候|问题|感觉|觉得|应该|可能|真的|有点|一下|一个)$/.test(w))
    // wxid 片段、长英文 ID 不能当星座名
    .filter(([w]) => !/^wxid/i.test(w) && !/^[a-z0-9_]{4,}$/i.test(w))
    .sort((a, b) => b[1] - a[1])

  const topics = []
  const used = new Set()
  for (const [word, count] of ranked) {
    if (topics.length >= maxTopics) break
    if (used.has(word)) continue
    const memoryIds = (facts || []).filter((f) => (memGrams.get(f.id) || []).includes(word)).map((f) => f.id)
    if (memoryIds.length < minSize) continue
    // 同簇的第二个词（让标签更像"话题"而不是单个词）
    const partner = ranked
      .map(([w]) => w)
      // wxid / 英文 ID 不当话题名（"梦云·wxid_urirqbcdh0rc22" 这种太长也没意义）
      .filter((w) => !/^wxid_/i.test(w) && !/^[a-z0-9_]{6,}$/i.test(w))
      .find((w) => w !== word && !used.has(w)
        && memoryIds.filter((id) => (memGrams.get(id) || []).includes(w)).length >= Math.max(2, memoryIds.length * 0.5))
    used.add(word)
    if (partner) used.add(partner)
    topics.push({
      key: 'topic:' + word,
      label: String(partner ? `${word}·${partner}` : word).slice(0, 12),
      words: partner ? [word, partner] : [word],
      memoryIds,
      size: memoryIds.length,
    })
  }
  return topics.sort((a, b) => b.size - a.size)
}

/** 从文本里找人名（用于"人↔记忆"连边） */
function findPeopleInText(text, people) {
  const t = String(text || '')
  const hit = []
  for (const p of people) {
    // ★ 2026-11-02 修：people 传进来的元素字段是 label（构建时就叫 label），
    //   这里原来只认 p.name → 一条"人↔记忆"边都没连上。
    const nm = String(p.name || p.label || '')
    if (nm.length < 2) continue
    if (t.includes(nm)) hit.push(p.id)
  }
  return hit
}

/**
 * 生成星盘。
 * @param {object} o
 * @param {object} o.persona   persona 状态（affinity/impressions/traits/lexicon）
 * @param {object[]} o.facts   记忆（memory v2）
 * @param {Array} o.people      [{id,name}] 群成员
 * @param {number} o.now
 * @param {object} o.retentionFn (fact, now) => 0..1  保持率（从 memory-v2 传进来，避免重复实现）
 * @param {string} [o.selfName]
 */
export function buildChart({ persona, facts = [], people = [], now = Date.now(), retentionFn = null, selfName = '蓝色大肥鱼', social = null } = {}) {
  const st = persona || {}
  const affinity = st.affinity || {}
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  const nodes = []
  const edges = []
  const pushEdge = (a, b, kind, weight = 1) => {
    if (!a || !b || a === b) return
    edges.push({ source: a, target: b, kind, weight: Number(weight.toFixed(3)) })
  }

  // ── ① 她自己（中心） ──
  nodes.push({ id: 'self', kind: 'self', label: selfName, r: 1, glow: 1 })

  // ── ② 人（恒星） ──
  const peopleList = []
  for (const [id, name] of nameOf.entries()) {
    if (id === st.roomId) continue
    const aff = clamp01(affinity[id] ?? 0.5)
    const imp = (st.impressions || {})[id]
    peopleList.push({
      id,
      kind: 'person',
      label: name || id.slice(0, 12),
      affinity: aff,
      bond: bondLevelOf(aff),
      impression: imp ? String(imp.text || '').slice(0, 80) : '',
      r: 0.45 + aff * 0.55,
      glow: aff,
    })
  }
  peopleList.sort((a, b) => b.affinity - a.affinity)
  nodes.push(...peopleList)

  // ── ③ 话题（星座） ──
  const topics = pickTopics(facts)
  for (const t of topics) {
    nodes.push({ id: t.key, kind: 'topic', label: t.label, size: t.size, r: 0.3 + Math.min(0.5, t.size / 20) })
    for (const mid of t.memoryIds) pushEdge(t.key, mid, 'topic')
  }

  // ── ④ 记忆（行星） ──
  const memNodes = []
  for (const f of facts) {
    const keep = retentionFn ? clamp01(retentionFn(f, now)) : clamp01(0.7)
    const imp = clamp01(num(f.importance, 0.45))
    const ageDays = Math.max(0, (now - num(f.createdAt, now)) / 86_400_000)
    memNodes.push({
      id: f.id,
      kind: 'memory',
      label: String(f.text || '').slice(0, 40),
      keep,
      importance: imp,
      ageDays,
      room: f.sourceRoomName || '',
      kindOf: f.kind || '',
      emotion: (f.emotion && f.emotion.label) || '',
      r: 0.14 + imp * 0.22,
      glow: keep * (0.35 + imp * 0.65),
    })
  }
  nodes.push(...memNodes)

  // ── ⑤ 连边：人 ↔ 记忆（提到名字） ──
  for (const f of facts) {
    const hits = findPeopleInText(f.text, peopleList)
    for (const pid of hits) pushEdge(pid, f.id, 'mention', 1 / Math.max(1, hits.length))
    // 同一段记忆里被一起提到的人 → 人↔人
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) pushEdge(hits[i], hits[j], 'together', 1)
    }
  }

  // ── ⑥ 性格星云（背景弧） ──
  const traits = Object.entries(st.traits || {}).map(([k, v]) => ({ key: k, value: clamp01(v) }))

  // ── ⑦ 群梗（小行星带） ──
  const terms = Object.entries(st.lexicon || {})
    .filter(([, v]) => v && (v.learned || num(v.count, 0) >= 2))
    .slice(0, 12)
    .map(([w, v]) => ({ id: 'term:' + w, kind: 'term', label: w, count: num(v.count, 1), learned: !!v.learned, r: 0.16 }))
  nodes.push(...terms)
  for (const t of terms) {
    // 梗挂在"用过它的人"上
    const users = (st.lexicon[t.label] || {}).usedBy || []
    for (const u of users) if (nameOf.has(u)) pushEdge(u, t.id, 'uses', 0.6)
  }

  // ── ⑧ 人-人关系（2026-11-02 新增）：把她以外的连接也画出来 ──
  //   数据来源见 social.mjs：对话共现 / 同段记忆 / 同话题 / 同群
  let pp = []
  let communities = []
  try {
    // 每个人属于哪些话题（人 → 他记忆挂的话题）
    const memTopic = new Map()
    for (const e of edges) if (e.kind === 'topic') memTopic.set(e.target, e.source)
    const personTopics = {}
    for (const e of edges) {
      if (e.kind !== 'mention') continue
      const t = memTopic.get(e.target)
      if (!t) continue
      if (!personTopics[e.source]) personTopics[e.source] = []
      if (!personTopics[e.source].includes(t)) personTopics[e.source].push(t)
    }
    const together = edges.filter((e) => e.kind === 'together').map((e) => ({ source: e.source, target: e.target }))
    const built = buildPersonEdges({
      talk: (social && social.talkPairs) || [],
      roomMembers: (social && social.roomMembers) || {},
      together,
      personTopics,
    })
    pp = built.edges
    // ★ 社区检测**只用力边**（聊过/同框/同话题）：
    //   "同群"那种弱边会把半个群连成一片 → 只剩 1 个圈子，失去意义。
    const strong = pp.filter((e) => e.basis.some((b) => b === 'talk' || b === 'memory' || b === 'topic'))
    const strongNodes = new Set()
    for (const e of strong) { strongNodes.add(e.source); strongNodes.add(e.target) }
    communities = strongNodes.size >= 3 && strong.length >= 2
      ? findCommunities(strong)
      : findCommunities(pp)      // 关系数据太少时退回全图（至少能分出东西）
    // 只保留有人数 >= 2 的团；单人团当"散星"
    const small = new Set()
    for (const c of communities) if (c.size < 2) c.members.forEach((m) => small.add(m))
    communities = communities.filter((c) => c.size >= 2)
    const personCommunity = new Map()
    for (const c of communities) for (const m of c.members) personCommunity.set(m, c.id)
    for (const n of nodes) {
      if (n.kind !== 'person') continue
      n.community = personCommunity.get(n.id) || ''
      n.friends = pp.filter((e) => e.source === n.id || e.target === n.id).length
      n.scatter = small.has(n.id)
    }
    const zyStats = {}
    for (const edge of pp) {
      const k = edge.basis.join('+')
      zyStats[k] = (zyStats[k] || 0) + 1
    }
    return {
      nodes, edges, traits, topics, pp, communities,
      roomsBrief: (social && social.roomMembers) || {},
      stats: {
        people: peopleList.length, memories: memNodes.length, topics: topics.length,
        terms: terms.length, edges: edges.length,
        pp: pp.length, communities: communities.length, ppByBasis: zyStats,
        talk: ((social && social.talkPairs) || []).length,
        rooms: Object.keys((social && social.roomMembers) || {}).length,
      },
    }
  } catch (e) {
    return {
      nodes, edges, traits, topics, pp: [], communities: [],
      stats: { people: peopleList.length, memories: memNodes.length, topics: topics.length, terms: terms.length, edges: edges.length, pp: 0, communities: 0, ppError: String(e && e.message || e).slice(0, 80) },
    }
  }
}

function bondLevelOf(aff) {
  if (aff >= 0.86) return '心动'
  if (aff >= 0.71) return '好朋友'
  if (aff >= 0.56) return '朋友'
  if (aff >= 0.45) return '普通人'
  if (aff >= 0.30) return '冷淡'
  if (aff >= 0.15) return '有点烦'
  return '讨厌'
}

/**
 * 布局：确定性力导向（同一个输入永远同一张图）。
 * 语义约束：好感度越高的人越靠近中心；记忆往外围；话题在中间环。
 * @returns {{id:string,x:number,y:number}[]}  x/y 归一化到 -1..1
 */
export function layout(chart, { iterations = 220, now = Date.now() } = {}) {
  const nodes = chart.nodes || []
  const pos = new Map()
  const kindRing = { self: 0, person: 0.5, term: 0.62, topic: 0.74, memory: 0.9 }
  const byKind = {}
  for (const n of nodes) (byKind[n.kind] = byKind[n.kind] || []).push(n)

  // 初始角度：按名字 hash 稳定分布，避免每次刷新乱转
  const hash = (s) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
    return (h >>> 0) / 4294967295
  }
  for (const [kind, arr] of Object.entries(byKind)) {
    const ring = kindRing[kind] ?? 0.8
    arr.forEach((n, i) => {
      if (n.kind === 'self') { pos.set(n.id, { x: 0, y: 0 }); return }
      const base = (i / Math.max(1, arr.length)) * Math.PI * 2
      const jitter = (hash(n.id) - 0.5) * 0.5
      // 人：好感度越高越靠里
      const r = n.kind === 'person' ? ring * (1.15 - clamp01(n.affinity) * 0.55) : ring
      pos.set(n.id, { x: Math.cos(base + jitter) * r, y: Math.sin(base + jitter) * r })
    })
  }

  // 力导向微调（弹簧 + 斥力），只跑 iterations 次，节点少所以很快
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const P = nodes.map((n) => ({ ...(pos.get(n.id) || { x: 0, y: 0 }) }))
  const edges = (chart.edges || []).filter((e) => idx.has(e.source) && idx.has(e.target))
  const k = 0.9 / Math.sqrt(Math.max(8, nodes.length))    // 理想边长

  for (let it = 0; it < iterations; it++) {
    const disp = P.map(() => ({ x: 0, y: 0 }))
    // 斥力（全对，O(n²)，n≈400 → 16 万次/轮 × 220 轮 ≈ 3500 万，稍慢，抽稀）
    const step = nodes.length > 300 ? 2 : 1
    for (let i = 0; i < P.length; i += step) {
      for (let j = i + 1; j < P.length; j += step) {
        let dx = P[i].x - P[j].x
        let dy = P[i].y - P[j].y
        let d2 = dx * dx + dy * dy
        if (d2 < 1e-4) { dx = 1e-3 * (i - j); dy = 1e-3; d2 = dx * dx + dy * dy }
        const f = (k * k) / d2
        const d = Math.sqrt(d2)
        disp[i].x += (dx / d) * f; disp[i].y += (dy / d) * f
        disp[j].x -= (dx / d) * f; disp[j].y -= (dy / d) * f
      }
    }
    // 弹簧（只对连边）
    for (const e of edges) {
      const a = idx.get(e.source), b = idx.get(e.target)
      let dx = P[a].x - P[b].x, dy = P[a].y - P[b].y
      const d = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy))
      const f = ((d * d) / k) * 0.02 * (0.5 + Number(e.weight || 1) * 0.5)
      disp[a].x -= (dx / d) * f; disp[a].y -= (dy / d) * f
      disp[b].x += (dx / d) * f; disp[b].y += (dy / d) * f
    }
    // 向心力（保持环形层次）+ 应用位移
    const t = 1 - it / iterations
    for (let i = 0; i < P.length; i++) {
      const n = nodes[i]
      const target = kindRing[n.kind] ?? 0.8
      const len = Math.max(1e-3, Math.hypot(P[i].x, P[i].y))
      const pull = n.kind === 'person' ? target * (1.15 - clamp01(n.affinity) * 0.55) : target
      disp[i].x += (P[i].x / len) * (pull - len) * 2.2
      disp[i].y += (P[i].y / len) * (pull - len) * 2.2
      const limit = 0.12 * t
      const dl = Math.max(1e-6, Math.hypot(disp[i].x, disp[i].y))
      const s = Math.min(limit, dl) / dl
      P[i].x += disp[i].x * s
      P[i].y += disp[i].y * s
    }
  }

  // 归一化到 -1..1（按最大半径缩）
  const maxR = Math.max(...P.map((p) => Math.hypot(p.x, p.y)), 0.001)
  return nodes.map((n, i) => ({
    id: n.id,
    x: P[i].x / maxR,
    y: P[i].y / maxR,
  }))
}

/** 一次性产出「图 + 坐标」，给面板用 */
export function buildChartWithLayout(opts) {
  const chart = buildChart(opts)
  const pos = layout(chart, { now: opts.now })
  const p = new Map(pos.map((x) => [x.id, x]))
  return {
    ...chart,
    nodes: chart.nodes.map((n) => ({ ...n, x: p.get(n.id)?.x ?? 0, y: p.get(n.id)?.y ?? 0 })),
  }
}
