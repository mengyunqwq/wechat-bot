# 一键回滚：hires provider
#
# 做什么：把 version.dll 还原成安装前的备份 → 清掉开关文件
# 不做：不杀进程、不强关微信
#
# 用法：右键「使用 PowerShell 运行」，或
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\一键回滚.ps1

param([string]$WeChatDir = 'D:\wxhook\wx4110')

$ErrorActionPreference = 'Stop'

function Ok($m)  { Write-Host "  [OK] $m" -ForegroundColor Green }
function Say($m) { Write-Host "  $m" }
function Warn($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [X] $m" -ForegroundColor Red; Read-Host '按回车退出'; exit 1 }

Write-Host ''
Write-Host '  === hires provider 一键回滚 ===' -ForegroundColor Cyan
Say "微信目录: $WeChatDir"
Say ''

# ── 1) 前置检查 ─────────────────────────────────────────────────────────────
$proc = Get-Process -Name Weixin -EA SilentlyContinue
if ($proc) { Die "微信还在运行（$($proc.Count) 个进程）。请先从托盘图标右键 → 退出微信，再重跑。" }
Ok '微信已完全退出'

$dll = Join-Path $WeChatDir 'version.dll'
if (-not (Test-Path $WeChatDir)) { Die "目录不存在: $WeChatDir" }

# ── 2) 找最近一次备份 ──────────────────────────────────────────────────────
Say '[1/3] 查找备份'
$baks = Get-ChildItem $WeChatDir -File -Filter 'version.dll.bak.*' -EA SilentlyContinue | Sort-Object LastWriteTime -Descending
if (-not $baks -or $baks.Count -eq 0) {
  Warn '没找到 version.dll.bak.* 备份'
  Warn '如果这是你第一次装组件，可能原文件已被覆盖 —— 请从完整备份恢复（全量备份里有原版 hook 的 version.dll）'
  $go = Read-Host '  只清理开关、不动 DLL 吗？输入 YES 继续'
  if ($go -ne 'YES') { Die '用户取消' }
} else {
  $bak = $baks[0]
  Ok "使用备份: $($bak.Name)（$([math]::Round($bak.Length/1KB,0))KB，$($bak.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))）"
  Say '[2/3] 还原 version.dll'
  Copy-Item $bak.FullName $dll -Force
  Ok "已还原，SHA256=$((Get-FileHash $dll -Algorithm SHA256).Hash.Substring(0,16))…"
}

# ── 3) 清开关 ──────────────────────────────────────────────────────────────
Say '[3/3] 清理开关文件'
foreach ($f in 'hook-cdn-replay.on','hook-cdn-replay.dir','hook-vuprobe.on') {
  $p = Join-Path $WeChatDir $f
  if (Test-Path $p) { Remove-Item $p -Force; Ok "已删除 $f" } else { Say "  （$f 本来就不存在）" }
}

Write-Host ''
Write-Host '  === 回滚完成 ===' -ForegroundColor Cyan
Write-Host ''
Say '接下来：'
Say "  1) 启动微信：$(Join-Path $WeChatDir 'Weixin.exe')"
Say '  2) 登录窗口出现后【直接按回车】进入'
Say '  3) 图片能力退回「本地 .dat 解密」（能认图，小字读不出），但不会再影响客户端稳定性'
Write-Host ''
Read-Host '按回车退出'
