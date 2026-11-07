/* 网关 WS 非 101 大正文的下游背压回归（复审 P2）。
 *
 * 直接调用真实的 createWebsocketProxy().handleUpgrade，用一个 write() 返回 false 的
 * 受控下游 socket，观察：
 * - 首块缓冲写入 false 时立即 pause 上游，未收到 drain 前不再写；
 * - 正文块写入 false 时同样暂停，drain 后恢复并完成；
 * - 背压期间客户端关闭会清理监听，之后 drain 不再 resume。
 *
 * upstream 是本机 127.0.0.1:0 的 mock HTTP server；不读真实 HANA_HOME/凭据，
 * 不启停现有服务，不递归删除运行产物。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');
const CONTENT_LENGTH = 64 * 1024;
const BODY_CHUNK = 4 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 5000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return Boolean(fn());
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function bodyBytes(writes) {
  const all = Buffer.concat(writes);
  const end = all.indexOf('\r\n\r\n');
  return end === -1 ? 0 : all.length - end - 4;
}

class ControlledClientSocket extends EventEmitter {
  constructor({ writeReturns = [] } = {}) {
    super();
    this.writeReturns = [...writeReturns];
    this.writes = [];
    this.endCalls = 0;
    this.destroyCalls = 0;
    this.destroyed = false;
    this.readableEnded = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.pipedTo = null;
    this.unpipedFrom = null;
  }

  write(chunk, callback) {
    this.writes.push(Buffer.from(chunk));
    const accepted = this.writeReturns.length > 0 ? this.writeReturns.shift() : true;
    if (typeof callback === 'function') queueMicrotask(callback);
    return accepted;
  }

  end(chunk) {
    if (chunk !== undefined) this.writes.push(Buffer.from(chunk));
    this.endCalls += 1;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyCalls += 1;
    this.destroyed = true;
    this.emit('close');
  }

  pipe(destination) {
    this.pipedTo = destination;
    return destination;
  }

  unpipe(destination) {
    this.unpipedFrom = destination;
    return this;
  }
}

let upstream;
let upstreamPort;
let proxy;
let upgradeHits = 0;
let capturedSockets = [];
const allUpstreamSockets = [];
const clients = [];
let originalConnect;

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    if (String(req.url || '').startsWith('/api/web-auth/session')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ authenticated: true, principal: { kind: 'local_user' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  upstream.on('upgrade', (req, socket) => {
    upgradeHits += 1;
    socket.on('error', () => {});
    socket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
        'Content-Type: text/plain\r\n' +
        `Content-Length: ${CONTENT_LENGTH}\r\n` +
        '\r\n',
    );

    let sent = 0;
    const pushChunk = () => {
      if (socket.destroyed) return;
      const size = Math.min(BODY_CHUNK, CONTENT_LENGTH - sent);
      socket.write(Buffer.alloc(size, 0x61));
      sent += size;
      if (sent < CONTENT_LENGTH) setTimeout(pushChunk, 5);
      else socket.end();
    };
    setTimeout(pushChunk, 5);

    socket.on('close', () => {
      // 上游被网关关闭后停止继续写
    });
  });

  upstreamPort = await listen(upstream);
}

function makeRequest() {
  return {
    method: 'GET',
    url: '/ws?backpressure=1',
    headers: {
      host: '127.0.0.1:1',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      cookie: 'hana_session=valid',
    },
  };
}

async function startProxy() {
  process.env.HANA_UPSTREAM_HOST = '127.0.0.1';
  process.env.HANA_UPSTREAM_PORT = String(upstreamPort);
  process.env.HANA_GW_WS_UPSTREAM_TIMEOUT_MS = '5000';
  process.env.HANA_GW_LOG_WS = '';
  process.env.HANA_HOME = path.join(ARTIFACTS_ROOT, 'audit-ws-backpressure-fake-home');

  const { createWebsocketProxy } = await import('../gateway/websocket-proxy.mjs');
  proxy = createWebsocketProxy({ isAllowedGatewayOrigin: () => true });
}

function patchConnect() {
  originalConnect = net.connect;
  net.connect = function patchedConnect(...args) {
    const socket = originalConnect.apply(net, args);
    socket.__pauses = 0;
    socket.__resumes = 0;
    const originalPause = socket.pause.bind(socket);
    const originalResume = socket.resume.bind(socket);
    socket.pause = () => {
      socket.__pauses += 1;
      return originalPause();
    };
    socket.resume = () => {
      socket.__resumes += 1;
      return originalResume();
    };
    capturedSockets.push(socket);
    allUpstreamSockets.push(socket);
    return socket;
  };
}

function restoreConnect() {
  if (originalConnect) net.connect = originalConnect;
}

async function startScenario(writeReturns) {
  upgradeHits = 0;
  capturedSockets = [];
  const client = new ControlledClientSocket({ writeReturns });
  clients.push(client);
  const task = proxy.handleUpgrade(makeRequest(), client, Buffer.alloc(0));
  task.catch(() => {});
  assert.equal(await waitFor(() => upgradeHits === 1 && client.writes.length >= 1), true, '应进入上游 WS 握手');
  return { client, task };
}

function wsSocketWithPause() {
  return capturedSockets.find((socket) => socket.__pauses > 0);
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('首块 buffered 写入 false：pause 上游，无 drain 不再写；drain 后完成', async () => {
  const { client } = await startScenario([false]);
  const wsSocket = wsSocketWithPause();
  assert.ok(wsSocket, '首块写返回 false 后必须 pause 上游');
  assert.equal(wsSocket.isPaused(), true, '上游 readable 必须处于 paused');

  const writesBefore = client.writes.length;
  const bytesBefore = bodyBytes(client.writes);
  await sleep(150);
  assert.equal(client.writes.length, writesBefore, '未收到 drain 前不得继续向下游写');
  assert.equal(bodyBytes(client.writes), bytesBefore, '未收到 drain 前正文不得增长');
  assert.equal(client.endCalls, 0, '未收到 drain 前不得提前结束响应');

  client.emit('drain');
  assert.equal(await waitFor(() => client.endCalls === 1), true, 'drain 后应恢复并完成响应');
  assert.equal(bodyBytes(client.writes), CONTENT_LENGTH, '正文必须完整转发');
  assert.ok(wsSocket.__resumes > 0, 'drain 后必须 resume 上游');

  const resumesAfterEnd = wsSocket.__resumes;
  client.emit('drain');
  await sleep(80);
  assert.equal(wsSocket.__resumes, resumesAfterEnd, 'finished 后不得再次 resume');
});

t('正文块写入 false：pause 上游，drain 后继续并完成', async () => {
  const { client } = await startScenario([true, false]);
  assert.equal(
    await waitFor(() => Boolean(wsSocketWithPause())),
    true,
    '正文块写返回 false 后必须 pause 上游',
  );
  const wsSocket = wsSocketWithPause();

  const writesBefore = client.writes.length;
  const bytesBefore = bodyBytes(client.writes);
  await sleep(150);
  assert.equal(client.writes.length, writesBefore, '正文块背压后不得继续写');
  assert.equal(bodyBytes(client.writes), bytesBefore, '背压期间正文不得增长');
  assert.equal(wsSocket.isPaused(), true, '背压期间上游必须 paused');

  client.emit('drain');
  assert.equal(await waitFor(() => client.endCalls === 1), true, 'drain 后应继续到完成');
  assert.equal(bodyBytes(client.writes), CONTENT_LENGTH, '正文必须完整转发');
});

t('背压未 drain 时客户端关闭：清理 drain 监听，之后 drain 不再 resume', async () => {
  const { client } = await startScenario([false]);
  const wsSocket = wsSocketWithPause();
  assert.ok(wsSocket, '首块写 false 后应 pause 上游');

  const writesBefore = client.writes.length;
  client.destroy();
  assert.equal(await waitFor(() => wsSocket.destroyed), true, '客户端关闭后应销毁上游连接');

  const resumesAfterClose = wsSocket.__resumes;
  client.emit('drain');
  await sleep(100);
  assert.equal(wsSocket.__resumes, resumesAfterClose, '关闭后 drain 不得再 resume 上游');
  assert.equal(client.writes.length, writesBefore, '关闭后不得再写响应');
  assert.equal(client.endCalls, 0, '关闭后不得再调用 end');
});

let bad = 0;
try {
  await startUpstream();
  await startProxy();
  patchConnect();

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
  restoreConnect();
  for (const client of clients) client.destroy();
  for (const socket of allUpstreamSockets) {
    if (!socket.destroyed) socket.destroy();
  }
  if (upstream) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  console.log(`artifacts kept at ${ARTIFACTS_ROOT}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
