# 微信客户端电源控制：开关进程
# 用法：
#   wechat-power.ps1 -Action status
#   wechat-power.ps1 -Action kill
#   wechat-power.ps1 -Action start   [-ClientDir D:\wxhook\wx4110] [-ApiPort 30001] [-CbPort 18998]
#
# 输出：末行固定为 JSON: {...}（供 Node 侧 execFile 解析）
#
# 为什么单独写成脚本：
#   「进入微信」那一步必须用 UIA（UI Automation）去找 mmui::LoginWindow 里的
#   「进入微信」按钮并点击 —— 这是 .NET/Windows API，Node 侧无法直接调用。
#   实测（2026-10-22 23:2x）：UIA 的 Invoke 对 Qt 窗口**无效**（调用成功但没反应），
#   必须用坐标鼠标点击（BoundingRectangle 中心 + mouse_event）。
#   而键盘回车也不行（登录窗口焦点不在按钮上）。

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'kill', 'start')]
  [string]$Action,

  [string]$ClientDir = 'D:\wxhook\wx4110',
  [int]$ApiPort = 30001,
  [int]$CbPort = 18998,
  [int]$WaitSec = 60
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 桥用 execFile 抓 stdout，Node 按 UTF-8 解析 → 这里必须把输出编码也设成 UTF-8，
# 否则中文会变成乱码（实测："微信已经在运行" → "΢���Ѿ������У�"）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  Write-Output ("JSON: " + $json)
}

# taskkill 在"进程已经没了"时返回 exit 1 并往 stderr 写东西，
# 在 $ErrorActionPreference='Stop' 下会被当成异常把整个脚本打断（实测 23:33）。
# 统一走这个包一层，吞掉即可。
function Stop-WechatHard {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try { Stop-WechatHard } catch { }
  $ErrorActionPreference = $old
}

# ── 回车登录（2026-11-11 用户实测：坐标点击对这版客户端无效，按回车能进）──
#   两路都发：① PostMessage 给登录窗口（不抢焦点，窗口不在最前也能收）
#             ② SendKeys 兜底（有些 Qt 版本只认真实键盘输入）
function Send-EnterToLogin {
  param([IntPtr]$Hwnd)
  # ★ 2026-11-11 实测结论（三次试验）：
  #   · PostMessage(WM_KEYDOWN) → Qt 主循环**收不到**，进程数不变
  #   · 只发 KeyDown 不发 KeyUp → 无效
  #   · 【有效】ShowWindow 恢复 + SetForegroundWindow + keybd_event(0x0D down/up)
  #     + SendKeys 兜底 → 实测 1 个进程（登录页）→ 5 个进程（进主界面）
  if ($Hwnd -ne [IntPtr]0) {
    try { $w32::ShowWindow($Hwnd, 9) | Out-Null } catch { }
    try { $w32::SetForegroundWindow($Hwnd) | Out-Null } catch { }
    Start-Sleep -Milliseconds 500
    try {
      $zero = [System.UIntPtr]::Zero
      $w32::keybd_event(0x0D, 0, 0, $zero)     # VK_RETURN down
      Start-Sleep -Milliseconds 150
      $w32::keybd_event(0x0D, 0, 2, $zero)     # VK_RETURN up（KEYEVENTF_KEYUP）
    } catch { }
  }
  Start-Sleep -Milliseconds 400
  try {
    Add-Type -AssemblyName System.Windows.Forms -EA SilentlyContinue
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  } catch { }
}

function Get-WechatProcs {
  return @(Get-Process -Name Weixin -EA SilentlyContinue)
}

function Test-HookAlive {
  # ① 首选 hook 自己的 HTTP（有的版本 30001 可用）
  try {
    $r = Invoke-RestMethod ("http://127.0.0.1:" + $ApiPort + "/QueryDB/status") -Method Get -TimeoutSec 5 -EA Stop
    if ($r) { return @{ alive = $true; isLogin = [int]$r.IsLogin; via = 'hook-http' } }
  } catch { }
  # ② ★ 2026-11-24：这套环境 hook 只走文件队列，30001 恒为 000（实测），
  #    以前这里就判"没登录" → 一键启动永远认为 hook 挂了。
  #    改用**桥的轮询状态**作为证据：shard 解析成功 + 连续失败少 = hook 真的在供数据。
  foreach ($port in @(17300, 17301)) {
    try {
      $s = Invoke-RestMethod ("http://127.0.0.1:" + $port + "/api/pollStatus") -Method Get -TimeoutSec 5 -EA Stop
      if ($s -and $s.shard -and ([int]$s.consecFail -lt 3)) {
        return @{ alive = $true; isLogin = 1; via = ('bridge:' + $port) }
      }
    } catch { }
  }
  return @{ alive = $false; isLogin = 0; via = 'none' }
}

# ── status ────────────────────────────────────────────────────────────────
if ($Action -eq 'status') {
  $procs = Get-WechatProcs
  $hook = Test-HookAlive
  Out-Json @{
    ok      = $true
    action  = 'status'
    procs   = $procs.Count
    running = ($procs.Count -gt 0)
    hook    = $hook.alive
    isLogin = $hook.isLogin
  }
  exit 0
}

# ── kill ──────────────────────────────────────────────────────────────────
if ($Action -eq 'kill') {
  $before = (Get-WechatProcs).Count
  $method = ''

  # ── 直接 taskkill /F（实测唯一有效的方式）────────────────────────────
  #  ★ 2026-10-22 23:4x 实测：`CloseMainWindow()` **对微信是死锁的**。
  #    微信点右上角 × 只是最小化到托盘，Qt 不把 WM_CLOSE 当"退出"处理，
  #    这个调用会一直不返回 → 整个脚本卡住 → 桥的 execFile 60 秒超时 →
  #    用户看到「关不掉」。删掉温和关闭，直接强杀。
  #
  #  taskkill /F 实测：0.1 秒杀干净 5 个进程，观察 21 秒不会自己回来。
  #
  #  代价：强杀会让微信写一份 6MB 崩溃 dump（和真崩溃同名同大小）。
  #        这是**异常终止记录**，不是崩溃，看时间点能区分：
  #        由本脚本 kill 出来的 dump，紧邻着桥日志里的
  #        「检测到客户端已退出」且**之前没有**轮询失败/句柄错误。
  for ($round = 1; $round -le 3; $round++) {
    if ((Get-WechatProcs).Count -eq 0) { break }
    Stop-WechatHard
    $method = 'taskkill/F'
    $dl2 = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $dl2) {
      if ((Get-WechatProcs).Count -eq 0) { break }
      Start-Sleep -Milliseconds 400
    }
    if ((Get-WechatProcs).Count -eq 0) { break }
    Start-Sleep -Milliseconds 800
  }
  if ($method -eq '') { $method = 'already-stopped' }

  $after = (Get-WechatProcs).Count
  Out-Json @{
    ok      = ($after -eq 0)
    action  = 'kill'
    before  = $before
    method  = $method
    after   = $after
  }
  exit 0
}

# ── start ─────────────────────────────────────────────────────────────────
if ($Action -eq 'start') {
  $exe = Join-Path $ClientDir 'Weixin.exe'
  if (-not (Test-Path $exe)) {
    Out-Json @{ ok = $false; action = 'start'; error = ("找不到客户端：" + $exe) }
    exit 1
  }

  # 已经在跑就不重复拉起（避免多开）
  # ⚠️ 判断条件不能只看"有进程"：实测 kill 后 3 秒会冒出一个启动器进程（1 个），
  #    它停在登录窗口、没有主界面、hook 也没登录。这时如果直接返回 already，
  #    用户点了"打开"却什么也没发生。
  #    只有「进程数 >= 3」或「hook 活着且已登录」才算真的在运行。
  $procs0 = (Get-WechatProcs).Count
  if ($procs0 -gt 0) {
    $hook0 = Test-HookAlive
    $reallyRunning = ($procs0 -ge 3) -or ($hook0.alive -and $hook0.isLogin -eq 1)
    if ($reallyRunning) {
      Out-Json @{
        ok       = $true
        action   = 'start'
        already  = $true
        procs    = $procs0
        isLogin  = $hook0.isLogin
        message  = '微信已经在运行，未重复启动'
      }
      exit 0
    }
    # 只是残留的启动器/登录页 → 先清掉再重新启动
    Stop-WechatHard
    $dl0 = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $dl0) {
      if ((Get-WechatProcs).Count -eq 0) { break }
      Start-Sleep -Milliseconds 400
    }
    Stop-WechatHard
    Start-Sleep -Milliseconds 600
  }

  # 启动（带 hook 参数；这些参数决定 version.dll 的 hook 能收到消息）
  # ★ 2026-11-18 严重 bug 修复：这里原来叫 $args —— PowerShell 的**自动变量**，
  #   赋值会被吞掉，于是 Start-Process -ArgumentList $args 拿到空值 →
  #   客户端以「完全无参数」启动 → hook 收不到 StartPort/CallBackURL →
  #   读库全部失败（"消息库分片暂不可用 / 句柄还没挂载"）→ 机器人静默失聪。
  #   症状现场：Weixin.exe 命令行只有 exe 路径，后面什么都没有。
  $argList = @(
    'StartPort=' + $ApiPort,
    'RecvType=1',
    'CallBackURL=http://127.0.0.1:' + $CbPort      # 不带 /recv：桥只认根路径
  )
  Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $ClientDir | Out-Null

  # ── 等登录窗口 → 点「进入微信」 ──────────────────────────────────────
  $entered = $false
  $clicked = $false
  $note = ''
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -EA SilentlyContinue
    $sig = @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
'@
    $w32 = Add-Type -MemberDefinition $sig -Name WxPower -Namespace WxPow -PassThru -EA SilentlyContinue
    $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
    $deadline = (Get-Date).AddSeconds($WaitSec)

    while ((Get-Date) -lt $deadline) {
      $loginWin = $null
      $enterBtn = $null
      foreach ($proc in (Get-WechatProcs)) {
        try {
          $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
          foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
            if ($w.Current.ClassName -match 'LoginWindow') { $loginWin = $w; break }
          }
          if ($loginWin) {
            $btnCond = New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
              [System.Windows.Automation.ControlType]::Button)
            foreach ($b in $loginWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
              if ($b.Current.Name -eq '进入微信') { $enterBtn = $b; break }
            }
          }
        } catch { }
        if ($enterBtn) { break }
      }

      if ($enterBtn -ne $null) {
        # 1) 先把窗口提到前台（坐标点击要求窗口可见且在最前）
        $hwnd = [IntPtr]0
        foreach ($proc in (Get-WechatProcs)) {
          try {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
            foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
              if ($w.Current.ClassName -match 'LoginWindow') { $hwnd = [IntPtr]$w.Current.NativeWindowHandle; break }
            }
          } catch { }
          if ($hwnd -ne [IntPtr]0) { break }
        }
        if ($hwnd -ne [IntPtr]0) {
          try { $w32::ShowWindow($hwnd, 9) | Out-Null } catch { }   # SW_RESTORE
          try { $w32::SetForegroundWindow($hwnd) | Out-Null } catch { }
          Start-Sleep -Milliseconds 500
        }

        # 2) 坐标点击（UIA Invoke 对 Qt 窗口无效，实测）
        $rect = $enterBtn.Current.BoundingRectangle
        $cx = [int]($rect.X + $rect.Width / 2)
        $cy = [int]($rect.Y + $rect.Height / 2)
        try {
          $w32::SetCursorPos($cx, $cy) | Out-Null
          Start-Sleep -Milliseconds 150
          $w32::mouse_event(0x0002, 0, 0, 0, [IntPtr]0)   # LEFTDOWN
          Start-Sleep -Milliseconds 80
          $w32::mouse_event(0x0004, 0, 0, 0, [IntPtr]0)   # LEFTUP
          $clicked = $true
        } catch { }

        # 3) 验证：登录窗口消失 + 进程数增长
        Start-Sleep -Seconds 10
        $stillLogin = $false
        foreach ($proc in (Get-WechatProcs)) {
          try {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
            foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
              if ($w.Current.ClassName -match 'LoginWindow') { $stillLogin = $true; break }
            }
          } catch { }
          if ($stillLogin) { break }
        }
        $np = (Get-WechatProcs).Count
        if ((-not $stillLogin) -and $np -ge 3) { $entered = $true; break }

        # ★ 2026-11-11：点击没进去 → 补一次回车（用户实测有效）
        if ($stillLogin -and $hwnd -ne [IntPtr]0) {
          Send-EnterToLogin -Hwnd $hwnd
          $note = '点击无效 → 已按回车重试'
          Start-Sleep -Seconds 8
          $stillLogin2 = $false
          foreach ($proc in (Get-WechatProcs)) {
            try {
              $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
              foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
                if ($w.Current.ClassName -match 'LoginWindow') { $stillLogin2 = $true; break }
              }
            } catch { }
            if ($stillLogin2) { break }
          }
          $np2 = (Get-WechatProcs).Count
          # ★ 只认「进程数 >= 3」：UIA 找不到窗口不等于登录成功
          #   （之前用 -not $stillLogin2 判，窗口枚举抛异常时会误判成功）
          if ($np2 -ge 3) {
            $entered = $true
            $note = '回车登录成功'
            break
          }
        }
        $note = '点击/回车后仍在登录页，重试中'
        Start-Sleep -Seconds 3
      } else {
        # 没有登录窗口：可能已经进入主界面
        if ((Get-WechatProcs).Count -ge 3) { $entered = $true; break }
        Start-Sleep -Seconds 2
      }
    }
    # ★ 兜底：整轮结束还没进去（可能一直没找到「进入微信」按钮），再来一次回车
    if (-not $entered) {
      $hwnd2 = [IntPtr]0
      foreach ($proc in (Get-WechatProcs)) {
        try {
          $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
          foreach ($w in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
            if ($w.Current.ClassName -match 'LoginWindow') { $hwnd2 = [IntPtr]$w.Current.NativeWindowHandle; break }
          }
        } catch { }
        if ($hwnd2 -ne [IntPtr]0) { break }
      }
      if ($hwnd2 -ne [IntPtr]0) {
        Send-EnterToLogin -Hwnd $hwnd2
        Start-Sleep -Seconds 8
        if ((Get-WechatProcs).Count -ge 3) { $entered = $true; $note = '兜底回车后进程数已增长' }
      } else {
        $note = '没找到登录窗口（可能已经在主界面或界面类名变了）'
      }
    }
  } catch {
    $note = ('UIA 异常：' + $_.Exception.Message)
  }

  # ── 回车登录（独立脚本：实测 1 个进程 → 5 个进程，最多重试 5 次）──────
  if (-not $entered) {
    $enterScript = Join-Path $PSScriptRoot 'wechat-login-enter.ps1'
    if (Test-Path $enterScript) {
      try {
        $out2 = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $enterScript -WaitSec 60 -MaxTry 5 2>&1
        $line2 = ($out2 | Where-Object { $_ -match '^JSON:' } | Select-Object -Last 1)
        if ($line2) {
          $j2 = ($line2 -replace '^JSON:\s*', '') | ConvertFrom-Json
          if ($j2.ok) { $entered = $true; $note = ('回车登录成功（第 ' + $j2.tries + ' 次，进程 ' + $j2.procs + '）') }
          else { $note = ('回车登录未成功：' + $j2.note) }
        }
      } catch { $note = ('回车登录脚本异常：' + $_.Exception.Message) }
    }
  }

  # ── 等 hook 就绪 ────────────────────────────────────────────────────
  $hookOk = $false
  $isLogin = 0
  $deadline2 = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline2) {
    $h = Test-HookAlive
    if ($h.alive -and $h.isLogin -eq 1) { $hookOk = $true; $isLogin = 1; break }
    Start-Sleep -Seconds 2
  }

  Out-Json @{
    ok      = ($entered -and $hookOk)
    action  = 'start'
    procs   = (Get-WechatProcs).Count
    entered = $entered
    clicked = $clicked
    hook    = $hookOk
    isLogin = $isLogin
    note    = $note
  }
  exit 0
}
