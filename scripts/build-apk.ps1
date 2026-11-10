# scripts/build-apk.ps1 —— 一条命令打 APK：前端 → android/build.ps1 → android/dist
#
# 为什么要有这个脚本：以前打一次包要在命令行上现敲版本号
#     pwsh -File android\build.ps1 -VersionName 0.9.10-share -VersionCode 13
# 版本号是手抄的，抄错就是一个装不上的包（versionCode 倒退）或者版本名和内容对不上的包。
# 现在版本只从 package.json 读（scripts/version.mjs），命令行里不再出现版本号。
#
# 实际构建仍然是 android/build.ps1：Android SDK 自带的 aapt2 / d8 / zipalign / apksigner
# 手搓，不依赖 Gradle。这个脚本只负责「拼版本名 → 跑前端 → 跑构建 → 核对产物」。
#
# 用法：
#     pwsh -File scripts\build-apk.ps1                  打 share 包（默认）
#     pwsh -File scripts\build-apk.ps1 -Mode debug      打 debuggable 包（开 WebView CDP，别外发）
#     pwsh -File scripts\build-apk.ps1 -Version 0.9.11  临时打另一个版本（只影响本次，不改文件）
#     pwsh -File scripts\build-apk.ps1 -SkipWeb         跳过前端构建
#     pwsh -File scripts\build-apk.ps1 -DryRun          只打印要执行的命令，不构建
#     pwsh -File scripts\build-apk.ps1 -Help
#
# 产物：android\dist\hana-mobile-<version>-<share|Debuggable>.apk
# 对外发版（验包 + 下载页 + latest.json）不在这里，走 scripts\release.ps1。

param(
  # share：日常给人装的包；debug：debuggable 包，壳里会开 WebView 调试端口（CDP）。
  [ValidateSet('share', 'debug')]
  [string]$Mode = 'share',
  # 不传就用 package.json 的 version。传了就只影响这一次，不改文件。
  [string]$Version = '',
  # 前端产物是网关运行时从 web\dist 取的，和 APK 本身无关；改的只是前端时可以跳过。
  [switch]$SkipWeb,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

$usage = @'
scripts\build-apk.ps1 —— 一条命令打 APK

  -Mode share|debug   默认 share。debug = debuggable 包（开 WebView 调试端口，别外发）。
  -Version X.Y.Z      临时指定版本，缺省读 package.json 的 version。
  -SkipWeb            跳过前端构建（node scripts\build-web.mjs）。
  -DryRun             只解析参数、打印要执行的命令，不构建。
  -Help               打印这段说明。

版本号只从 package.json 读（node scripts\version.mjs）；versionCode 按
major*10000 + minor*100 + patch 算。改版本：npm run version:set -- 0.9.11
产物：android\dist\hana-mobile-<version>-<share|Debuggable>.apk
'@

if ($Help) {
  Write-Host $usage
  exit 0
}

# ---------- 1. 解析版本（唯一的版本来源） ----------

$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) {
  throw "PATH 里找不到 node。打包要先跑 node scripts\build-web.mjs 和 scripts\version.mjs，请先装 Node.js。"
}
$node = $nodeCmd.Source

$versionScript = Join-Path $root 'scripts\version.mjs'
if (-not (Test-Path -LiteralPath $versionScript -PathType Leaf)) {
  throw "找不到版本脚本：$versionScript"
}

$versionArgs = @($versionScript, '--json')
if ($Version) { $versionArgs += @('--version', $Version) }

$global:LASTEXITCODE = 0
$versionJson = & $node @versionArgs
if ($LASTEXITCODE -ne 0) {
  throw "读版本号失败（node scripts\version.mjs 退出码 $LASTEXITCODE）。上面是 version.mjs 的报错。"
}
try {
  $info = (($versionJson | Out-String).Trim()) | ConvertFrom-Json
} catch {
  throw "scripts\version.mjs --json 的输出不是 JSON：$($versionJson | Out-String)"
}
if (-not $info.version -or -not $info.versionCode) {
  throw "scripts\version.mjs --json 没给出 version / versionCode：$($versionJson | Out-String)"
}

# 版本名带模式后缀：share / debug 是同一个版本的两种产物，不是两个版本，
# 所以后缀加在 APK 名字上，不写进 package.json。build.ps1 用 -VersionName 拼产物文件名。
$suffix = if ($Mode -eq 'debug') { '-Debuggable' } else { '-share' }
$fullVersion = "$($info.version)$suffix"
$apkName = "hana-mobile-$fullVersion.apk"
$distDir = Join-Path $root 'android\dist'
$apkPath = Join-Path $distDir $apkName
$buildScript = Join-Path $root 'android\build.ps1'
$webScript = Join-Path $root 'scripts\build-web.mjs'

if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
  throw "找不到 android 构建脚本：$buildScript"
}

# 签名 key 不在仓库里（.gitignore 里的 *.jks）。缺了 build.ps1 会生成一次性 key，
# 那个包装不到已有安装上（签名不同，覆盖安装会失败），所以要提前说清楚。
$keyStore = Join-Path $root 'android\debug.jks'
$keyMissing = -not (Test-Path -LiteralPath $keyStore -PathType Leaf)

# 这里必须用哈希表 splatting。数组 splatting 是「按位置传参」：@('-VersionName', '0.9.10-share')
# 会把 -VersionName 本身当成 $VersionName 的值传进去，参数名根本绑不上（build.ps1 会在第 0 步
# 报「版本名不能以符号开头」）。哈希表才能按名字绑。
$buildParams = @{
  VersionName = $fullVersion
  VersionCode = [string]$info.versionCode
}
if ($Mode -eq 'debug') { $buildParams.Debuggable = $true }
$buildCommandLine = "pwsh -File android\build.ps1 -VersionName $fullVersion -VersionCode $($info.versionCode)" + $(if ($Mode -eq 'debug') { ' -Debuggable' } else { '' })

# ---------- 2. 打印计划 ----------

Write-Host ""
Write-Host "==> 版本    $($info.version)（versionCode $($info.versionCode)）" -ForegroundColor Cyan
Write-Host "==> 模式    $Mode$(if ($Mode -eq 'debug') { '（debuggable：开 WebView 调试端口，别外发）' })"
Write-Host "==> 产物    $apkPath"
if ($keyMissing) {
  Write-Host "==> 警告    android\debug.jks 不存在：build.ps1 会生成一次性签名 key，" -ForegroundColor Yellow
  Write-Host "            这样打出来的包装不到已有安装上（签名不同）。要覆盖升级先放回原来的 key。" -ForegroundColor Yellow
}

if ($DryRun) {
  Write-Host ""
  Write-Host "==> DryRun：下面这些命令一条都没执行" -ForegroundColor DarkGray
  if ($SkipWeb) {
    Write-Host "    1) （-SkipWeb：跳过前端构建）"
  } else {
    Write-Host "    1) node scripts\build-web.mjs"
  }
  Write-Host "    2) $buildCommandLine"
  Write-Host ""
  exit 0
}

# ---------- 3. 构建 ----------

$webLabel = if ($SkipWeb) { '跳过前端构建（-SkipWeb）' } else { '构建前端' }

# dist 里已经有同名旧包（比如之前手敲命令打的 0.9.10-share）。只判「文件在不在」会把旧包
# 当成这次的成果，所以记下改动时间，构建后要求它真的变新。
$previousApkTime = if (Test-Path -LiteralPath $apkPath -PathType Leaf) { (Get-Item -LiteralPath $apkPath).LastWriteTime } else { $null }

try {
  if ($SkipWeb) {
    Write-Host ""
    Write-Host "==> 1/2 $webLabel" -ForegroundColor Cyan
  } else {
    Write-Host ""
    Write-Host "==> 1/2 $webLabel（node scripts\build-web.mjs）" -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $webScript -PathType Leaf)) {
      throw "找不到前端构建脚本：$webScript"
    }
    $global:LASTEXITCODE = 0
    Push-Location -LiteralPath $root
    try {
      & $node $webScript
    } finally {
      Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
      throw "前端构建失败（node scripts\build-web.mjs 退出码 $LASTEXITCODE）"
    }
  }

  Write-Host ""
  Write-Host "==> 2/2 打 APK（android\build.ps1）" -ForegroundColor Cyan
  Write-Host "    $buildCommandLine" -ForegroundColor DarkGray
  # build.ps1 自己会在出错时 throw，异常会传到这里；$LASTEXITCODE 先归零，
  # 免得拿到上一步 node 的退出码误判。
  $global:LASTEXITCODE = 0
  & $buildScript @buildParams
  if ($LASTEXITCODE -ne 0) {
    throw "APK 构建失败（android\build.ps1 退出码 $LASTEXITCODE）"
  }

  # 构建脚本说成功但没产物，是另一类问题（版本名和预期不一致），必须当场发现。
  if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
    throw "构建结束但没有产物：$apkPath"
  }

  $apk = Get-Item -LiteralPath $apkPath
  if ($previousApkTime -and $apk.LastWriteTime -le $previousApkTime) {
    throw "构建说成功了，但 $apkName 的修改时间没变（$($apk.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))），这是上一次的产物"
  }
  Write-Host ""
  Write-Host "==> 完成    $($apk.FullName)" -ForegroundColor Green
  Write-Host "    大小    $('{0:N0} KB' -f ($apk.Length / 1KB))"
  Write-Host "    版本    $fullVersion（versionCode $($info.versionCode)）"
  Write-Host "    目录    $distDir"
} catch {
  Write-Host ""
  Write-Host "==> 失败    $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "    期望产物  $apkPath"
  Write-Host "    产物目录  $distDir"
  if (Test-Path -LiteralPath $apkPath -PathType Leaf) {
    $stale = Get-Item -LiteralPath $apkPath
    Write-Host "    注意：这个路径上有一个旧产物（$('{0:N0} KB' -f ($stale.Length / 1KB))，$($stale.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))），不是这次构建的。" -ForegroundColor Yellow
  }
  throw
}
