/**
 * 手动测试：向群里发一条文字 + 一张**真实收藏到的表情**（走 ForwardXMLMsg）。
 * 用法: node send-test-sticker.mjs <roomId> <stickerId>
 */
import WebSocket from 'ws'

const [, , roomId, stickerId] = process.argv
if (!roomId || !stickerId) { console.log('用法: node send-test-sticker.mjs <roomId> <stickerId>'); process.exit(1) }

const ws = new WebSocket('ws://127.0.0.1:17300')
const send = (id, op, args) => ws.send(JSON.stringify({ id, op, ...args }))

ws.on('open', () => {
  console.log('已连桥，先发文字…')
  send('t1', 'sendText', { roomId, text: '给你们看个表情' })
})

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t !== 'reply') return
  console.log(`[${m.op}] ok=${m.ok}`, m.ok ? JSON.stringify(m.result) : '错误: ' + m.error)
  if (m.id === 't1') {
    console.log('再发收藏到的表情…')
    send('t2', 'sendSticker', { roomId, stickerId })
  } else if (m.id === 't2') {
    ws.close()
    process.exit(m.ok ? 0 : 3)
  }
})

setTimeout(() => { console.log('超时'); process.exit(2) }, 30000)
