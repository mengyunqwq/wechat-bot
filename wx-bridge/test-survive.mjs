/**
 * 存活观察：只注入、不调 API、不登录，看微信能活多久。
 * 用来区分「注入本身致命」还是「登录/收消息/API 调用致命」。
 */
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { findMainPid, injectDll, isModuleLoaded } from './lib/inject.mjs'

function portUp(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
    setTimeout(() => done(false), 2000)
  })
}

const DLL = 'D:\\wxhook\\wxhook.dll'
const pid = findMainPid('Weixin')
console.log('主进程 pid =', pid)
if (!pid) process.exit(2)

if (!isModuleLoaded(pid, 'wxhook.dll')) {
  console.log('注入:', JSON.stringify(injectDll(pid, DLL)))
} else {
  console.log('DLL 已加载，跳过注入')
}

for (let i = 1; i <= 6; i++) {
  await sleep(15000)
  const alive = !!findMainPid('Weixin')
  const up = await portUp(19088)
  console.log(`[${i * 15}s] 微信存活=${alive}  API端口19088=${up}`)
  if (!alive) { console.log('>>> 微信已退出（注入后未做任何 API 调用）'); break }
}
console.log('观察结束')
