/**
 * 批量：按情绪+场景现场生成表情包，并直接发到指定群。
 * 用法: node gen-and-send.mjs <roomId>
 */
import WebSocket from 'ws'

const roomId = process.argv[2] || '47390425951@chatroom'
const SPECS = [
  { emotion: '大笑', extra: '抱着奶茶笑得直不起腰，奶茶差点洒出来' },
  { emotion: '困', extra: '趴在键盘上睡着了，脸上压出键盘印' },
  { emotion: '馋', extra: '盯着翻滚的火锅流口水，手里举着筷子' },
]

const ws = new WebSocket('ws://127.0.0.1:17300')
const pending = new Map()
let idc = 0
const call = (op, args, timeoutMs = 200000) => new Promise((resolve, reject) => {
  const id = 'c' + (++idc)
  const t = setTimeout(() => { pending.delete(id); reject(new Error(op + ' 超时')) }, timeoutMs)
  pending.set(id, { resolve, reject, t })
  ws.send(JSON.stringify({ id, op, ...args }))
})

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t !== 'reply') return
  const p = pending.get(m.id)
  if (!p) return
  clearTimeout(p.t); pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

ws.on('open', async () => {
  for (const spec of SPECS) {
    const t0 = Date.now()
    try {
      console.log(`\n▶ 生成「${spec.emotion}｜${spec.extra}」…`)
      const gen = await call('genSticker', { emotion: spec.emotion, extra: spec.extra })
      console.log(`  生成完成 ${Math.round((Date.now() - t0) / 1000)}s → ${gen.stickerId}${gen.cached ? '（复用）' : ''}`)
      console.log(`  文件: ${gen.file}`)
      const sent = await call('sendSticker', { roomId, stickerId: gen.stickerId })
      console.log(`  已发送 rc=${JSON.stringify(sent)}`)
    } catch (e) {
      console.log('  失败:', e.message)
    }
  }
  console.log('\n全部完成')
  ws.close()
  process.exit(0)
})
ws.on('error', (e) => { console.log('WS 错误:', e.message); process.exit(1) })
