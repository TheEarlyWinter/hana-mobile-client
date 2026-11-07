/* gateway/server.mjs 的 /api 路由测试（只测路由，不碰鉴权）
 *
 * 背景：isApiPath 之前直接拿 req.url 做前缀比较，req.url 带着 query，
 * 于是 `/api?x=1`、`/api?` 既不等于 `/api` 也不以 `/api/` 开头，被判成静态资源，
 * 前端拿到的是 index.html 而不是接口响应。
 *
 * 做法：起一个临时 mock upstream 记录收到的 req.url，再 spawn 网关子进程指向它，
 * 从测试进程发请求。用 http.request 的 path 选项而不是 fetch，是因为 URL 解析会把
 * 结尾的 `?` 吃掉——那样 `/api?` 这条用例根本发不出去，测不到缺陷。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');

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

function request(port, rawPath, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: rawPath,
        headers: { connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

let upstream;
let child;
let gatewayPort;
const hits = [];
let childLog = '';

async function setup() {
  upstream = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-mock-upstream': 'yes' });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamPort = upstream.address().port;

  gatewayPort = await freePort();
  child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env, HANA_GATEWAY_LOG: 'off',
      // 路由测试不触 owner/卡片路径，但仍显式隔离 HANA_HOME，避免以后误读真实 ~/.hanako。
      HANA_HOME: path.resolve(__dirname, 'artifacts', 'routing-hana-home'),
      HANA_UPSTREAM_HOST: '127.0.0.1',
      HANA_UPSTREAM_PORT: String(upstreamPort),
      HANA_GW_HOST: '127.0.0.1',
      HANA_GW_PORT: String(gatewayPort),
      HANA_GW_LOG_WS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => {
    childLog += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    childLog += c.toString('utf8');
  });
  child.once('error', (err) => {
    childLog += `[spawn error] ${err.message}\n`;
  });

  // 等网关可连（不依赖日志文案，轮询 /index.html 即可）
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`gateway 未就绪\n${childLog}`);
    try {
      await request(gatewayPort, '/index.html');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function teardown() {
  if (child && child.exitCode === null) {
    child.kill();
  }
  if (upstream) {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

/** 断言这次请求被转发到 mock upstream，且 query 原样保留。 */
async function assertProxied(rawPath) {
  const before = hits.length;
  const res = await request(gatewayPort, rawPath);
  assert.equal(res.headers['x-mock-upstream'], 'yes', `未被反代（status=${res.status}）`);
  assert.equal(hits.length, before + 1, 'upstream 应恰好收到一次请求');
  assert.equal(JSON.parse(res.body).url, rawPath, 'upstream 收到的 req.url 与客户端一致');
}

/** 断言这次请求没有进反代（走网关静态托管）。 */
async function assertNotProxied(rawPath) {
  const before = hits.length;
  const res = await request(gatewayPort, rawPath);
  assert.equal(res.headers['x-mock-upstream'], undefined, '不应进反代');
  assert.equal(hits.length, before, 'upstream 不应收到请求');
  assert.ok(String(res.headers['content-type'] || '').startsWith('text/html'), '应走静态托管');
}

t('/api（无 query）转发', async () => {
  await assertProxied('/api');
});

t('/api?x=1 转发', async () => {
  await assertProxied('/api?x=1');
});

t('/api?（空 query）转发', async () => {
  await assertProxied('/api?');
});

t('/api/chat?x=1&y=2 转发且 query 保留', async () => {
  await assertProxied('/api/chat?x=1&y=2');
});

t('/mobile/api/chat?x=1 转发', async () => {
  await assertProxied('/mobile/api/chat?x=1');
});

t('/index.html?x=1 不进反代', async () => {
  await assertNotProxied('/index.html?x=1');
});

t('/apiary?x=1 不被前缀误伤', async () => {
  await assertNotProxied('/apiary?x=1');
});

// 文档层不再发 Clear-Site-Data：那个头每次导航都会清掉该源的 HTTP 缓存，
// 而产物名已经跟着内容走、页面本身 no-store，版本切换不靠清缓存，
// 留着它等于每次开页都把 immutable 产物白缓存一遍。
t('HTML 响应不再发 Clear-Site-Data（否则 immutable 会被自己清掉）', async () => {
  const res = await request(gatewayPort, '/');
  assert.equal(res.status, 200, '首页应 200');
  assert.equal(res.headers['clear-site-data'], undefined, '文档层不应再发清缓存指令');
  assert.match(String(res.headers['cache-control'] || ''), /no-store/, '首页仍然必须每次回源');
});

t('JS 响应也不发 Clear-Site-Data（文档层都不发了，脚本更不该有）', async () => {
  const res = await request(gatewayPort, '/app.js');
  assert.equal(res.status, 200, 'app.js 应 200');
  assert.equal(res.headers['clear-site-data'], undefined, '静态脚本不应发清理指令');
});

/* ---- 运行 ---- */

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
  if (childLog) console.log(`\n--- gateway log ---\n${childLog.slice(-2000)}`);
}
process.exitCode = bad ? 1 : 0;
