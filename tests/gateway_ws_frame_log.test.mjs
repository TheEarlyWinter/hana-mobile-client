/* WS 帧日志（I4-3）：默认只记元数据、正文要显式开关、帧流自己做轮转。
 *
 * 全部在本机进程内跑：mock 上游只认 /api/web-auth/session 与 WS 升级，端口都用 0，
 * 不读真实 HANA_HOME、不碰仓库里的 gateway/logs（轮转用临时目录）。
 *
 * 断言三条：
 *   1. 默认（HANA_GW_LOG_WS_BODY 未开）帧记录里没有 body，只有方向/帧类型/字节数/会话前缀；
 *   2. 正文开关打开时才有 body，且先截到上限（一帧可能带几十 MB 的内联图片）；
 *   3. ws-frames 这条流共用主日志的容量/保留参数：超过单文件上限会切段，段数按保留份数删。
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

const AUTH_BODY = JSON.stringify({ authenticated: true, principal: { kind: 'local_user' } });
const HEADER_101 =
  'HTTP/1.1 101 Switching Protocols\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Accept: test\r\n\r\n';

/** 客户端帧必须带掩码；掩码固定，免得断言里出现随机值。 */
const MASK = [0x37, 0xfa, 0x21, 0x3d];

function clientFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (body.length < 126) {
    header[1] = 0x80 | body.length;
  } else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  }
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= MASK[i % 4];
  return Buffer.concat([header, Buffer.from(MASK), masked]);
}

/** 上游帧不带掩码。 */
function serverFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (body.length < 126) {
    header[1] = body.length;
  } else {
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  }
  return Buffer.concat([header, body]);
}

/* ---- mock 上游：/api/web-auth/session + WS 升级后每个客户端帧回一帧 ---- */

let upstreamServer;
let upstreamPort;
let gatewayServer;
let gatewayPort;
const upstreamSockets = new Set();
const clientSockets = new Set();

async function startUpstream() {
  upstreamServer = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => upstreamSockets.delete(socket));

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      if (upgraded) {
        // 收到客户端帧就回一帧，让 s2c 方向也有东西可记。
        socket.write(serverFrame(0x1, JSON.stringify({ type: 'text_delta', sessionId: 'sess_0123456789', text: '回复机密-ZXCV' })));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buffer.subarray(0, headerEnd + 4).toString('latin1');
      const target = (head.split('\r\n')[0] || '').split(' ')[1] || '/';
      const rest = buffer.subarray(headerEnd + 4);
      buffer = Buffer.alloc(0);

      if (target.startsWith('/api/web-auth/session')) {
        socket.end(
          'HTTP/1.1 200 OK\r\n' +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(AUTH_BODY)}\r\n` +
            'Connection: close\r\n\r\n' +
            AUTH_BODY,
        );
        return;
      }

      upgraded = true;
      socket.write(HEADER_101);
      if (rest.length) socket.write(rest);
    });
  });
  upstreamPort = await listen(upstreamServer);
}

function openSocket(query) {
  return new Promise((resolve) => {
    const state = { data: Buffer.alloc(0), closed: false };
    const socket = net.connect(gatewayPort, '127.0.0.1', () => {
      clientSockets.add(socket);
      socket.write(
        [
          `GET /ws${query} HTTP/1.1`,
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
      clientSockets.delete(socket);
    });
    socket.on('error', () => {});
    socket.setTimeout(4000, () => socket.destroy());
  });
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

/* ---- 用例 ---- */

const frameEntries = [];
const logEntries = [];

t('默认只记元数据：没有正文，但有方向/帧类型/字节数/会话前缀', async () => {
  const secret = '正文机密-QWERTY';
  const textFrame = JSON.stringify({ type: 'prompt', sessionId: 'sess_0123456789', text: secret });
  const { socket, state } = await openSocket('?client=mobile');
  assert.equal(
    await waitFor(() => state.data.includes(Buffer.from('101 Switching Protocols'))),
    true,
    '应先完成 101 握手',
  );

  socket.write(clientFrame(0x1, textFrame));
  socket.write(clientFrame(0x2, Buffer.from('BINARY机密-ASDF')));

  assert.equal(
    await waitFor(
      () =>
        frameEntries.filter((entry) => entry.dir === 'c2s').length >= 2 &&
        frameEntries.some((entry) => entry.dir === 's2c'),
    ),
    true,
    `两个方向的帧都应被记录，实际：${JSON.stringify(frameEntries)}`,
  );

  const c2sText = frameEntries.find((entry) => entry.dir === 'c2s' && entry.op === 'text');
  assert.equal(c2sText.msg, 'prompt', '帧类型要从帧里摘出来');
  assert.equal(c2sText.session, 'sess_012', '会话 id 只留前缀');
  assert.equal(c2sText.bytes, Buffer.byteLength(textFrame, 'utf8'), '字节数应是帧载荷长度');
  assert.equal('body' in c2sText, false, '默认不记正文');
  assert.equal(c2sText.cont, undefined, '完整帧不该带 cont');

  const c2sBinary = frameEntries.find((entry) => entry.dir === 'c2s' && entry.op === 'binary');
  assert.equal(c2sBinary.bytes, Buffer.byteLength('BINARY机密-ASDF', 'utf8'));
  assert.equal('body' in c2sBinary, false, '二进制帧永远不记内容');

  const s2c = frameEntries.find((entry) => entry.dir === 's2c' && entry.op === 'text');
  assert.equal(s2c.msg, 'text_delta');
  assert.equal('body' in s2c, false);

  // 整条记录（序列化后）里不能出现任何一方向的正文字符串。
  const serialized = JSON.stringify(frameEntries);
  assert.equal(serialized.includes(secret), false, `帧日志里不应出现客户端正文：${serialized}`);
  assert.equal(serialized.includes('回复机密-ZXCV'), false, '帧日志里不应出现上游正文');
  assert.equal(serialized.includes('BINARY机密-ASDF'), false, '帧日志里不应出现二进制正文');

  socket.destroy();
});

t('open 记录带脱敏后的 WS 地址（原来 OPEN 行提供的信息不丢）', async () => {
  const { socket, state } = await openSocket('?client=mobile&token=token-secret-42');
  assert.equal(
    await waitFor(() => state.data.includes(Buffer.from('101 Switching Protocols'))),
    true,
    '应先完成 101 握手',
  );
  assert.equal(await waitFor(() => logEntries.some((entry) => entry.event === 'open')), true, '应有 open 记录');

  const open = logEntries.find((entry) => entry.event === 'open');
  assert.equal(open.kind, 'ws');
  assert.ok(open.path.includes('client=mobile'), `地址要留着（分得清哪一端连的）：${open.path}`);
  assert.equal(open.path.includes('token-secret-42'), false, 'query 里的令牌必须脱敏');
  socket.destroy();
});

t('正文开关打开时才写 body，且先截到上限', async () => {
  const { describeFrame } = await import('../gateway/websocket-proxy.mjs');
  const { WS_FRAME_BODY_MAX } = await import('../gateway/logger.mjs');

  const payload = Buffer.from(JSON.stringify({ type: 'prompt', sessionId: 'sess_0123456789', text: '正文机密-QWERTY' }), 'utf8');
  const hidden = describeFrame({ dir: 'c2s', op: 'text', payload, fin: true });
  assert.equal('body' in hidden, false, 'withBody 默认 false');

  const shown = describeFrame({ dir: 'c2s', op: 'text', payload, fin: true, withBody: true });
  assert.ok(shown.body.includes('正文机密-QWERTY'), '开关打开后应有正文');

  // 长帧（例如带内联图片的 prompt）：正文截到上限，bytes 仍是真实大小，能看出被截了。
  const longText = JSON.stringify({ type: 'prompt', text: 'x'.repeat(WS_FRAME_BODY_MAX * 3) });
  const longEntry = describeFrame({
    dir: 'c2s',
    op: 'text',
    payload: Buffer.from(longText, 'utf8'),
    fin: true,
    withBody: true,
  });
  assert.equal(longEntry.body.length, WS_FRAME_BODY_MAX, '正文必须截到上限');
  assert.equal(longEntry.bytes, Buffer.byteLength(longText, 'utf8'), 'bytes 记真实字节数');

  // 分片帧只标 cont，不猜完整报文。
  const fragment = describeFrame({ dir: 's2c', op: 'text', payload: Buffer.from('{"ty', 'utf8'), fin: false });
  assert.equal(fragment.cont, 1);
  assert.equal('body' in fragment, false);
});

t('ws-frames 流共用容量/保留参数：超过上限切段，段数按 keepFiles 删', async () => {
  const { createLogger } = await import('../gateway/logger.mjs');
  const { describeFrame } = await import('../gateway/websocket-proxy.mjs');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-ws-frames-'));
  const KEEP = 3;
  try {
    // maxBytes 比一条记录还小：每条都新开一段，段数完全由记录条数决定，断言不依赖行宽。
    const logger = createLogger({
      dir,
      prefix: 'ws-frames',
      now: () => new Date(2026, 10, 10, 9, 0, 0, 0),
      maxBytes: 40,
      keepFiles: KEEP,
    });
    for (let i = 0; i < 6; i += 1) {
      logger.log(
        describeFrame({
          dir: 'c2s',
          op: 'text',
          payload: Buffer.from(JSON.stringify({ type: 'prompt', sessionId: 'sess_0123456789', n: i })),
          fin: true,
        }),
      );
    }
    await logger.flush();

    const names = (await fsp.readdir(dir)).sort();
    assert.equal(names.length, KEEP, `只该留 ${KEEP} 份，实际：${names.join(',')}`);
    for (const name of names) {
      assert.match(name, /^ws-frames-2026-11-10\.\d+\.jsonl$/, `段名必须是 ws-frames 前缀：${name}`);
    }
    // 记录格式仍是 JSONL：每行一条，能直接用 gateway-log.ps1 那套读。
    const newest = names[names.length - 1];
    const lines = (await fsp.readFile(path.join(dir, newest), 'utf8')).trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.kind, 'ws');
    assert.equal(record.event, 'frame');
    assert.equal(record.dir, 'c2s');
    assert.equal(record.msg, 'prompt');
    assert.equal('body' in record, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await startUpstream();
  process.env.HANA_UPSTREAM_HOST = '127.0.0.1';
  process.env.HANA_UPSTREAM_PORT = String(upstreamPort);
  process.env.HANA_GW_LOG_WS = '';
  process.env.HANA_HOME = path.join(os.tmpdir(), 'hana-ws-frame-log-fake-home');

  const { createWebsocketProxy } = await import('../gateway/websocket-proxy.mjs');
  const proxy = createWebsocketProxy({
    isAllowedGatewayOrigin: () => true,
    log: (entry) => logEntries.push(entry),
    frameLog: (entry) => frameEntries.push(entry),
  });

  gatewayServer = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  gatewayServer.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
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
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
