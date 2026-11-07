# ---------------------------------------------------------------------
# 启动网关守护（无可见窗口），按接入方式决定监听地址。
#
# 受控启动链：
#   WMI -> cmd.exe /d /c set "...=..." && ... && call "<本仓库>\gateway\supervise.cmd"
# WMI 子进程不继承本进程环境变量，所以受管变量必须显式放进 set 链。
# 身份判定在 gateway\process-identity.ps1：只认完整 supervise.cmd 路径和本项目 node。
#
# 模式：
#   usb        127.0.0.1 监听，手机走 adb reverse 或电脑本机浏览器（默认）
#   lan        0.0.0.0 + HANA_GW_ALLOW_INSECURE_LAN=1，同网段手机直连（明文，有风险）
#   tunnel     127.0.0.1 监听，公网 TLS 由隧道终止；可选 remote.json 的 allowedOrigins
#   tailscale  绑 `tailscale ip -4` 的地址 + 允许明文
#
# 用法：pwsh -File gateway\start.ps1 [-Mode usb|lan|tunnel|tailscale] [-Port 24000] [-RemoteJson <路径>] [-CheckOnly]
#   -CheckOnly 只校验参数与配置并打印将要注入的环境变量，不碰 WMI/端口/进程。
# ---------------------------------------------------------------------

param(
  [string]$Mode = 'usb',
  [int]$Port = 24000,
  [string]$RemoteJson = '',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-identity.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$supervise = Join-Path $PSScriptRoot 'supervise.cmd'
$remoteJson = if ($RemoteJson) { $RemoteJson } else { Join-Path $PSScriptRoot 'remote.json' }
$gwPort = $Port
$validModes = @('usb', 'lan', 'tunnel', 'tailscale')

function Fail([string]$message) {
  [Console]::Error.WriteLine("[hana-gateway] $message")
  exit 1
}

if ($gwPort -lt 1 -or $gwPort -gt 65535) { Fail "端口非法：$gwPort" }
$modeKey = "$Mode".Trim().ToLowerInvariant()
if ($validModes -notcontains $modeKey) {
  Fail "模式非法：'$Mode'。可选值：$($validModes -join ' / ')"
}
if (-not (Test-Path -LiteralPath $supervise)) { Fail "找不到 $supervise" }

# 只读：Tailscale 的 IPv4；命令不存在/未登录/输出为空都返回 $null。
function Get-TailscaleIPv4 {
  if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { return $null }
  $lines = @(& tailscale ip -4 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  foreach ($line in $lines) {
    $text = "$line".Trim()
    $parsed = [System.Net.IPAddress]::None
    if ($text -and [System.Net.IPAddress]::TryParse($text, [ref]$parsed) -and $parsed.AddressFamily -eq 'InterNetwork') {
      return $text
    }
  }
  return $null
}

function Resolve-NodeExe {
  $pinned = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path -LiteralPath $pinned) { return $pinned }
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

# 直接调 security-policy.mjs 的校验 CLI，避免 PS 与 JS 的 Origin 规则漂移。
function Get-ValidatedAllowedOrigins([string[]]$origins) {
  if (-not $origins -or $origins.Count -eq 0) { return '' }
  $node = Resolve-NodeExe
  if (-not $node) { Fail '找不到 node.exe，无法校验 remote.json 的 allowedOrigins（网关本身也需要 node）' }
  $policy = Join-Path $PSScriptRoot 'security-policy.mjs'
  if (-not (Test-Path -LiteralPath $policy)) { Fail "找不到 $policy" }
  $payload = ($origins -join "`n")
  $output = $payload | & $node $policy --check-origins 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $detail = (($output | ForEach-Object { "$_" }) -join ' ').Trim()
    Fail "remote.json 的 allowedOrigins 有非法项：$detail`n每一项只许写一个 Origin（scheme://host[:port]），不能含逗号、路径、查询串、片段或空白。"
  }
  return ((($output | ForEach-Object { "$_" }) -join '').Trim())
}

function Test-TcpListening([int]$TargetPort) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $TargetPort)
    if ($task.Wait(400) -and $client.Connected) { return $true }
    return $false
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-GatewayListeners([int]$TargetPort) {
  @(Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction SilentlyContinue)
}

# ---- TLS：只接受调用者显式设置的两个文件；只传递路径，不读取内容 ----
$tlsCert = if ($null -ne $env:HANA_GW_TLS_CERT_FILE) { "$env:HANA_GW_TLS_CERT_FILE".Trim() } else { '' }
$tlsKey = if ($null -ne $env:HANA_GW_TLS_KEY_FILE) { "$env:HANA_GW_TLS_KEY_FILE".Trim() } else { '' }
if ([bool]$tlsCert -ne [bool]$tlsKey) {
  Fail 'HANA_GW_TLS_CERT_FILE 和 HANA_GW_TLS_KEY_FILE 必须同时设置或同时留空'
}
$tlsConfigured = [bool]$tlsCert
if ($tlsConfigured) {
  if (-not (Test-Path -LiteralPath $tlsCert)) { Fail 'HANA_GW_TLS_CERT_FILE 指向的证书文件不存在' }
  if (-not (Test-Path -LiteralPath $tlsKey)) { Fail 'HANA_GW_TLS_KEY_FILE 指向的私钥文件不存在' }
}
$scheme = if ($tlsConfigured) { 'https' } else { 'http' }

# ---- 受管环境变量：不清空调用者的其它环境，只显式覆盖本脚本负责的变量 ----
$envPairs = [ordered]@{
  HANA_GW_MODE = $modeKey
  HANA_GW_PORT = "$gwPort"
  HANA_GW_HOST = ''
  HANA_GW_ALLOW_INSECURE_LAN = ''
  HANA_GW_EXTERNAL_HTTPS = ''
  HANA_GW_ALLOWED_ORIGINS = ''
  HANA_GW_TLS_CERT_FILE = if ($tlsConfigured) { $tlsCert } else { '' }
  HANA_GW_TLS_KEY_FILE = if ($tlsConfigured) { $tlsKey } else { '' }
  HANA_HOME = if ($env:HANA_HOME) { "$env:HANA_HOME".Trim() } else { '' }
  HANA_UPSTREAM_HOST = if ($env:HANA_UPSTREAM_HOST) { "$env:HANA_UPSTREAM_HOST".Trim() } else { '' }
  HANA_UPSTREAM_PORT = if ($env:HANA_UPSTREAM_PORT) { "$env:HANA_UPSTREAM_PORT".Trim() } else { '' }
}

# 上游端口只做白名单校验，不在输出中展开非必要配置。
if ($envPairs['HANA_UPSTREAM_PORT']) {
  $upstreamPort = 0
  if (-not [int]::TryParse($envPairs['HANA_UPSTREAM_PORT'], [ref]$upstreamPort) -or $upstreamPort -lt 1 -or $upstreamPort -gt 65535) {
    Fail 'HANA_UPSTREAM_PORT 必须是 1-65535'
  }
}

$notes = New-Object System.Collections.Generic.List[string]
$listenHost = ''
$phoneHint = ''

switch ($modeKey) {
  'usb' {
    $listenHost = '127.0.0.1'
    $envPairs['HANA_GW_HOST'] = $listenHost
    $phoneHint = "${scheme}://127.0.0.1:$gwPort/"
    $notes.Add("手机要访问得先做端口映射：adb reverse tcp:$gwPort tcp:$gwPort")
  }

  'lan' {
    $listenHost = '0.0.0.0'
    $envPairs['HANA_GW_HOST'] = $listenHost
    $envPairs['HANA_GW_ALLOW_INSECURE_LAN'] = '1'
    $phoneHint = "${scheme}://<本机局域网 IP>:$gwPort/（具体 IP 用 gateway\status.ps1 查）"
    if ($tlsConfigured) {
      $notes.Add('已按显式 TLS 配置启用 HTTPS；手机地址使用 https。')
    } else {
      $notes.Add("明文风险：网关绑定 0.0.0.0 且没有启用 TLS，同网段任何人都能连上并嗅探流量，只在可信网络里临时用。")
    }
  }

  'tunnel' {
    $listenHost = '127.0.0.1'
    $envPairs['HANA_GW_HOST'] = $listenHost
    # 公网 TLS 在网关外终止：显式告诉网关外部已是 https，让 Set-Cookie 补 Secure。
    $envPairs['HANA_GW_EXTERNAL_HTTPS'] = '1'
    if (Test-Path -LiteralPath $remoteJson) {
      try {
        $cfg = Get-Content -LiteralPath $remoteJson -Raw -Encoding utf8 | ConvertFrom-Json
      } catch {
        Fail "gateway\remote.json 不是合法 JSON，先修好它（字段参考 remote.json.example）：$($_.Exception.Message)"
      }
      $origins = @()
      if ($null -ne $cfg.allowedOrigins) {
        $origins = @($cfg.allowedOrigins | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
      }
      $validatedOrigins = Get-ValidatedAllowedOrigins $origins
      if ($validatedOrigins) {
        $envPairs['HANA_GW_ALLOWED_ORIGINS'] = $validatedOrigins
      } else {
        $notes.Add('remote.json 里没有 allowedOrigins：公网页面发起的写请求会被同源校验拒绝。')
      }
      $publicBaseUrl = "$($cfg.publicBaseUrl)".Trim()
      if ($publicBaseUrl) {
        $phoneHint = $publicBaseUrl
      } else {
        $phoneHint = '（remote.json 里没写 publicBaseUrl，运行 gateway\status.ps1 看当前值）'
      }
    } else {
      $phoneHint = '（没有 remote.json，不知道公网地址；用隧道工具显示的那个域名）'
      $notes.Add("没找到 gateway\remote.json：本次不注入 HANA_GW_ALLOWED_ORIGINS，也不会自动创建；需要的话复制 remote.json.example 改成自己的隧道域名。")
    }
    $notes.Add("隧道要转发到本机 127.0.0.1:$gwPort；如果隧道改写了 Host，公网页面的写请求会被判成跨源，必须把隧道域名写进 remote.json 的 allowedOrigins。")
  }

  'tailscale' {
    if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
      Fail '找不到 tailscale 命令，无法用 tailscale 模式启动；先安装 Tailscale 再执行 tailscale up（不会自动退回其他模式）。'
    }
    $tsIp = Get-TailscaleIPv4
    if (-not $tsIp) {
      Fail 'Tailscale 未登录，先执行 tailscale up（或 tailscale ip -4 没返回 IPv4，确认状态是 Running）；不会自动退回其他模式。'
    }
    $listenHost = $tsIp
    $envPairs['HANA_GW_HOST'] = $tsIp
    $envPairs['HANA_GW_ALLOW_INSECURE_LAN'] = '1'
    $phoneHint = "${scheme}://${tsIp}:$gwPort/"
    if ($tlsConfigured) {
      $notes.Add('已按显式 TLS 配置启用 HTTPS；手机地址使用 https。')
    } else {
      $notes.Add("明文风险：绑定 Tailscale 地址且没有启用 TLS，tailnet 内其他设备能连上；只允许自己的设备加入该 tailnet。")
    }
  }
}

# 值里含 cmd 元字符时拒绝，避免拼错一个 & 变成另一条命令；错误不展开变量值。
try {
  $commandLine = New-GatewaySupervisorCommandLine -SupervisePath $supervise -EnvPairs $envPairs
} catch {
  Fail "启动参数无法安全拼进 cmd：$($_.Exception.Message)"
}

"启动模式：$modeKey"
"监听地址：${listenHost}:$gwPort"
if ($modeKey -eq 'tunnel') {
  "本地协议：$scheme"
  '公网协议：https（隧道终止）'
} else {
  "协议：$scheme"
}
$sensitiveKeys = @('HANA_HOME', 'HANA_UPSTREAM_HOST', 'HANA_UPSTREAM_PORT', 'HANA_GW_TLS_CERT_FILE', 'HANA_GW_TLS_KEY_FILE')
foreach ($pair in $envPairs.GetEnumerator()) {
  if ($pair.Key -eq 'HANA_GW_MODE') { continue }
  if ([string]::IsNullOrWhiteSpace([string]$pair.Value)) { continue }
  if ($sensitiveKeys -contains $pair.Key) {
    "注入环境变量：$($pair.Key)=（已显式配置，值不打印）"
  } else {
    "注入环境变量：$($pair.Key)=$($pair.Value)"
  }
}
"手机该填的地址：$phoneHint"
foreach ($note in $notes) { "提示：$note" }

if ($CheckOnly) {
  "校验通过（-CheckOnly）：未检查端口、未调用 WMI、未启动守护。"
  exit 0
}

# ---- 精确识别本项目已有守护；别项目同名/echo 内容一律不算 ----
# 旧版受控行没有 HANA_GW_PORT：只能确认身份，不能假装端口一致；
# 识别到旧守护时直接要求先 stop 再 start。
$cmdProcesses = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue)
$existingSupervisors = @(Get-GatewaySupervisorProcesses -Processes $cmdProcesses -RepoRoot $repoRoot)
if ($existingSupervisors.Count -gt 0) {
  $supervisor = $existingSupervisors[0]
  $info = Get-GatewaySupervisorCommand -CommandLine ([string]$supervisor.CommandLine) -RepoRoot $repoRoot
  if ($info.Mode -ne $modeKey) {
    Fail "本项目守护已在运行（PID $($supervisor.ProcessId)，模式 $($info.Mode)），本次请求 $modeKey；先运行 gateway\stop.ps1 停止后再切换。"
  }
  if (-not $info.PortSpecified) {
    Fail "检测到旧版本项目守护（PID $($supervisor.ProcessId)，模式 $($info.Mode)）：启动行没有显式 HANA_GW_PORT，无法确认端口与本次请求一致。先运行 gateway\stop.ps1，再按当前参数执行 start.ps1。"
  }
  if (-not (Test-GatewaySupervisorConfig -SupervisorInfo $info -DesiredEnvPairs $envPairs)) {
    Fail "本项目守护已在运行（PID $($supervisor.ProcessId)），但受管配置（包括 HANA_HOME、上游、TLS 文件路径、allowedOrigins）与本次请求不同；先运行 gateway\stop.ps1 再重启。"
  }

  $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
  $node = Get-GatewayNodeForSupervisor -Processes $nodeProcesses -Supervisor $supervisor -RepoRoot $repoRoot
  $listeners = @(Get-GatewayListeners $gwPort)
  if ($listeners.Count -gt 0) {
    $owned = if ($node) {
      Get-GatewayOwnedListener -Listeners $listeners -NodePid ([int]$node.ProcessId) -ExpectedAddress $listenHost -Port $gwPort
    } else { $null }
    if (-not $owned) {
      $pids = ($listeners | ForEach-Object { "$($_.OwningProcess)" } | Sort-Object -Unique) -join ', '
      Fail "本项目守护存在，但端口 $gwPort 被 PID $pids 占用且不是本项目 node；拒绝启动第二个，也不会停止占用者。"
    }
    "网关已就绪：$($owned.LocalAddress):$($owned.LocalPort)（PID $($owned.OwningProcess)）"
  } elseif ($node) {
    "网关守护已在运行（supervise PID $($supervisor.ProcessId)，node PID $($node.ProcessId)），端口尚未监听，可能正在重启。"
  } else {
    "网关守护已在运行（supervise PID $($supervisor.ProcessId)），node 尚未启动或正在重启。"
  }
  exit 0
}

$existingListeners = @(Get-GatewayListeners $gwPort)
if ($existingListeners.Count -gt 0 -or (Test-TcpListening $gwPort)) {
  $pids = ($existingListeners | ForEach-Object { "$($_.OwningProcess)" } | Sort-Object -Unique) -join ', '
  if (-not $pids) { $pids = '未知' }
  Fail "端口 $gwPort 已被 PID $pids 占用，且不是本项目守护；拒绝启动，也不会生成重试守护或停止占用者。"
}

# ---- WMI 起守护（set 链带环境变量，call 保住放到批处理） ----
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
  Fail "WMI 起守护进程失败：ReturnValue=$($created.ReturnValue)"
}

# 只隐藏本次创建的 PID；不扫描其它窗口。
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction SilentlyContinue
  $p = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    [WindowHide]::ShowWindow($p.MainWindowHandle, 0) | Out-Null
  }
} catch {}

$ready = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $current = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue)
  $supervisor = @($current | Where-Object { [int]$_.ProcessId -eq [int]$created.ProcessId })[0]
  if (-not $supervisor) { continue }
  if (-not (Test-GatewaySupervisorProcess -Process $supervisor -RepoRoot $repoRoot)) { continue }
  $info = Get-GatewaySupervisorCommand -CommandLine ([string]$supervisor.CommandLine) -RepoRoot $repoRoot
  if (-not $info.PortSpecified -or $info.Mode -ne $modeKey -or $info.Port -ne $gwPort) { continue }

  $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
  $node = Get-GatewayNodeForSupervisor -Processes $nodeProcesses -Supervisor $supervisor -RepoRoot $repoRoot
  if (-not $node) { continue }
  $listeners = @(Get-GatewayListeners $gwPort)
  $owned = Get-GatewayOwnedListener -Listeners $listeners -NodePid ([int]$node.ProcessId) -ExpectedAddress $listenHost -Port $gwPort
  if ($owned) {
    $ready = [pscustomobject]@{
      LocalAddress = $owned.LocalAddress
      LocalPort = $owned.LocalPort
      NodePid = $node.ProcessId
      SupervisorPid = $supervisor.ProcessId
    }
    break
  }
}

if (-not $ready) {
  "守护已创建（supervise PID $($created.ProcessId)），但 10 秒内未关联到本项目 node 和期望监听 $listenHost`:$gwPort。"
  "未自动停止或重试；启动/崩溃输出在 $env:TEMP\hana-gateway.log，请求与生命周期日志在 gateway\logs（pwsh -File scripts\gateway-log.ps1），状态用 gateway\status.ps1。"
  exit 1
}

"网关已就绪：$($ready.LocalAddress):$($ready.LocalPort)（node PID $($ready.NodePid)，supervise PID $($ready.SupervisorPid)）"
