/**
 * 自研注入器自测：起一个记事本 → 注入系统无害 DLL → 校验模块表里确实出现。
 * 不碰微信，纯验证 koffi 注入链路（OpenProcess/VirtualAllocEx/WriteProcessMemory/
 * CreateRemoteThread/GetExitCodeThread）。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { injectDll, isModuleLoaded, findMainPid } from './lib/inject.mjs'

const DLL = 'C:\\Windows\\System32\\magnification.dll'

let pass = 0
const fails = []
const ok = (c, label) => { console.log((c ? '  PASS  ' : '  FAIL  ') + label); c ? pass++ : fails.push(label) }

console.log('\n=== 自研注入器自测 ===')
const child = spawn('notepad.exe', [], { detached: false, stdio: 'ignore' })
await sleep(2500)

const pid = findMainPid('notepad')
ok(!!pid, `找到目标进程 pid=${pid}`)
ok(!isModuleLoaded(pid, 'magnification.dll'), '注入前模块表中没有目标 DLL')

const r = injectDll(pid, DLL)
console.log('  注入返回:', JSON.stringify(r))
ok(r.ok, `injectDll 成功（hmod=${r.hmod}）`)

await sleep(1000)
ok(isModuleLoaded(pid, 'magnification.dll'), '注入后模块表里出现目标 DLL')

try { process.kill(pid) } catch { /* ignore */ }
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
process.exit(fails.length ? 1 : 0)
