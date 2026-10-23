/**
 * pet-bridge.mjs —— 桌宠联动（dsh-pet：桌面上的蓝色大肥鱼）
 *
 * 定位：**她才是本体，微信只是她干活的手。**
 * 这个模块把机器人的活动翻译成桌宠的动作和表情，让她看起来像真的在操作微信：
 *
 *   群里有人说话     → 表情（默认「点击回应-害羞惊讶」）
 *   开始动脑子想回什么 → 动作（默认「工作状态-思考冒泡」）
 *   回复发出去       → 动作（默认「工作状态-雀跃庆祝」）
 *   出错 / 失联      → 表情（默认「工作状态-垂头叹气冒汗」）
 *
 * 依赖 dsh-pet 插件提供的 HTTP 接口（挂在 DSH web 端口上，**不需要鉴权**）：
 *   POST /dsh-pet-7340/anim?pet=<id>&surface=<web|desktop|both|any>      { name }
 *   POST /dsh-pet-7340/broadcast?...                                     { text, duration, image?, url? }
 *   POST /dsh-pet-7340/work-status?...                                   { state, task? }
 *
 * 设计口径：
 *   · **全部静默失败**：没装桌宠 / 没开 / 端口换了 / 桌宠没在显示 —— 一律吞掉，
 *     绝不影响机器人本体（这条是硬要求：桌宠是装饰，机器人不能因为装饰挂掉）。
 *   · **限频**：动作最短间隔（默认 2s），同一种动作 6s 内不重播，防刷屏。
 *   · 不发请求前先看 config.petSync 开关，关掉就是零开销。
 */

const PET_ROUTE = '/dsh-pet-7340'

export function createPetBridge({ getConfig, log }) {
  let lastAnimAt = 0
  let lastAnimName = ''

  const cfg = () => (getConfig && getConfig()) || {}
  const enabled = () => {
    const c = cfg()
    return c.petSync !== false
  }

  async function post(path, body, timeoutMs = 2500) {
    const c = cfg()
    const base = String(c.petSyncBaseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '')
    const pet = encodeURIComponent(String(c.petSyncPetId || 'main'))
    const surface = encodeURIComponent(String(c.petSyncSurface || 'desktop'))
    const url = `${base}${PET_ROUTE}${path}?pet=${pet}&surface=${surface}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ac.signal,
      })
      const json = await res.json().catch(() => null)
      if (json && json.ok === false) {
        // 失败原因只打 debug 日志（pet-not-displayed 之类属于正常情况：桌宠没开）
        if (log) log('[pet] ' + path + ' 被拒：' + (json.reason || '') + ' ' + (json.message || ''))
      }
      return json
    } catch (e) {
      // 连不上 = 没装桌宠 / DSH 端口变了 → 静默
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 播一段动作（name 是素材池里的名字，见 assets/webm） */
  async function anim(name, { force = false } = {}) {
    if (!name || !enabled()) return false
    const now = Date.now()
    const gap = Number(cfg().petSyncMinGapMs || 2000)
    if (!force) {
      if (now - lastAnimAt < gap) return false
      // 同一个动作短时间内不重播（思考冒泡连着播会很傻）
      if (lastAnimName === name && now - lastAnimAt < gap * 3) return false
    }
    lastAnimAt = now
    lastAnimName = name
    const r = await post('/anim', { name: String(name) })
    return !!(r && r.ok)
  }

  /** 让她气泡冒一句话（可选配表情包池里的图） */
  async function say(text, { duration = 8000, image } = {}) {
    const t = String(text || '').trim()
    if (!t || !enabled()) return false
    const body = { text: t.slice(0, 300), duration }
    if (image) body.image = String(image)
    const r = await post('/broadcast', body)
    return !!(r && r.ok)
  }

  /** 工作状态（working / idle 之类，桌宠会话取它做小动作） */
  async function work(state, task) {
    if (!enabled() || !state) return false
    const body = { state: String(state) }
    if (task) body.task = String(task).slice(0, 120)
    const r = await post('/work-status', body)
    return !!(r && r.ok)
  }

  return { anim, say, work, enabled }
}
