/**
 * outbox.mjs —— 统一出站队列（节流 / 去重 / 重试退避）
 *
 * 为什么需要（2026-10-29）：
 *   以前所有发送都是"直连" `client.call('sendText', ...)`，于是出现两类真实事故：
 *     · 13 秒内连发两条语音 → 微信客户端直接退出（媒体对象所有权撞车）
 *     · 客户端退出后 75 秒内 wake 刷了 7 次，全是 fetch failed（没有退避）
 *   参考 dsh-wechat-bridge 的 "rate-limit-aware outbox"：所有出站统一进队列，
 *   在一个地方做节流、去重、失败重试。
 *
 * 设计要点：
 *   · 按 room 串行（同一个群不会两条同时飞）
 *   · 每 room 最小间隔 minGapMs（默认 1200ms）
 *   · 全局每分钟上限 maxPerMin（默认 20）
 *   · 同 room + 同样文本在 dedupeMs 内只发一次（防重复/连发）
 *   · 失败重试 maxAttempts 次，退避 baseBackoff * 2^n
 *   · priority: 'high' 忽略 minGap（但仍受全局上限），用于"必回"
 *
 * 纯逻辑 + 注入 sender，可脱离插件单测。
 */

const now0 = () => Date.now()

export function createOutbox({ send, log = () => {}, cfg = {}, now = now0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (typeof send !== 'function') throw new Error('outbox: send 必须是函数')
  const C = {
    minGapMs: 1200,
    maxPerMin: 20,
    maxAttempts: 3,
    baseBackoffMs: 2000,
    dedupeMs: 5000,
    maxQueue: 80,
    ...cfg,
  }
  /** @type {Array<{id,roomId,kind,args,priority,at,attempts,resolve,reject,key}>} */
  const queue = []
  const lastSentAt = new Map()   // roomId → ts
  const recentKeys = new Map()   // key → ts
  const sentTimes = []           // 全局 1 分钟窗口
  const stats = { enqueued: 0, sent: 0, failed: 0, deduped: 0, dropped: 0, retried: 0 }
  let running = false
  let seq = 0

  const roomLast = (roomId) => Number(lastSentAt.get(roomId) || 0)
  const pruneMinute = (t) => {
    while (sentTimes.length && t - sentTimes[0] > 60_000) sentTimes.shift()
  }

  /** 入队；返回 promise（成功 resolve 桥返回，失败 reject） */
  function enqueue({ roomId = '', kind = 'sendText', args = {}, priority = 'normal', text = '' } = {}) {
    const key = roomId + '|' + kind + '|' + String(text || JSON.stringify(args)).slice(0, 120)
    const t = now()
    const prev = recentKeys.get(key)
    if (prev && t - prev < C.dedupeMs) {
      stats.deduped++
      return Promise.resolve({ ok: true, deduped: true })
    }
    if (queue.length >= C.maxQueue) {
      stats.dropped++
      log(`出站队列满（${C.maxQueue}）→ 丢弃一条 ${kind}`)
      return Promise.resolve({ ok: false, dropped: true })
    }
    stats.enqueued++
    return new Promise((resolve, reject) => {
      queue.push({ id: ++seq, roomId, kind, args, priority, text, at: t, attempts: 0, resolve, reject, key })
      void drain()
    })
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (queue.length) {
        // 取队首可发的：优先 high，其次按入队顺序
        const t = now()
        pruneMinute(t)
        const idx = pickIndex(t)
        if (idx < 0) { await sleep(120); continue }
        const job = queue.splice(idx, 1)[0]
        await runJob(job)
      }
    } finally {
      running = false
    }
  }

  function pickIndex(t) {
    if (sentTimes.length >= C.maxPerMin) return -1                 // 全局限速
    for (let i = 0; i < queue.length; i++) {
      const j = queue[i]
      const gapOk = j.priority === 'high' ? true : (t - roomLast(j.roomId) >= C.minGapMs)
      if (gapOk) return i
    }
    return -1
  }

  async function runJob(job) {
    for (let attempt = 1; attempt <= C.maxAttempts; attempt++) {
      try {
        const res = await send(job.kind, job.args)
        lastSentAt.set(job.roomId, now())
        sentTimes.push(now())
        recentKeys.set(job.key, now())
        if (recentKeys.size > 400) {
          const keep = [...recentKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)
          recentKeys.clear()
          for (const [k, v] of keep) recentKeys.set(k, v)
        }
        stats.sent++
        job.resolve(res)
        return true
      } catch (e) {
        job.attempts = attempt
        if (attempt >= C.maxAttempts) {
          stats.failed++
          log(`出站失败（${attempt}/${C.maxAttempts}）${job.kind}：` + String(e?.message || e).slice(0, 90))
          job.reject(e)
          return false
        }
        stats.retried++
        const back = C.baseBackoffMs * Math.pow(2, attempt - 1)
        log(`出站重试（${attempt}/${C.maxAttempts}）${job.kind}，${Math.round(back / 1000)}s 后：` + String(e?.message || e).slice(0, 70))
        await sleep(back)
      }
    }
    return false
  }

  return {
    enqueue,
    sendText: (roomId, text, opts = {}) => enqueue({ roomId, kind: 'sendText', args: { roomId, text }, text, ...opts }),
    sayVoice: (roomId, args, opts = {}) => enqueue({ roomId, kind: 'sayVoice', args: { roomId, ...args }, ...opts }),
    sendSticker: (roomId, stickerId, opts = {}) => enqueue({ roomId, kind: 'sendSticker', args: { roomId, stickerId }, ...opts }),
    get stats() { return { ...stats, queue: queue.length } },
    get idle() { return queue.length === 0 },
    cfg: C,
  }
}
