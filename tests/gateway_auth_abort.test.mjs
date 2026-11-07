/* 新建会话请求的取消语义与鉴权响应收尾回归。
 *
 * 覆盖：
 * - Owner 代办新建：鉴权等待期间客户端断开 → 不向上游发创建，鉴权连接被取消
 * - 普通 Cookie 新建：同上，不进入代理创建
 * - 上游鉴权响应中途断开：checkReadAuth 必须收尾（503），客户端不挂死，网关继续工作
 *
 * 只使用伪上游、临时 HANA_HOME / server-info；不读取真实凭据、不启停真实网关。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.HANA_GW_SERVER_PATH
  ? path.resolve(process.env.HANA_GW_SERVER_PATH)
  : path.join(ROOT, 'gateway', 'server.mjs');

const VALID_COOKIE = 'hana_session=owner-account';
const NON_OWNER_COOKIE = 'hana_session=device-account';
const FAKE_OWNER_TOKEN = 'FAKE_OWNER_TOKEN_FOR_ABORT_TEST';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ACCOUNT_PRINCIPAL = Object.freeze({
  kind: 'account_user',
  credentialKind: 'user_session',
  authMethod: 'password',
  connectionKind: 'local',
  trustState: 'local',
  serverId: 'server-A',
  serverNodeId: 'node-A',
  studioId: 'studio-A',
  userId: 'account-user-A',
  scopes: ['chat', 'resources.read', 'studio.owner'],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 4000, stepMs = 25) {
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

/** 只关心"响应有没有被中止"，成功/失败都 resolve。 */
function rawGet(port, rawPath, { headers = {}, method = 'GET', body = null, timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    const h = { connection: 'close', ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const startedAt = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h }, (res) => {
      const chunks = [];
      let aborted = false;
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => {
        aborted = true;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode || 0,
          aborted,
          headers: res.headers,
          body: Buffer.concat(chunks),
          ms: Date.now() - startedAt,
        }),
      );
      res.on('close', () => {
        if (!res.complete) {
          aborted = true;
          resolve({
            status: res.statusCode || 0,
            aborted,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ms: Date.now() - startedAt,
          });
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`client timeout ${rawPath}`)));
    req.on('error', (err) =>
      resolve({ status: 0, aborted: true, error: err.message, headers: {}, body: Buffer.alloc(0), ms: Date.now() - startedAt }),
    );
    req.end(body == null ? undefined : body);
  });
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let upstream;
let upstreamPort;
let gw;
const gateways = [];

const state = {
  /** 鉴权响应延迟；模拟客户端在 await 窗口内离开。 */
  authDelayMs: 0,
  /** ok | truncated：truncated 表示只发一半响应体就掐断上游连接。 */
  authMode: 'ok',
  authHits: 0,
  /** 上游看到鉴权连接结束的时间；0 表示还没结束。 */
  authClosedAt: 0,
  /** 延迟鉴权真正开始写响应的时间；用来区分“被取消”与“正常回完”。 */
  authSentAt: 0,
  createHits: [],
  echoHits: 0,
};

function resetState() {
  state.authDelayMs = 0;
  state.authMode = 'ok';
  state.authHits = 0;
  state.authClosedAt = 0;
  state.authSentAt = 0;
  state.createHits.length = 0;
  state.echoHits = 0;
}

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-abort-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  await fsp.mkdir(path.join(hanaHome, 'session-files'), { recursive: true });
  await fsp.writeFile(path.join(hanaHome, 'session-files', 'ok.png'), TINY_PNG);
  await fsp.writeFile(
    path.join(hanaHome, 'server-info.json'),
    JSON.stringify({
      pid: process.pid,
      port: upstreamPort,
      token: FAKE_OWNER_TOKEN,
      serverId: 'server-A',
      serverNodeId: 'node-A',
      studioId: 'studio-A',
    }),
    { mode: 0o600 },
  );
}

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/web-auth/session') {
      state.authHits += 1;
      req.socket.once('close', () => {
        state.authClosedAt = Date.now();
      });
      const cookie = req.headers.cookie || '';
      if (state.authMode === 'truncated') {
        // 响应头和一半正文都发出去了，再掐 socket：调用方收不到 'end'
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': '480' });
        res.write('{"authenticated":true,"principal":');
        setTimeout(() => req.socket.destroy(), 30);
        return;
      }
      const send = () => {
        state.authSentAt = Date.now();
        if (res.destroyed || res.writableEnded) return;
        const authenticated = cookie.includes(VALID_COOKIE) || cookie.includes(NON_OWNER_COOKIE);
        const principal = cookie.includes(NON_OWNER_COOKIE)
          ? { ...ACCOUNT_PRINCIPAL, kind: 'device', credentialKind: 'device_credential', authMethod: null }
          : ACCOUNT_PRINCIPAL;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ authenticated, principal: authenticated ? principal : null }));
      };
      if (state.authDelayMs > 0) setTimeout(send, state.authDelayMs);
      else send();
      return;
    }

    if (url.pathname === '/api/sessions/new') {
      state.createHits.push({ method: req.method, headers: req.headers, body: null });
      const hit = state.createHits.at(-1);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hit.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ path: '/fake/sessions/new.md', sessionId: 'sess-abort-001', agentId: 'agent-abort-001' }));
      });
      return;
    }

    if (url.pathname === '/api/echo') {
      state.echoHits += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  upstreamPort = await listen(upstream);
}

function gatewayEnv(overrides = {}) {
  const env = {
    ...process.env,
    HANA_GATEWAY_LOG: 'off',
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

/**
 * 用裸 socket 发完整的新建请求（头 + 正文一次写完），保持连接不关。
 * 调用方在确认上游已收到鉴权请求后再 destroy()，模拟"正文已完整送达、客户端随即离开"。
 */
async function openCreateRequest(port, { cookie, pathname = '/api/sessions/new', body = '{}' } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {});
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  const payload = [
    `POST ${pathname} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Origin: http://127.0.0.1:${port}`,
    `Cookie: ${cookie}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
  sock.write(payload);
  return sock;
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('Owner 新建：鉴权等待期间客户端断开 → 立即取消鉴权，不发创建', async () => {
  resetState();
  state.authDelayMs = 1500;
  const before = state.authHits;
  const sock = await openCreateRequest(gw.port, { cookie: VALID_COOKIE, body: '{"namespace":"home"}' });

  assert.equal(await waitFor(() => state.authHits === before + 1, 2000), true, '网关应先向上游发起鉴权');
  await sleep(80); // 此时请求正文已完整送达网关，网关正卡在 checkReadAuth
  sock.destroy();

  // 关键：鉴权连接必须在延迟响应到期前就被取消，而不是等上游 1.5s 后回完
  assert.equal(
    await waitFor(() => state.authClosedAt > 0 && state.authSentAt === 0, 700),
    true,
    '客户端断开后鉴权上游连接必须立即结束，不能等延迟鉴权回完',
  );
  await sleep(1800); // 超过延迟鉴权的原定回复时间，确认不会再补发创建
  assert.equal(state.createHits.length, 0, '客户端已断开，不得发起 Owner 创建');
  assert.equal(gw.child.exitCode, null, '网关进程应仍存活');
});

t('普通 Cookie 新建：鉴权等待期间客户端断开 → 立即取消鉴权，不进入上游代理创建', async () => {
  resetState();
  state.authDelayMs = 1500;
  const before = state.authHits;
  const sock = await openCreateRequest(gw.port, { cookie: NON_OWNER_COOKIE, body: '{"namespace":"home"}' });

  assert.equal(await waitFor(() => state.authHits === before + 1, 2000), true, '网关应先向上游发起鉴权');
  await sleep(80);
  sock.destroy();

  assert.equal(
    await waitFor(() => state.authClosedAt > 0 && state.authSentAt === 0, 700),
    true,
    '客户端断开后鉴权上游连接必须立即结束，不能等延迟鉴权回完',
  );
  await sleep(1800);
  assert.equal(state.createHits.length, 0, '客户端已断开，不得代理创建请求');
  assert.equal(gw.child.exitCode, null, '网关进程应仍存活');
});

t('鉴权响应中途断开：安全结束为 503，不挂死客户端，后续请求仍正常', async () => {
  resetState();
  state.authMode = 'truncated';
  const res = await rawGet(gw.port, `/gw/file/${b64url(path.join(hanaHome, 'session-files', 'ok.png'))}`, {
    headers: { cookie: VALID_COOKIE },
    timeout: 6000,
  });
  state.authMode = 'ok';

  assert.equal(res.status, 503, `不完整鉴权响应必须按不可用拒绝，实际 ${res.status} (${res.ms}ms)`);
  assert.equal(res.body.toString('utf8'), 'auth service unavailable');
  assert.ok(res.ms < 3000, `响应不能靠客户端超时收尾：${res.ms}ms`);
  assert.equal(gw.child.exitCode, null, '网关进程应仍存活');

  const after = await rawGet(gw.port, '/api/echo', { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200, '后续请求必须仍能正常处理');
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await startUpstream();
  await makeFixtures();
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
