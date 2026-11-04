# 编译 version.dll（Release x64），输出产物信息
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root
Set-Location $root

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "找不到 vswhere，请先安装 VS 2022 Build Tools" }
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
if (-not $msbuild) { throw "找不到 MSBuild，请安装「使用 C++ 的桌面开发」工作负载" }

Write-Host "MSBuild: $msbuild"
& $msbuild 'x64_Version_dll.sln' /p:Configuration=Release /p:Platform=x64 /m /v:m /nologo
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$dll = Join-Path $root 'x64\Release\version.dll'
if (-not (Test-Path $dll)) { throw "编译成功但没找到产物: $dll" }
$item = Get-Item $dll
$sha = (Get-FileHash $dll -Algorithm SHA256).Hash.ToLower()
Write-Host ""
Write-Host ("产物: " + $dll)
Write-Host ("大小: " + [Math]::Round($item.Length/1KB,0) + "KB")
Write-Host ("SHA256: " + $sha)