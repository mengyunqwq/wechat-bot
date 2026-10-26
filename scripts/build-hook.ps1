# 自动构建我们改造过的微信 Hook（version.dll）
#
# 为什么用脚本而不是直接发编译好的 DLL？
#   上游 aixed/WeChat-Hook **没有 LICENSE 文件**（默认"保留所有权利"），
#   直接再分发其衍生二进制（version.dll）法律风险高。
#   所以本脚本让**你自己在本机构建** —— 我们只提供补丁和流程。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-hook.ps1 -TargetDir "D:\wxhook\wx4110"
#
# 它会：检查/安装 VS Build Tools → 克隆上游 → 应用补丁 → 编译 → 部署（自动备份原文件）

param(
  [string]$TargetDir = "D:\wxhook\wx4110",      # 机器人专用微信目录（version.dll 要放这里）
  [string]$WorkDir   = "E:\wxhook-src",          # 源码工作目录
  [string]$Repo      = "https://github.com/aixed/WeChat-Hook.git",
  # ⚠️ 必须锁定提交：补丁是针对下面这个提交生成的；上游一更新，git apply 就会失败（实测过）
  [string]$Commit    = "5c92aab",                 # 补丁的基准提交（aixed/WeChat-Hook）
  [switch]$SkipInstall                            # 已装 VS Build Tools 时跳过安装检查
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$patch = Join-Path $root 'patches\wechat-hook-querydb-fix.patch'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok($m)  { Say "  [OK] $m" 'Green' }
function Warn($m){ Say "  [!]  $m" 'Yellow' }
function Bad($m) { Say "  [X]  $m" 'Red' }

Say "`n=== 构建我们改造过的微信 Hook ===`n" 'Cyan'
Say "⚠️  上游项目没有 LICENSE（默认保留所有权利）→ 本脚本让**你自己构建**，不代你分发二进制`n" 'Yellow'

# ── 1. 找 MSBuild ────────────────────────────────────────────
Say "[1/5] 查找 MSBuild（VS 2022 Build Tools）"
$msbuild = $null
$cands = @(
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe"
)
foreach ($c in $cands) { if (Test-Path $c) { $msbuild = $c; break } }
if (-not $msbuild) {
  $found = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\2022\*\MSBuild\Current\Bin\MSBuild.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $msbuild = $found.FullName }
}

if ($msbuild) {
  Ok "MSBuild: $msbuild"
} elseif ($SkipInstall) {
  Bad "没找到 MSBuild，但指定了 -SkipInstall"; exit 1
} else {
  Warn "没找到 MSBuild —— 需要安装 VS 2022 Build Tools（含 C++ 工作负载 + Windows SDK，约 2~6 GB）"
  $ans = Read-Host "  现在用 winget 安装吗？(y/N)"
  if ($ans -notmatch '^[yY]') { Bad "请手动安装后重跑：winget install --id Microsoft.VisualStudio.2022.BuildTools --override `"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""; exit 1 }
  Say "  正在安装（这一步可能十几分钟）…"
  winget install --id Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
  foreach ($c in $cands) { if (Test-Path $c) { $msbuild = $c; break } }
  if (-not $msbuild) { Bad "安装后仍未找到 MSBuild，请重开一个终端再跑"; exit 1 }
  Ok "MSBuild 就绪"
}

# ── 2. 克隆上游 ──────────────────────────────────────────────
Say "`n[2/5] 获取上游源码"
$src = Join-Path $WorkDir 'WeChat-Hook'
if (Test-Path (Join-Path $src '.git')) {
  Ok "已存在：$src（跳过克隆，只取提交）"
  Push-Location $src
  git fetch --quiet origin 2>$null
  Pop-Location
} else {
  New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
  Say "  git clone $Repo → $src（完整克隆，便于切到指定提交）"
  git clone --quiet $Repo $src
  if ($LASTEXITCODE -ne 0) { Bad "克隆失败"; exit 1 }
  Ok "克隆完成"
}
# 锁定到补丁的基准提交 —— 不锁的话上游一更新，git apply 必失败（已实测）
Push-Location $src
git checkout --quiet $Commit 2>$null
if ($LASTEXITCODE -ne 0) {
  Bad "找不到提交 $Commit —— 上游可能改了历史；请用 -Commit <sha> 指定补丁对应的提交"
  Pop-Location; exit 1
}
Ok "已锁定上游提交：$Commit（$(git log -1 --format=%s)）"
Pop-Location

# ── 3. 应用补丁 ──────────────────────────────────────────────
Say "`n[3/5] 应用我们的补丁"
Push-Location $src
$already = git diff --stat
if ($already) {
  Warn "工作区已有改动，先重置到干净状态（丢弃本地改动）"
  git checkout -- . 2>$null
}
if (-not (Test-Path $patch)) { Bad "找不到补丁文件：$patch"; Pop-Location; exit 1 }
git apply --check $patch 2>$null
if ($LASTEXITCODE -ne 0) {
  Warn "直接 apply 失败，尝试 3-way 合并"
  git apply --3way $patch
} else {
  git apply $patch
}
if ($LASTEXITCODE -ne 0) { Bad "补丁应用失败 —— 上游可能已更新，需要重新适配"; Pop-Location; exit 1 }
Ok "补丁已应用："
git diff --stat | ForEach-Object { Say "    $_" }

# ── 3.5 生成偏移特征 ────────────────────────────────────────
Say "`n[3.5/5] 生成偏移特征（从本机 Weixin.dll 提取，不入库）"
$wxDll = Get-ChildItem (Join-Path $TargetDir '') -Recurse -Filter 'Weixin.dll' -ErrorAction SilentlyContinue |
         Sort-Object Length -Descending | Select-Object -First 1
if (-not $wxDll) {
  Warn "没找到 Weixin.dll（在 $TargetDir 下）→ 跳过特征生成，将全部使用硬编码偏移"
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
& $msbuild 'x64_Version_dll.vcxproj' /m /t:Build /p:Configuration=Release /p:Platform=x64 /v:minimal
if ($LASTEXITCODE -ne 0) { Bad "编译失败"; Pop-Location; exit 1 }
$built = Join-Path $src 'x64\Release\version.dll'
if (-not (Test-Path $built)) { Bad "没有产物：$built"; Pop-Location; exit 1 }
$b = Get-Item $built
Ok "产物：$($b.Length) 字节  MD5=$((Get-FileHash $built -Algorithm MD5).Hash.Substring(0,12))"
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
Say "  curl http://127.0.0.1:30001/QueryDB/debug        # 有响应 = 补丁版已加载（官方版返回 404）"
Say "  curl -X POST http://127.0.0.1:30001/QueryDB/GetAllDBName -d {}   # 应返回 20+ 个数据库"
Say "`n注意：message_0.db 是懒加载的，客户端刚启动时它不存在；"
Say "      需要群里来消息或自己发一条，微信才会打开它（收消息轮询依赖它）。`n"
