/* 网关边界回归：不读真实 host 凭据，不碰真实 hana-server。
 *
 * 用临时 HANA_HOME、自由端口和 mock upstream，覆盖：
 * - 非 loopback 明文需 HANA_GW_ALLOW_INSECURE_LAN=1，默认绑定 127.0.0.1
 * - 写请求同源 Origin / 显式 allowlist；缺省、null、跨源拒绝
 * - 新建会话不注入 owner token，上游 403 原样透传（本测试 mock 身份是非 owner）
 * - 转发前剥离 Authorization、X-Forwarded-*、Forwarded、X-Real-IP、X-Hana-*
 * - WS 只允许 /ws，错路径 / 无认证 / 坏 Origin 不连上游
 * - logout 成功撤销 card token；/gw/file no-store
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import {
  evaluateBindPolicy,
  isAllowedOrigin,
  isCreateSessionPath,
  isLogoutPath,
  isWorkspaceContentPath,
  isWsPath,
  isWriteMethod,
  parseAllowedOrigins,
  sanitizeUpstreamHeaders,
  secureSetCookieHeaders,
  upstreamIdleTimeoutFor,
} from '../gateway/security-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');
const WORKSPACE_CONTENT_PATHS = [
  '/api/mobile/workspace/content',
  '/api/workspace/content',
  '/api/mobile/workbench/content',
  '/api/workbench/content',
];
const VALID_COOKIE = 'hana_session=ok';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

function rawUpgrade(port, { rawPath = '/ws', headers = {} } = {}) {
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
    sock.setTimeout(2500, () => {
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

const fileUrl = (absPath) => `/gw/file/${b64url(absPath)}`;
const cardUrl = (dir) => `/gw/card/${b64url(dir)}/`;

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let sessionFiles;
let cardDir;
let okPng;
let upstream;
let upstreamPort;
let mainGw;
const children = [];
const upstreamHits = [];
const authCalls = [];
const upgradeHits = [];
let echoHeaders = null;
let logoutCalls = 0;
let redirectLocation = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixtures() {
  await fsp.mkdir(ARTIFACTS_ROOT, { recursive: true });
  tmpRoot = await fsp.mkdtemp(path.join(ARTIFACTS_ROOT, 'gateway-boundary-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  sessionFiles = path.join(hanaHome, 'session-files');
  await fsp.mkdir(sessionFiles, { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });

  cardDir = path.join(sessionFiles, 'card');
  await fsp.mkdir(cardDir, { recursive: true });
  await fsp.writeFile(path.join(cardDir, 'index.html'), '<!doctype html><h1>BOUNDARY_CARD</h1>');
  okPng = path.join(sessionFiles, 'ok.png');
  await fsp.writeFile(okPng, TINY_PNG);
}

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    upstreamHits.push({ method: req.method, pathname: url.pathname, headers: req.headers });

    if (url.pathname === '/api/web-auth/session') {
      authCalls.push(req.headers.cookie || '');
      const authenticated = String(req.headers.cookie || '').includes(VALID_COOKIE);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ authenticated, principal: authenticated ? { kind: 'local_user' } : null }));
      return;
    }
    if (url.pathname === '/api/web-auth/logout' && req.method === 'POST') {
      logoutCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/sessions/new' || url.pathname === '/api/sessions/new-detached') {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"insufficient_scope","reason":"insufficient_capability"}');
      return;
    }
    if (WORKSPACE_CONTENT_PATHS.includes(url.pathname)) {
      if (url.searchParams.get('redirect') === '304') {
        res.writeHead(304, { location: redirectLocation, 'cache-control': 'public, max-age=60' });
        res.end();
        return;
      }
      if (url.searchParams.get('redirect') === '1') {
        res.writeHead(302, {
          location: redirectLocation,
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'leak=should-not-follow; Path=/',
        });
        res.end('<html><body>UPSTREAM_REDIRECT</body></html>');
        return;
      }
      const kind = url.searchParams.get('kind') || 'html';
      const isSvg = kind === 'svg';
      res.writeHead(200, {
        'content-type': isSvg ? 'image/svg+xml' : 'text/html; charset=utf-8',
        'content-disposition': isSvg ? 'inline; filename="../../evil.svg"' : 'inline; filename="preview.html"',
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'sniff',
        'content-security-policy': "default-src *",
        'x-mock-upstream': 'yes',
      });
      res.end(isSvg ? '<svg xmlns="http://www.w3.org/2000/svg"><text>SVG</text></svg>' : '<html><body>HTML</body></html>');
      return;
    }
    if (url.pathname === '/api/doc') {
      const kind = url.searchParams.get('kind') || 'html';
      const meta = {
        html: ['text/html; charset=utf-8', '<html><body>DOC</body></html>'],
        xhtml: ['application/xhtml+xml; charset=utf-8', '<html xmlns="http://www.w3.org/1999/xhtml"><body>DOC</body></html>'],
        svg: ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><text>DOC</text></svg>'],
        json: ['application/json; charset=utf-8', '{"ok":true}'],
        png: ['image/png', 'PNG'],
      }[kind] || ['application/octet-stream', 'X'];
      const active = kind === 'html' || kind === 'svg';
      res.writeHead(200, {
        'content-type': meta[0],
        'content-disposition': 'inline; filename="doc.' + kind + '"',
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'sniff',
        'content-security-policy': "default-src *",
      });
      res.end(active ? meta[1] : meta[1]);
      return;
    }
    if (url.pathname === '/mobile/api/resource/raw') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'inline; filename="mobile-raw.html"',
        'cache-control': 'public, max-age=60',
      });
      res.end('<html><body>MOBILE_RAW</body></html>');
      return;
    }
    if (url.pathname === '/api/cookie') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [
          'cookie_a=1; HttpOnly; SameSite=Lax; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
          'cookie_b=2; sEcUrE; Path=/',
        ],
      });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/card-host/tools/invoke') {
      const delay = Math.max(0, Number(url.searchParams.get('delay')) || 0);
      const timer = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":true}');
      }, delay);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/api/echo' && req.method === 'POST') {
      echoHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/other-redirect') {
      res.writeHead(302, {
        location: redirectLocation,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=60',
      });
      res.end('<html><body>OTHER_REDIRECT</body></html>');
      return;
    }
    if (url.pathname === '/api/web-auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  upstream.on('upgrade', (req, socket) => {
    upgradeHits.push({ url: req.url, headers: req.headers });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: test\r\n' +
        '\r\n',
    );
    socket.end();
  });

  upstreamPort = await listen(upstream);
  // 即使本测试的 mock 身份不是 owner，也隔离一个伪 server-info，
  // 防止未来误把该身份判成 owner 时读到真实 ~/.hanako。
  await fsp.writeFile(
    path.join(hanaHome, 'server-info.json'),
    JSON.stringify({
      pid: process.pid,
      port: upstreamPort,
      token: 'FAKE_BOUNDARY_OWNER_TOKEN',
      serverId: 'boundary-server',
      serverNodeId: 'boundary-node',
      studioId: 'boundary-studio',
      userId: 'boundary-owner',
    }),
    { mode: 0o600 },
  );
}

function gatewayEnv({ port, overrides = {}, omitHost = false }) {
  const env = {
    ...process.env, HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upstreamPort),
    HANA_GW_PORT: String(port),
    HANA_GW_HOST: '127.0.0.1',
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
  if (omitHost) delete env.HANA_GW_HOST;
  Object.assign(env, overrides);
  return env;
}

async function startGateway({ overrides = {}, omitHost = false, timeoutMs = 10_000 } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY], {
    env: gatewayEnv({ port, overrides, omitHost }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    log += c.toString('utf8');
  });
  children.push(child);
  try {
    await waitTcp(port, timeoutMs);
  } catch (err) {
    throw new Error(`${err.message}\n${log}`);
  }
  return { port, child, log: () => log };
}

function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, log: '' });
      return;
    }
    let timer = null;
    const finish = (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, log: '' });
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      child.kill();
      finish(null, 'TIMEOUT');
    }, timeoutMs);
  });
}

async function startFailingGateway({ overrides = {}, omitHost = false } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY], {
    env: gatewayEnv({ port, overrides, omitHost }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    log += c.toString('utf8');
  });
  const result = await waitExit(child);
  return { ...result, log };
}

async function teardown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  // 保留 tests/artifacts 下的夹具，不递归删除。
  console.log(`artifacts kept at ${tmpRoot}`);
}

function originFor(port) {
  return `http://127.0.0.1:${port}`;
}

function post(port, rawPath, { origin, cookie, headers = {}, body = '{}' } = {}) {
  const h = { ...headers };
  if (origin !== undefined) h.origin = origin;
  if (cookie) h.cookie = cookie;
  return request(port, rawPath, { method: 'POST', headers: h, body });
}

function hitsTo(pathname, method) {
  return upstreamHits.filter((hit) => hit.pathname === pathname && (!method || hit.method === method));
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('纯策略：非 loopback 明文必须显式 opt-in', () => {
  assert.equal(isWriteMethod('POST'), true);
  assert.equal(isWriteMethod('OPTIONS'), false);
  assert.equal(isWsPath('/ws?x=1'), true);
  assert.equal(isWsPath('/ws/'), false);
  assert.equal(isCreateSessionPath('/api/sessions/new?x=1'), true);
  assert.equal(isLogoutPath('/api/web-auth/logout'), true);
  assert.equal(isWorkspaceContentPath('/api/mobile/workspace/content?path=a.html'), true);
  assert.equal(isWorkspaceContentPath('/api/workspace/content?path=a.html'), true);
  assert.equal(isWorkspaceContentPath('/api/mobile/workbench/content?path=a.html'), true);
  assert.equal(isWorkspaceContentPath('/api/workbench/content?path=a.html'), true);
  assert.equal(isWorkspaceContentPath('/api/mobile/workspace/content/extra'), false);
  assert.equal(isWorkspaceContentPath('/api/workspace/content-extra'), false);

  assert.deepEqual(evaluateBindPolicy({ host: '0.0.0.0' }), { ok: false, insecureLan: false });
  assert.deepEqual(evaluateBindPolicy({ host: '0.0.0.0', allowInsecureLan: true }), {
    ok: true,
    insecureLan: true,
  });
  assert.equal(evaluateBindPolicy({ host: '0.0.0.0', tls: true }).ok, true);
  assert.equal(isAllowedOrigin({ origin: originFor(24000), host: '127.0.0.1:24000', scheme: 'http' }), true);
  assert.equal(isAllowedOrigin({ origin: 'https://127.0.0.1:24000', host: '127.0.0.1:24000', scheme: 'http' }), false);
  assert.equal(isAllowedOrigin({ origin: 'null', host: '127.0.0.1:24000', scheme: 'http' }), false);
  assert.equal(parseAllowedOrigins('http://allowed.example').has('http://allowed.example'), true);

  const stripped = sanitizeUpstreamHeaders({
    authorization: 'Bearer attacker',
    'x-forwarded-for': '1.2.3.4',
    forwarded: 'for=1.2.3.4',
    'x-hana-input-draft-owner': 'bad',
    cookie: VALID_COOKIE,
    host: 'old',
  });
  assert.deepEqual(stripped, { cookie: VALID_COOKIE });
});

t('默认绑定 127.0.0.1，URL 显示实际 scheme', async () => {
  const gw = await startGateway({ omitHost: true });
  const log = gw.log();
  assert.match(log, /gateway listening on http:\/\/127\.0\.0\.1:/);
  const res = await request(gw.port, '/index.html');
  assert.equal(res.status, 200);
});

t('非 loopback + 明文未 opt-in：启动失败且提示开关', async () => {
  const result = await startFailingGateway({ overrides: { HANA_GW_HOST: '0.0.0.0' } });
  assert.notEqual(result.code, 0, `应启动失败：${result.log}`);
  assert.match(result.log, /HANA_GW_ALLOW_INSECURE_LAN=1/);
});

t('TLS 只配置一半：启动失败不降级', async () => {
  const result = await startFailingGateway({
    overrides: { HANA_GW_TLS_CERT_FILE: path.join(tmpRoot, 'missing.crt') },
  });
  assert.notEqual(result.code, 0, `应启动失败：${result.log}`);
  assert.match(result.log, /must both be set/);
});

t('TLS 证书坏：启动失败不降级', async () => {
  const cert = path.join(tmpRoot, 'bad.crt');
  const key = path.join(tmpRoot, 'bad.key');
  await fsp.writeFile(cert, 'not a certificate');
  await fsp.writeFile(key, 'not a key');
  const result = await startFailingGateway({
    overrides: {
      HANA_GW_TLS_CERT_FILE: cert,
      HANA_GW_TLS_KEY_FILE: key,
    },
  });
  assert.notEqual(result.code, 0, `应启动失败：${result.log}`);
  assert.match(result.log, /failed to create server|failed to read TLS/i);
});

t('写请求缺省 / null / 跨源 / 错 scheme 的 Origin 都拒绝', async () => {
  const cases = [
    ['缺省', undefined],
    ['null', 'null'],
    ['跨源', 'http://evil.example'],
    ['错 scheme', originFor(mainGw.port).replace('http://', 'https://')],
  ];
  for (const [label, origin] of cases) {
    const before = upstreamHits.length;
    const res = await post(mainGw.port, '/api/web-auth/login', { origin });
    assert.equal(res.status, 403, `${label} 应拒绝，实际 ${res.status}`);
    assert.equal(upstreamHits.length, before, `${label} 不应访问上游`);
  }
});

t('同源写请求放行，且不带 owner', async () => {
  const res = await post(mainGw.port, '/api/web-auth/login', { origin: originFor(mainGw.port) });
  assert.equal(res.status, 200);
  const hit = hitsTo('/api/web-auth/login', 'POST').at(-1);
  assert.ok(hit, '应命中上游');
  assert.equal(hit.headers.authorization, undefined, '不得注入 owner/bearer');
  assert.equal(hit.headers.cookie, undefined, '登录请求本来没有 Cookie');
});

t('显式 HANA_GW_ALLOWED_ORIGINS 放行跨源写', async () => {
  const gw = await startGateway({ overrides: { HANA_GW_ALLOWED_ORIGINS: 'http://allowed.example' } });
  const res = await post(gw.port, '/api/web-auth/login', { origin: 'http://allowed.example' });
  assert.equal(res.status, 200);
  assert.equal(hitsTo('/api/web-auth/login', 'POST').length > 0, true);
});

t('未登录新建会话：先 401，不访问上游', async () => {
  const before = hitsTo('/api/sessions/new', 'POST').length;
  const res = await post(mainGw.port, '/api/sessions/new', { origin: originFor(mainGw.port) });
  assert.equal(res.status, 401);
  assert.equal(res.body, 'unauthorized');
  assert.equal(hitsTo('/api/sessions/new', 'POST').length, before, '不应把未登录请求发给上游');
});

t('合法登录后上游 403 原样透传，仍不注入 owner', async () => {
  const before = hitsTo('/api/sessions/new', 'POST').length;
  const res = await post(mainGw.port, '/api/sessions/new', {
    origin: originFor(mainGw.port),
    cookie: VALID_COOKIE,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body, '{"error":"insufficient_scope","reason":"insufficient_capability"}');
  assert.equal(hitsTo('/api/sessions/new', 'POST').length, before + 1);
  const hit = hitsTo('/api/sessions/new', 'POST').at(-1);
  assert.equal(hit.headers.authorization, undefined, '不得注入 owner bearer');
  assert.equal(hit.headers.cookie, VALID_COOKIE, '必须保留客户端 Cookie');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mainGw.log().includes('insufficient_capability'), '错误响应正文不得写进日志');
});

t('伪造转发头 / Authorization / X-Hana 头在转发前被剔除', async () => {
  const res = await post(mainGw.port, '/api/echo', {
    origin: originFor(mainGw.port),
    cookie: VALID_COOKIE,
    headers: {
      authorization: 'Bearer attacker',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
      forwarded: 'for=1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'x-hana-input-draft-owner': 'attacker',
      'x-http-method-override': 'DELETE',
    },
  });
  assert.equal(res.status, 200);
  assert.ok(echoHeaders, '应命中 echo');
  for (const name of [
    'authorization',
    'x-forwarded-for',
    'x-forwarded-proto',
    'forwarded',
    'x-real-ip',
    'x-hana-input-draft-owner',
    'x-http-method-override',
  ]) {
    assert.equal(echoHeaders[name], undefined, `${name} 不应到达上游`);
  }
  assert.equal(echoHeaders.cookie, VALID_COOKIE, 'Cookie 必须保留');
  assert.match(echoHeaders.host, /^127\.0\.0\.1:/, 'Host 应改写为上游地址');
});

t('GET/HEAD/OPTIONS 不要求写 Origin，按只读路径处理', async () => {
  const get = await request(mainGw.port, '/index.html');
  assert.equal(get.status, 200);

  const head = await request(mainGw.port, '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);

  const options = await request(mainGw.port, '/api/echo', { method: 'OPTIONS' });
  assert.equal(options.status, 404, 'OPTIONS 应正常到上游，而不是被 Origin 保护拦成 403');
});

t('工作区 content 四个宿主别名：HTML/SVG 强制附件下载与安全响应头，HEAD 同样生效', async () => {
  const csp = "sandbox; default-src 'none'; frame-ancestors 'none'";
  for (const pathname of WORKSPACE_CONTENT_PATHS) {
    for (const kind of ['html', 'svg']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await request(mainGw.port, `${pathname}?kind=${kind}&path=evil.${kind}`, { method });
        assert.equal(res.status, 200, `${method} ${pathname} ${kind} 应成功`);
        assert.match(res.headers['content-type'], kind === 'svg' ? /^image\/svg\+xml/ : /^text\/html/);
        assert.match(res.headers['content-disposition'] || '', /^attachment(?:;|$)/);
        assert.ok(!String(res.headers['content-disposition']).toLowerCase().includes('inline'), '不得保留 inline');
        assert.ok(!String(res.headers['content-disposition']).includes('..'), 'filename 不得含 ..');
        assert.ok(!String(res.headers['content-disposition']).includes('/'), 'filename 不得含路径分隔符');
        if (kind === 'html') assert.ok(String(res.headers['content-disposition']).includes('preview.html'));
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['content-security-policy'], csp);
        if (method === 'HEAD') assert.equal(res.body, '', 'HEAD 不应返回正文');
      }
    }
  }
});

t('任意 /api 文档响应：HTML/XHTML/SVG 强制下载，JSON/普通图片不改', async () => {
  const genericCsp = "sandbox; default-src 'none'";
  for (const kind of ['html', 'xhtml', 'svg']) {
    for (const method of ['GET', 'HEAD']) {
      const res = await request(mainGw.port, `/api/doc?kind=${kind}`, { method });
      assert.equal(res.status, 200, `${method} ${kind} 应成功`);
      assert.match(res.headers['content-disposition'] || '', /^attachment(?:;|$)/);
      assert.ok(!String(res.headers['content-disposition']).toLowerCase().includes('inline'));
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['content-security-policy'], genericCsp);
      if (method === 'HEAD') assert.equal(res.body, '');
    }
  }

  for (const kind of ['json', 'png']) {
    const res = await request(mainGw.port, `/api/doc?kind=${kind}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-disposition'], `inline; filename="doc.${kind}"`, `${kind} 的 disposition 不应被改`);
    assert.equal(res.headers['cache-control'], 'public, max-age=60', `${kind} 的缓存不应被改`);
    assert.equal(res.headers['x-content-type-options'], 'sniff', `${kind} 的 nosniff 不应被加`);
    assert.equal(res.headers['content-security-policy'], 'default-src *', `${kind} 的 CSP 不应被改`);
  }
});

t('/mobile/api active document 也走同一 isApiPath 下载边界', async () => {
  const genericCsp = "sandbox; default-src 'none'";
  for (const method of ['GET', 'HEAD']) {
    const res = await request(mainGw.port, '/mobile/api/resource/raw', { method });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.headers['content-disposition'] || '', /^attachment(?:;|$)/);
    assert.ok(!String(res.headers['content-disposition']).toLowerCase().includes('inline'));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-security-policy'], genericCsp);
    if (method === 'HEAD') assert.equal(res.body, '');
  }
});

t('HTTPS Set-Cookie helper：逐条补 Secure，保留属性，数组不拆分', () => {
  const cookieA = 'cookie_a=1; HttpOnly; SameSite=Lax; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT';
  const cookieB = 'cookie_b=2; sEcUrE; Path=/';
  const original = [cookieA, cookieB];
  const secured = secureSetCookieHeaders(original, { secure: true });
  assert.deepEqual(secured, [`${cookieA}; Secure`, cookieB]);
  assert.equal(secured.length, 2, '多 cookie 数组不能合并或按逗号拆分');
  assert.equal(secured[1], cookieB, '已有 Secure（大小写不敏感）不得重复');

  assert.deepEqual(secureSetCookieHeaders(original, { secure: false }), original);
  assert.equal(
    secureSetCookieHeaders('cookie_a=1; Path=/, cookie_b=2', { secure: true }),
    'cookie_a=1; Path=/, cookie_b=2; Secure',
    '字符串输入也不能按逗号拆分',
  );
  assert.equal(secureSetCookieHeaders('cookie_a=1; Path=/;', { secure: true }), 'cookie_a=1; Path=/; Secure');
});

t('HTTP 网关不因 X-Forwarded-Proto 给上游 Set-Cookie 加 Secure', async () => {
  const res = await request(mainGw.port, '/api/cookie', {
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers['set-cookie'], [
    'cookie_a=1; HttpOnly; SameSite=Lax; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'cookie_b=2; sEcUrE; Path=/',
  ]);
});

t('card-host tools invoke 使用独立 timeout 策略，其它路径仍 60s', () => {
  assert.equal(upstreamIdleTimeoutFor('/api/card-host/tools/invoke'), 160_000);
  assert.equal(upstreamIdleTimeoutFor('/api/card-host/tools/invoke?x=1'), 160_000);
  assert.equal(upstreamIdleTimeoutFor('/api/card-host/tools/invoke/extra'), 60_000);
  assert.equal(upstreamIdleTimeoutFor('/api/chat'), 60_000);
  assert.equal(upstreamIdleTimeoutFor('/mobile/api/card-host/tools/invoke'), 60_000);
  assert.equal(upstreamIdleTimeoutFor('/api/card-host/tools/invoke', { toolInvokeMs: 300 }), 300);
  assert.equal(upstreamIdleTimeoutFor('/api/chat', { toolInvokeMs: 300 }), 60_000);
});

t('card-host tools invoke 慢调用：短配置验证独立 idle timeout，不真等 160 秒', async () => {
  const gw = await startGateway({ overrides: { HANA_GW_CARD_HOST_TOOL_IDLE_MS: '250' } });
  const started = Date.now();
  const res = await request(gw.port, '/api/card-host/tools/invoke?delay=800', { timeout: 5000 });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 502, '慢调用应在独立 idle timeout 后失败');
  assert.ok(elapsed < 2000, `不应等待默认 160 秒（实际 ${elapsed}ms）`);
});

t('workspace content 上游 3xx：502 download_redirect_blocked，不复制或跟随 Location，也不外联', async () => {
  const externalHits = [];
  const external = http.createServer((req, res) => {
    externalHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('external-hit');
  });
  const externalPort = await listen(external);
  const externalLocation = `http://127.0.0.1:${externalPort}/external-cookie-leak`;
  redirectLocation = externalLocation;
  try {
    for (const pathname of WORKSPACE_CONTENT_PATHS) {
      const res = await request(mainGw.port, `${pathname}?redirect=1`);
      assert.equal(res.status, 502, `${pathname} 3xx 应转换为 502`);
      assert.equal(res.headers.location, undefined, '失败响应不能带 Location');
      assert.equal(res.headers['set-cookie'], undefined, '不能复制上游 Set-Cookie');
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(JSON.parse(res.body), { error: 'download_redirect_blocked' });
    }

    const followHitsBefore = upstreamHits.filter((h) => h.pathname === '/api/other-redirect').length;
    redirectLocation = `http://127.0.0.1:${mainGw.port}/api/other-redirect`;
    const sameOrigin = await request(mainGw.port, '/api/workspace/content?redirect=1');
    assert.equal(sameOrigin.status, 502, '同源 Location 也必须拒绝');
    assert.equal(sameOrigin.headers.location, undefined);
    assert.equal(
      upstreamHits.filter((h) => h.pathname === '/api/other-redirect').length,
      followHitsBefore,
      '不能跟随同源 Location',
    );
    redirectLocation = externalLocation;

    const notModified = await request(mainGw.port, '/api/workspace/content?redirect=304');
    assert.equal(notModified.status, 502, '304 同样按失败处理');
    assert.equal(notModified.headers.location, undefined);

    const other = await request(mainGw.port, '/api/other-redirect');
    assert.equal(other.status, 302, '其它 API 3xx 行为不能被改');
    assert.equal(other.headers.location, redirectLocation);
    assert.equal(other.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(other.headers['cache-control'], 'public, max-age=60');
    assert.equal(other.headers['content-disposition'], undefined, '其它 API 重定向不应被改成下载');
    assert.equal(other.headers['content-security-policy'], undefined, '其它 API 重定向头不应被改');

    await sleep(100);
    assert.deepEqual(externalHits, [], '网关不能请求 Location 目标');
  } finally {
    await new Promise((resolve) => external.close(resolve));
  }
});

t('WS 错路径：拒绝且不碰上游', async () => {
  const beforeAuth = authCalls.length;
  const beforeUpgrade = upgradeHits.length;
  const res = await rawUpgrade(mainGw.port, {
    rawPath: '/not-ws?x=1',
    headers: { Origin: originFor(mainGw.port), Cookie: VALID_COOKIE },
  });
  assert.equal(statusOf(res), 404);
  assert.equal(authCalls.length, beforeAuth);
  assert.equal(upgradeHits.length, beforeUpgrade);
});

t('WS 无 Cookie：401 且不连上游 WS', async () => {
  const beforeAuth = authCalls.length;
  const beforeUpgrade = upgradeHits.length;
  const res = await rawUpgrade(mainGw.port, {
    rawPath: '/ws',
    headers: { Origin: originFor(mainGw.port) },
  });
  assert.equal(statusOf(res), 401);
  assert.equal(authCalls.length, beforeAuth, '无 Cookie 不应发起 session 查询');
  assert.equal(upgradeHits.length, beforeUpgrade);
});

t('WS 坏 Origin：403 且不连上游 WS', async () => {
  const beforeAuth = authCalls.length;
  const beforeUpgrade = upgradeHits.length;
  const res = await rawUpgrade(mainGw.port, {
    rawPath: '/ws',
    headers: { Origin: 'http://evil.example', Cookie: VALID_COOKIE },
  });
  assert.equal(statusOf(res), 403);
  assert.equal(authCalls.length, beforeAuth, '坏 Origin 不应触发 session 查询');
  assert.equal(upgradeHits.length, beforeUpgrade);
});

t('WS /ws?query + Cookie + 同源 Origin：升级，且头被清理', async () => {
  const beforeUpgrade = upgradeHits.length;
  const res = await rawUpgrade(mainGw.port, {
    rawPath: '/ws?client=mobile',
    headers: {
      Origin: originFor(mainGw.port),
      Cookie: VALID_COOKIE,
      Authorization: 'Bearer attacker',
      'X-Forwarded-For': '1.2.3.4',
      'X-Hana-Input-Draft-Owner': 'attacker',
    },
  });
  assert.equal(statusOf(res), 101);
  assert.equal(upgradeHits.length, beforeUpgrade + 1);
  const hit = upgradeHits.at(-1);
  assert.equal(hit.headers.authorization, undefined);
  assert.equal(hit.headers['x-forwarded-for'], undefined);
  assert.equal(hit.headers['x-hana-input-draft-owner'], undefined);
  assert.equal(hit.headers.cookie, VALID_COOKIE);
});

t('logout 成功后立即撤销 card token', async () => {
  const nav = await request(mainGw.port, cardUrl(cardDir), { headers: { cookie: VALID_COOKIE } });
  assert.equal(nav.status, 302);
  const location = nav.headers.location;
  assert.ok(location, '应拿到 card token 重定向');

  const logout = await post(mainGw.port, '/api/web-auth/logout', {
    origin: originFor(mainGw.port),
    cookie: VALID_COOKIE,
  });
  assert.equal(logout.status, 200);
  assert.equal(logoutCalls, 1);

  const after = await request(mainGw.port, location);
  assert.equal(after.status, 401, 'logout 后旧 card token 必须立即失效');
});

t('/gw/file 成功响应 no-store', async () => {
  const res = await request(mainGw.port, fileUrl(okPng), { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
});

t('/gw/debug/whoami 调试出口已移除', async () => {
  const res = await request(mainGw.port, '/gw/debug/whoami');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type'] || ''), /^text\/html/);
  assert.ok(!res.body.includes('no_client_cookie_seen_yet'));
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await makeFixtures();
  await startUpstream();
  mainGw = await startGateway();
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
