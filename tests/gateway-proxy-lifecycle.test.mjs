/* 网关转发链路生命周期回归：连接断开、上游中断、WS 升级与 hop-by-hop/认证响应上限。
 *
 * 覆盖：
 * - P1-3 客户端断开 → 网关销毁上游请求（不挂到 idle timeout）
 * - P1-3 上游响应中途断开 → 客户端看到中止而不是挂死，网关进程不崩
 * - P1-4 WS 鉴权 await 期间客户端断开 → 不连上游 WS
 * - P1-4 WS 上游迟迟不返回 101 → 超时 504，两端 socket 收尾
 * - P2 hop-by-hop 头：请求/响应两侧剥离（含 Connection 点名的动态字段）
 * - P2 /api/web-auth/session 响应体上限：超限销毁并按不可用拒绝
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { stripHopByHopHeaders } from '../gateway/security-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.HANA_GW_SERVER_PATH
  ? path.resolve(process.env.HANA_GW_SERVER_PATH)
  : path.join(ROOT, 'gateway', 'server.mjs');

const VALID_COOKIE = 'hana_session=valid';
const HUGE_COOKIE = 'hana_session=huge';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 4000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return Boolean(fn());
}

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

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
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

/** 只关心"响应有没有被中止"，所以成功/失败都 resolve。 */
function rawGet(port, rawPath, { headers = {}, method = 'GET', body = null, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const h = { connection: 'close', ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h }, (res) => {
      const chunks = [];
      let aborted = false;
      res.on('data', (c) => chunks.push(c));
      res.on('aborted', () => {
        aborted = true;
      });
      res.on('error', () => {
        aborted = true;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, aborted, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('close', () => {
        if (!res.complete) {
          aborted = true;
          resolve({ status: res.statusCode || 0, aborted, headers: res.headers, body: Buffer.concat(chunks) });
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`client timeout ${rawPath}`)));
    req.on('error', (err) => resolve({ status: 0, aborted: true, error: err.message, headers: {}, body: Buffer.alloc(0) }));
    req.end(body == null ? undefined : body);
  });
}

function rawUpgrade(port, { rawPath = '/ws', headers = {}, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        [
          `GET ${rawPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n'),
      );
    });
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    sock.on('data', (c) => {
      data += c.toString('utf8');
    });
    sock.once('close', finish);
    sock.once('error', finish);
    sock.setTimeout(timeoutMs, () => {
      finish();
      sock.destroy();
    });
  });
}

function statusOf(raw) {
  const match = String(raw).match(/^HTTP\/1\.1 (\d{3})/);
  return match ? Number(match[1]) : 0;
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let okPng;
let upstream;
let upstreamPort;
let gw;
const gateways = [];

const state = {
  authDelayMs: 0,
  neverOpened: 0,
  neverClosed: false,
  upgradeHits: [],
  echoHeaders: null,
  stalled: [],
};

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-life-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  const sessionFiles = path.join(hanaHome, 'session-files');
  await fsp.mkdir(sessionFiles, { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });
  okPng = path.join(sessionFiles, 'ok.png');
  await fsp.writeFile(okPng, TINY_PNG);
}

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/web-auth/session') {
      const cookie = req.headers.cookie || '';
      const send = () => {
        if (res.destroyed || res.writableEnded) return;
        if (cookie.includes(HUGE_COOKIE)) {
          // 合法 JSON + 超大填充：修复前会被当成 authenticated=true 放行
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ authenticated: true, principal: { kind: 'local_user' }, pad: 'x'.repeat(128 * 1024) }));
          return;
        }
        const authenticated = cookie.includes(VALID_COOKIE);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ authenticated, principal: authenticated ? { kind: 'local_user' } : null }));
      };
      if (state.authDelayMs > 0) setTimeout(send, state.authDelayMs);
      else send();
      return;
    }

    if (url.pathname === '/api/never') {
      state.neverOpened += 1;
      state.neverClosed = false;
      req.socket.on('close', () => {
        state.neverClosed = true;
      });
      return; // 永不响应
    }

    if (url.pathname === '/api/truncated') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': '200' });
      res.write('partial-body-');
      // 直接掐 socket（而不是 res.destroy）：上游给的是 RST，
      // 网关那侧会收到 IncomingMessage 的 'error'，不接住就是未捕获异常
      setTimeout(() => {
        req.socket.destroy();
      }, 30);
      return;
    }

    if (url.pathname === '/api/hop') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'keep-alive, x-hop',
        'x-hop': '1',
        'keep-alive': 'timeout=5',
        trailer: 'x-trailer',
        upgrade: 'h2c',
        'proxy-authenticate': 'Basic realm="x"',
      });
      res.end('HOP');
      return;
    }

    if (url.pathname === '/api/echo' && req.method === 'POST') {
      state.echoHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  upstream.on('upgrade', (req, socket) => {
    state.upgradeHits.push({ url: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('stall') === '1') {
      state.stalled.push(socket);
      socket.on('error', () => {});
      return; // 连上但永不回应升级结果
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n',
    );
    socket.end();
  });

  upstreamPort = await listen(upstream);
}

function gatewayEnv(overrides = {}) {
  const env = {
    ...process.env, HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upstreamPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_LOG_WS: '',
  };
  for (const key of [
    'HANA_GW_ALLOWED_ORIGINS',
    'HANA_GW_ALLOW_INSECURE_LAN',
    'HANA_GW_TLS_CERT_FILE',
    'HANA_GW_TLS_KEY_FILE',
    'HANA_GW_EXTERNAL_HTTPS',
    'HANA_GW_WS_UPSTREAM_TIMEOUT_MS',
  ]) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

async function startGateway(overrides = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: gatewayEnv({ HANA_GW_PORT: String(port), ...overrides }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    log += c.toString('utf8');
  });
  const entry = { port, child, log: () => log, stop: () => child.exitCode === null && child.kill() };
  gateways.push(entry);
  try {
    await waitTcp(port);
  } catch (err) {
    throw new Error(`${err.message}\n${log}`);
  }
  return entry;
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('stripHopByHopHeaders：静态头与 Connection 点名的动态字段都剥掉，其余保留', () => {
  const stripped = stripHopByHopHeaders({
    connection: 'keep-alive, x-custom',
    'x-custom': 'drop-me',
    'keep-alive': 'timeout=5',
    te: 'trailers',
    trailer: 'x-trailer',
    'transfer-encoding': 'chunked',
    upgrade: 'h2c',
    'proxy-authenticate': 'Basic realm="x"',
    'content-type': 'application/json',
    'x-keep': 'keep-me',
  });
  assert.deepEqual(stripped, { 'content-type': 'application/json', 'x-keep': 'keep-me' });

  // WS 升级握手需要 connection/upgrade，由调用方显式保留
  const upgraded = stripHopByHopHeaders({ connection: 'Upgrade', upgrade: 'websocket', host: 'a' }, { keepUpgrade: true });
  assert.deepEqual(upgraded, { connection: 'Upgrade', upgrade: 'websocket', host: 'a' });
});

t('客户端断开：网关销毁上游请求，而不是挂到 idle timeout', async () => {
  const before = state.neverOpened;
  const sock = net.connect(gw.port, '127.0.0.1', () => {
    sock.write(`GET /api/never HTTP/1.1\r\nHost: 127.0.0.1:${gw.port}\r\n\r\n`);
  });
  sock.on('error', () => {});
  assert.equal(await waitFor(() => state.neverOpened === before + 1), true, '上游应收到请求');
  await sleep(120);
  sock.destroy();
  assert.equal(await waitFor(() => state.neverClosed, 4000), true, '客户端断开后上游连接必须被销毁');
});

t('上游响应中途断开：客户端看到中止而不是挂死，网关进程存活', async () => {
  const res = await rawGet(gw.port, '/api/truncated');
  assert.equal(res.aborted, true, `客户端应看到中止的响应：${JSON.stringify(res.status)}`);
  assert.equal(gw.child.exitCode, null, '上游异常不能把网关进程打挂');

  const after = await rawGet(gw.port, '/api/hop');
  assert.equal(after.status, 200, '后续请求仍应正常');
});

t('WS 鉴权等待期间客户端断开：不再连上游 WS，网关存活', async () => {
  state.authDelayMs = 400;
  try {
    const before = state.upgradeHits.length;
    const sock = net.connect(gw.port, '127.0.0.1');
    await new Promise((resolve) => sock.once('connect', resolve));
    sock.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${gw.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Origin: http://127.0.0.1:${gw.port}`,
        `Cookie: ${VALID_COOKIE}`,
        '',
        '',
      ].join('\r\n'),
    );
    await sleep(80);
    sock.destroy();
    await sleep(700);
    assert.equal(state.upgradeHits.length, before, '客户端已断开，不应再连上游 WS');
    assert.equal(gw.child.exitCode, null, '网关进程应仍存活');
  } finally {
    state.authDelayMs = 0;
  }
});

t('WS 上游不返回 101：超时后 504，不把客户端 socket 永远挂着', async () => {
  const gwFast = await startGateway({ HANA_GW_WS_UPSTREAM_TIMEOUT_MS: '300' });
  const raw = await rawUpgrade(gwFast.port, {
    rawPath: '/ws?stall=1',
    headers: { Origin: `http://127.0.0.1:${gwFast.port}`, Cookie: VALID_COOKIE },
    timeoutMs: 4000,
  });
  assert.equal(statusOf(raw), 504, `应返回 504，实际收到：${JSON.stringify(raw.slice(0, 80))}`);
});

t('正常 WS 升级：101 原样回传，头清理不破坏握手', async () => {
  const before = state.upgradeHits.length;
  const raw = await rawUpgrade(gw.port, {
    rawPath: '/ws?client=mobile',
    headers: {
      Origin: `http://127.0.0.1:${gw.port}`,
      Cookie: VALID_COOKIE,
      'te': 'trailers',
      'keep-alive': 'timeout=5',
    },
  });
  assert.equal(statusOf(raw), 101, raw.slice(0, 80));

  assert.equal(state.upgradeHits.length, before + 1);
  const hit = state.upgradeHits.at(-1);
  assert.equal(hit.headers.upgrade, 'websocket', 'upgrade 头必须原样带到上游');
  assert.match(String(hit.headers.connection || ''), /upgrade/i, 'connection 头必须保留升级语义');
  assert.equal(hit.headers.te, undefined, 'te 不应带到上游');
  assert.equal(hit.headers['keep-alive'], undefined, 'keep-alive 不应带到上游');
});

t('响应侧 hop-by-hop 头被剥离（含 Connection 动态字段），正常头保留', async () => {
  const res = await rawGet(gw.port, '/api/hop');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), 'HOP', '正文不能被改');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  for (const name of ['x-hop', 'keep-alive', 'trailer', 'upgrade', 'proxy-authenticate']) {
    assert.equal(res.headers[name], undefined, `${name} 不应出现在客户端响应里`);
  }
});

t('请求侧 hop-by-hop 头被剥离', async () => {
  const res = await rawGet(gw.port, '/api/echo', {
    method: 'POST',
    body: '{}',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${gw.port}`,
      te: 'trailers',
      'keep-alive': 'timeout=5',
    },
  });
  assert.equal(res.status, 200);
  const seen = state.echoHeaders || {};
  for (const name of ['te', 'keep-alive']) {
    assert.equal(seen[name], undefined, `${name} 不应转发给上游`);
  }
  assert.equal(seen['content-type'], 'application/json', '普通头必须保留');
});

t('认证响应体超限：销毁并按不可用拒绝，不解析成已认证', async () => {
  const res = await rawGet(gw.port, `/gw/file/${b64url(okPng)}`, { headers: { cookie: HUGE_COOKIE } });
  assert.equal(res.status, 503, '超大认证响应必须按不可用拒绝');
  assert.equal(res.body.toString('utf8'), 'auth service unavailable');
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await makeFixtures();
  await startUpstream();
  gw = await startGateway();
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
  for (const entry of gateways) entry.stop();
  for (const socket of state.stalled) socket.destroy();
  if (upstream) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
