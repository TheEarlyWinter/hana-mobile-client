# ---------------------------------------------------------------------
# 网关进程身份纯判定。
#
# 只接受 start.ps1 生成的受控 cmd 启动行：
#   cmd.exe /d /c set "...=..." && ... && call "<本仓库>\gateway\supervise.cmd"
# 额外兼容旧版 start 的受控行：完整 supervise 路径 + set 语法 + MODE/HOST，
# 唯一缺失 HANA_GW_PORT 时仍标记 owned，但 PortSpecified=false、Port=null，
# 绝不把未知端口推断成 24000。新生成仍由 New-GatewaySupervisorCommandLine 强制端口。
# node 必须是本项目 gateway\server.mjs，且父进程是本仓库的 supervise cmd。
#
# 本文件只定义函数，不查询 WMI/端口、不启停进程、不读 HANA_HOME 或任何配置。
# 输出对象不包含原始 CommandLine；调用方可安全打印身份字段。
# ---------------------------------------------------------------------

$script:GatewayAllowedEnvNames = @(
  'HANA_GW_MODE',
  'HANA_GW_HOST',
  'HANA_GW_PORT',
  'HANA_GW_ALLOW_INSECURE_LAN',
  'HANA_GW_EXTERNAL_HTTPS',
  'HANA_GW_ALLOWED_ORIGINS',
  'HANA_GW_TLS_CERT_FILE',
  'HANA_GW_TLS_KEY_FILE',
  'HANA_HOME',
  'HANA_UPSTREAM_HOST',
  'HANA_UPSTREAM_PORT'
)

$script:GatewayValidModes = @('usb', 'lan', 'tunnel', 'tailscale')

function ConvertTo-GatewayPath {
  param([string]$Path, [string]$BasePath = '')

  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $value = $Path.Trim()
  if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  try {
    if (-not [IO.Path]::IsPathRooted($value) -and $BasePath) {
      $value = [IO.Path]::Combine($BasePath, $value)
    }
    return [IO.Path]::GetFullPath($value)
  } catch {
    return $null
  }
}

function Test-GatewayPathEqual {
  param([string]$Left, [string]$Right)

  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    # 发现其它进程时不能借用检查者的工作目录；普通相对路径和 C:foo 都拒绝。
    if (-not [IO.Path]::IsPathFullyQualified($Left) -or -not [IO.Path]::IsPathFullyQualified($Right)) { return $false }
    $leftPath = [IO.Path]::GetFullPath($Left)
    $rightPath = [IO.Path]::GetFullPath($Right)
    return [string]::Equals($leftPath, $rightPath, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-GatewayProcessCreationDate {
  param($Value)

  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
  if ($null -eq $Value) { return $null }

  try {
    $parsed = [DateTime]::MinValue
    $ok = [DateTime]::TryParse(
      [string]$Value,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsed
    )
    if ($ok) { return $parsed.ToUniversalTime() }
  } catch {
    return $null
  }
  return $null
}

function Get-GatewaySupervisorCommand {
  param([string]$CommandLine, [string]$RepoRoot)

  $result = [pscustomobject]@{
    IsOwned = $false
    Mode = $null
    SupervisePath = $null
    Host = $null
    PortSpecified = $false
    Port = $null
    EnvPairs = [ordered]@{}
    TlsConfigured = $false
    ExternalHttps = $false
    AllowedOrigins = $null
    UpstreamHost = '127.0.0.1'
    UpstreamPort = 23917
  }
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
    return $result
  }

  $line = $CommandLine.Trim()
  $prefix = [regex]::Match($line, '^(?i)(?:"[^"]*cmd\.exe"|[A-Za-z]:\\[^\s]*cmd\.exe|cmd(?:\.exe)?)\s+/d\s+/c\s+(.+)$')
  if (-not $prefix.Success) { return $result }
  $body = $prefix.Groups[1].Value

  $call = [regex]::Match($body, '(?i)(?:^|&&)\s*call\s+"([^"]+)"\s*$')
  if (-not $call.Success) { return $result }

  $callPath = $call.Groups[1].Value
  $expectedPath = Join-Path $RepoRoot 'gateway\supervise.cmd'
  if (-not (Test-GatewayPathEqual $callPath $expectedPath)) { return $result }

  $before = $body.Substring(0, $call.Index).Trim()
  if ([string]::IsNullOrWhiteSpace($before)) { return $result }

  $values = @{}
  $segments = [regex]::Split($before, '\s*&&\s*')
  foreach ($segment in $segments) {
    if ([string]::IsNullOrWhiteSpace($segment)) { return $result }
    $set = [regex]::Match($segment, '^(?i)set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"$')
    if (-not $set.Success) { return $result }

    $name = $set.Groups[1].Value.ToUpperInvariant()
    $value = $set.Groups[2].Value
    if ($script:GatewayAllowedEnvNames -notcontains $name) { return $result }
    if ($value -match '[&|<>^"%\r\n]') { return $result }
    if ($values.ContainsKey($name)) { return $result }
    $values[$name] = $value
  }

  if (-not $values.ContainsKey('HANA_GW_MODE')) { return $result }
  if (-not $values.ContainsKey('HANA_GW_HOST') -or [string]::IsNullOrWhiteSpace($values['HANA_GW_HOST'])) { return $result }

  $hostAddress = [System.Net.IPAddress]::None
  if (-not [System.Net.IPAddress]::TryParse($values['HANA_GW_HOST'], [ref]$hostAddress)) { return $result }

  $mode = $values['HANA_GW_MODE'].Trim().ToLowerInvariant()
  if ($script:GatewayValidModes -notcontains $mode) { return $result }

  $portSpecified = $values.ContainsKey('HANA_GW_PORT')
  $port = $null
  if ($portSpecified) {
    $port = 0
    if (-not [int]::TryParse($values['HANA_GW_PORT'], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
      return $result
    }
  }

  $external = $values['HANA_GW_EXTERNAL_HTTPS']
  if ($external -and $external -ne '0' -and $external -ne '1') { return $result }
  $insecure = $values['HANA_GW_ALLOW_INSECURE_LAN']
  if ($insecure -and $insecure -ne '0' -and $insecure -ne '1') { return $result }

  $cert = $values['HANA_GW_TLS_CERT_FILE']
  $key = $values['HANA_GW_TLS_KEY_FILE']
  $hasCert = -not [string]::IsNullOrWhiteSpace($cert)
  $hasKey = -not [string]::IsNullOrWhiteSpace($key)
  if ($hasCert -ne $hasKey) { return $result }

  $result.IsOwned = $true
  $result.Mode = $mode
  $result.SupervisePath = $callPath
  $result.Host = $values['HANA_GW_HOST']
  $result.PortSpecified = $portSpecified
  $result.Port = $port
  $managedEnv = [ordered]@{}
  foreach ($name in $script:GatewayAllowedEnvNames) {
    $managedEnv[$name] = if ($values.ContainsKey($name)) { $values[$name] } else { '' }
  }
  $result.EnvPairs = $managedEnv
  $result.TlsConfigured = ($hasCert -and $hasKey)
  $result.ExternalHttps = ($external -eq '1')
  $result.UpstreamHost = if ([string]::IsNullOrWhiteSpace($values['HANA_UPSTREAM_HOST'])) {
    '127.0.0.1'
  } else {
    $values['HANA_UPSTREAM_HOST']
  }
  $upstreamPort = 23917
  if (-not [string]::IsNullOrWhiteSpace($values['HANA_UPSTREAM_PORT'])) {
    if (-not [int]::TryParse($values['HANA_UPSTREAM_PORT'], [ref]$upstreamPort) -or $upstreamPort -lt 1 -or $upstreamPort -gt 65535) {
      $result.IsOwned = $false
      return $result
    }
  }
  $result.UpstreamPort = $upstreamPort
  $result.AllowedOrigins = if ([string]::IsNullOrWhiteSpace($values['HANA_GW_ALLOWED_ORIGINS'])) {
    $null
  } else {
    $values['HANA_GW_ALLOWED_ORIGINS']
  }
  return $result
}

function Get-GatewayNodeCommand {
  param([string]$CommandLine, [string]$RepoRoot)

  $result = [pscustomobject]@{ IsOwned = $false; EntryPath = $null; IsAbsolute = $false }
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
    return $result
  }

  $line = $CommandLine.Trim()
  $parsed = [regex]::Match($line, '^(?:"([^"]+)"|(\S+))\s+(.+)$')
  if (-not $parsed.Success) { return $result }

  $exe = if ($parsed.Groups[1].Success) { $parsed.Groups[1].Value } else { $parsed.Groups[2].Value }
  $exeName = [IO.Path]::GetFileName($exe)
  if ($exeName -notmatch '^(?i:node(?:\.exe)?)$') { return $result }

  $argsText = $parsed.Groups[3].Value.Trim()
  $entry = $null
  if ($argsText -match '^"([^"]+)"$') {
    $entry = $Matches[1]
  } elseif ($argsText -notmatch '\s') {
    $entry = $argsText
  } else {
    return $result
  }
  if ([string]::IsNullOrWhiteSpace($entry)) { return $result }

  $expected = Join-Path $RepoRoot 'gateway\server.mjs'
  $isAbsolute = [IO.Path]::IsPathRooted($entry)
  if ($isAbsolute) {
    if (-not (Test-GatewayPathEqual $entry $expected)) { return $result }
    $entryPath = [IO.Path]::GetFullPath($entry)
  } else {
    $relative = $entry.Replace('/', '\')
    if ($relative -notmatch '^(?i:\.?\\)?gateway\\server\.mjs$') { return $result }
    $entryPath = ConvertTo-GatewayPath $entry $RepoRoot
    if (-not $entryPath -or -not (Test-GatewayPathEqual $entryPath $expected)) { return $result }
  }

  $result.IsOwned = $true
  $result.EntryPath = $entryPath
  $result.IsAbsolute = $isAbsolute
  return $result
}

function Test-GatewaySupervisorProcess {
  param($Process, [string]$RepoRoot)

  if ($null -eq $Process -or [string]::IsNullOrWhiteSpace($RepoRoot)) { return $false }
  $name = ([string]$Process.Name).Trim().ToLowerInvariant()
  if ($name -ne 'cmd.exe' -and $name -ne 'cmd') { return $false }
  if ([int]$Process.ProcessId -le 0) { return $false }
  if ($null -eq (Get-GatewayProcessCreationDate $Process.CreationDate)) { return $false }

  return (Get-GatewaySupervisorCommand -CommandLine ([string]$Process.CommandLine) -RepoRoot $RepoRoot).IsOwned
}

function Test-GatewayNodeProcess {
  param($Process, $Supervisor, [string]$RepoRoot)

  if ($null -eq $Process -or $null -eq $Supervisor -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
    return $false
  }
  if (-not (Test-GatewaySupervisorProcess -Process $Supervisor -RepoRoot $RepoRoot)) { return $false }

  $name = ([string]$Process.Name).Trim().ToLowerInvariant()
  if ($name -ne 'node.exe' -and $name -ne 'node') { return $false }
  if ([int]$Process.ProcessId -le 0) { return $false }
  if ([int]$Process.ParentProcessId -ne [int]$Supervisor.ProcessId) { return $false }

  $nodeCreated = Get-GatewayProcessCreationDate $Process.CreationDate
  $supervisorCreated = Get-GatewayProcessCreationDate $Supervisor.CreationDate
  if ($null -eq $nodeCreated -or $null -eq $supervisorCreated) { return $false }
  if ($nodeCreated -lt $supervisorCreated) { return $false }

  return (Get-GatewayNodeCommand -CommandLine ([string]$Process.CommandLine) -RepoRoot $RepoRoot).IsOwned
}

function Test-GatewayAddressMatch {
  param([string]$ActualAddress, [string]$ExpectedAddress)

  $actual = ([string]$ActualAddress).Trim()
  $expected = ([string]$ExpectedAddress).Trim()
  if (-not $actual -or -not $expected) { return $false }

  if ($expected -eq '0.0.0.0') { return $actual -eq '0.0.0.0' -or $actual -eq '::' }
  if ($expected -eq '::') { return $actual -eq '::' -or $actual -eq '0.0.0.0' }
  return [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)
}

function Get-GatewayOwnedListener {
  param($Listeners, [int]$NodePid, [string]$ExpectedAddress, [int]$Port)

  foreach ($listener in @($Listeners)) {
    if ($null -eq $listener) { continue }
    if ([int]$listener.OwningProcess -ne $NodePid) { continue }
    if ([int]$listener.LocalPort -ne $Port) { continue }
    if (-not (Test-GatewayAddressMatch -ActualAddress $listener.LocalAddress -ExpectedAddress $ExpectedAddress)) { continue }
    return $listener
  }
  return $null
}

function Test-GatewaySameProcessSnapshot {
  param($Process, $Snapshot)

  if ($null -eq $Process -or $null -eq $Snapshot) { return $false }
  if ([int]$Process.ProcessId -le 0) { return $false }
  if ([int]$Process.ProcessId -ne [int]$Snapshot.ProcessId) { return $false }

  $currentCreated = Get-GatewayProcessCreationDate $Process.CreationDate
  $snapshotCreated = Get-GatewayProcessCreationDate $Snapshot.CreationDate
  if ($null -eq $currentCreated -or $null -eq $snapshotCreated) { return $false }
  return [DateTime]::Equals($currentCreated, $snapshotCreated)
}

function Test-GatewaySupervisorConfig {
  param($SupervisorInfo, [System.Collections.IDictionary]$DesiredEnvPairs)

  if ($null -eq $SupervisorInfo -or -not $SupervisorInfo.IsOwned -or -not $SupervisorInfo.PortSpecified) { return $false }
  if ($null -eq $DesiredEnvPairs) { return $false }

  foreach ($name in $script:GatewayAllowedEnvNames) {
    $existingValue = ''
    if ($null -ne $SupervisorInfo.EnvPairs -and $SupervisorInfo.EnvPairs.Contains($name)) {
      $existingValue = [string]$SupervisorInfo.EnvPairs[$name]
    }
    $desiredValue = ''
    if ($DesiredEnvPairs.Contains($name)) {
      $desiredValue = [string]$DesiredEnvPairs[$name]
    }
    if (-not [string]::Equals($existingValue, $desiredValue, [StringComparison]::Ordinal)) {
      return $false
    }
  }
  return $true
}

function Get-GatewayProjectListener {
  param($Listeners, [int]$NodePid)

  if ($NodePid -le 0) { return $null }
  $owned = @($Listeners | Where-Object {
    $_ -and [int]$_.OwningProcess -eq $NodePid
  })
  if ($owned.Count -eq 0) { return $null }

  $ipv4 = $owned | Where-Object { "$($_.LocalAddress)" -notmatch ':' } | Select-Object -First 1
  if ($ipv4) { return $ipv4 }
  return $owned[0]
}

function Get-GatewaySupervisorProcesses {
  param($Processes, [string]$RepoRoot)

  return @($Processes | Where-Object {
    $_ -and (Test-GatewaySupervisorProcess -Process $_ -RepoRoot $RepoRoot)
  })
}

function Get-GatewayNodeForSupervisor {
  param($Processes, $Supervisor, [string]$RepoRoot)

  $nodes = @($Processes | Where-Object {
    $_ -and (Test-GatewayNodeProcess -Process $_ -Supervisor $Supervisor -RepoRoot $RepoRoot)
  })
  if ($nodes.Count -eq 0) { return $null }
  return $nodes[0]
}

function New-GatewaySupervisorCommandLine {
  param([string]$SupervisePath, [System.Collections.IDictionary]$EnvPairs)

  $path = ConvertTo-GatewayPath $SupervisePath
  if (-not $path) { throw 'supervise.cmd 路径无效' }
  if ([IO.Path]::GetFileName($path) -ne 'supervise.cmd') { throw 'supervise.cmd 路径无效' }
  if ($path -match '[&|<>^"%\r\n]') { throw 'supervise.cmd 路径含 cmd 元字符' }

  $normalized = [ordered]@{}
  foreach ($key in $EnvPairs.Keys) {
    $name = [string]$key
    $upper = $name.ToUpperInvariant()
    if ($script:GatewayAllowedEnvNames -notcontains $upper) { throw "不允许传递环境变量 $name" }
    if ($normalized.Contains($upper)) { throw "重复环境变量 $name" }
    $value = [string]$EnvPairs[$key]
    if ($value -match '[&|<>^"%\r\n]') { throw "环境变量 $name 含 cmd 元字符" }
    $normalized[$upper] = $value
  }

  foreach ($required in @('HANA_GW_MODE', 'HANA_GW_HOST', 'HANA_GW_PORT')) {
    if (-not $normalized.Contains($required) -or [string]::IsNullOrWhiteSpace($normalized[$required])) {
      throw "缺少环境变量 $required"
    }
  }
  if ($script:GatewayValidModes -notcontains $normalized['HANA_GW_MODE'].Trim().ToLowerInvariant()) {
    throw 'HANA_GW_MODE 非法'
  }
  $hostAddress = [System.Net.IPAddress]::None
  if (-not [System.Net.IPAddress]::TryParse($normalized['HANA_GW_HOST'], [ref]$hostAddress)) {
    throw 'HANA_GW_HOST 必须是 IP 地址'
  }
  $port = 0
  if (-not [int]::TryParse($normalized['HANA_GW_PORT'], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'HANA_GW_PORT 非法'
  }
  $cert = $normalized['HANA_GW_TLS_CERT_FILE']
  $key = $normalized['HANA_GW_TLS_KEY_FILE']
  if (([string]::IsNullOrWhiteSpace($cert)) -ne ([string]::IsNullOrWhiteSpace($key))) {
    throw 'TLS 证书和私钥必须同时配置'
  }
  foreach ($flagName in @('HANA_GW_ALLOW_INSECURE_LAN', 'HANA_GW_EXTERNAL_HTTPS')) {
    $flagValue = $normalized[$flagName]
    if ($flagValue -and $flagValue -ne '0' -and $flagValue -ne '1') {
      throw "$flagName 只允许 0/1/空"
    }
  }
  if ($normalized['HANA_UPSTREAM_PORT']) {
    $upstreamPort = 0
    if (-not [int]::TryParse($normalized['HANA_UPSTREAM_PORT'], [ref]$upstreamPort) -or $upstreamPort -lt 1 -or $upstreamPort -gt 65535) {
      throw 'HANA_UPSTREAM_PORT 必须是 1-65535'
    }
  }

  $segments = @()
  foreach ($name in $normalized.Keys) {
    $segments += "set `"$name=$($normalized[$name])`""
  }
  return "cmd.exe /d /c $($segments -join ' && ') && call `"$path`""
}
