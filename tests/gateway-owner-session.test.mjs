/* Hana Mobile Gateway local-owner 新建会话回归。
 *
 * 只使用伪 owner server-info / 伪 Cookie / mock upstream；
 * 不读取真实 HANA_HOME、server-info、token、Cookie 或密码文件。
 *
 * 本文件的所有运行产物留在 tests/artifacts 下，不递归删除旧目录。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { isOwnerSessionCreatePath } from '../gateway/security-policy.mjs';
import { isEligibleOwnerPrincipal, loadLocalOwner } from '../gateway/local-owner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');
const FAKE_OWNER_TOKEN = 'FAKE_OWNER_TOKEN_FOR_TESTS';
const ROTATED_OWNER_TOKEN = 'ROTATED_OWNER_TOKEN_FOR_TESTS';
const VALID_COOKIE = 'hana_session=owner-account';
const NON_OWNER_COOKIE = 'hana_session=device-account';
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

let runDir;
let hanaHome;
let upstream;
let upstreamPort;
let gateway;
let gatewayPort;
let childLog = '';
let acceptedOwnerToken = FAKE_OWNER_TOKEN;
let ownerMode = 'ok';
const authHits = [];
const ownerHits = [];
const echoHits = [];
const detachedHits = [];
const children = [];

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

function request(port, rawPath, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = { connection: 'close', ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
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

function originFor(port) {
  return `http://127.0.0.1:${port}`;
}

async function writeServerInfo({
  token = FAKE_OWNER_TOKEN,
  pid = process.pid,
  port = upstreamPort,
  serverId = 'server-A',
  serverNodeId = 'node-A',
  studioId = 'studio-A',
  userId = 'owner-info-user-does-not-match-account',
} = {}) {
  const info = { pid, port, token, serverId, serverNodeId, studioId, userId };
  await fsp.writeFile(path.join(hanaHome, 'server-info.json'), JSON.stringify(info), { mode: 0o600 });
}

async function makeHome(name, content) {
  const home = path.join(runDir, name);
  await fsp.mkdir(home, { recursive: true });
  if (content !== undefined) {
    await fsp.writeFile(path.join(home, 'server-info.json'), content, { mode: 0o600 });
  }
  return home;
}

async function setup() {
  await fsp.mkdir(ARTIFACTS_ROOT, { recursive: true });
  runDir = await fsp.mkdtemp(path.join(ARTIFACTS_ROOT, 'owner-session-'));
  hanaHome = path.join(runDir, 'hana-home');
  await fsp.mkdir(hanaHome, { recursive: true });

  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/web-auth/session') {
      authHits.push(req.headers.cookie || '');
      const cookie = String(req.headers.cookie || '');
      if (cookie.includes(VALID_COOKIE)) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ authenticated: true, principal: ACCOUNT_PRINCIPAL }));
        return;
      }
      if (cookie.includes(NON_OWNER_COOKIE)) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          authenticated: true,
          principal: { ...ACCOUNT_PRINCIPAL, kind: 'device', credentialKind: 'device_credential', authMethod: null },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"authenticated":false,"principal":null}');
      return;
    }

    if (url.pathname === '/api/sessions/new') {
      const hit = { method: req.method, headers: req.headers, body: '' };
      ownerHits.push(hit);
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      hit.body = Buffer.concat(bodyChunks).toString('utf8');
      if (ownerMode === 'cut_error') {
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': 2048 });
        res.write('{"error":"partial');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (ownerMode === 'error') {
        res.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': 'owner_error_cookie=1; Path=/',
        });
        res.end(JSON.stringify({ error: `OWNER_SECRET_${acceptedOwnerToken}` }));
        return;
      }
      if (ownerMode === 'bad_request') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `OWNER_SECRET_${acceptedOwnerToken}` }));
        return;
      }
      if (ownerMode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `OWNER_SECRET_${acceptedOwnerToken}` }));
        return;
      }
      if (ownerMode === 'bad_json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('not-json');
        return;
      }
      if (ownerMode === 'redirect') {
        res.writeHead(302, {
          location: `http://127.0.0.1:${upstreamPort}/api/other-redirect?token=${acceptedOwnerToken}`,
          'set-cookie': 'owner_redirect_cookie=1; Path=/',
        });
        res.end('redirect');
        return;
      }
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${acceptedOwnerToken}`) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'owner_rejected' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'owner_success_cookie=must-not-pass; Path=/',
      });
      res.end(JSON.stringify({
        ok: true,
        path: '/fake/sessions/new-session.md',
        sessionId: 'sess-fake-001',
        agentId: 'agent-fake-001',
        ...(ownerMode === 'no_agent_name' ? {} : { agentName: '创建时的助手名' }),
        cwd: '/must/not/be/returned',
        namespace: 'home',
        ownerToken: acceptedOwnerToken,
      }));
      return;
    }

    if (url.pathname === '/api/sessions/new-detached') {
      detachedHits.push({ method: req.method, headers: req.headers });
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"detached_requires_other_scope"}');
      return;
    }

    if (url.pathname === '/api/sessions/messages') {
      const canRead = req.headers.cookie === VALID_COOKIE && !req.headers.authorization &&
        url.searchParams.get('sessionId') === 'sess-fake-001' &&
        url.searchParams.get('path') === '/fake/sessions/new-session.md';
      res.writeHead(canRead ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(canRead ? { messages: [], sessionFiles: [], hasMore: false } : { error: 'read_rejected' }));
      return;
    }

    if (url.pathname === '/api/echo') {
      echoHits.push({ method: req.method, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  upstreamPort = await listen(upstream);
  await writeServerInfo();

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
  gateway.stdout.on('data', (c) => { childLog += c.toString('utf8'); });
  gateway.stderr.on('data', (c) => { childLog += c.toString('utf8'); });
  children.push(gateway);
  await waitTcp(gatewayPort);
}

async function teardown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  // 不删除 runDir：保留 tests/artifacts 下的本次产物，避免递归清理。
  console.log(`artifacts kept at ${runDir}`);
}

function resetState() {
  authHits.length = 0;
  ownerHits.length = 0;
  echoHits.length = 0;
  detachedHits.length = 0;
  ownerMode = 'ok';
}

function postOwner(pathname, { cookie = VALID_COOKIE, headers = {}, body = '{}', origin = originFor(gatewayPort) } = {}) {
  return request(gatewayPort, pathname, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

function ownerHit() {
  return ownerHits.at(-1);
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('纯策略：owner 只匹配精确 /api/sessions/new，不匹配 new-detached 或相似路径', () => {
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new'), true);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new?x=1'), true);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new-detached'), false);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new/'), false);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new/extra'), false);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new-extra'), false);
  assert.equal(isOwnerSessionCreatePath('/api/sessions/new/../new-detached'), false);
  assert.equal(isOwnerSessionCreatePath('http://evil/api/sessions/new'), false);
});

t('loader：缺失/坏 JSON/缺字段/坏端口/PID 失效都 fail closed 且不泄漏 token', async () => {
  const missing = await makeHome('missing');
  const missingResult = loadLocalOwner({ hanaHome: missing, upstreamHost: '127.0.0.1', upstreamPort });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, 'missing_server_info');

  const bad = await makeHome('bad-json', '{not json');
  const badResult = loadLocalOwner({ hanaHome: bad, upstreamHost: '127.0.0.1', upstreamPort });
  assert.equal(badResult.ok, false);
  assert.equal(badResult.reason, 'invalid_server_info');
  assert.ok(!JSON.stringify(badResult).includes(FAKE_OWNER_TOKEN));

  const incomplete = await makeHome('incomplete', JSON.stringify({ pid: process.pid, port: upstreamPort }));
  assert.equal(loadLocalOwner({ hanaHome: incomplete, upstreamHost: '127.0.0.1', upstreamPort }).reason, 'incomplete_server_info');

  const badPort = await makeHome('bad-port', JSON.stringify({
    pid: process.pid, port: upstreamPort + 1, token: FAKE_OWNER_TOKEN, serverNodeId: 'node-A', studioId: 'studio-A',
  }));
  assert.equal(loadLocalOwner({ hanaHome: badPort, upstreamHost: '127.0.0.1', upstreamPort }).reason, 'port_mismatch');

  const stale = await makeHome('stale-pid', JSON.stringify({
    pid: 99_999_999, port: upstreamPort, token: FAKE_OWNER_TOKEN, serverNodeId: 'node-A', studioId: 'studio-A',
  }));
  assert.equal(loadLocalOwner({ hanaHome: stale, upstreamHost: '127.0.0.1', upstreamPort }).reason, 'stale_pid');

  const remote = await makeHome('remote-host', JSON.stringify({
    pid: process.pid, port: upstreamPort, token: FAKE_OWNER_TOKEN, serverNodeId: 'node-A', studioId: 'studio-A',
  }));
  const remoteResult = loadLocalOwner({ hanaHome: remote, upstreamHost: '192.0.2.10', upstreamPort });
  assert.equal(remoteResult.reason, 'unsafe_upstream');
  assert.ok(!JSON.stringify(remoteResult).includes(FAKE_OWNER_TOKEN));
});

t('loader：有效配置读取 token，端口必须与目标一致；不读 userId 做匹配', async () => {
  const home = await makeHome('valid', JSON.stringify({
    pid: process.pid,
    port: upstreamPort,
    token: FAKE_OWNER_TOKEN,
    serverId: 'server-A',
    serverNodeId: 'node-A',
    studioId: 'studio-A',
    userId: 'owner-info-user-does-not-match-account',
  }));
  const result = loadLocalOwner({ hanaHome: home, upstreamHost: '127.0.0.1', upstreamPort });
  assert.equal(result.ok, true);
  assert.equal(result.token, FAKE_OWNER_TOKEN);
  assert.equal(result.info.serverNodeId, 'node-A');
  assert.equal(result.info.studioId, 'studio-A');
  assert.equal(result.info.port, upstreamPort);
});

t('资格：只接受本机密码账户 + studio.owner + 本机 server/studio 对应；不同 userId 不误拒', () => {
  const info = { serverId: 'server-A', serverNodeId: 'node-A', studioId: 'studio-A' };
  assert.equal(isEligibleOwnerPrincipal(ACCOUNT_PRINCIPAL, info), true, '不同 userId 不能影响资格');
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, kind: 'device' }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, credentialKind: 'device_credential' }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, authMethod: null }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, scopes: ['chat'] }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, serverNodeId: 'node-B' }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, serverId: 'server-B' }, info), false);
  assert.equal(isEligibleOwnerPrincipal({ ...ACCOUNT_PRINCIPAL, studioId: 'studio-B' }, info), false);
});

t('坏 Origin / 无 Cookie / 伪 Cookie：在 owner 加载与上游新建之前拒绝', async () => {
  resetState();
  const badOrigin = await postOwner('/api/sessions/new', { origin: 'http://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal(ownerHits.length, 0);
  assert.equal(authHits.length, 0, '坏 Origin 不应触发 session 查询');

  const noCookie = await postOwner('/api/sessions/new', { cookie: '' });
  assert.equal(noCookie.status, 401);
  assert.equal(ownerHits.length, 0);

  const fakeCookie = await postOwner('/api/sessions/new', { cookie: 'hana_session=fake' });
  assert.equal(fakeCookie.status, 401);
  assert.equal(ownerHits.length, 0);
});

t('未认证 / 非 owner 不会因 owner 配置坏而变成 503', async () => {
  await fsp.writeFile(path.join(hanaHome, 'server-info.json'), '{broken', { mode: 0o600 });

  resetState();
  const badOrigin = await postOwner('/api/sessions/new', { origin: 'http://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal(authHits.length, 0, '坏 Origin 不应读取会话');

  const noCookie = await postOwner('/api/sessions/new', { cookie: '' });
  assert.equal(noCookie.status, 401);

  const fakeCookie = await postOwner('/api/sessions/new', { cookie: 'hana_session=fake' });
  assert.equal(fakeCookie.status, 401);

  resetState();
  const device = await postOwner('/api/sessions/new', { cookie: NON_OWNER_COOKIE });
  assert.equal(device.status, 403, '非 owner 账户仍走普通 Cookie 代理，不应读取 owner 配置');
  assert.equal(ownerHit().headers.authorization, undefined);

  await writeServerInfo();
});

t('精确 POST 正路径：保留会话身份与创建助手名，不覆盖用户 Cookie、不回 Owner 元数据', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', { body: '{}' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    path: '/fake/sessions/new-session.md',
    sessionId: 'sess-fake-001',
    agentId: 'agent-fake-001',
    agentName: '创建时的助手名',
  });
  assert.equal(res.headers['set-cookie'], undefined, 'Owner Set-Cookie 绝不能透传');
  assert.equal(ownerHits.length, 1);
  const hit = ownerHit();
  assert.equal(hit.headers.authorization, `Bearer ${FAKE_OWNER_TOKEN}`);
  assert.equal(hit.headers.cookie, undefined, 'Owner 请求不带原 Cookie');
  assert.equal(authHits.at(-1), VALID_COOKIE, '原 Cookie 只用于 session 认证');
});

t('宿主未返回可选 agentName 时仍可成功，不把已创建会话误报失败', async () => {
  resetState();
  ownerMode = 'no_agent_name';
  const res = await postOwner('/api/sessions/new');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    path: '/fake/sessions/new-session.md', sessionId: 'sess-fake-001', agentId: 'agent-fake-001',
  });
});

t('Owner 创建后原 Cookie 可按会话身份读回 Mock 历史，读取不得带 Bearer', async () => {
  resetState();
  const created = await postOwner('/api/sessions/new');
  assert.equal(created.status, 200);
  const session = JSON.parse(created.body);
  const query = new URLSearchParams({ sessionId: session.sessionId, path: session.path });
  const readback = await request(gatewayPort, `/api/sessions/messages?${query}`, {
    headers: { cookie: VALID_COOKIE },
  });
  assert.equal(readback.status, 200);
  assert.deepEqual(JSON.parse(readback.body), { messages: [], sessionFiles: [], hasMore: false });
});

t('错误响应正文中途断开不能打崩网关，也不能泄漏上游细节', async () => {
  resetState();
  ownerMode = 'cut_error';
  const res = await postOwner('/api/sessions/new');
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'owner_session_create_failed' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(gateway.exitCode, null, '上游截断错误响应后网关必须仍存活');
  const alive = await request(gatewayPort, '/api/echo', { headers: { cookie: VALID_COOKIE } });
  assert.equal(alive.status, 200);
});

t('普通 Cookie 路径仍转发原 Cookie，不被 owner 身份污染', async () => {
  resetState();
  const res = await request(gatewayPort, '/api/echo', {
    method: 'POST',
    headers: { origin: originFor(gatewayPort), cookie: VALID_COOKIE, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(echoHits.length, 1);
  assert.equal(echoHits[0].headers.cookie, VALID_COOKIE);
  assert.equal(echoHits[0].headers.authorization, undefined);
  assert.equal(ownerHits.length, 0);
});

t('非 POST / new-detached / 相似路径 / 其它 API 不获得 owner bearer', async () => {
  resetState();
  const getRes = await request(gatewayPort, '/api/sessions/new', {
    headers: { cookie: VALID_COOKIE },
  });
  assert.equal(getRes.status, 405);
  assert.equal(ownerHits.length, 1);
  assert.equal(ownerHit().headers.authorization, undefined);
  assert.equal(ownerHit().headers.cookie, VALID_COOKIE);

  resetState();
  const detached = await postOwner('/api/sessions/new-detached');
  assert.equal(detached.status, 403);
  assert.equal(detachedHits.length, 1);
  assert.equal(detachedHits[0].headers.authorization, undefined);
  assert.equal(detachedHits[0].headers.cookie, VALID_COOKIE);
  assert.equal(ownerHits.length, 0);

  resetState();
  const similar = await postOwner('/api/sessions/new/extra');
  assert.equal(similar.status, 404);
  assert.equal(ownerHits.length, 0);
  assert.equal(detachedHits.length, 0);
});

t('设备/非 owner 账户不代办，仍按普通 Cookie 代理', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', { cookie: NON_OWNER_COOKIE });
  assert.equal(res.status, 403);
  assert.equal(ownerHits.length, 1);
  assert.equal(ownerHit().headers.authorization, undefined);
  assert.equal(ownerHit().headers.cookie, NON_OWNER_COOKIE);
});

t('body 越权字段 / 坏类型 / 空 body / 非 JSON / 超限都拒绝且不调用 owner', async () => {
  const cases = [
    ['额外 namespace', '{"namespace":"code"}', 400],
    ['额外 cwd', '{"cwd":"/tmp"}', 400],
    ['数组', '[]', 400],
    ['null', 'null', 400],
    ['agentId 非字符串', '{"agentId":123}', 400],
    ['agentId 空白', '{"agentId":"   "}', 400],
    ['空 body', '', 400],
  ];
  for (const [label, body, status] of cases) {
    resetState();
    const res = await postOwner('/api/sessions/new', { body });
    assert.equal(res.status, status, `${label} 应拒绝`);
    assert.equal(ownerHits.length, 0, `${label} 不应调用 owner`);
  }

  resetState();
  const wrongType = await postOwner('/api/sessions/new', {
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal(ownerHits.length, 0);

  resetState();
  const tooLarge = await postOwner('/api/sessions/new', { body: JSON.stringify({ agentId: 'a'.repeat(9000) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal(ownerHits.length, 0);
});

t('合法 agentId 会透传，伪造 Authorization / X-Hana 不会成为凭据', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', {
    body: '{"agentId":"agent-from-client"}',
    headers: {
      authorization: 'Bearer attacker',
      'x-hana-input-draft-owner': 'attacker',
    },
  });
  assert.equal(res.status, 200);
  const hit = ownerHit();
  assert.equal(hit.headers.authorization, `Bearer ${FAKE_OWNER_TOKEN}`);
  assert.equal(hit.headers.cookie, undefined);
  assert.equal(hit.headers['x-hana-input-draft-owner'], undefined);
  assert.deepEqual(JSON.parse(hit.body), { agentId: 'agent-from-client' }, '必须真的将所选 agentId 发给上游');
  assert.equal(authHits.at(-1), VALID_COOKIE);
});

t('Owner 上游错误 / 重定向：不回显原始错误或 token，不透传 Set-Cookie/Location', async () => {
  resetState();
  ownerMode = 'error';
  const errorRes = await postOwner('/api/sessions/new');
  assert.equal(errorRes.status, 502, '上游 5xx 统一安全失败');
  assert.deepEqual(JSON.parse(errorRes.body), { error: 'owner_session_create_failed' });
  assert.ok(!errorRes.body.includes(FAKE_OWNER_TOKEN));
  assert.equal(errorRes.headers['set-cookie'], undefined);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!childLog.includes(FAKE_OWNER_TOKEN), '日志不得出现 owner token');
  assert.ok(!childLog.includes('OWNER_SECRET_'), '日志不得出现原始错误体');

  resetState();
  ownerMode = 'bad_request';
  const badRequestRes = await postOwner('/api/sessions/new');
  assert.equal(badRequestRes.status, 400, '上游 4xx 业务状态应保留');
  assert.deepEqual(JSON.parse(badRequestRes.body), { error: 'owner_session_create_failed' });
  assert.ok(!badRequestRes.body.includes(FAKE_OWNER_TOKEN));

  resetState();
  ownerMode = 'unauthorized';
  const unauthorizedRes = await postOwner('/api/sessions/new');
  assert.equal(unauthorizedRes.status, 502, 'owner token 失效不能伪装成手机登录失效');
  assert.deepEqual(JSON.parse(unauthorizedRes.body), { error: 'owner_session_create_failed' });

  resetState();
  ownerMode = 'bad_json';
  const badJsonRes = await postOwner('/api/sessions/new');
  assert.equal(badJsonRes.status, 502, '上游 200 但不是合法新会话时必须失败');
  assert.deepEqual(JSON.parse(badJsonRes.body), { error: 'owner_session_create_failed' });
  assert.ok(!badJsonRes.body.includes('sessionId'));

  resetState();
  ownerMode = 'redirect';
  const redirectRes = await postOwner('/api/sessions/new');
  assert.equal(redirectRes.status, 502);
  assert.equal(redirectRes.headers.location, undefined);
  assert.equal(redirectRes.headers['set-cookie'], undefined);
  assert.ok(!redirectRes.body.includes(FAKE_OWNER_TOKEN));
});

t('server/studio 不匹配时不代办，仍按普通 Cookie 代理', async () => {
  resetState();
  await writeServerInfo({ serverNodeId: 'node-B' });
  const res = await postOwner('/api/sessions/new');
  assert.equal(res.status, 403);
  assert.equal(ownerHits.length, 1);
  assert.equal(ownerHit().headers.authorization, undefined);
  assert.equal(ownerHit().headers.cookie, VALID_COOKIE);
  await writeServerInfo();
});

t('server-info 轮换后不使用旧 token', async () => {
  resetState();
  acceptedOwnerToken = ROTATED_OWNER_TOKEN;
  await writeServerInfo({ token: ROTATED_OWNER_TOKEN });
  const res = await postOwner('/api/sessions/new');
  assert.equal(res.status, 200);
  assert.equal(ownerHit().headers.authorization, `Bearer ${ROTATED_OWNER_TOKEN}`);
  assert.ok(!ownerHit().headers.authorization.includes(FAKE_OWNER_TOKEN));

  acceptedOwnerToken = FAKE_OWNER_TOKEN;
  await writeServerInfo({ token: FAKE_OWNER_TOKEN });
});

t('坏 JSON / 错端口 / PID 失效：owner 不可用时 503，且不访问上游、不泄漏 token', async () => {
  for (const [label, write] of [
    ['坏 JSON', () => fsp.writeFile(path.join(hanaHome, 'server-info.json'), '{broken', { mode: 0o600 })],
    ['错端口', () => writeServerInfo({ port: upstreamPort + 1 })],
    ['PID 失效', () => writeServerInfo({ pid: 99_999_999 })],
  ]) {
    resetState();
    await write();
    const res = await postOwner('/api/sessions/new');
    assert.equal(res.status, 503, `${label} 应 fail closed`);
    assert.deepEqual(JSON.parse(res.body), { error: 'owner_unavailable' });
    assert.equal(ownerHits.length, 0, `${label} 不应调用上游新建`);
    assert.ok(!res.body.includes(FAKE_OWNER_TOKEN), `${label} 不得泄漏 token`);
    assert.ok(!childLog.includes(FAKE_OWNER_TOKEN), `${label} 日志不得泄漏 token`);
    await writeServerInfo();
  }
});

/* ---- 请求体白名单：namespace 与 Code 目录 ---------------------------------- */

t('owner 代办：namespace=home 原样放行（Chat 新建）', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', namespace: 'home' }),
  });
  assert.equal(res.status, 200, `应放行，实际：${res.status} ${res.body}`);
  assert.equal(ownerHits.length, 1, '应转发到上游');
  assert.deepEqual(
    JSON.parse(ownerHits[0].body),
    { agentId: 'agent-a', namespace: 'home' },
    'namespace 必须原样带给宿主；丢了它宿主就一律建 Chat',
  );
});

t('owner 代办：namespace=code 且 cwd 是真实目录时放行', async () => {
  resetState();
  const dir = path.join(runDir, 'code-repo');
  await fsp.mkdir(dir, { recursive: true });
  const res = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', namespace: 'code', cwd: dir }),
  });
  assert.equal(res.status, 200, `应放行，实际：${res.status} ${res.body}`);
  const forwarded = JSON.parse(ownerHits[0].body);
  assert.equal(forwarded.namespace, 'code');
  assert.equal(forwarded.cwd, dir, 'Code 会话必须把目录带给宿主');
});

t('owner 代办：Code 不带 cwd 直接 400，且不调上游', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', namespace: 'code' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'code_repository_required' });
  assert.equal(ownerHits.length, 0, '缺目录时不应把注定 400 的请求转给宿主');
});

t('owner 代办：cwd 不存在或不是目录时 400，且不调上游', async () => {
  resetState();
  const missing = path.join(runDir, 'definitely-missing-dir');
  const relative = 'relative/repo';
  const filePath = path.join(runDir, 'not-a-dir.txt');
  await fsp.writeFile(filePath, 'x');

  for (const cwd of [missing, relative, filePath]) {
    const res = await postOwner('/api/sessions/new', {
      body: JSON.stringify({ agentId: 'agent-a', namespace: 'code', cwd }),
    });
    assert.equal(res.status, 400, `cwd=${cwd} 应被拒`);
    assert.deepEqual(JSON.parse(res.body), { error: 'code_repository_required' });
  }
  assert.equal(ownerHits.length, 0, '非法目录不应转发到上游');
});

t('owner 代办：未知字段仍然 400，保持白名单严格', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', namespace: 'home', codeWorktree: '/tmp/x' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid_request' });
  assert.equal(ownerHits.length, 0);
});

t('owner 代办：namespace 非法值 400，且不调上游', async () => {
  resetState();
  const res = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', namespace: 'all' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'invalid_request' });
  assert.equal(ownerHits.length, 0);
});

t('owner 代办：thinkingLevel 原样放行，非法形状 400', async () => {
  resetState();
  const ok = await postOwner('/api/sessions/new', {
    body: JSON.stringify({ agentId: 'agent-a', thinkingLevel: 'max' }),
  });
  assert.equal(ok.status, 200, `合法档位应放行，实际：${ok.status} ${ok.body}`);
  assert.equal(JSON.parse(ownerHits[0].body).thinkingLevel, 'max', '档位必须原样带给宿主');

  for (const bad of ['', 'MAX', 'max ', "max';", 'a'.repeat(40), 123, null, true]) {
    resetState();
    const res = await postOwner('/api/sessions/new', {
      body: JSON.stringify({ agentId: 'agent-a', thinkingLevel: bad }),
    });
    assert.equal(res.status, 400, `thinkingLevel=${JSON.stringify(bad)} 应被拒`);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid_request' });
    assert.equal(ownerHits.length, 0, '非法档位不应转给宿主');
  }
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
  await teardown();
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
