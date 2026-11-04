/**
 * 桥 op 端到端自测：连上（mock）桥 → 调 fetchLinkVideo → 打印返回结构。
 * 用法：node test-link-video-op.mjs [ws://127.0.0.1:17399] [url]
 * 只读网络 + 只写临时目录，不发任何消息。
 */
const url = process.argv[2] || 'ws://127.0.0.1:17399'
const target = process.argv[3] || 'https://b23.tv/BV1uT4y1P7CX'

const ws = new WebSocket(url)
const t0 = Date.now()
let done = false
const finish = (code, msg) => {
  if (done) return
  done = true
  console.log(msg)
  try { ws.close() } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 200)
}
const killer = setTimeout(() => finish(1, '❌ 超时（90s）'), 90_000)

ws.addEventListener('open', () => {
  console.log(`已连上 ${url}，调用 op=fetchLinkVideo（${target}）…`)
  ws.send(JSON.stringify({
    id: 'e2e-1', op: 'identify', name: 'link-video-e2e', pid: process.pid,
  }))
  ws.send(JSON.stringify({
    id: 'e2e-2', op: 'fetchLinkVideo',
    url: target, maxSeconds: 300, maxMB: 80, timeoutMs: 120_000, frames: 6,
  }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
  if (m.t !== 'reply' || m.id !== 'e2e-2') return
  clearTimeout(killer)
  const r = m.result || {}
  console.log('REPLY ok=' + m.ok + ' 耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
  console.log(JSON.stringify(r, null, 2).slice(0, 1200))
  if (!r.sheet) finish(1, '❌ op 没返回 sheet：' + JSON.stringify(r.error || r))
  else finish(0, '✅ op 返回了联系表/音轨结构（sheet/wav/durationSec/title/site 都在）')
})
ws.addEventListener('error', (e) => finish(1, '❌ WS 错误：' + String(e?.message || e)))
