import { WebSocket } from 'ws'

const ws = new WebSocket('ws://127.0.0.1:17300')
let seq = 0
const waiting = new Map()
const call = (op, a = {}) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => rej(new Error('timeout')), 40_000)
  waiting.set(id, { res, rej, t })
  ws.send(JSON.stringify({ id, op, ...a }))
})

ws.on('open', async () => {
  for (const room of ['48684538221@chatroom', '47390425951@chatroom', '45701312872@chatroom']) {
    try {
      const r = await call('searchMessages', { roomId: room, query: '', limit: 240, scan: 800 })
      const items = (r && r.items) || []
      const mine = items.filter((m) => m.isSelf && m.text && !/^<\?xml/i.test(String(m.text)))
      console.log(`${room}: 共 ${items.length} 条｜她自己说的 ${mine.length} 条`)
      for (const m of mine.slice(-3)) console.log('   ·', String(m.text).slice(0, 46))
    } catch (e) { console.log(room, '失败:', e.message) }
  }
  ws.close()
  setTimeout(() => process.exit(0), 200)
})
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(String(raw)) } catch { return }
  if (m && m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); clearTimeout(w.t); waiting.delete(m.id)
    m.error ? w.rej(new Error(m.error)) : w.res(m.result ?? m)
  }
})
ws.on('error', (e) => { console.log('连不上:', e.message); process.exit(1) })
