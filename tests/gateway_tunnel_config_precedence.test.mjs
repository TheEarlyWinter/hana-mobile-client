/* tunnel.ps1 的 CLI / 配置文件优先级回归（O6）。
 *
 * 契约：显式写在命令行上的 -VpsHost/-VpsPort/-VpsUser/-KeyPath/-RemotePort/-LocalPort 优先；
 * 没显式绑定的字段才从 -Config 读；cfg 也没有的字段沿用既有默认（vpsPort=22、localPort=24000）。
 * 另外：显式写了非法值必须被校验拒绝，不能被一个合法的 cfg 悄悄盖成合法值。
 *
 * 做法：spawn 真实 tunnel.ps1 -CheckOnly，读它打印的 run.cmd 正文，断言其中那条 ssh 命令用的值。
 * 不 -Detach、不碰 WMI/SSH：-CheckOnly 在写文件/起进程之前就 exit。
 * 配置与私钥全部是本次 artifacts 下的假文件，不读任何真实配置。
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

let runDir = null;

function setup() {
  if (runDir) return runDir;
  assert.ok(PS, '本回归只在 Windows + pwsh 下跑');
  runDir = fs.mkdtempSync(path.join(ARTIFACTS, 'tunnel-precedence-'));

  // 两个不同的假私钥：只用于通过 Test-Path 与 cmd 元字符检查，不会被读取。
  fs.writeFileSync(path.join(runDir, 'cli-key.pem'), 'CLI-KEY-PLACEHOLDER');
  fs.writeFileSync(path.join(runDir, 'cfg-key.pem'), 'CFG-KEY-PLACEHOLDER');
  return runDir;
}

function keyPath(name) {
  return path.join(setup(), name);
}

/** 写一个假 remote 配置；字段按需给。 */
function writeCfg(name, cfg) {
  const file = path.join(setup(), name);
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
  return file;
}

function runCheckOnly(args) {
  const child = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-File', TUNNEL, '-CheckOnly', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  return {
    status: child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    text: `${child.stdout || ''}\n${child.stderr || ''}`,
  };
}

/** 打印出来的 run.cmd 正文里那条 ssh 命令。 */
function sshLine(result) {
  return result.stdout.split(/\r?\n/).find((line) => line.includes('-o BatchMode=yes')) || '';
}

let bad = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('显式 CLI 全部优先，cfg 的六个字段都不生效', () => {
  const cfg = writeCfg('cfg-full-for-cli.json', {
    vpsHost: '198.51.100.10',
    vpsPort: 2200,
    vpsUser: 'cfguser',
    keyPath: keyPath('cfg-key.pem'),
    remotePort: 24011,
    localPort: 24012,
  });

  const res = runCheckOnly([
    '-Config', cfg,
    '-VpsHost', '203.0.113.9',
    '-VpsPort', '2222',
    '-VpsUser', 'cliuser',
    '-KeyPath', keyPath('cli-key.pem'),
    '-RemotePort', '24001',
    '-LocalPort', '24000',
  ]);
  assert.equal(res.status, 0, `应校验通过：\n${res.text}`);

  const line = sshLine(res);
  assert.ok(line, `run.cmd 正文里没有 ssh 命令：\n${res.stdout}`);

  assert.ok(line.includes(`-i "${keyPath('cli-key.pem')}"`), `私钥应取 CLI 值：${line}`);
  assert.ok(line.includes('-p 2222'), `端口应取 CLI 值：${line}`);
  assert.ok(line.includes('"cliuser@203.0.113.9"'), `user@host 应取 CLI 值：${line}`);
  assert.ok(line.includes('-R 127.0.0.1:24001:127.0.0.1:24000'), `-R 应取 CLI 值：${line}`);

  for (const leaked of ['cfguser', '198.51.100.10', 'cfg-key.pem', '-p 2200', '24011', '24012']) {
    assert.equal(line.includes(leaked), false, `cfg 的值 ${leaked} 不该出现在 ssh 命令里：${line}`);
  }
});

t('只绑部分 CLI：未绑定的字段从 cfg 继承', () => {
  const cfg = writeCfg('cfg-full-for-inherit.json', {
    vpsHost: '198.51.100.10',
    vpsPort: 2200,
    vpsUser: 'cfguser',
    keyPath: keyPath('cfg-key.pem'),
    remotePort: 24011,
    localPort: 24012,
  });

  const res = runCheckOnly(['-Config', cfg, '-VpsUser', 'cliuser2']);
  assert.equal(res.status, 0, `应校验通过：\n${res.text}`);

  const line = sshLine(res);
  assert.ok(line, `run.cmd 正文里没有 ssh 命令：\n${res.stdout}`);
  assert.ok(line.includes('"cliuser2@198.51.100.10"'), `user 取 CLI、host 取 cfg：${line}`);
  assert.ok(line.includes('-p 2200'), `端口未绑定应取 cfg：${line}`);
  assert.ok(line.includes(`-i "${keyPath('cfg-key.pem')}"`), `私钥未绑定应取 cfg：${line}`);
  assert.ok(line.includes('-R 127.0.0.1:24011:127.0.0.1:24012'), `-R 未绑定应取 cfg：${line}`);
});

t('cfg 缺字段时沿用既有默认（vpsPort=22、localPort=24000）', () => {
  const cfg = writeCfg('cfg-partial.json', {
    vpsHost: '198.51.100.10',
    vpsUser: 'cfguser',
    keyPath: keyPath('cfg-key.pem'),
    remotePort: 24001,
  });

  const res = runCheckOnly(['-Config', cfg]);
  assert.equal(res.status, 0, `应校验通过：\n${res.text}`);

  const line = sshLine(res);
  assert.ok(line, `run.cmd 正文里没有 ssh 命令：\n${res.stdout}`);
  assert.ok(line.includes('-p 22'), `vpsPort 缺省应为 22：${line}`);
  assert.ok(line.includes('-R 127.0.0.1:24001:127.0.0.1:24000'), `localPort 缺省应为 24000：${line}`);
});

t('显式非法 host 必须被拒绝，不能被合法 cfg 覆盖', () => {
  const cfg = writeCfg('cfg-valid-mask.json', {
    vpsHost: '198.51.100.10',
    vpsPort: 2200,
    vpsUser: 'cfguser',
    keyPath: keyPath('cfg-key.pem'),
    remotePort: 24011,
    localPort: 24012,
  });

  const res = runCheckOnly([
    '-Config', cfg,
    '-VpsHost', 'evil.example&calc',
    '-KeyPath', keyPath('cli-key.pem'),
  ]);

  assert.notEqual(res.status, 0, `显式非法 host 必须报错退出，实际退出码 ${res.status}：\n${res.text}`);
  // 只看 ASCII 关键词：控制台重定向时中文可能被转成另一套编码，断言字符会不稳定。
  assert.match(res.text, /vpsHost/, `应报 vpsHost 含非法字符：\n${res.text}`);
  assert.equal(sshLine(res), '', '拒绝之后不得打印 run.cmd 正文');
});

// 本机没有 ssh.exe 时 -CheckOnly 会在校验收尾处先抛错；那种环境跑不了这组断言。
const sshPresent = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
  '(Get-Command ssh -ErrorAction SilentlyContinue) -ne $null'], { encoding: 'utf8' }).stdout.trim() === 'True';

if (!sshPresent) {
  console.log('SKIP  本机没有 ssh.exe，tunnel.ps1 -CheckOnly 无法校验，跳过 4 项');
} else {
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      bad += 1;
      console.log(`FAIL  ${name}\n      ${String(err.message || err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
}

console.log(`\nartifacts: ${runDir || '(未运行)'}`);
if (bad) {
  console.log(`${bad} 个用例失败`);
  process.exitCode = 1;
}
