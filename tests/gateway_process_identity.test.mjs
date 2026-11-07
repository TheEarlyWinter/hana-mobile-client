/* 网关进程身份纯函数回归。
 *
 * 只 dot-source process-identity.ps1，喂假进程对象；
 * 不查 WMI、不查端口、不启停进程、不读真实 HANA_HOME/server-info。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'gateway', 'process-identity.ps1');
const ARTIFACTS_ROOT = path.join(__dirname, 'artifacts');
const repoRoot = ROOT;
const supervisePath = path.join(ROOT, 'gateway', 'supervise.cmd');
const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
const nodeEntry = path.join(ROOT, 'gateway', 'server.mjs');

let runDir;
let probeScript;
let counter = 0;

function supervisorLine({
  target = supervisePath,
  mode = 'usb',
  host = '127.0.0.1',
  port = 24000,
  extraSet = '',
  extraAfterCall = '',
} = {}) {
  return `cmd.exe /d /c set "HANA_GW_MODE=${mode}" && set "HANA_GW_HOST=${host}" && set "HANA_GW_PORT=${port}"${extraSet} && call "${target}"${extraAfterCall}`;
}

function legacySupervisorLine({
  target = supervisePath,
  mode = 'usb',
  host = '127.0.0.1',
  extraSet = '',
} = {}) {
  return `cmd.exe /d /c set "HANA_GW_MODE=${mode}" && set "HANA_GW_HOST=${host}"${extraSet} && call "${target}"`;
}

function managedEnvPairs(overrides = {}) {
  return {
    HANA_GW_MODE: 'usb',
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: '24000',
    HANA_GW_ALLOW_INSECURE_LAN: '',
    HANA_GW_EXTERNAL_HTTPS: '',
    HANA_GW_ALLOWED_ORIGINS: '',
    HANA_GW_TLS_CERT_FILE: '',
    HANA_GW_TLS_KEY_FILE: '',
    HANA_HOME: '',
    HANA_UPSTREAM_HOST: '',
    HANA_UPSTREAM_PORT: '',
    ...overrides,
  };
}

function nodeLine(entry = 'gateway\\server.mjs', extra = '') {
  return `"${nodeExe}" ${entry}${extra}`;
}

function processOf({
  name = 'cmd.exe',
  pid = 100,
  parent = 1,
  created = '2026-01-01T00:00:00Z',
  commandLine = supervisorLine(),
} = {}) {
  return { Name: name, ProcessId: pid, ParentProcessId: parent, CreationDate: created, CommandLine: commandLine };
}

function normalizeProcess(p) {
  return {
    Name: p.Name ?? '',
    ProcessId: Number(p.ProcessId) || 0,
    ParentProcessId: Number(p.ParentProcessId) || 0,
    CreationDate: p.CreationDate ?? null,
    CommandLine: p.CommandLine ?? '',
  };
}

async function setup() {
  await fsp.mkdir(ARTIFACTS_ROOT, { recursive: true });
  runDir = await fsp.mkdtemp(path.join(ARTIFACTS_ROOT, 'process-identity-'));
  const fakeHome = path.join(runDir, 'hana-home');
  await fsp.mkdir(fakeHome, { recursive: true });
  probeScript = path.join(runDir, 'probe.ps1');
  await fsp.writeFile(probeScript, String.raw`
param([string]$HelperPath, [string]$FixturePath)
$ErrorActionPreference = 'Stop'
. $HelperPath
$fixtures = @(Get-Content -LiteralPath $FixturePath -Raw -Encoding utf8 | ConvertFrom-Json)

function Convert-Process($p) {
  if ($null -eq $p) { return $null }
  [pscustomobject]@{
    Name = [string]$p.Name
    ProcessId = [int]$p.ProcessId
    ParentProcessId = [int]$p.ParentProcessId
    CreationDate = $p.CreationDate
    CommandLine = [string]$p.CommandLine
  }
}

$results = [System.Collections.Generic.List[object]]::new()
foreach ($data in $fixtures) {
  $raw = switch ([string]$data.action) {
  'supervisorCommand' {
    Get-GatewaySupervisorCommand -CommandLine ([string]$data.commandLine) -RepoRoot ([string]$data.repoRoot) |
      ConvertTo-Json -Compress -Depth 8
  }
  'nodeCommand' {
    Get-GatewayNodeCommand -CommandLine ([string]$data.commandLine) -RepoRoot ([string]$data.repoRoot) |
      ConvertTo-Json -Compress -Depth 8
  }
  'supervisorProcess' {
    $p = Convert-Process $data.process
    (Test-GatewaySupervisorProcess -Process $p -RepoRoot ([string]$data.repoRoot)) | ConvertTo-Json -Compress
  }
  'nodeProcess' {
    $p = Convert-Process $data.process
    $s = Convert-Process $data.supervisor
    (Test-GatewayNodeProcess -Process $p -Supervisor $s -RepoRoot ([string]$data.repoRoot)) | ConvertTo-Json -Compress
  }
  'listener' {
    $listeners = @($data.listeners | ForEach-Object {
      [pscustomobject]@{
        LocalAddress = [string]$_.LocalAddress
        LocalPort = [int]$_.LocalPort
        OwningProcess = [int]$_.OwningProcess
      }
    })
    $found = Get-GatewayOwnedListener -Listeners $listeners -NodePid ([int]$data.nodePid) -ExpectedAddress ([string]$data.expectedAddress) -Port ([int]$data.port)
    if ($null -eq $found) { 'null' } else { $found | ConvertTo-Json -Compress -Depth 5 }
  }
  'projectListener' {
    $listeners = @($data.listeners | ForEach-Object {
      [pscustomobject]@{
        LocalAddress = [string]$_.LocalAddress
        LocalPort = [int]$_.LocalPort
        OwningProcess = [int]$_.OwningProcess
      }
    })
    $found = Get-GatewayProjectListener -Listeners $listeners -NodePid ([int]$data.nodePid)
    if ($null -eq $found) { 'null' } else { $found | ConvertTo-Json -Compress -Depth 5 }
  }
  'sameSnapshot' {
    $p = Convert-Process $data.process
    $s = Convert-Process $data.snapshot
    (Test-GatewaySameProcessSnapshot -Process $p -Snapshot $s) | ConvertTo-Json -Compress
  }
  'configMatch' {
    $info = Get-GatewaySupervisorCommand -CommandLine ([string]$data.commandLine) -RepoRoot ([string]$data.repoRoot)
    $desired = [ordered]@{}
    foreach ($prop in $data.desiredPairs.PSObject.Properties) { $desired[$prop.Name] = [string]$prop.Value }
    (Test-GatewaySupervisorConfig -SupervisorInfo $info -DesiredEnvPairs $desired) | ConvertTo-Json -Compress
  }
  'newCommand' {
    try {
      $pairs = [ordered]@{}
      foreach ($prop in $data.envPairs.PSObject.Properties) { $pairs[$prop.Name] = [string]$prop.Value }
      $line = New-GatewaySupervisorCommandLine -SupervisePath ([string]$data.supervisePath) -EnvPairs $pairs
      $parsed = Get-GatewaySupervisorCommand -CommandLine $line -RepoRoot ([string]$data.repoRoot)
      [pscustomobject]@{ ok = $true; line = $line; parsed = $parsed } | ConvertTo-Json -Compress -Depth 8
    } catch {
      [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 5
    }
  }
    default { throw "unknown action: $($data.action)" }
  }
  $results.Add((ConvertFrom-Json -InputObject ([string]$raw) -AsHashtable))
}
ConvertTo-Json -InputObject ([pscustomobject]@{ results = $results.ToArray() }) -Compress -Depth 8
`, 'utf8');
  process.env.HANA_HOME = fakeHome;
}

function runProbes(fixtures) {
  const fixturePath = path.join(runDir, `fixtures-${String(++counter).padStart(3, '0')}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixtures.map((data) => ({ repoRoot, ...data }))), 'utf8');
  const result = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-File', probeScript, '-HelperPath', HELPER, '-FixturePath', fixturePath,
  ], {
    env: { ...process.env, HANA_GATEWAY_LOG: 'off', HANA_HOME: process.env.HANA_HOME },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pwsh failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  const text = String(result.stdout || '').trim();
  try {
    return JSON.parse(text).results;
  } catch {
    throw new Error(`probe output is not JSON:\n${text}\nSTDERR:\n${result.stderr}`);
  }
}

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('只接受当前仓库完整 supervise.cmd 路径和精确 call 结尾', async () => {
  const badLines = [
    `cmd.exe /d /c echo "${supervisePath}"`,
    `cmd.exe /d /c echo ${supervisePath}`,
    supervisorLine({ target: supervisePath, extraAfterCall: ' extra' }),
    supervisorLine({ target: supervisePath, extraAfterCall: ' && echo done' }),
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && call "${supervisePath}" --unexpected`,
  ];
  const results = await runProbes([
    { action: 'supervisorCommand', commandLine: supervisorLine() },
    { action: 'supervisorCommand', commandLine: supervisorLine({ target: path.join(ROOT, 'other', 'supervise.cmd') }) },
    { action: 'supervisorCommand', commandLine: supervisorLine({ target: path.join(ROOT, 'other', 'supervise.cmd') }) },
    ...badLines.map((commandLine) => ({ action: 'supervisorCommand', commandLine })),
  ]);
  const [owned, otherDir, sameName, ...badResults] = results;

  assert.equal(owned.IsOwned, true);
  assert.equal(owned.Mode, 'usb');
  assert.equal(owned.Port, 24000);
  assert.equal(owned.PortSpecified, true);
  assert.equal(otherDir.IsOwned, false);
  assert.equal(sameName.IsOwned, false);
  for (const [index, bad] of badLines.entries()) {
    assert.equal(badResults[index].IsOwned, false, bad);
  }
});

t('旧受控行唯一缺 PORT：保留 owned 但端口标未知', async () => {
  const badLines = [
    legacySupervisorLine({ extraSet: ' && set "HANA_GW_PORT="' }),
    legacySupervisorLine({ extraSet: ' && set "EVIL=1"' }),
    legacySupervisorLine({ host: '' }),
    legacySupervisorLine({ mode: 'bad' }),
    `cmd.exe /d /c echo "${supervisePath}"`,
  ];
  const results = await runProbes([
    { action: 'supervisorCommand', commandLine: legacySupervisorLine() },
    {
      action: 'supervisorCommand',
      commandLine: legacySupervisorLine({
        extraSet: ' && set "HANA_GW_ALLOWED_ORIGINS=https://a.example" && set "HANA_GW_TLS_CERT_FILE=C:\\fake\\gateway.crt" && set "HANA_GW_TLS_KEY_FILE=C:\\fake\\gateway.key" && set "HANA_UPSTREAM_PORT=23918"',
      }),
    },
    ...badLines.map((commandLine) => ({ action: 'supervisorCommand', commandLine })),
  ]);
  const [legacy, extended, ...badResults] = results;

  assert.equal(legacy.IsOwned, true);
  assert.equal(legacy.Mode, 'usb');
  assert.equal(legacy.Host, '127.0.0.1');
  assert.equal(legacy.PortSpecified, false);
  assert.equal(legacy.Port, null, '旧行不能把端口伪装成 24000');
  assert.equal(extended.IsOwned, true);
  assert.equal(extended.PortSpecified, false);
  assert.equal(extended.Port, null);
  assert.equal(extended.TlsConfigured, true);
  for (const [index, line] of badLines.entries()) {
    assert.equal(badResults[index].IsOwned, false, line);
  }
});

t('受管配置逐项精确比较：不同非空 Origin/HOME/上游/TLS 路径都不能算一致', async () => {
  const extraSet = ' && set "HANA_GW_ALLOWED_ORIGINS=https://a.example" && set "HANA_GW_TLS_CERT_FILE=C:\\fake\\gateway.crt" && set "HANA_GW_TLS_KEY_FILE=C:\\fake\\gateway.key" && set "HANA_HOME=C:\\fake\\home" && set "HANA_UPSTREAM_HOST=10.0.0.1" && set "HANA_UPSTREAM_PORT=23918"';
  const commandLine = supervisorLine({ extraSet });
  const expected = managedEnvPairs({
    HANA_GW_ALLOWED_ORIGINS: 'https://a.example',
    HANA_GW_TLS_CERT_FILE: 'C:\\fake\\gateway.crt',
    HANA_GW_TLS_KEY_FILE: 'C:\\fake\\gateway.key',
    HANA_HOME: 'C:\\fake\\home',
    HANA_UPSTREAM_HOST: '10.0.0.1',
    HANA_UPSTREAM_PORT: '23918',
  });
  const mismatches = [
    ['不同非空 Origin', { ...expected, HANA_GW_ALLOWED_ORIGINS: 'https://b.example' }],
    ['HANA_HOME', { ...expected, HANA_HOME: 'C:\\fake\\other-home' }],
    ['端口', { ...expected, HANA_GW_PORT: '24001' }],
    ['LAN 明文标记', { ...expected, HANA_GW_ALLOW_INSECURE_LAN: '1' }],
    ['外部 HTTPS 标记', { ...expected, HANA_GW_EXTERNAL_HTTPS: '1' }],
    ['上游主机', { ...expected, HANA_UPSTREAM_HOST: '10.0.0.2' }],
    ['上游端口', { ...expected, HANA_UPSTREAM_PORT: '23919' }],
    ['TLS 证书路径', { ...expected, HANA_GW_TLS_CERT_FILE: 'C:\\fake\\other.crt' }],
    ['TLS 私钥路径', { ...expected, HANA_GW_TLS_KEY_FILE: 'C:\\fake\\other.key' }],
  ];
  const results = await runProbes([
    { action: 'configMatch', commandLine, desiredPairs: expected },
    ...mismatches.map(([, desired]) => ({ action: 'configMatch', commandLine, desiredPairs: desired })),
    {
      action: 'configMatch',
      commandLine: legacySupervisorLine({ extraSet }),
      desiredPairs: expected,
    },
  ]);

  assert.equal(results[0], true, '完全相同的受管配置应一致');
  for (const [index, [name]] of mismatches.entries()) {
    assert.equal(results[index + 1], false, name);
  }
  assert.equal(results.at(-1), false, '旧守护端口未知时不能判为配置一致');
});

t('stop same-snapshot：PID 相同但创建时间不同不是同一进程', async () => {
  const snapshot = processOf();
  const [same, differentTime, differentPid, missingTime] = await runProbes([
    { action: 'sameSnapshot', process: snapshot, snapshot },
    { action: 'sameSnapshot', process: { ...snapshot, CreationDate: '2026-01-01T00:00:01Z' }, snapshot },
    { action: 'sameSnapshot', process: { ...snapshot, ProcessId: 101 }, snapshot },
    { action: 'sameSnapshot', process: { ...snapshot, CreationDate: null }, snapshot },
  ]);
  assert.equal(same, true);
  assert.equal(differentTime, false);
  assert.equal(differentPid, false);
  assert.equal(missingTime, false);
});

t('status 混合监听：先按本项目 node PID 选，不能被别项目 127 抢占', async () => {
  const listeners = [
    { LocalAddress: '127.0.0.1', LocalPort: 24000, OwningProcess: 999 },
    { LocalAddress: '100.64.0.10', LocalPort: 24000, OwningProcess: 101 },
  ];
  const [found, missing] = await runProbes([
    { action: 'projectListener', listeners, nodePid: 101 },
    { action: 'projectListener', listeners: [listeners[0]], nodePid: 101 },
  ]);
  assert.equal(found.LocalAddress, '100.64.0.10');
  assert.equal(found.OwningProcess, 101);
  assert.equal(missing, null);
});

t('受控 set 语法缺失、未知变量、重复变量、坏端口都不算 owned', async () => {
  const cases = [
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && call "${supervisePath}"`,
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && set "HANA_GW_HOST=127.0.0.1" && set "HANA_GW_PORT=24000" && set "EVIL=1" && call "${supervisePath}"`,
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && set "HANA_GW_MODE=lan" && set "HANA_GW_HOST=127.0.0.1" && set "HANA_GW_PORT=24000" && call "${supervisePath}"`,
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && set "HANA_GW_HOST=127.0.0.1" && set "HANA_GW_PORT=nope" && call "${supervisePath}"`,
    `cmd.exe /d /c set "HANA_GW_MODE=usb" && set "HANA_GW_HOST=127.0.0.1" && set "HANA_GW_PORT=0" && call "${supervisePath}"`,
  ];
  const results = await runProbes(cases.map((commandLine) => ({ action: 'supervisorCommand', commandLine })));
  for (const [index, line] of cases.entries()) {
    assert.equal(results[index].IsOwned, false, line);
  }
});

t('TLS 双文件才算配置；external https 只认 0/1', async () => {
  const [noTls, tls, half] = await runProbes([
    { action: 'newCommand', supervisePath, envPairs: {
      HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000',
      HANA_GW_TLS_CERT_FILE: '', HANA_GW_TLS_KEY_FILE: '', HANA_GW_EXTERNAL_HTTPS: '',
    } },
    { action: 'newCommand', supervisePath, envPairs: {
      HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000',
      HANA_GW_TLS_CERT_FILE: 'C:\\fake\\gateway.crt', HANA_GW_TLS_KEY_FILE: 'C:\\fake\\gateway.key',
      HANA_GW_EXTERNAL_HTTPS: '1',
    } },
    { action: 'newCommand', supervisePath, envPairs: {
      HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000',
      HANA_GW_TLS_CERT_FILE: 'C:\\fake\\gateway.crt', HANA_GW_TLS_KEY_FILE: '',
    } },
  ]);
  assert.equal(noTls.ok, true);
  assert.equal(noTls.parsed.IsOwned, true);
  assert.equal(noTls.parsed.TlsConfigured, false);
  assert.equal(noTls.parsed.ExternalHttps, false);

  assert.equal(tls.ok, true);
  assert.equal(tls.parsed.IsOwned, true);
  assert.equal(tls.parsed.TlsConfigured, true);
  assert.equal(tls.parsed.ExternalHttps, true);
  assert.equal(half.ok, false, 'TLS 只配置一半必须拒绝');
});

t('New-GatewaySupervisorCommandLine 拒绝 cmd 元字符和未知变量', async () => {
  const badPairs = [
    { HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000', HANA_GW_ALLOWED_ORIGINS: 'http://a&calc' },
    { HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000', HANA_TOKEN: 'secret' },
    { HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: '24000', HANA_GW_ALLOWED_ORIGINS: 'http://a"b' },
  ];
  const results = await runProbes([
    { action: 'newCommand', supervisePath, envPairs: { HANA_GW_MODE: 'usb', HANA_GW_HOST: '127.0.0.1' } },
    ...badPairs.map((envPairs) => ({ action: 'newCommand', supervisePath, envPairs })),
  ]);
  assert.equal(results[0].ok, false, '新启动行仍必须显式端口');
  for (const [index, pairs] of badPairs.entries()) {
    assert.equal(results[index + 1].ok, false, JSON.stringify(pairs));
  }
});

t('supervise 进程必须 Name=cmd/完整命令/有创建时间', async () => {
  const results = await runProbes([
    { action: 'supervisorProcess', process: processOf() },
    { action: 'supervisorProcess', process: processOf({ name: 'powershell.exe' }) },
    { action: 'supervisorProcess', process: processOf({ created: null }) },
    { action: 'supervisorProcess', process: processOf({ commandLine: supervisorLine({ target: path.join(ROOT, 'other', 'supervise.cmd') }) }) },
  ]);
  assert.deepEqual(results, [true, false, false, false]);
});

t('node 只接受本项目 entry：绝对路径或 owned supervise 下的相对 gateway/server.mjs', async () => {
  const badLines = [
    nodeLine(path.join(ROOT, 'other', 'server.mjs')),
    nodeLine('gateway\\other.mjs'),
    nodeLine('..\\other\\gateway\\server.mjs'),
    nodeLine('gateway\\server.mjs', ' --extra'),
    `"${nodeExe}" --inspect gateway\\server.mjs`,
    `cmd.exe /c echo "${nodeEntry}"`,
  ];
  const [relative, absolute, ...badResults] = await runProbes([
    { action: 'nodeCommand', commandLine: nodeLine() },
    { action: 'nodeCommand', commandLine: nodeLine(nodeEntry) },
    ...badLines.map((commandLine) => ({ action: 'nodeCommand', commandLine })),
  ]);
  assert.equal(relative.IsOwned, true);
  assert.equal(relative.IsAbsolute, false);
  assert.equal(absolute.IsOwned, true);
  assert.equal(absolute.IsAbsolute, true);
  for (const [index, line] of badLines.entries()) {
    assert.equal(badResults[index].IsOwned, false, line);
  }
});

t('node 进程必须父链到 owned supervise，且创建时间不早于父进程', async () => {
  const s = processOf();
  const n = processOf({ name: 'node.exe', pid: 101, parent: 100, created: '2026-01-01T00:00:02Z', commandLine: nodeLine() });
  const legacySupervisor = processOf({ commandLine: legacySupervisorLine() });
  const legacyNode = processOf({ name: 'node.exe', pid: 102, parent: 100, created: '2026-01-01T00:00:02Z', commandLine: nodeLine() });
  const results = await runProbes([
    { action: 'nodeProcess', process: n, supervisor: s },
    { action: 'nodeProcess', process: { ...n, ParentProcessId: 999 }, supervisor: s },
    { action: 'nodeProcess', process: { ...n, CreationDate: '2025-12-31T23:59:59Z' }, supervisor: s },
    { action: 'nodeProcess', process: { ...n, CreationDate: null }, supervisor: s },
    { action: 'nodeProcess', process: legacyNode, supervisor: legacySupervisor },
  ]);
  assert.deepEqual(results, [true, false, false, false, true], '旧守护下的本项目 node 仍须可被安全识别');
});

t('listener 只认指定 node PID + 端口 + 期望地址', async () => {
  const listeners = [
    { Name: 'node.exe', ProcessId: 101, ParentProcessId: 100, CreationDate: '2026-01-01T00:00:02Z', CommandLine: nodeLine(), LocalAddress: '127.0.0.1', LocalPort: 24000, OwningProcess: 101 },
    { Name: 'node.exe', ProcessId: 101, ParentProcessId: 100, CreationDate: '2026-01-01T00:00:02Z', CommandLine: nodeLine(), LocalAddress: '0.0.0.0', LocalPort: 24000, OwningProcess: 101 },
  ];
  const results = await runProbes([
    { action: 'listener', listeners, nodePid: 101, expectedAddress: '127.0.0.1', port: 24000 },
    { action: 'listener', listeners, nodePid: 999, expectedAddress: '127.0.0.1', port: 24000 },
    { action: 'listener', listeners, nodePid: 101, expectedAddress: '127.0.0.1', port: 24001 },
    { action: 'listener', listeners, nodePid: 101, expectedAddress: '192.0.2.10', port: 24000 },
  ]);
  assert.equal(results[0].LocalAddress, '127.0.0.1');
  assert.deepEqual(results.slice(1), [null, null, null]);
});

let bad = 0;
try {
  await setup();
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      bad += 1;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
} catch (err) {
  bad += 1;
  console.log(`FAIL  setup\n      ${err.stack || err.message}`);
} finally {
  console.log(`artifacts kept at ${runDir}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
