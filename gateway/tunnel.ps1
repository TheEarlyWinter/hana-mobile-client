# ---------------------------------------------------------------------
# 公网入口的反向隧道守护（PC 侧）
#
# 链路：公网 -> Cloudflare -> VPS 上的 cloudflared -> VPS 127.0.0.1:24001
#       -> 本脚本建立的 SSH 反向隧道 -> 本机 127.0.0.1:24000（自制网关）
#
# 为什么绑 127.0.0.1:24001 而不是 0.0.0.0：sshd 默认 GatewayPorts no，只能绑回环；
# 正好 cloudflared 就在 VPS 本机，走回环即可，不必为了开 0.0.0.0 去改 sshd 配置。
#
# 配置放在仓库外：%USERPROFILE%\.hana-mobile\tunnel.json
#   { "vpsHost": "...", "vpsPort": 22, "vpsUser": "root", "keyPath": "C:\\...\\id_ed25519",
#     "remotePort": 24001, "localPort": 24000 }
# 仓库里不留真实主机名/IP；缺字段时用命令行参数补。
#
# 断线后 5 秒重连。日志：%TEMP%\hana-tunnel.log
# 用法：pwsh -File gateway\tunnel.ps1              # 前台（调试）
#       pwsh -File gateway\tunnel.ps1 -Detach      # 后台 + 隐藏窗口（日常）
# ---------------------------------------------------------------------

param(
  [switch]$Detach,
  # 只校验配置并打印将要写入的 run.cmd；不建目录、不写文件、不起进程
  [switch]$CheckOnly,
  [string]$Config = (Join-Path $env:USERPROFILE '.hana-mobile\tunnel.json'),
  [string]$VpsHost = '',
  [int]$VpsPort = 0,
  [string]$VpsUser = '',
  [string]$KeyPath = '',
  [int]$RemotePort = 0,
  [int]$LocalPort = 24000,
  [int]$RetrySeconds = 5
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'hana-tunnel.log'

# 命令行参数优先：只有没显式绑定的字段才从配置文件补；cfg 也没有的字段沿用 param 里的默认值。
# 这样显式写了非法值会走到后面的白名单校验并报错，而不是被一个合法的 cfg 悄悄盖成合法值。
if (Test-Path -LiteralPath $Config) {
  try {
    $cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($cfg.vpsHost -and -not $PSBoundParameters.ContainsKey('VpsHost')) { $VpsHost = [string]$cfg.vpsHost }
    if ($cfg.vpsPort -and -not $PSBoundParameters.ContainsKey('VpsPort')) { $VpsPort = [int]$cfg.vpsPort }
    if ($cfg.vpsUser -and -not $PSBoundParameters.ContainsKey('VpsUser')) { $VpsUser = [string]$cfg.vpsUser }
    if ($cfg.keyPath -and -not $PSBoundParameters.ContainsKey('KeyPath')) { $KeyPath = [string]$cfg.keyPath }
    if ($cfg.remotePort -and -not $PSBoundParameters.ContainsKey('RemotePort')) { $RemotePort = [int]$cfg.remotePort }
    if ($cfg.localPort -and -not $PSBoundParameters.ContainsKey('LocalPort')) { $LocalPort = [int]$cfg.localPort }
  } catch {
    throw "配置文件解析失败：$Config（$($_.Exception.Message)）"
  }
}

if (-not $VpsHost) { throw "缺少 vpsHost：在 $Config 里配，或用 -VpsHost 传入" }
if ($VpsPort -le 0) { $VpsPort = 22 }
if (-not $VpsUser) { $VpsUser = 'root' }
if ($RemotePort -le 0) { throw "缺少 remotePort（VPS 上给 cloudflared 用的本地端口）" }
if (-not $KeyPath) { $KeyPath = Join-Path $env:USERPROFILE '.ssh\hana_tunnel' }

# ---------------------------------------------------------------------
# 这些值会被拼进 run.cmd（cmd 会解释 & | < > ^ " % 和换行），先按白名单卡死。
# 不做转义、不猜：一行配错就变成另一条命令，宁可拒绝启动。
# ---------------------------------------------------------------------
$hostPattern = '^[A-Za-z0-9.\-:\[\]]+$'
$userPattern = '^[A-Za-z0-9._\-]+$'
$cmdMetaPattern = '[&|<>^"%\r\n]'

if ($VpsHost -notmatch $hostPattern) {
  throw "vpsHost 含非法字符：'$VpsHost'（只允许 A-Z a-z 0-9 . - : [ ]）"
}
if ($VpsUser -notmatch $userPattern) {
  throw "vpsUser 含非法字符：'$VpsUser'（只允许 A-Z a-z 0-9 . _ -）"
}
if ($KeyPath -match $cmdMetaPattern) {
  throw "keyPath 含 cmd 元字符（& | < > ^ "" % 或换行），拒绝拼进 run.cmd：$KeyPath"
}
if (-not [System.IO.Path]::IsPathRooted($KeyPath)) {
  throw "keyPath 必须是绝对路径：$KeyPath"
}
foreach ($pair in @(@('vpsPort', $VpsPort), @('remotePort', $RemotePort), @('localPort', $LocalPort))) {
  $name = $pair[0]
  $value = [int]$pair[1]
  if ($value -lt 1 -or $value -gt 65535) { throw "$name 必须是 1-65535：$value" }
}
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "找不到私钥：$KeyPath" }

$ssh = (Get-Command ssh -ErrorAction SilentlyContinue)?.Source
if (-not $ssh) { throw '找不到 ssh.exe' }

$runDir = Join-Path $env:TEMP 'hana-tunnel'
$runCmd = Join-Path $runDir 'run.cmd'
$sshExe = $ssh

# run.cmd 的内容只在这里生成一份：-CheckOnly 打印的和真正写入的必须一模一样。
# 路径和 user@host 一律加引号：空格不会把参数拆开，白名单之外也不会多出命令。
function New-RunCmdBody {
  @"
@echo off
chcp 65001 >nul
set "LOGFILE=%TEMP%\hana-tunnel.log"
:loop
echo [tunnel] %date% %time% starting ssh>>"%LOGFILE%"
"$sshExe" -i "$KeyPath" -p $VpsPort -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -R 127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort} "${VpsUser}@${VpsHost}" 2>>"%LOGFILE%"
echo [tunnel] %date% %time% ssh exited, restart in ${RetrySeconds}s>>"%LOGFILE%"
timeout /t ${RetrySeconds} /nobreak >nul
goto loop
"@
}

if ($CheckOnly) {
  "校验通过：$VpsUser@$VpsHost`:$VpsPort  -R 127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}"
  "将要写入 $runCmd 的内容："
  New-RunCmdBody
  exit 0
}

if ($Detach) {
  # 真正占资源的是 ssh 那条反向转发；重复的守护会互抢同一个远端端口
  $tunnelSsh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -like "*-R 127.0.0.1:${RemotePort}:*" }
  if ($tunnelSsh) {
    "隧道已在运行（ssh PID $($tunnelSsh.ProcessId -join ', ')）"
    exit 0
  }

  # 用 cmd 循环（与网关的 supervise.cmd 同一套机制，已证明能长期存活）：
  # 直接把参数写进临时 .cmd，避免嵌套引号和 WMI 不继承环境变量的坑。
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  # 正文用 UTF-8 无 BOM 落盘：私钥路径/用户名可能含中文或空格，ascii 会把它们写成 '?'。
  # 不能带 BOM（cmd 会把 BOM 当第一行的一部分）；前两行保持纯 ASCII，第 2 行 chcp 65001 之后
  # 的正文才会按 UTF-8 解析。
  Set-Content -LiteralPath $runCmd -Value (New-RunCmdBody) -Encoding utf8NoBOM

  $create = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "cmd.exe /c `"$runCmd`""
  }
  if ($create.ReturnValue -ne 0) { throw "后台进程启动失败（WMI 返回 $($create.ReturnValue)）" }
  Start-Sleep -Milliseconds 1500

  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TunnelWindowHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction SilentlyContinue
  # 只隐藏本次 WMI 创建的那个进程（$create.ProcessId）。绝不按进程名扫描：
  # 那会把用户自己开着的 pwsh/终端窗口一并藏掉，而被创建的 cmd 窗口反而留在桌面上。
  $created = Get-Process -Id $create.ProcessId -ErrorAction SilentlyContinue
  if ($created -and $created.MainWindowHandle -ne 0) {
    [TunnelWindowHide]::ShowWindow($created.MainWindowHandle, 0) | Out-Null
  }

  Start-Sleep -Seconds 4
  $connected = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -like "*-R 127.0.0.1:${RemotePort}:*" }
  if ($connected) { "隧道守护已在后台启动（ssh PID $($connected.ProcessId -join ', ')），日志：$logPath" }
  else { "隧道守护已启动，但没看到 ssh 进程，看日志：$logPath" }
  exit 0
}

function Write-TunnelLog([string]$text) {
  $line = "[tunnel] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

Write-TunnelLog "start: $VpsUser@$VpsHost`:$VpsPort  -R 127.0.0.1:${RemotePort} -> 127.0.0.1:${LocalPort}"

while ($true) {
  $sshArgs = @(
    '-i', $KeyPath,
    '-p', "$VpsPort",
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-N',
    '-R', "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}",
    "$VpsUser@$VpsHost"
  )
  $started = Get-Date
  & $ssh @sshArgs 2>&1 | ForEach-Object { Write-TunnelLog "ssh: $_" }
  $ran = [int]((Get-Date) - $started).TotalSeconds
  Write-TunnelLog "ssh exited after ${ran}s, retry in ${RetrySeconds}s"
  Start-Sleep -Seconds $RetrySeconds
}
