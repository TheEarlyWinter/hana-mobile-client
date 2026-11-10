/* gateway/server.mjs 的安全回归测试
 *
 * 覆盖：
 *   - /gw/file、/gw/card 未认证拒绝（401）
 *   - 有效 Cookie 放行（Cookie 必须透传给上游 /api/web-auth/session）
 *   - 上游不可用 / 上游报错时拒绝（503），不降级放行
 *   - 软链接/junction 越界拒绝（403），根与目标都按 realpath 判定
 *   - 正常卡片目录资源可访问
 *   - WS 帧日志开关关闭时不写 ws-frames 帧日志（请求日志照写入）
 *
 * 用 mock upstream 的 /api/web-auth/session 提供 {authenticated: boolean}，
 * 断言里不依赖真实 hana-server。
 *
 * 已知限制（Chromium 实测，2026-11）：卡片 iframe 是 sandbox="allow-scripts"，
 * 没有 allow-same-origin，文档 origin 是 opaque；它的子资源（img/css/fetch）
 * 不会携带 SameSite=Strict Cookie。因此开启鉴权后，目录卡片的外链资源会 401，
 * 只有 iframe 顶层导航能带上 Cookie。本文件不做浏览器内验证，详见汇报。
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
// 默认测仓库里的网关；HANA_GW_SERVER_PATH 只为对比历史版本（先红后绿）留的口子
const GATEWAY = process.env.HANA_GW_SERVER_PATH
  ? path.resolve(process.env.HANA_GW_SERVER_PATH)
  : path.resolve(__dirname, '..', 'gateway', 'server.mjs');

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const VALID_COOKIE = 'hana_session=valid';
const BAD_COOKIE = 'hana_session=bad';
const BOOM_COOKIE = 'hana_session=boom';

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

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, rawPath, { cookie, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath, headers }, (res) => {
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

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let sessionFiles;
let outsideDir;
let okPng;
let cardDir;
let evilCardDir;

const children = [];
const sessionCalls = [];
let upstream;
let upstreamPort;
let mainGateway;

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-sec-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  sessionFiles = path.join(hanaHome, 'session-files');
  const uploads = path.join(hanaHome, 'uploads');
  const attachments = path.join(hanaHome, 'attachments');
  await fsp.mkdir(sessionFiles, { recursive: true });
  await fsp.mkdir(uploads, { recursive: true });
  await fsp.mkdir(attachments, { recursive: true });

  okPng = path.join(sessionFiles, 'ok.png');
  await fsp.writeFile(okPng, TINY_PNG);

  cardDir = path.join(sessionFiles, 'card-ok');
  await fsp.mkdir(cardDir, { recursive: true });
  await fsp.writeFile(path.join(cardDir, 'index.html'), '<!doctype html><html><body><h1>CARD_OK</h1></body></html>');
  await fsp.writeFile(path.join(cardDir, 'style.css'), 'body{color:#123456}');
  await fsp.writeFile(path.join(cardDir, 'logo.png'), TINY_PNG);

  // 白名单之外的真实目录：软链接把读取范围带到这里就算越界
  outsideDir = path.join(tmpRoot, 'outside');
  evilCardDir = path.join(outsideDir, 'card');
  await fsp.mkdir(evilCardDir, { recursive: true });
  await fsp.writeFile(path.join(outsideDir, 'secret.png'), 'SECRET_PIXELS');
  await fsp.writeFile(path.join(evilCardDir, 'index.html'), '<!doctype html><h1>OUTSIDE_CARD</h1>');

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.symlink(outsideDir, path.join(sessionFiles, 'escape'), linkType);
  await fsp.symlink(evilCardDir, path.join(sessionFiles, 'card-evil'), linkType);
}

function gatewayEnv({ port, upPort, extra = {} }) {
  return {
    ...process.env, HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: String(port),
    HANA_GW_LOG_WS: '',
    ...extra,
  };
}

async function startGateway({ upPort = upstreamPort, script = GATEWAY, env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    env: gatewayEnv({ port, upPort, extra: env }),
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

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    if (req.url === '/api/web-auth/session') {
      sessionCalls.push(req.headers.cookie || '');
      const cookie = req.headers.cookie || '';
      if (cookie.includes(VALID_COOKIE)) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ authenticated: true, principal: { kind: 'local_user' } }));
      }
      if (cookie.includes(BOOM_COOKIE)) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end('{"error":"boom"}');
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ authenticated: false, principal: null }));
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  upstreamPort = await listen(upstream);
}

async function teardown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('/gw/file 无 Cookie → 401', async () => {
  const res = await request(mainGateway.port, fileUrl(okPng));
  assert.equal(res.status, 401);
  assert.equal(res.body.toString('utf8'), 'unauthorized');
});

t('/gw/file Cookie 无效 → 401，且 Cookie 原样透传给上游', async () => {
  const before = sessionCalls.length;
  const res = await request(mainGateway.port, fileUrl(okPng), { cookie: BAD_COOKIE });
  assert.equal(res.status, 401);
  assert.ok(sessionCalls.length > before, 'upstream 应该收到一次 session 查询');
  assert.equal(sessionCalls.at(-1), BAD_COOKIE, 'Cookie 必须透传，不能换成回环默认身份');
});

t('/gw/file 有效 Cookie → 200 原始字节', async () => {
  const res = await request(mainGateway.port, fileUrl(okPng), { cookie: VALID_COOKIE });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.ok(res.body.equals(TINY_PNG), '返回内容应与文件一致');
});

t('/gw/file 上游 500 → 503（不降级放行）', async () => {
  const res = await request(mainGateway.port, fileUrl(okPng), { cookie: BOOM_COOKIE });
  assert.equal(res.status, 503);
  assert.equal(res.body.toString('utf8'), 'auth service unavailable');
});

t('/gw/file 上游不可达 → 503', async () => {
  const deadPort = await freePort();
  const deadGw = await startGateway({ upPort: deadPort });
  const res = await request(deadGw.port, fileUrl(okPng), { cookie: VALID_COOKIE });
  assert.equal(res.status, 503);
  assert.equal(res.body.toString('utf8'), 'auth service unavailable');
});

t('/gw/file 软链接指向白名单外 → 403', async () => {
  const res = await request(mainGateway.port, fileUrl(path.join(sessionFiles, 'escape', 'secret.png')), {
    cookie: VALID_COOKIE,
  });
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('SECRET_PIXELS'), '不能读到白名单外的内容');
});

t('/gw/file 路径里的 .. 不能跳出白名单 → 403', async () => {
  // 故意不用 path.join（它会提前折叠 ..），让网关收到真的 .. 段
  const traversal = `${sessionFiles}${path.sep}..${path.sep}..${path.sep}outside${path.sep}secret.png`;
  const res = await request(mainGateway.port, fileUrl(traversal), { cookie: VALID_COOKIE });
  assert.equal(res.status, 403);
});

t('/gw/card 无 Cookie → 401', async () => {
  const res = await request(mainGateway.port, cardUrl(cardDir));
  assert.equal(res.status, 401);
  assert.ok(!res.body.toString('utf8').includes('CARD_OK'));
});

t('/gw/card 软链接目录指向白名单外 → 403', async () => {
  const res = await request(mainGateway.port, cardUrl(path.join(sessionFiles, 'card-evil')), {
    cookie: VALID_COOKIE,
  });
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_CARD'));
});

t('/gw/card 卡片目录内的 index/css/png 正常返回', async () => {
  // HTML 导航现在先 302 到带短时令牌的路径（sandbox iframe 的子资源靠它免 Cookie）
  const nav = await request(mainGateway.port, cardUrl(cardDir), { cookie: VALID_COOKIE });
  assert.equal(nav.status, 302);
  const location = nav.headers.location;
  assert.ok(location && location.startsWith(cardUrl(cardDir)), `Location 应在同一卡片路径下: ${location}`);

  const html = await request(mainGateway.port, location);
  assert.equal(html.status, 200);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(html.body.toString('utf8').includes('CARD_OK'));

  const css = await request(mainGateway.port, cardUrl(cardDir, 'style.css'), { cookie: VALID_COOKIE });
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.ok(css.body.toString('utf8').includes('#123456'));

  const png = await request(mainGateway.port, cardUrl(cardDir, 'logo.png'), { cookie: VALID_COOKIE });
  assert.equal(png.status, 200);
  assert.ok(png.body.equals(TINY_PNG));
});

t('静态资源不受鉴权影响，也不会去问上游', async () => {
  const before = sessionCalls.length;
  const res = await request(mainGateway.port, '/index.html');
  assert.equal(res.status, 200);
  assert.equal(sessionCalls.length, before, '静态资源不应触发 session 查询');
});

t('WS 帧日志开关关闭时不写 ws-frames 帧日志（请求日志照写）', async () => {
  const copyDir = path.join(tmpRoot, 'gw-copy');
  const copyGatewayDir = path.join(copyDir, 'gateway');
  const copyLogDir = path.join(copyDir, 'logs');
  await fsp.mkdir(copyGatewayDir, { recursive: true });
  const copyScript = path.join(copyGatewayDir, 'server.mjs');
  // 网关会 import 同目录的其他模块（local-owner / security-policy …）。
  // 整目录按 .mjs 扫一遍，以后再加模块不用回来改测试。
  const sourceGatewayDir = path.join(__dirname, '..', 'gateway');
  for (const name of await fsp.readdir(sourceGatewayDir)) {
    if (!name.endsWith('.mjs')) continue;
    await fsp.copyFile(path.join(sourceGatewayDir, name), path.join(copyGatewayDir, name));
  }

  // 结构化日志开着、只关 WS 帧开关：断言才能区分「没开帧日志」和「日志整个没写」。
  const gw = await startGateway({
    script: copyScript,
    env: { HANA_GATEWAY_LOG: '', HANA_GATEWAY_LOG_DIR: copyLogDir },
  });
  await new Promise((resolve) => {
    const sock = net.connect(gw.port, '127.0.0.1', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 500);
    });
    sock.on('error', () => resolve());
  });

  // 给日志落盘留一点时间（修复前这里会出现一条帧日志）
  await new Promise((r) => setTimeout(r, 300));
  const names = await fsp.readdir(copyLogDir).catch(() => []);
  assert.equal(
    names.some((name) => name.startsWith('ws-frames-')),
    false,
    `HANA_GW_LOG_WS 未开启时不应产生帧日志，实际：${names.join(',')}`,
  );
  assert.ok(
    names.some((name) => /^gateway-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)),
    `请求日志应该照写（否则这条断言证明不了什么），实际：${names.join(',')}`,
  );
  if (gw.child.exitCode === null) gw.child.kill();
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await makeFixtures();
  await startUpstream();
  mainGateway = await startGateway();
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
