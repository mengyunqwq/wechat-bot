/**
 * Web 控制面板（宿主侧）。
 *
 * 设计约束：
 *   1. 不新起进程、不改 DSH 本体：直接挂在 DSH 已有的 webServer 上（/wechat-bot）。
 *   2. 配置只有一份事实来源：改值走 index.js 的 applyConfigPatch（与 wechat_bot_config 同一入口），
 *      面板不自己写 config.json。
 *   3. 鉴权复用 DSH 的 connection 栅栏（Host/Origin/cookie）；写操作再要求 JSON + 同源。
 *   4. 卸载即净：路由挂在 ctx.effect 上，热重载不会残留导致 duplicate route。
 *
 * 前端是 panel/index.html 单文件（内联 CSS/JS，零构建）；本文件只做路由 + JSON API。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_CANDIDATES = [join(HERE, '..', 'panel', 'index.html'), join(HERE, 'panel.html')]

const HIGH_RISK_OPS = new Set(['genSticker', 'douyinBrush', 'selfheal', 'memory.clear', 'memory.clearAll', 'config.import'])
const ALLOWED_OPS = new Set([
  'status', 'selfcheck', 'rooms', 'members', 'history', 'searchMessages',
  'sendText', 'sayVoice', 'sendSticker', 'pickSticker', 'voiceSwitch', 'pat',
  'stickers', 'genSticker', 'genEmotions',
  'memory.list', 'memory.add', 'memory.clear', 'memory.extract',
  'names.set', 'names.add', 'names.refresh',
  // 2026-10-22 新增：用量统计 / 环境诊断 / 自动更新
  'usage', 'diag', 'diagCleanHires',
  'eyesInfo', 'eyesSetDir', 'eyesToggle', 'eyesClean',
  'eyesUpload', 'eyesInstall', 'eyesCheck',
  'checkUpdate', 'updateInfo', 'applyUpdate',
])

// 不做模块级缓存：热重载后 panel/index.html 的改动必须立刻可见
// （踩过：cachedPage 留在旧模块里，页面看起来"改了不生效"）。
function pageHtml() {
  for (const p of PAGE_CANDIDATES) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch { /* 试下一个 */ }
  }
  return '<!doctype html><meta charset="utf-8"><h1>面板文件缺失</h1><p>找不到 panel/index.html，请重新注入插件。</p>'
}

function json(res, status, body) {
  const s = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
  })
  res.end(s)
}

function html(res, body, status = 200) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('JSON 解析失败：' + e.message)) }
    })
    req.on('error', reject)
  })
}

/** 取目录里最新的匹配文件（日志按时间戳命名，字典序即时间序）。 */
function latestFile(dir, re) {
  try {
    if (!dir) return ''
    const files = readdirSync(dir).filter((f) => re.test(f)).sort()
    return files.length ? join(dir, files[files.length - 1]) : ''
  } catch { return '' }
}

/** 只读文件尾部 N 行（日志可能几百 MB，不能整读）。 */
function tailLines(file, n = 200) {
  if (!existsSync(file)) return ''
  const st = statSync(file)
  const maxBytes = Math.min(st.size, 1024 * 1024)
  const start = Math.max(0, st.size - maxBytes)
  const buf = Buffer.alloc(maxBytes)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, maxBytes, start) } finally { closeSync(fd) }
  const text = buf.toString('utf8')
  const lines = text.split(/\r?\n/)
  if (start > 0) lines.shift()          // 首行可能被截断，丢掉
  return lines.slice(-n).join('\n')
}

function maskIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
}

/**
 * 挂载面板。
 * @param {object} ctx cordis 上下文
 * @param {object} api 由 index.js 提供的访问器（见文件底部调用处）
 */
export function setupPanel(ctx, api) {
  const getService = (name) => {
    try { return (typeof ctx.get === 'function' ? ctx.get(name) : null) ?? ctx[name] } catch { return null }
  }
  const getWs = () => getService('webServer')
  const getConn = () => getService('connection')

  let mounted = false
  let tries = 0
  const mount = () => {
    if (mounted) return
    const ws = getWs()
    if (!ws || typeof ws.register !== 'function') {
      // 注入后服务的就绪时间不确定（实测 inject 后 20 秒都还没就绪）→ 重试 5 分钟，2 秒一次
      if (++tries <= 150) { setTimeout(mount, 2000); return }
      api.log('面板：没有可用的 webServer 服务，已跳过挂载（机器人功能不受影响）')
      return
    }
    mounted = true
    try {
      ctx.effect(() => ws.register({ kind: 'prefix', path: '/wechat-bot', handler: handle }), 'dsh-wechat-bot: panel route')
      api.log('面板已挂载：/wechat-bot')
    } catch (e) {
      mounted = false
      api.log('面板挂载失败：' + String(e?.message || e))
    }
  }

  const audit = (req, op, detail) => {
    try {
      const file = join(dirname(api.configFile), 'panel-audit.log')
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, JSON.stringify({
        at: new Date().toISOString(), ip: maskIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120),
        op, detail,
      }) + '\n')
    } catch { /* ignore */ }
  }

  const isApi = (pathname) => pathname === '/wechat-bot/api' || pathname.startsWith('/wechat-bot/api/')

  async function handle(req, res) {
    let pathname = '/wechat-bot'
    try { pathname = new URL(req.url || '/', 'http://x').pathname } catch { /* ignore */ }
    const apiPath = isApi(pathname)

    // ① DSH 登录/同源栅栏（面板不自己搞一套账号）
    const conn = getConn()
    if (conn && typeof conn.requestRejection === 'function') {
      let rejection
      try { rejection = conn.requestRejection({ headers: req.headers }) } catch { rejection = undefined }
      if (rejection !== undefined) {
        if (apiPath) return json(res, rejection === 401 ? 401 : 403, { ok: false, error: rejection === 401 ? '未登录或登录已过期' : '来源不受信任' })
        return html(res, `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;max-width:34em;margin:auto">
<h2>🔐 需要先登录 DSH</h2><p>请在同一个浏览器里打开 <a href="/">DSH 主界面</a> 完成登录，再回到本页。</p>
<p style="color:#667">（HTTP ${rejection === 401 ? 401 : 403}）</p></body>`, rejection === 401 ? 401 : 403)
      }
    }

    if (!apiPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' })
      return html(res, pageHtml())
    }

    // ② 写操作：只收 JSON + 同源（浏览器会带 Sec-Fetch-Site）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = String(req.headers['content-type'] || '')
      if (!ct.includes('application/json')) return json(res, 415, { ok: false, error: '只接受 application/json' })
      const site = String(req.headers['sec-fetch-site'] || '')
      if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
    }

    const sub = pathname.slice('/wechat-bot/api'.length) || '/'

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (sub === '/state') return json(res, 200, await buildState(req))
        if (sub === '/logs') {
          const u = new URL(req.url, 'http://x')
          const lines = Math.max(20, Math.min(2000, Number(u.searchParams.get('lines')) || 200))
          const source = u.searchParams.get('source') === 'bridge' ? 'bridge' : 'bot'
          const file = source === 'bridge'
            ? (api.bridgeLogFile?.() || latestFile(api.bridgeLogDir, /^bridge-.*\.log$/i))
            : api.logFile
          const text = tailLines(file, lines)
          return json(res, 200, { ok: true, source, file, lines, text })
        }
        if (sub === '/export') {
          const dump = {}
          for (const k of Object.keys(api.defaults)) dump[k] = api.config[k]
          return json(res, 200, { ok: true, at: new Date().toISOString(), config: dump })
        }
        if (sub === '/meta') return json(res, 200, { ok: true, meta: api.meta || {}, groups: api.groups || [], features: api.features || [] })
        if (sub === '/providers') {
          const state = await api.providersState?.()
          return json(res, 200, { ok: true, ...state, config: { provider: api.config.provider, model: api.config.model, visionProvider: api.config.visionProvider, visionModel: api.config.visionModel } })
        }
        if (sub === '/providers/models') {
          const u = new URL(req.url, 'http://x')
          const provider = String(u.searchParams.get('provider') || '')
          return json(res, 200, { ok: true, models: await api.providerModels?.(provider) })
        }
        if (sub === '/image') {
          return json(res, 200, { ok: true, config: api.imageConfig?.() || null })
        }
        return json(res, 404, { ok: false, error: '未知接口：' + sub })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)

        if (sub === '/providers/save') {
          const r = await api.providerSave?.(body)
          audit(req, 'providers.save', { provider: body?.provider, keyRef: body?.keyRef })
          return json(res, 200, { ok: true, ...r })
        }
        if (sub === '/providers/remove') {
          const r = await api.providerRemove?.(body)
          audit(req, 'providers.remove', { provider: body?.provider })
          return json(res, 200, { ok: true, ...r })
        }
        if (sub === '/providers/test') {
          const r = await api.providerTest?.(body)
          audit(req, 'providers.test', { provider: body?.provider, model: body?.model })
          return json(res, 200, { ok: true, ...r })
        }
        if (sub === '/image') {
          const r = await api.imageSave?.(body)
          audit(req, 'image.save', { model: body?.model, apiUrl: body?.apiUrl })
          return json(res, 200, { ok: true, ...r })
        }

        if (sub === '/config') {
          const patch = body?.patch
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return json(res, 400, { ok: false, error: '需要 {patch:{key:value}}' })
          const r = api.applyConfigPatch(patch)
          audit(req, 'config', { patch, applied: r.applied, rejected: r.rejected })
          return json(res, r.ok ? 200 : 400, r)
        }

        if (sub === '/import') {
          const cfg = body?.config
          if (!cfg || typeof cfg !== 'object') return json(res, 400, { ok: false, error: '需要 {config:{...}}' })
          if (body?.confirm !== 'import') return json(res, 400, { ok: false, error: '导入需要 confirm:"import"' })
          const r = api.applyConfigPatch(cfg)
          audit(req, 'config.import', { keys: Object.keys(cfg), ok: r.ok })
          return json(res, r.ok ? 200 : 400, r)
        }

        if (sub === '/action') {
          const op = String(body?.op || '')
          if (!ALLOWED_OPS.has(op)) return json(res, 400, { ok: false, error: '不允许的操作：' + op })
          if (HIGH_RISK_OPS.has(op) && body?.confirm !== op) {
            return json(res, 400, { ok: false, error: `高风险操作需要 confirm:"${op}"` })
          }
          const result = await api.handleAction(op, body?.args || {})
          audit(req, 'action:' + op, { args: body?.args || {} })
          return json(res, 200, { ok: true, op, result })
        }

        if (sub === '/ping') return json(res, 200, { ok: true, at: Date.now() })
        return json(res, 404, { ok: false, error: '未知接口：' + sub })
      }

      return json(res, 405, { ok: false, error: 'method not allowed' })
    } catch (e) {
      const msg = String(e?.message || e)
      api.log('面板接口异常 ' + pathname + '：' + msg)
      return json(res, 500, { ok: false, error: msg })
    }
  }

  async function buildState(req) {
    const u = new URL(req.url || '/', 'http://x')
    const lite = u.searchParams.get('lite') === '1'
    try { await api.refreshRoomNames?.() } catch { /* 群名拿不到就用 roomId */ }
    const cfg = api.config
    let bridge = null
    let bridgeErr = ''
    if (!lite && api.client.status.connected) {
      try { bridge = await api.client.call('status', {}, 2500) } catch (e) { bridgeErr = String(e?.message || e) }
    }
    const rooms = [...api.rooms.values()].map((r) => {
      let snap = null
      try { snap = r.policy.snapshot() } catch { /* ignore */ }
      return {
        roomId: r.roomId,
        roomName: api.roomName?.(r.roomId) || r.roomName,
        msgs: (r.msgs || []).length,
        facts: (r.facts || []).length,
        lastActivityAt: r.lastActivityAt || 0,
        lastProactiveAt: r.lastProactiveAt || 0,
        proactiveStreak: r.proactiveStreak || 0,
        pendingQuestion: r.pendingQuestion?.text || '',
        policy: snap,
        recent: (r.msgs || []).slice(-6).map((m) => ({
          ts: m.ts, isSelf: !!m.isSelf, sender: m.sender,
          senderName: api.senderName?.(m.sender) || m.senderName || m.sender || '',
          text: m.text,
        })),
      }
    })
    const h = api.lastHealth?.() || null
    // 还没有活动群时（刚重载/还没收到消息），至少把桥知道的群列出来，别显示"没有群"
    let bridgeRooms = []
    if (!rooms.length && !lite && api.client.status.connected) {
      try {
        const list = await api.client.call('rooms', {}, 3000)
        bridgeRooms = (list || []).map((x) => ({ roomId: x.roomId, name: api.roomName?.(x.roomId) || x.name || x.roomId }))
      } catch { /* ignore */ }
    }
    return {
      ok: true,
      at: Date.now(),
      version: api.version,
      config: cfg,
      defaults: api.defaults,
      meta: api.meta || {},
      groups: api.groups || [],
      features: api.features || [],
      stats: { ...api.stats },
      rooms,
      bridgeRooms,
      bridge: {
        connected: !!api.client.status.connected,
        reconnects: api.client.status.reconnects || 0,
        lastError: api.client.status.lastError || '',
        status: bridge,
        error: bridgeErr,
      },
      health: h,
      route: api.lastRoute?.() || null,
      services: {
        speechToText: !!api.hasSpeech?.(),
        attachments: !!api.hasAttachments?.(),
      },
      names: api.nameCounts?.() || null,
      paths: { config: api.configFile, memory: api.memoryDir, log: api.logFile, bridgeLogDir: api.bridgeLogDir || '' },
      selfCheck: api.selfCheckInfo?.() || null,
    }
  }

  mount()
}
