# 一键部署（Windows 10/11 x64）
#
# 把 DEPLOY.md 里的 8 个步骤串起来，一条命令从头装到能说话：
#   ① 环境检查（Node / Python / Git / MSBuild）
#   ② 装依赖（npm + pip）
#   ③ 准备一份独立的微信客户端（不碰你日常用的那份）
#   ④ 获取 Hook：调 scripts/build-hook.ps1 编译（克隆上游 + 打补丁 + 编译）
#   ⑤ 部署 version.dll（自动备份原文件）
#   ⑥ 生成 config.json（自动填微信路径）
#   ⑦ 起桥 + 装 DSH 插件
#   ⑧ 健康检查
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\一键部署.ps1
#   powershell -ExecutionPolicy Bypass -File .\一键部署.ps1 -WeChatDir "D:\WeChat"
#   powershell -ExecutionPolicy Bypass -File .\一键部署.ps1 -HookDll "D:\my-version.dll"   # 已有 DLL 时跳过编译
#   powershell -ExecutionPolicy Bypass -File .\一键部署.ps1 -SkipHook -NoStart              # 只装代码和依赖
#
# 设计原则：
#   · 幂等：重复跑不会破坏已装好的东西（已存在就跳过）
#   · 可回滚：动任何文件前先备份
#   · 不猜：每一步都真的验证，失败就停在这一步并说清楚原因
#   · 不重写：编译调 build-hook.ps1、启动调 start-bot.ps1，逻辑只维护一份

param(
  [string]$Dir       = '',        # 项目目录（默认=脚本所在目录）
  [string]$WeChatDir = '',        # 独立微信目录（默认识别/询问）
  [string]$HookDll   = '',        # 已有的 version.dll（给了就跳过编译）
  [string]$WorkDir   = '',        # hook 源码工作目录（默认 %USERPROFILE%\wxhook-src）
  [switch]$SkipHook,              # 跳过 Hook 环节（只装代码）
  [switch]$NoStart,               # 装完不启动
  [switch]$NoDsh                  # 不尝试装 DSH 插件
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 选 PowerShell 宿主：优先 pwsh 7（原生 UTF-8，中文不会乱码），回退 powershell 5.1（需 BOM）
$PSHostExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
Write-Host ("  PowerShell 宿主: " + $PSHostExe) -ForegroundColor DarkGray

# ── 输出助手 ────────────────────────────────────────────────
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok([string]$m)   { Say "  [OK] $m" 'Green' }
function Warn([string]$m) { Say "  [!]  $m" 'Yellow' }
function Bad([string]$m)  { Say "  [X]  $m" 'Red' }
function Step([string]$m) { Say "`n$m" 'Cyan' }
function Die([string]$m)  { Bad $m; Say ''; Read-Host '按回车退出'; exit 1 }

function Ask([string]$q, [string]$def = '') {
  $hint = if ($def) { " [$def]" } else { '' }
  $a = Read-Host "  $q$hint"
  if (-not $a) { $a = $def }
  return $a
}

# ── 0. 定位项目目录 ─────────────────────────────────────────
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Test-Path "$Dir\wx-bridge\server.mjs")) {
  Die "这里不像项目根目录（缺 wx-bridge\server.mjs）：$Dir`n请在仓库根目录运行本脚本，或用 -Dir 指定。"
}
Set-Location $Dir
Say "`n╔══════════════════════════════════════════════════════════╗" 'Cyan'
Say "║        dsh-wechat-bot · 一键部署（Windows x64）           ║" 'Cyan'
Say "╚══════════════════════════════════════════════════════════╝" 'Cyan'
Say "  项目目录：$Dir"

# ── 1. 环境检查 ─────────────────────────────────────────────
Step '[1/8] 环境检查'

$missing = @()

# Node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nv = (& node -v) -replace '^v', ''
  $nmajor = 0
  [void][int]::TryParse(($nv -split '\.')[0], [ref]$nmajor)
  if ($nmajor -ge 18) { Ok "Node v$nv" }
  else { Bad "Node v$nv 太旧（需要 ≥18）"; $missing += 'node' }
} else { Bad '没找到 node'; $missing += 'node' }

# Python
$pyExe = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { 'python' }
$pyOk = $false
try {
  $pv = (& $pyExe --version 2>&1) -join ' '
  if ($pv -match 'Python 3\.(\d+)' -and [int]$matches[1] -ge 10) { Ok "$pv"; $pyOk = $true }
  else { Bad "$pv 太旧（需要 ≥3.10）"; $missing += 'python' }
} catch { Bad '没找到 python'; $missing += 'python' }

# Git（编译 Hook 时需要）
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { Ok ("git " + ((& git --version 2>&1) -replace '^git version ', '')) }
else { Warn '没找到 git（编译 Hook 需要）'; if (-not $SkipHook -and -not $HookDll) { $missing += 'git' } }

# MSBuild（只有要编译 Hook 时才必需）
$msbuild = $null
foreach ($c in @(
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
)) { if (Test-Path $c) { $msbuild = $c; break } }
if (-not $msbuild) {
  $f = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\MSBuild.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { $msbuild = $f.FullName }
}
if ($msbuild) { Ok "MSBuild: $msbuild" }
elseif (-not $SkipHook -and -not $HookDll) { Warn '没找到 MSBuild —— 编译 Hook 时会尝试自动安装 VS 2022 Build Tools（2~6 GB / 15~30 分钟）' }

# 微信客户端
$wxExe = $null
$wxCandidates = @(
  "$env:ProgramFiles\Tencent\Weixin\Weixin.exe",
  "${env:ProgramFiles(x86)}\Tencent\Weixin\Weixin.exe",
  'D:\wxhook\wx4110\Weixin.exe'
)
foreach ($p in $wxCandidates) { if (Test-Path $p) { $wxExe = $p; break } }
if (-not $wxExe) {
  $reg = Get-ItemProperty 'HKCU:\Software\Tencent\Weixin' -ErrorAction SilentlyContinue
  if ($reg -and $reg.InstallPath) {
    $c = Join-Path $reg.InstallPath 'Weixin.exe'
    if (Test-Path $c) { $wxExe = $c }
  }
}
if (-not $wxExe) {
  foreach ($proc in (Get-Process -Name Weixin -ErrorAction SilentlyContinue)) {
    try { if ($proc.Path -and (Test-Path $proc.Path)) { $wxExe = $proc.Path; break } } catch {}
  }
}

if ($missing.Count -gt 0) {
  Say ''
  Warn '缺少必需组件：' + ($missing -join ', ')
  Say '  安装命令：' 'Yellow'
  if ($missing -contains 'node')   { Say '    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements' }
  if ($missing -contains 'python') { Say '    winget install --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements' }
  if ($missing -contains 'git')    { Say '    winget install --id Git.Git --accept-package-agreements --accept-source-agreements' }
  Say ''
  Say '  装完必须【新开一个终端】再跑本脚本（PATH 才生效）。' 'Yellow'
  $ans = Ask '已经装好了，现在继续？(y/N)' 'n'
  if ($ans -notmatch '^[yY]') { exit 1 }
}

# ── 2. 装依赖 ───────────────────────────────────────────────
Step '[2/8] 安装依赖'

Say '  Node 依赖（wx-bridge）…'
Push-Location "$Dir\wx-bridge"
# 判断 node_modules 是否真的可用（不能只看目录在不在）
$nmOk = $false
if (Test-Path 'node_modules') {
  # 桥在跑会锁住 node_modules 里的 .node 文件 → npm 清理阶段 EBUSY
  $bridgeRunning = Get-NetTCPConnection -LocalPort 17300 -State Listen -ErrorAction SilentlyContinue
  if (Test-Path 'node_modules\ws\package.json') {
    if ($bridgeRunning) {
      Warn 'node_modules 已存在（桥正在运行，跳过重装以免文件被占用）'
      $nmOk = $true
    } else {
      # 有基础包就当已装好；后续 npm 若有更新需求可手动跑
      $nmOk = $true
      Ok 'node_modules 已存在，跳过（如需强制重装：先停桥，再删 node_modules）'
    }
  }
}
if (-not $nmOk) {
  $log = & npm install --no-audit --no-fund 2>&1
  $log | ForEach-Object { if ($_ -match 'added|up to date') { Say "    $_" } }
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    # 区分三种常见失败
    $joined = ($log -join "`n")
    if ($joined -match 'EBUSY|EPERM|resource busy or locked') {
      Die "npm install 失败：node_modules 里有文件被占用。`n  最可能：桥正在运行（或微信相关进程持有 .node 文件）。`n  请先停掉桥（关掉那个 node 窗口），再重跑本脚本。"
    }
    if ($joined -match 'ETIMEDOUT|ECONNRESET|EAI_AGAIN|network') {
      Die "npm install 失败：网络问题。`n  可换源后重试：npm config set registry https://registry.npmmirror.com"
    }
    Die "npm install 失败 —— 完整日志见上面的 npm error 行。`n  也可手动：cd wx-bridge && npm install"
  }
  Ok 'Node 依赖就绪'
}
Pop-Location

if ($pyOk) {
  Say '  Python 依赖（pycryptodome / pilk / imageio-ffmpeg / Pillow / edge-tts）…'
  & $pyExe -m pip install --quiet --disable-pip-version-check pycryptodome pilk imageio-ffmpeg Pillow edge-tts 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $check = & $pyExe -c "import Crypto, pilk, imageio_ffmpeg, PIL, edge_tts; print('ok')" 2>&1
    if ($check -match 'ok') { Ok 'Python 依赖就绪' } else { Warn '部分 Python 依赖导入失败（语音/视频功能可能降级）' }
  } else { Warn 'pip install 有失败项 —— 识图/语音/视频可能降级' }
}

# ── 3. 准备独立微信客户端 ───────────────────────────────────
Step '[3/8] 准备独立微信客户端'

if ($WeChatDir -and (Test-Path "$WeChatDir\Weixin.exe")) {
  Ok "使用指定目录：$WeChatDir"
} else {
  if (-not $wxExe) {
    Say ''
    Warn '没自动找到微信客户端。'
    Say '  Hook 只适配【微信 4.1.10.27 x64】，请先在别的机器或本机装好该版本。' 'Yellow'
    $wxExe = Ask '微信安装目录（含 Weixin.exe 的那个目录）'
    if (-not $wxExe -or -not (Test-Path "$wxExe\Weixin.exe")) { Die "目录无效：$wxExe" }
    $WeChatDir = $wxExe
  } else {
    $WeChatDir = Split-Path $wxExe -Parent
    Ok "找到微信：$WeChatDir"
    Say ''
    Say '  ⚠️ 强烈建议用【独立的微信目录】，不要直接改你日常用的那份。' 'Yellow'
    Say "     脚本可以复制一份到 D:\wxhook\wx4110（约 1-2 GB）" 'Gray'
    $ans = Ask '复制一份独立微信吗？(Y/n)' 'y'
    if ($ans -notmatch '^[nN]') {
      $target = 'D:\wxhook\wx4110'
      if (Test-Path "$target\Weixin.exe") { Ok "已存在：$target" }
      else {
        Say "  复制 $WeChatDir → $target …（1-2 分钟）"
        & robocopy $WeChatDir $target /E /NFL /NDL /NJH /NJS /NP 2>&1 | Out-Null
        # robocopy 退出码 0~7 都是成功，>=8 才是失败
        if ($LASTEXITCODE -ge 8) { Warn "robocopy 返回 $LASTEXITCODE，复制可能不完整" }
        if (Test-Path "$target\Weixin.exe") { Ok "独立微信已就绪：$target" } else { Warn '复制后没找到 Weixin.exe，请手动准备' }
      }
      $WeChatDir = $target
    }
  }
}

# 版本校验：必须有 4.1.10.27 子目录（微信 4.x 是「外壳 + 版本目录」结构）
$verDir = Get-ChildItem $WeChatDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
if ($verDir) {
  if ($verDir.Name -eq '4.1.10.27') { Ok "客户端版本：$($verDir.Name) ✓" }
  else {
    Warn "客户端版本是 $($verDir.Name)，但 Hook 只适配 4.1.10.27"
    $ans = Ask '继续？（y/N）' 'n'
    if ($ans -notmatch '^[yY]') { Die '请安装微信 4.1.10.27 x64 后重试' }
  }
} else {
  Warn "在 $WeChatDir 下没找到版本号目录（可能不是微信 4.x 结构）"
}

# ── 4. 获取 Hook ────────────────────────────────────────────
Step '[4/8] 获取微信 Hook（version.dll）'

$hookSource = $null    # 最终要部署的 DLL
if ($SkipHook) {
  Warn '跳过 Hook（-SkipHook）—— 机器人会连不上微信'
} elseif ($HookDll) {
  if (-not (Test-Path $HookDll)) { Die "指定的 DLL 不存在：$HookDll" }
  $hookSource = $HookDll
  Ok "使用指定的 DLL：$HookDll"
} else {
  Say '  检查是否已有可用的编译产物…'
  $existing = @(
    "$WorkDir\WeChat-Hook\x64\Release\version.dll",
    'E:\wxhook-src\WeChat-Hook\x64\Release\version.dll'
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($existing) {
    $sha = (Get-FileHash $existing -Algorithm SHA256).Hash.Substring(0, 8)
    Ok "发现已有产物：$existing（$([math]::Round((Get-Item $existing).Length/1KB,0)) KB, $sha）"
    $ans = Ask '直接用这个？(Y/n)' 'y'
    if ($ans -match '^[nN]') { $existing = $null }
  }

  if (-not $existing) {
    Say ''
    Say '  没有现成产物 → 调 scripts/build-hook.ps1 编译（克隆上游 + 打补丁 + 编译）'
    Say '  ⚠️ 这一步需要 VS 2022 Build Tools；没装的话脚本会问你是否自动装（2~6 GB）' 'Yellow'
    Say '  编译本身只要 1~2 秒，时间几乎都花在装编译器上。' 'Gray'
    if (-not $WorkDir) { $WorkDir = Join-Path $env:USERPROFILE 'wxhook-src' }
    $buildArgs = @('-ExecutionPolicy', 'Bypass', '-File', "$Dir\scripts\build-hook.ps1", '-TargetDir', $WeChatDir, '-WorkDir', $WorkDir)
    & $PSHostExe @buildArgs
    if ($LASTEXITCODE -ne 0) { Die 'Hook 编译失败 —— 看上面的输出；也可手动按 DEPLOY.md 第 2 节方案 B 做' }
    $existing = Join-Path $WorkDir 'WeChat-Hook\x64\Release\version.dll'
    if (-not (Test-Path $existing)) { Die "编译后没找到产物：$existing" }
  }
  $hookSource = $existing
}

# ── 5. 部署 DLL ─────────────────────────────────────────────
Step '[5/8] 部署 version.dll'

if ($hookSource) {
  $dst = Join-Path $WeChatDir 'version.dll'
  # 微信在跑 → DLL 被锁
  $running = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue).Count
  if ($running -gt 0) {
    Warn "微信正在运行（$running 个进程）→ version.dll 被占用，无法替换"
    Say '  请【完全退出微信】（托盘右键 → 退出微信），然后按回车继续' 'Yellow'
    [void](Read-Host '  退出后按回车')
    if (@(Get-Process -Name Weixin -ErrorAction SilentlyContinue).Count -gt 0) {
      Die '微信仍在运行。DLL 被锁时无法部署，请退出后重跑本脚本（或加 -SkipHook 先装其余部分）'
    }
  }
  if (Test-Path $dst) {
    $bak = "$dst.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $dst $bak -Force
    Ok "已备份原文件 → $(Split-Path $bak -Leaf)"
  }
  Copy-Item $hookSource $dst -Force
  $sha = (Get-FileHash $dst -Algorithm SHA256).Hash.Substring(0, 8)
  $sizeKB = [math]::Round((Get-Item $dst).Length / 1KB, 0)
  Ok "已部署：$dst（$sizeKB KB, $sha）"
  # 只提示去哪确认，不在脚本里校验具体实现细节（那些不公开）
  Say '  眼睛能力（原图 / 视频整片）是否可用，到控制面板「👁 眼睛」页看：' 'Gray'
  Say '    · CDN 重放 ✅ = 可用    ❌ = 该 DLL 不含此能力（识图退化为缩略图、视频退化为封面）' 'Gray'
} else {
  Warn '跳过部署（没有可用的 DLL）'
}

# ── 6. 生成配置 ─────────────────────────────────────────────
Step '[6/8] 生成配置'

$cfgPath = "$Dir\config.json"
$cfg = $null
if (Test-Path $cfgPath) {
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
if (-not $cfg) {
  if (Test-Path "$Dir\config.example.json") {
    Copy-Item "$Dir\config.example.json" $cfgPath -Force
    Ok '已从模板生成 config.json'
  } else {
    '{}' | Set-Content $cfgPath -Encoding UTF8
    Warn '没有 config.example.json，生成了空配置'
  }
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

# 填微信路径
$exePath = Join-Path $WeChatDir 'Weixin.exe'
if ($cfg.PSObject.Properties.Name -contains 'wechatExe') { $cfg.wechatExe = $exePath }
else { $cfg | Add-Member -NotePropertyName wechatExe -NotePropertyValue $exePath -Force }
$cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding UTF8
Ok "wechatExe = $exePath"

# ── 7. 启动 ─────────────────────────────────────────────────
Step '[7/8] 启动'

if ($NoStart) {
  Warn '跳过启动（-NoStart）'
} else {
  # 起桥（start-bot.ps1 会顺便拉起微信客户端）
  # 注意：start-bot.ps1 不接参数，只读环境变量 WECHAT_EXE
  $env:WECHAT_EXE = $exePath
  Say '  调用 scripts/start-bot.ps1（拉起微信 + 起桥）…'
  & $PSHostExe -ExecutionPolicy Bypass -File "$Dir\scripts\start-bot.ps1"
  Start-Sleep -Seconds 3

  # 装 DSH 插件（如果检测到 DSH 环境）
  if (-not $NoDsh) {
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dshCmd) {
      Say ''
      Warn '没找到 dsh 命令 —— 控制面板和「大脑」需要 DSH 运行时'
      Say '  安装/启动方式：' 'Yellow'
      Say '    npx @deepseek-ai/dsh web --port 3080' 'Gray'
      Say '  然后把本项目作为插件装进 DSH（见 DEPLOY.md 第 5.1 节）。' 'Gray'
    }
  }
}

# ── 8. 健康检查 ─────────────────────────────────────────────
Step '[8/8] 健康检查'

$fail = 0

# 桥端口
$bridgeOk = Get-NetTCPConnection -LocalPort 17300 -State Listen -ErrorAction SilentlyContinue
if ($bridgeOk) { Ok '桥 17300 在监听' } else { Bad '桥 17300 没监听'; $fail++ }

# hook 端口
try {
  $r = Invoke-RestMethod 'http://127.0.0.1:30001/QueryDB/status' -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 5
  Ok "hook 30001 可访问（IsLogin=$($r.IsLogin)）"
} catch { Bad 'hook 30001 无响应（微信没起？DLL 没加载？）'; $fail++ }

# 数据库
try {
  $d = Invoke-RestMethod 'http://127.0.0.1:30001/Debug/DBRescan' -TimeoutSec 8
  Ok "数据库 reg=$($d.counters.registrations) named=$($d.registry.named) db=$($d.db_count) lookup_ok=$($d.counters.lookup_ok)"
  if ($d.counters.lookup_ok -eq 0 -and $d.registry.named -gt 0) {
    Warn 'lookup_ok=0 —— 名字全是扫描猜的（可能是中文数据目录，或者 DLL 没含中文路径修复）'
  }
} catch { Warn '数据库诊断路由不可用（DLL 可能不是补丁版）' }

# ── 完成 ────────────────────────────────────────────────────
Say ''
Say '╔══════════════════════════════════════════════════════════╗' 'Cyan'
if ($fail -eq 0) { Say '║  部署完成 ✓                                              ║' 'Green' }
else             { Say "║  部署结束，但有 $fail 项没通过（见上）                          ║" 'Yellow' }
Say '╚══════════════════════════════════════════════════════════╝' 'Cyan'
Say ''
Say '  下一步：' 'Cyan'
Say '    1. 微信登录（登录窗口按回车）'
Say '    2. 启动 DSH：npx @deepseek-ai/dsh web --port 3080'
Say '    3. 打开控制面板：http://127.0.0.1:3080/wechat-bot'
Say '    4. 在群里 @ 机器人说句话试试'
Say ''
Say '  排错：DEPLOY.md 第 6 节 / docs/OPERATIONS-RULES.md' 'Gray'
Say ''
