/**
 * 用启动参数拉起客户端：StartPort / RecvType=1 / CallBackURL
 * 这是该 DLL 文档里"收消息"的正规路径（/set_callback 只是运行时改配置，钩子要在启动时装）。
 */
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 18998
const API = 30001
const RUN = 'D:\\wxhook\\hook-run'

const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    console.log(`\n>>> 回调 ${req.method} ${req.url}`)
    console.log('    body:', body.slice(0, 1200))
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
})

await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
console.log(`回调监听 127.0.0.1:${PORT}`)

try { execFileSync('taskkill', ['/IM', 'Weixin.exe', '/F'], { stdio: 'ignore' }) } catch { /* 没在跑 */ }
await sleep(4000)

spawn(`${RUN}\\Weixin.exe`, [
  `StartPort=${API}`,
  'RecvType=1',
  `CallBackURL=http://127.0.0.1:${PORT}`,
], { cwd: RUN, detached: true, stdio: 'ignore' }).unref()

console.log('已带启动参数拉起客户端：StartPort=%d RecvType=1 CallBackURL=http://127.0.0.1:%d', API, PORT)
console.log('等待登录与消息推送，共 150 秒…')

// 期间定期确认 HTTP 服务
for (let i = 1; i <= 15; i++) {
  await sleep(10000)
  let st = '未就绪'
  try {
    const r = await fetch(`http://127.0.0.1:${API}/QueryDB/status`, { signal: AbortSignal.timeout(3000) })
    st = await r.text()
  } catch { /* ignore */ }
  console.log(`[${i * 10}s] API: ${st.replace(/\s+/g, ' ')}`)
}
console.log('观察结束')
process.exit(0)
