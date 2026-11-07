/* 启动/状态/停止脚本的静态所有权回归。
 *
 * 不执行 start.ps1 / status.ps1 / stop.ps1；
 * 只读源码并检查它们调用纯身份 helper、没有旧的 *supervise* 泛匹配、没有 HANA_TOKEN。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const START = path.join(ROOT, 'gateway', 'start.ps1');
const STATUS = path.join(ROOT, 'gateway', 'status.ps1');
const STOP = path.join(ROOT, 'gateway', 'stop.ps1');
const HELPER = path.join(ROOT, 'gateway', 'process-identity.ps1');

function source(file) {
  assert.equal(existsSync(file), true, `缺少文件：${file}`);
  return readFileSync(file, 'utf8');
}

function assertNoWildSupervise(text, name) {
  assert.doesNotMatch(text, /\*supervise\*/i, `${name} 不得使用 *supervise* 泛匹配`);
  assert.doesNotMatch(text, /CommandLine\s+-like\s+['"][^'"]*supervise/i, `${name} 不得用 CommandLine -like 匹配 supervise`);
}

let bad = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('process-identity.ps1 是独立纯 helper，不读取真实进程/配置', () => {
  const helper = source(HELPER);
  for (const fn of [
    'Get-GatewaySupervisorCommand',
    'Get-GatewayNodeCommand',
    'Test-GatewaySupervisorProcess',
    'Test-GatewayNodeProcess',
    'Get-GatewayOwnedListener',
    'New-GatewaySupervisorCommandLine',
  ]) {
    assert.match(helper, new RegExp(`function\\s+${fn}\\b`), `helper 缺少 ${fn}`);
  }
  assert.doesNotMatch(helper, /Get-CimInstance|Get-NetTCPConnection|Invoke-CimMethod|Get-Process\b|Stop-Process\b/);
  assert.doesNotMatch(helper, /HANA_TOKEN/i);
});

t('start 使用完整路径/受控语法 helper，且显式传递受管环境变量', () => {
  const text = source(START);
  assertNoWildSupervise(text, 'start.ps1');
  for (const token of [
    'process-identity.ps1',
    'New-GatewaySupervisorCommandLine',
    'Test-GatewaySupervisorProcess',
    'Test-GatewaySupervisorConfig',
    'PortSpecified',
    'Get-GatewayOwnedListener',
    'HANA_GW_PORT',
    'HANA_GW_EXTERNAL_HTTPS',
    'HANA_GW_ALLOWED_ORIGINS',
    'HANA_GW_TLS_CERT_FILE',
    'HANA_GW_TLS_KEY_FILE',
    'HANA_HOME',
    'HANA_UPSTREAM_HOST',
    'HANA_UPSTREAM_PORT',
  ]) {
    assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `start 缺少 ${token}`);
  }
  assert.doesNotMatch(text, /HANA_TOKEN/i);
  assert.doesNotMatch(text, /\$info\.AllowedOrigins\s+-or/);
  assert.match(text, /旧版本项目守护/);
  assert.match(text, /get-netTCPConnection|Test-TcpListening/i, 'start 需要检查端口占用');
});

t('status 只通过 owner helper 识别进程，并显示实际监听', () => {
  const text = source(STATUS);
  assertNoWildSupervise(text, 'status.ps1');
  for (const token of [
    'process-identity.ps1',
    'Get-GatewaySupervisorCommand',
    'Get-GatewaySupervisorProcesses',
    'Get-GatewayOwnedListener',
    'PortSpecified',
    'Get-GatewayProjectListener',
    'Get-NodeListenRows',
    'LocalAddress',
    'LocalPort',
  ]) {
    assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `status 缺少 ${token}`);
  }
  assert.doesNotMatch(text, /HANA_TOKEN/i);
  assert.match(text, /旧版启动行/);
});

t('stop 只停本项目 owner 进程，支持 WhatIf，未知占用者不杀', () => {
  const text = source(STOP);
  assertNoWildSupervise(text, 'stop.ps1');
  assert.match(text, /SupportsShouldProcess|\[switch\]\$WhatIf/i);
  assert.match(text, /Test-GatewaySupervisorProcess/);
  assert.match(text, /Test-GatewayNodeProcess/);
  assert.match(text, /Test-GatewaySameProcessSnapshot/);
  assert.match(text, /Stop-Process/);
  assert.doesNotMatch(text, /HANA_TOKEN/i);
});

t('三个入口都 dot-source 同一个 helper，不各自复制身份正则', () => {
  for (const [name, file] of [['start', START], ['status', STATUS], ['stop', STOP]]) {
    const text = source(file);
    assert.match(text, /process-identity\.ps1/, `${name} 未引用 helper`);
  }
});

try {
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      bad += 1;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
} catch (err) {
  bad += 1;
  console.log(`FAIL  setup\n      ${err.stack || err.message}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
