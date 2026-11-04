# 点微信登录窗口的「进入微信」（需要 UTF-8 BOM，PowerShell 5.1）
param([int]$MaxSeconds = 40)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WxClick2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$deadline = (Get-Date).AddSeconds($MaxSeconds)
$clicked = $false
while ((Get-Date) -lt $deadline -and -not $clicked) {
  $btn = $null; $hwnd = [IntPtr]0
  foreach ($p in @(Get-Process -Name Weixin -ErrorAction SilentlyContinue)) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      if ($w.Current.ClassName -match 'LoginWindow') {
        $hwnd = [IntPtr]$w.Current.NativeWindowHandle
        $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)) {
          if ($b.Current.Name -eq "进入微信") { $btn = $b; break }
        }
      }
      if ($btn) { break }
    }
    if ($btn) { break }
  }
  if ($btn) {
    if ($hwnd -ne [IntPtr]0) { [WxClick2]::ShowWindow($hwnd, 9) | Out-Null; [WxClick2]::SetForegroundWindow($hwnd) | Out-Null; Start-Sleep -Milliseconds 600 }
    $r = $btn.Current.BoundingRectangle
    $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
    Write-Output ("CLICK " + $cx + "," + $cy)
    [WxClick2]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 200
    [WxClick2]::mouse_event(2, 0, 0, 0, [UIntPtr]0)
    Start-Sleep -Milliseconds 100
    [WxClick2]::mouse_event(4, 0, 0, 0, [UIntPtr]0)
    Start-Sleep -Seconds 8
    $clicked = $true
  } else {
    Start-Sleep -Seconds 2
  }
}
Write-Output ("clicked=" + $clicked)
