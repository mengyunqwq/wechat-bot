# backup-full.ps1 —— 全量备份（换组件 / 高危实验前的保险）
#
# 设计原则：**不写死任何本机路径**，全部自动探测，或用参数覆盖。
#
# 用法：
#   .\backup-full.ps1
#   .\backup-full.ps1 -DataRoot 'D:\...\xwechat_files\wxid_xxx' -BridgeDir 'D:\...\wx-bridge'
#   .\backup-full.ps1 -OutRoot 'E:\my-backup' -SkipClient
#
# 参数（都可省略，会被自动探测）：
#   -DataRoot    微信数据目录（含 msg\attach 的那层）
#   -BridgeDir   接入层目录（含 server.mjs）
#   -BotDir      本项目目录（默认 = 本脚本所在仓库根）
#   -ClientDir   微信客户端目录（含 Weixin.exe 与 version.dll）
#   -AppDataDir  微信 AppData（默认自动）
#   -PluginData  机器人插件数据目录（可选）
#   -OutRoot     备份输出根目录（默认：数据目录所在盘 \backup-wechat-<时间戳>）
#   -SkipClient  跳过客户端目录（体积最大，通常几百 MB）

param(
  [string]$DataRoot = '',
  [string]$BridgeDir = '',
  [string]$BotDir = '',
  [string]$ClientDir = '',
  [string]$AppDataDir = '',
  [string]$PluginData = '',
  [string]$OutRoot = '',
  [switch]$SkipClient
)

$ErrorActionPreference = 'Stop'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Say($m)  { Write-Host "  $m" }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

# ── 自动探测 ────────────────────────────────────────────────────────────────
function FindDataRoot() {
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null })) {
    $base = "$($drive.Name):\Users"
    if (-not (Test-Path $base)) { continue }
    foreach ($u in (Get-ChildItem $base -Directory -EA SilentlyContinue)) {
      $wx = Join-Path $u.FullName 'xwechat_files'
      if (-not (Test-Path $wx)) { continue }
      $cand = Get-ChildItem $wx -Directory -Filter 'wxid_*' -EA SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'msg\attach') } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($cand) { return $cand.FullName }
    }
  }
  return ''
}

function FindBridgeDir() {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repo = Split-Path -Parent (Split-Path -Parent $here)      # scripts\ → 仓库根
  $cands = @(
    (Join-Path (Split-Path -Parent $repo) 'wx-bridge'),
    (Join-Path $repo 'wx-bridge')
  )
  foreach ($c in $cands) { if (Test-Path (Join-Path $c 'server.mjs')) { return $c } }
  return ''
}

function FindClientDir() {
  $roots = @("$env:ProgramFiles\Tencent", "${env:ProgramFiles(x86)}\Tencent", 'D:\', 'E:\')
  foreach ($r in $roots) {
    if (-not $r -or -not (Test-Path $r)) { continue }
    try {
      $exe = Get-ChildItem $r -Recurse -Depth 3 -File -Filter 'Weixin.exe' -EA SilentlyContinue | Select-Object -First 1
      if ($exe) { return (Split-Path -Parent $exe.FullName) }
    } catch { }
  }
  return ''
}

if (-not $DataRoot)   { $DataRoot   = FindDataRoot }
if (-not $BridgeDir)  { $BridgeDir  = FindBridgeDir }
if (-not $BotDir)     { $BotDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not $ClientDir)  { $ClientDir  = FindClientDir }
if (-not $AppDataDir) { $AppDataDir = Join-Path $env:APPDATA 'Tencent\xwechat' }
if (-not $OutRoot) {
  $q = if ($DataRoot) { Split-Path -Qualifier $DataRoot } else { Split-Path -Qualifier (Get-Location).Path }
  $OutRoot = Join-Path "$q\" ('backup-wechat-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

Say ''
Say '=== 探测结果（不对就用参数覆盖）==='
Say "  微信数据:   $(if ($DataRoot) { $DataRoot } else { '（未找到）' })"
Say "  接入层:     $(if ($BridgeDir) { $BridgeDir } else { '（未找到）' })"
Say "  本项目:     $BotDir"
Say "  客户端:     $(if ($ClientDir) { $ClientDir } else { '（未找到，可用 -ClientDir 指定）' })"
Say "  AppData:    $AppDataDir"
Say "  插件数据:   $(if ($PluginData) { $PluginData } else { '（未指定，跳过）' })"
Say "  备份到:     $OutRoot"
Say ''

if (-not $DataRoot) { Warn '没探测到微信数据目录 —— 数据库备份会被跳过（建议用 -DataRoot 指定）' }
if (Test-Path $OutRoot) { Fail "备份目录已存在：$OutRoot（换个 -OutRoot）" }
New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null

# ── robocopy 封装（rc<8 视为成功；-Tolerant 允许部分文件被占用）────────────
function Mirror($src, $dst, [string[]]$xd = @(), [string[]]$xf = @(), [switch]$Tolerant) {
  if (-not $src -or -not (Test-Path $src)) { Warn "源不存在，跳过: $src"; return }
  $args = @($src, $dst, '/E', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($xd.Count -gt 0) { $args += '/XD'; $args += $xd }
  if ($xf.Count -gt 0) { $args += '/XF'; $args += $xf }
  & robocopy @args | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    if ($Tolerant) { Warn ("{0} 部分文件被占用（rc={1}），已尽力备份" -f (Split-Path $dst -Leaf), $rc) }
    else { Fail "robocopy 失败 rc=$rc : $src -> $dst" }
  } else {
    $sz = (Get-ChildItem $dst -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    Ok ("{0} （{1} MB）" -f (Split-Path $dst -Leaf), [math]::Round($sz/1MB,1))
  }
}

Say '[1/5] 微信数据'
if ($DataRoot) {
  Mirror "$DataRoot\db_storage" "$OutRoot\wechat-data\db_storage"
  Mirror "$DataRoot\config"     "$OutRoot\wechat-data\config"
  Mirror "$DataRoot\cache"      "$OutRoot\wechat-data\cache"
  Mirror "$DataRoot\msg\attach" "$OutRoot\wechat-data\msg\attach"
} else { Warn '跳过（没有数据目录）' }

Say ''
if ($SkipClient -or -not $ClientDir) { Warn '[2/5] 跳过客户端目录' }
else { Say '[2/5] 客户端目录（含 version.dll）'; Mirror $ClientDir "$OutRoot\client\wechat" }

Say ''
Say '[3/5] 代码'
if ($BridgeDir) { Mirror $BridgeDir "$OutRoot\code\wx-bridge" @('node_modules', '.git') } else { Warn '跳过接入层（没找到）' }
if ($BotDir -and (Test-Path $BotDir)) { Mirror $BotDir "$OutRoot\code\$(Split-Path $BotDir -Leaf)" } else { Warn '跳过本项目' }

Say ''
Say '[4/5] 微信 AppData（排除缓存/日志）'
if (Test-Path $AppDataDir) {
  Mirror $AppDataDir "$OutRoot\appdata-wechat" @(
    (Join-Path $AppDataDir 'radium'), (Join-Path $AppDataDir 'log'),
    (Join-Path $AppDataDir 'crashinfo'), (Join-Path $AppDataDir 'net'),
    (Join-Path $AppDataDir 'net_1'), (Join-Path $AppDataDir 'net_2'),
    (Join-Path $AppDataDir 'confsdk')
  ) -Tolerant
} else { Warn '跳过（没有 AppData 目录）' }

Say ''
Say '[5/5] 清单与还原脚本'
if ($PluginData -and (Test-Path $PluginData)) {
  Mirror $PluginData "$OutRoot\plugin-data\$(Split-Path $PluginData -Leaf)"
}

$manifest = [System.Collections.Generic.List[string]]::new()
$manifest.Add('全量备份清单')
$manifest.Add("生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$manifest.Add("备份根目录: $OutRoot")
$manifest.Add('')
$manifest.Add('源路径:')
$manifest.Add("  wechat-data   <- $DataRoot")
$manifest.Add("  client        <- $ClientDir")
$manifest.Add("  code\wx-bridge <- $BridgeDir")
$manifest.Add("  code\$(Split-Path $BotDir -Leaf) <- $BotDir")
$manifest.Add("  appdata-wechat <- $AppDataDir")
$manifest.Add('')
$manifest.Add('文件（相对路径 | 字节 | 修改时间）:')
Get-ChildItem $OutRoot -Recurse -File -EA SilentlyContinue | ForEach-Object {
  $manifest.Add(('{0}|{1}|{2}' -f $_.FullName.Replace($OutRoot + '\', ''), $_.Length, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))
}
$manifest | Set-Content (Join-Path $OutRoot 'MANIFEST.txt') -Encoding utf8

$restore = @'
# RESTORE.ps1 —— 还原本次备份
#   ⚠️ 运行前必须完全退出微信（托盘右键 → 退出微信）
param(
  [ValidateSet('all','data','client','code','appdata')][string]$Only = 'all',
  [string]$DataRoot = '', [string]$ClientDir = '', [string]$BridgeDir = '', [string]$BotDir = ''
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($m) { Write-Host "  $m" }

if (Get-Process -Name Weixin -EA SilentlyContinue) {
  Write-Host '  [X] 微信还在运行，请先完全退出（托盘右键 -> 退出微信）' -ForegroundColor Red; exit 1
}

function Back($src, $dst) {
  if (-not (Test-Path $src)) { Say "跳过（备份里没有）: $src"; return }
  if (-not $dst) { Say "跳过（没给目标路径）: $src"; return }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  & robocopy $src $dst /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host "  [X] 还原失败: $src -> $dst" -ForegroundColor Red; exit 1 }
  Say "已还原: $dst"
}

if ($Only -in @('all','data') -and $DataRoot) {
  Back "$Root\wechat-data\db_storage" "$DataRoot\db_storage"
  Back "$Root\wechat-data\config"     "$DataRoot\config"
  Back "$Root\wechat-data\cache"      "$DataRoot\cache"
  Back "$Root\wechat-data\msg\attach" "$DataRoot\msg\attach"
}
if ($Only -in @('all','client') -and $ClientDir) { Back "$Root\client\wechat" $ClientDir }
if ($Only -in @('all','code')) {
  Back "$Root\code\wx-bridge" $BridgeDir
  if ($BotDir) { Back "$Root\code\$(Split-Path $BotDir -Leaf)" $BotDir }
}
if ($Only -in @('all','appdata')) { Back "$Root\appdata-wechat" (Join-Path $env:APPDATA 'Tencent\xwechat') }

Say ''
Say '完成。启动微信 → 登录窗口按【回车】→ 等库挂载 → 起桥。'
'@
$restore | Set-Content (Join-Path $OutRoot 'RESTORE.ps1') -Encoding utf8

$n = (Get-ChildItem $OutRoot -Recurse -File -EA SilentlyContinue | Measure-Object).Count
$total = (Get-ChildItem $OutRoot -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
Ok '清单 + 还原脚本已写入'
Say ''
Write-Host '  === 备份完成 ===' -ForegroundColor Cyan
Say "  目录: $OutRoot"
Say "  大小: $([math]::Round($total/1MB,0)) MB / $n 个文件"
Say "  还原: 完全退出微信后运行 $OutRoot\RESTORE.ps1"
