/**
 * build-social.mjs —— 采集"人-人关系"原始数据到 social-cache.json
 * （和插件里 op 的逻辑一致：群成员 + 最近消息的对话共现）
 *
 * 用法：node scripts/build-social.mjs
 */
import { WebSocket } from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = process.env.SOCIAL_CACHE || 'D:/dsh/data/wechat-bot/social-cache.json'
const WIN = 10 * 60_000
const MAX_GAP = 3 * 60_000

function talkPairs(messages) {
  const list = messages.filter((m) => m && m.sender && Number(m.ts))
    .map((m) => ({ s: String(m.sender), t: Number(m.ts) }))
    .sort((a, b) => a.t - b.t)
  const pairs = new Map()
  for (let i = 0; i < list.length; i++) {
    const A = list[i]
    for (let j = i + 1; j < list.length; j++) {
      const B = list[j]
      if (B.t - A.t > WIN) break
      if (B.s === A.s) continue
      if (j > i + 1) {
        let hole = 0
        for (let k = i + 1; k < j; k++) hole = Math.max(hole, list[k].t - list[k - 1].t)
        if (hole > MAX_GAP) continue
      }
      const key = [A.s, B.s].sort().join('|')
      pairs.set(key, (pairs.get(key) || 0) + 1)
    }
  }
  return [...pairs.entries()].map(([k, n]) => { const [a, b] = k.split('|'); return { a, b, n } })
}

const ws = new WebSocket('ws://127.0.0.1:17300')
let seq = 0
const waiting = new Map()
const call = (op, a = {}, ms = 60_000) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + op)) }, ms)
  waiting.set(id, { res, rej, t })
  ws.send(JSON.stringify({ id, op, ...a }))
})

ws.on('open', async () => {
  try {
    const roomsRes = await call('rooms')
    const rooms = (Array.isArray(roomsRes) ? roomsRes : (roomsRes && roomsRes.rooms) || [])
      .map((r) => ({ id: String(r.roomId || r.wxid || ''), name: String(r.name || '') }))
      .filter((r) => r.id.endsWith('@chatroom'))
    console.log('群数:', rooms.length, rooms.map((r) => r.name).join(' / '))
    const roomMembers = {}
    const talkAcc = new Map()
    for (const r of rooms.slice(0, 5)) {
      try {
        const mm = await call('members', { roomId: r.id }, 40_000)
        const ids = ((mm && mm.members) || []).map((x) => String(x.wxid || '')).filter(Boolean)
        if (ids.length) roomMembers[r.id] = ids
        console.log(`  ${r.name}: 成员 ${ids.length}`)
      } catch (e) { console.log(`  ${r.name}: 成员读取失败 ${e.message}`) }
      try {
        const h = await call('searchMessages', { roomId: r.id, query: '', limit: 600, scan: 1500 }, 60_000)
        const msgs = ((h && h.items) || []).filter((x) => x && !x.isSelf && x.sender && x.ts)
        const ps = talkPairs(msgs)
        for (const p of ps) {
          const k = [p.a, p.b].sort().join('|')
          talkAcc.set(k, (talkAcc.get(k) || 0) + p.n)
        }
        console.log(`  ${r.name}: 消息 ${msgs.length} 条 → 对话对 ${ps.length}`)
      } catch (e) { console.log(`  ${r.name}: 消息读取失败 ${e.message}`) }
    }
    const talkPairsOut = [...talkAcc.entries()].map(([k, n]) => { const [a, b] = k.split('|'); return { a, b, n } })
    const data = { at: Date.now(), roomMembers, talkPairs: talkPairsOut }
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, JSON.stringify(data))
    console.log(`\n已写入 ${OUT}`)
    console.log(`  群 ${Object.keys(roomMembers).length} 个 / 覆盖 ${new Set(Object.values(roomMembers).flat()).size} 人 / 对话对 ${talkPairsOut.length}`)
  } catch (e) {
    console.log('❌', e.message)
  } finally {
    ws.close()
    setTimeout(() => process.exit(0), 200)
  }
})
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(String(raw)) } catch { return }
  if (m && m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); clearTimeout(w.t); waiting.delete(m.id)
    m.error ? w.rej(new Error(m.error)) : w.res(m.result ?? m)
  }
})
ws.on('error', (e) => { console.log('连不上桥:', e.message); process.exit(1) })
