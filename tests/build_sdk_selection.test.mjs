/* build.ps1 的 SDK 目录挑选回归（L5）。
 *
 * 不执行 build.ps1（它开头就递归删 build/）。这里用 PowerShell AST 抽出脚本里
 * 真正的选取语句/函数，配上伪 sdk 目录与假 Get-ChildItem，跑出"最终选中哪个目录"。
 *
 * 断言的是行为：android-9 / android-35 / android-36 必须选 36；9.0.0 / 35.0.0 必须选 35.0.0；
 * 非数字命名（android-Baklava、preview）必须被忽略而不是排到最前。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD_PS1 = path.join(ROOT, 'android', 'build.ps1');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');const PS = process.platform === 'win32' ? 'pwsh' : null;

const PROBE = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$BuildPs1,
  [Parameter(Mandatory = $true)][string]$FixturePath,
  [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
$fx = Get-Content -LiteralPath $FixturePath -Raw -Encoding utf8 | ConvertFrom-Json

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($BuildPs1, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { throw ("build.ps1 解析失败：" + $errors[0].Message) }

# 先定义脚本里已有的纯函数（修复后才会有），再逐条执行真正的选取语句。
foreach ($fn in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}

$global:FixturePlatforms = @($fx.platforms | ForEach-Object {
  [pscustomobject]@{ Name = $_.name; FullName = (Join-Path $fx.platformsDir $_.name) }
})
$global:FixtureBuildTools = @($fx.buildTools | ForEach-Object {
  [pscustomobject]@{ Name = $_.name; FullName = (Join-Path $fx.buildToolsDir $_.name) }
})
$global:SdkRoot = [string]$fx.sdkRoot
$global:PlatformsDir = Join-Path $global:SdkRoot 'platforms'
$global:BuildToolsDir = Join-Path $global:SdkRoot 'build-tools'

function global:Test-Path {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$LiteralPath, [string]$Path)
  return $false
}

function global:Get-ChildItem {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$LiteralPath, [string]$Path, [switch]$Directory)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($target -eq $global:PlatformsDir) { return $global:FixturePlatforms }
  if ($target -eq $global:BuildToolsDir) { return $global:FixtureBuildTools }
  return @()
}

$sdk = $global:SdkRoot
$platform = Join-Path $sdk 'platforms\android-36'

# 真正的 platform fallback 分支（脚本里就这一段做选择）。
$platformBlock = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] }, $false) |
  Where-Object { $_.Extent.Text -match 'platforms' -and $_.Extent.Text -match '\$platform' } |
  Select-Object -First 1
if (-not $platformBlock) { throw 'build.ps1 里找不到 platform fallback 分支' }
. ([scriptblock]::Create($platformBlock.Extent.Text))

# 真正的 build-tools 选取语句。
$buildToolsAssign = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] }, $false) |
  Where-Object { $_.Left.Extent.Text -eq '$buildTools' } |
  Select-Object -First 1
if (-not $buildToolsAssign) { throw 'build.ps1 里找不到 $buildTools 赋值' }
. ([scriptblock]::Create($buildToolsAssign.Extent.Text))

[pscustomobject]@{
  platformPath = [string]$platform
  platformName = [string](Split-Path -Leaf ([string]$platform))
  buildToolsPath = [string]$buildTools.FullName
  buildToolsName = [string](Split-Path -Leaf ([string]$buildTools.FullName))
} | ConvertTo-Json | Set-Content -LiteralPath $OutPath -Encoding utf8NoBOM
`;

let results = new Map();

function runSelection(variant = 'mixed') {
  if (results.has(variant)) return results.get(variant);
  assert.ok(PS, '本回归只在 Windows + pwsh 下跑');

  // 工作区里 tests/artifacts/ 是被 gitignore 的，干净检出时它不存在；
  // 不先建出来，mkdtempSync 会直接 ENOENT（CI 上就是这书）。
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(ARTIFACTS, `build-sdk-select-${variant}-`));  const sdkRoot = path.join(runDir, 'sdk');
  fs.mkdirSync(path.join(sdkRoot, 'platforms'), { recursive: true });
  fs.mkdirSync(path.join(sdkRoot, 'build-tools'), { recursive: true });

  // variant=mixed 额外放入非数字命名，证明它们被过滤而不是排到最前；
  // variant=numeric 只用纯数字名字，单独证明“按数值而不是按字典序”。
  const platformNames = variant === 'numeric'
    ? ['android-9', 'android-35', 'android-36']
    : ['android-9', 'android-Baklava', 'android-35', 'android-36'];
  const buildToolNames = variant === 'numeric'
    ? ['9.0.0', '35.0.0']
    : ['9.0.0', 'preview', '35.0.0'];

  const fixture = {
    sdkRoot,
    platformsDir: path.join(sdkRoot, 'platforms'),
    buildToolsDir: path.join(sdkRoot, 'build-tools'),
    // 伪目录只给名字：选择逻辑只看 Name/FullName，不读文件。
    platforms: platformNames.map((name) => ({ name })),
    buildTools: buildToolNames.map((name) => ({ name })),
  };
  const fixturePath = path.join(runDir, 'fixture.json');
  const outPath = path.join(runDir, 'picked.json');
  const probePath = path.join(runDir, 'probe.ps1');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');
  fs.writeFileSync(probePath, PROBE, 'utf8');

  const child = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-File', probePath,
    '-BuildPs1', BUILD_PS1, '-FixturePath', fixturePath, '-OutPath', outPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });

  const sc = {
    runDir,
    status: child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    picked: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null,
  };
  results.set(variant, sc);
  return sc;
}

let bad = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('platform fallback 按 API 级别数值挑最新（纯数字目录）', () => {
  const sc = runSelection('numeric');
  assert.ok(sc.picked, `选取没有产出结果：\n${sc.stdout}\n${sc.stderr}`);
  assert.equal(
    sc.picked.platformName,
    'android-36',
    `应选 API 36，实际选了 ${sc.picked.platformName}`,
  );
});

t('platform fallback 忽略非数字命名（android-Baklava）', () => {
  const sc = runSelection('mixed');
  assert.ok(sc.picked, `选取没有产出结果：\n${sc.stdout}\n${sc.stderr}`);
  assert.equal(
    sc.picked.platformName,
    'android-36',
    `应选 android-36，实际选了 ${sc.picked.platformName}`,
  );
});

t('build-tools 按版本数值挑最新，非稳定命名不参与比较', () => {
  const numeric = runSelection('numeric');
  assert.ok(numeric.picked, `选取没有产出结果：\n${numeric.stdout}\n${numeric.stderr}`);
  assert.equal(
    numeric.picked.buildToolsName,
    '35.0.0',
    `纯数字目录应选 35.0.0，实际选了 ${numeric.picked.buildToolsName}`,
  );

  const mixed = runSelection('mixed');
  assert.ok(mixed.picked, `选取没有产出结果：\n${mixed.stdout}\n${mixed.stderr}`);
  assert.equal(
    mixed.picked.buildToolsName,
    '35.0.0',
    `含 preview 时应选 35.0.0，实际选了 ${mixed.picked.buildToolsName}`,
  );
});

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message || err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

console.log(`\nartifacts: ${[...results.values()].map((s) => s.runDir).join(' , ') || '(未运行)'}`);
if (bad) {
  console.log(`${bad} 个用例失败`);
  process.exitCode = 1;
}
