# 微信机器人 · 一键启动（通用模板）
#
# 为什么是 PowerShell + 一个纯 ASCII 的 .cmd 壳，而不是单个 .cmd：
#   批处理是按【控制台当前码页】解析文件字节的。只要脚本里出现中文路径，
#   双击运行（码页 936）和从 PowerShell 里调用（码页 65001）就会一个正常一个乱码，
#   严重时中文碎片会被当成命令执行。PowerShell 脚本用 UTF-8+BOM，与码页无关。
#
# 需要你配置的只有【微信客户端路径】（其余都有默认值），用环境变量：
#   setx WECHAT_EXE       "D:\wxhook\wx4110\Weixin.exe"   ← 必填：你复制的 hooked 微信
#   setx WECHAT_BOT_DATA  "D:\wechat-bot-data"            ← 可选：数据目录（默认 <仓库>\wx-bridge\data）
#   setx WECHAT_BOT_PORT  "17300"                          ← 可选：bridge 端口
#   setx WECHAT_HOOK_PORT "30001"                          ← 可选：hook HTTP 端口
#   setx WECHAT_CB_PORT   "18998"                          ← 可选：hook 回调端口
# （setx 后要新开一个窗口才生效）
$ErrorActionPreference = 'Continue'

$RepoRoot  = Split-Path -Parent $PSScriptRoot                 # scripts/ 的上一级 = 仓库根
$BridgeDir = Join-Path $RepoRoot 'wx-bridge'
$DataDir   = if ($env:WECHAT_BOT_DATA)  { $env:WECHAT_BOT_DATA }  else { Join-Path $BridgeDir 'data' }
$WxExe     = $env:WECHAT_EXE
$BotPort   = if ($env:WECHAT_BOT_PORT)  { $env:WECHAT_BOT_PORT }  else { 17300 }
$HookPort  = if ($env:WECHAT_HOOK_PORT) { $env:WECHAT_HOOK_PORT } else { 30001 }
$CbPort    = if ($env:WECHAT_CB_PORT)   { $env:WECHAT_CB_PORT }   else { 18998 }

Write-Host '============================================================'
Write-Host ' 微信机器人 · 一键启动'
Write-Host "   微信客户端 : $(if ($WxExe) { $WxExe } else { '(未设置 WECHAT_EXE)' })"
Write-Host "   hook API   : 127.0.0.1:$HookPort    回调 : http://127.0.0.1:$CbPort"
Write-Host "   bridge     : 127.0.0.1:$BotPort    (DSH 里的插件连这个)"
Write-Host "   数据目录   : $DataDir"
Write-Host '============================================================'
Write-Host ''

# ── 1/3 微信客户端：没在跑就用【正确参数】拉起 ──
# 必须带 RecvType=1 + CallBackURL，否则收不到消息回调；
# 不带参数直接双击 Weixin.exe 会按它自己 config.ini 的端口走，和 bridge 对不上。
if (-not $WxExe -or -not (Test-Path $WxExe)) {
  Write-Host '[1/3] 没找到微信客户端 —— 请先设置环境变量 WECHAT_EXE：'
  Write-Host '        setx WECHAT_EXE "D:\wxhook\wx4110\Weixin.exe"'
  Write-Host '      路径怎么准备见 DEPLOY.md 第 1、2 节。'
} else {
  $wx = Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue
  if ($wx) {
    Write-Host '[1/3] 微信客户端已在运行，跳过启动'
  } else {
    Write-Host '[1/3] 启动微信客户端（RecvType=1，回调）...'
    Start-Process -FilePath $WxExe `
      -ArgumentList "StartPort=$HookPort", 'RecvType=1', "CallBackURL=http://127.0.0.1:$CbPort" `
      -WorkingDirectory (Split-Path -Parent $WxExe)
    Write-Host '      等 hook 就绪（约 10 秒）...'
    Start-Sleep -Seconds 10
  }
}

# ── 2/3 bridge：已在跑就不重复起（两个桥会抢同一个端口）──
$listening = Get-NetTCPConnection -LocalPort $BotPort -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "[2/3] bridge 已在运行（$BotPort 已监听），不重复启动"
  Write-Host '[3/3] 机器人已在工作 —— 现在可以在微信群里跟它说话'
  Write-Host ''
  Write-Host '若它不回话：先确认 DSH 里的插件在线，再看日志：'
  Write-Host "  $DataDir\logs\bridge-hook.out.log"
} else {
  Write-Host '[2/3] 启动 bridge ...'
  Write-Host '[3/3] 就绪。本窗口保持打开 = bridge 在跑；关掉本窗口即停止 bridge。'
  Write-Host ''
  Set-Location $BridgeDir
  # 注意 --data-dir= 必须用等号：server.mjs 的 opt() 只认 --key=value 形式
  & node server.mjs --transport=wechat-hook "--api-port=$HookPort" "--cb-port=$CbPort" "--data-dir=$DataDir" "--wechat=$WxExe"
  Write-Host ''
  Write-Host "bridge 已退出（退出码 $LASTEXITCODE）"
}

Write-Host ''
Write-Host '按回车关闭窗口...'
[void](Read-Host)
