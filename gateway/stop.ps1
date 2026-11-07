# ---------------------------------------------------------------------
# 停止本项目网关守护：先本项目 supervise cmd，再本项目 node。
#
# 只使用 process-identity.ps1 的精确判定：
#   - 完整本仓库 gateway\supervise.cmd
#   - node 是本项目 gateway\server.mjs 且父进程是上述 supervise
# 旧版守护即使缺 HANA_GW_PORT 也可识别；停止不依赖端口。
# 不按命令行里的 supervise 字样泛匹配，不停止未知端口占用者。
#
# 用法：pwsh -File gateway\stop.ps1 [-WhatIf]
#   -WhatIf 只打印将要停止的 PID，不执行 Stop-Process。
# ---------------------------------------------------------------------

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [int]$Port = 24000
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-identity.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot

if ($Port -lt 1 -or $Port -gt 65535) {
  [Console]::Error.WriteLine("[hana-gateway] 端口非法：$Port")
  exit 1
}

$cmdProcesses = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue)
$supervisors = @(Get-GatewaySupervisorProcesses -Processes $cmdProcesses -RepoRoot $repoRoot)
if ($supervisors.Count -eq 0) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $pids = ($listeners | ForEach-Object { "$($_.OwningProcess)" } | Sort-Object -Unique) -join ', '
    "没有发现本项目 supervise；端口 $Port 被 PID $pids 占用，未停止（没有可确认的本项目守护）。"
  } else {
    "没有发现本项目 supervise；没有可停止的网关进程。"
  }
  exit 0
}

$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
foreach ($supervisor in $supervisors) {
  $info = Get-GatewaySupervisorCommand -CommandLine ([string]$supervisor.CommandLine) -RepoRoot $repoRoot
  $node = Get-GatewayNodeForSupervisor -Processes $nodeProcesses -Supervisor $supervisor -RepoRoot $repoRoot

  if ($PSCmdlet.ShouldProcess("本项目 supervise PID $($supervisor.ProcessId)（模式 $($info.Mode)）", '停止守护')) {
    $current = @(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$supervisor.ProcessId)" -ErrorAction SilentlyContinue)[0]
    if ($current -and (Test-GatewaySameProcessSnapshot -Process $current -Snapshot $supervisor) -and (Test-GatewaySupervisorProcess -Process $current -RepoRoot $repoRoot)) {
      Stop-Process -Id ([int]$current.ProcessId) -Force -ErrorAction Stop
    } else {
      "跳过 supervise PID $($supervisor.ProcessId)：停止前身份核验失败。"
    }
  }

  if ($node) {
    if ($PSCmdlet.ShouldProcess("本项目 node PID $($node.ProcessId)（$($node.EntryPath)）", '停止进程')) {
      $currentNode = @(Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$node.ProcessId)" -ErrorAction SilentlyContinue)[0]
      if ($currentNode -and (Test-GatewaySameProcessSnapshot -Process $currentNode -Snapshot $node) -and (Test-GatewayNodeProcess -Process $currentNode -Supervisor $supervisor -RepoRoot $repoRoot)) {
        Stop-Process -Id ([int]$currentNode.ProcessId) -Force -ErrorAction Stop
      } else {
        "跳过 node PID $($node.ProcessId)：停止前身份核验失败。"
      }
    }
  }
}
