# 点「进入微信」：不依赖窗口类名，直接对微信的可见窗口做 UIA 后代搜索
param([int]$MaxSeconds = 40)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxClick3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@

function Get-WeixinVisibleWindows {
  $list = New-Object System.Collections.ArrayList
  [WxClick3]::EnumWindows({
    param($h, $l)
    $procId = [uint32]0
    [WxClick3]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'Weixin' -and [WxClick3]::IsWindowVisible($h)) {
      $list.Add([IntPtr]$h) | Out-Null
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  return $list
}

$deadline = (Get-Date).AddSeconds($MaxSeconds)
$clicked = $false
while ((Get-Date) -lt $deadline -and -not $clicked) {
  $btn = $null
  foreach ($h in (Get-WeixinVisibleWindows)) {
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      foreach ($b in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)) {
        $nm = $b.Current.Name
        if ($nm -match "进入微信|进入") { $btn = $b; break }
      }
    } catch { }
    if ($btn) { break }
  }
  if ($btn) {
    try { [WxClick3]::ShowWindow([IntPtr]$btn.Current.NativeWindowHandle, 9) | Out-Null } catch { }
    $r = $btn.Current.BoundingRectangle
    $cx = [int]($r.X + $r.Width / 2)
    $cy = [int]($r.Y + $r.Height / 2)
    Write-Output ("BTN=" + $btn.Current.Name + " rect=" + $r + " click=" + $cx + "," + $cy)
    [WxClick3]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 250
    [WxClick3]::mouse_event(2, 0, 0, 0, [UIntPtr]0)
    Start-Sleep -Milliseconds 120
    [WxClick3]::mouse_event(4, 0, 0, 0, [UIntPtr]0)
    Start-Sleep -Seconds 8
    $clicked = $true
  } else {
    Start-Sleep -Seconds 2
  }
}
Write-Output ("clicked=" + $clicked)
