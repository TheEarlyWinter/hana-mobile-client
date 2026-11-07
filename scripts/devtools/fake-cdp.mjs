// fake-cdp —— 一个假的 WebView 调试端点，只给离线自检用。
//
// 真机上那一套（adb forward → /json/list → WebSocket → Runtime.evaluate）在这里被原样
// 复刻：HTTP 发现、WebSocket 握手（含掩码帧解码）、CDP 请求/响应配对都一样，
// 只有「页面」是假的——它不认识 JS，只按表达式里的特征返回固定的 DOM 快照。
//
// 这样 selftest.mjs 不需要真机，也能把 ui-probe / js-eval 的整条链路跑通：
// 真实会出错的地方（帧解析、坐标换算、报错文案）都是真的在跑。
//
// 单独跑（手动调工具时很有用）：
//   node scripts/devtools/fake-cdp.mjs           # 打印 ws:// 地址，Ctrl-C 结束

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 假页面的默认内容：一个正常按钮、一个卡片按钮、一个不可见面板。 */
export const DEFAULT_ITEMS = [
  {
    id: 'btnOpenDrawer',
    tag: 'button',
    cls: 'icon-btn liquid-btn',
    label: '打开侧边栏',
    text: '打开侧边栏',
    rect: { x: 12, y: 20, w: 48, h: 48 },
    visible: true,
    inView: true,
    hitId: 'btnOpenDrawer',
    hitTag: 'button',
    hitMatch: true,
  },
  {
    id: 'btnCasual',
    tag: 'button',
    cls: 'agent-card',
    label: '随便聊聊',
    text: '随便聊聊',
    rect: { x: 40, y: 180, w: 280, h: 56 },
    visible: true,
    inView: true,
    hitId: 'btnCasual',
    hitTag: 'button',
    hitMatch: true,
  },
  {
    id: 'hiddenPanel',
    tag: 'div',
    cls: 'sheet',
    label: '',
    text: '隐藏面板',
    rect: { x: 0, y: 0, w: 0, h: 0 },
    visible: false,
    inView: false,
    hitId: '',
    hitTag: '',
    hitMatch: false,
  },
];

export const DEFAULT_VIEWPORT = {
  w: 360,
  h: 800,
  dpr: 3,
  scrollX: 0,
  scrollY: 0,
  ua: 'Mozilla/5.0 (Linux; Android 13; FAKE_PHONE Build/TQ3A.230901.001; wv) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
};

/* ---------------------------- WebSocket 帧 ---------------------------- */

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 从缓冲区里切出完整帧（客户端帧一定带掩码）。返回 false 表示还要更多数据。 */
function decodeOneFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let length = buf[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  const total = offset + maskLength + length;
  if (buf.length < total) return null;
  let payload = buf.subarray(offset + maskLength, total);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const plain = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) plain[i] = payload[i] ^ mask[i % 4];
    payload = plain;
  }
  return { opcode, payload, rest: buf.subarray(total) };
}

/* ---------------------------- 假页面的「执行」 ---------------------------- */

function describeItem(item) {
  return { id: item.id, tag: item.tag, cls: item.cls, label: item.label, text: item.text };
}

/** 只认最简单的三种选择器：#id / .cls / tag——够自检用，也够说明「这是假的」。 */
function matchSelector(selector, items) {
  const sel = String(selector || '').trim();
  if (!sel) return null;
  if (sel.startsWith('#')) return items.find((it) => it.id === sel.slice(1)) || null;
  if (sel.startsWith('.')) return items.find((it) => String(it.cls).split(/\s+/).includes(sel.slice(1))) || null;
  return items.find((it) => it.tag === sel) || null;
}

function extractSelector(expression) {
  const expr = String(expression || '');
  // 工具里的写法是 `const SEL = "#x"; ... document.querySelector(SEL)`：先认这个，
  // 再兼容直接写 `querySelector("#x")` 的形式。
  const m = expr.match(/const SEL = ("(?:[^"\\]|\\.)*")/) || expr.match(/querySelector\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function evaluateFake(expression, ctx) {
  const expr = String(expression || '');
  const { items, viewport, url, title } = ctx;
  if (process.env.FAKE_CDP_DEBUG) {
    process.stderr.write(`[fake-cdp] len=${expr.length} tap=${expr.includes('scrollIntoView')} qsa=${expr.includes('querySelectorAll')} sel=${JSON.stringify(extractSelector(expr))}\n`);
  }

  // 两个页面侧脚本都含 querySelectorAll / navigator.userAgent（点击脚本会列候选、也会读 UA），
  // 所以先认「这段是干什么的」，再决定回什么。识别标志用各脚本里只出现于自己的那部分。
  const isTapScript = expr.includes('scrollIntoView');

  if (isTapScript) {
    const selector = extractSelector(expr);
    const item = selector === null ? null : matchSelector(selector, items);
    if (!item) {
      return {
        result: {
          type: 'object',
          value: {
            ok: false,
            reason: 'not-found',
            viewport,
            candidates: items.filter((it) => it.visible).map((it) => ({ id: it.id, text: it.label || it.text })),
          },
        },
      };
    }
    if (!item.visible) {
      return { result: { type: 'object', value: { ok: false, reason: 'not-visible', element: describeItem(item), rect: item.rect, viewport } } };
    }
    return {
      result: {
        type: 'object',
        value: {
          ok: true,
          element: describeItem(item),
          rect: { ...item.rect },
          cx: item.rect.x + item.rect.w / 2,
          cy: item.rect.y + item.rect.h / 2,
          inView: item.inView,
          scrolled: false,
          hit: { id: item.hitId, tag: item.hitTag, text: item.label, cls: '' },
          hitMatch: item.hitMatch,
          viewport,
        },
      },
    };
  }

  if (expr.includes('querySelectorAll')) {
    const shown = items.filter((it) => it.visible);
    return {
      result: {
        type: 'object',
        value: {
          url,
          title,
          hanaShell: true,
          viewport,
          total: items.length,
          hidden: items.length - shown.length,
          shown: shown.length,
          items: items.map((it) => ({ ...it, rect: { ...it.rect } })),
        },
      },
    };
  }

  if (/^\s*navigator\.userAgent\s*;?\s*$/.test(expr)) {
    return { result: { type: 'string', value: viewport.ua } };
  }

  if (expr.includes('throw-me')) {
    return {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'Error: 假异常（离线自检用）\n    at <anonymous>:1:1' },
      },
    };
  }

  // 其余表达式一律回显：证明往返通、JSON 解析正确，但不假装会算 JS
  return { result: { type: 'string', value: `ECHO: ${expr}` } };
}

/* ---------------------------- 服务器 ---------------------------- */

/**
 * 起一个假调试端点。
 * mode: 'normal' | 'no-page'（只有 service_worker target）| 'html'（/json/list 返回 HTML）
 */
export async function startFakeCdp(options = {}) {
  const ctx = {
    items: options.items || DEFAULT_ITEMS,
    viewport: options.viewport || DEFAULT_VIEWPORT,
    url: options.url || 'http://127.0.0.1:24000/',
    title: options.title || 'Hana（假页面）',
  };
  const mode = options.mode || 'normal';
  const sockets = new Set();
  let port = 0;

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/json/list' || pathname === '/json/list/') {
      if (mode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>404 Not Found</body></html>');
        return;
      }
      if (mode === 'no-page') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'SW1', type: 'service_worker', url: 'http://127.0.0.1:24000/sw.js', title: '' }]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 'FAKE-PAGE',
        type: 'page',
        title: ctx.title,
        url: ctx.url,
        description: '',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/FAKE-PAGE`,
      }]));
      return;
    }
    if (pathname === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Chrome/120.0.0.0 (fake)', 'Protocol-Version': '1.3' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeOneFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame('', 0x8));
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload.toString('utf8'), 0xa));
          continue;
        }
        if (frame.opcode !== 0x1) continue; // 二进制/续帧：自检用不到
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }
        socket.write(encodeFrame(JSON.stringify(handleCdp(msg, ctx))));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // options.port 一般用 0（让系统挑）；自检里指定固定端口，好让假 adb 的代理指过来
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  port = server.address().port;

  return {
    port,
    httpBase: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/devtools/page/FAKE-PAGE`,
    context: ctx,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* 已经没了 */ }
      }
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

function handleCdp(msg, ctx) {
  const id = msg && msg.id != null ? msg.id : 0;
  const method = msg && msg.method;
  if (method === 'Runtime.evaluate') {
    // 注意信封：「CDP 命令结果」外面还包一层 result，Runtime.evaluate 自己的结果里又有一个
    // result（RemoteObject）——与真调试器一致，否则客户端会把两个 result 看错。
    const payload = evaluateFake(msg.params && msg.params.expression, ctx);
    return { id, result: payload };
  }
  if (method === 'Browser.getVersion') {
    return { id, result: { product: 'Chrome/120.0.0.0 (fake)', userAgent: ctx.viewport.ua } };
  }
  if (method === 'Runtime.enable' || method === 'Page.enable') return { id, result: {} };
  return { id, error: { code: -32601, message: `fake-cdp 不支持 ${method}` } };
}

// 直接跑：起服务并打印地址，方便手动对着调
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeCdp();
  process.stdout.write(`假 CDP 端点已就绪\n  http: ${fake.httpBase}/json/list\n  ws:   ${fake.wsUrl}\n`);
  process.stdout.write('试一下：\n');
  process.stdout.write(`  node scripts/devtools/ui-probe.mjs --cdp-url ${fake.wsUrl} --dry-run\n`);
  process.stdout.write(`  node scripts/devtools/js-eval.mjs "1+1" --cdp-url ${fake.wsUrl}\n`);
  process.stdout.write('Ctrl-C 结束\n');
  process.on('SIGINT', () => {
    fake.close().finally(() => process.exit(0));
  });
}
