/**
 * verify-voice.mjs —— 验证"语音发送"链路，**只发文件传输助手**，绝不发群
 *
 * 规矩（R19 补充，2026-10-29 用户要求）：
 *   凡是验证发送类功能（语音/表情/图片），一律发到 filehelper（文件传输助手），
 *   不要拿真实的群当试验场。
 *
 * 用法：
 *   node scripts/verify-voice.mjs            # 发一句默认测试语音
 *   node scripts/verify-voice.mjs "自定义文本"
 *
 * 退出码：0 = 发送成功；1 = 失败
 */
import { WebSocket } from 'ws'

const ROOM = process.env.VOICE_TEST_ROOM || 'filehelper'   // 🔒 只允许 filehelper
if (ROOM !== 'filehelper') {
  console.error('❌ 按规矩只能发 filehelper（文件传输助手），不拿群当试验场')
  process.exit(1)
}

const TEXT = String(process.argv[2] || '这是一条测试语音，验证发送链路').slice(0, 60)
const URL = process.env.BRIDGE_WS || 'ws://127.0.0.1:17300'

const ws = new WebSocket(URL)
let seq = 0
const waiting = new Map()

function call(op, args = {}, timeoutMs = 180_000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout ' + op)) }, timeoutMs)
    waiting.set(id, { resolve, reject, t })
    // ★ 桥的协议是扁平参数（server.mjs: const { id, op, ...args } = msg）
    ws.send(JSON.stringify({ id, op, ...args }))
  })
}

ws.on('open', async () => {
  console.log(`发语音到「${ROOM}」（文件传输助手）：${TEXT}`)
  const t0 = Date.now()
  try {
    const r = await call('sayVoice', { roomId: ROOM, text: TEXT, emotion: 'main' })
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    if (r && (r.ok || r.bytes)) {
      console.log(`✅ 发送成功（${sec}s）：${r.bytes || '?'} 字节 / ${r.durationMs || '?'}ms`)
    } else {
      console.log(`❌ 发送失败（${sec}s）：` + JSON.stringify(r).slice(0, 300))
      process.exitCode = 1
    }
  } catch (e) {
    console.log('❌ 异常：' + String(e?.message || e))
    process.exitCode = 1
  } finally {
    ws.close()
    setTimeout(() => process.exit(process.exitCode || 0), 200)
  }
})

ws.on('message', (raw) => {
  let m
  try { m = JSON.parse(String(raw)) } catch { return }
  if (m && m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    clearTimeout(w.t)
    waiting.delete(m.id)
    if (m.error) w.reject(new Error(m.error))
    else w.resolve(m.result !== undefined ? m.result : m)
  }
})

ws.on('error', (e) => { console.error('❌ 连不上桥：' + String(e?.message || e)); process.exit(1) })
