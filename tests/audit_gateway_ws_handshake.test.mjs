/* 网关 WS 上游握手超时回归（审计 G1）。
 *
 * 只用 127.0.0.1 的端口 0、mock WS upstream 和进程内 gateway；
 * 不读取真实 HANA_HOME/凭据，不启停任何现有服务，不递归删除运行产物。
 *
 * 目标行为：
 * - 上游只写半截 HTTP 头后停住：短握手超时必须关闭两端，不能把客户端挂住；
 * - 上游完全无响应：同样超时收尾；
 * - 完整分片 101 头到齐才停止握手计时，之后双向原样中继；
 * - 101 与首帧同 chunk 不丢帧；
 * - 超长握手头有上限并安全关闭；
 * - 上游完整非 101 HTTP 响应原样返回并收尾，不当作成功 WS。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');
const HANDSHAKE_TIMEOUT_MS = 300;
const HEADER_LIMIT_BYTES = 16 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitFor(fn, timeoutMs = 2500, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return Boolean(fn());
}

const upstreamSockets = new Set();
const upstreamStates = [];
const clientSockets = new Set();

let upstreamServer;
let upstreamPort;
let gatewayServer;
let gatewayPort;

const AUTH_BODY = JSON.stringify({
  authenticated: true,
  principal: { kind: 'local_user' },
});

function header101() {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: test\r\n' +
    '\r\n'
  );
}

async function startUpstream() {
  upstreamServer = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let mode = '';
    const state = { mode: '', closed: false };
    upstreamSockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      state.closed = true;
      upstreamSockets.delete(socket);
    });

    socket.on('data', (chunk) => {
      if (upgraded) {
        // echo 与 split 在握手完成后原样回写客户端字节
        if (mode === 'echo' || mode === 'split') socket.write(chunk);
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const head = buffer.subarray(0, headerEnd + 4).toString('latin1');
      const rest = buffer.subarray(headerEnd + 4);
      const requestLine = head.split('\r\n')[0] || '';
      const target = requestLine.split(' ')[1] || '/';

      if (target.startsWith('/api/web-auth/session')) {
        socket.end(
          'HTTP/1.1 200 OK\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(AUTH_BODY)}\r\n` +
            'Connection: close\r\n' +
            '\r\n' +
            AUTH_BODY,
        );
        return;
      }

      let modeName = 'same-chunk';
      try {
        modeName = new URL(target, 'http://x').searchParams.get('mode') || 'same-chunk';
      } catch {
        modeName = 'same-chunk';
      }
      mode = modeName;
      state.mode = modeName;
      upstreamStates.push(state);
      upgraded = true;

      if (mode === 'partial') {
        // 只写半截头，永远不补 \r\n\r\n
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n');
        return;
      }
      if (mode === 'none') return;
      if (mode === 'oversize') {
        socket.write('A'.repeat(HEADER_LIMIT_BYTES + 4096));
        return;
      }
      if (mode === 'reject' || mode === 'reject-open') {
        const response =
          'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: text/plain\r\n' +
          'Content-Length: 9\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'forbidden';
        if (mode === 'reject') socket.end(response);
        else socket.write(response); // 故意不结束：网关应按 Content-Length 收尾
        return;
      }
      if (mode === '101-end') {
        socket.end(header101());
        return;
      }
      if (mode === 'split') {
        const parts = [
          'HTTP/1.1 101 Switching Protocols\r\n',
          'Upgrade: websocket\r\n',
          'Connection: Upgrade\r\n',
          'Sec-WebSocket-Accept: test\r\n\r\n',
        ];
        (async () => {
          for (const part of parts) {
            if (socket.destroyed) return;
            socket.write(part);
            await sleep(40);
          }
        })();
        return;
      }
      if (mode === 'same-chunk') {
        socket.write(Buffer.concat([Buffer.from(header101(), 'latin1'), Buffer.from([0x81, 0x02, 0x68, 0x69])]));
        return;
      }

      // 默认 echo：先 101，再原样回写后续字节
      socket.write(header101());
      if (rest.length) socket.write(rest);
    });
  });
  upstreamPort = await listen(upstreamServer);
}

function startClient(mode) {
  return new Promise((resolve) => {
    const state = { data: Buffer.alloc(0), closed: false, error: null, elapsed: 0, timedOut: false };
    const startedAt = Date.now();
    const socket = net.connect(gatewayPort, '127.0.0.1', () => {
      clientSockets.add(socket);
      socket.write(
        [
          `GET /ws?mode=${mode} HTTP/1.1`,
          `Host: 127.0.0.1:${gatewayPort}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Origin: http://127.0.0.1:${gatewayPort}`,
          'Cookie: hana_session=valid',
          '',
          '',
        ].join('\r\n'),
      );
      resolve({ socket, state });
    });
    socket.on('data', (chunk) => {
      state.data = Buffer.concat([state.data, chunk]);
    });
    socket.on('close', () => {
      state.closed = true;
      state.elapsed = Date.now() - startedAt;
      clientSockets.delete(socket);
    });
    socket.on('error', (err) => {
      state.error = err.message;
    });
    socket.setTimeout(2500, () => {
      state.timedOut = true;
      socket.destroy();
    });
  });
}

function rawText(state) {
  return state.data.toString('latin1');
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('半截 HTTP 头后停住：短握手超时关闭两端，不把半截 101 转发给客户端', async () => {
  const upstreamBefore = upstreamStates.length;
  const { socket, state } = await startClient('partial');

  assert.equal(await waitFor(() => state.closed, 1500), true, '客户端 socket 必须在握手超时后关闭');
  assert.ok(state.elapsed < 1200, `握手超时不应拖到客户端 2.5s 超时（实际 ${state.elapsed}ms）`);

  const text = rawText(state);
  assert.match(text, /^HTTP\/1\.1 504/, `未转发任何上游头时应能回 504，实际收到：${text.slice(0, 120)}`);
  assert.ok(!text.includes('101 Switching Protocols'), '不能先把半截 101 头转给客户端');

  assert.equal(
    await waitFor(() => upstreamStates[upstreamBefore]?.closed, 1200),
    true,
    '上游连接也必须被关闭',
  );
  socket.destroy();
});

t('上游完全无响应：短握手超时 504 并关闭两端', async () => {
  const upstreamBefore = upstreamStates.length;
  const { socket, state } = await startClient('none');

  assert.equal(await waitFor(() => state.closed, 1500), true, '客户端 socket 必须关闭');
  assert.match(rawText(state), /^HTTP\/1\.1 504/, '完全无响应应回 504');
  assert.equal(
    await waitFor(() => upstreamStates[upstreamBefore]?.closed, 1200),
    true,
    '上游连接也必须被关闭',
  );
  socket.destroy();
});

t('分片 101 头完整到齐才停止计时，之后双向原样中继', async () => {
  const { socket, state } = await startClient('split');

  assert.equal(await waitFor(() => state.data.includes(Buffer.from('\r\n\r\n'))), true, '应收到完整 101 头');
  assert.match(rawText(state), /^HTTP\/1\.1 101/, '分片 101 头应正常回传');
  await sleep(80);
  assert.equal(state.closed, false, '完整 101 头到齐后连接应保持');

  const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
  socket.write(frame);
  assert.equal(await waitFor(() => state.data.includes(frame)), true, '客户端帧应原样到上游并回传');

  // 超过握手超时后仍不能被 timer 误关
  await sleep(HANDSHAKE_TIMEOUT_MS + 150);
  assert.equal(state.closed, false, '握手完成后握手 timer 不应再关闭连接');
  assert.ok(!rawText(state).includes('504'), '握手完成后不应出现 504');
  socket.destroy();
});

t('合法 101 + 首帧同 chunk：首帧不丢，握手 timer 不影响后续连接', async () => {
  const { socket, state } = await startClient('same-chunk');
  const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);

  assert.equal(await waitFor(() => state.data.includes(frame)), true, '同 chunk 的首帧必须送达');
  assert.match(rawText(state), /^HTTP\/1\.1 101/, '应回传 101');

  await sleep(HANDSHAKE_TIMEOUT_MS + 150);
  assert.equal(state.closed, false, '握手完成后连接不应被 timer 关闭');
  socket.destroy();
});

t('超长握手头：有上限并安全关闭，网关继续服务', async () => {
  const upstreamBefore = upstreamStates.length;
  const { socket, state } = await startClient('oversize');

  assert.equal(await waitFor(() => state.closed, 1800), true, '超长头必须在有限时间内关闭');
  const text = rawText(state);
  assert.match(text, /^HTTP\/1\.1 502 Bad Gateway\r\n/, `超长头应在未转发任何字节时安全拒绝，实际：${text.slice(0, 80)}`);
  assert.equal(
    await waitFor(() => upstreamStates[upstreamBefore]?.closed, 1200),
    true,
    '上游连接也必须关闭',
  );
  socket.destroy();

  const healthy = await startClient('same-chunk');
  assert.equal(await waitFor(() => healthy.state.data.includes(Buffer.from([0x81, 0x02, 0x68, 0x69]))), true);
  healthy.socket.destroy();
});

t('上游完整非 101 HTTP 响应：原样返回并收尾，不当作成功 WS', async () => {
  const { socket, state } = await startClient('reject');

  assert.equal(await waitFor(() => state.closed, 1800), true, '上游 HTTP 拒绝后客户端应收到完整响应并关闭');
  const text = rawText(state);
  assert.match(text, /^HTTP\/1\.1 403 Forbidden/, `必须原样返回上游状态：${text.slice(0, 100)}`);
  assert.ok(text.endsWith('forbidden'), '响应正文必须完整送达');
  assert.ok(!text.includes('101 Switching Protocols'), '非 101 不能当成成功 WS');
  socket.destroy();
});

t('上游完整非 101 响应但不关连接：网关按 Content-Length 收尾', async () => {
  const { socket, state } = await startClient('reject-open');

  assert.equal(await waitFor(() => state.closed, 1800), true, '上游不关连接时网关也必须收尾');
  const text = rawText(state);
  assert.match(text, /^HTTP\/1\.1 403 Forbidden/, '必须原样返回上游状态');
  assert.ok(text.endsWith('forbidden'), '正文必须完整送达');
  socket.destroy();
});

t('101 后上游立即结束：101 仍应送达客户端', async () => {
  const { socket, state } = await startClient('101-end');

  assert.equal(await waitFor(() => state.closed, 1800), true, '上游关闭后客户端应收尾');
  assert.match(rawText(state), /^HTTP\/1\.1 101/, '101 头不能因上游立即结束而丢失');
  socket.destroy();
});

let bad = 0;
try {
  await startUpstream();
  process.env.HANA_UPSTREAM_HOST = '127.0.0.1';
  process.env.HANA_UPSTREAM_PORT = String(upstreamPort);
  process.env.HANA_GW_WS_UPSTREAM_TIMEOUT_MS = String(HANDSHAKE_TIMEOUT_MS);
  process.env.HANA_GW_LOG_WS = '';
  process.env.HANA_HOME = path.join(ARTIFACTS_ROOT, 'audit-ws-fake-home');

  const { createWebsocketProxy } = await import('../gateway/websocket-proxy.mjs');
  const proxy = createWebsocketProxy({ isAllowedGatewayOrigin: () => true });

  gatewayServer = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  gatewayServer.on('upgrade', (req, socket, head) => {
    proxy.handleUpgrade(req, socket, head);
  });
  gatewayPort = await listen(gatewayServer);

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
  for (const socket of clientSockets) socket.destroy();
  for (const socket of upstreamSockets) socket.destroy();
  if (gatewayServer) await new Promise((resolve) => gatewayServer.close(resolve));
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  console.log(`artifacts kept at ${ARTIFACTS_ROOT}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
