#!/usr/bin/env node
/* scripts/devtools 调试工具的 dry-run 与远端 dump 边界（任务 8 调试工具部分）。
 *
 * 目标行为（主控已核实旧实现会违反前两条）：
 *   1. --dry-run 不滚动页面：不调用 scrollIntoView，元素留在原处；
 *   2. --dry-run 不跑 uiautomator：不 dump、不 cat、不 rm 任何远端 xml，坐标按 dpr/--frame 估算；
 *   3. --dry-run 遇到视口外元素时回报「视口外、未点击」，不硬报「点不了」也不真点；
 *   4. 正常 readWebViewFrame 每次用随机唯一远端文件，只 cat/rm 自己那份，不读写删默认 window_dump.xml；
 *   5. 老机型不支持「dump 到指定路径」时返回 null 安全降级，不退回不带路径的 dump。
 *
 * 观测方式（全部离线，不接设备/浏览器/网关）：
 *   - 假 CDP 端点会真的用 vm + 最小 DOM 执行 ui-probe 发来的页面表达式，记录 scrollIntoView 调用；
 *     这是行为证据，不是匹配源码文本。
 *   - 假 adb 两种：仓库自带的 fake-adb.mjs（设备模式链路）与临时目录里生成的记录型假 adb
 *     （直接调用 readWebViewFrame，逐条断言 adb 命令）。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { readWebViewFrame } from '../scripts/devtools/lib/adb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI_PROBE = path.join(ROOT, 'scripts', 'devtools', 'ui-probe.mjs');
const REPO_FAKE_ADB = path.join(ROOT, 'scripts', 'devtools', 'fake-adb.mjs');
const SERIAL = 'FAKE0000';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-devtools-dryrun-'));
const UA = 'Mozilla/5.0 (Linux; Android 13; FAKE_PHONE Build/TQ3A.230901.001; wv)'
  + ' AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
const VIEWPORT = { w: 360, h: 800, dpr: 3 };

/* ------------------------------------------------------------------ */
/* 会真的执行页面表达式的假 CDP                                        */
/* ------------------------------------------------------------------ */

function makeElement(rect) {
  const state = { rect: { ...rect }, scrollCalls: 0 };
  const el = {
    id: 'btnCasual',
    tagName: 'BUTTON',
    className: 'agent-card',
    innerText: '随便聊聊',
    textContent: '随便聊聊',
    getAttribute: () => '',
    getBoundingClientRect: () => {
      const r = state.rect;
      return {
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        top: r.y,
        left: r.x,
        right: r.x + r.w,
        bottom: r.y + r.h,
      };
    },
    contains: (other) => other === el,
    // 真滚进视口：记录调用次数，并把矩形挪到视口内（后面点击脚本会重新读矩形）
    scrollIntoView: () => {
      state.scrollCalls += 1;
      state.rect = { ...state.rect, y: 100 };
    },
  };
  return { el, state };
}

function evaluateTapExpression(expression, page) {
  const { el } = page;
  const document = {
    title: 'Hana（假页面）',
    querySelector: (selector) => (String(selector) === '#btnCasual' ? el : null),
    querySelectorAll: () => [el],
    elementFromPoint: (x, y) => {
      const r = el.getBoundingClientRect();
      return x >= r.x && x <= r.right && y >= r.y && y <= r.bottom ? el : null;
    },
  };
  const sandbox = {
    document,
    navigator: { userAgent: UA },
    location: { href: 'http://127.0.0.1:24000/' },
    window: { scrollX: 0, scrollY: 0 },
    innerWidth: VIEWPORT.w,
    innerHeight: VIEWPORT.h,
    devicePixelRatio: VIEWPORT.dpr,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    setTimeout,
    clearTimeout,
    console,
  };
  return vm.runInNewContext(String(expression), sandbox, { timeout: 5000 });
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | 0x1, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | 0x1;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  const total = offset + maskLength + length;
  if (buffer.length < total) return null;
  let payload = buffer.subarray(offset + maskLength, total);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const plain = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) plain[i] = payload[i] ^ mask[i % 4];
    payload = plain;
  }
  return { opcode, payload, rest: buffer.subarray(total) };
}

/**
 * 起一个假调试端点：/json/list 正常回 page，Runtime.evaluate 用 vm 真的跑表达式。
 * rect 是元素初始矩形；scrollIntoView 会把 y 挪到 100（和真页面滚动效果一致）。
 */
async function startExecutingCdp({ rect }) {
  const page = makeElement(rect);
  const sockets = new Set();
  let port = 0;

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/json/list' || pathname === '/json/list/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 'FAKE-PAGE',
        type: 'page',
        title: 'Hana（假页面）',
        url: 'http://127.0.0.1:24000/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/FAKE-PAGE`,
      }]));
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
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
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
        const frame = decodeFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(''));
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }
        if (msg.method === 'Runtime.evaluate') {
          evaluateTapExpression(msg.params && msg.params.expression, page)
            .then((value) => {
              socket.write(encodeFrame(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value } } })));
            })
            .catch((err) => {
              socket.write(encodeFrame(JSON.stringify({
                id: msg.id,
                result: { exceptionDetails: { text: String((err && err.message) || err) } },
              })));
            });
        } else {
          socket.write(encodeFrame(JSON.stringify({ id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } })));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/devtools/page/FAKE-PAGE`,
    scrollCalls: () => page.state.scrollCalls,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* 已经没了 */ }
      }
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 假 adb / 子进程工具                                                  */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function runTool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UI_PROBE, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        // 不认宿主环境里的设备选择，只认本用例显式给的
        HANA_ANDROID_SERIAL: '',
        ANDROID_SERIAL: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`输出里没有 JSON：${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

function normalizeLog(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-s\s+\S+\s+/, ''));
}

function setEnv(vars) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// 直接调用 readWebViewFrame 用的记录型假 adb：只回答 dump/cat/rm，其余一律失败，
// 这样「偷偷多跑了一条 adb」会立刻暴露。
const RECORDING_ADB = path.join(TMP, 'recording-adb.mjs');
fs.writeFileSync(RECORDING_ADB, `
import { appendFileSync } from 'node:fs';

const raw = process.argv.slice(2);
const args = raw[0] === '-s' ? raw.slice(2) : raw;
if (process.env.FAKE_ADB_LOG) appendFileSync(process.env.FAKE_ADB_LOG, args.join(' ') + '\\n');

const ok = (text) => { if (text) process.stdout.write(text + '\\n'); process.exit(0); };
const fail = (text) => { process.stderr.write(text + '\\n'); process.exit(1); };

function xml() {
  const b = (process.env.FAKE_ADB_BOUNDS || '0,0,1080,2400').split(',').map(Number);
  return '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">'
    + '<node class="android.webkit.WebView" package="com.hanamobile.app" bounds="['
    + b[0] + ',' + b[1] + '][' + b[2] + ',' + b[3] + ']" /></hierarchy>';
}

const [kind, sub, third, fourth] = args;
if (kind === 'shell' && sub === 'uiautomator' && third === 'dump') {
  if (!fourth) fail('不接受不带路径的 uiautomator dump（会写默认 window_dump.xml）');
  if (process.env.FAKE_DUMP_UNSUPPORTED === '1') fail('Error: unknown option: ' + fourth);
  ok('UI hierchary dumped to: ' + fourth);
}
if (kind === 'shell' && sub === 'cat' && third) {
  if (process.env.FAKE_DUMP_OK === '1' && third.endsWith('.xml')) ok(xml());
  ok('');
}
if (kind === 'shell' && sub === 'rm') ok('');
fail('不认识的命令：' + args.join(' '));
`, 'utf8');

const pickFrame = (frame) => ({
  left: frame.left,
  top: frame.top,
  width: frame.width,
  height: frame.height,
  source: frame.source,
});

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push({ name, message: String((err && err.message) || err) });
    process.stdout.write(`  ✗ ${name}\n     ${String((err && err.message) || err).split('\n').join('\n     ')}\n`);
  }
}

process.stdout.write('devtools dry-run / 远端 dump 离线回归（假 CDP + 假 adb）\n\n');

/* ------------------------------------------------------------------ */
/* 1. --dry-run：不滚动、不探测、不点                                   */
/* ------------------------------------------------------------------ */

await check('--dry-run + 设备：不滚页面、不跑 uiautomator、不落盘、不点', async () => {
  const upstream = await startExecutingCdp({ rect: { x: 40, y: 1200, w: 280, h: 56 } }); // 视口外
  const local = await freePort();
  const log = path.join(TMP, 'adb-dry-run.log');
  try {
    const res = await runTool(
      ['--port', String(local), '--device', SERIAL, '--tap', '#btnCasual', '--dry-run', '--json'],
      {
        HANA_ADB_BIN: REPO_FAKE_ADB,
        FAKE_ADB_LOG: log,
        FAKE_ADB_BOUNDS: '0,0,1080,2400',
        FAKE_ADB_UPSTREAM_PORT: String(upstream.port),
      },
    );
    assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
    const data = parseJson(res.stdout);
    assert.equal(data.tapped, false, 'dry-run 不得真的点');
    assert.equal(data.scrolled, false, 'dry-run 不得滚动页面');
    assert.equal(data.inView, false, '元素在视口外，dry-run 应如实回报');
    assert.equal(data.frame, null, 'dry-run 不应去拿 uiautomator 矩形');
    assert.equal(data.mapping.estimated, true, '没有 --frame 时坐标应标成估算');
    assert.equal(upstream.scrollCalls(), 0, `dry-run 调用了 scrollIntoView ${upstream.scrollCalls()} 次`);

    const lines = normalizeLog(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    assert.equal(lines.some((l) => l.includes('uiautomator')), false, `dry-run 不得跑 uiautomator：${lines.join(' | ')}`);
    assert.equal(lines.some((l) => l.includes('.xml')), false, `dry-run 不得读写远端 dump：${lines.join(' | ')}`);
    assert.equal(lines.some((l) => l.includes('shell input tap')), false, 'dry-run 不得真的点');
    assert.match(res.stderr, /--dry-run 不跑 uiautomator/, '应说明 dry-run 不做 uiautomator 探测');
  } finally {
    await upstream.close();
  }
});

await check('非 dry-run 对照：同一元素会先滚进视口，再发出 input tap', async () => {
  const upstream = await startExecutingCdp({ rect: { x: 40, y: 1200, w: 280, h: 56 } });
  const local = await freePort();
  const log = path.join(TMP, 'adb-real-tap.log');
  try {
    const res = await runTool(
      ['--port', String(local), '--device', SERIAL, '--tap', '#btnCasual', '--json'],
      {
        HANA_ADB_BIN: REPO_FAKE_ADB,
        FAKE_ADB_LOG: log,
        FAKE_ADB_BOUNDS: '0,0,1080,2400',
        FAKE_ADB_UPSTREAM_PORT: String(upstream.port),
      },
    );
    assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
    const data = parseJson(res.stdout);
    assert.equal(data.scrolled, true, '正常点击应把视口外元素滚进来');
    assert.equal(data.tapped, true);
    assert.equal(upstream.scrollCalls(), 1, '正常点击应调用一次 scrollIntoView');
    const lines = normalizeLog(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    assert.ok(lines.some((l) => l.startsWith('shell input tap ')), `应真的发出 input tap：${lines.join(' | ')}`);
    // 正常路径仍然会探测 WebView 矩形（这里用的是本次唯一文件）
    assert.ok(lines.some((l) => l.includes('uiautomator dump /sdcard/hana-ui-probe-')));
  } finally {
    await upstream.close();
  }
});

await check('--dry-run + --frame：用 CLI 矩形换算，不探测、不滚动', async () => {
  const upstream = await startExecutingCdp({ rect: { x: 40, y: 180, w: 280, h: 56 } });
  try {
    const res = await runTool(
      ['--cdp-url', upstream.wsUrl, '--tap', '#btnCasual', '--dry-run', '--json', '--frame', '0,63,1080,2202'],
    );
    assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
    const data = parseJson(res.stdout);
    assert.equal(data.tapped, false);
    assert.equal(data.frame.top, 63);
    assert.equal(data.mapping.estimated, false);
    assert.equal(data.mapping.scaleX, 3);
    assert.equal(data.mapping.scaleY, 2.7525);
    assert.match(data.mapping.source, /--frame/);
    assert.equal(upstream.scrollCalls(), 0);
  } finally {
    await upstream.close();
  }
});

/* ------------------------------------------------------------------ */
/* 2. 正常 readWebViewFrame：随机唯一远端文件，只碰自己那份              */
/* ------------------------------------------------------------------ */

await check('readWebViewFrame：每次随机唯一远端文件，只 cat/rm 自己那份', async () => {
  const log = path.join(TMP, 'adb-frame-unique.log');
  const restore = setEnv({
    HANA_ADB_BIN: RECORDING_ADB,
    FAKE_ADB_LOG: log,
    FAKE_DUMP_OK: '1',
    FAKE_DUMP_UNSUPPORTED: undefined,
    FAKE_ADB_BOUNDS: '0,63,1080,2265',
  });
  try {
    const first = await readWebViewFrame(SERIAL);
    const second = await readWebViewFrame(SERIAL);
    assert.deepEqual(pickFrame(first), { left: 0, top: 63, width: 1080, height: 2202, source: 'uiautomator' });
    assert.deepEqual(pickFrame(second), { left: 0, top: 63, width: 1080, height: 2202, source: 'uiautomator' });

    const lines = normalizeLog(fs.readFileSync(log, 'utf8'));
    const dumps = lines.filter((l) => l.startsWith('shell uiautomator dump '));
    assert.equal(dumps.length, 2, `每次调用只 dump 一次：${lines.join(' | ')}`);
    const paths = dumps.map((l) => l.slice('shell uiautomator dump '.length).trim());
    for (const p of paths) {
      assert.match(p, /^\/sdcard\/hana-ui-probe-[A-Za-z0-9._-]+\.xml$/, `dump 路径应是本次唯一文件：${p}`);
      assert.notEqual(p, '/sdcard/hana-ui-probe.xml', '不得复用固定的旧文件名');
    }
    assert.notEqual(paths[0], paths[1], '两次调用必须用不同的远端文件');

    for (const p of paths) {
      assert.equal(lines.filter((l) => l === `shell cat ${p}`).length, 1, `应只 cat 自己那份 ${p}：${lines.join(' | ')}`);
      assert.equal(lines.filter((l) => l === `shell rm -f ${p}`).length, 1, `应只删自己那份 ${p}：${lines.join(' | ')}`);
    }
    assert.equal(lines.some((l) => l.includes('window_dump.xml')), false, '不得读/删默认 window_dump.xml');
    assert.equal(lines.some((l) => l === 'shell uiautomator dump'), false, '不得退回不带路径的 dump');
  } finally {
    restore();
  }
});

await check('readWebViewFrame：老机型不支持指定路径 → null，不退回默认 dump', async () => {
  const log = path.join(TMP, 'adb-frame-unsupported.log');
  const restore = setEnv({
    HANA_ADB_BIN: RECORDING_ADB,
    FAKE_ADB_LOG: log,
    FAKE_DUMP_OK: undefined,
    FAKE_DUMP_UNSUPPORTED: '1',
  });
  try {
    const frame = await readWebViewFrame(SERIAL);
    assert.equal(frame, null, '拿不到矩形应安全降级为 null');
    const lines = normalizeLog(fs.readFileSync(log, 'utf8'));
    const dumps = lines.filter((l) => l.startsWith('shell uiautomator dump '));
    assert.equal(dumps.length, 1, `只尝试一次指定路径：${lines.join(' | ')}`);
    const dumpPath = dumps[0].slice('shell uiautomator dump '.length).trim();
    assert.equal(lines.some((l) => l === 'shell uiautomator dump'), false, '不得退回不带路径的 dump（会覆盖默认文件）');
    assert.equal(lines.some((l) => l.startsWith('shell cat ')), false, 'dump 失败时不应再去读文件');
    assert.equal(lines.filter((l) => l === `shell rm -f ${dumpPath}`).length, 1, '仍应清理自己那份路径');
    assert.equal(lines.some((l) => l.includes('window_dump.xml')), false);
  } finally {
    restore();
  }
});

await check('readWebViewFrame：dump 成功但文件读不到 → null，仍清理自己的文件', async () => {
  const log = path.join(TMP, 'adb-frame-missing.log');
  const restore = setEnv({
    HANA_ADB_BIN: RECORDING_ADB,
    FAKE_ADB_LOG: log,
    FAKE_DUMP_OK: undefined,
    FAKE_DUMP_UNSUPPORTED: undefined,
  });
  try {
    const frame = await readWebViewFrame(SERIAL);
    assert.equal(frame, null);
    const lines = normalizeLog(fs.readFileSync(log, 'utf8'));
    const dumpPath = lines.find((l) => l.startsWith('shell uiautomator dump ')).slice('shell uiautomator dump '.length).trim();
    assert.equal(lines.filter((l) => l === `shell cat ${dumpPath}`).length, 1, '应读的是本次 dump 的那个文件');
    assert.equal(lines.filter((l) => l === `shell rm -f ${dumpPath}`).length, 1);
    assert.equal(lines.some((l) => l.includes('window_dump.xml')), false);
  } finally {
    restore();
  }
});

fs.rmSync(TMP, { recursive: true, force: true });

const total = passed + failures.length;
process.stdout.write(`\n${passed}/${total} 项通过`);
if (failures.length > 0) {
  process.stdout.write(`，${failures.length} 项失败\n`);
  for (const f of failures) process.stdout.write(`  - ${f.name}：${f.message.split('\n')[0]}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n');
  process.exitCode = 0;
}
