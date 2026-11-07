/* gateway：受限日报卡片路由 /gw/feed/<itemId>/r<revision>/
 *
 * 背景：手机日报复用宿主烘焙的 HTML 卡片，但公开路径不能带本机路径。
 * 网关只接受 fi_ + 26 位 Crockford ULID 与正整数版本，定位 HANA_HOME 下
 * feed/items/<id>/card/rN，并复用旧卡片托管内核的鉴权、短时令牌、CSP 与流式响应。
 *
 * 覆盖：未认证 401（不是 404）、认证导航 302 + 令牌子资源、新前缀 CSP、HEAD/GET
 * 与流式、严格 ID/版本校验、双重编码与目录穿越、软链接别名到别的条目、令牌跨条目
 * 拒绝、logout 撤销、旧 /gw/card 路由未放宽且仍可用。全部使用临时 HANA_HOME 与假上游，
 * 不读真实配置、不连真实服务。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');

const VALID_COOKIE = 'hana_session=valid';
const TOKEN_RE = /^t_[A-Za-z0-9_-]{43}$/;
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/* 26 位 Crockford base32（不含 I/L/O/U） */
const ULID_A = '0123456789ABCDEFGHJKMNPQRS';
const ULID_B = 'ZYXWVTSRQPNMKJHGFEDCBA9876';
const ULID_C = '7654321ABCDEFGHJKMNPQRSTVW';
const ULID_D = 'ABCDEFGHJKMNPQRSTVWXYZ0123';
const ITEM_A = `fi_${ULID_A}`;
const ITEM_B = `fi_${ULID_B}`;
const ITEM_C = `fi_${ULID_C}`;
const ITEM_D = `fi_${ULID_D}`;

const BIG_CSS = Buffer.from(`/* feed card asset */\n${'a{color:#0a0b0c}\n'.repeat(60_000)}`, 'utf8');

const FEED_A_R1_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>A</title>
<script>window.__businessSawCard = !!(window.card && typeof window.card.invoke === 'function');</script>
<link rel="stylesheet" href="style.css"></head>
<body><h1>CARD_A_R1</h1><img id="logo" src="logo.png" alt=""></body></html>`;

const LEGACY_HTML = '<!doctype html><html><head><title>legacy</title></head><body><h1>LEGACY_CARD</h1></body></html>';

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

function request(port, rawPath, { cookie, headers: extraHeaders, method = 'GET', timeout = 10_000 } = {}) {
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

const feedUrl = (itemId, rev, rel = '') => `/gw/feed/${itemId}/r${rev}/${rel}`;
const legacyCardUrl = (dir, rel = '') => `/gw/card/${b64url(dir)}/${rel}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pathExists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let sessionFiles;
let feedItems;
let cardA1;
let outsideDir;
const children = [];
let upstream;
let upstreamPort;
let gw;
let authGate = null;
let authGateStarted = null;
let authGateStartedResolve = null;
let releaseAuthGate = null;

function armAuthGate() {
  authGate = new Promise((resolve) => {
    releaseAuthGate = resolve;
  });
  authGateStarted = new Promise((resolve) => {
    authGateStartedResolve = resolve;
  });
}

function openAuthGate() {
  if (releaseAuthGate) releaseAuthGate();
  authGate = null;
  authGateStarted = null;
  authGateStartedResolve = null;
  releaseAuthGate = null;
}

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-feed-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  sessionFiles = path.join(hanaHome, 'session-files');
  feedItems = path.join(hanaHome, 'feed', 'items');
  outsideDir = path.join(tmpRoot, 'outside');

  for (const dir of [sessionFiles, feedItems, outsideDir]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });

  // 旧路由仍要能读 session-files 下的卡片
  const legacyDir = path.join(sessionFiles, 'card-ok');
  await fsp.mkdir(legacyDir, { recursive: true });
  await fsp.writeFile(path.join(legacyDir, 'index.html'), LEGACY_HTML);
  await fsp.writeFile(path.join(legacyDir, 'style.css'), 'body{color:rgb(9, 9, 9)}');

  // 条目 A：r1 完整素材，r2 用来验证版本隔离
  cardA1 = path.join(feedItems, ITEM_A, 'card', 'r1');
  await fsp.mkdir(cardA1, { recursive: true });
  await fsp.writeFile(path.join(cardA1, 'index.html'), FEED_A_R1_HTML);
  await fsp.writeFile(path.join(cardA1, 'style.css'), 'body{color:rgb(7, 8, 9)}');
  await fsp.writeFile(path.join(cardA1, 'big.css'), BIG_CSS);
  await fsp.writeFile(path.join(cardA1, 'logo.png'), TINY_PNG);
  await fsp.writeFile(path.join(cardA1, 'data.json'), '{"ok":true}');
  await fsp.writeFile(path.join(feedItems, ITEM_A, 'item.json'), '{"secret":"ITEM_JSON_SECRET"}');

  const cardA2 = path.join(feedItems, ITEM_A, 'card', 'r2');
  await fsp.mkdir(cardA2, { recursive: true });
  await fsp.writeFile(path.join(cardA2, 'index.html'), '<!doctype html><html><body><h1>CARD_A_R2</h1></body></html>');

  // 条目 B：另一个条目的私有素材
  const cardB1 = path.join(feedItems, ITEM_B, 'card', 'r1');
  await fsp.mkdir(cardB1, { recursive: true });
  await fsp.writeFile(path.join(cardB1, 'index.html'), '<!doctype html><html><body><h1>CARD_B_R1</h1></body></html>');
  await fsp.writeFile(path.join(cardB1, 'secret.txt'), 'B_SECRET');

  // 条目 C：card/r1 指向 feed 根之外的目录
  await fsp.mkdir(path.join(feedItems, ITEM_C, 'card'), { recursive: true });
  await fsp.writeFile(path.join(outsideDir, 'index.html'), '<!doctype html><html><body><h1>OUTSIDE_CARD</h1></body></html>');
  await fsp.writeFile(path.join(outsideDir, 'secret.png'), 'OUTSIDE_SECRET');

  // 条目 D：card/r1 别名指向条目 A 的 r1
  await fsp.mkdir(path.join(feedItems, ITEM_D, 'card'), { recursive: true });

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.symlink(outsideDir, path.join(feedItems, ITEM_C, 'card', 'r1'), linkType);
  await fsp.symlink(cardA1, path.join(feedItems, ITEM_D, 'card', 'r1'), linkType);
  // 卡目录内部的链接也不能把资源指到外面
  await fsp.symlink(outsideDir, path.join(cardA1, 'nested'), linkType);
}

/**
 * 子网关只拿 Node/Windows 必需的基变量；HANA_HOME、上游、监听、网关选项都由夹具显式给。
 * 尤其不能继承 TLS 证书/密钥、HANA_GW_*、NODE_OPTIONS：它们会改变启动行为甚至触发真实文件读取。
 */
const GATEWAY_BASE_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SystemDrive',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'TMPDIR',
];

function gatewayEnv(port, { ttlMs } = {}) {
  const env = {};
  for (const key of GATEWAY_BASE_ENV_KEYS) {
    const actual = Object.keys(process.env).find((name) => name.toUpperCase() === key.toUpperCase());
    if (actual !== undefined && typeof process.env[actual] === 'string') env[key] = process.env[actual];
  }
  env.HANA_GATEWAY_LOG = 'off';
  env.HANA_HOME = hanaHome;
  env.HANA_UPSTREAM_HOST = '127.0.0.1';
  env.HANA_UPSTREAM_PORT = String(upstreamPort);
  env.HANA_GW_HOST = '127.0.0.1';
  env.HANA_GW_PORT = String(port);
  env.HANA_GW_LOG_WS = '';
  if (ttlMs) env.HANA_GW_CARD_TOKEN_TTL_MS = String(ttlMs);
  return env;
}

async function startUpstream() {
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/api/web-auth/session') {
      if (authGate) {
        const gate = authGate;
        authGateStartedResolve?.();
        await gate;
      }
      const authed = String(req.headers.cookie || '').includes(VALID_COOKIE);
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

async function startGateway({ ttlMs } = {}) {
  const port = await freePort();
  // 堆上限显式给，不从 NODE_OPTIONS 继承任何运行配置。
  const child = spawn(process.execPath, ['--max-old-space-size=256', GATEWAY], {
    env: gatewayEnv(port, { ttlMs }),
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
  return { port, child, log: () => log };
}

async function teardown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

/** Cookie 导航拿令牌；Location 形状固定为 <目录>/t_xxx/。 */
async function mintFeedToken(port, itemId = ITEM_A, rev = 1) {
  const res = await request(port, feedUrl(itemId, rev), { cookie: VALID_COOKIE });
  assert.equal(res.status, 302, `应重定向到令牌路径（实际 ${res.status}）：${res.body}`);
  const location = res.headers.location;
  assert.ok(typeof location === 'string', '缺少 Location');
  const prefix = `/gw/feed/${itemId}/r${rev}/`;
  assert.ok(location.startsWith(prefix), `Location 应落在新前缀下：${location}`);
  const token = location.slice(prefix.length).replace(/\/$/, '');
  assert.ok(TOKEN_RE.test(token), `令牌格式不对：${token}`);
  return { location, token, res };
}

/** 与 gateway/card-host.mjs 一致的卡片 CSP 期望值（location 含末尾斜线）。 */
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

t('夹具自检：条目 ID 是 fi_+26 位 Crockford ULID', () => {
  for (const id of [ITEM_A, ITEM_B, ITEM_C, ITEM_D]) {
    assert.match(id, /^fi_[0-9A-HJKMNP-TV-Z]{26}$/, `夹具 ID 不合法：${id}`);
  }
});

t('feed 卡片未认证 → 401，不重定向也不暴露条目是否存在', async () => {
  const known = await request(gw.port, feedUrl(ITEM_A, 1));
  assert.equal(known.status, 401);
  assert.equal(known.headers.location, undefined);
  const unknown = await request(gw.port, feedUrl(ITEM_B, 9));
  assert.equal(unknown.status, 401, '未登录不能因为条目不存在变成 404');
});

t('认证导航 → 302 到新前缀令牌路径，响应 no-store/no-referrer', async () => {
  const { res, token, location } = await mintFeedToken(gw.port);
  assert.equal(location, `/gw/feed/${ITEM_A}/r1/${token}/`);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.ok(!res.body.toString('utf8').includes('CARD_A_R1'), '302 不能顺手把正文发出去');
});

t('令牌 GET HTML → 200，runtime 先于业务脚本，CSP 前缀精确为新路由', async () => {
  const { location } = await mintFeedToken(gw.port);
  const res = await request(gw.port, location);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  const body = res.body.toString('utf8');
  assert.ok(body.startsWith('<!doctype html>'), '注入不能破坏 doctype');
  assert.ok(body.includes('CARD_A_R1'));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const runtimeAt = body.indexOf('__HANA_CARD_RUNTIME_INSTALLED__');
  const businessAt = body.indexOf('window.__businessSawCard');
  assert.ok(runtimeAt > -1, '缺少 shared runtime 注入');
  assert.ok(businessAt > runtimeAt, 'runtime 必须在首个业务脚本之前');
  assert.ok(body.includes('__hanaCardHeight'), '高度上报脚本必须保留');

  assert.equal(res.headers['content-security-policy'], cardCspFor(gw.port, location));
  const csp = res.headers['content-security-policy'];
  assert.ok(!csp.includes('allow-same-origin'), '不能放开 same-origin');
  assert.ok(!csp.includes('unsafe-eval'));
  assert.ok(!csp.includes('/gw/card/'), '新路由 CSP 不能沿用旧前缀');
  assert.ok(csp.includes("frame-ancestors 'self'"));
});

t('令牌子资源 CSS/PNG/JSON → 200，同前缀 CSP；无令牌不带 Cookie → 401', async () => {
  const { location } = await mintFeedToken(gw.port);
  const expected = cardCspFor(gw.port, location);

  const css = await request(gw.port, `${location}style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(css.headers['content-security-policy'], expected);
  assert.ok(css.body.toString('utf8').includes('rgb(7, 8, 9)'));
  assert.equal(css.headers['x-hana-card-source-version'], undefined, '非 HTML 资源没有源版本头');
  assert.equal(css.headers['content-disposition'], undefined);

  const png = await request(gw.port, `${location}logo.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.ok(png.body.equals(TINY_PNG));

  const json = await request(gw.port, `${location}data.json`);
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body.toString('utf8')), { ok: true });

  const noCookie = await request(gw.port, feedUrl(ITEM_A, 1, 'style.css'));
  assert.equal(noCookie.status, 401);
});

t('HEAD 与 GET 同源版本、同 CSP；HEAD 无正文', async () => {
  const { location } = await mintFeedToken(gw.port);
  const expectedVersion = `sha256:${createHash('sha256').update(FEED_A_R1_HTML, 'utf8').digest('hex')}`;

  const get = await request(gw.port, location);
  const head = await request(gw.port, location, { method: 'HEAD' });
  assert.equal(get.status, 200);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(get.headers['x-hana-card-source-version'], expectedVersion);
  assert.equal(head.headers['x-hana-card-source-version'], expectedVersion);
  assert.equal(head.headers['content-security-policy'], get.headers['content-security-policy']);

  const cssHead = await request(gw.port, `${location}style.css`, { method: 'HEAD' });
  assert.equal(cssHead.status, 200);
  assert.equal(cssHead.body.length, 0);
  assert.equal(Number(cssHead.headers['content-length']), Buffer.byteLength('body{color:rgb(7, 8, 9)}'));

  const navHead = await request(gw.port, feedUrl(ITEM_A, 1), { method: 'HEAD', cookie: VALID_COOKIE });
  assert.equal(navHead.status, 302);
  assert.equal(navHead.headers['x-hana-card-source-version'], undefined, '302 不应带源版本');
});

t('大素材按 content-length 流式返回完整字节', async () => {
  const { location } = await mintFeedToken(gw.port);
  const res = await request(gw.port, `${location}big.css`);
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), BIG_CSS.length);
  assert.equal(res.body.length, BIG_CSS.length);
  assert.equal(createHash('sha256').update(res.body).digest('hex'), createHash('sha256').update(BIG_CSS).digest('hex'));
});

t('缺文件 404；目录穿越到 item.json 与双重编码都被拒绝', async () => {
  const { location } = await mintFeedToken(gw.port);

  const missing = await request(gw.port, `${location}missing.css`);
  assert.equal(missing.status, 404);

  const escape = await request(gw.port, `${location}..%2f..%2fitem.json`);
  assert.equal(escape.status, 403);
  assert.ok(!escape.body.toString('utf8').includes('ITEM_JSON_SECRET'));

  const backslash = await request(gw.port, `${location}..%5c..%5citem.json`);
  assert.ok([403, 404].includes(backslash.status), `反斜杠穿越应被拒绝（实际 ${backslash.status}）`);
  assert.ok(!backslash.body.toString('utf8').includes('ITEM_JSON_SECRET'));

  const doubleEncoded = await request(gw.port, `${location}%252e%252e%252f%252e%252e%252fitem.json`);
  assert.ok([403, 404].includes(doubleEncoded.status), `双重编码应被拒绝（实际 ${doubleEncoded.status}）`);
  assert.ok(!doubleEncoded.body.toString('utf8').includes('ITEM_JSON_SECRET'));

  const linkedOut = await request(gw.port, `${location}nested/secret.png`);
  assert.equal(linkedOut.status, 403, '卡目录内的链接越界也必须拒绝');
  assert.ok(!linkedOut.body.toString('utf8').includes('OUTSIDE_SECRET'));
});

t('严格 ID/版本校验：非 fi_ ULID、小写、r0、r01、r-1、缺版本 → 400', async () => {
  const cases = [
    '/gw/feed/fi_short/r1/',
    '/gw/feed/fi_0123456789ABCDEFGHJKMNPQRi/r1/',
    `/gw/feed/${ITEM_A.toLowerCase()}/r1/`,
    `/gw/feed/${ITEM_A}/r0/`,
    `/gw/feed/${ITEM_A}/r01/`,
    `/gw/feed/${ITEM_A}/r-1/`,
    `/gw/feed/${ITEM_A}/x1/`,
    `/gw/feed/${ITEM_A}/`,
    '/gw/feed/../etc/r1/',
  ];
  for (const rawPath of cases) {
    const res = await request(gw.port, rawPath);
    assert.equal(res.status, 400, `${rawPath} 应 400（实际 ${res.status}）：${res.body}`);
  }
});

t('条目存在但版本不存在 → 认证后 404，不回落成 200 或 500', async () => {
  const res = await request(gw.port, feedUrl(ITEM_B, 2), { cookie: VALID_COOKIE });
  assert.equal(res.status, 404);
});

t('令牌跨条目/跨版本 → 403，读不到别条目素材', async () => {
  const { token } = await mintFeedToken(gw.port);
  const crossItem = await request(gw.port, `/gw/feed/${ITEM_B}/r1/${token}/secret.txt`);
  assert.equal(crossItem.status, 403);
  assert.ok(!crossItem.body.toString('utf8').includes('B_SECRET'));

  const crossRev = await request(gw.port, `/gw/feed/${ITEM_A}/r2/${token}/`);
  assert.equal(crossRev.status, 403);
  assert.ok(!crossRev.body.toString('utf8').includes('CARD_A_R2'));
});

t('软链接别名指向别的条目 → 403（不把 A 的卡片当 D 发出去）', async () => {
  const res = await request(gw.port, feedUrl(ITEM_D, 1), { cookie: VALID_COOKIE });
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('CARD_A_R1'));
});

t('card/rN 指向 feed 根之外 → 403，读不到外部目录', async () => {
  const res = await request(gw.port, feedUrl(ITEM_C, 1), { cookie: VALID_COOKIE });
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_CARD'));
});

t('feed 令牌不能用于 /gw/card 与 /gw/file', async () => {
  const { token } = await mintFeedToken(gw.port);
  const viaCard = await request(gw.port, `/gw/card/${b64url(path.join(sessionFiles, 'card-ok'))}/${token}/index.html`);
  assert.ok([401, 403].includes(viaCard.status), `feed 令牌不应能在 /gw/card 使用（实际 ${viaCard.status}）`);
  assert.ok(!viaCard.body.toString('utf8').includes('LEGACY_CARD'));

  const viaFile = await request(gw.port, `/gw/file/${token}/${b64url(path.join(cardA1, 'logo.png'))}`);
  assert.equal(viaFile.status, 401);
});

t('旧 /gw/card 未放宽：feed 目录不能借旧路由读出来', async () => {
  const card = await request(gw.port, legacyCardUrl(cardA1, 'index.html'), { cookie: VALID_COOKIE });
  assert.equal(card.status, 403, `feed 目录不在 CARD_ALLOWED_ROOTS 内（实际 ${card.status}）`);
  assert.ok(!card.body.toString('utf8').includes('CARD_A_R1'));

  const png = await request(gw.port, `/gw/file/${b64url(path.join(cardA1, 'logo.png'))}`, { cookie: VALID_COOKIE });
  assert.equal(png.status, 403, '/gw/file 仍只认三个白名单目录');
});

t('旧 /gw/card 仍可正常读 session-files 卡片，CSP 保持旧前缀', async () => {
  const legacyDir = path.join(sessionFiles, 'card-ok');
  const nav = await request(gw.port, legacyCardUrl(legacyDir), { cookie: VALID_COOKIE });
  assert.equal(nav.status, 302);
  const location = nav.headers.location;
  assert.match(location, /^\/gw\/card\/[A-Za-z0-9_-]+\/t_[A-Za-z0-9_-]{43}\/$/);
  const page = await request(gw.port, location);
  assert.equal(page.status, 200);
  assert.ok(page.body.toString('utf8').includes('LEGACY_CARD'));
  const csp = page.headers['content-security-policy'];
  assert.equal(csp, cardCspFor(gw.port, location));
  assert.ok(!csp.includes('/gw/feed/'), '旧路由 CSP 不能串到新前缀');

  const css = await request(gw.port, legacyCardUrl(legacyDir, 'style.css'), { cookie: VALID_COOKIE });
  assert.equal(css.status, 200);
  assert.ok(css.body.toString('utf8').includes('rgb(9, 9, 9)'));
});

t('卡 Host 非法 → 400，不把 Host 拼进 CSP', async () => {
  const res = await request(gw.port, feedUrl(ITEM_A, 1), {
    cookie: VALID_COOKIE,
    headers: { host: 'evil.test; script-src *' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers['content-security-policy'], undefined);
});

t('过期令牌 → 401（短 TTL 网关），重新导航可再取', async () => {
  const shortGw = await startGateway({ ttlMs: 250 });
  const { location } = await mintFeedToken(shortGw.port);
  await sleep(450);
  const expired = await request(shortGw.port, `${location}style.css`);
  assert.equal(expired.status, 401);
  assert.ok(!expired.body.toString('utf8').includes('rgb(7, 8, 9)'));

  const again = await mintFeedToken(shortGw.port);
  const page = await request(shortGw.port, again.location);
  assert.equal(page.status, 200);
  assert.ok(page.body.toString('utf8').includes('CARD_A_R1'));
});

t('logout 递增 epoch：旧 feed 令牌失效，跨 logout 的旧鉴权不再 mint', async () => {
  const old = await mintFeedToken(gw.port);
  armAuthGate();
  const pending = request(gw.port, feedUrl(ITEM_A, 1), { cookie: VALID_COOKIE });
  try {
    await authGateStarted;
    const logout = await request(gw.port, '/api/web-auth/logout', {
      method: 'POST',
      cookie: VALID_COOKIE,
      headers: { origin: `http://127.0.0.1:${gw.port}` },
    });
    assert.equal(logout.status, 200);
    openAuthGate();
    const late = await pending;
    assert.equal(late.status, 401, 'logout 后的旧 auth 不能 mint');
    assert.equal(late.headers.location, undefined, '不能迟到签发 Location');
    assert.ok(!late.body.toString('utf8').includes('t_'), '不能返回令牌');

    const stale = await request(gw.port, old.location);
    assert.equal(stale.status, 401, 'logout 后旧 feed 令牌必须失效');
  } finally {
    openAuthGate();
  }
});

t('受控污染环境（I3）：父进程注入 TLS 证书/密钥与 NODE_OPTIONS，子网关仍以 HTTP 假环境启动', async () => {
  const pollutionDir = path.join(tmpRoot, 'pollution');
  await fsp.mkdir(pollutionDir, { recursive: true });
  const certPath = path.join(pollutionDir, 'fake-cert.pem');
  const keyPath = path.join(pollutionDir, 'fake-key.pem');
  const guardPath = path.join(pollutionDir, 'node-options-guard.cjs');
  const guardMark = path.join(pollutionDir, 'node-options-ran');
  // 只写测试自建的假 PEM：若被继承，网关会去读它们并把它们当证书/私钥用。
  await fsp.writeFile(certPath, '-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n');
  await fsp.writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n');
  await fsp.writeFile(guardPath, `require('node:fs').writeFileSync(${JSON.stringify(guardMark)}, 'ran');\n`);

  const pollution = {
    HANA_GW_TLS_CERT_FILE: certPath,
    HANA_GW_TLS_KEY_FILE: keyPath,
    HANA_GW_EXTERNAL_HTTPS: '1',
    HANA_GW_ALLOWED_ORIGINS: 'https://pollution.invalid',
    // 用正斜线：NODE_OPTIONS 的分词器会把反斜线吞成转义字符。
    NODE_OPTIONS: `--require "${guardPath.split(path.sep).join('/')}"`,
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(pollution)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const pollutedGw = await startGateway();
    const { location } = await mintFeedToken(pollutedGw.port);
    const page = await request(pollutedGw.port, location);
    assert.equal(page.status, 200, '污染变量不应让子网关变成 HTTPS 或启动失败');
    const prefix = `http://127.0.0.1:${pollutedGw.port}${location}`;
    assert.ok(
      page.headers['content-security-policy'].includes(`script-src 'unsafe-inline' ${prefix}`),
      'CSP 仍应是本机 http 前缀，不能因为外部 HTTPS 变量变成 https',
    );
    assert.equal(await pathExists(guardMark), false, 'NODE_OPTIONS 不应被继承执行');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
      console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
    }
  }
} catch (err) {
  bad += 1;
  console.log(`FAIL  setup\n      ${err.stack || err.message}`);
} finally {
  await teardown();
}

if (bad) {
  console.log(`\n${bad} 个用例失败（共 ${tests.length} 个）`);
  process.exitCode = 1;
} else {
  console.log(`\nALL PASS（${tests.length} 个用例）`);
}
