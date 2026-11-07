/* tunnel.ps1 -Detach 的两个离线行为回归。
 *
 * M1：隐藏窗口只能针对 WMI 本次返回的 ProcessId，绝不能扫描其它 pwsh 窗口。
 * M2：run.cmd 必须以 UTF-8（无 BOM）落盘，中文私钥路径不被替换成 '?'。
 *
 * 不连 WMI / 不连 ssh / 不写真实 %TEMP%：
 *   Get-CimInstance / Invoke-CimMethod / Get-Process / Add-Type / Start-Sleep / Get-Command 全是替身，
 *   %TEMP% 指到本次 artifacts 目录，替身把每次调用追加进日志。
 * 断言落在"真实调用序列"和"落盘字节"上，不 grep 源码文本。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TUNNEL = path.join(ROOT, 'gateway', 'tunnel.ps1');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');

const PS = process.platform === 'win32' ? 'pwsh' : null;

/** 固定值：替身按这些值回答，断言只认这些字面量。 */
const CREATED_PID = 4242;
const CREATED_WINDOW = 555001;
const FOREIGN_WINDOW = 999777;

const PROBE = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$TunnelPath,
  [Parameter(Mandatory = $true)][string]$FixturePath
)
$ErrorActionPreference = 'Stop'
$global:TunnelFx = Get-Content -LiteralPath $FixturePath -Raw -Encoding utf8 | ConvertFrom-Json
$global:TunnelLog = [string]$global:TunnelFx.logPath

function global:Write-Record {
  param([string]$Tag, [string]$Detail)
  Add-Content -LiteralPath $global:TunnelLog -Value ("{0}|{1}" -f $Tag, $Detail) -Encoding utf8
}

# 替身：只认 tunnel.ps1 真正用到的那几个外部边界。
function global:Get-Command {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Name)
  Write-Record 'get-command' $Name
  if ($Name -eq 'ssh') { return [pscustomobject]@{ Source = [string]$global:TunnelFx.sshPath } }
  return $null
}

function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  Write-Record 'get-ciminstance' ("{0}|{1}" -f $ClassName, $Filter)
  return $null
}

function global:Invoke-CimMethod {
  [CmdletBinding()]
  param([string]$ClassName, [string]$MethodName, [hashtable]$Arguments)
  Write-Record 'invoke-cimmethod' ("{0}|{1}|{2}" -f $ClassName, $MethodName, $Arguments['CommandLine'])
  return [pscustomobject]@{ ReturnValue = 0; ProcessId = [int]$global:TunnelFx.createdProcessId }
}

function global:Get-Process {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string[]]$Name, [int[]]$Id)
  if ($Id) {
    Write-Record 'get-process' ("id=" + ($Id -join ','))
    foreach ($one in $Id) {
      if ($one -eq [int]$global:TunnelFx.createdProcessId) {
        return [pscustomobject]@{
          Id = $one
          MainWindowHandle = [IntPtr][int64]$global:TunnelFx.createdWindowHandle
        }
      }
    }
    return $null
  }
  Write-Record 'get-process' ("name=" + ($Name -join ','))
  if ($Name -contains 'pwsh') {
    return @([pscustomobject]@{
      Id = 900001
      MainWindowHandle = [IntPtr][int64]$global:TunnelFx.foreignWindowHandle
    })
  }
  return @()
}

function global:Start-Sleep {
  [CmdletBinding()]
  param([int]$Milliseconds, [int]$Seconds)
  Write-Record 'start-sleep' ("ms={0} s={1}" -f $Milliseconds, $Seconds)
}

function global:Add-Type {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$TypeDefinition)
  Write-Record 'add-type' 'suppressed'
}

# 只记一次 ShowWindow 调用；不碰 user32。
class TunnelWindowHide {
  static [string] $LogPath
  static [bool] ShowWindow([IntPtr]$hWnd, [int]$nCmdShow) {
    [System.IO.File]::AppendAllText(
      [TunnelWindowHide]::LogPath,
      ("showwindow|{0}{1}" -f $hWnd.ToInt64(), [Environment]::NewLine)
    )
    return $true
  }
}
[TunnelWindowHide]::LogPath = $global:TunnelLog

$tunnelArgs = @{
  Config = [string]$global:TunnelFx.configPath
  VpsHost = [string]$global:TunnelFx.vpsHost
  VpsUser = 'root'
  KeyPath = [string]$global:TunnelFx.keyPath
  RemotePort = 24001
  LocalPort = 24000
  Detach = $true
}
& $TunnelPath @tunnelArgs
`;

function readRecords(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('|');
      return { tag: line.slice(0, at), detail: line.slice(at + 1) };
    });
}

let scenario = null;

function runDetach() {
  if (scenario) return scenario;
  assert.ok(PS, '本回归只在 Windows + pwsh 下跑');

  const runDir = fs.mkdtempSync(path.join(ARTIFACTS, 'tunnel-detach-'));
  const work = path.join(runDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  // 中文文件名是关键输入：旧实现用 ascii 落盘会把它写成 '??'。
  const keyPath = path.join(runDir, '伪钥-测试.pem');
  fs.writeFileSync(keyPath, 'PRIVATE-KEY-PLACEHOLDER');
  const logPath = path.join(runDir, 'calls.log');
  const fixturePath = path.join(runDir, 'fixture.json');
  const probePath = path.join(runDir, 'probe.ps1');
  fs.writeFileSync(probePath, PROBE, 'utf8');

  fs.writeFileSync(fixturePath, JSON.stringify({
    logPath,
    keyPath,
    sshPath: 'C:\\fake\\ssh.exe',
    // 不存在的配置文件：显式传，避免脚本去读用户真实 remote 配置。
    configPath: path.join(runDir, 'no-such-config.json'),
    vpsHost: '203.0.113.9',
    createdProcessId: CREATED_PID,
    createdWindowHandle: CREATED_WINDOW,
    foreignWindowHandle: FOREIGN_WINDOW,
  }), 'utf8');

  const child = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-File', probePath,
    '-TunnelPath', TUNNEL, '-FixturePath', fixturePath], {
    cwd: ROOT,
    env: { ...process.env, TEMP: work, TMP: work },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });

  const runCmd = path.join(work, 'hana-tunnel', 'run.cmd');
  scenario = {
    runDir,
    status: child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    records: fs.existsSync(logPath) ? readRecords(logPath) : [],
    cmdBytes: fs.existsSync(runCmd) ? fs.readFileSync(runCmd) : null,
    keyPath,
  };
  return scenario;
}

function tag(sc, name) {
  return sc.records.filter((r) => r.tag === name).map((r) => r.detail);
}

let bad = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('tunnel -Detach 只隐藏本次 WMI 创建进程的窗口，不扫描其它 pwsh', () => {
  const sc = runDetach();
  assert.equal(sc.status, 0, `tunnel.ps1 应以 0 退出：\n${sc.stdout}\n${sc.stderr}`);

  const created = tag(sc, 'invoke-cimmethod');
  assert.equal(created.length, 1, `必须只创建一次守护进程，实际：${created.join(' | ')}`);
  assert.match(created[0], /^Win32_Process\|Create\|/, `创建调用形状不对：${created[0]}`);
  assert.match(created[0], /run\.cmd/, `创建调用必须拉起 run.cmd：${created[0]}`);

  const processCalls = tag(sc, 'get-process');
  assert.deepEqual(
    processCalls.filter((d) => d.startsWith('name=')),
    [],
    `不得按名字（pwsh）扫描窗口：${processCalls.join(' | ')}`,
  );
  assert.ok(
    processCalls.includes(`id=${CREATED_PID}`),
    `必须按 WMI 返回的 PID 取进程：${processCalls.join(' | ')}`,
  );

  const hidden = tag(sc, 'showwindow').map((d) => Number(d));
  assert.deepEqual(hidden, [CREATED_WINDOW], `只能隐藏本次创建的窗口，实际：${hidden.join(',')}`);
});

t('tunnel -Detach 写出的 run.cmd 是 UTF-8 无 BOM，中文私钥路径原样保留', () => {
  const sc = runDetach();
  assert.ok(sc.cmdBytes, `run.cmd 没有生成：\n${sc.stdout}\n${sc.stderr}`);

  const bytes = sc.cmdBytes;
  assert.notDeepEqual(
    Array.from(bytes.subarray(0, 3)),
    [0xEF, 0xBB, 0xBF],
    'run.cmd 不得带 UTF-8 BOM（cmd 第一行会被 BOM 干扰）',
  );

  const text = bytes.toString('utf8');
  assert.ok(!text.includes('\uFFFD'), 'run.cmd 必须是合法 UTF-8');

  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '@echo off', `第一行必须保持 ASCII：${JSON.stringify(lines[0])}`);
  assert.match(lines[1] || '', /^chcp 65001/, `第二行必须是 chcp 65001：${JSON.stringify(lines[1])}`);
  assert.match(lines[0], /^[\x00-\x7F]*$/, '第一行必须是纯 ASCII');
  assert.match(lines[1], /^[\x00-\x7F]*$/, '第二行必须是纯 ASCII');

  assert.ok(
    text.includes(`-i "${sc.keyPath}"`),
    `中文私钥路径必须原样落盘，实际含：${JSON.stringify(text.split(/\r?\n/).find((l) => l.includes('-i ')) || '')}`,
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

console.log(`\nartifacts: ${scenario ? scenario.runDir : '(未运行)'}`);
if (bad) {
  console.log(`${bad} 个用例失败`);
  process.exitCode = 1;
}
