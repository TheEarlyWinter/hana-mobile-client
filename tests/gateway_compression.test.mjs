/* 网关响应压缩回归：/api 反代路径上的按需 gzip。
 *
 * 背景：手机端「消息列表打开慢」的主因是明文 JSON 要从家里上行经 frp 隧道送到 VPS。
 * 一次 /api/sessions/messages?limit=50 的响应约 92KB 明文，gzip 后约四分之一。
 *
 * 覆盖：
 * - 可压类型 + accept-encoding: gzip → gzip、删 content-length、解压后逐字节一致
 * - 不带 accept-encoding → 原样透传，但仍标 Vary（中间缓存不能把压缩体发给不支持的客户端）
 * - text/event-stream / application/x-ndjson → 不压，且分块按到达顺序立即下发（没缓冲）
 * - 上游已带 content-encoding → 不二次压缩
 * - 204/304/HEAD、图片、cache-control: no-transform → 不压
 * - Vary 合并：不覆盖上游已有的 origin
 * - 客户端在压缩响应中途断开 → 上游 socket 被销毁，网关存活且仍能服务
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.HANA_GW_SERVER_PATH
  ? path.resolve(process.env.HANA_GW_SERVER_PATH)
  : path.join(ROOT, 'gateway', 'server.mjs');

const gunzip = promisify(zlib.gunzip);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 4000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return Boolean(fn());
}

/** 给「应该尽快发生」的事加个上限：超时即判失败，而不是拿固定 sleep 碰运气。 */
async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 仍未发生`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/** 收完整响应；中止也 resolve，交给用例断言 aborted。 */
function request(port, rawPath, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => {});
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), aborted: false });
      });
      res.on('close', () => {
        if (!res.complete) {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), aborted: true });
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`client timeout ${rawPath}`)));
    req.on('error', (err) =>
      resolve({ status: 0, aborted: true, error: err.message, headers: {}, body: Buffer.alloc(0) }),
    );
    req.end(body == null ? undefined : body);
  });
}

/* ---- 夹具 ---- */

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 造一段像 /api/sessions/messages 的响应（90KB 上下）：id、时间戳、长 markdown 正文、工具块都有。
 * 正文用固定种子的伪随机词序拼，压缩比才接近线上——纯重复字符的假数据会把比例吹到个位数。
 */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const PROSE = (
  '网关 上游 响应 压缩 隧道 消息 列表 会话 分块 缓冲 延迟 弱网 上行 快照 索引 渲染 分页 ' +
  'teardown socket stream gzip chunk header proxy tunnel session message payload encode ' +
  'handshake backpressure chunked identity variant cache cookie origin header truncate ' +
  'pipeline latency throughput watchdog rotation supervisor upgrade websocket auth token ' +
  '沙箱 附件 下载 路径 编码 校验 权限 日志 记录 超时 重试 幂等 收尾 连接 请求 缓存 头 '
).split(' ');

function prose(rand, chars) {
  let out = '';
  while (out.length < chars) {
    const word = PROSE[Math.floor(rand() * PROSE.length)];
    out += out ? ' ' + word : word;
    if (rand() < 0.08) out += '\n';
  }
  return out.slice(0, chars);
}

function buildMessagesPayload({ count = 17 } = {}) {
  const rand = seededRandom(20261108);
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const idx = String(i).padStart(3, '0');
    const blocks = [];
    const paragraphs = 2 + Math.floor(rand() * 2);
    for (let p = 0; p < paragraphs; p += 1) {
      blocks.push({ type: 'text', text: prose(rand, 900 + Math.floor(rand() * 900)) });
    }
    if (i % 3 === 0) {
      blocks.push({
        type: 'tool_use',
        id: `toolu_${idx}_${Math.floor(rand() * 1e6).toString(36)}`,
        name: 'read',
        input: { path: 'gateway/http-proxy.mjs', offset: 1, limit: 40 },
      });
      blocks.push({ type: 'text', text: prose(rand, 400 + Math.floor(rand() * 400)) });
    }
    messages.push({
      id: `msg_20261108_${idx}_${Math.floor(rand() * 1e9).toString(36)}`,
      sessionId: 'sess_9f3c1d7a-2b44-4e51-9c8e-77aa10b3de55',
      role: i % 2 === 0 ? 'user' : 'assistant',
      createdAt: new Date(1762500000000 + i * 61_000).toISOString(),
      status: 'complete',
      content: blocks,
      usage: { inputTokens: 1200 + i * 37, outputTokens: 240 + Math.floor(rand() * 900), cachedTokens: 800 },
    });
  }
  return JSON.stringify({ sessionId: 'sess_9f3c1d7a-2b44-4e51-9c8e-77aa10b3de55', messages, hasMore: true });
}

const MESSAGE_PATH = '/api/sessions/messages?limit=50';
const NDJSON_PATH = '/api/ndjson';
const SSE_PATH = '/api/sse';

let tmpRoot;
let hanaHome;
let upstream;
let upstreamPort;
let gw;
const gateways = [];

const state = {
  payload: '',
  sseRelease: null,
  sseReleased: 0,
  bigStarted: 0,
  bigClosed: false,
};

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-gzip-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  await fsp.mkdir(path.join(hanaHome, 'session-files'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });
  state.payload = buildMessagesPayload();
}

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/sessions/messages') {
      const body = Buffer.from(state.payload, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === SSE_PATH) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      // 第一块立刻发；第二块等测试端显式放行。网关要是缓冲，第一块就永远到不了客户端。
      res.write('data: first\n\n');
      state.sseRelease = () => {
        state.sseReleased += 1;
        if (res.destroyed || res.writableEnded) return;
        res.write('data: second\n\n');
        res.end();
      };
      res.on('close', () => {
        state.sseRelease = null;
      });
      return;
    }

    if (url.pathname === NDJSON_PATH) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.write('{"i":1}\n');
      state.sseRelease = () => {
        if (res.destroyed || res.writableEnded) return;
        res.write('{"i":2}\n');
        res.end();
      };
      res.on('close', () => {
        state.sseRelease = null;
      });
      return;
    }

    // 测试端直连上游放行第二个分块（不经过网关）。
    if (url.pathname === '/__release') {
      const release = state.sseRelease;
      res.writeHead(release ? 200 : 409, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(release ? 'ok' : 'nothing-waiting');
      if (release) release();
      return;
    }

    if (url.pathname === '/api/attachment') {
      // text/plain 本来可压，但它是附件下载：压了就没 content-length / 没进度条
      const body = Buffer.from('# a.md\n\n附件正文\n'.repeat(20), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="a.md"; filename*=UTF-8\'\'a.md',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/preencoded') {
      // 上游自己已经压过（这里只关心不再压一层，不关心 br 是否合法）
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'br',
        'content-length': '5',
      });
      res.end('BRBR!');
      return;
    }

    if (url.pathname === '/api/notmodified') {
      res.writeHead(304, { etag: '"abc"' });
      res.end();
      return;
    }

    if (url.pathname === '/api/nocontent') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (url.pathname === '/api/image') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(TINY_PNG.length),
      });
      res.end(TINY_PNG);
      return;
    }

    if (url.pathname === '/api/vary') {
      const body = Buffer.from(JSON.stringify({ ok: true, list: Array.from({ length: 40 }, (_, i) => i) }), 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        vary: 'origin',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/vary-star') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', vary: '*' });
      res.end('{"ok":true}');
      return;
    }

    if (url.pathname === '/api/notransform') {
      const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store, no-transform',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/partial') {
      // 模拟续传/区间下载：text/plain 但带 Content-Range，压了偏移就对不上
      const body = Buffer.from('0123456789');
      res.writeHead(206, {
        'content-type': 'text/plain; charset=utf-8',
        'content-range': 'bytes 0-9/1000',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/identity-encoded') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'identity' });
      res.end('plain-identity');
      return;
    }

    if (url.pathname === '/api/big-stream') {
      // 永不自己结束：客户端断开后只能靠网关 teardown 收掉上游 socket。
      state.bigStarted += 1;
      state.bigClosed = false;
      req.socket.on('close', () => {
        state.bigClosed = true;
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      const block = Buffer.alloc(64 * 1024, 0x61);
      let stopped = false;
      res.on('close', () => {
        stopped = true;
      });
      const pump = () => {
        if (stopped || res.destroyed || res.writableEnded) return;
        if (res.write(block)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
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

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('JSON + accept-encoding: gzip：压缩、删 content-length、解压后逐字节一致', async () => {
  const res = await request(gw.port, MESSAGE_PATH, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip', `应有 gzip，实际头：${JSON.stringify(res.headers)}`);
  assert.equal(res.headers['content-length'], undefined, '压缩后不能保留明文 content-length');
  assert.equal(res.headers['transfer-encoding'], 'chunked', '压缩体应按 chunked 下发');

  const plain = await gunzip(res.body);
  const expected = Buffer.from(state.payload, 'utf8');
  assert.equal(plain.length, expected.length, `解压后长度应一致：${plain.length} vs ${expected.length}`);
  assert.ok(plain.equals(expected), '解压后必须与上游原文逐字节一致');

  const ratio = ((res.body.length / expected.length) * 100).toFixed(1);
  console.log(
    `      (真实 JSON：${(expected.length / 1024).toFixed(1)}KB → ${(res.body.length / 1024).toFixed(1)}KB，${ratio}%)`,
  );
});

t('同一请求不带 accept-encoding：原样透传，但仍标 Vary', async () => {
  const res = await request(gw.port, MESSAGE_PATH);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined, '没请求压缩就不能压');
  assert.equal(res.body.toString('utf8'), state.payload, '正文必须原样');
  assert.equal(
    Number(res.headers['content-length']),
    Buffer.byteLength(state.payload),
    '未压缩时 content-length 保持原值',
  );
  assert.match(String(res.headers.vary || ''), /accept-encoding/i, '不可压的请求也要标 Vary，否则缓存会串味');
});

t('accept-encoding: gzip;q=0 不压；`*` 视为可压', async () => {
  const refused = await request(gw.port, MESSAGE_PATH, { headers: { 'accept-encoding': 'gzip;q=0, identity' } });
  assert.equal(refused.headers['content-encoding'], undefined, 'q=0 是明确拒绝 gzip');
  assert.match(String(refused.headers.vary || ''), /accept-encoding/i);

  const star = await request(gw.port, MESSAGE_PATH, { headers: { 'accept-encoding': '*' } });
  assert.equal(star.headers['content-encoding'], 'gzip', '`*` 表示任何编码都可接受，gzip 在范围内');
});

t('text/event-stream：不压缩，且第二个分块要等放行才到（证明没有缓冲）', async () => {
  const chunks = [];
  let markFirst = null;
  const firstArrived = new Promise((resolve) => {
    markFirst = resolve;
  });
  let clientReq = null;
  const done = new Promise((resolve, reject) => {
    clientReq = http.request(
      { host: '127.0.0.1', port: gw.port, path: SSE_PATH, headers: { 'accept-encoding': 'gzip' } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          chunks.push(chunk);
          if (chunks.length === 1) markFirst(res);
        });
        res.on('end', () => resolve(res));
        res.on('error', reject);
      },
    );
    clientReq.on('error', reject);
    clientReq.setTimeout(8000, () => clientReq.destroy(new Error('sse client timeout')));
    clientReq.end();
  });

  try {
    const firstRes = await withTimeout(firstArrived, 4000, 'SSE 第一个分块');
    assert.equal(firstRes.headers['content-encoding'], undefined, 'SSE 不能压缩');
    assert.match(String(firstRes.headers['content-type']), /^text\/event-stream/, 'content-type 必须原样');
    assert.equal(chunks.join(''), 'data: first\n\n', `第一个分块应原样到达，实际：${JSON.stringify(chunks)}`);

    // 第一个分块已经在客户端手里了，才允许上游发第二个。
    const release = await request(upstreamPort, '/__release');
    assert.equal(release.status, 200, '上游应有一个挂着的 SSE 响应');
    await withTimeout(done, 4000, 'SSE 剩余分块');
    assert.equal(chunks.join(''), 'data: first\n\ndata: second\n\n', '分块必须按到达顺序拼接');
  } finally {
    clientReq?.destroy();
  }
});

t('application/x-ndjson：不压缩，分块同样不缓冲', async () => {
  const chunks = [];
  let markFirst = null;
  const firstArrived = new Promise((resolve) => {
    markFirst = resolve;
  });
  let clientReq = null;
  const done = new Promise((resolve, reject) => {
    clientReq = http.request(
      { host: '127.0.0.1', port: gw.port, path: NDJSON_PATH, headers: { 'accept-encoding': 'gzip' } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          chunks.push(chunk);
          if (chunks.length === 1) markFirst(res);
        });
        res.on('end', () => resolve(res));
        res.on('error', reject);
      },
    );
    clientReq.on('error', reject);
    clientReq.setTimeout(8000, () => clientReq.destroy(new Error('ndjson client timeout')));
    clientReq.end();
  });

  try {
    const firstRes = await withTimeout(firstArrived, 4000, 'NDJSON 第一个分块');
    assert.equal(firstRes.headers['content-encoding'], undefined, 'NDJSON 是流式的，不能压');
    assert.equal(chunks.join(''), '{"i":1}\n');
    await request(upstreamPort, '/__release');
    await withTimeout(done, 4000, 'NDJSON 剩余分块');
    assert.equal(chunks.join(''), '{"i":1}\n{"i":2}\n');
  } finally {
    clientReq?.destroy();
  }
});

t('上游已带 content-encoding: br：原样透传，不二次压缩', async () => {
  const res = await request(gw.port, '/api/preencoded', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'br', `编码不能被改写：${JSON.stringify(res.headers)}`);
  assert.equal(res.body.toString('utf8'), 'BRBR!', '正文必须原样透传');
  assert.equal(res.headers['content-length'], '5', 'content-length 不应被删');
  assert.equal(res.headers.vary, undefined, '不属于可压范围时不加 Vary');
});

t('上游带 content-encoding: identity 也不压（当作已处理）', async () => {
  const res = await request(gw.port, '/api/identity-encoded', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'identity', 'identity 也是上游已经给过的编码');
  assert.equal(res.body.toString('utf8'), 'plain-identity');
});

t('304：无 body、无 content-encoding', async () => {
  const res = await request(gw.port, '/api/notmodified', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 304);
  assert.equal(res.body.length, 0, '304 不能有 body');
  assert.equal(res.headers['content-encoding'], undefined, '304 不能加 content-encoding');
  assert.equal(res.headers['transfer-encoding'], undefined, '304 不能改成 chunked');
});

t('204：无 body、无 content-encoding', async () => {
  const res = await request(gw.port, '/api/nocontent', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 204);
  assert.equal(res.body.length, 0);
  assert.equal(res.headers['content-encoding'], undefined);
});

t('HEAD：不压缩，头保持原样', async () => {
  const res = await request(gw.port, MESSAGE_PATH, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined, 'HEAD 只回头，不压');
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(state.payload), 'HEAD 的 content-length 是明文的');
  assert.equal(res.body.length, 0);
});

t('image/png：不压缩，字节原样', async () => {
  const res = await request(gw.port, '/api/image', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined, '图片已压过，不能再套 gzip');
  assert.ok(res.body.equals(TINY_PNG), 'PNG 字节必须原样');
  assert.equal(res.headers.vary, undefined, '不可压类型不加 Vary');
});

t('cache-control: no-transform：不压缩', async () => {
  const res = await request(gw.port, '/api/notransform', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined, 'no-transform 明确禁止改写载荷');
  assert.equal(res.body.toString('utf8'), '{"ok":true}');
});

t('206/Content-Range：不压缩（字节区间不能套 gzip）', async () => {
  const res = await request(gw.port, '/api/partial', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-encoding'], undefined, '区间响应不能压');
  assert.equal(res.headers['content-range'], 'bytes 0-9/1000', 'Content-Range 必须原样');
  assert.equal(res.body.toString('utf8'), '0123456789', '字节必须原样');
  assert.equal(res.headers.vary, undefined, '不参与压缩时也不加 Vary');
});

t('content-disposition: attachment：不压缩，content-length 保留', async () => {
  const res = await request(gw.port, '/api/attachment', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined, '附件下载不能压（否则客户端拿不到进度）');
  assert.equal(
    Number(res.headers['content-length']),
    res.body.length,
    '附件必须保留 content-length，下载进度靠它',
  );
  assert.match(String(res.headers['content-disposition']), /^attachment/, 'disposition 原样');
  assert.equal(res.headers.vary, undefined, '不参与压缩就不加 Vary');
  assert.equal(res.body.toString('utf8'), '# a.md\n\n附件正文\n'.repeat(20));
});

t('Vary 合并：上游的 origin 不能丢', async () => {
  const res = await request(gw.port, '/api/vary', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers['content-encoding'], 'gzip');
  const vary = String(res.headers.vary || '')
    .split(',')
    .map((part) => part.trim().toLowerCase());
  assert.ok(vary.includes('origin'), `origin 必须保留，实际：${JSON.stringify(res.headers.vary)}`);
  assert.ok(vary.includes('accept-encoding'), `accept-encoding 必须追加，实际：${JSON.stringify(res.headers.vary)}`);
  assert.equal(vary.filter((v) => v === 'accept-encoding').length, 1, '不能重复');
  const plain = JSON.parse((await gunzip(res.body)).toString('utf8'));
  assert.equal(plain.ok, true);
});

t('Vary: * 不追加 accept-encoding（已经覆盖全部）', async () => {
  const res = await request(gw.port, '/api/vary-star', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(String(res.headers.vary).trim(), '*');
});

t('客户端在压缩响应中途断开：上游 socket 被销毁，网关仍可用', async () => {
  const before = state.bigStarted;
  const sock = net.connect(gw.port, '127.0.0.1');
  sock.on('error', () => {});
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      }),
      4000,
      '连接网关',
    );
    const firstByte = new Promise((resolve) => sock.once('data', resolve));
    sock.write(
      [
        'GET /api/big-stream HTTP/1.1',
        `Host: 127.0.0.1:${gw.port}`,
        'Accept-Encoding: gzip',
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    const head = await withTimeout(firstByte, 4000, '压缩响应的第一个字节');
    assert.match(String(head).slice(0, 40), /^HTTP\/1\.1 200/, 'head 应先发出去');
    assert.equal(state.bigStarted, before + 1, '上游应已开始写');
    sock.destroy();
    assert.equal(await waitFor(() => state.bigClosed, 5000), true, '客户端断开后上游 socket 必须被销毁');
  } finally {
    sock.destroy();
  }

  assert.equal(gw.child.exitCode, null, '网关进程必须存活');
  const after = await request(gw.port, MESSAGE_PATH, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(after.status, 200, '断开之后仍要能正常服务');
  assert.equal(after.headers['content-encoding'], 'gzip');
  assert.ok((await gunzip(after.body)).equals(Buffer.from(state.payload, 'utf8')));
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
  if (upstream) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} 个用例全部通过`);
}
