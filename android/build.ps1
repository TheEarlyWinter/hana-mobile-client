# Hana Mobile —— 不依赖 Gradle 的 APK 构建脚本
#
# 用 SDK 自带的 aapt2 / d8 / zipalign / apksigner 手搓，全程离线。
#
# 用法：pwsh -File build.ps1
#       pwsh -File build.ps1 -Debuggable        # 打包可调试版：壳里会开 WebView 调试端口（CDP）
#       pwsh -File build.ps1 -Release           # 发布构建：必须已有稳定签名 key，且不允许 -Debuggable
# 产物：dist\hana-mobile-<version>.apk

param(
  [string]$VersionName = "",
  [string]$VersionCode = "",
  # 默认不写 android:debuggable：产出的包和以前完全一样，壳里调试端口永远不开。
  # 需要 scripts/devtools 的 CDP 工具链时才加这个开关（仅调试用，别拿去发给人）。
  [switch]$Debuggable,
  # 发布构建：缺稳定签名 key 直接失败，绝不自动生成新 key；也不允许 debuggable。
  # 开发调试不加这个开关，缺 key 时仍会生成一次性的调试 key（签名会变，只能本机用）。
  [switch]$Release
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# ---------- 0. 参数、签名身份与版本基线（必须在任何删除/编译之前） ----------
# 这一段全部是「动手之前」的检查：发布构建的 key 不对、版本号不对，都不该先把上一次的
# build/ 产物删掉再报错。

if ($Release -and $Debuggable) {
  throw "发布构建不能加 -Debuggable：debuggable 包会开 WebView 调试端口，不允许外发。"
}

$ks = Join-Path $root "debug.jks"
# 必须是文件（-PathType Leaf）：debug.jks 被建成目录时 Test-Path 也会为真，
# 那种情况下签名必然失败，不如在清理 build/ 之前就拦下来。
if ($Release -and -not (Test-Path -LiteralPath $ks -PathType Leaf)) {
  throw "发布构建需要已有的稳定签名 key：$ks 不存在。发布路径不会自动生成新 key（换了签名，手机上覆盖安装会失败）。只做本机调试请去掉 -Release。"
}

$manifestSrc = Join-Path $root "AndroidManifest.xml"
if (-not (Test-Path -LiteralPath $manifestSrc)) { throw "找不到 manifest：$manifestSrc" }
$xml = Get-Content -LiteralPath $manifestSrc -Raw

$manifestCodeText = [regex]::Match($xml, 'android:versionCode="(\d+)"').Groups[1].Value
$manifestNameText = [regex]::Match($xml, 'android:versionName="([^"]*)"').Groups[1].Value

# 不传参数就沿用 manifest 里的版本号。
# 切勿在这里给 0.1/1 这类默认值：那样手滑直接跑一遍，产出的包版本比手上的低，
# 覆盖安装直接 INSTALL_FAILED_VERSION_DOWNGRADE。
$codeFromManifest = $false
if (-not $VersionCode) {
  if (-not $manifestCodeText) { throw "manifest 里没有 versionCode，请用 -VersionCode 指定" }
  $VersionCode = $manifestCodeText
  $codeFromManifest = $true
}
if (-not $VersionName) {
  if (-not $manifestNameText) { throw "manifest 里没有 versionName，请用 -VersionName 指定" }
  $VersionName = $manifestNameText
}

if ($VersionCode -notmatch '^\d+$') { throw "版本码必须是整数，收到的是：$VersionCode" }
$codeNumber = [int]$VersionCode
if ($codeNumber -lt 1) { throw "版本码必须大于 0，收到的是：$VersionCode" }
# 版本名会进 APK 文件名和 manifest 的 XML 替换，不能带路径分隔符、引号、$ 之类的东西。
# 允许 0.9.8-devtools 这种开发后缀，发布脚本自己会再收紧成纯数字点号。
if ($VersionName -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$' -or $VersionName.Length -gt 40) {
  throw "版本名只能由字母、数字、点、下划线、连字符组成（不能以符号开头，最长 40），收到的是：$VersionName"
}

# 已发布版本是另一条基线：发版故意不改工作区，manifest 常常落后于线上，
# 直接拿它当默认值会静默产出装不上的旧包。
$latestPath = Join-Path (Split-Path -Parent $root) 'web\download\latest.json'
$latestCode = 0
$latestName = ''
if (Test-Path -LiteralPath $latestPath) {
  try {
    $latestJson = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
  } catch {
    throw "web\download\latest.json 解析失败，先人工确认线上元数据：$($_.Exception.Message)"
  }
  $parsedLatest = 0
  if (-not [int]::TryParse([string]$latestJson.versionCode, [ref]$parsedLatest)) {
    throw "web\download\latest.json 里的 versionCode 不是整数：$($latestJson.versionCode)"
  }
  $latestCode = $parsedLatest
  $latestName = [string]$latestJson.versionName
}

if ($codeNumber -lt $latestCode) {
  if ($codeFromManifest) {
    throw "manifest 里的默认版本 $VersionName ($codeNumber) 比已发布的 $latestName ($latestCode) 旧。不带版本参数打包会产出装不上的旧包；请显式传 -VersionName/-VersionCode，或先更新 android/AndroidManifest.xml。"
  }
  Write-Host "==> 警告：版本码 $codeNumber 低于已发布的 $latestCode，覆盖安装会失败" -ForegroundColor Yellow
}

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path -LiteralPath $sdk)) { throw "Android SDK 没找到：$sdk" }

# 按数字段挑最新目录。Sort-Object Name -Descending 是字典序，会把 android-9 排在
# android-36 前面、把 preview/android-Baklava 这种非数字命名排到最前。
# 名字先用正则过滤（只有匹配的才取 $Matches['v']），非稳定命名直接跳过而不是强转成 0。
function Select-LatestVersionDirectory {
  param(
    [string]$Path,
    [string]$NamePattern
  )
  $candidates = foreach ($dir in @(Get-ChildItem -LiteralPath $Path -Directory -ErrorAction SilentlyContinue)) {
    if ($dir.Name -notmatch $NamePattern) { continue }
    $parts = $Matches['v'] -split '\.'
    # 每段补零再拼成字符串：段数不同也能正确比较（9.0.0 < 35.0.0），不依赖 [version] 的段数限制。
    $sortKey = ($parts | ForEach-Object { $_.PadLeft(6, '0') }) -join '.'
    [pscustomobject]@{ Name = $dir.Name; FullName = $dir.FullName; SortKey = $sortKey }
  }
  $best = @($candidates) | Sort-Object -Property SortKey -Descending | Select-Object -First 1
  if (-not $best) { return $null }
  return $best
}

# SDK 里这几个工具的后缀并不统一（aapt2/zipalign 是 .exe，d8/apksigner 是 .bat），
# 按后缀硬拼会在「工具其实在、只是后缀不同」时误报缺失。统一按 exe → bat → cmd 找。
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

$buildTools = Select-LatestVersionDirectory -Path (Join-Path $sdk "build-tools") -NamePattern '^(?<v>\d+(?:\.\d+)*)$'
if (-not $buildTools) { throw "Android SDK 里没有可用的 build-tools：$(Join-Path $sdk 'build-tools')" }
$bt = $buildTools.FullName

$platform = Join-Path $sdk "platforms\android-36"
if (-not (Test-Path -LiteralPath $platform)) {
  $picked = Select-LatestVersionDirectory -Path (Join-Path $sdk "platforms") -NamePattern '^android-(?<v>\d+)$'
  if (-not $picked) { throw "Android SDK 的 platforms 目录里没有 android-<数字> 平台：$(Join-Path $sdk 'platforms')" }
  $platform = $picked.FullName
}
$androidJar = Join-Path $platform "android.jar"
if (-not (Test-Path -LiteralPath $androidJar)) { throw "android.jar 没找到：$androidJar" }

$tools = [ordered]@{
  aapt2     = Resolve-SdkTool -Directory $bt -BaseName 'aapt2'
  d8        = Resolve-SdkTool -Directory $bt -BaseName 'd8'
  zipalign  = Resolve-SdkTool -Directory $bt -BaseName 'zipalign'
  apksigner = Resolve-SdkTool -Directory $bt -BaseName 'apksigner'
}
foreach ($toolName in @($tools.Keys)) {
  if (-not $tools[$toolName]) { throw "缺少构建工具：$toolName（目录 $bt）" }
}
$aapt2     = $tools.aapt2
$d8        = $tools.d8
$zipalign  = $tools.zipalign
$apksigner = $tools.apksigner

$buildDir = Join-Path $root "build"
$distDir  = Join-Path $root "dist"
Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $buildDir, $distDir | Out-Null
$genDir = Join-Path $buildDir "gen"
New-Item -ItemType Directory -Force -Path $genDir | Out-Null

Write-Host "==> 1/7 编译资源" -ForegroundColor Cyan

# 版本号已经在第 0 步定好（manifest / 参数 / 线上基线的裁决都在那里），这里只改写临时 manifest。
$manifest = Join-Path $buildDir "AndroidManifest.xml"
Write-Host "==> 版本 $VersionName ($VersionCode)" -ForegroundColor DarkGray
$xml = $xml -replace 'android:versionCode="[0-9]+"', ("android:versionCode=`"{0}`"" -f $VersionCode)
$xml = $xml -replace 'android:versionName="[^"]*"', ("android:versionName=`"{0}`"" -f $VersionName)

# debuggable 是壳里「开 WebView 调试端口」的唯一依据（MainActivity 读 FLAG_DEBUGGABLE）。
# 只改这一份临时 manifest，源码里的 AndroidManifest.xml 不动，签名流程也不动。
if ($Debuggable) {
  $xml = $xml -replace '\s+android:debuggable="[^"]*"', ''
  $xml = $xml -replace '<application', '<application android:debuggable="true"'
  Write-Host "==> 构建类型：debuggable（WebView 调试端口 / CDP 可用）" -ForegroundColor Yellow
} else {
  Write-Host "==> 构建类型：非 debuggable（WebView 调试端口不开；要 CDP 就加 -Debuggable）" -ForegroundColor DarkGray
}

Set-Content -LiteralPath $manifest -Value $xml -Encoding UTF8

& $aapt2 compile --dir (Join-Path $root "res") -o (Join-Path $buildDir "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

Write-Host "==> 2/7 链接资源 + 生成 R.java" -ForegroundColor Cyan
$baseApk = Join-Path $buildDir "base.apk"
& $aapt2 link `
  -o $baseApk `
  -I $androidJar `
  --manifest $manifest `
  -A (Join-Path $root "assets") `
  -R (Join-Path $buildDir "res.zip") `
  --java $genDir `
  --auto-add-overlay `
  --min-sdk-version 26 `
  --target-sdk-version 36 `
  --version-code $VersionCode `
  --version-name $VersionName
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

Write-Host "==> 3/7 编译 Java" -ForegroundColor Cyan
$classesDir = Join-Path $buildDir "classes"
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
$sources = @()
$sources += (Get-ChildItem -LiteralPath (Join-Path $root "src") -Recurse -Filter *.java).FullName
$sources += (Get-ChildItem -LiteralPath $genDir -Recurse -Filter *.java).FullName
& javac -encoding UTF-8 -source 17 -target 17 -nowarn `
  -classpath $androidJar -d $classesDir $sources
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

Write-Host "==> 4/7 dex" -ForegroundColor Cyan
$dexDir = Join-Path $buildDir "dex"
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null
$classFiles = (Get-ChildItem -LiteralPath $classesDir -Recurse -Filter *.class).FullName
& $d8 --lib $androidJar --min-api 26 --output $dexDir $classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

Write-Host "==> 5/7 打包 classes.dex" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$unaligned = Join-Path $buildDir "unaligned.apk"
Copy-Item -LiteralPath $baseApk -Destination $unaligned -Force
$zip = [System.IO.Compression.ZipFile]::Open($unaligned, [System.IO.Compression.ZipArchiveMode]::Update)
$entry = $zip.GetEntry("classes.dex")
if ($entry) { $entry.Delete() }
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
  $zip, (Join-Path $dexDir "classes.dex"), "classes.dex",
  [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
$zip.Dispose()

Write-Host "==> 6/7 zipalign" -ForegroundColor Cyan
$aligned = Join-Path $buildDir "aligned.apk"
& $zipalign -f 4 $unaligned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

Write-Host "==> 7/7 签名" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $ks)) {
  # 只有开发构建能走到这里：-Release 在第 0 步就会因为缺 key 直接失败。
  # 新生成的 key 和之前发布的包不是同一个签名，装到已有安装上会失败，所以只能本机调试用。
  Write-Host "    没有 $ks：生成一次性调试 key。签名与已发布的包不同，只能本机调试；发布构建请用 -Release（缺 key 会直接失败）。" -ForegroundColor Yellow
  & keytool -genkeypair -keystore $ks -alias hana -keyalg RSA -keysize 2048 `
    -validity 10000 -storepass android -keypass android `
    -dname "CN=Hana Mobile, O=Local, C=CN"
  if ($LASTEXITCODE -ne 0) { throw "keytool 失败" }
}

$outApk = Join-Path $distDir ("hana-mobile-{0}.apk" -f $VersionName)
& $apksigner sign `
  --ks $ks --ks-key-alias hana `
  --ks-pass pass:android --key-pass pass:android `
  --out $outApk $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }

& $apksigner verify --print-certs $outApk | Select-Object -First 3
if ($LASTEXITCODE -ne 0) { throw "apksigner verify 失败：产出的包签不上，别拿它发布" }

Write-Host ""
Write-Host "完成：$outApk" -ForegroundColor Green
"{0:N0} KB" -f ((Get-Item $outApk).Length / 1KB)
