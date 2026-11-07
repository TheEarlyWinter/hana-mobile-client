/* 网关配置输入的边界回归：allowedOrigins 单项语义、隧道脚本的 cmd 注入面。
 *
 * 覆盖：
 * - validateAllowedOrigin：每一项只能是"恰好一个 Origin"（不含逗号/路径/查询/片段/空白/userinfo）
 * - parseAllowedOrigins 严格模式（网关启动失败），非严格模式（丢弃非法项）
 * - security-policy.mjs 的 --check-origins CLI 与 start.ps1 共用同一份校验
 * - start.ps1 -CheckOnly：单项含逗号必须启动失败；合法配置注入规范化值 + HANA_GW_EXTERNAL_HTTPS
 * - tunnel.ps1 -CheckOnly：vpsHost/vpsUser/keyPath 白名单，非法值直接报错退出；
 *   生成的 run.cmd 给路径和 user@host 加引号
 *
 * 这些脚本只在 -CheckOnly 下运行：不碰 WMI、不启动进程、不写 run.cmd。
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { parseAllowedOrigins, validateAllowedOrigin } from '../gateway/security-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GW_DIR = path.join(ROOT, 'gateway');
const SERVER = path.join(GW_DIR, 'server.mjs');
const POLICY = path.join(GW_DIR, 'security-policy.mjs');
const START_PS1 = path.join(GW_DIR, 'start.ps1');
const TUNNEL_PS1 = path.join(GW_DIR, 'tunnel.ps1');
const PS = process.platform === 'win32' ? 'pwsh' : null;

let tmpRoot;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitTcp(port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`gateway 未就绪（port ${port}）`));
        else setTimeout(attempt, 80);
      });
    };
    attempt();
  });
}

function run(exe, args, { stdin = '', timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`超时：${exe} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(stdin);
  });
}

/** 起一个真网关并等它就绪；返回 { port, child, stop }。 */
async function startGateway(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, HANA_GATEWAY_LOG: 'off', HANA_GW_HOST: '127.0.0.1', HANA_GW_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    log += c.toString('utf8');
  });
  try {
    await waitTcp(port);
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n${log}`);
  }
  return {
    port,
    child,
    log: () => log,
    stop: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** 起网关并等它自己退出（启动失败路径）。 */
function startGatewayExpectingExit(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, HANA_GATEWAY_LOG: 'off', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (c) => {
      log += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      log += c.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, log }));
  });
}

function baseEnv() {
  const env = { ...process.env };
  for (const key of [
    'HANA_GW_ALLOWED_ORIGINS',
    'HANA_GW_EXTERNAL_HTTPS',
    'HANA_GW_ALLOW_INSECURE_LAN',
    'HANA_GW_TLS_CERT_FILE',
    'HANA_GW_TLS_KEY_FILE',
  ]) {
    delete env[key];
  }
  return env;
}

async function writeJson(name, value) {
  const file = path.join(tmpRoot, name);
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('validateAllowedOrigin：只接受恰好一个 Origin', () => {
  const ok = [
    ['https://a.example', 'https://a.example'],
    ['  http://a.example:8080  ', 'http://a.example:8080'],
    ['https://A.Example/', 'https://a.example'],
    ['http://127.0.0.1:24000', 'http://127.0.0.1:24000'],
    ['http://[::1]:24000', 'http://[::1]:24000'],
  ];
  for (const [input, expected] of ok) {
    const result = validateAllowedOrigin(input);
    assert.equal(result.ok, true, `${input} 应通过`);
    assert.equal(result.origin, expected, `${input} 应规范化成 ${expected}`);
  }

  const bad = [
    ['https://a.example,https://evil.example', 'comma'],
    ['https://a.example,evil.example', 'comma'],
    [',https://a.example', 'comma'],
    ['https://a.example/', 'trailing-slash-ok-should-not-happen'],
    ['https://a.example/path', 'path'],
    ['https://a.example?x=1', 'query'],
    ['https://a.example#frag', 'fragment'],
    ['https://user:pass@a.example', 'userinfo'],
    ['ftp://a.example', 'scheme'],
    ['a.example', 'relative'],
    ['', 'empty'],
    ['https://a.example\\evil', 'backslash'],
    ['https://a.example\tevil', 'whitespace'],
    ['https://a.example, ', 'comma'],
    [null, 'not_a_string'],
    [42, 'not_a_string'],
  ];
  for (const [input, reason] of bad) {
    if (reason === 'trailing-slash-ok-should-not-happen') continue;
    const result = validateAllowedOrigin(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} 必须被拒绝`);
    if (reason !== 'relative') assert.equal(result.reason, reason, `${JSON.stringify(input)} 的拒绝原因`);
  }
});

t('parseAllowedOrigins：严格模式遇到非法项直接抛错，宽松模式丢弃', () => {
  const loose = parseAllowedOrigins('https://a.example,not-an-origin,https://b.example');
  assert.deepEqual([...loose].sort(), ['https://a.example', 'https://b.example']);

  assert.throws(
    () => parseAllowedOrigins('https://a.example,not-an-origin', { strict: true }),
    /invalid allowed origin/,
  );
  // 规范化后仍可用：尾斜杠/大小写被折叠
  const normalized = parseAllowedOrigins('HTTPS://A.EXAMPLE/', { strict: true });
  assert.deepEqual([...normalized], ['https://a.example']);
  // 空项（多余逗号、末尾逗号）不算非法配置
  assert.deepEqual([...parseAllowedOrigins('https://a.example,,', { strict: true })], ['https://a.example']);
});

t('security-policy CLI --check-origins：单项含逗号非零退出，合法项输出规范化列表', async () => {
  const badCase = await run(process.execPath, [POLICY, '--check-origins'], {
    stdin: 'https://a.example,https://evil.example\n',
  });
  assert.notEqual(badCase.code, 0, '单项含逗号必须是失败退出');
  assert.match(`${badCase.out}${badCase.err}`, /comma|非法|invalid/i);

  const okCase = await run(process.execPath, [POLICY, '--check-origins'], {
    stdin: 'HTTPS://A.EXAMPLE/\nhttps://b.example:8443\n',
  });
  assert.equal(okCase.code, 0, okCase.err);
  assert.equal(okCase.out.trim(), 'https://a.example,https://b.example:8443');

  const badLine = await run(process.execPath, [POLICY, '--check-origins'], {
    stdin: 'https://a.example\ngopher://b.example\n',
  });
  assert.notEqual(badLine.code, 0);
});

t('网关启动：HANA_GW_ALLOWED_ORIGINS 有非法项直接失败，不回退成放行', async () => {
  const bad = await startGatewayExpectingExit({
    ...baseEnv(),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: String(await freePort()),
    HANA_GW_ALLOWED_ORIGINS: 'https://a.example,not-an-origin',
  });
  assert.notEqual(bad.code, 0, `应启动失败：\n${bad.log}`);
  assert.match(bad.log, /HANA_GW_ALLOWED_ORIGINS/);
  assert.match(bad.log, /invalid allowed origin|非法/);

  const gw = await startGateway({ HANA_GW_ALLOWED_ORIGINS: 'HTTPS://A.EXAMPLE/' });
  try {
    assert.match(gw.log(), /gateway listening/);
  } finally {
    gw.stop();
  }
});

t('start.ps1 -CheckOnly：单项含逗号判为非法并退出，不启动守护', async () => {
  if (!PS) return;
  const bad = await writeJson('remote-bad.json', {
    publicBaseUrl: 'https://a.example/',
    allowedOrigins: ['https://a.example,https://evil.example'],
  });
  const badRun = await run(PS, ['-NoProfile', '-NonInteractive', '-File', START_PS1, '-Mode', 'tunnel', '-RemoteJson', bad, '-CheckOnly']);
  assert.notEqual(badRun.code, 0, `非法 allowedOrigins 必须启动失败：\n${badRun.out}\n${badRun.err}`);
  assert.match(`${badRun.out}${badRun.err}`, /allowedOrigins/);

  const badPath = await writeJson('remote-path.json', {
    publicBaseUrl: 'https://a.example/',
    allowedOrigins: ['https://a.example/app'],
  });
  const pathRun = await run(PS, ['-NoProfile', '-NonInteractive', '-File', START_PS1, '-Mode', 'tunnel', '-RemoteJson', badPath, '-CheckOnly']);
  assert.notEqual(pathRun.code, 0, '带路径的 Origin 必须启动失败');
});

t('start.ps1 -CheckOnly：tunnel 模式注入规范化 Origin 与 HANA_GW_EXTERNAL_HTTPS=1', async () => {
  if (!PS) return;
  const good = await writeJson('remote-good.json', {
    publicBaseUrl: 'https://hana.example/',
    allowedOrigins: ['HTTPS://HANA.EXAMPLE/'],
  });
  const res = await run(PS, ['-NoProfile', '-NonInteractive', '-File', START_PS1, '-Mode', 'tunnel', '-RemoteJson', good, '-CheckOnly']);
  assert.equal(res.code, 0, `${res.out}\n${res.err}`);
  assert.match(res.out, /HANA_GW_ALLOWED_ORIGINS=https:\/\/hana\.example/);
  assert.match(res.out, /HANA_GW_EXTERNAL_HTTPS=1/);
  assert.match(res.out, /-CheckOnly|未启动/);

  // 非 tunnel 模式不注入这两个变量
  const usb = await run(PS, ['-NoProfile', '-NonInteractive', '-File', START_PS1, '-Mode', 'usb', '-CheckOnly']);
  assert.equal(usb.code, 0, `${usb.out}\n${usb.err}`);
  assert.doesNotMatch(usb.out, /HANA_GW_EXTERNAL_HTTPS/);
  assert.doesNotMatch(usb.out, /HANA_GW_ALLOWED_ORIGINS/);
});

t('tunnel.ps1 -CheckOnly：vpsHost/vpsUser/keyPath 拒绝 cmd 元字符与相对路径', async () => {
  if (!PS) return;
  const keyFile = path.join(tmpRoot, 'id_ed25519');
  await fsp.writeFile(keyFile, 'PRIVATE-KEY-PLACEHOLDER');

  const cases = [
    ['host-amp', { vpsHost: 'evil.example&calc', vpsUser: 'root', keyPath: keyFile, remotePort: 24001 }],
    ['host-pipe', { vpsHost: 'evil.example|calc', vpsUser: 'root', keyPath: keyFile, remotePort: 24001 }],
    ['user-pipe', { vpsHost: 'evil.example', vpsUser: 'root|x', keyPath: keyFile, remotePort: 24001 }],
    ['user-quote', { vpsHost: 'evil.example', vpsUser: 'ro"ot', keyPath: keyFile, remotePort: 24001 }],
    ['key-relative', { vpsHost: 'evil.example', vpsUser: 'root', keyPath: 'id_ed25519', remotePort: 24001 }],
    ['key-missing', { vpsHost: 'evil.example', vpsUser: 'root', keyPath: path.join(tmpRoot, 'nope'), remotePort: 24001 }],
    ['remote-port', { vpsHost: 'evil.example', vpsUser: 'root', keyPath: keyFile, remotePort: 70000 }],
  ];
  for (const [name, cfg] of cases) {
    const file = await writeJson(`tunnel-${name}.json`, cfg);
    const res = await run(PS, ['-NoProfile', '-NonInteractive', '-File', TUNNEL_PS1, '-Config', file, '-CheckOnly']);
    assert.notEqual(res.code, 0, `${name} 必须被拒绝：\n${res.out}\n${res.err}`);
  }

  // 名字里带 % 的真实文件：文件存在，但 % 会被 cmd 当变量展开
  const percentKey = path.join(tmpRoot, 'key%TEMP%.pem');
  await fsp.writeFile(percentKey, 'PRIVATE-KEY-PLACEHOLDER');
  const percentFile = await writeJson('tunnel-key-percent.json', {
    vpsHost: 'evil.example',
    vpsUser: 'root',
    keyPath: percentKey,
    remotePort: 24001,
  });
  const percentRun = await run(PS, ['-NoProfile', '-NonInteractive', '-File', TUNNEL_PS1, '-Config', percentFile, '-CheckOnly']);
  assert.notEqual(percentRun.code, 0, 'keyPath 含 % 必须被拒绝');
});

t('tunnel.ps1 -CheckOnly：合法配置生成带引号的 run.cmd，不启动进程', async () => {
  if (!PS) return;
  const keyFile = path.join(tmpRoot, 'id ed25519');
  await fsp.writeFile(keyFile, 'PRIVATE-KEY-PLACEHOLDER');
  const cfgFile = await writeJson('tunnel-good.json', {
    vpsHost: '203.0.113.9',
    vpsPort: 2222,
    vpsUser: 'hana_tunnel',
    keyPath: keyFile,
    remotePort: 24001,
    localPort: 24000,
  });
  const before = await fsp.readdir(path.join(os.tmpdir(), 'hana-tunnel')).catch(() => []);
  const res = await run(PS, ['-NoProfile', '-NonInteractive', '-File', TUNNEL_PS1, '-Config', cfgFile, '-CheckOnly']);
  assert.equal(res.code, 0, `${res.out}\n${res.err}`);

  const body = res.out;
  assert.ok(body.includes(`-i "${keyFile}"`), `keyPath 必须带引号：\n${body}`);
  assert.ok(body.includes('"hana_tunnel@203.0.113.9"'), `user@host 必须带引号：\n${body}`);
  assert.ok(body.includes('-p 2222'), '端口原样写入');
  assert.ok(body.includes('-R 127.0.0.1:24001:127.0.0.1:24000'), '反向转发目标原样写入');

  const after = await fsp.readdir(path.join(os.tmpdir(), 'hana-tunnel')).catch(() => []);
  assert.deepEqual(after, before, '-CheckOnly 不应创建 hana-tunnel 运行目录');
});

/* ---- 运行 ---- */

let bad = 0;
try {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-cfg-'));
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
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
