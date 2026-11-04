/**
 * 验证 /set_callback：注册回调地址 → 等待微信把新消息推给我们。
 * 这一步决定"收消息"是走推送还是只能轮询数据库。
 */
import http from 'node:http'

const PORT = 18998
const HOOK = 'http://127.0.0.1:30001'

const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    console.log(`\n>>> 收到回调 ${req.method} ${req.url}`)
    console.log('    headers:', JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host'))))
    console.log('    body:', body.slice(0, 800))
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
})

srv.listen(PORT, '127.0.0.1', async () => {
  console.log(`回调服务器已监听 127.0.0.1:${PORT}`)

  const variants = [
    { url: `http://127.0.0.1:${PORT}` },
    { callback_url: `http://127.0.0.1:${PORT}` },
    { CallBackURL: `http://127.0.0.1:${PORT}` },
    { url: `http://127.0.0.1:${PORT}`, recv_type: 1 },
    { callbackUrl: `http://127.0.0.1:${PORT}`, RecvType: 1 },
  ]
  for (const v of variants) {
    try {
      const r = await fetch(`${HOOK}/set_callback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v),
        signal: AbortSignal.timeout(8000),
      })
      console.log(`set_callback ${JSON.stringify(v)} -> ${await r.text()}`)
    } catch (e) {
      console.log(`set_callback ${JSON.stringify(v)} -> ERR ${e.message}`)
    }
  }

  console.log('\n现在请在手机上给机器人账号发一条消息（任意内容），我等 90 秒…')
  setTimeout(() => { console.log('等待结束'); process.exit(0) }, 90000)
})
