/* gateway：卡片短时资源令牌
 *
 * 背景：卡片 iframe 是 sandbox="allow-scripts"（opaque origin），Chromium 不会给它的
 * 子资源请求带 SameSite=Strict Cookie。方案是卡片 HTML 导航（Cookie 鉴权通过）后
 * 302 到 /gw/card/<b64>/<token>/，令牌只绑定这个卡片真实目录、短时有效，子资源
 * 不带 Cookie 也能取；无令牌、跨目录、过期、目录穿越、链接越界、/gw/file 一律拒绝。
 *
 * 覆盖：无令牌拒绝、有效令牌子资源可用、跨目录/过期/越界拒绝、日志不出现令牌、
 * 令牌不可用于 /gw/file，以及真实 Chromium sandbox iframe 探针（找不到 Chrome 时跳过）。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');

// 后半段要起真实 Chromium 验 sandbox iframe，CI 上不稳定；开关关掉它。
const SKIP_BROWSER = process.env.HANA_SKIP_BROWSER_TESTS === '1';const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const VALID_COOKIE = 'hana_session=valid';
const TOKEN_RE = /^t_[A-Za-z0-9_-]{43}$/;

/* ---- 基础设施 ---- */

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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, rawPath, { cookie, headers: extraHeaders, method = 'GET', timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close', ...(extraHeaders || {}) };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

function waitTcp(port, timeoutMs = 15_000) {
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
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fileUrl = (absPath) => `/gw/file/${b64url(absPath)}`;
const cardUrl = (dir, rel = '') => `/gw/card/${b64url(dir)}/${rel}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let sessionFiles;
let cardA;
let cardB;
let okPng;
let outsideDir;

const children = [];
let upstream;
let upstreamPort;
let mainGw;
let tracker;
let trackerPort;
const trackerHits = [];
let authGate = null;
let authGateStarted = null;
let authGateStartedResolve = null;
let releaseAuthGate = null;

function armAuthGate() {
  authGate = new Promise((resolve) => { releaseAuthGate = resolve; });
  authGateStarted = new Promise((resolve) => { authGateStartedResolve = resolve; });
}

function openAuthGate() {
  if (releaseAuthGate) releaseAuthGate();
  authGate = null;
  authGateStarted = null;
  authGateStartedResolve = null;
  releaseAuthGate = null;
}

const CARD_A_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>A</title>
<script>window.__businessSawCard = !!(window.card && typeof window.card.invoke === 'function');</script>
<script type="module" src="probe.mjs"></script>
<link rel="stylesheet" href="style.css"></head>
<body><h1>CARD_A</h1><img id="logo" src="logo.png" alt="">
<img id="vector" src="vector.svg" alt="">
<script>
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const img = document.getElementById('logo');
  const imgOk = await new Promise((resolve) => {
    if (img.complete) return resolve(img.naturalWidth > 0);
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  const vector = document.getElementById('vector');
  const vectorImgOk = await new Promise((resolve) => {
    if (vector.complete) return resolve(vector.naturalWidth > 0);
    vector.onload = () => resolve(true);
    vector.onerror = () => resolve(false);
  });
  let fetchOk = false, fetchStatus = 0;
  try {
    const r = await fetch('data.json');
    fetchStatus = r.status;
    const j = await r.json();
    fetchOk = r.ok && j && j.ok === true;
  } catch {}
  for (let i = 0; i < 20 && !window.__localModule; i++) await wait(50);
  let externalImgLoaded = false;
  const externalImg = new Image();
  externalImg.onload = () => { externalImgLoaded = true; };
  externalImg.src = '__TRACKER_BASE__/blocked-card-image.png';
  await wait(200);
  let externalFetchOk = false;
  try {
    const r = await fetch('__TRACKER_BASE__/blocked-card-fetch');
    externalFetchOk = r.ok;
  } catch {}
  const externalFrame = document.createElement('iframe');
  externalFrame.src = '__TRACKER_BASE__/blocked-card-frame';
  document.body.appendChild(externalFrame);
  await wait(100);
  parent.postMessage({
    __cardProbe: {
      imgOk, fetchOk, fetchStatus, color: getComputedStyle(document.body).color,
      vectorImgOk,
      sdkVisible: !!window.__businessSawCard,
      localModule: !!window.__localModule,
      externalImgLoaded,
      externalFetchOk,
    },
  }, '*');
})();
</script>
</body></html>`;

const VECTOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">
<style>rect{fill:rgb(4, 5, 6)}</style>
<rect id="r" width="20" height="20"></rect>
<script><![CDATA[
(async () => {
  const fill = getComputedStyle(document.getElementById('r')).fill;
  const local = new Image();
  const localOk = await new Promise((resolve) => {
    local.onload = () => resolve(true);
    local.onerror = () => resolve(false);
    local.src = 'logo.png';
  });
  let externalImgLoaded = false;
  const externalImg = new Image();
  externalImg.onload = () => { externalImgLoaded = true; };
  externalImg.src = '__TRACKER_BASE__/blocked-svg-image.png';
  await new Promise((resolve) => setTimeout(resolve, 150));
  let externalFetchOk = false;
  try {
    const r = await fetch('__TRACKER_BASE__/blocked-svg-fetch');
    externalFetchOk = r.ok;
  } catch {}
  parent.postMessage({ __svgProbe: { fill, localOk, externalImgLoaded, externalFetchOk } }, '*');
})();
]]></script>
</svg>`;

const VECTOR_START_HTML = '<!doctype html><html><head></head><body><script>location.href="vector.svg";</script></body></html>';

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-token-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  sessionFiles = path.join(hanaHome, 'session-files');
  await fsp.mkdir(sessionFiles, { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });

  cardA = path.join(sessionFiles, 'card-a');
  await fsp.mkdir(cardA, { recursive: true });
  const cardHtml = CARD_A_HTML.replaceAll('__TRACKER_BASE__', `http://127.0.0.1:${trackerPort}`);
  await fsp.writeFile(path.join(cardA, 'index.html'), cardHtml);
  await fsp.writeFile(path.join(cardA, 'style.css'), 'body{color:rgb(1, 2, 3)}');
  await fsp.writeFile(path.join(cardA, 'logo.png'), TINY_PNG);
  await fsp.writeFile(path.join(cardA, 'data.json'), '{"ok":true}');
  await fsp.writeFile(path.join(cardA, 'probe.mjs'), 'window.__localModule = true;');
  await fsp.writeFile(
    path.join(cardA, 'vector.svg'),
    VECTOR_SVG.replaceAll('__TRACKER_BASE__', `http://127.0.0.1:${trackerPort}`),
  );
  await fsp.writeFile(path.join(cardA, 'vector-start.html'), VECTOR_START_HTML);

  cardB = path.join(sessionFiles, 'card-b');
  await fsp.mkdir(cardB, { recursive: true });
  await fsp.writeFile(path.join(cardB, 'index.html'), '<!doctype html><h1>CARD_B</h1>');
  await fsp.writeFile(path.join(cardB, 'secret.txt'), 'B_SECRET');

  okPng = path.join(sessionFiles, 'ok.png');
  await fsp.writeFile(okPng, TINY_PNG);

  outsideDir = path.join(tmpRoot, 'outside');
  await fsp.mkdir(outsideDir, { recursive: true });
  await fsp.writeFile(path.join(outsideDir, 'secret.png'), 'OUTSIDE_SECRET');

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.symlink(outsideDir, path.join(cardA, 'out'), linkType);
}

function gatewayEnv({ port, upPort, ttlMs, maxTokens, logDir }) {
  const env = {
    ...process.env,
    // 日志默认关掉：大多数用例只看 HTTP 响应。要求证「日志里有没有令牌」的用例
    // 必须自己给 logDir 打开结构化日志 —— 控制台那路已经不记请求了。
    HANA_GATEWAY_LOG: logDir ? 'on' : 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: String(port),
    HANA_GW_LOG_WS: '',
  };
  if (ttlMs) env.HANA_GW_CARD_TOKEN_TTL_MS = String(ttlMs);
  else delete env.HANA_GW_CARD_TOKEN_TTL_MS;
  if (maxTokens) env.HANA_GW_CARD_TOKEN_MAX = String(maxTokens);
  else delete env.HANA_GW_CARD_TOKEN_MAX;
  if (logDir) env.HANA_GATEWAY_LOG_DIR = logDir;
  else delete env.HANA_GATEWAY_LOG_DIR;
  return env;
}

async function startGateway({ upPort = upstreamPort, ttlMs, maxTokens, serverPath = GATEWAY, logDir } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: gatewayEnv({ port, upPort, ttlMs, maxTokens, logDir }),
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
    await waitTcp(port);
  } catch (err) {
    throw new Error(`${err.message}\n${log}`);
  }
  return { port, child, log: () => log, logDir };
}

/**
 * 读当天写下的结构化日志，等到 wants(text) 成立再返回，最多 deadlineMs。
 * 不能只看「文件非空」：启动时那一条 lifecycle 一落地就算非空，请求那条还没写进来。
 */
async function readStructuredLog(logDir, wants, deadlineMs = 3000) {
  const started = Date.now();
  let text = '';
  for (;;) {
    const files = await fsp.readdir(logDir).catch(() => []);
    const parts = [];
    for (const name of files.filter((n) => n.endsWith('.jsonl'))) {
      parts.push(await fsp.readFile(path.join(logDir, name), 'utf8').catch(() => ''));
    }
    text = parts.join('');
    if (wants(text) || Date.now() - started > deadlineMs) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 复制网关但故意不带 shared/card-runtime.mjs，验证懒加载 503 而不是启动崩溃。 */
async function makeGatewayWithoutShared() {
  const root = await fsp.mkdtemp(path.join(tmpRoot, 'gw-no-shared-'));
  const gatewayDir = path.join(root, 'gateway');
  await fsp.mkdir(gatewayDir, { recursive: true });
  await fsp.copyFile(GATEWAY, path.join(gatewayDir, 'server.mjs'));
  // 同目录的模块（local-owner / security-policy …）跟着复制，新增模块不用改测试
  const sourceGatewayDir = path.resolve(__dirname, '..', 'gateway');
  for (const name of await fsp.readdir(sourceGatewayDir)) {
    if (!name.endsWith('.mjs') || name === 'server.mjs') continue;
    await fsp.copyFile(path.join(sourceGatewayDir, name), path.join(gatewayDir, name));
  }
  return path.join(gatewayDir, 'server.mjs');
}

async function startUpstream() {
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/api/web-auth/session') {
      if (authGate) {
        const gate = authGate;
        authGateStartedResolve?.();
        await gate;
      }
      const cookie = req.headers.cookie || '';
      const authed = cookie.includes(VALID_COOKIE);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ authenticated: authed, principal: authed ? { kind: 'local_user' } : null }));
    }
    if (req.url === '/api/web-auth/logout' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"ok":true}');
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  upstreamPort = await listen(upstream);
}

async function startTracker() {
  tracker = http.createServer((req, res) => {
    trackerHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('tracker');
  });
  trackerPort = await listen(tracker);
}

async function teardown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (tracker) await new Promise((resolve) => tracker.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

/** 用 Cookie 拿一张卡片的 302，返回 { location, token }。 */
async function mintToken(port, dir = cardA) {
  const res = await request(port, cardUrl(dir), { cookie: VALID_COOKIE });
  assert.equal(res.status, 302, `应重定向到令牌路径（实际 ${res.status}）`);
  const location = res.headers.location;
  assert.ok(typeof location === 'string', '缺少 Location');
  const m = location.match(/^\/gw\/card\/([^/]+)\/(t_[A-Za-z0-9_-]{43})\/$/);
  assert.ok(m, `Location 形状不对: ${location}`);
  return { location, token: m[2], res };
}

/** 构造卡片 CSP；location 是 /gw/card/<b64>/ 或 /gw/card/<b64>/<token>/。 */
function cardCspFor(port, location) {
  const prefix = `http://127.0.0.1:${port}${location}`;
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${prefix}`,
    `style-src 'unsafe-inline' ${prefix}`,
    `img-src data: blob: ${prefix}`,
    `font-src data: blob: ${prefix}`,
    `media-src data: blob: ${prefix}`,
    `connect-src ${prefix}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('未认证的卡片 HTML 导航 → 401，不重定向', async () => {
  const res = await request(mainGw.port, cardUrl(cardA));
  assert.equal(res.status, 401);
  assert.equal(res.headers.location, undefined);
});

t('认证的卡片导航 → 302，Location 带令牌，响应 no-store/no-referrer', async () => {
  const { res, token } = await mintToken(mainGw.port);
  assert.ok(TOKEN_RE.test(token), '令牌格式不对');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

t('logout 递增 epoch：跨越 logout 的旧 auth 不 mint，旧 token 同时失效', async () => {
  const old = await mintToken(mainGw.port);
  armAuthGate();
  const pending = request(mainGw.port, cardUrl(cardA), { cookie: VALID_COOKIE });
  try {
    await authGateStarted;
    const logout = await request(mainGw.port, '/api/web-auth/logout', {
      method: 'POST',
      cookie: VALID_COOKIE,
      headers: { origin: `http://127.0.0.1:${mainGw.port}` },
    });
    assert.equal(logout.status, 200);
    openAuthGate();
    const late = await pending;
    assert.equal(late.status, 401, 'logout 后的旧 auth 不能 mint');
    assert.equal(late.headers.location, undefined, '不能迟到签发 Location');
    assert.ok(!late.body.toString('utf8').includes('t_'), '不能返回 token');
    const stale = await request(mainGw.port, old.location);
    assert.equal(stale.status, 401, 'logout 后旧 token 必须失效');
  } finally {
    openAuthGate();
  }
});

t('跟随重定向（不带 Cookie）→ 200 卡片 HTML，响应头正确且 runtime 早于业务脚本', async () => {
  const { location, token } = await mintToken(mainGw.port);
  const res = await request(mainGw.port, location);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  const body = res.body.toString('utf8');
  assert.ok(body.startsWith('<!doctype html>'), '注入不能破坏 doctype');
  assert.ok(body.includes('CARD_A'));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.ok(!body.includes(token), '令牌不应被注入 HTML 正文');

  const runtimeAt = body.indexOf('__HANA_CARD_RUNTIME_INSTALLED__');
  const businessAt = body.indexOf('window.__businessSawCard');
  assert.ok(runtimeAt > -1, '缺少 shared runtime 注入');
  assert.ok(businessAt > runtimeAt, 'runtime 必须在首个业务脚本之前');
  assert.ok(body.includes('__hanaCardHeight'), 'height 脚本必须保留');

  const expectedCsp = cardCspFor(mainGw.port, location);
  assert.equal(res.headers['content-security-policy'], expectedCsp);
  assert.ok(!res.headers['content-security-policy'].includes('allow-same-origin'));
  assert.ok(!res.headers['content-security-policy'].includes('unsafe-eval'));
  assert.ok(!res.headers['content-security-policy'].includes('https:'));
});

t('卡片 HTML 源版本头：GET/HEAD 同值，按注入前原文件哈希，源变化后变化', async () => {
  const sourcePath = path.join(cardA, 'index.html');
  const original = await fsp.readFile(sourcePath);
  const originalText = original.toString('utf8');
  const expected = `sha256:${createHash('sha256').update(originalText, 'utf8').digest('hex')}`;

  const { res: redirectRes, location } = await mintToken(mainGw.port);
  assert.equal(redirectRes.headers['x-hana-card-source-version'], undefined, '302 不应带源版本');

  // 父级实际路径：HEAD 原卡目录 URL -> 302 -> HEAD 同源 token URL，读取可信版本。
  const headNav = await request(mainGw.port, cardUrl(cardA), { method: 'HEAD', cookie: VALID_COOKIE });
  assert.equal(headNav.status, 302);
  assert.ok(headNav.headers.location);
  assert.equal(headNav.headers['x-hana-card-source-version'], undefined);
  const headViaRedirect = await request(mainGw.port, headNav.headers.location, { method: 'HEAD' });
  assert.equal(headViaRedirect.status, 200);
  assert.equal(headViaRedirect.body.length, 0);
  assert.equal(headViaRedirect.headers['x-hana-card-source-version'], expected);

  const get = await request(mainGw.port, location);
  const head = await request(mainGw.port, location, { method: 'HEAD' });
  assert.equal(get.status, 200);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.match(get.headers['x-hana-card-source-version'] || '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(get.headers['x-hana-card-source-version'], expected);
  assert.equal(head.headers['x-hana-card-source-version'], expected, 'HEAD 必须返回同一可信版本');

  const unauth = await request(mainGw.port, cardUrl(cardA));
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers['x-hana-card-source-version'], undefined, '未认证响应不应带源版本');

  try {
    await fsp.appendFile(sourcePath, '\n<!-- source-version-change -->');
    const changedSource = (await fsp.readFile(sourcePath)).toString('utf8');
    const changedExpected = `sha256:${createHash('sha256').update(changedSource, 'utf8').digest('hex')}`;
    const changed = await request(mainGw.port, location);
    assert.equal(changed.status, 200);
    assert.equal(changed.headers['x-hana-card-source-version'], changedExpected);
    assert.notEqual(changed.headers['x-hana-card-source-version'], expected, '修改源文件后版本必须变化');
  } finally {
    await fsp.writeFile(sourcePath, original);
  }
});

t('shared/card-runtime.mjs：唯一公开固定文件、GET/HEAD、无目录穿越', async () => {
  const res = await request(mainGw.port, '/shared/card-runtime.mjs');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-security-policy'], undefined, '静态 JS 不应强套 CSP sandbox');
  const body = res.body.toString('utf8');
  assert.ok(body.includes('export const CARD_RUNTIME_SCRIPT'));
  assert.ok(body.includes('__HANA_CARD_RUNTIME_INSTALLED__'));

  const head = await request(mainGw.port, '/shared/card-runtime.mjs', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(head.body.length, 0);

  const post = await request(mainGw.port, '/shared/card-runtime.mjs', {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${mainGw.port}` },
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');

  const traversal = await request(mainGw.port, '/shared/../gateway/server.mjs');
  assert.equal(traversal.status, 404);
  assert.ok(!traversal.body.toString('utf8').includes('HANA_GW_CARD_TOKEN'));
  const encodedTraversal = await request(mainGw.port, '/shared/%2e%2e/gateway/server.mjs');
  assert.equal(encodedTraversal.status, 404);
  const encodedSlash = await request(mainGw.port, '/shared/card-runtime.mjs%2f..%2f..%2fserver.mjs');
  assert.equal(encodedSlash.status, 404);
  const other = await request(mainGw.port, '/shared/card-runtime.mjs/extra');
  assert.equal(other.status, 404);
  const directory = await request(mainGw.port, '/shared/');
  assert.equal(directory.status, 404);
});

t('顶层 app HTML 加最小 CSP，静态 CSS 不强套 sandbox', async () => {
  const app = await request(mainGw.port, '/index.html');
  assert.equal(app.status, 200);
  assert.equal(app.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(
    app.headers['content-security-policy'],
    "frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  const css = await request(mainGw.port, '/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-security-policy'], undefined);
  const cached = await request(mainGw.port, '/index.html', { headers: { 'if-none-match': app.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers['content-security-policy'], app.headers['content-security-policy']);
});

t('shared runtime 缺失：卡片 HTML 明确 503，不静默退回无桥', async () => {
  const missingServer = await makeGatewayWithoutShared();
  const gw = await startGateway({ serverPath: missingServer });
  const html = await request(gw.port, cardUrl(cardA), { cookie: VALID_COOKIE });
  assert.equal(html.status, 503);
  assert.match(html.body.toString('utf8'), /card runtime unavailable/);
  const runtime = await request(gw.port, '/shared/card-runtime.mjs');
  assert.equal(runtime.status, 503);
});

t('卡片 Host 非法：400，不把 Host 拼进 CSP', async () => {
  const res = await request(mainGw.port, cardUrl(cardA), {
    cookie: VALID_COOKIE,
    headers: { host: 'evil.test; script-src *' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers['content-security-policy'], undefined);
});

t('有效令牌子资源（CSS/图片/JSON）无需 Cookie → 200', async () => {
  const { location } = await mintToken(mainGw.port);
  const css = await request(mainGw.port, `${location}style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.ok(css.body.toString('utf8').includes('rgb(1, 2, 3)'));
  assert.equal(css.headers['cache-control'], 'no-store');
  assert.equal(css.headers['referrer-policy'], 'no-referrer');
  assert.equal(css.headers['content-security-policy'], cardCspFor(mainGw.port, location));
  assert.equal(css.headers['content-disposition'], undefined);

  const png = await request(mainGw.port, `${location}logo.png`);
  assert.equal(png.status, 200);
  assert.ok(png.body.equals(TINY_PNG));

  const json = await request(mainGw.port, `${location}data.json`);
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body.toString('utf8')), { ok: true });
});

t('卡片 SVG 与无 token 资源也带同卡 CSP，不强制 attachment、不注入 runtime', async () => {
  const { location } = await mintToken(mainGw.port);
  const tokenCsp = cardCspFor(mainGw.port, location);
  const svg = await request(mainGw.port, `${location}vector.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.equal(svg.headers['content-security-policy'], tokenCsp);
  assert.equal(svg.headers['content-disposition'], undefined);
  assert.equal(svg.headers['x-hana-card-source-version'], undefined);
  assert.ok(svg.body.toString('utf8').includes('<svg'));
  assert.ok(!svg.body.toString('utf8').includes('__HANA_CARD_RUNTIME_INSTALLED__'), 'SVG 不应注入 runtime');

  const svgHead = await request(mainGw.port, `${location}vector.svg`, { method: 'HEAD' });
  assert.equal(svgHead.status, 200);
  assert.equal(svgHead.headers['content-security-policy'], tokenCsp);
  assert.equal(svgHead.body.length, 0);

  const noTokenPath = cardUrl(cardA);
  const noTokenCsp = cardCspFor(mainGw.port, noTokenPath);
  const noTokenCss = await request(mainGw.port, cardUrl(cardA, 'style.css'), { cookie: VALID_COOKIE });
  assert.equal(noTokenCss.status, 200);
  assert.equal(noTokenCss.headers['content-security-policy'], noTokenCsp);
  assert.ok(!noTokenCss.headers['content-security-policy'].includes('null'), '无 token prefix 不能是字符串 null');
  assert.ok(noTokenCsp.includes(noTokenPath), '无 token CSP 必须限定到本卡目录');
  assert.ok(!noTokenCsp.includes('/gw/card/;'), '无 token CSP 不能扩大到整个同源');
});

t('无令牌子资源（不带 Cookie）→ 401', async () => {
  const res = await request(mainGw.port, cardUrl(cardA, 'style.css'));
  assert.equal(res.status, 401);
});

t('令牌跨目录 → 403，读不到别的卡片', async () => {
  const { token } = await mintToken(mainGw.port);
  const res = await request(mainGw.port, `/gw/card/${b64url(cardB)}/${token}/secret.txt`);
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('B_SECRET'));
});

t('令牌 + 目录穿越（../ 到别的卡片）→ 403', async () => {
  const { location } = await mintToken(mainGw.port);
  const res = await request(mainGw.port, `${location}..%2fcard-b%2fsecret.txt`);
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('B_SECRET'));
});

t('令牌 + 卡片目录内的链接越界 → 403', async () => {
  const { location } = await mintToken(mainGw.port);
  const res = await request(mainGw.port, `${location}out/secret.png`);
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_SECRET'));
});

t('令牌不能用于 /gw/file', async () => {
  const { token } = await mintToken(mainGw.port);
  const viaQuery = await request(mainGw.port, `${fileUrl(okPng)}?t=${token}`);
  assert.equal(viaQuery.status, 401);
  const viaPath = await request(mainGw.port, `/gw/file/${token}/${b64url(okPng)}`);
  assert.equal(viaPath.status, 401);
});

t('过期令牌 → 401（短 TTL 网关）', async () => {
  const gw = await startGateway({ ttlMs: 250 });
  const { location } = await mintToken(gw.port);
  await sleep(450);
  const res = await request(gw.port, `${location}style.css`);
  assert.equal(res.status, 401);
  // 重新导航可以再拿一张新令牌
  const again = await mintToken(gw.port);
  const html = await request(gw.port, again.location);
  assert.equal(html.status, 200);
});

t('令牌有界：超过上限后最旧的被淘汰', async () => {
  const gw = await startGateway({ maxTokens: 3 });
  const first = await mintToken(gw.port);
  await mintToken(gw.port);
  await mintToken(gw.port);
  const last = await mintToken(gw.port);
  const oldRes = await request(gw.port, `${first.location}style.css`);
  assert.equal(oldRes.status, 401, '最旧的令牌应已被淘汰');
  const newRes = await request(gw.port, `${last.location}style.css`);
  assert.equal(newRes.status, 200);
});

t('访问日志不含令牌原文', async () => {
  // 控制台那路已经不记请求了（每请求一条结构化记录），所以这里要真开日志才验得到。
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-card-token-log-'));
  const gw = await startGateway({ logDir });
  const { location, token } = await mintToken(gw.port);
  await request(gw.port, `${location}style.css`);
  const log = await readStructuredLog(logDir, (text) => text.includes('style.css'));
  assert.ok(log.includes('t_[redacted]'), '应看到被脱敏的令牌位置');
  assert.ok(!log.includes(token), '访问日志里出现了令牌原文');
});

t('受控 Chromium：SDK 先于业务脚本；外网 img/fetch/iframe 被 CSP 拒绝，本地资源与 ES module 可用', async () => {
  if (SKIP_BROWSER) return 'skip';
  const chrome = findChrome();
  if (!chrome) return 'skip';

  const { location } = await mintToken(mainGw.port);
  const cardUrlAbs = `http://127.0.0.1:${mainGw.port}${location}`;
  const trackerBase = `http://127.0.0.1:${trackerPort}`;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-chrome-'));
  let browser;
  let cdp;
  try {
    browser = await startChrome(chrome, profile);
    cdp = await connectCdp(await findPageTarget(browser.port));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const loaded = cdp.once('Page.loadEventFired', 20_000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${mainGw.port}/` });
    await loaded;
    await sleep(300);

    const evaluate = async (expression) => {
      const out = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: false,
        returnByValue: true,
      });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'Runtime.evaluate failed');
      return out.result?.value;
    };

    trackerHits.length = 0;
    await evaluate(`(() => {
      window.__probe = null;
      window.addEventListener('message', (e) => {
        if (e.data && e.data.__cardProbe) window.__probe = e.data.__cardProbe;
      });
      const sr = document.createElement('iframe');
      sr.id = '__srcdoc_probe';
      sr.srcdoc = '<p id="inside">srcdoc-ok</p>';
      document.body.appendChild(sr);
      const external = document.createElement('iframe');
      external.id = '__external_top_frame';
      external.src = ${JSON.stringify(`${trackerBase}/blocked-top-frame`)};
      document.body.appendChild(external);
      const card = document.createElement('iframe');
      card.setAttribute('sandbox', 'allow-scripts');
      card.src = ${JSON.stringify(cardUrlAbs)};
      document.body.appendChild(card);
      return true;
    })()`);

    let probe = null;
    for (let i = 0; i < 100; i += 1) {
      probe = await evaluate('window.__probe');
      if (probe) break;
      await sleep(100);
    }
    assert.ok(probe, '卡片 iframe 没有回报探针结果');
    assert.equal(probe.sdkVisible, true, '首个业务脚本看不到 window.card');
    assert.equal(probe.localModule, true, '本地 ES module 没有执行');
    assert.equal(probe.imgOk, true, '本地图片没有通过令牌加载');
    assert.equal(probe.vectorImgOk, true, 'SVG 作为 img 没有被正常加载');
    assert.equal(probe.fetchOk, true, `本地 fetch 失败（status=${probe.fetchStatus}）`);
    assert.equal(probe.color, 'rgb(1, 2, 3)', '本地 CSS 没有生效');
    assert.equal(probe.externalImgLoaded, false, '外网图片没有被 CSP 拒绝');
    assert.equal(probe.externalFetchOk, false, '外网 fetch 没有被 CSP 拒绝');

    const srcdocText = await evaluate('document.getElementById("__srcdoc_probe")?.contentDocument?.body?.textContent || ""');
    assert.equal(srcdocText, 'srcdoc-ok', 'frame-src self 不应阻断 srcdoc');

    // HTML 先加载，再同源导航到 SVG 文档；验证 SVG 文档自身的 CSP，而不是顶层
    // frame-src 对直接外部 iframe 的拦截。
    await evaluate(`(() => {
      window.__svgProbe = null;
      window.addEventListener('message', (e) => {
        if (e.data && e.data.__svgProbe) window.__svgProbe = e.data.__svgProbe;
      });
      const svgFrame = document.createElement('iframe');
      svgFrame.setAttribute('sandbox', 'allow-scripts');
      svgFrame.src = ${JSON.stringify(`${cardUrlAbs}vector-start.html`)};
      document.body.appendChild(svgFrame);
      return true;
    })()`);
    let svgProbe = null;
    for (let i = 0; i < 100; i += 1) {
      svgProbe = await evaluate('window.__svgProbe');
      if (svgProbe) break;
      await sleep(100);
    }
    assert.ok(svgProbe, '同源 SVG 文档没有回报探针结果');
    assert.equal(svgProbe.fill, 'rgb(4, 5, 6)', 'SVG 内联样式没有生效');
    assert.equal(svgProbe.localOk, true, 'SVG 本地图片没有加载');
    assert.equal(svgProbe.externalImgLoaded, false, 'SVG 外网图片没有被 CSP 拒绝');
    assert.equal(svgProbe.externalFetchOk, false, 'SVG 外网 fetch 没有被 CSP 拒绝');

    await sleep(300);
    const blocked = trackerHits.filter((p) => p.startsWith('/blocked-'));
    assert.deepEqual(blocked, [], `外网 iframe/img/fetch 不应到达 tracker：${blocked.join(',')}`);
  } finally {
    if (cdp) cdp.close();
    if (browser?.child && browser.child.exitCode === null) browser.child.kill();
    await sleep(200);
    await fsp.rm(profile, { recursive: true, force: true });
  }
});

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

async function startChrome(chrome, profile) {
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr.on('data', (c) => {
    err += c.toString('utf8');
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`chrome 提前退出 ${child.exitCode}\n${err.slice(-800)}`);
    try {
      const text = await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
      const port = Number(text.split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return { child, port };
    } catch {
      // Chrome 还在启动
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`chrome 远程调试未就绪\n${err.slice(-800)}`);
}

async function findPageTarget(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // 页面 target 还没就绪
    }
    await sleep(100);
  }
  throw new Error('chrome 页面 target 未就绪');
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    let opened = false;
    const pending = new Map();
    const waiters = new Map();

    const failPending = (err) => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(err);
      }
      pending.clear();
    };

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id) {
        const item = pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error.message || 'CDP error'));
        else item.resolve(msg.result);
        return;
      }
      const list = waiters.get(msg.method);
      if (list && list.length) {
        const waiter = list.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(msg.params);
      }
    });
    ws.addEventListener('error', () => {
      if (!opened) reject(new Error('CDP websocket 连接失败'));
      failPending(new Error('CDP websocket 错误'));
    });
    ws.addEventListener('close', () => failPending(new Error('CDP websocket 已关闭')));
    ws.addEventListener('open', () => {
      opened = true;
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} 超时`));
            }, 15_000);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        once(method, timeout = 10_000) {
          return new Promise((res, rej) => {
            const list = waiters.get(method) || [];
            const timer = setTimeout(() => {
              const current = waiters.get(method) || [];
              const idx = current.indexOf(waiter);
              if (idx >= 0) current.splice(idx, 1);
              rej(new Error(`CDP 事件 ${method} 超时`));
            }, timeout);
            const waiter = { resolve: res, reject: rej, timer };
            list.push(waiter);
            waiters.set(method, list);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      });
    });
  });
}

/* ---- 运行 ---- */

let bad = 0;
let skipped = 0;
try {
  await startTracker();
  await makeFixtures();
  await startUpstream();
  mainGw = await startGateway();
  for (const [name, fn] of tests) {
    try {
      const result = await fn();
      if (result === 'skip') {
        skipped += 1;
        console.log(`SKIP  ${name}`);
      } else {
        console.log(`PASS  ${name}`);
      }
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
  console.log(`\n${bad} 个用例失败${skipped ? `，${skipped} 个跳过` : ''}`);
  process.exitCode = 1;
}
