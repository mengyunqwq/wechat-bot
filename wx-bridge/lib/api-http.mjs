/**
 * wx-bridge 的 HTTP API —— 给"只会 HTTP"的 agent/脚本用。
 *
 * 设计：**复用 WS 的同一个 handle(op, args) 分发器**，所以每个接口的行为和 WS 完全一致，
 * 不需要为 HTTP 再写一份业务逻辑。
 *
 * room 参数可以是：roomId、群名（模糊匹配）、或留空（只有一个群时自动选中）
 */

const JSON_HDR = { 'content-type': 'application/json; charset=utf-8' }

function sendJson(res, code, obj) {
  res.writeHead(code, JSON_HDR)
  res.end(JSON.stringify(obj, null, 2))
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { req.destroy(); resolve({}) ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * @param {object} o
 * @param {(op:string, args:object)=>Promise<any>} o.handle  桥的业务分发器
 * @param {()=>Promise<any>} o.rooms                         取会话列表
 * @param {(s:string)=>void} o.log
 * @param {object} o.bridge                                   真实桥实例（取 status 等）
 * @param {object} o.counters
 * @param {number} o.startedAt
 */
export function createApiHandler({ handle, rooms, log, bridge, counters, startedAt, hosted = null }) {
  /** room（id 或名字）→ roomId */
  async function resolveRoom(input) {
    const want = String(input || '').trim()
    let list = []
    try {
      const r = await rooms()
      list = Array.isArray(r) ? r : (r?.rooms || [])
    } catch { /* ignore */ }
    if (!want) {
      if (list.length === 1) return list[0].roomId || list[0].id
      throw new Error('没指定 room，且不止一个会话。可用：'
        + list.map((x) => x.name || x.roomName || x.roomId).join('、'))
    }
    const hit = list.find((x) => (x.roomId || x.id) === want
      || (x.name || x.roomName || '') === want
      || String(x.name || x.roomName || '').includes(want))
    return hit ? (hit.roomId || hit.id) : want
  }

  return async function handleApi(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/api'
    const q = url.searchParams
    try {
      // ── 只读 ──────────────────────────────────────────────
      if (path === '/api/status') {
        return sendJson(res, 200, {
          ...bridge.status(), startedAt, counters, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        })
      }
      if (path === '/api/rooms') return sendJson(res, 200, await handle('rooms'))
      if (path === '/api/members') {
        const roomId = await resolveRoom(q.get('room'))
        return sendJson(res, 200, await handle('members', { roomId }))
      }
      if (path === '/api/messages') {
        const roomId = await resolveRoom(q.get('room'))
        return sendJson(res, 200, await handle('history', { roomId, limit: Number(q.get('limit')) || 20 }))
      }
      if (path === '/api/stickers') {
        return sendJson(res, 200, await handle('stickers', { limit: Number(q.get('limit')) || 50 }))
      }
      if (path === '/api/emotions') return sendJson(res, 200, await handle('genEmotions'))

      // ── 动作（POST） ──────────────────────────────────────
      const body = req.method === 'POST' ? await readBody(req) : {}
      const arg = (k, d = '') => (body[k] !== undefined ? body[k] : q.get(k) ?? d)

      if (path === '/api/send') {
        const roomId = await resolveRoom(arg('room'))
        const text = String(arg('text'))
        if (!text) throw new Error('需要 text')
        return sendJson(res, 200, await handle('sendText', {
        roomId, text,
        // split=true → 长文本自动拆成多条发
        split: arg('split') === true || arg('split') === 'true',
        maxLines: Number(arg('maxLines')) || undefined,
      }))
      }
      if (path === '/api/sticker/send') {
        const roomId = await resolveRoom(arg('room'))
        const picked = await handle('pickSticker', { text: String(arg('text')), roomId, minScore: 0 })
        if (!picked?.id) throw new Error('表情包库里没有可发的')
        const sent = await handle('sendSticker', { roomId, stickerId: picked.id })
        return sendJson(res, 200, { ...sent, stickerId: picked.id, tags: picked.tags || [] })
      }
      if (path === '/api/sticker/gen') {
        const subject = String(arg('subject'))
        if (!subject) throw new Error('需要 subject（题材，如 委屈 / 摸鱼 / 吃饭）')
        const gen = await handle('genSticker', {
          emotion: subject,
          extra: String(arg('scene')),
          bubble: String(arg('bubble')),
          force: arg('force') === true || arg('force') === 'true',
        })
        if (arg('room') && gen?.stickerId) {
          const roomId = await resolveRoom(arg('room'))
          await handle('sendSticker', { roomId, stickerId: gen.stickerId })
        }
        return sendJson(res, 200, gen)
      }
      if (path === '/api/image') {
        const roomId = await resolveRoom(arg('room'))
        const r = await handle('fetchMedia', { xml: '', type: 3, roomId, ts: Number(arg('ts')) || 0 })
        if (!r?.file) throw new Error('没取到图片（可能未下载或解密密钥失效）')
        return sendJson(res, 200, { file: r.file, note: '解密后的临时文件，识别完请删除' })
      }
      if (path === '/api/pat') {
        const roomId = await resolveRoom(arg('room'))
        return sendJson(res, 200, await handle('pat', { roomId, wxid: String(arg('wxid')) }))
      }
      if (path === '/api/revoke') {
        const roomId = await resolveRoom(arg('room'))
        return sendJson(res, 200, await handle('revoke', { roomId, msgid: String(arg('msgid')) }))
      }

      // ── 托管模式配置 ───────────────────────────────────────
      if (path === '/api/hosted') {
        if (!hosted) throw new Error('托管模式未启用')
        if (req.method === 'GET') return sendJson(res, 200, hosted.status())
        const patch = await readBody(req)
        return sendJson(res, 200, hosted.save(patch || {}))
      }

      // ── 策略服务（让外部 agent 复用拟人逻辑）─────────────────
      if (path === '/api/policy/decide') {
        const roomId = await resolveRoom(arg('room'))
        const text = String(arg('text') || '')
        const priority = String(arg('priority') || 'ambient')
        const r = hosted ? hosted.room(roomId) : null
        if (!r) throw new Error('策略服务需要托管模式已初始化')
        const { RoomPolicy, detectTrigger, humanDelayMs, isQuiet, parseQuietWindows } = await import('./policy.mjs')
        const quiet = isQuiet(parseQuietWindows(String(arg('quietHours') || '23:00-08:00')))
        const d = r.policy.decide({ priority, now: Date.now(), quiet, text })
        return sendJson(res, 200, {
          ...d,
          delayMs: d.reply ? humanDelayMs(text || '嗯', priority) : 0,
        })
      }
      if (path === '/api/policy/deliver') {
        const roomId = await resolveRoom(arg('room'))
        const text = String(arg('text') || '')
        const priority = String(arg('priority') || 'ambient')
        if (!text) throw new Error('需要 text')
        const { splitMessage, humanDelayMs, gapMs } = await import('./policy.mjs')
        const parts = splitMessage(text, { chance: Number(arg('splitChance') ?? 0.3), maxParts: Number(arg('maxLines') ?? 3) })
        let total = 0
        for (let i = 0; i < parts.length; i++) {
          const d = humanDelayMs(parts[i], priority)
          total += d
          await new Promise((r) => setTimeout(r, d))
          await handle('sendText', { roomId, text: parts[i] })
          if (i < parts.length - 1) { const g = gapMs(); total += g; await new Promise((r) => setTimeout(r, g)) }
        }
        return sendJson(res, 200, { sent: parts.length, parts, totalDelayMs: total })
      }

      return sendJson(res, 404, { error: '未知接口：' + path, hint: '见 PROTOCOL.md' })
    } catch (e) {
      const msg = String(e?.message || e)
      log('API 失败 ' + path + '：' + msg)
      return sendJson(res, 400, { error: msg })
    }
  }
}
