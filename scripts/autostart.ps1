# ---------------------------------------------------------------------
# 网关开机自启：往「启动」文件夹放一个快捷方式。
#
# 为什么用启动文件夹而不是 schtasks：
#   本机沙盒策略禁止创建计划任务（schtasks 会被拒），而启动文件夹是普通用户目录，
#   写入不需要管理员权限，卸载就是删一个文件，可逆、可审计。
#
# 用法：
#   pwsh -File scripts\autostart.ps1 -Plan        # 只打印将要创建什么，不落盘
#   pwsh -File scripts\autostart.ps1 -Install     # 创建快捷方式（默认 lan 模式）
#   pwsh -File scripts\autostart.ps1 -Status      # 看是否已登记 + 网关现在是否在听
#   pwsh -File scripts\autostart.ps1 -Uninstall   # 删除快捷方式
#
# 参数：
#   -Mode usb|lan|tunnel|tailscale   传给 gateway\start.ps1，默认 lan
#   -Port 24000                      同上
#   -StartupDir <路径>               覆盖启动文件夹（测试用，也方便自定义）
#
# 输出约定：第一段是机器可读的 key=value（ASCII，测试与脚本靠它判断），
# 之后是给人看的中文说明。这样跨机器/跨控制台代码页都不会误判。
# 退出码：0 成功；1 参数/环境有问题。
# ---------------------------------------------------------------------

param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Plan,
  [string]$Mode = 'lan',
  [int]$Port = 24000,
  [string]$StartupDir = ''
)

$ErrorActionPreference = 'Stop'

# 控制台代码页在 CI 上可能是 GBK：不设 UTF-8 的话中文说明会变成问号。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $repoRoot 'gateway\start.ps1'
# 文件名保持 ASCII：中文文件名在部分环境（CI 的临时目录、非 UTF-8 代码页）会保存失败。
$shortcutName = 'Hana Mobile Gateway.lnk'
$validModes = @('usb', 'lan', 'tunnel', 'tailscale')

function Fail([string]$code, [string]$message) {
  [Console]::Error.WriteLine("error=$code")
  [Console]::Error.WriteLine("# $message")
  exit 1
}

function Resolve-StartupDir {
  if ($StartupDir) { return $StartupDir }
  if ($env:HANA_AUTOSTART_DIR) { return $env:HANA_AUTOSTART_DIR }
  return [Environment]::GetFolderPath('Startup')
}

# 用 pwsh 7 优先：gateway 下几个脚本是按 7.x 写的，Windows PowerShell 5.1 可能缺语法。
function Resolve-HostExe {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) { return $pwsh.Source }
  $ps = Get-Command powershell -ErrorAction SilentlyContinue
  if ($ps) { return $ps.Source }
  Fail 'no_powershell' '找不到 pwsh 或 powershell'
}

if ($validModes -notcontains $Mode) { Fail 'invalid_mode' "Mode 非法：$Mode（可选 $($validModes -join ' / ')）" }
if ($Port -lt 1 -or $Port -gt 65535) { Fail 'invalid_port' "Port 非法：$Port" }
if (-not (Test-Path -LiteralPath $startScript)) { Fail 'missing_start_script' "找不到启动脚本：$startScript" }

$dir = Resolve-StartupDir
if (-not $dir) { Fail 'no_startup_dir' '无法确定启动文件夹（可显式传 -StartupDir）' }
$shortcutPath = Join-Path $dir $shortcutName
$hostExe = Resolve-HostExe
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -Mode $Mode -Port $Port"

# 只选一个动作；不传时默认 -Status，避免手滑就装上去。
$actions = @()
foreach ($pair in @(@($Install, 'Install'), @($Uninstall, 'Uninstall'), @($Status, 'Status'), @($Plan, 'Plan'))) {
  if ($pair[0]) { $actions += $pair[1] }
}
if ($actions.Count -gt 1) { Fail 'multiple_actions' "一次只能做一个动作：$($actions -join ' / ')" }
$action = if ($actions.Count -eq 1) { $actions[0] } else { 'Status' }

function Test-GatewayListening {
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    return [bool]$conn
  } catch {
    return $false
  }
}

switch ($action) {
  'Plan' {
    Write-Output 'action=plan'
    Write-Output "startupDir=$dir"
    Write-Output "shortcut=$shortcutPath"
    Write-Output "target=$hostExe"
    Write-Output "arguments=$arguments"
    Write-Output "workdir=$repoRoot"
    Write-Output '# 以上只是计划，没有创建任何文件。'
    exit 0
  }
  'Status' {
    $exists = Test-Path -LiteralPath $shortcutPath
    $listening = Test-GatewayListening
    Write-Output 'action=status'
    Write-Output ('installed=' + $(if ($exists) { 'yes' } else { 'no' }))
    Write-Output "shortcut=$shortcutPath"
    Write-Output ('listening=' + $(if ($listening) { 'yes' } else { 'no' }))
    Write-Output "port=$Port"
    if ($exists) {
      Write-Output '# 已登记开机自启。'
    } else {
      Write-Output '# 尚未登记开机自启；现在能连说明网关是手动起的。'
    }
    exit 0
  }
  'Uninstall' {
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
      Write-Output 'action=uninstall'
      Write-Output 'result=absent'
      Write-Output "# 没有登记过，无需删除：$shortcutPath"
      exit 0
    }
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Output 'action=uninstall'
    Write-Output 'result=removed'
    Write-Output "# 已删除：$shortcutPath"
    exit 0
  }
  'Install' {
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $hostExe
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.WindowStyle = 7          # 7 = 最小化启动，别在开机时弹一个黑窗口
    $shortcut.Description = "Start Hana mobile gateway ($Mode mode, port $Port) at login"
    try {
      $shortcut.Save()
    } catch {
      Fail 'save_failed' "写快捷方式失败：$($_.Exception.Message)"
    }

    if (-not (Test-Path -LiteralPath $shortcutPath)) { Fail 'not_created' "写入后仍找不到快捷方式：$shortcutPath" }
    Write-Output 'action=install'
    Write-Output 'result=created'
    Write-Output "shortcut=$shortcutPath"
    Write-Output "# 已创建。下次登录会自动执行：$hostExe $arguments"
    Write-Output '# 提示：只想现在就用，直接跑 gateway\start.ps1 即可，不必重启。'
    exit 0
  }
}
