# scripts/release.ps1 —— 一条命令发版：预检 → 打包 → 验包 → 落到下载页
#
# 为什么每一步都是硬检查：
#   版本号写错、忘了拷 APK、把 debug 包发出去、拿旧包覆盖同版本、换了签名导致装不上——
#   这些都不是「小心一点」能避免的。发布是不可逆的对外动作，所以默认 fail-closed：
#   预检或验包任一步不过，web\download 里的 APK / latest.json / index.html 一律不动。
#   真正开始落盘后不是多文件事务：复制 APK / 写 latest.json / 写 index.html 之间如果发生
#   磁盘错误或进程被中断，可能留下部分更新，不会自动回滚（本脚本不承诺全局事务）。
#
# 用法：
#   scripts/release.ps1 -VersionName 0.9.10 -VersionCode 13
#   scripts/release.ps1 -VersionName 0.9.10 -VersionCode 13 -SkipBuild   # 已经打过包，只重做下载页
#   scripts/release.ps1 -VersionName 0.9.10 -VersionCode 13 -AllowDowngrade  # 明确知道自己在干什么时才用
#
# 版本基线：max(android/AndroidManifest.xml, web/download/latest.json)。
#   发版故意不改工作区的 manifest，所以 manifest 往往落后于线上；只按 manifest 判递增
#   会让一个比线上旧的版本号通过检查。

param(
  [Parameter(Mandatory = $true)][string]$VersionName,
  [Parameter(Mandatory = $true)][string]$VersionCode,
  [switch]$SkipBuild,
  # 保留这个参数只为给出明确报错：发布不再接受 debuggable 包。
  [switch]$Debuggable,
  # 允许版本码回退：只有明确知道自己在干什么时才用（正常会挡住）。
  # 它只放宽「版本码必须 >= 基线」这一条，包身份/签名校验一条都不会被跳过。
  [switch]$AllowDowngrade
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'android\AndroidManifest.xml'
$distDir = Join-Path $root 'android\dist'
$downloadDir = Join-Path $root 'web\download'
$latestPath = Join-Path $downloadDir 'latest.json'
$packageName = 'com.hanamobile.app'

# ---------- 0. 小工具 ----------

# 只认纯数字目录名，按数字段比较。预览目录（36.0.0-rc1、preview 之类）直接跳过：
# 拿 [version] 强转会在遇到 rc 名时整个脚本抛异常，也不该拿预览工具链发正式包。
function Select-StableVersionDirectory {
  param(
    [string]$Path,
    [string]$NamePattern
  )
  $candidates = foreach ($dir in @(Get-ChildItem -LiteralPath $Path -Directory -ErrorAction SilentlyContinue)) {
    if ($dir.Name -notmatch $NamePattern) { continue }
    $parts = $Matches['v'] -split '\.'
    $sortKey = ($parts | ForEach-Object { $_.PadLeft(6, '0') }) -join '.'
    [pscustomobject]@{ Name = $dir.Name; FullName = $dir.FullName; SortKey = $sortKey }
  }
  $best = @($candidates) | Sort-Object -Property SortKey -Descending | Select-Object -First 1
  if (-not $best) { return $null }
  return $best
}

# 工具后缀在不同 SDK 版本里不统一（aapt2/zipalign 是 .exe，d8/apksigner 是 .bat）。
function Resolve-SdkTool {
  param(
    [string]$Directory,
    [string]$BaseName
  )
  foreach ($ext in @('.exe', '.bat', '.cmd')) {
    $candidate = Join-Path $Directory ($BaseName + $ext)
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# 读线上元数据。文件不存在 = 还没发过版；存在但读不出来 = 元数据坏了，不能猜，直接停。
function Read-PublishedRelease {
  param([string]$Path, [string]$DownloadDir)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "web\download\latest.json 解析失败，先人工确认线上元数据：$($_.Exception.Message)"
  }
  $parsedCode = 0
  if (-not [int]::TryParse([string]$data.versionCode, [ref]$parsedCode)) {
    throw "web\download\latest.json 里的 versionCode 不是整数：$($data.versionCode)"
  }
  $publishedFile = [string]$data.file
  $publishedHash = ([string]$data.sha256).ToLowerInvariant()
  # 老元数据可能没有 sha256：用下载目录里那份 APK 现算，作为同码重发的身份依据。
  if (-not $publishedHash -and $publishedFile) {
    $publishedApkPath = Join-Path $DownloadDir $publishedFile
    if (Test-Path -LiteralPath $publishedApkPath) {
      $publishedHash = (Get-FileHash -LiteralPath $publishedApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return [pscustomobject]@{
    VersionName = [string]$data.versionName
    VersionCode = $parsedCode
    File        = $publishedFile
    Sha256      = $publishedHash
  }
}

# ---------- 1. 参数检查 ----------

if ($Debuggable) {
  throw "发布不接受 debuggable 包：调试包会开 WebView 调试端口，别外发。只做本机调试请直接用 android/build.ps1 -Debuggable。"
}
if ($VersionName -notmatch '^\d+\.\d+(\.\d+)*$') {
  throw "版本名要写成 0.9.10 这种形式，收到的是：$VersionName"
}
if ($VersionCode -notmatch '^\d+$') {
  throw "版本码必须是整数，收到的是：$VersionCode"
}
$code = [int]$VersionCode
if ($code -lt 1) {
  throw "版本码必须大于 0，收到的是：$VersionCode"
}

# ---------- 2. 版本基线：manifest 与线上元数据取大者 ----------

$manifestXml = Get-Content -LiteralPath $manifestPath -Raw
$manifestCodeMatch = [regex]::Match($manifestXml, 'android:versionCode="(\d+)"')
if (-not $manifestCodeMatch.Success) {
  throw "android\AndroidManifest.xml 里没有 versionCode，没法确定基线"
}
$manifestCode = [int]$manifestCodeMatch.Groups[1].Value
$manifestName = [regex]::Match($manifestXml, 'android:versionName="([^"]*)"').Groups[1].Value

$published = Read-PublishedRelease -Path $latestPath -DownloadDir $downloadDir
$publishedCode = if ($published) { $published.VersionCode } else { 0 }
$baselineCode = [math]::Max($manifestCode, $publishedCode)

if ($code -lt $baselineCode) {
  if (-not $AllowDowngrade) {
    throw "版本码 $code 比基线 $baselineCode 低（manifest $manifestCode / 已发布 $publishedCode）。手机装上去会 INSTALL_FAILED_VERSION_DOWNGRADE；确实要这么做就加 -AllowDowngrade"
  }
  Write-Host "==> -AllowDowngrade：允许发 $code（基线 $baselineCode）" -ForegroundColor Yellow
}

# 同版本码只允许「同一份包」重发。名字对不上就是同码异包，直接停。
$republish = $false
if ($published -and $code -eq $published.VersionCode) {
  if ($VersionName -ne $published.VersionName) {
    throw "版本码 $code 已经发布过 $($published.VersionName)，不能换成 $VersionName 重发（同码异包）。要发新包请递增版本码。"
  }
  $republish = $true
}

Write-Host "==> 发版 $VersionName ($code)，基线 $baselineCode" -ForegroundColor Cyan

# ---------- 3. 预检：稳定 SDK 工具必须齐 ----------

# 没有 aapt2 / apksigner 就没法验包身份和签名，宁可不发。
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath $sdk)) {
  throw "Android SDK 没找到：$sdk（发版必须能用 aapt2 / apksigner 验包）"
}
$buildTools = Select-StableVersionDirectory -Path (Join-Path $sdk 'build-tools') -NamePattern '^(?<v>\d+(?:\.\d+)*)$'
if (-not $buildTools) {
  throw "Android SDK 的 build-tools 里没有稳定版本目录（只要纯数字命名，rc/preview 不算）：$(Join-Path $sdk 'build-tools')"
}
$aapt2 = Resolve-SdkTool -Directory $buildTools.FullName -BaseName 'aapt2'
if (-not $aapt2) {
  throw "缺少 aapt2，无法核对包身份：$(Join-Path $buildTools.FullName 'aapt2')"
}
$apksigner = Resolve-SdkTool -Directory $buildTools.FullName -BaseName 'apksigner'
if (-not $apksigner) {
  throw "缺少 apksigner，无法校验签名：$(Join-Path $buildTools.FullName 'apksigner')"
}
Write-Host "==> 使用 build-tools $($buildTools.Name)" -ForegroundColor DarkGray

# ---------- 4. 打包 ----------

$apkName = "hana-mobile-$VersionName.apk"
$apkPath = Join-Path $distDir $apkName

if ($SkipBuild) {
  if (-not (Test-Path -LiteralPath $apkPath)) {
    throw "用了 -SkipBuild，但找不到 $apkPath"
  }
  Write-Host "==> 跳过打包，用现成的 $apkName" -ForegroundColor DarkGray
} else {
  $buildScript = Join-Path $root 'android\build.ps1'
  # build.ps1 抛错会直接终止本脚本；这里只需要兜住「它没抛错但也没产出」的情况。
  $global:LASTEXITCODE = 0
  & $buildScript -VersionName $VersionName -VersionCode $VersionCode -Release
  if ($LASTEXITCODE -ne 0) {
    throw "打包失败（build.ps1 退出码 $LASTEXITCODE）"
  }
  if (-not (Test-Path -LiteralPath $apkPath)) {
    throw "打包失败，没有产出 $apkPath"
  }
}

$apk = Get-Item -LiteralPath $apkPath
if ($apk.Length -lt 50KB) {
  throw "产出的 APK 只有 $([math]::Round($apk.Length/1KB)) KB，明显不对，停下来"
}

# ---------- 5. 验包：身份、版本、调试位、签名 ----------
# 这一段之前不许碰 web\download：验不过就什么都不改。

$badgingRaw = & $aapt2 dump badging $apkPath 2>&1
$badgingExit = $LASTEXITCODE
$badgingText = ($badgingRaw | Out-String)
if ($badgingExit -ne 0) {
  throw "aapt2 dump badging 失败（退出码 $badgingExit），没法确认包身份：$($badgingText.Trim())"
}

$packageMatch = [regex]::Match($badgingText, "package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'")
if (-not $packageMatch.Success) {
  throw "aapt2 dump badging 输出里没有完整的 package 行（name / versionCode / versionName），不能确认包身份：$($badgingText.Trim())"
}
$apkPackage = $packageMatch.Groups[1].Value
$apkCode = [int]$packageMatch.Groups[2].Value
$apkVersionName = $packageMatch.Groups[3].Value

# 包名要区分大小写：PowerShell 的 -ne 默认忽略大小写，com.Hanamobile.app 会被当成
# 和 com.hanamobile.app 相等，等于放过一个不同的包身份。
if ($apkPackage -cne $packageName) {
  throw "APK 的包名是 $apkPackage，不是 $packageName，不能发"
}
if ($apkCode -ne $code) {
  throw "APK 里的 versionCode 是 $apkCode，和要发的 $code 对不上"
}
if ($apkVersionName -ne $VersionName) {
  throw "APK 里的版本名是 $apkVersionName，和要发的 $VersionName 对不上"
}
if ($badgingText -match '(?m)^application-debuggable\s*$') {
  throw "APK 是 debuggable 的（application-debuggable），不能外发"
}

$verifyRaw = & $apksigner verify --print-certs $apkPath 2>&1
$verifyExit = $LASTEXITCODE
if ($verifyExit -ne 0) {
  throw "apksigner verify 失败（退出码 $verifyExit），这个包不能发：$(($verifyRaw | Out-String).Trim())"
}
Write-Host "==> 包身份与签名核对通过" -ForegroundColor DarkGray

$hash = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "==> SHA256 $hash" -ForegroundColor DarkGray

# ---------- 6. 落盘：同版本同包幂等，其余情况才改下载目录 ----------

if ($republish) {
  if (-not $published.Sha256) {
    throw "版本码 $code（$VersionName）已经发布过，但线上元数据里没有可用的 sha256，无法证明是同一份包。先人工核对 web\download 再发。"
  }
  if ($hash -ne $published.Sha256) {
    throw "版本码 $code（$VersionName）已经发布过，但这次的 APK 不是同一份（$hash ≠ $($published.Sha256)）。同码异包不能覆盖；要发新包请递增版本码。"
  }
  $targetApk = Join-Path $downloadDir $apkName
  $targetOk = (Test-Path -LiteralPath $targetApk) -and
    ((Get-FileHash -LiteralPath $targetApk -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash)
  if (-not $targetOk) {
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    Copy-Item -LiteralPath $apkPath -Destination $targetApk -Force
    Write-Host "==> 幂等重发：已发布的 $apkName 缺失或不一致，按已验证的字节补回" -ForegroundColor DarkGray
  } else {
    Write-Host "==> 幂等重发：$apkName 与已发布的完全一致，下载页与 latest.json 不动" -ForegroundColor DarkGray
  }
  Write-Host ""
  Write-Host "发版完成（幂等，无改动）：$apkName" -ForegroundColor Green
  Write-Host "  版本    $VersionName ($code)"
  Write-Host "  SHA256  $hash"
  return
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
$targetApk = Join-Path $downloadDir $apkName
Copy-Item -LiteralPath $apkPath -Destination $targetApk -Force

# 仓库里的 manifest 故意不动：发版不该把工作区弄脏。
# 但它落后于线上时，不带参数直接打包会被 build.ps1 挡住，这里提前说一声。
$declaredCode = [regex]::Match($manifestXml, 'android:versionCode="([0-9]+)"').Groups[1].Value
if ($manifestName -ne $VersionName -or $declaredCode -ne $VersionCode) {
  Write-Host "==> 提醒：android/AndroidManifest.xml 里还写着 $manifestName ($declaredCode)，落后于线上。" -ForegroundColor Yellow
  Write-Host "    不带 -VersionName/-VersionCode 直接跑 build.ps1 会被拒绝；发布请始终显式带版本。" -ForegroundColor Yellow
}

# ---------- 7. 重新生成下载页 ----------

$apks = Get-ChildItem -LiteralPath $downloadDir -Filter '*.apk' -File |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object {
    $versionMatch = [regex]::Match($_.Name, 'hana-mobile-([\d.]+)\.apk')
    [pscustomobject]@{
      file = $_.Name
      version = if ($versionMatch.Success) { $versionMatch.Groups[1].Value } else { '未知' }
      sizeMB = [math]::Round($_.Length / 1MB, 2)
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      builtAt = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
    }
  }

$latestJson = [ordered]@{
  versionName = $VersionName
  versionCode = $code
  file = $apkName
  sha256 = $hash
  sizeBytes = $apk.Length
  builtAt = (Get-Date).ToString('o')
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $downloadDir 'latest.json') -Value $latestJson -Encoding UTF8

$rows = foreach ($item in $apks) {
  # 「最新」按这次发布的文件名标记，不按 mtime：-SkipBuild 重发旧产物时 mtime 可能更早。
  $isLatest = ($item.file -eq $apkName)
  $tag = if ($isLatest) { ' <span class="tag">最新</span>' } else { '' }
  @"
    <tr>
      <td><a href="/download/$($item.file)">$($item.file)</a>$tag</td>
      <td>$($item.version)</td>
      <td>$($item.sizeMB) MB</td>
      <td class="mono">$($item.sha256.Substring(0, 16))…</td>
      <td>$($item.builtAt)</td>
    </tr>
"@
}

$html = @"
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hana Mobile 安装包</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 18px 48px; font: 15px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.note { margin: 0 0 20px; opacity: .65; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid rgba(128,128,128,.25); }
  th { font-weight: 600; opacity: .7; font-size: 12px; }
  a { color: #2a6df4; text-decoration: none; }
  .tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: #2a6df4; color: #fff; font-size: 11px; vertical-align: 1px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; opacity: .7; }
  footer { margin-top: 24px; font-size: 12px; opacity: .55; }
</style>
</head>
<body>
<h1>Hana Mobile 安装包</h1>
<p class="note">同签名覆盖安装，不会清数据。装之前确认手机与电脑在同一个局域网。</p>
<table>
  <thead><tr><th>文件</th><th>版本</th><th>大小</th><th>SHA256</th><th>构建时间</th></tr></thead>
  <tbody>
$($rows -join "`n")
  </tbody>
</table>
<footer>由 scripts/release.ps1 自动生成，别手改。</footer>
</body>
</html>
"@
Set-Content -LiteralPath (Join-Path $downloadDir 'index.html') -Value $html -Encoding UTF8

# ---------- 8. 汇报 ----------

# 只报「能上网的那张网卡」的地址：带默认网关、且不是虚拟网卡。
# 不这么筛的话，WSL / Hyper-V / VPN 的 172.x 会被选中，报出去手机根本连不上。
$lanIp = (Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPv4DefaultGateway -and
    $_.IPv4Address.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' -and
    $_.InterfaceAlias -notmatch 'vEthernet|Hyper-V|WSL|Loopback|VirtualBox|VMware|Tailscale|ZeroTier'
  } |
  Sort-Object { if ($_.IPv4Address.IPAddress -like '192.168.*') { 0 } else { 1 } } |
  Select-Object -First 1).IPv4Address.IPAddress

Write-Host ""
Write-Host "发版完成：$apkName" -ForegroundColor Green
Write-Host "  版本    $VersionName ($code)"
Write-Host "  大小    $([math]::Round($apk.Length / 1KB)) KB"
Write-Host "  下载页  web\download\index.html"
if ($lanIp) {
  Write-Host "  手机上打开  http://${lanIp}:24000/download/"
}
Write-Host "  提醒：web\download\*.apk 不进仓库；index.html 与 latest.json 会进。" -ForegroundColor DarkGray
