# 安全重启微信客户端（唯一允许的方式）
#
#  为什么有这个脚本：2026-10-19 夜间反复用 Stop-Process -Force 强杀微信，
#  把 WCDB 的 WAL 停在半提交状态 → 微信把消息库移进 .factory 隔离 → 用户聊天记录消失。
#  → 从此重启客户端只走这个脚本：先备份、再正常退出、等它退干净、再启动、再等加载。
#
#  用法：
#     powershell -ExecutionPolicy Bypass -File .\scripts\safe-restart-client.ps1
#     powershell -ExecutionPolicy Bypass -File .\scripts\safe-restart-client.ps1 -WeChatDir "D:\wxhook\wx4110"
#     powershell -ExecutionPolicy Bypass -File .\scripts\safe-restart-client.ps1 -DryRun    # 只看会做什么
#
#  它会做：
#     1) 停桥（防止桥的巡检去拉客户端）
#     2) 【备份】整个 db_storage（含 -wal/-shm/.material）
#     3) CloseMainWindow 正常关闭 → 等 30 秒（绝不强杀，除非 -Force 明确给）
#     4) 启动客户端（带回调参数）
#     5) 等加载：轮询 /QueryDB/debug 直到 dbs>5 且 Weixin>=3（最多 5 分钟）
#     6) 起桥
#     7) 打印验收结果（收消息计数 / 轮询失败 / 语音开关）
param(
  [string]$WeChatDir = "D:\wxhook\wx4110",
  [string]$ApiPort = 30001,
  [string]$CbPort = 18998,
  [string]$BridgeDir = "",
  [int]$WaitSeconds = 30,
  [switch]$Force,      # 明确允许强杀（默认绝不允许）
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }
function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }

if (-not (Test-Path (Join-Path $WeChatDir "Weixin.exe"))) { Fail "找不到客户端：$WeChatDir\Weixin.exe" }
if (-not $BridgeDir) { $BridgeDir = Join-Path (Split-Path $PSScriptRoot -Parent) "wx-bridge" }
Say "客户端目录: $WeChatDir"
Say "桥目录:     $BridgeDir"
Say "DryRun:     $([bool]$DryRun)"
Say ""

# ── 1) 停桥 ────────────────────────────────────────────────────────────────
Say "[1/7] 停桥（避免桥去自动拉起客户端）"
$c = Get-NetTCPConnection -LocalPort 17300 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) {
  if ($DryRun) { Say "（DryRun）将停桥 pid=$($c.OwningProcess)" }
  else { Stop-Process -Id $c.OwningProcess -Force -EA SilentlyContinue; Ok "桥已停" }
} else { Say "桥本来没在监听" }
Start-Sleep -Seconds 2

# ── 2) 备份 db_storage ─────────────────────────────────────────────────────
Say "[2/7] 备份数据库（这一步不能省）"
$dataRoot = $null
Get-ChildItem "D:\Users" -Directory -EA SilentlyContinue | ForEach-Object {
  Get-ChildItem $_.FullName -Directory -Filter "xwechat_files" -EA SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName -Directory -EA SilentlyContinue | ForEach-Object { if (-not $dataRoot -and (Test-Path (Join-Path $_.FullName "db_storage"))) { $dataRoot = $_.FullName } }
  }
}
if (-not $dataRoot) { Say "⚠️ 没自动找到数据目录 → 跳过备份（请手动确认 db_storage 位置）" }
else {
  $db = Join-Path $dataRoot "db_storage"
  $bk = Join-Path (Split-Path $BridgeDir -Parent) ("backup-db-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
  if ($DryRun) { Say "（DryRun）将备份 $db → $bk" }
  else {
    New-Item -ItemType Directory $bk -Force | Out-Null
    $files = Get-ChildItem $db -Recurse -File -Include "*.db","*.db-wal","*.db-shm","*.material" -EA SilentlyContinue
    $n = 0
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($db.Length).TrimStart("\")
      $dst = Join-Path $bk $rel
      $dd = Split-Path $dst -Parent
      if (-not (Test-Path $dd)) { New-Item -ItemType Directory $dd -Force | Out-Null }
      try { Copy-Item $f.FullName $dst -Force -EA Stop; $n++ } catch { }
    }
    Ok "备份 $n 个文件 → $bk"
  }
}

# ── 3) 正常关闭（绝不强杀）─────────────────────────────────────────────────
# ★ 微信最小化到托盘时 MainWindowTitle 为空、MainWindowHandle=0，
#   CloseMainWindow() 拿不到窗口会直接失败（实测 2026-10-20 15:38）。
#   所以：先试 CloseMainWindow；不行就枚举该进程的所有窗口发 WM_CLOSE
#   （那是"点 ✗"的程序化版本，仍是正常关闭，微信会把 WAL 正常落盘）。
Say "[3/7] 正常关闭客户端（CloseMainWindow / WM_CLOSE，等 $WaitSeconds 秒）"

function Close-WeChatWindows {
  param([switch]$DumpOnly)
  $cls = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WeChatWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  public static List<IntPtr> Find(uint[] pids) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      foreach (var p in pids) if (p == pid) { r.Add(h); break; }
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static string Info(IntPtr h) {
    var c = new StringBuilder(256); var t = new StringBuilder(256);
    GetClassName(h, c, 256); GetWindowText(h, t, 256);
    return "class=" + c + " title=" + t;
  }
}
'@
  if (-not ([System.Management.Automation.PSTypeName]'WeChatWin').Type) {
    Add-Type -TypeDefinition $cls -ErrorAction Stop
  }
  $pids = @(Get-Process -Name Weixin -EA SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if (-not $pids.Count) { return 0 }
  $wins = [WeChatWin]::Find($pids)
  $sent = 0
  foreach ($h in $wins) {
    $info = [WeChatWin]::Info($h)
    if ($DumpOnly) { Say "    窗口: $info"; continue }
    # 只对主窗口类发 WM_CLOSE（跳过 IME / 消息类隐藏窗口）
    if ($info -match 'class=WeChatMainWndForPC|class=Qt5|class=mmui|class=Weixin|class=WxTrayIcon') {
      $ok = [WeChatWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      Say "    WM_CLOSE → $info (ok=$ok)"
      if ($ok) { $sent++ }
    }
  }
  return $sent
}

if ($DryRun) {
  Say "（DryRun）会先试 CloseMainWindow，再枚举窗口发 WM_CLOSE"
} else {
  # 3.1 先试标准 CloseMainWindow
  $w = Get-Process -Name Weixin -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  foreach ($p in $w) { try { $p.CloseMainWindow() | Out-Null } catch { } }
  if (-not $w) { Say "    没有可见主窗口（多半是最小化到托盘）→ 直接用 WM_CLOSE" }
  Start-Sleep -Seconds 3
  # 3.2 还在跑 → 枚举窗口发 WM_CLOSE
  if ((Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count -gt 0) {
    Say "    仍在上 → 枚举窗口发 WM_CLOSE（等同点 ✗，不是强杀）"
    try { [void](Close-WeChatWindows) } catch { Say "    ⚠️ WM_CLOSE 失败: $($_.Exception.Message)" }
  }
  # 3.3 等它退
  $exited = $false
  for ($i = 1; $i -le $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    if ((Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count -eq 0) { Ok "已正常退出（等了 $i 秒）"; $exited = $true; break }
  }
  if (-not $exited) {
    if ($Force) { Say "⚠️ 等 $WaitSeconds 秒没退 → -Force 已给，才强杀"; Get-Process -Name Weixin,WeChatAppEx -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue; Start-Sleep -Seconds 4 }
    else { Fail "等 $WaitSeconds 秒没退干净。**不会强杀**（规则 R1）。请手动关掉微信窗口（托盘图标右键→退出），或加 -Force 明确允许强杀（有损坏数据库的风险）" }
  }
}

# ── 4) 启动客户端 ──────────────────────────────────────────────────────────
Say "[4/7] 启动客户端"
if ($DryRun) { Say "（DryRun）将启动 $WeChatDir\Weixin.exe" }
else {
  Start-Process -FilePath (Join-Path $WeChatDir "Weixin.exe") `
    -ArgumentList "StartPort=$ApiPort", "RecvType=1", "CallBackURL=http://127.0.0.1:$CbPort" `
    -WorkingDirectory $WeChatDir
  Ok "已启动（可能需要点一下「进入微信」）"
}

# ── 5) 等加载 ──────────────────────────────────────────────────────────────
# ── 4.5) 自动点「进入微信」（用户要求：不需要人工点）──────────────────────
#   UIA 的 Invoke 对 Qt 窗口无效，但「UIA 拿坐标 + 真实鼠标点击」可行
#   （实测 2026-10-21 08:43：进程 1→5，dbs 0→19，一次点中）。
Say "[4.5/7] 自动点「进入微信」"
if ($DryRun) {
  Say "（DryRun）会调用 scripts/click-enter-wechat.ps1 点登录按钮"
} else {
  $clickScript = Join-Path $PSScriptRoot "click-enter-wechat.ps1"
  if (Test-Path $clickScript) {
    try {
      & pwsh -NoProfile -File $clickScript -ApiPort $ApiPort -Wait -MaxSeconds 90 2>&1 | ForEach-Object { Say "    $_" }
    } catch { Say "    ⚠️ 自动点击失败（不影响后续，可以人工点）: $($_.Exception.Message)" }
  } else {
    Say "    ⚠️ 没找到 click-enter-wechat.ps1，跳过自动点击"
  }
}

Say "[5/7] 等客户端加载（最多 5 分钟；判据 dbs>5 且 Weixin>=3，不按时间判断）"
if ($DryRun) { Say "（DryRun）将轮询状态" }
else {
  $ready = $false
  for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 15
    $np = (Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count
    $dbs = 0
    try { $d = (Invoke-WebRequest "http://127.0.0.1:$ApiPort/QueryDB/debug" -Method Get -TimeoutSec 15).Content | ConvertFrom-Json; $dbs = @($d.dbs).Count } catch { }
    Say "[$($i*15)s] 进程=$np dbs=$dbs"
    if ($dbs -gt 5 -and $np -ge 3) { $ready = $true; break }
  }
  if (-not $ready) {
    Say "⚠️ 没达到就绪。**不要反复重启**（规则 R4/R5）——先看 /QueryDB/debug、看客户端窗口是否停在登录页。"
    Say "   如果停在登录页：手动点「进入微信」，再等 30 秒。"
  } else { Ok "客户端就绪" }
}

# ── 6) 起桥 ────────────────────────────────────────────────────────────────
Say "[6/7] 起桥"
if ($DryRun) { Say "（DryRun）将启动桥" }
else {
  $logDir = Join-Path (Split-Path $BridgeDir -Parent) "data\logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir -Force | Out-Null }
  Start-Process -FilePath "node" `
    -ArgumentList "server.mjs", "--transport=wechat-hook", "--api-port=$ApiPort", "--cb-port=$CbPort", `
                  "--data-dir=$(Join-Path (Split-Path $BridgeDir -Parent) 'data')", "--wechat=$(Join-Path $WeChatDir 'Weixin.exe')" `
    -WorkingDirectory $BridgeDir `
    -RedirectStandardOutput (Join-Path $logDir "bridge-hook.out.log") `
    -RedirectStandardError  (Join-Path $logDir "bridge-hook.err.log") `
    -WindowStyle Hidden
  Start-Sleep -Seconds 40
  Ok "桥已启动"
}

# ── 7) 验收 ────────────────────────────────────────────────────────────────
Say "[7/7] 验收"
if (-not $DryRun) {
  try { $st = (Invoke-WebRequest "http://127.0.0.1:17300/api/status" -TimeoutSec 12).Content | ConvertFrom-Json
    Say "桥 loggedIn=$($st.loggedIn) 收=$($st.counters.msgsIn) 发=$($st.counters.msgsOut)"
    Say "轮询失败: $((Select-String -Path (Join-Path (Split-Path $BridgeDir -Parent) 'data\logs\bridge-hook.out.log') -Pattern '轮询失败' -EA SilentlyContinue | Measure-Object).Count) 次（应为 0）"
  } catch { Say "⚠️ 桥状态取不到" }
  try { $v = (Invoke-WebRequest "http://127.0.0.1:$ApiPort/Debug/VoiceSend" -Method Post -Body '{"on":true}' -ContentType "application/json" -TimeoutSec 15).Content | ConvertFrom-Json
    Say "语音发送开关 forceOn=$($v.forceOn)"
  } catch { }
  $wc = (Get-Process -Name Weixin -EA SilentlyContinue | Measure-Object).Count
  $ec = (Get-Process -Name WeChatAppEx -EA SilentlyContinue | Measure-Object).Count
  Say "客户端: Weixin=$wc AppEx=$ec（正常应为 5 / 10，且只有一个实例）"
}

Say ""
Ok "完成。如果客户端停在登录页，点一下「进入微信」即可。"
Say "★ 提醒：一晚最多做 2 轮重启（规则 R4）。不要连做 3 轮以上。"
