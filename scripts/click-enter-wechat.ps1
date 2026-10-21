# 自动点微信登录窗口的「进入微信」按钮
#
#  为什么需要：微信最小化/重启后会停在登录页（mmui::LoginWindow），
#  必须点「进入微信」才真正进去。UIA 的 InvokePattern 对 Qt 窗口无效
#  （报"目标元素无法接收焦点"），但 **UIA 拿坐标 + 真实鼠标点击** 是可以的
#  （实测 2026-10-21 08:43：进程 1→5，dbs 0→19，一次点中）。
#
#  用法：
#    pwsh -File scripts/click-enter-wechat.ps1          # 点一次
#    pwsh -File scripts/click-enter-wechat.ps1 -Wait    # 最多等 60 秒，看到登录窗口就点
#
#  返回码：0 = 已经在微信里 / 点击成功；1 = 没找到登录窗口
param(
  [switch]$Wait,          # 是否轮询等待登录窗口出现
  [int]$ApiPort = 30001,
  [int]$MaxSeconds = 60
)

$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "  $m" }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WeChatClicker {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flag, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(220);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(90);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@ -ErrorAction Stop

function Get-Dbs {
  try {
    $d = (Invoke-WebRequest "http://127.0.0.1:$ApiPort/QueryDB/debug" -Method Get -TimeoutSec 8).Content | ConvertFrom-Json
    return @($d.dbs).Count
  } catch { return 0 }
}

function Try-ClickEnter {
  $procs = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return $false }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($p in $procs) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    foreach ($win in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      $cls = $win.Current.ClassName
      if ($cls -notmatch 'LoginWindow|WeChatMainWnd|mmui') { continue }
      # 提到前台（否则点不到）
      try { [void][WeChatClicker]::ShowWindow([IntPtr]$win.Current.NativeWindowHandle, 9) } catch { }
      try { [void][WeChatClicker]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) } catch { }
      Start-Sleep -Milliseconds 500
      $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      foreach ($b in $btns) {
        if ($b.Current.Name -match '进入微信') {
          $r = $b.Current.BoundingRectangle
          if ($r.Width -lt 10 -or $r.Height -lt 5) { continue }
          $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
          Say "找到「进入微信」按钮 ($cx,$cy)，点击中…"
          [WeChatClicker]::ClickAt($cx, $cy)
          return $true
        }
      }
    }
  }
  return $false
}

# 已经在微信里了就不用点
$dbs = Get-Dbs
if ($dbs -gt 5) { Say "已经在微信里了（dbs=$dbs），不需要点"; exit 0 }

Say "当前在登录页（dbs=$dbs），尝试点「进入微信」…"
$deadline = (Get-Date).AddSeconds($MaxSeconds)
$tries = 0
while ($true) {
  $tries++
  if (Try-ClickEnter) {
    # 点完等它进（最多 30 秒）
    for ($i = 1; $i -le 10; $i++) {
      Start-Sleep -Seconds 3
      $dbs = Get-Dbs
      if ($dbs -gt 5) { Say "✓ 进入微信成功（dbs=$dbs）"; exit 0 }
    }
    Say "⚠️ 点了但 dbs 还没上来（可能还在加载）"
    exit 0
  }
  if (-not $Wait -or (Get-Date) -gt $deadline) {
    Say "✗ 没找到「进入微信」按钮（窗口可能还没出来，或已经在加载中）"
    exit 1
  }
  if ($tries % 6 -eq 0) { Say "…还在等登录窗口（已等 $($tries * 5) 秒）" }
  Start-Sleep -Seconds 5
}
