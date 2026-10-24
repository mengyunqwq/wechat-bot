# 构建微信 Hook（version.dll）—— 默认使用我们自己的 hook 仓库
#
# 源码：https://github.com/mengyunqwq/wechat-hook （公开，衍生自 aixed/WeChat-Hook）
# 本项目默认就用它；官方 upstream 的 release 版 QueryDB 是坏的，不要用。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1 -TargetDir "D:\wxhook\wx4110"
#
# 它会：检查 VS Build Tools → 克隆/更新我们的 hook 仓库 → （可选）生成偏移特征 → 编译 → 备份并部署

param(
  [string]$TargetDir = "D:\wxhook\wx4110",                               # 机器人专用微信目录（version.dll 要放这里）
  [string]$WorkDir   = "D:\wxhook-src",                                   # 源码工作目录
  [string]$Repo      = "https://github.com/mengyunqwq/wechat-hook.git",   # 我们自己的 hook 仓库
  [string]$Branch    = "main",
  [switch]$SkipInstall                                                    # 已装 VS Build Tools 时跳过安装检查
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok($m)  { Say "  [OK] $m" 'Green' }
function Warn($m){ Say "  [!]  $m" 'Yellow' }
function Bad($m) { Say "  [X]  $m" 'Red' }

Say "`n=== 构建微信 Hook（我们的仓库）===`n" 'Cyan'
Say "源码: $Repo ($Branch)" 'Gray'

# ── 1. 找 MSBuild ────────────────────────────────────────────
Say "`n[1/5] 查找 MSBuild"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = $null
if (Test-Path $vswhere) {
  $msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2>$null | Select-Object -First 1
}
if (-not $msbuild) {
  foreach ($p in @(
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
  )) { if (Test-Path $p) { $msbuild = $p; break } }
}
if (-not $msbuild) {
  Bad "找不到 MSBuild"
  Say "  请安装 VS 2022 Build Tools（勾选「使用 C++ 的桌面开发」）：" 'Yellow'
  Say "  https://visualstudio.microsoft.com/visual-cpp-build-tools/" 'Yellow'
  if (-not $SkipInstall) { exit 1 }
} else { Ok "MSBuild：$msbuild" }

# ── 2. 克隆或更新我们的 hook 仓库 ────────────────────────────
Say "`n[2/5] 获取源码"
$src = Join-Path $WorkDir 'wechat-hook'
if (Test-Path (Join-Path $src '.git')) {
  Push-Location $src
  Ok "已存在，更新到最新"
  git fetch origin 2>$null
  git checkout $Branch 2>$null
  git pull --ff-only origin $Branch 2>$null
  if ($LASTEXITCODE -ne 0) { Warn "更新失败（可能本地有改动）→ 继续用现有代码" }
  Pop-Location
} else {
  New-Item -ItemType Directory -Force $WorkDir | Out-Null
  git clone --branch $Branch $Repo $src
  if ($LASTEXITCODE -ne 0) { Bad "克隆失败：$Repo"; exit 1 }
  Ok "已克隆到 $src"
}
Push-Location $src
Ok "当前提交：$(git log -1 --format='%h %s')"
Pop-Location

# ── 3. （可选）用本机 Weixin.dll 生成偏移特征 ────────────────
Say "`n[3/5] 生成偏移特征（可选，从本机 Weixin.dll 提取）"
$wxDll = Get-ChildItem $TargetDir -Recurse -Filter 'Weixin.dll' -ErrorAction SilentlyContinue |
         Sort-Object Length -Descending | Select-Object -First 1
if (-not $wxDll) {
  Warn "没找到 Weixin.dll（在 $TargetDir 下）→ 跳过，使用仓库自带的硬编码偏移"
} else {
  $gen = Join-Path $root 'scripts\gen-offset-patterns.py'
  if (-not (Test-Path $gen)) { Warn "缺少 $gen → 跳过" }
  else {
    Ok "目标：$($wxDll.FullName)（$([math]::Round($wxDll.Length/1MB,1)) MB）"
    & python $gen $wxDll.FullName (Join-Path $src 'include\offset_patterns.h')
    if ($LASTEXITCODE -eq 2) { Warn "部分偏移取不到特征（会回退硬编码值，不影响运行）" }
    elseif ($LASTEXITCODE -ne 0) { Warn "特征生成失败 → 全部回退硬编码偏移" }
    else { Ok "特征已生成" }
  }
}

# ── 4. 编译 ──────────────────────────────────────────────────
Say "`n[4/5] 编译（Release x64）"
Push-Location $src
& $msbuild 'x64_Version_dll.vcxproj' /m /t:Build /p:Configuration=Release /p:Platform=x64 /v:minimal
if ($LASTEXITCODE -ne 0) { Bad "编译失败"; Pop-Location; exit 1 }
$built = Join-Path $src 'x64\Release\version.dll'
if (-not (Test-Path $built)) { Bad "没有产物：$built"; Pop-Location; exit 1 }
$b = Get-Item $built
Ok "产物：$($b.Length) 字节  SHA256=$((Get-FileHash $built -Algorithm SHA256).Hash.Substring(0,16))"
Pop-Location

# ── 5. 部署 ──────────────────────────────────────────────────
Say "`n[5/5] 部署到 $TargetDir"
if (-not (Test-Path $TargetDir)) { Bad "目标目录不存在：$TargetDir（请先复制一份独立微信客户端）"; exit 1 }
$dst = Join-Path $TargetDir 'version.dll'
if (Test-Path $dst) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = Join-Path $TargetDir "version.dll.bak-$stamp"
  Copy-Item $dst $bak -Force
  Ok "已备份原文件 → $(Split-Path $bak -Leaf)"
}
Copy-Item $built $dst -Force
Ok "已部署：$dst"
Say "  提示：部署前请先停掉微信客户端和 wx-bridge，否则文件被占用会失败" 'Yellow'

Say "`n=== 完成 ===" 'Cyan'
Say "验证（先启动客户端和 wx-bridge）："
Say "  curl http://127.0.0.1:30001/QueryDB/debug        # 有响应 = 我们的 hook 已加载"
Say "  curl -X POST http://127.0.0.1:30001/QueryDB/GetAllDBName -d {}   # 应返回 20+ 个数据库"
Say "`n注意：message_0.db 是懒加载的，客户端刚启动时它不存在；"
Say "      需要群里来消息或自己发一条，微信才会打开它（收消息轮询依赖它）。"
