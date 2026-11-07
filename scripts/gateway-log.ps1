#Requires -Version 7.0
<#
.SYNOPSIS
  查网关结构化日志（gateway/logs/*.jsonl）。

.DESCRIPTION
  给人和 agent 共用的读取入口：默认把最近 N 条格式化成一行一条，
  也可以 -Json 拿原始行自己处理。

  日志由 gateway/logger.mjs 写出，一行一个 JSON，按天分文件。
  这里只读，不改、不删、不锁文件。

.EXAMPLE
  pwsh -File scripts/gateway-log.ps1 -Tail 30

.EXAMPLE
  pwsh -File scripts/gateway-log.ps1 -Errors -SinceMinutes 30

.EXAMPLE
  pwsh -File scripts/gateway-log.ps1 -Kind http -Path '*sessions*' -Tail 20

.EXAMPLE
  pwsh -File scripts/gateway-log.ps1 -Json -Tail 5
#>
param(
  # 取最近多少条（过滤之后）
  [int]$Tail = 50,
  # 只看 error 级
  [switch]$Errors,
  # 只看某类：http / ws / lifecycle / all
  [ValidateSet('all', 'http', 'ws', 'lifecycle')]
  [string]$Kind = 'all',
  # 路径包含（支持 * 通配），例如 '*sessions*'
  [string]$Path,
  # 只保留最近多少分钟
  [int]$SinceMinutes = 0,
  # 只看某个时刻之后，格式 HH:mm 或 HH:mm:ss
  [string]$Since,
  # 输出原始 JSON 行（给程序消费）
  [switch]$Json,
  # 日志目录；默认 <仓库根>/gateway/logs
  [string]$Dir
)

$ErrorActionPreference = 'Stop'

function Resolve-LogDir {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit }
  $root = Split-Path -Parent $PSScriptRoot
  return (Join-Path $root 'gateway/logs')
}

$logDir = Resolve-LogDir -Explicit $Dir
if (-not (Test-Path -LiteralPath $logDir)) {
  Write-Output "no-logs dir=$logDir"
  Write-Output 'hint: 网关没写过日志，或 HANA_GATEWAY_LOG=off，或日志目录被 HANA_GATEWAY_LOG_DIR 改到了别处。'
  exit 0
}

# 文件名里的段号不带前导零，字符串排序会把 .10 排到 .2 前面，-Tail 就会取到旧段。
# 按（日期, 段号数值）排，无段号的 base 文件段号为 0。
$files = Get-ChildItem -LiteralPath $logDir -Filter 'gateway-*.jsonl' -File -ErrorAction SilentlyContinue |
  ForEach-Object {
    $m = [regex]::Match($_.Name, '^gateway-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$')
    [pscustomobject]@{
      File = $_
      Day = if ($m.Success) { $m.Groups[1].Value } else { '' }
      Index = if ($m.Success -and $m.Groups[2].Success) { [int]$m.Groups[2].Value } else { 0 }
    }
  } |
  Sort-Object Day, Index |
  ForEach-Object { $_.File }
if (-not $files) {
  Write-Output "no-logs dir=$logDir"
  exit 0
}

# 时间下界：-SinceMinutes 优先，其次 -Since（按今天的日期理解）
$now = Get-Date
$lower = $null
if ($SinceMinutes -gt 0) {
  $lower = $now.AddMinutes(-$SinceMinutes)
} elseif ($Since) {
  $parsed = [datetime]::MinValue
  $formats = @('HH:mm:ss', 'HH:mm')
  if ([datetime]::TryParseExact($Since, [string[]]$formats, $null, 'None', [ref]$parsed)) {
    $lower = $now.Date.Add($parsed.TimeOfDay)
    if ($lower -gt $now) { $lower = $lower.AddDays(-1) }
  } else {
    Write-Output "bad-since value=$Since expect=HH:mm[:ss]"
    exit 2
  }
}

$records = New-Object System.Collections.Generic.List[object]

foreach ($file in $files) {
  # 日志是追加写的，最后一行可能写到一半：解析失败就跳过，不当成错误
  foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
    if (-not $line) { continue }
    if ($line[0] -ne '{') { continue }
    try { $obj = $line | ConvertFrom-Json } catch { continue }
    if ($null -eq $obj) { continue }

    if ($Errors -and $obj.level -ne 'error') { continue }
    if ($Kind -ne 'all' -and $obj.kind -ne $Kind) { continue }
    if ($Path -and $obj.path -and -not ($obj.path -like $Path)) { continue }
    if ($Path -and -not $obj.path) { continue }

    $ts = $null
    if ($obj.ts) { $ts = [datetimeoffset]::Parse($obj.ts).LocalDateTime }
    if ($lower -and $ts -and $ts -lt $lower) { continue }

    $records.Add([pscustomobject]@{ Time = $ts; Raw = $line; Obj = $obj })
  }
}

$picked = if ($records.Count -gt $Tail) { $records.GetRange($records.Count - $Tail, $Tail) } else { $records }

if ($picked.Count -eq 0) {
  Write-Output 'no-match'
  exit 0
}

if ($Json) {
  foreach ($item in $picked) { Write-Output $item.Raw }
  exit 0
}

# 一行一条：时间 级别 类型 状态 耗时 方法/事件 路径 错误
foreach ($item in $picked) {
  $o = $item.Obj
  $time = if ($item.Time) { $item.Time.ToString('HH:mm:ss') } else { '--:--:--' }
  $level = if ($o.level) { $o.level.ToUpperInvariant() } else { 'INFO' }
  # 变量名不能叫 $kind：PowerShell 大小写不敏感，会撞上带 ValidateSet 的参数 $Kind
  $kindCol = if ($o.kind) { $o.kind.PadRight(9) } else { 'http     ' }

  $what = ''
  if ($o.kind -eq 'http') {
    $status = if ($null -ne $o.status) { $o.status } else { '-' }
    $ms = if ($null -ne $o.ms) { "$($o.ms)ms" } else { '-' }
    $what = "{0,-6} {1} {2,-9} {3} {4}" -f $o.method, $o.path, ("status=" + $status), $ms, ''
  } elseif ($o.kind -eq 'ws') {
    $ms = if ($null -ne $o.ms) { "$($o.ms)ms" } else { '-' }
    $what = "{0,-6} {1}" -f $o.event, $ms
  } else {
    $what = "{0} {1}" -f $o.event, $o.detail
  }

  $err = ''
  if ($o.errorCode -or $o.error) {
    $err = ' | ' + (@($o.errorCode, $o.error) | Where-Object { $_ }) -join ' '
  }

  $line = '{0} {1,-5} {2} {3}{4}' -f $time, $level, $kindCol, ($what -replace '\s+$', ''), $err
  Write-Output $line
}

Write-Output ("-- {0} 条（共匹配 {1} 条，目录 {2}）" -f $picked.Count, $records.Count, $logDir)
exit 0
