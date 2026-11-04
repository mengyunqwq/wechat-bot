# 在桌面创建「启动 / 关闭 微信机器人」快捷方式，图标用用户给的那张图
$desktop = [Environment]::ExpandEnvironmentVariables(
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').Desktop)
$root = 'D:\微信deepseek'
$icon = Join-Path $root 'assets\bot.ico'

if (-not (Test-Path $icon)) { Write-Output "图标不存在: $icon"; exit 1 }
Write-Output "桌面: $desktop"
Write-Output "图标: $icon"

$ws = New-Object -ComObject WScript.Shell

$defs = @(
  @{ name = '启动微信机器人.lnk'; target = (Join-Path $root '启动机器人.cmd'); desc = '启动微信拟人化群聊机器人（微信客户端 + wx-bridge 接入层）' },
  @{ name = '关闭微信机器人.lnk'; target = (Join-Path $root '停止机器人.cmd'); desc = '关闭微信机器人的接入层（微信客户端不关，你自己决定）' }
)

foreach ($d in $defs) {
  $path = Join-Path $desktop $d.name
  if (-not (Test-Path $d.target)) { Write-Output "✗ 目标脚本不存在: $($d.target)"; continue }
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath = $d.target
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = $d.desc
  $lnk.WindowStyle = 1
  $lnk.Save()
  if (Test-Path $path) { Write-Output "✓ 已创建: $($d.name)" } else { Write-Output "✗ 创建失败: $($d.name)" }
}

Write-Output ''
Write-Output '=== 桌面上的机器人快捷方式 ==='
Get-ChildItem $desktop -Filter '*机器人*.lnk' | ForEach-Object {
  $s = $ws.CreateShortcut($_.FullName)
  Write-Output ("  {0}`n     → 目标: {1}`n     → 图标: {2}`n     → 说明: {3}" -f $_.Name, $s.TargetPath, $s.IconLocation, $s.Description)
}
