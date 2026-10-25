/**
 * 分阶段探测：每一步只做一个动作，然后检查微信是否存活，精确定位崩溃触发点。
 * 用法：先启动本脚本（它会等 45s 让用户扫码登录），再让用户登录。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { findMainPid } from './lib/inject.mjs'

const PORT = 19088
const alive = () => !!findMainPid('Weixin')

async function call(path, timeoutMs = 8000) {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    return { ok: true, ms: Date.now() - t0, body: text.slice(0, 300) }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e.message || e).slice(0, 120) }
  }
}

function report(tag, r) {
  const state = alive() ? '存活' : '★已崩溃★'
  console.log(`[${tag}] 微信=${state}  ${r.ok ? 'HTTP返回' : '请求失败'}(${r.ms}ms) ${r.ok ? r.body : r.err}`)
}

console.log('=== 分阶段探测开始 ===')
console.log('现在请扫码登录；脚本会等 45s 再开始探测。')
console.log('注入状态: DLL 应已在进程中（前面已注入）')
console.log('初始存活:', alive())

await sleep(45000)
console.log('--- 登录窗口期结束，开始探测 ---')
console.log('登录后（未调任何 API）存活:', alive())

// 阶段 1：最"无害"的接口
report('userInfo', await call('/api/userInfo'))
await sleep(3000)
console.log('  3s 后存活:', alive())
if (!alive()) process.exit(0)

// 阶段 2：登录检查（此前怀疑的凶手）
report('checkLogin', await call('/api/checkLogin'))
await sleep(3000)
console.log('  3s 后存活:', alive())
if (!alive()) process.exit(0)

// 阶段 3：注册消息回调（群聊必需）
report('hookSyncMsg', await call('/api/hookSyncMsg'))
await sleep(5000)
console.log('  5s 后存活:', alive())
if (!alive()) process.exit(0)

// 阶段 4：联系人（群列表来源）
report('getContactList', await call('/api/getContactList', 20000))
await sleep(3000)
console.log('  3s 后存活:', alive())

console.log('=== 探测结束 ===')
