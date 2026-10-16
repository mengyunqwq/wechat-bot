# 一键安装脚本（Windows）
# 作用：检查环境 → 装依赖 → 生成配置模板 → 打印后续步骤
# 用法：powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg) { Say "  [OK] $msg" 'Green' }
function Warn($msg) { Say "  [!]  $msg" 'Yellow' }
function Bad($msg) { Say "  [X]  $msg" 'Red' }

Say "`n=== dsh-wechat-bot 一键安装 ===`n" 'Cyan'
Say "⚠️  本项目是二次开发产物，使用前请阅读 NOTICE.md（合规与账号风险）`n" 'Yellow'

# ── 1. 检查 Node ──────────────────────────────────────────────
Say "[1/5] 检查 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (& node -v) -replace '^v', ''
  $major = [int]($v.Split('.')[0])
  if ($major -ge 18) { Ok "Node v$v" } else { Bad "Node 版本过低（v$v），需要 18+"; $needNode = $true }
} else {
  Bad "没找到 node"
  Warn "安装：winget install OpenJS.NodeJS.LTS"
  $needNode = $true
}

# ── 2. 检查 Python ───────────────────────────────────────────
Say "`n[2/5] 检查 Python"
$py = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { 'python' }
try {
  $pv = & $py --version 2>&1
  Ok "$pv"
  $pyOk = $true
} catch {
  Bad "没找到 python"
  Warn "安装：winget install Python.Python.3.12"
  $pyOk = $false
}

# ── 3. 装依赖 ────────────────────────────────────────────────
Say "`n[3/5] 安装依赖"
if ($pyOk) {
  Say "  Python: pycryptodome, zstandard"
  & $py -m pip install --quiet pycryptodome zstandard 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "Python 依赖就绪" } else { Warn "Python 依赖安装失败，请手动：$py -m pip install pycryptodome zstandard" }
}
if (-not $needNode) {
  Say "  Node: ws, fzstd, jimp …"
  Push-Location "$root\wx-bridge"
  & npm install --no-audit --no-fund 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "Node 依赖就绪" } else { Warn "Node 依赖安装失败，请手动在 wx-bridge 目录执行 npm install" }
  Pop-Location
}

# ── 4. 生成配置 ──────────────────────────────────────────────
Say "`n[4/5] 生成配置"
if (Test-Path "$root\config.json") {
  Ok "config.json 已存在，跳过"
} else {
  Copy-Item "$root\config.example.json" "$root\config.json"
  Ok "已生成 config.json —— 请填写 wechatExe（机器人专用微信的完整路径）"
}

# ── 5. 找微信客户端 ──────────────────────────────────────────
Say "`n[5/5] 检查微信客户端"
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$wx = $cfg.wechatExe
if ($wx -and (Test-Path $wx)) {
  Ok "微信客户端：$wx"
  $verDir = Get-ChildItem (Split-Path $wx) -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
  if ($verDir) { Ok "客户端版本目录：$($verDir.Name)" }
  $dll = Join-Path (Split-Path $wx) 'version.dll'
  if (Test-Path $dll) {
    $len = (Get-Item $dll).Length
    Ok "version.dll 已就位（$len 字节）"
    Warn "注意：官方 release 的 DLL 没有 QueryDB 修复，拿不到群成员昵称。要完整功能请按 DEPLOY.md 第 2 节方案 B 自己编译"
  } else {
    Bad "没找到 version.dll —— 请按 DEPLOY.md 第 2 节获取微信 Hook"
  }
} else {
  Warn "config.json 里的 wechatExe 无效：$wx"
  Warn "请复制一份独立微信（robocopy），然后填写它的 Weixin.exe 完整路径"
}

# ── 完成 ─────────────────────────────────────────────────────
Say "`n=== 下一步 ===" 'Cyan'
Say "  1. 编辑 config.json，确认 wechatExe 指向机器人专用微信"
Say "  2. 启动： cd wx-bridge ; npm start"
Say "  3. 验证： curl http://127.0.0.1:17300/api/status"
Say "  4. 接入 agent：见 DEPLOY.md 第 5 节（MCP / REST / 托管模式）"
Say "`n完整说明：README.md、DEPLOY.md、wx-bridge/PROTOCOL.md`n" 'Gray'
