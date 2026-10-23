# 一键安装：hires provider（高分辨率图片组件）
#
# 做什么：检查微信已退出 → 备份原 version.dll → 替换 → 建开关 → 准备输出目录
# 不做：不杀进程、不强关微信（安全第一）
#
# 用法：右键「使用 PowerShell 运行」，或
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\一键安装.ps1

param(
  [string]$WeChatDir = 'D:\wxhook\wx4110',
  [string]$OutDir = 'D:\cdndl-replay'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Ok($m)  { Write-Host "  [OK] $m" -ForegroundColor Green }
function Say($m) { Write-Host "  $m" }
function Warn($m){ Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  [X] $m" -ForegroundColor Red; Read-Host '按回车退出'; exit 1 }

Write-Host ''
Write-Host '  === hires provider 一键安装 ===' -ForegroundColor Cyan
Say "包目录: $here"
Say "微信目录: $WeChatDir"
Say ''

# ── 1) 前置检查 ─────────────────────────────────────────────────────────────
Say '[1/6] 检查微信是否已完全退出'
$proc = Get-Process -Name Weixin -EA SilentlyContinue
if ($proc) {
  Die "微信还在运行（$($proc.Count) 个进程）。请先从托盘图标右键 → 退出微信，再重跑本脚本。"
}
Ok '微信已完全退出'

Say '[2/6] 检查微信目录'
if (-not (Test-Path $WeChatDir)) { Die "目录不存在: $WeChatDir" }
$exe = Join-Path $WeChatDir 'Weixin.exe'
$dll = Join-Path $WeChatDir 'version.dll'
if (-not (Test-Path $exe)) { Die "找不到 Weixin.exe：$WeChatDir" }
Ok "找到 Weixin.exe"
if (Test-Path $dll) {
  $ver = (Get-Item $dll).VersionInfo.FileVersion
  Say "  现有 version.dll: $([math]::Round((Get-Item $dll).Length/1KB,0))KB"
} else {
  Warn '目录里没有 version.dll（可能是全新未 hook 的客户端）'
}

# ── 2) 版本提示（读不到就跳过）───────────────────────────────────────────────
Say '[3/6] 版本核对（组件只适配 4.1.10.27）'
$sub = Get-ChildItem $WeChatDir -Directory -EA SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
if ($sub) {
  if ($sub.Name -eq '4.1.10.27') { Ok "客户端版本: $($sub.Name)" }
  else { Warn "客户端版本是 $($sub.Name)，组件是为 4.1.10.27 做的 —— 继续安装可能失效或异常" ; $go = Read-Host '  仍要继续吗？输入 YES 继续'; if ($go -ne 'YES') { Die '用户取消' } }
} else { Warn '无法判断客户端版本，请自行确认是 4.1.10.27' }

# ── 3) 备份 + 替换 ──────────────────────────────────────────────────────────
Say '[4/6] 备份并替换 version.dll'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $dll) {
  $bak = "$dll.bak.$stamp"
  Copy-Item $dll $bak -Force
  Ok "原文件已备份: $bak"
}
$srcDll = Join-Path $here 'version.dll'
if (-not (Test-Path $srcDll)) { Die "包内缺少 version.dll（应在 $here）" }
Copy-Item $srcDll $dll -Force
$newHash = (Get-FileHash $dll -Algorithm SHA256).Hash
Ok "已替换，SHA256=$($newHash.Substring(0,16))…"

# ── 4) 开关文件 ────────────────────────────────────────────────────────────
Say '[5/6] 创建开关文件'
New-Item -ItemType File (Join-Path $WeChatDir 'hook-vuprobe.on') -Force | Out-Null
New-Item -ItemType File (Join-Path $WeChatDir 'hook-cdn-replay.on') -Force | Out-Null
Set-Content (Join-Path $WeChatDir 'hook-cdn-replay.dir') $OutDir -Encoding ascii -NoNewline
Ok 'hook-vuprobe.on（安装 hook，必须）'
Ok 'hook-cdn-replay.on（启用高分辨率图）'
Ok "hook-cdn-replay.dir → $OutDir"

# ── 5) 输出目录 ────────────────────────────────────────────────────────────
Say '[6/6] 准备输出目录'
New-Item -ItemType Directory $OutDir -Force | Out-Null
Ok "$OutDir"

Write-Host ''
Write-Host '  === 安装完成 ===' -ForegroundColor Cyan
Write-Host ''
Say '接下来：'
Say "  1) 启动微信：$exe"
Say '  2) 登录窗口出现后【直接按回车】进入'
Say '  3) 发一张带文字的截图到群里，看机器人能否读出字'
Say ''
Say '观察 30 分钟：'
Say "  $env:APPDATA\Tencent\xwechat\crashinfo\reports  有没有新增 .dmp"
Say '  有 → 立刻运行「一键回滚.ps1」'
Write-Host ''
Read-Host '按回车退出'
