/**
 * social.mjs —— 人-人关系提取（2026-11-02 用户要求"把别人之间的关系也连起来"）
 *
 * 为什么单独一层：原来只有"两个人在同一段记忆里被提到"这一种信号，
 * 64 个人里只有 10 个能连上（16%）→ 画出来是 10 个点 + 54 个孤岛。
 *
 * 这里补三种更粗的信号，让网络有形状：
 *   talk  对话共现：A 和 B 在同一个群里、10 分钟内都说过话（最强，说明真的在聊）
 *   room  同群     ：A 和 B 在同一个群里（最弱，但覆盖率接近 100%）
 *   topic 同话题   ：A 和 B 各自的记忆落在同一个话题簇里（中等）
 *
 * 全部纯函数，确定性（同样输入 → 同样的边和权重）。
 */

const TALK_WINDOW_MS = 10 * 60_000     // 10 分钟内算"在同一段对话里"
const TALK_MAX_GAP_MS = 3 * 60_000     // 相邻两条不能隔太久（否则不是一段）

/**
 * 从一批消息里算"谁跟谁聊过"。
 * @param {{sender:string, ts:number, isSelf?:boolean}[]} messages
 * @returns {{a:string,b:string,n:number}[]}
 */
export function talkPairs(messages, { windowMs = TALK_WINDOW_MS, maxGapMs = TALK_MAX_GAP_MS } = {}) {
  const list = (messages || [])
    .filter((m) => m && m.sender && Number(m.ts))
    .map((m) => ({ s: String(m.sender), t: Number(m.ts) }))
    .sort((x, y) => x.t - y.t)
  const pairs = new Map()
  for (let i = 0; i < list.length; i++) {
    const A = list[i]
    for (let j = i + 1; j < list.length; j++) {
      const B = list[j]
      const gap = B.t - A.t
      if (gap > windowMs) break
      if (B.s === A.s) continue
      // 中间如果隔了很久没人说话，就不算同一段对话
      if (j > i + 1) {
        let hole = 0
        for (let k = i + 1; k < j; k++) hole = Math.max(hole, list[k].t - list[k - 1].t)
        if (hole > maxGapMs) continue
      }
      const key = [A.s, B.s].sort().join('|')
      pairs.set(key, (pairs.get(key) || 0) + 1)
    }
  }
  return [...pairs.entries()].map(([k, n]) => {
    const [a, b] = k.split('|')
    return { a, b, n }
  })
}

/**
 * 合并四种信号，产出人-人边。
 * @param {object} o
 * @param {Array<{a,b,n}>} o.talk     对话共现
 * @param {Object<string,string[]>} o.roomMembers   roomId → wxid[]
 * @param {Array<{source,target}>} o.together       同段记忆
 * @param {Object<string,string[]>} o.personTopics  wxid → 话题 id[]
 * @returns {{edges:Array, byBasis:object, degree:Map<string,number>}}
 */
export function buildPersonEdges({ talk = [], roomMembers = {}, together = [], personTopics = {} } = {}) {
  const acc = new Map()   // "a|b" → { a, b, basis:Set, w }
  const add = (a, b, basis, w) => {
    if (!a || !b || a === b) return
    const [x, y] = [a, b].sort()
    const key = x + '|' + y
    if (!acc.has(key)) acc.set(key, { a: x, b: y, w: 0, basis: new Set() })
    const e = acc.get(key)
    e.w += Number(w) || 0
    e.basis.add(basis)
  }

  // ① 对话共现（最强信号，权重按次数）
  // 权重分层：聊过 >> 同框 >> 同话题 >> 同群（不然 978 条"同群"边会把真结构淹没）
  for (const t of talk) add(t.a, t.b, 'talk', 3 * (1 + Math.log(1 + Number(t.n || 0))))

  // ② 同段记忆
  for (const e of together) add(e.source, e.target, 'memory', 2)

  // ③ 同话题（按共同话题数累加，权重最低）
  const byTopic = new Map()
  for (const [wxid, topics] of Object.entries(personTopics || {})) {
    for (const t of topics) {
      if (!byTopic.has(t)) byTopic.set(t, [])
      byTopic.get(t).push(wxid)
    }
  }
  for (const [tid, list] of byTopic) {
    const uniq = [...new Set(list)]
    if (uniq.length > 12) continue          // 太大众的话题（半个群都在）不足以说明关系
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) add(uniq[i], uniq[j], 'topic', 0.5)
    }
  }

  // ④ 同群（最弱；大群里几乎人人相连，所以群越大权重越低）
  for (const [roomId, members] of Object.entries(roomMembers || {})) {
    const uniq = [...new Set((members || []).filter(Boolean))]
    if (uniq.length < 2) continue
    const w = Math.max(0.02, 0.45 / Math.sqrt(uniq.length))
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) add(uniq[i], uniq[j], 'room', w)
    }
  }

  const edges = [...acc.values()].map((e) => ({
    source: e.a,
    target: e.b,
    w: Number(e.w.toFixed(3)),
    basis: [...e.basis].sort(),          // 可能同时是"聊过 + 同群"
  })).sort((x, y) => y.w - x.w)

  const byBasis = {}
  const degree = new Map()
  for (const e of edges) {
    byBasis[e.basis.join('+')] = (byBasis[e.basis.join('+')] || 0) + 1
    degree.set(e.source, (degree.get(e.source) || 0) + 1)
    degree.set(e.target, (degree.get(e.target) || 0) + 1)
  }
  return { edges, byBasis, degree }
}

/**
 * 社区发现（标签传播，确定性）：把关系密的人分到同一团。
 * 不用 Louvain 是刻意的 —— 这个图只有几十个点，标签传播够用且代码短。
 * @returns {Array<{id:string, members:string[], size:number, weight:number}>}
 */
export function findCommunities(edges, { maxRounds = 12 } = {}) {
  const nodes = new Set()
  const adj = new Map()
  for (const e of edges) {
    nodes.add(e.source); nodes.add(e.target)
    if (!adj.has(e.source)) adj.set(e.source, [])
    if (!adj.has(e.target)) adj.set(e.target, [])
    adj.get(e.source).push({ to: e.target, w: e.w })
    adj.get(e.target).push({ to: e.source, w: e.w })
  }
  // 初始标签：自己
  const label = new Map([...nodes].map((n) => [n, n]))
  const order = [...nodes].sort()        // 固定顺序 → 确定性
  for (let round = 0; round < maxRounds; round++) {
    let changed = false
    for (const n of order) {
      const score = new Map()
      for (const { to, w } of adj.get(n) || []) {
        const l = label.get(to)
        score.set(l, (score.get(l) || 0) + w)
      }
      if (!score.size) continue
      let best = label.get(n), bestW = score.get(best) || 0
      for (const [l, w] of score) {
        // 同分时按字符串序（确定性）
        if (w > bestW + 1e-9 || (Math.abs(w - bestW) < 1e-9 && String(l) < String(best))) { best = l; bestW = w }
      }
      if (best !== label.get(n)) { label.set(n, best); changed = true }
    }
    if (!changed) break
  }
  const groups = new Map()
  for (const [n, l] of label) {
    if (!groups.has(l)) groups.set(l, [])
    groups.get(l).push(n)
  }
  const out = [...groups.entries()].map(([id, members]) => {
    let weight = 0
    const set = new Set(members)
    for (const e of edges) if (set.has(e.source) && set.has(e.target)) weight += e.w
    return { id: 'c:' + id, members: members.sort(), size: members.length, weight: Number(weight.toFixed(2)) }
  }).sort((a, b) => b.size - a.size || b.weight - a.weight)
  return out
}

/** 一个人的"朋友圈"：按关系权重排序的邻居 */
export function friendsOf(edges, wxid, { limit = 6 } = {}) {
  return edges
    .filter((e) => e.source === wxid || e.target === wxid)
    .map((e) => ({ id: e.source === wxid ? e.target : e.source, w: e.w, basis: e.basis }))
    .sort((a, b) => b.w - a.w)
    .slice(0, limit)
}
