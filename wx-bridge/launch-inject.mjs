/**
 * 启动即注入：拉起微信后在 200ms 粒度轮询，一发现真实客户端进程就立刻注入。
 *
 * 为什么这么做：wxhelper 的原生启动器 start-wechat.exe 就是"启动微信 + 立刻注入"，
 * 而它内部钩子很可能依赖微信初始化早期就存在的结构；我们之前等 15 秒再注入，
 * 结果 DLL 的 HTTP 服务在第一次 API 请求后就死了（微信本身不崩）。
 */
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { injectDll } from './lib/inject.mjs'

const RUN = process.env.WX_RUN || 'D:\\wxhook\\wx50-run'
const EXE = RUN + '\\Weixin.exe'
const DLL = process.env.WX_DLL || 'D:\\wxhook\\wxhook.dll'

function biggestPid() {
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq Weixin.exe', '/fo', 'csv', '/nh'], { encoding: 'latin1' })
    let best = 0
    let bestKb = 0
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","([\d,]+) K"/.exec(line.trim())
      if (!m) continue
      const kb = Number(m[3].replace(/,/g, ''))
      if (kb > bestKb) { bestKb = kb; best = Number(m[2]) }
    }
    return { pid: best, mb: Math.round(bestKb / 1024) }
  } catch { return { pid: 0, mb: 0 } }
}

console.log('启动客户端:', EXE)
spawn(EXE, [], { cwd: RUN, detached: true, stdio: 'ignore' }).unref()

let done = false
for (let i = 0; i < 150; i++) {
  await sleep(200)
  const { pid, mb } = biggestPid()
  if (pid && mb >= 25) {
    console.log(`[${(i * 0.2).toFixed(1)}s] 真实客户端出现 pid=${pid} (${mb}MB) → 立刻注入`)
    const r = injectDll(pid, DLL)
    console.log('注入结果:', JSON.stringify(r))
    done = r.ok
    break
  }
}
if (!done) { console.log('未能在启动阶段找到客户端进程'); process.exit(3) }

await sleep(6000)
const { pid, mb } = biggestPid()
console.log(`6s 后：pid=${pid} (${mb}MB) 微信存活=${!!pid}`)
