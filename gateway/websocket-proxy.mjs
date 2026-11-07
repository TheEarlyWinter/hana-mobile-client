/**
 * WebSocket 反向代理：裸 socket 中继 + 可选帧日志。
 *
 * 生命周期要点（都是踩过的坑）：
 *   - 客户端可能在鉴权 await 期间就断开：监听必须在 await 之前挂上；
 *   - 升级后的 socket 是半开双工，客户端发 FIN 只触发 'end'，光等 'close' 赶不上；
 *   - 上游连不上 / 迟迟不回 101 时，必须超时收尾，不能把客户端 socket 挂到天荒地老；
 *   - 双端收尾走同一条幂等路径，避免一端清了两端没收。
 *
 * 来源校验（isAllowedGatewayOrigin）由调用方注入：它是网关级策略，HTTP 与 WS 必须
 * 用同一个实现，不能在这里再写一份。
 */

import fs from 'node:fs';
import net from 'node:net';
import { LOG_WS, UPSTREAM, WS_LOG, WS_UPSTREAM_TIMEOUT_MS } from './config.mjs';
import { isWsPath, stripHopByHopHeaders } from './security-policy.mjs';
import { checkReadAuth, redactUrlForLog, upstreamHeaders } from './upstream-access.mjs';

/** 握手 HTTP 头上限，和 Node 默认的 16KB 保持同一量级；超限直接安全拒绝。 */
const MAX_HANDSHAKE_BYTES = 16 * 1024;

/** 极简 WebSocket 帧解析：只处理 unmasked 文本/二进制帧，用于日志。 */
function makeFrameLogger(label, { skipHttpHeader = false } = {}) {
  if (!LOG_WS) return () => {};
  let buffer = Buffer.alloc(0);
  let skippedHeader = !skipHttpHeader;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // 上游方向的第一个 chunk 是 HTTP 101 响应头，必须先剥掉，否则帧全部错位
    if (!skippedHeader) {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      buffer = buffer.subarray(idx + 4);
      skippedHeader = true;
    }

    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > 8_000_000n) {
          buffer = Buffer.alloc(0);
          return;
        }
        len = Number(big);
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;

      let payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      buffer = buffer.subarray(offset + len);

      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        appendLog(label, text, fin);
      } else if (opcode === 0x2) {
        appendLog(label, `<binary ${payload.length} bytes>`, fin);
      }
    }
  };
}

function appendLog(label, text, fin) {
  const line = `${new Date().toISOString()} [${label}]${fin ? '' : '(cont)'} ${text}\n`;
  fs.appendFile(WS_LOG, line, () => {});
}

function rejectUpgrade(socket, status, message) {
  const reason =
    { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }[status] ||
    'Forbidden';
  const body = message || reason;
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    'Cache-Control: no-store',
    'Referrer-Policy: no-referrer',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
  try {
    socket.end(response);
  } catch {
    socket.destroy();
  }
}

/**
 * @param {{
 *   isAllowedGatewayOrigin: (req: import('node:http').IncomingMessage) => boolean,
 *   log?: (entry: object) => void,
 * }} deps
 */
export function createWebsocketProxy({ isAllowedGatewayOrigin, log = null }) {
  /** 结构化日志只记 open/close/error，绝不带帧内容。 */
  const writeLog = (entry) => {
    if (typeof log !== 'function') return;
    try {
      log(entry);
    } catch {
      // 日志永远不能影响 WS 中继
    }
  };

  async function handleUpgrade(req, socket, head) {
    let clientGone = false;
    let upstreamSocket = null;
    let finished = false;
    let handshakeTimer = null;
    let handshakeBuffer = Buffer.alloc(0);
    let handshakeDone = false;
    let relayCleanup = null;
    let openedAt = 0;
    let closeLogged = false;
    let errorLogged = false;

    const logWsError = (errorCode, error) => {
      if (errorLogged) return;
      errorLogged = true;
      writeLog({ level: 'error', kind: 'ws', event: 'error', errorCode, error });
    };
    const logWsClose = () => {
      if (!openedAt || closeLogged) return;
      closeLogged = true;
      writeLog({ level: 'info', kind: 'ws', event: 'close', ms: Date.now() - openedAt });
    };

    // 双端收尾只写一份：幂等，客户端先走、上游先走、超时都走这条路。
    // graceful=true 表示客户端 socket 已经 end()（已写好响应），只需关上游。
    const shutdown = ({ graceful = false } = {}) => {
      if (finished) return;
      finished = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      handshakeBuffer = Buffer.alloc(0);
      if (relayCleanup) {
        relayCleanup();
        relayCleanup = null;
      }
      if (upstreamSocket) upstreamSocket.destroy();
      if (!graceful) socket.destroy();
      logWsClose();
    };

    // 关键：在任何 await 之前就盯住客户端。它可能在鉴权途中就断开，
    // 那时候再往上游 net.connect 就白连一条，还得等对端超时。
    // 注意要用 'end'：升级后的 socket 是半开双工，客户端发完 FIN 时只会触发 'end'，
    // 'close' 要等写端也结束（实测断言过），光等 'close' 根本赶不上鉴权窗口。
    const onClientGone = () => {
      clientGone = true;
      shutdown();
    };
    socket.on('end', onClientGone);
    socket.on('close', onClientGone);
    socket.on('error', onClientGone);

    // 只允许 /ws（query 可以）；其它 upgrade 路径在碰上游之前就拒绝。
    if (!isWsPath(req.url || '')) {
      rejectUpgrade(socket, 404, 'not found');
      return;
    }

    // Origin 先于鉴权：坏源不触发 session 查询，更不连上游 WS。
    if (!isAllowedGatewayOrigin(req)) {
      rejectUpgrade(socket, 403, 'forbidden');
      return;
    }

    const auth = await checkReadAuth(req);
    if (clientGone || finished || socket.destroyed || socket.readableEnded) return;
    if (!auth.ok) {
      rejectUpgrade(socket, auth.status, auth.status === 401 ? 'unauthorized' : 'auth service unavailable');
      return;
    }

    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    // 升级握手必需的 connection/upgrade 保留，其余 hop-by-hop 头照样剥
    const headers = stripHopByHopHeaders(upstreamHeaders(req.headers), { keepUpgrade: true });
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
      else lines.push(`${k}: ${v}`);
    }

    // 日志开关关着就不要碰 ws-frames.log（之前 OPEN 这行无条件写）
    if (LOG_WS) appendLog('OPEN', redactUrlForLog(req.url || ''));

    upstreamSocket = net.connect(UPSTREAM.port, UPSTREAM.host, () => {
      if (clientGone || finished) {
        shutdown();
        return;
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstreamSocket.write(head);

      // 客户端 → 上游可以立刻开始；上游 → 客户端必须先等完整 HTTP 头。
      // 如果先把半截头转给客户端、超时后再拼 504，客户端收到的是损坏的响应。
      socket.pipe(upstreamSocket);

      const onHandshakeData = (chunk) => {
        if (finished || handshakeDone) return;
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
        const complete = headerEnd !== -1;
        const tooLarge = complete
          ? headerEnd + 4 > MAX_HANDSHAKE_BYTES
          : handshakeBuffer.length > MAX_HANDSHAKE_BYTES;

        if (tooLarge) {
          // 握手阶段还没向客户端转发过任何上游字节，可以安全回明确错误。
          handshakeDone = true;
          upstreamSocket.off('data', onHandshakeData);
          logWsError('WS_HANDSHAKE_TOO_LARGE', `upstream handshake exceeded ${MAX_HANDSHAKE_BYTES} bytes`);
          rejectUpgrade(socket, 502, 'upstream handshake too large');
          shutdown({ graceful: true });
          return;
        }
        if (!complete) return;

        handshakeDone = true;
        upstreamSocket.off('data', onHandshakeData);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;

        const buffered = handshakeBuffer;
        handshakeBuffer = Buffer.alloc(0);
        const statusLine = buffered.subarray(0, Math.max(0, buffered.indexOf('\r\n'))).toString('latin1');
        const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
        const status = statusMatch ? Number(statusMatch[1]) : 0;

        if (status === 101) {
          openedAt = Date.now();
          writeLog({ level: 'info', kind: 'ws', event: 'open' });
          // 101 头（以及同 chunk 的首帧）一次性交给客户端，之后恢复裸流中继。
          socket.write(buffered);
          upstreamSocket.pipe(socket);
          return;
        }

        // 上游给的是完整 HTTP 错误响应：原样转发剩余正文并收尾，不当作 WS。
        logWsError(
          `WS_UPSTREAM_HTTP_${status || 'UNKNOWN'}`,
          `upstream responded HTTP ${status || 'unknown'} instead of 101`,
        );
        socket.unpipe(upstreamSocket);
        const bufferedAccepted = socket.write(buffered);

        const headerText = buffered.subarray(0, headerEnd + 4).toString('latin1');
        const lengthMatch = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(headerText);
        const contentLength = lengthMatch ? Number(lengthMatch[1]) : null;
        const initialBodyBytes = buffered.length - (headerEnd + 4);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          // 没有可用的 Content-Length：按上游 close 收尾（错误响应通常会关连接）。
          upstreamSocket.pipe(socket);
          return;
        }
        if (initialBodyBytes >= contentLength) {
          socket.end();
          shutdown({ graceful: true });
          return;
        }

        // 有 Content-Length：只转发声明长度的正文，不依赖上游是否 keep-alive。
        let remaining = contentLength - initialBodyBytes;
        let waitingDrain = false;
        let bodyDone = false;

        const onDrain = () => {
          waitingDrain = false;
          if (finished || bodyDone) return;
          upstreamSocket.resume();
        };
        const pauseForDrain = () => {
          if (waitingDrain || finished || bodyDone) return;
          waitingDrain = true;
          upstreamSocket.pause();
          socket.once('drain', onDrain);
        };
        const cleanupBodyRelay = () => {
          upstreamSocket.off('data', onErrorBodyData);
          socket.off('drain', onDrain);
        };
        const onErrorBodyData = (bodyChunk) => {
          if (finished || bodyDone || remaining <= 0) return;
          const take = Math.min(remaining, bodyChunk.length);
          if (take > 0) {
            const accepted = socket.write(bodyChunk.subarray(0, take));
            remaining -= take;
            if (remaining === 0) {
              bodyDone = true;
              cleanupBodyRelay();
              relayCleanup = null;
              socket.end();
              shutdown({ graceful: true });
              return;
            }
            if (!accepted) pauseForDrain();
          }
        };
        relayCleanup = cleanupBodyRelay;
        upstreamSocket.on('data', onErrorBodyData);
        // 首块 buffered 已经写入；如果它触发 backpressure，先 pause，
        // 否则后续 body 的 data 监听会在 drain 前继续拉取。
        if (!bufferedAccepted) pauseForDrain();
      };
      upstreamSocket.on('data', onHandshakeData);
    });

    // 连接/握手超时：上游拒收、扫挂、或者连上了却迟迟不回完整 HTTP 头，
    // 都不能把客户端 socket 永远挂在半路。只有完整 HTTP 头到齐才算握手完成。
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (finished || handshakeDone) return;
      // 握手阶段没有向客户端转发过上游字节，可以安全回 504。
      logWsError('WS_HANDSHAKE_TIMEOUT', `upstream websocket handshake timeout after ${WS_UPSTREAM_TIMEOUT_MS}ms`);
      rejectUpgrade(socket, 504, 'upstream timeout');
      shutdown({ graceful: true });
    }, WS_UPSTREAM_TIMEOUT_MS);

    if (LOG_WS) {
      socket.on('data', makeFrameLogger('C→S'));
      upstreamSocket.on('data', makeFrameLogger('S→C', { skipHttpHeader: true }));
    }

    upstreamSocket.on('error', (err) => {
      logWsError(err?.code || 'WS_UPSTREAM_ERROR', err?.message || 'upstream socket error');
      shutdown();
    });
    upstreamSocket.on('close', () => {
      if (handshakeDone) {
        // 非 101 响应正文 / 正常 WS 收尾可能还在写队列里：先让客户端写完。
        shutdown({ graceful: true });
        if (!socket.writableEnded && !socket.destroyed) socket.end();
        return;
      }
      shutdown();
    });
  }

  function proxyUpgrade(req, socket, head) {
    handleUpgrade(req, socket, head).catch(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  }

  return { handleUpgrade, proxyUpgrade };
}
