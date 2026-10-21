# backup-full.ps1 —— 全量备份（为「逆向 CDN 下载接口」这种高危实验准备）
#
# 用法：
#   .\backup-full.ps1                  # 备份到 E:\backup-wechat-<时间戳>
#   .\backup-full.ps1 -Root 'E:\xx'    # 指定备份根目录
#
# 备份内容：
#   1) 微信数据：db_storage / config / cache / msg\attach
#   2) 微信客户端：整个 wx4110 目录（含 version.dll 这个 hook，换 DLL 前必须留底）
#   3) 我们的代码：wx-bridge + dsh-wechat-bot（含 .git 历史）
#   4) WeChat AppData：登录态/配置（排除 radium、log、crashinfo 这些大而无关的）
#   5) 机器人插件配置与记忆：D:\dsh\data\wechat-bot
#   6) MANIFEST.txt（清单）+ RESTORE.ps1（一键还原）
#
# 安全约定：只读源、只写备份目录，不碰微信进程。

param(
  [string]$Root = '',
  [switch]$SkipClient
)

$ErrorActionPreference = 'Stop'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Say($m)  { Write-Host "  $m" }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

$DataRoot   = 'D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886'
$ClientDir  = 'D:\wxhook\wx4110'
$BridgeDir  = 'D:\微信deepseek\wx-bridge'
$BotDir     = 'D:\dsh-wechat-bot'
$AppDataWx  = Join-Path $env:APPDATA 'Tencent\xwechat'
$PluginData = 'D:\dsh\data\wechat-bot'

if (-not $Root) { $Root = 'E:\backup-wechat-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }
if (Test-Path $Root) { Fail "备份目录已存在，换一个：$Root" }

New-Item -ItemType Directory -Path $Root -Force | Out-Null
Say "备份根目录: $Root"
Say "开始时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say ''

# ── robocopy 封装（返回码 <8 视为成功）─────────────────────────────────────
function Mirror($src, $dst, [string[]]$xd = @(), [string[]]$xf = @(), [switch]$Tolerant) {
  if (-not (Test-Path $src)) { Warn "源不存在，跳过: $src"; return }
  $args = @($src, $dst, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($xd.Count -gt 0) { $args += '/XD'; $args += $xd }
  if ($xf.Count -gt 0) { $args += '/XF'; $args += $xf }
  & robocopy @args | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    if ($Tolerant) {
      Warn ("{0} 有文件被占用/跳过（rc={1}），已尽力备份" -f (Split-Path $dst -Leaf), $rc)
    } else {
      Fail "robocopy 失败 rc=$rc : $src -> $dst"
    }
  } else {
    $sz = (Get-ChildItem $dst -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    Ok ("{0} （{1} MB，rc={2}）" -f (Split-Path $dst -Leaf), [math]::Round($sz/1MB,1), $rc)
  }
}

# ── 1) 微信数据 ───────────────────────────────────────────────────────────
Say '[1/6] 微信数据'
Mirror "$DataRoot\db_storage" "$Root\wechat-data\db_storage"
Mirror "$DataRoot\config"     "$Root\wechat-data\config"
Mirror "$DataRoot\cache"      "$Root\wechat-data\cache"
Mirror "$DataRoot\msg\attach" "$Root\wechat-data\msg\attach"

# ── 2) 微信客户端（含 hook DLL）───────────────────────────────────────────
Say ''
if ($SkipClient) { Warn '[2/6] 跳过客户端目录（-SkipClient）' }
else { Say '[2/6] 微信客户端目录（含 version.dll）'; Mirror $ClientDir "$Root\client\wx4110" }

# ── 3) 我们的代码 ─────────────────────────────────────────────────────────
Say ''
Say '[3/6] 代码'
Mirror $BridgeDir "$Root\code\wx-bridge" @('node_modules', '.git') 
Mirror $BotDir    "$Root\code\dsh-wechat-bot"

# ── 4) WeChat AppData（排除大而无内容的部分）──────────────────────────────
Say ''
Say '[4/6] WeChat AppData（排除 radium/log/crashinfo）'
Mirror $AppDataWx "$Root\appdata-wechat" @(
  (Join-Path $AppDataWx 'radium'),
  (Join-Path $AppDataWx 'log'),
  (Join-Path $AppDataWx 'crashinfo'),
  (Join-Path $AppDataWx 'net'),
  (Join-Path $AppDataWx 'net_1'),
  (Join-Path $AppDataWx 'net_2'),
  (Join-Path $AppDataWx 'confsdk')
) -Tolerant

# ── 5) 插件配置与记忆 ────────────────────────────────────────────────────
Say ''
Say '[5/6] 机器人插件数据'
Mirror $PluginData "$Root\plugin-data\wechat-bot"
if (Test-Path 'D:\dsh\data\wechat-bot\config.json') { Copy-Item 'D:\dsh\data\wechat-bot\config.json' "$Root\plugin-data\config.json" -Force -EA SilentlyContinue }

# ── 6) 清单 + 还原脚本 ───────────────────────────────────────────────────
Say ''
Say '[6/6] 生成清单与还原脚本'

$manifest = @()
$manifest += "全量备份清单"
$manifest += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$manifest += "备份根目录: $Root"
$manifest += ''
$manifest += '源路径对照:'
$manifest += "  wechat-data\db_storage   <- $DataRoot\db_storage"
$manifest += "  wechat-data\config       <- $DataRoot\config"
$manifest += "  wechat-data\cache        <- $DataRoot\cache"
$manifest += "  wechat-data\msg\attach   <- $DataRoot\msg\attach"
$manifest += "  client\wx4110            <- $ClientDir"
$manifest += "  code\wx-bridge           <- $BridgeDir"
$manifest += "  code\dsh-wechat-bot      <- $BotDir"
$manifest += "  appdata-wechat           <- $AppDataWx"
$manifest += "  plugin-data\wechat-bot   <- $PluginData"
$manifest += ''
$manifest += '文件清单（相对路径 | 字节 | 最后写入）:'
Get-ChildItem $Root -Recurse -File -EA SilentlyContinue | ForEach-Object {
  $manifest += ('{0}|{1}|{2}' -f $_.FullName.Replace($Root + '\', ''), $_.Length, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
}
$manifest | Set-Content (Join-Path $Root 'MANIFEST.txt') -Encoding utf8
$n = (Get-ChildItem $Root -Recurse -File -EA SilentlyContinue | Measure-Object).Count
$total = (Get-ChildItem $Root -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
Ok "清单写好：$n 个文件，共 $([math]::Round($total/1MB,0)) MB"

# 还原脚本（注意：不在这里 execute，只写出来）
$restore = @'
# RESTORE.ps1 —— 一键还原本次备份
#   ⚠️ 运行前必须先完全退出微信（托盘右键 → 退出微信）
#   用法: .\RESTORE.ps1            # 还原全部
#         .\RESTORE.ps1 -Only data # 只还原微信数据

param([ValidateSet('all','data','client','code','appdata')][string]$Only = 'all')

$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataRoot   = 'D:\Users\Administrator\xwechat_files\wxid_3odtthhn7u5t22_7886'
$ClientDir  = 'D:\wxhook\wx4110'
$BridgeDir  = 'D:\微信deepseek\wx-bridge'
$BotDir     = 'D:\dsh-wechat-bot'
$AppDataWx  = Join-Path $env:APPDATA 'Tencent\xwechat'
$PluginData = 'D:\dsh\data\wechat-bot'

function Say($m) { Write-Host "  $m" }

$running = Get-Process -Name Weixin -EA SilentlyContinue
if ($running) {
  Write-Host "  [X] 微信还在运行！请先完全退出（托盘右键 -> 退出微信），再跑这个脚本。" -ForegroundColor Red
  exit 1
}
Say "从备份还原: $Root"

function Back($src, $dst) {
  if (-not (Test-Path $src)) { Say "跳过（备份里没有）: $src"; return }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  & robocopy $src $dst /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host "  [X] 还原失败: $src -> $dst" -ForegroundColor Red; exit 1 }
  Say "已还原: $dst"
}

if ($Only -in @('all','data')) {
  Back "$Root\wechat-data\db_storage" "$DataRoot\db_storage"
  Back "$Root\wechat-data\config"     "$DataRoot\config"
  Back "$Root\wechat-data\cache"      "$DataRoot\cache"
  Back "$Root\wechat-data\msg\attach" "$DataRoot\msg\attach"
}
if ($Only -in @('all','client')) { Back "$Root\client\wx4110" $ClientDir }
if ($Only -in @('all','code')) {
  Back "$Root\code\wx-bridge"      $BridgeDir
  Back "$Root\code\dsh-wechat-bot" $BotDir
}
if ($Only -in @('all','appdata')) { Back "$Root\appdata-wechat" $AppDataWx }
if ($Only -in @('all')) { Back "$Root\plugin-data\wechat-bot" $PluginData }

Say ''
Say "还原完成。下一步：启动微信 -> 登录窗口按【回车】进入 -> 等库挂载 -> 起桥。"
'@
$restore | Set-Content (Join-Path $Root 'RESTORE.ps1') -Encoding utf8
Ok "还原脚本：$Root\RESTORE.ps1"

Say ''
Say "完成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say ''
Write-Host "  === 备份就绪 ===" -ForegroundColor Cyan
Say "  目录: $Root"
Say "  大小: $([math]::Round($total/1MB,0)) MB / $n 个文件"
Say "  还原: 完全退出微信后，运行 $Root\RESTORE.ps1"
