/* 真实 stop.ps1 控制流的隔离验收。所有进程/端口/停止命令均由函数替身拦截。
 * 不操作真实进程，不访问真实配置，不删除产物。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stopPath = path.join(ROOT, 'gateway', 'stop.ps1');
const helperPath = path.join(ROOT, 'gateway', 'process-identity.ps1');
// 防止入口改成绕过函数替身的模块限定命令或原生进程调用。
const stopSource = readFileSync(stopPath, 'utf8');
assert.doesNotMatch(stopSource, /(?:[\\:]Stop-Process|Invoke-CimMethod|Get-Process\b|Diagnostics\.Process|Start-Process|Invoke-Expression)/i);
assert.doesNotMatch(readFileSync(helperPath, 'utf8'), /Get-CimInstance|Get-NetTCPConnection|Stop-Process|Diagnostics\.Process|Invoke-CimMethod/i);
const artifacts = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const runDir = mkdtempSync(path.join(artifacts, 'gateway-stop-mock-'));
const fakeHome = path.join(runDir, 'fake-home');
mkdirSync(fakeHome);
const probePath = path.join(runDir, 'probe.ps1');
writeFileSync(probePath, String.raw`
param([string]$Fixture, [string]$StopPath)
$ErrorActionPreference = 'Stop'
$global:StopFixture = Get-Content -LiteralPath $Fixture -Raw | ConvertFrom-Json
function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM class' }
  if ($Filter -eq "Name='cmd.exe'") { return $global:StopFixture.supervisor }
  if ($Filter -eq "Name='node.exe'") { return $global:StopFixture.node }
  if ($Filter -eq 'ProcessId=101') { return $global:StopFixture.currentSupervisor }
  if ($Filter -eq 'ProcessId=202') { return $global:StopFixture.currentNode }
  throw "Unexpected CIM filter: $Filter"
}
function global:Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State, [int]$LocalPort)
  return $global:StopFixture.listeners
}
function global:Stop-Process {
  [CmdletBinding()]
  param([int]$Id, [switch]$Force)
  Write-Output "MOCK_STOP:$Id"
}
foreach ($name in @('Get-CimInstance', 'Get-NetTCPConnection', 'Stop-Process')) {
  if ((Get-Command $name).CommandType -ne 'Function') { throw "Missing safety mock: $name" }
}
if ($global:StopFixture.whatIf) { & $StopPath -WhatIf } else { & $StopPath }
`, 'utf8');

const supervisor = {
  Name: 'cmd.exe', ProcessId: 101, ParentProcessId: 1,
  CreationDate: '2026-01-01T00:00:00Z',
  CommandLine: `cmd.exe /d /c set "HANA_GW_MODE=usb" && set "HANA_GW_HOST=127.0.0.1" && set "HANA_GW_PORT=24000" && call "${path.join(ROOT, 'gateway', 'supervise.cmd')}"`,
};
const node = {
  Name: 'node.exe', ProcessId: 202, ParentProcessId: 101,
  CreationDate: '2026-01-01T00:00:01Z',
  CommandLine: '"C:\\fake\\node.exe" gateway\\server.mjs',
};
let sequence = 0;
function run(overrides = {}) {
  const fixture = { supervisor, node, currentSupervisor: supervisor, currentNode: node, listeners: [], whatIf: false, ...overrides };
  const file = path.join(runDir, `fixture-${++sequence}.json`);
  writeFileSync(file, JSON.stringify(fixture), 'utf8');
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', probePath, '-Fixture', file, '-StopPath', stopPath], {
    cwd: ROOT, env: { ...process.env, HANA_GATEWAY_LOG: 'off', HANA_HOME: fakeHome }, encoding: 'utf8', timeout: 20000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return [...result.stdout.matchAll(/MOCK_STOP:(\d+)/g)].map((m) => Number(m[1]));
}
const tests = [
  ['本项目按守护、node的顺序停止', () => assert.deepEqual(run(), [101, 202])],
  ['WhatIf没有停止调用', () => assert.deepEqual(run({ whatIf: true }), [])],
  ['相对supervise路径不得认成本项目', () => {
    const relative = { ...supervisor, CommandLine: supervisor.CommandLine.replace(path.join(ROOT, 'gateway', 'supervise.cmd'), 'gateway\\supervise.cmd') };
    assert.deepEqual(run({ supervisor: relative, currentSupervisor: relative }), []);
  }],
  ['驱动器相对路径不得认成本项目', () => {
    const relative = { ...supervisor, CommandLine: supervisor.CommandLine.replace(path.join(ROOT, 'gateway', 'supervise.cmd'), `${ROOT.slice(0, 2)}gateway\\supervise.cmd`) };
    assert.deepEqual(run({ supervisor: relative, currentSupervisor: relative }), []);
  }],
  ['外部守护及端口占用者不停止', () => {
    const other = { ...supervisor, CommandLine: supervisor.CommandLine.replace('gateway\\supervise.cmd', 'other\\supervise.cmd') };
    assert.deepEqual(run({ supervisor: other, listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 24000, OwningProcess: 999 }] }), []);
  }],
  ['node PID被复用时不得停止新进程', () => assert.deepEqual(run({ currentNode: { ...node, CreationDate: '2026-01-01T00:02:00Z' } }), [101])],
  ['守护PID被复用时不得停止新守护', () => assert.equal(run({ currentSupervisor: { ...supervisor, CreationDate: '2026-01-01T00:02:00Z' } }).includes(101), false)],
  ['缺显式端口的旧受控启动仍可停止', () => {
    const legacy = { ...supervisor, CommandLine: supervisor.CommandLine.replace(' && set "HANA_GW_PORT=24000"', '') };
    assert.deepEqual(run({ supervisor: legacy, currentSupervisor: legacy }), [101, 202]);
  }],
];
let failures = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { failures++; console.error(`FAIL ${name}\n${err.stack}`); }
}
console.log(`STOP MOCK: ${tests.length} cases, ${failures} failed`);
if (failures) process.exitCode = 1;
