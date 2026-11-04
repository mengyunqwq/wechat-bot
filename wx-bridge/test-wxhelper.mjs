/**
 * wxhelper 最小验证：注入 → 等 API → 探 checkLogin / userInfo。
 * 单独跑，避免整条桥启动失败时看不到根因。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { findMainPid, injectDll, isModuleLoaded } from './lib/inject.mjs'

const DLL = process.argv[2] || 'D:\\wxhook\\wxhook.dll'
const PORT = Number(process.argv[3] || 19088)

const pid = findMainPid('Weixin')
console.log('主进程 pid =', pid)
if (!pid) process.exit(2)

if (!isModuleLoaded(pid, DLL.replace(/^.*[\\/]/, ''))) {
  const r = injectDll(pid, DLL)
  console.log('注入结果:', JSON.stringify(r))
  if (!r.ok) process.exit(3)
} else {
  console.log('DLL 已在该进程中（跳过注入）')
}

for (let i = 1; i <= 25; i++) {
  await sleep(1000)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/checkLogin`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(6000),
    })
    console.log(`[${i}s] checkLogin ->`, await res.text())
    break
  } catch (e) {
    if (i % 5 === 0) console.log(`[${i}s] 等待 API… ${e.message}`)
    if (i === 25) { console.log('API 始终未就绪'); process.exit(4) }
  }
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/userInfo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(8000),
  })
  const t = await res.text()
  console.log('userInfo ->', t.slice(0, 500))
} catch (e) {
  console.log('userInfo 失败:', e.message)
}

// 进程是否还活着（判断 API 是否把微信搞崩）
await sleep(1500)
console.log('微信主进程是否仍存活:', !!findMainPid('Weixin'))
