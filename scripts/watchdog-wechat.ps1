# watchdog-wechat.ps1 —— 微信机器人自愈看门狗（每 10 分钟由计划任务调用）
#
# 2026-11-14 复盘的三层防线（对应三个根因）：
#   根因① 强杀微信 → 消息库损坏 → 消息模块被微信挂起（弹修复窗，被遮挡无人看到）→ 失聪 24h
#   根因② hook 语句泄漏 → 写入锁死（RAII 已修，属代码层，不在本脚本范围）
#   根因③ 桥进程挂掉 → 机器人失聪
#
# 本脚本做四件事（全部幂等，重复跑无害）：
#   ① 检测"修复弹窗"并自动点「开始修复」—— 关键防线：损坏发生后 10 分钟内自愈，
#      而不是 24 小时后才被人发现。
#   ② wal 新鲜度检查：> 40 分钟没写入且进程活着 → 重启桥 → 还不行发告警到 filehelper。
#   ③ 桥存活检查：17300 无响应 → WMI 脱离拉起。
#   ④ 微信进程检查：< 3 个 → 启动 + 回车登录（每小时最多一次，防止登录页循环点）。
#
# 日志：D:\微信deepseek\data\logs\watchdog.log

param([int]$LoopSec = 600)


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


$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 常驻模式：默认每 10 分钟循环执行一次主体（主体在文件末尾的 do { } while）
$asService = ($LoopSec -gt 0)

$LogDir  = 'D:\微信deepseek\data\logs'
$LogFile = Join-Path $LogDir 'watchdog.log'
$DbRoot  = Resolve-DbRoot ''
$WalPath = Join-Path $DbRoot 'message\message_0.db-wal'
$BridgeDir = 'D:\微信deepseek\wx-bridge'
$StateFile = Join-Path $LogDir 'watchdog-state.json'

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
  for ($i = 1; $i -le $MaxTry; $i++) {
    Stop-Bridge
    Start-Sleep -Seconds 2
    $cmd = '"' + $node + '" server.mjs --transport=wechat-hook --api-port=30001 ' +
           '--cb-port=18998 --data-dir=D:/微信deepseek/data --wechat=D:/wxhook/wx4110/Weixin.exe'
    $r = ([wmiclass]'Win32_Process').Create($cmd, $BridgeDir, $null)
    Start-Sleep -Seconds $WaitSec
    if (Test-Bridge) {
      return @{ ok = $true; try = $i; rc = $r.ReturnValue; pid = $r.ProcessId }
    }
    Write-Host ('  [桥] 第 ' + $i + ' 次启动后无响应（rc=' + $r.ReturnValue + '）→ 重试')
  }
  return @{ ok = $false; why = ('重试 ' + $MaxTry + ' 次仍无响应') }
}


if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log([string]$msg) {
  $line = '[' + (Get-Date).ToString('MM-dd HH:mm:ss') + '] ' + $msg
  Write-Output $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Read-State {
  try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return [pscustomobject]@{ lastClientStart = 0; lastWalAlert = 0; lastRepairClick = 0 } }
}
function Write-State($s) {
  try { $s | ConvertTo-Json -Compress | Set-Content $StateFile -Encoding UTF8 } catch { }
}

$state = Read-State
$now = [DateTime]::UtcNow.Ticks / 10000   # epoch ms

# ── ① 微信进程 ──────────────────────────────────────────────────────
$procs = @(Get-Process Weixin -ErrorAction SilentlyContinue)
if ($procs.Count -lt 3) {
  # 每小时最多代启一次，防止登录页反复点击形成循环
  if ($now - $state.lastClientStart -gt 3600 * 1000) {
    Log ('微信进程不足（' + $procs.Count + '）→ 启动客户端')
    $r = ([wmiclass]'Win32_Process').Create(
      'D:\wxhook\wx4110\Weixin.exe StartPort=30001 RecvType=1 CallBackURL=http://127.0.0.1:18998',
      'D:\wxhook\wx4110', $null)
    Start-Sleep -Seconds 20
    # 回车登录（登录页两个实例只认回车，坐标点击对这版无效——2026-11-14 实测）
    Add-Type -AssemblyName System.Windows.Forms
    $p = Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) {
      $sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
      $t = Add-Type -MemberDefinition $sig -Name FU -Namespace W32 -PassThru
      [void]$t::SetForegroundWindow($p.MainWindowHandle)
      Start-Sleep -Milliseconds 800
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Log '已回车登录'
    }
    $state.lastClientStart = $now
    Write-State $state
    break
  }
  Log ('微信进程不足但 1 小时内已代启过，跳过（' + $procs.Count + ' 进程）')
  break
}

# ── ② 修复弹窗检测 + 自动点击 ──────────────────────────────────────
# 修复窗特征：Weixin 进程的可见窗口，尺寸约 516x308（实测 2026-11-14）。
# 「开始修复」按钮在窗内 (427,264)。若已修复成功，同位置是「重启并前往指引」，点了也无害。
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
}
'@

$wxPids = @($procs | Select-Object -ExpandProperty Id)
$repairWin = [IntPtr]::Zero
$cb = {
  param($h, $p)
  $procId = 0
  [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($wxPids -contains [int]$procId -and [WinEnum]::IsWindowVisible($h)) {
    $r = New-Object WinEnum+RECT
    if ([WinEnum]::GetWindowRect($h, [ref]$r)) {
      $w = $r.R - $r.L; $ht = $r.B - $r.T
      # 修复弹窗 516x308（±20 容差），且不是主窗（主窗更大）
      if ($w -ge 496 -and $w -le 536 -and $ht -ge 288 -and $ht -le 328) {
        $script:repairWin = $h
        return $false
      }
    }
  }
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)

if ($repairWin -ne [IntPtr]::Zero) {
  if ($now - $state.lastRepairClick -gt 10 * 60 * 1000) {
    $r = New-Object WinEnum+RECT
    [void][WinEnum]::GetWindowRect($repairWin, [ref]$r)
    Log ('发现疑似修复弹窗 ' + ($r.R - $r.L) + 'x' + ($r.B - $r.T) + ' → 自动点「开始修复」')
    [void][WinEnum]::SetForegroundWindow($repairWin)
    Start-Sleep -Milliseconds 600
    $bx = $r.L + 427; $by = $r.T + 264
    [void][WinEnum]::SetCursorPos($bx, $by)
    Start-Sleep -Milliseconds 300
    [WinEnum]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    [WinEnum]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    $state.lastRepairClick = $now
    Write-State $state
    Log '已点击，等待自动重启（下轮继续跟进）'
  } else {
    Log '修复弹窗存在，但 10 分钟内已点过，等它自己重启'
  }
  break
}


# ── ③.5 桥存活（每轮必查，不依赖 WAL 新鲜度）─────────────────────────
#   ⚠️ 2026-11-17：原来这段在「WAL 90 分钟没写入」的自愈流程里，
#      桥单独挂掉（WAL 还新鲜）时根本不会执行 → 机器人静默失联。
#      现在挪出来，每轮都查：死了就按完整 node 路径重启，并自检重试。
if (-not (Test-Bridge -TimeoutSec 6)) {
  $binfo = ''
  try {
    $pr = (Invoke-RestMethod -Uri 'http://127.0.0.1:17300/api/pollStatus' -TimeoutSec 4)
    $binfo = ' polls=' + $pr.polls + ' msgs=' + $pr.msgs
  } catch { }
  Log ('桥无响应' + $binfo + ' → 重启桥')
  $bres = Start-Bridge -MaxTry 3 -WaitSec 22
  if ($bres.ok) {
    Log ('桥已恢复（第 ' + $bres.try + ' 次成功，pid=' + $bres.pid + '）')
  } else {
    Log ('桥重启失败：' + $bres.why)
  }
} else {
  # 桥活着，但顺带看一眼轮询是否卡住（polls 不涨 = 没在读）
  try {
    $p1 = (Invoke-RestMethod -Uri 'http://127.0.0.1:17300/api/pollStatus' -TimeoutSec 4)
    Start-Sleep -Seconds 15
    $p2 = (Invoke-RestMethod -Uri 'http://127.0.0.1:17300/api/pollStatus' -TimeoutSec 4)
    if ($p1.polls -eq $p2.polls -and -not $p2.maintaining) {
      Log ('桥在跑但轮询没动（polls 停在 ' + $p2.polls + '）→ 重启桥')
      $bres = Start-Bridge -MaxTry 2 -WaitSec 22
      if (-not $bres.ok) { Log ('桥重启失败：' + $bres.why) }
    }
  } catch { }
}

# ── ③ wal 新鲜度 ───────────────────────────────────────────────────
$walAgeMin = -1
if (Test-Path $WalPath) {
  $walAgeMin = [int]((Get-Date) - (Get-Item $WalPath).LastWriteTime).TotalMinutes
}
# 阈值 90 分钟：深夜无消息很正常。真正的损坏由上面的"修复弹窗检测"
# 在 10 分钟内拦截（强信号）；这里只是最后的通知线（弱信号）。
if ($walAgeMin -ge 0 -and $walAgeMin -le 90) {
  break
}

Log ('消息库 ' + $(if ($walAgeMin -lt 0) { 'wal 文件缺失' } else { '已 ' + $walAgeMin + ' 分钟没写入' }) + ' → 进入自愈流程')

# ── ⑤ 告警（每 2 小时最多一次，别刷屏）─────────────────────────────
if ($now - $state.lastWalAlert -gt 2 * 3600 * 1000) {
  try {
    $body = @{ room = 'filehelper'; text = ('⚠️ 机器人看门狗：消息库已 ' + $walAgeMin + ' 分钟没写入，已尝试自动修复/重启，若持续失聪请人工检查微信是否弹修复窗。') } | ConvertTo-Json -Compress
    Invoke-WebRequest -Uri 'http://127.0.0.1:17300/api/send' -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 20 -UseBasicParsing | Out-Null
    Log '已发告警到 filehelper'
  } catch {
    Log ('告警发送失败（桥可能还没就绪）: ' + $_.Exception.Message)
  }
  $state.lastWalAlert = $now
  Write-State $state
}

if ($asService) {
  Log ('看门狗进入常驻循环（每 ' + $LoopSec + ' 秒一轮）')
  while ($true) {
    Start-Sleep -Seconds $LoopSec
    try { & $MyInvocation.MyCommand.Path -LoopSec 0 } catch { }
  }
}
