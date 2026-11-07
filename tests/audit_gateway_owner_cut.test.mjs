/* 网关 owner 新建会话：非 2xx 响应正文截断回归（审计 G3）。
 *
 * 只用伪 HANA_HOME/server-info、伪 Cookie 和 mock upstream；不读取真实宿主配置、
 * 不连接真实 hana-server，不递归删除运行产物。
 *
 * 目标：确认 400/403 + Content-Length + 半截 body + destroy 是否会让网关因
 * upstreamRes 的未捕获 'error' 退出；同时确认现有 2xx 截断路径仍按 502 收尾。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');
const FAKE_OWNER_TOKEN = 'FAKE_OWNER_TOKEN_FOR_AUDIT_CUT';
const VALID_COOKIE = 'hana_session=owner-account';

const PRINCIPAL = Object.freeze({
  kind: 'account_user',
  credentialKind: 'user_session',
  authMethod: 'password',
  connectionKind: 'local',
  trustState: 'local',
  serverId: 'server-A',
  serverNodeId: 'node-A',
  studioId: 'studio-A',
  userId: 'owner-account',
  scopes: ['chat', 'resources.read', 'studio.owner'],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function request(port, rawPath, { method = 'GET', headers = {}, body = null, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = { connection: 'close', ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end(body == null ? undefined : body);
  });
}

let runDir;
let hanaHome;
let upstream;
let upstreamPort;
let gateway;
let gatewayPort;
let childLog = '';
let ownerMode = 'ok';

async function setup() {
  await fsp.mkdir(ARTIFACTS_ROOT, { recursive: true });
  runDir = await fsp.mkdtemp(path.join(ARTIFACTS_ROOT, 'audit-owner-cut-'));
  hanaHome = path.join(runDir, 'hana-home');
  await fsp.mkdir(hanaHome, { recursive: true });

  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/web-auth/session') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ authenticated: true, principal: PRINCIPAL }));
      return;
    }

    if (url.pathname === '/api/sessions/new') {
      for await (const _chunk of req) {
        // 只消费请求体，内容不影响本测试
      }
      if (ownerMode === 'cut400' || ownerMode === 'cut403') {
        const status = ownerMode === 'cut400' ? 400 : 403;
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"error":"partial');
        setTimeout(() => {
          res.destroy();
        }, 30);
        return;
      }
      if (ownerMode === 'cut400-error') {
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"error":"partial');
        setTimeout(() => {
          res.destroy(new Error('mock upstream cut'));
        }, 30);
        return;
      }
      if (ownerMode === 'cut400-now') {
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"error":"partial');
        res.destroy();
        return;
      }
      if (ownerMode === 'cut400-socket') {
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"error":"partial');
        res.socket.destroy();
        return;
      }
      if (ownerMode === 'cut200') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"path":"partial');
        setTimeout(() => {
          res.destroy();
        }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ path: '/fake/session.md', sessionId: 'sess-audit', agentId: 'agent-audit' }));
      return;
    }

    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  upstreamPort = await listen(upstream);

  await fsp.writeFile(
    path.join(hanaHome, 'server-info.json'),
    JSON.stringify({
      pid: process.pid,
      port: upstreamPort,
      token: FAKE_OWNER_TOKEN,
      serverId: 'server-A',
      serverNodeId: 'node-A',
      studioId: 'studio-A',
      userId: 'owner-account',
    }),
    { mode: 0o600 },
  );

  gatewayPort = await freePort();
  const env = {
    ...process.env, HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upstreamPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: String(gatewayPort),
    HANA_GW_LOG_WS: '',
  };
  for (const key of [
    'HANA_GW_ALLOW_INSECURE_LAN',
    'HANA_GW_ALLOWED_ORIGINS',
    'HANA_GW_TLS_CERT_FILE',
    'HANA_GW_TLS_KEY_FILE',
    'HANA_GW_CARD_TOKEN_TTL_MS',
    'HANA_GW_CARD_TOKEN_MAX',
    'HANA_GW_CARD_HOST_TOOL_IDLE_MS',
  ]) {
    delete env[key];
  }

  gateway = spawn(process.execPath, [GATEWAY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', (chunk) => {
    childLog += chunk.toString('utf8');
  });
  gateway.stderr.on('data', (chunk) => {
    childLog += chunk.toString('utf8');
  });
  await waitTcp(gatewayPort);
}

function postOwner() {
  return request(gatewayPort, '/api/sessions/new', {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${gatewayPort}`,
      cookie: VALID_COOKIE,
      'content-type': 'application/json',
    },
    body: '{}',
  });
}

async function waitGatewayExit() {
  for (let i = 0; i < 40 && gateway.exitCode === null; i += 1) await sleep(25);
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('400 + Content-Length + 半截 body + destroy：网关不得退出，仍回安全错误', async () => {
  ownerMode = 'cut400';
  let res = null;
  let requestError = null;
  try {
    res = await postOwner();
  } catch (err) {
    requestError = err;
  }
  await sleep(300);
  await waitGatewayExit();

  assert.equal(gateway.exitCode, null, `网关因 upstreamRes error 退出：${childLog.slice(-800)}`);
  assert.ok(res, `请求异常：${requestError?.message}`);
  assert.equal(res.status, 400, '上游 4xx 业务状态应保留');
  assert.deepEqual(JSON.parse(res.body), { error: 'owner_session_create_failed' });
});

t('400 半截 body 立即 destroy / 直接 destroy socket：网关都不得退出', async () => {
  for (const mode of ['cut400-error', 'cut400-now', 'cut400-socket']) {
    ownerMode = mode;
    let res = null;
    let requestError = null;
    try {
      res = await postOwner();
    } catch (err) {
      requestError = err;
    }
    await sleep(250);
    await waitGatewayExit();

    assert.equal(gateway.exitCode, null, `${mode} 后网关退出：${childLog.slice(-800)}`);
    assert.ok(res, `${mode} 请求异常：${requestError?.message}`);
    // 半截响应有时连状态行都没到网关；400（已收到状态行）或 502（整段安全失败）都可接受。
    assert.ok([400, 502].includes(res.status), `${mode} 状态应安全：${res.status}`);
    assert.deepEqual(JSON.parse(res.body), { error: 'owner_session_create_failed' });
  }
});

t('403 + Content-Length + 半截 body + destroy：网关不得退出', async () => {
  ownerMode = 'cut403';
  let res = null;
  let requestError = null;
  try {
    res = await postOwner();
  } catch (err) {
    requestError = err;
  }
  await sleep(300);
  await waitGatewayExit();

  assert.equal(gateway.exitCode, null, `网关因 upstreamRes error 退出：${childLog.slice(-800)}`);
  assert.ok(res, `请求异常：${requestError?.message}`);
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'owner_session_create_failed' });
});

t('200 + 半截 body：现有 2xx error 处理应回 502，网关存活', async () => {
  ownerMode = 'cut200';
  const res = await postOwner();
  await sleep(300);
  await waitGatewayExit();

  assert.equal(gateway.exitCode, null, `网关不应退出：${childLog.slice(-800)}`);
  assert.equal(res.status, 502, '2xx 但 body 截断必须按上游故障处理');
  assert.deepEqual(JSON.parse(res.body), { error: 'owner_session_create_failed' });
});

t('截断错误后普通 /api 请求仍可用', async () => {
  ownerMode = 'ok';
  const res = await request(gatewayPort, '/api/echo', { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
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
  if (gateway && gateway.exitCode === null) gateway.kill();
  if (upstream) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  if (runDir) console.log(`artifacts kept at ${runDir}`);
  if (childLog) console.log(`gateway log tail:\n${childLog.slice(-1200)}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
