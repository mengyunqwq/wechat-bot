# deploy-hook.ps1 —— 安全部署 version.dll（避免"强杀造成数据库损坏"）
#
# 背景（2026-11-13 诊断）：
#   微信消息库是 WAL 模式 + SQLCipher。写入流程是
#       新消息 → message_0.db-wal → 定期 checkpoint 合并回 message_0.db
#   如果在地 checkpoint 途中强杀进程，-wal 里已提交的事务和主库页就对不上，
#   下次启动直接判定「数据库损坏」。
#   今天为了调试一共强杀了 59 次 → 反复损坏。
#
#   而 CloseMainWindow() 对微信是**死锁的**（项目里早就实测过），
#   所以不能用"优雅关闭"这条路。
#
# 这个脚本改用的顺序（把风险压到最低）：
#   ① 先停桥（切断我们自己的查询流，别在客户端写库时抢连接）
#   ② 清空队列目录（hook 不再有活干）
#   ③ **等 WAL 落盘**：轮询 */message_*.db-wal 大小，等它降到阈值以下
#      （WAL 空 = 客户端已经把事务 checkpoint 回主库 = 此刻杀进程是安全的）
#   ④ 再结束进程；若 WAL 一直不降，退化为超时后强杀，并在日志里标记「强杀」
#   ⑤ 换 DLL → 启动（带 StartPort/RecvType/CallBackURL）→ 回车登录 → 验证
#
# 用法：
#   powershell -File deploy-hook.ps1 -Dll E:\wxhook-src\WeChat-Hook\x64\Release\version.dll
#   powershell -File deploy-hook.ps1 -Dll ... -WalTimeoutSec 120 -NoLogin

param(
  [Parameter(Mandatory = $true)][string]$Dll,
  [string]$ClientDir = 'D:\wxhook\wx4110',
  [string]$DbRoot    = '',
  [string]$BridgeDir = 'D:\微信deepseek\wx-bridge',
  [int]$ApiPort = 30001,
  [int]$CbPort  = 18998,
  [int]$WalTimeoutSec = 90,
  [int]$WalSafeKb = 128,
  [switch]$NoLogin,
  [switch]$KeepBridgeStopped
)


# ── DbRoot 自动探测（2026-11-17）──────────────────────────────────────
#   原来这里写死了 'D:\Users\...\xwechat_files\wxid_xxx_7886\db_storage'，
#   等于把个人 wxid 摊在源码里，换台机器也不能用。
#   现在按「环境变量 WECHAT_DB_ROOT > 常见位置通配 > 报错」的顺序解析。
function Resolve-DbRoot([string]$Current) {
  if ($Current -and (Test-Path $Current)) { return $Current }
  if ($env:WECHAT_DB_ROOT -and (Test-Path $env:WECHAT_DB_ROOT)) { return $env:WECHAT_DB_ROOT }
  $patterns = @(
    'D:\Users\*\xwechat_files\*\db_storage',
    'C:\Users\*\xwechat_files\*\db_storage',
    'D:\Users\*\Documents\WeChat Files\*\Msg'
  )
  foreach ($p in $patterns) {
    $hit = Get-ChildItem -Path $p -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $Current
}

# 立刻解析出真实路径（后面 WAL 采样要用）
$DbRoot = Resolve-DbRoot $DbRoot
Write-Host ('  数据库根目录: ' + $(if ($DbRoot) { $DbRoot } else { '（未找到）' }))


$ErrorActionPreference = 'Stop'

# ══════════════════════════════════════════════════════════════════════
#  桥启动（2026-11-17 加固）
#    ⚠️ 踩过的坑：WMI Create 只写 'node ...' 会返回 rc=8（找不到 node），
#       而且静默失败 —— 桥起不来、看门狗也不报错，机器人就整体失联。
#       必须用完整路径 C:\Program Files\nodejs\node.exe。
#    ⚠️ 另一个坑：用 start /b 启动时父进程退出会断掉 stdout →
#       console.log 每次抛 EPIPE → 刷屏堵死事件循环 → pollStatus 超时。
#       所以这里只用 WMI 直启（自带控制台，不依赖父进程）。
# ══════════════════════════════════════════════════════════════════════
function Get-NodeExe {
  $c = @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($p in $c) { if (Test-Path $p) { return $p } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Stop-Bridge {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'server\.mjs' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
}

function Test-Bridge([int]$TimeoutSec = 6) {
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:17300/api/pollStatus' -TimeoutSec $TimeoutSec
    return [bool]$resp.ok
  } catch { return $false }
}

function Start-Bridge([int]$MaxTry = 3, [int]$WaitSec = 22) {
  $node = Get-NodeExe
  if (-not $node) { return @{ ok = $false; why = '找不到 node.exe' } }

  # ① 生成无窗口启动器（VBS）：node 跑起来不带控制台，输出重定向到日志
  #    ★ 为什么不用 WMI 直启 node：WMI 创建的进程自带控制台窗口，
  #      每次重启桥就弹一个 cmd（用户反馈"cmd 面板开太多"）。
  #    ★ 为什么不用 WScript.Shell.Run 直接跑命令行：中文路径会失败（实测 3 次都没起）。
  $vbs = 'D:\微信deepseek\data\logs\start-bridge.vbs'
  $logFile = 'D:\微信deepseek\data\logs\bridge-console.log'
  try {
    $lines = @(
      'On Error Resume Next',
      'Set sh = CreateObject("WScript.Shell")',
      ('sh.CurrentDirectory = "' + $BridgeDir + '"'),
('sh.Run """' + $node + '"" server.mjs --transport=wechat-hook --api-port=30001 --cb-port=18998 --data-dir=D:/微信deepseek/data --wechat=D:/wxhook/wx4110/Weixin.exe", 0, False')
    )
    # VBS 用 ANSI(GBK) 存，避免中文路径在某些环境被当成 UTF-8 读成乱码
    [System.IO.File]::WriteAllLines($vbs, $lines, [System.Text.Encoding]::Default)
  } catch {
    Write-Host ('  [桥] 生成 VBS 失败：' + $_.Exception.Message)
  }

  for ($i = 1; $i -le $MaxTry; $i++) {
    Stop-Bridge
    Start-Sleep -Seconds 2
    $rc = 0
    try {
      if (Test-Path $vbs) {
        $r = ([wmiclass]'Win32_Process').Create('wscript.exe "' + $vbs + '"', 'C:\', $null)
        $rc = $r.ReturnValue
      } else { $rc = -1 }
    } catch { $rc = -2 }
    if ($rc -ne 0) {
      Write-Host ('  [桥] VBS 启动失败 rc=' + $rc + ' → 退回 WMI 直启（会有一个控制台窗口）')
      $cmd = '"' + $node + '" server.mjs --transport=wechat-hook --api-port=30001 ' +
             '--cb-port=18998 --data-dir=D:/微信deepseek/data --wechat=D:/wxhook/wx4110/Weixin.exe'
      $null = ([wmiclass]'Win32_Process').Create($cmd, $BridgeDir, $null)
    }
    Start-Sleep -Seconds $WaitSec
    if (Test-Bridge) {
      return @{ ok = $true; try = $i; rc = $rc; pid = 0 }
    }
    Write-Host ('  [桥] 第 ' + $i + ' 次启动后无响应（rc=' + $rc + '）→ 重试')
  }
  return @{ ok = $false; why = ('重试 ' + $MaxTry + ' 次仍无响应') }
}

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$LogDir = 'D:\微信deepseek\data\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'deploy-hook.log'

function Log([string]$msg) {
  $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Write-Output ('  ' + $msg)
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Get-WeChatProcs { return @(Get-Process Weixin -ErrorAction SilentlyContinue) }

function Get-WalInfo {
  $out = @()
  if (-not (Test-Path $DbRoot)) { return $out }
  Get-ChildItem $DbRoot -Recurse -File -Filter '*-wal' -ErrorAction SilentlyContinue | ForEach-Object {
    $out += [pscustomobject]@{ Name = $_.Name; KB = [Math]::Round($_.Length / 1KB, 1) }
  }
  return $out
}

# ── 0) 前置检查 ──────────────────────────────────────────────────────
if (-not (Test-Path $Dll)) { Log ('❌ DLL 不存在: ' + $Dll); exit 1 }
$dllMd5 = (Get-FileHash $Dll -Algorithm MD5).Hash.ToLower()
Log ('部署源: ' + $Dll + '  md5=' + $dllMd5.Substring(0, 8))

# ── 1) 停桥（切断我们的查询流）─────────────────────────────────────
$bridge = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'server\.mjs' })
if ($bridge.Count -gt 0) {
  foreach ($b in $bridge) { Stop-Process -Id $b.ProcessId -Force -ErrorAction SilentlyContinue }
  Log ('已停止桥进程 ' + $bridge.Count + ' 个')
} else { Log '桥未在运行' }
Start-Sleep -Seconds 2

# ── 2) 清空队列（hook 不再有活干）──────────────────────────────────
$qdir = Join-Path $ClientDir 'hook-queue'
if (Test-Path $qdir) {
  Remove-Item (Join-Path $qdir 'req-*.json') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $qdir 'res-*.json') -Force -ErrorAction SilentlyContinue
  Log '队列已清空'
}

# ── 3) 等 WAL 落盘 ─────────────────────────────────────────────────
$procs = Get-WeChatProcs
if ($procs.Count -eq 0) {
  Log '微信未运行，跳过 WAL 等待'
} else {
  # 判据改成"WAL 总大小停止变化"（说明此刻没有活跃写入），
  # 而不是"WAL 变小"——实测很多库的 -wal 会长期保持几百 KB 甚至 1.8MB 不降，
  # 那是微信自己的 checkpoint 节奏，我们催不动（13:25 实测：等 60 秒纹丝不动）。
  Log ('等写入静止（WAL 连续 3 次采样不变，最长 ' + $WalTimeoutSec + ' 秒）…')
  $deadline = (Get-Date).AddSeconds($WalTimeoutSec)
  $safe = $false
  $prevTotal = -1
  $stable = 0
  $lastReport = -99
  $t0 = Get-Date
  while ((Get-Date) -lt $deadline) {
    $wals = Get-WalInfo
    $total = 0.0
    foreach ($w in $wals) { $total += $w.KB }
    if ($prevTotal -ge 0 -and [Math]::Abs($total - $prevTotal) -lt 2) { $stable++ } else { $stable = 0 }
    $prevTotal = $total
    $elapsed = [int]((Get-Date) - $t0).TotalSeconds
    if ($stable -ge 3) { $safe = $true; break }
    if ($elapsed - $lastReport -ge 10) {
      $lastReport = $elapsed
      Log ('  采样 ' + $elapsed + 's：WAL 合计 ' + [Math]::Round($total, 1) + ' KB（连续不变 ' + $stable + '/3）')
    }
    Start-Sleep -Milliseconds 1200
  }
  if ($safe) { Log '✅ 写入已静止（WAL 稳定），此刻结束进程是安全的' }
  else { Log '⚠️ WAL 一直在变（写入没停）→ 只能强杀（本次记为强杀，有损坏风险）' }
}

# ── 4) 结束进程 ────────────────────────────────────────────────────
$procs = Get-WeChatProcs
if ($procs.Count -gt 0) {
  $method = if ($safe) { 'taskkill/F(after-wal-clean)' } else { 'taskkill/F(FORCED-risky)' }
  $ErrorActionPreference = 'SilentlyContinue'
  & taskkill /F /PID ($procs | Select-Object -First 1).Id 2>$null | Out-Null
  foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  $ErrorActionPreference = 'Stop'
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Get-WeChatProcs).Count -eq 0) { break }
  }
  Log ('已结束微信进程（方式：' + $method + '，剩余 ' + (Get-WeChatProcs).Count + '）')
}

# ── 5) 备份并替换 DLL ──────────────────────────────────────────────
$target = Join-Path $ClientDir 'version.dll'
if (Test-Path $target) {
  $bak = Join-Path $ClientDir ('version.dll.bak-' + (Get-Date).ToString('MMdd-HHmmss'))
  Copy-Item $target $bak -Force
  Log ('已备份旧 DLL: ' + (Split-Path $bak -Leaf))
}
Copy-Item $Dll $target -Force
$newMd5 = (Get-FileHash $target -Algorithm MD5).Hash.ToLower()
Log ('已替换 DLL，md5=' + $newMd5.Substring(0, 8) + $(if ($newMd5 -eq $dllMd5) { ' ✅一致' } else { ' ❌不一致' }))

# ── 6) 启动 + 登录 ─────────────────────────────────────────────────
# 同样用 WMI 脱离启动：避免客户端继承管道、被父进程的终止连带杀掉
$wechatExe0 = Join-Path $ClientDir 'Weixin.exe'
$wxCmd = $wechatExe0 + ' StartPort=' + $ApiPort + ' RecvType=1 CallBackURL=http://127.0.0.1:' + $CbPort
$wxr = ([wmiclass]'Win32_Process').Create($wxCmd, $ClientDir, $null)
Log ('已启动客户端（带端口/回调参数，pid=' + $wxr.ProcessId + '）')
Start-Sleep -Seconds 15

if (-not $NoLogin) {
  $loginScript = 'D:\微信deepseek\scripts\wechat-login-v3.ps1'
  if (Test-Path $loginScript) {
    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $loginScript -MaxTry 4 -WaitSec 40 2>&1
    Log ('登录结果: ' + (($r | Select-Object -Last 1) -as [string]))
  } else { Log '⚠️ 找不到登录脚本 wechat-login-v3.ps1' }
}

$final = (Get-WeChatProcs).Count
Log ('部署完成：微信进程 ' + $final)

# ── 7) 恢复桥（除非要求保持停止）───────────────────────────────────
if (-not $KeepBridgeStopped) {
  # ⚠️ 不要用 Start-Process -RedirectStandardOutput 起桥：
  #    子进程会继承父进程的标准输出管道，父进程退出后管道仍被 node 持有
  #    → 调用方（工具/终端）一直等不到 EOF → 看起来"卡住" → 超时被中止
  #    → 连带把整棵进程树（含微信）一起终止。13:26 实测踩过。
  #    改用 WMI Win32_Process.Create：完全脱离父进程与管道，立即返回。
  $wechatExe = Join-Path $ClientDir 'Weixin.exe'
  $bridgeRes = Start-Bridge -MaxTry 3 -WaitSec 22
  if (-not $bridgeRes.ok) { Write-Host ('  ⚠️ 桥启动失败：' + $bridgeRes.why) }
         ' --cb-port=' + $CbPort + ' --data-dir=D:/微信deepseek/data --wechat=' + $wechatExe
  try {
    $r = ([wmiclass]'Win32_Process').Create($cmd, 'D:\微信deepseek\wx-bridge', $null)
    Log ('桥已重启（WMI 脱离启动，pid=' + $r.ProcessId + '）')
  } catch {
    Log ('⚠️ 桥启动失败: ' + $_.Exception.Message)
  }
}

@{ ok = ($final -ge 3); procs = $final; walSafe = $safe; md5 = $newMd5.Substring(0, 8) } |
  ConvertTo-Json -Compress | ForEach-Object { Write-Output ('JSON: ' + $_) }
