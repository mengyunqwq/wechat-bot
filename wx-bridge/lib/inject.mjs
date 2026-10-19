/**
 * 自研 DLL 注入器 —— 纯 Node（koffi 直调 Win32 API），不依赖 Python。
 *
 * 为什么自己写：
 *   wxhook 自带的 start-wechat.exe 只认 3.9 的注册表路径、还强制要求管理员；
 *   而 4.x 客户端必须用"自研注入 + 自己控制端口/工作目录"的方式。
 *
 * 技术要点（实测结论）：
 *   - 同用户、同完整性级别下 OpenProcess 可拿到全权限，**不需要管理员**。
 *   - CreateRemoteThread(LoadLibraryW) 是标准注入；线程返回值就是 HMODULE，
 *     为 0 表示目标进程里加载失败（文件缺失/被杀软拦截/DllMain 返回 FALSE）。
 *   - 微信 4.x 是多进程：**必须注入"有主窗口"的那个主进程**，注入辅助进程不会起 API。
 */
import { execFileSync } from 'node:child_process'
import koffi from 'koffi'

const k32 = koffi.load('kernel32.dll')

const OpenProcess = k32.func('OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
const VirtualAllocEx = k32.func('VirtualAllocEx', 'void *', ['void *', 'void *', 'size_t', 'uint32', 'uint32'])
const WriteProcessMemory = k32.func('WriteProcessMemory', 'int', ['void *', 'void *', 'void *', 'size_t', 'void *'])
const VirtualFreeEx = k32.func('VirtualFreeEx', 'int', ['void *', 'void *', 'size_t', 'uint32'])
const GetModuleHandleW = k32.func('GetModuleHandleW', 'void *', ['str16'])
const GetProcAddress = k32.func('GetProcAddress', 'void *', ['void *', 'str'])
const CreateRemoteThread = k32.func('CreateRemoteThread', 'void *', ['void *', 'void *', 'size_t', 'void *', 'void *', 'uint32', 'void *'])
const WaitForSingleObject = k32.func('WaitForSingleObject', 'uint32', ['void *', 'uint32'])
const CloseHandle = k32.func('CloseHandle', 'int', ['void *'])

// 权限位
const PROCESS_ALL_ACCESS = 0x1f0fff
const PROCESS_MIN = 0x0002 | 0x0008 | 0x0010 | 0x0020 | 0x0400   // CREATE_THREAD|VM_OP|VM_WRITE|VM_READ|QUERY
const MEM_COMMIT_RESERVE = 0x1000 | 0x2000
const PAGE_READWRITE = 0x04
const MEM_RELEASE = 0x8000
const INFINITE = 0xffffffff
const WAIT_TIMEOUT = 0x102

/** 取"有主窗口"的进程 pid（微信 4.x 主进程判据）；拿不到退回内存最大者 */
export function findMainPid(exeName = 'Weixin') {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-Process ${exeName} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Sort-Object WorkingSet64 -Descending | Select-Object -First 1 -ExpandProperty Id`,
    ], { encoding: 'utf8', timeout: 15000 }).trim()
    if (/^\d+$/.test(out)) return Number(out)
  } catch { /* 退回内存判据 */ }

  try {
    const csv = execFileSync('tasklist', ['/fi', `imagename eq ${exeName}.exe`, '/fo', 'csv', '/nh'], { encoding: 'latin1' })
    let best = 0
    let bestKb = -1
    for (const line of csv.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","([\d,]+) K"/.exec(line.trim())
      if (!m) continue
      const kb = Number(m[3].replace(/,/g, ''))
      if (kb > bestKb) { bestKb = kb; best = Number(m[2]) }
    }
    return best
  } catch { return 0 }
}

/** 目标进程里是否已加载某模块（PowerShell 读模块表，无需 Python） */
export function isModuleLoaded(pid, moduleName) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `$m = (Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Modules | Where-Object { $_.ModuleName -ieq '${moduleName}' } | Select-Object -First 1 -ExpandProperty ModuleName; if ($m) { 'YES' } else { 'NO' }`,
    ], { encoding: 'utf8', timeout: 20000 }).trim()
    return out === 'YES'
  } catch { return false }
}

/**
 * 把 DLL 注入目标进程。
 * @returns {{ok:boolean, pid:number, hmod:string, error?:string}}
 */
export function injectDll(pid, dllPath) {
  if (!pid) return { ok: false, pid: 0, hmod: '0x0', error: '无效 pid' }

  let h = OpenProcess(PROCESS_ALL_ACCESS, 0, pid)
  if (!h) h = OpenProcess(PROCESS_MIN, 0, pid)
  if (!h) return { ok: false, pid, hmod: '0x0', error: 'OpenProcess 失败（权限不足？）' }

  let addr = null
  try {
    const buf = Buffer.from(dllPath + '\0', 'latin1')   // ANSI 路径（LoadLibraryA）
    addr = VirtualAllocEx(h, null, buf.length, MEM_COMMIT_RESERVE, PAGE_READWRITE)
    if (!addr) return { ok: false, pid, hmod: '0x0', error: 'VirtualAllocEx 失败' }

    const written = WriteProcessMemory(h, addr, buf, buf.length, null)
    if (!written) return { ok: false, pid, hmod: '0x0', error: 'WriteProcessMemory 失败' }

    const hKernel = GetModuleHandleW('kernel32.dll')
    const pLoad = GetProcAddress(hKernel, 'LoadLibraryA')
    if (!pLoad) return { ok: false, pid, hmod: '0x0', error: '找不到 LoadLibraryA' }

    const th = CreateRemoteThread(h, null, 0, pLoad, addr, 0, null)
    if (!th) return { ok: false, pid, hmod: '0x0', error: 'CreateRemoteThread 失败' }

    const w = WaitForSingleObject(th, 20000)
    if (w === WAIT_TIMEOUT) { CloseHandle(th); return { ok: false, pid, hmod: '0x0', error: '远程线程超时' } }

    // 线程返回值 = HMODULE（必须在 CloseHandle 之前取，否则拿到 0）
    let hmod = 0
    try {
      const GetExitCodeThread = k32.func('GetExitCodeThread', 'int', ['void *', koffi.out(koffi.pointer('uint32'))])
      const box = [0]
      GetExitCodeThread(th, box)
      hmod = box[0] >>> 0
    } catch { /* 交给下面的模块表校验 */ }
    CloseHandle(th)

    if (hmod === 0) {
      const loaded = isModuleLoaded(pid, dllPath.replace(/^.*[\\/]/, ''))
      if (!loaded) return { ok: false, pid, hmod: '0x0', error: '目标进程 LoadLibrary 失败（依赖缺失/被杀软拦截/版本不匹配导致 DllMain 返回 FALSE）' }
      hmod = 1   // 模块表证明已加载
    }
    return { ok: true, pid, hmod: '0x' + hmod.toString(16) }
  } finally {
    try { if (addr) VirtualFreeEx(h, addr, 0, MEM_RELEASE) } catch { /* ignore */ }
    try { CloseHandle(h) } catch { /* ignore */ }
  }
}

export { PROCESS_ALL_ACCESS }
