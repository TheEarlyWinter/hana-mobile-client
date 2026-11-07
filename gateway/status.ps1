# ---------------------------------------------------------------------
# 网关状态快照（只读）：模式、监听地址、PID、手机该填的地址。
#
# 进程身份只认 process-identity.ps1 的受控判定：
#   完整本仓库 gateway\supervise.cmd + 本项目 gateway\server.mjs + 父子/创建时间。
# 旧版守护允许缺 HANA_GW_PORT，但端口按实际 listener 显示，不推断成 24000。
# 不读取/打印原始 CommandLine；状态以实际监听为准。
#
# 用法：pwsh -File gateway\status.ps1 [-Port 24000] [-Mode usb|lan|tunnel|tailscale]
#   -Mode 只覆盖显示模式；不自动迁移、不重启、不修改任何配置。
#
# 本脚本不启动/停止任何进程，不写文件，不改环境变量。
# ---------------------------------------------------------------------

param(
  [string]$Mode = '',
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-identity.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$remoteJson = Join-Path $PSScriptRoot 'remote.json'
$validModes = @('usb', 'lan', 'tunnel', 'tailscale')
$logPath = Join-Path $env:TEMP 'hana-gateway.log'

function Fail([string]$message) {
  [Console]::Error.WriteLine("[hana-gateway] $message")
  exit 1
}

if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) {
  Fail "端口非法：$Port"
}

$modeOverride = ''
if ("$Mode".Trim()) {
  $modeOverride = "$Mode".Trim().ToLowerInvariant()
  if ($validModes -notcontains $modeOverride) {
    Fail "模式非法：'$Mode'。可选值：$($validModes -join ' / ')；不写 -Mode 则按实际守护识别"
  }
}

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

function Get-LanIPv4 {
  $candidates = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.AddressState -eq 'Preferred' -and
      $_.IPAddress -ne '0.0.0.0' -and
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*'
    })
  if ($candidates.Count -eq 0) { return $null }

  $defaultRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object -Property RouteMetric | Select-Object -First 1)
  $defaultIndex = -1
  if ($defaultRoutes.Count -gt 0) { $defaultIndex = $defaultRoutes[0].InterfaceIndex }

  $scored = foreach ($candidate in $candidates) {
    $score = 0
    if ($candidate.IPAddress -like '192.168.*' -or
        $candidate.IPAddress -like '10.*' -or
        $candidate.IPAddress -match '^172\.(1[6-9]|2\d|3[01])\.') { $score += 4 }
    if ($defaultIndex -ge 0 -and $candidate.InterfaceIndex -eq $defaultIndex) { $score += 2 }
    if ("$($candidate.InterfaceAlias)" -notmatch 'vEthernet|Loopback|Tailscale|WSL|Hyper-V|VirtualBox|VMware|Bluetooth') { $score += 1 }
    [pscustomobject]@{ IPAddress = $candidate.IPAddress; Score = $score }
  }

  return ($scored |
    Sort-Object -Property @{ Expression = 'Score'; Descending = $true }, @{ Expression = 'IPAddress'; Descending = $false } |
    Select-Object -First 1).IPAddress
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

function Get-ListenRows([int]$TargetPort) {
  @(Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction SilentlyContinue)
}

function Get-NodeListenRows([int]$NodePid) {
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { [int]$_.OwningProcess -eq $NodePid })
}

# ---- 精确采集本项目守护和 node ----
$cmdProcesses = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue)
$supervisors = @(Get-GatewaySupervisorProcesses -Processes $cmdProcesses -RepoRoot $repoRoot)
$supervisor = if ($supervisors.Count -gt 0) { $supervisors[0] } else { $null }
$supervisorInfo = if ($supervisor) {
  Get-GatewaySupervisorCommand -CommandLine ([string]$supervisor.CommandLine) -RepoRoot $repoRoot
} else { $null }

$targetPort = if ($Port -gt 0) {
  $Port
} elseif ($supervisorInfo -and $supervisorInfo.PortSpecified) {
  $supervisorInfo.Port
} elseif ($supervisorInfo) {
  0
} else {
  24000
}
$legacyPortUnknown = [bool]($supervisorInfo -and -not $supervisorInfo.PortSpecified)

$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$node = if ($supervisor) {
  Get-GatewayNodeForSupervisor -Processes $nodeProcesses -Supervisor $supervisor -RepoRoot $repoRoot
} else { $null }

$gatewayRows = if ($targetPort -gt 0) {
  @(Get-ListenRows $targetPort)
} elseif ($node) {
  @(Get-NodeListenRows ([int]$node.ProcessId))
} else {
  @()
}
$gatewayUp = if ($targetPort -gt 0) {
  Test-TcpListening $targetPort
} else {
  $gatewayRows.Count -gt 0
}
$projectRow = if ($node) {
  Get-GatewayProjectListener -Listeners $gatewayRows -NodePid ([int]$node.ProcessId)
} else { $null }
$gatewayRow = $projectRow
if (-not $gatewayRow -and $gatewayRows.Count -gt 0) {
  $gatewayRow = $gatewayRows | Where-Object { $_.LocalAddress -notmatch ':' } | Select-Object -First 1
  if (-not $gatewayRow) { $gatewayRow = $gatewayRows[0] }
}
$ownedListenerPort = if ($projectRow) { [int]$projectRow.LocalPort } else { 0 }
$ownedListener = if ($projectRow -and $ownedListenerPort -gt 0) {
  Get-GatewayOwnedListener -Listeners @($projectRow) -NodePid ([int]$node.ProcessId) -ExpectedAddress ([string]$projectRow.LocalAddress) -Port $ownedListenerPort
} else { $null }

$detectedMode = if ($supervisorInfo) { $supervisorInfo.Mode } else { '' }
$effectiveMode = if ($modeOverride) { $modeOverride } elseif ($detectedMode) { $detectedMode } else { '' }
$scheme = if ($supervisorInfo -and ($supervisorInfo.TlsConfigured -or $supervisorInfo.ExternalHttps)) { 'https' } else { 'http' }

$upstreamHost = if ($supervisorInfo) { $supervisorInfo.UpstreamHost } else { '127.0.0.1' }
$upstreamPort = if ($supervisorInfo) { $supervisorInfo.UpstreamPort } else { 23917 }
$upstreamRows = @(Get-ListenRows $upstreamPort)
$upstreamUp = Test-TcpListening $upstreamPort

# ---- 输出 ----
'网关状态'
if ($supervisor) {
  $legacyLabel = if ($legacyPortUnknown) { '，旧版启动行未显式端口' } else { '' }
  "  守护进程   : PID $($supervisor.ProcessId)（本项目 supervise$legacyLabel）"
} else {
  '  守护进程   : 没有本项目 supervise 进程'
}

if ($modeOverride) {
  if ($detectedMode -and $detectedMode -ne $modeOverride) {
    "  模式       : $modeOverride（-Mode 指定；实际识别为 $detectedMode）"
  } else {
    "  模式       : $modeOverride（-Mode 指定）"
  }
} elseif ($detectedMode) {
  "  模式       : $detectedMode"
} else {
  '  模式       : 未知（未发现本项目守护）'
}

if ($gatewayRow) {
  if ($projectRow -and $ownedListener) {
    "  监听地址   : $($gatewayRow.LocalAddress):$($gatewayRow.LocalPort)（本项目 node PID $($node.ProcessId)）"
  } else {
    "  监听地址   : $($gatewayRow.LocalAddress):$($gatewayRow.LocalPort)（PID $($gatewayRow.OwningProcess) 占用，未确认是本项目 node）"
  }
} elseif ($legacyPortUnknown) {
  '  监听地址   : 旧守护未显式 HANA_GW_PORT；未发现本项目 node 的监听'
} elseif ($gatewayUp) {
  "  监听地址   : 端口 $targetPort 有人在听，但拿不到绑定地址"
} else {
  "  监听地址   : 端口 $targetPort 未监听"
}

if ($upstreamUp) {
  if ($upstreamRows.Count -gt 0) {
    $upstreamRow = $upstreamRows | Where-Object { $_.LocalAddress -notmatch ':' } | Select-Object -First 1
    if (-not $upstreamRow) { $upstreamRow = $upstreamRows[0] }
    "  上游服务器 : $($upstreamRow.LocalAddress):$($upstreamRow.LocalPort) 在监听（PID $($upstreamRow.OwningProcess)）"
  } else {
    "  上游服务器 : ${upstreamHost}:$upstreamPort 在监听"
  }
} else {
  "  上游服务器 : ${upstreamHost}:$upstreamPort 未监听（网关会回 502）"
}

$phoneLines = New-Object System.Collections.Generic.List[string]
$notes = New-Object System.Collections.Generic.List[string]

if ($projectRow) {
  $actualHost = "$($projectRow.LocalAddress)"
  $actualPort = [int]$projectRow.LocalPort
  $phoneHost = $actualHost

  if ($actualHost -eq '0.0.0.0' -or $actualHost -eq '::') {
    $lanIp = Get-LanIPv4
    if ($lanIp) { $phoneHost = $lanIp } else { $phoneHost = '<本机局域网 IP>' }
  } elseif ($phoneHost -match ':') {
    $phoneHost = "[$phoneHost]"
  }

  if ($effectiveMode -eq 'tunnel') {
    if (Test-Path -LiteralPath $remoteJson) {
      try {
        $cfg = Get-Content -LiteralPath $remoteJson -Raw -Encoding utf8 | ConvertFrom-Json
        $publicBaseUrl = "$($cfg.publicBaseUrl)".Trim()
        if ($publicBaseUrl) {
          $phoneLines.Add($publicBaseUrl)
        } else {
          $phoneLines.Add('（remote.json 里没有 publicBaseUrl；公网入口用隧道工具显示的域名）')
        }
      } catch {
        $phoneLines.Add('（gateway\remote.json 不是合法 JSON，无法读取公网地址）')
      }
    } else {
      $phoneLines.Add('（没有 gateway\remote.json；公网入口用隧道工具显示的域名）')
    }
    $phoneLines.Add("（本机实际监听 ${actualHost}:${actualPort}；隧道应转发到这里）")
  } elseif ($effectiveMode -eq 'usb') {
    $phoneLines.Add("${scheme}://${phoneHost}:$actualPort/")
    $phoneLines.Add("（手机上打开需要先 adb reverse tcp:$actualPort tcp:$actualPort；否则这个地址只在电脑本机有效）")
  } elseif ($effectiveMode -eq 'lan') {
    $phoneLines.Add("${scheme}://${phoneHost}:$actualPort/")
    $phoneLines.Add('（手机和电脑要在同一个网段；网关绑 0.0.0.0 时换网卡后实际 IP 会变）')
  } elseif ($effectiveMode -eq 'tailscale') {
    $phoneLines.Add("${scheme}://${phoneHost}:$actualPort/")
    $currentTs = Get-TailscaleIPv4
    if (-not $currentTs) {
      $notes.Add('当前拿不到 Tailscale IPv4；手机地址按实际监听地址显示，请确认 tailscale 状态。')
    } elseif ($actualHost -eq '0.0.0.0' -or $actualHost -eq '::') {
      $notes.Add('监听地址是通配地址，无法确认 Tailscale 入口；请按 tailscale 模式手动重启后再用。')
    } elseif ($currentTs -ne $actualHost) {
      $notes.Add("当前 Tailscale IP $currentTs 与实际监听 $actualHost 不一致；如需迁移，请手动 gateway\stop.ps1 后按 tailscale 模式重启，本脚本不自动迁移。")
    }
  } else {
    $phoneLines.Add("${scheme}://${phoneHost}:$actualPort/")
    $notes.Add('没有识别到本项目模式；上面的地址直接按实际监听生成，仅供参考。')
  }

  if (-not $ownedListener) {
    $notes.Add("端口 $actualPort 的监听者未确认是本项目 node；手机地址不应作为本项目入口使用。")
  }
  if ($legacyPortUnknown) {
    $notes.Add("旧守护未显式 HANA_GW_PORT；手机端口 $actualPort 取自实际监听。")
  }
} elseif ($gatewayRow) {
  $phoneLines.Add("（端口 $($gatewayRow.LocalPort) 被 PID $($gatewayRow.OwningProcess) 占用，未确认是本项目 node；不把它当本项目入口）")
  $notes.Add("端口 $($gatewayRow.LocalPort) 的监听者不是已验证的本项目 node；只告警，不生成入口地址。")
} elseif ($supervisorInfo) {
  $expectedHost = $supervisorInfo.Host
  if ($effectiveMode -eq 'tunnel' -and (Test-Path -LiteralPath $remoteJson)) {
    try {
      $cfg = Get-Content -LiteralPath $remoteJson -Raw -Encoding utf8 | ConvertFrom-Json
      $publicBaseUrl = "$($cfg.publicBaseUrl)".Trim()
      if ($publicBaseUrl) { $phoneLines.Add($publicBaseUrl) }
    } catch {}
  }
  if ($phoneLines.Count -eq 0) {
    if ($legacyPortUnknown) {
      $phoneLines.Add('（旧守护未显式 HANA_GW_PORT；未发现本项目 node 的监听，无法给出手机地址）')
    } else {
      $phoneLines.Add("（端口 $targetPort 未监听；$effectiveMode 模式期望 ${scheme}://${expectedHost}:$targetPort/）")
    }
  }
} else {
  $phoneLines.Add("（网关未启动；端口 $targetPort 没有本项目监听）")
}

$first = $true
foreach ($line in $phoneLines) {
  if ($first) {
    "  手机填写   : $line"
    $first = $false
  } else {
    "               $line"
  }
}
foreach ($note in $notes) { "  提示       : $note" }

"  日志       : $logPath（控制台流，只剩启动与崩溃）"
$structuredLog = Join-Path $PSScriptRoot 'logs'
"  结构化日志 : $structuredLog（pwsh -File scripts\gateway-log.ps1 -Tail 30）"
