# 供批处理调用的状态探测（避免在 cmd 里写带引号的 PowerShell 单行命令）
# 输出：CLIENT=1/0（机器人客户端是否在跑）  BRIDGE=1/0（接入层端口是否在监听）
param(
  [string]$ClientExe = 'D:\wxhook\wx4110\Weixin.exe',
  [int]$Port = 17300
)

$client = $false
try {
  $client = [bool](Get-Process Weixin -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $ClientExe })
} catch { $client = $false }

$bridge = $false
try {
  $bridge = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
} catch { $bridge = $false }

Write-Output ("CLIENT=" + $(if ($client) { '1' } else { '0' }))
Write-Output ("BRIDGE=" + $(if ($bridge) { '1' } else { '0' }))
