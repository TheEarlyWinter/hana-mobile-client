/* tests/native_bridge.test.mjs — 页面 → 原生通道（WebMessageChannel）的行为测试
 *
 * 这条通道无设备可跑：真机上的 WebView 会把端口投到主 frame 的 window 上，
 * 这里用一个假 window 复现同一件事（dispatch 一条带 ports 的 message 事件），
 * 断言的是**我们自己那份协议的边界**：
 *
 * 1. 没有原生壳时安静降级：available 恒 false、notify 返回 false、requestPermission
 *    返回 'unsupported'，绝不抛错；
 * 2. 握手超时（3 秒）不挂住页面：whenReady() 一定会 resolve；
 * 3. 只接受 origin 相符、带指纹、带端口的握手；非法 origin 一律拒绝；
 * 4. 下行只认 {v:1, reply:'permission', id, status}；超长 / 非 JSON / 版本不符 / id 不匹配
 *    统统丢掉（表现为回执超时，而不是被错误地当成 granted）；
 * 5. 上行标题 / 正文有上限，换行与控制字符被压平。
 *
 * 注意：所有用例的握手/回执超时都调到几十毫秒，测试不等 3 秒、也不留悬挂定时器。
 */

import assert from 'node:assert/strict';
import {
  createNativeBridge,
  normalizeOrigin,
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
} from '../web/native-bridge.js';

const ORIGIN = 'https://app.example';
const HELLO = '{"v":1,"bridge":"hana-native","max":2048}';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 夹具：假 window + 假端口                                             */
/* ------------------------------------------------------------------ */

function fakeWindow(origin = ORIGIN) {
  const listeners = new Map();
  return {
    location: { origin },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    listenerCount(type = 'message') {
      return (listeners.get(type) || []).length;
    },
    dispatchMessage(event) {
      for (const fn of [...(listeners.get('message') || [])]) fn(event);
    },
  };
}

function fakePort() {
  const port = {
    sent: [],
    onmessage: null,
    started: false,
    closed: false,
    postMessage(data) {
      if (port.closed) throw new Error('端口已关闭');
      port.sent.push(data);
    },
    start() {
      port.started = true;
    },
    close() {
      port.closed = true;
    },
    /** 模拟「原生 → 页面」的一条消息。 */
    emit(data) {
      port.onmessage?.({ data });
    },
  };
  return port;
}

function helloEvent(win, port, overrides = {}) {
  return { type: 'message', origin: ORIGIN, data: HELLO, ports: [port], source: win, ...overrides };
}

/* ------------------------------------------------------------------ */
/* 1. origin 规整                                                       */
/* ------------------------------------------------------------------ */

await t('normalizeOrigin 与原生 targetOrigin 用同一种序列化（默认端口省略）', () => {
  assert.equal(normalizeOrigin('https://app.example/'), 'https://app.example');
  assert.equal(normalizeOrigin('http://127.0.0.1:24000/'), 'http://127.0.0.1:24000');
  assert.equal(normalizeOrigin('http://app.example:80'), 'http://app.example');
  assert.equal(normalizeOrigin('https://app.example:443/x/y?z=1'), 'https://app.example');
  assert.equal(normalizeOrigin('null'), '');
  assert.equal(normalizeOrigin(''), '');
  assert.equal(normalizeOrigin('不是地址'), '');
});

/* ------------------------------------------------------------------ */
/* 2. 没有原生壳：安静降级                                              */
/* ------------------------------------------------------------------ */

await t('没有原生壳时 available=false、notify 返回 false、requestPermission 返回 unsupported', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 20 });
  assert.equal(bridge.available, false);
  assert.equal(await bridge.notify('Hana', '回复已完成'), false);
  assert.equal(await bridge.requestPermission(), 'unsupported');
  assert.equal(bridge.available, false);
  bridge.dispose();
  assert.equal(win.listenerCount(), 0, 'dispose 之后不该还挂着 message 监听');
});

await t('握手超时会自己收摊，whenReady() 一定 resolve（不挂住页面）', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 25 });
  const startedAt = Date.now();
  assert.equal(await bridge.whenReady(), false);
  const waited = Date.now() - startedAt;
  assert.ok(waited >= 15, `应该在超时之后才放弃，实际等了 ${waited}ms`);
  assert.ok(waited < 1000, `不该拖这么久：${waited}ms`);
  bridge.dispose();
});

await t('window 连 addEventListener 都没有时立刻不可用，不抛错', async () => {
  const bridge = createNativeBridge({ window: {}, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  assert.equal(bridge.available, false);
  assert.equal(await bridge.whenReady(), false);
  assert.equal(await bridge.notify('Hana', 'x'), false);
  assert.equal(await bridge.requestPermission(), 'unsupported');
  bridge.dispose();
});

await t('没有 expectedOrigin 且 window 也给不出 origin：拒绝一切握手（fail closed）', async () => {
  const win = fakeWindow('');
  const bridge = createNativeBridge({ window: win, expectedOrigin: '', handshakeTimeoutMs: 20 });
  const port = fakePort();
  win.dispatchMessage({ type: 'message', origin: '', data: HELLO, ports: [port], source: win });
  await tick(5);
  assert.equal(bridge.available, false);
  assert.equal(port.sent.length, 0, '不该给来历不明的握手回 hello');
  bridge.dispose();
});

/* ------------------------------------------------------------------ */
/* 3. 握手：origin / 指纹 / 端口                                        */
/* ------------------------------------------------------------------ */

await t('非法 origin 的握手被拒绝，端口也不回 hello', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 30 });
  const port = fakePort();
  win.dispatchMessage(helloEvent(win, port, { origin: 'https://evil.example' }));
  await tick(5);
  assert.equal(bridge.available, false, '跨源消息不能建立通道');
  assert.equal(port.sent.length, 0);
  assert.equal(await bridge.whenReady(), false);
  bridge.dispose();
});

await t('没有指纹的消息（卡片之间的 postMessage）不当握手', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 20 });
  const port = fakePort();
  win.dispatchMessage({ type: 'message', origin: ORIGIN, data: '{"type":"card"}', ports: [port], source: win });
  win.dispatchMessage({ type: 'message', origin: ORIGIN, data: HELLO, ports: [], source: win });
  await tick(5);
  assert.equal(bridge.available, false);
  assert.equal(port.sent.length, 0);
  bridge.dispose();
});

await t('origin 为空但确实来自同一个 window 时才认（个别 WebView 不给 origin）', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  const port = fakePort();
  win.dispatchMessage({ type: 'message', origin: '', data: HELLO, ports: [port], source: win });
  assert.equal(bridge.available, true);
  assert.equal(await bridge.whenReady(), true);
  bridge.dispose();
});

await t('origin 与 source 都缺的握手要采纳（真机 WebView 就是这个形状）', async () => {
  // 真机实测：Android 15 WebView 的 postWebMessage 送到页面时 origin 是空串、source 是 null。
  // 安全依据是端口本身—— WebMessagePort 只能由壳创建，网页造不出来。
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 20 });
  const port = fakePort();
  win.dispatchMessage({ type: 'message', origin: '', data: HELLO, ports: [port], source: null });
  await tick(5);
  assert.equal(bridge.available, true);
  assert.equal(await bridge.whenReady(), true);
  bridge.dispose();
});

await t('origin 缺失且本页不在预期 origin 上时仍然拒绝', async () => {
  const win = fakeWindow();
  win.location = { origin: 'http://evil.example' };
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 20 });
  const port = fakePort();
  win.dispatchMessage({ type: 'message', origin: '', data: HELLO, ports: [port], source: null });
  await tick(5);
  assert.equal(bridge.available, false);
  bridge.dispose();
});

/* ------------------------------------------------------------------ */
/* 4. 通道建立之后：notify                                              */
/* ------------------------------------------------------------------ */

await t('握手成功后立刻可用，并且先回一个 hello 让原生停下重投', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  const port = fakePort();
  win.dispatchMessage(helloEvent(win, port));
  assert.equal(bridge.available, true);
  assert.equal(port.started, true, '端口要 start()');
  assert.equal(port.sent.length, 1);
  assert.deepEqual(JSON.parse(port.sent[0]), { v: 1, hello: true });
  bridge.dispose();
});

await t('notify 发出的报文形状固定，标题正文都在', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  const port = fakePort();
  win.dispatchMessage(helloEvent(win, port));
  assert.equal(await bridge.notify('Hana', '回复已完成'), true);
  const msg = JSON.parse(port.sent.at(-1));
  assert.deepEqual(msg, { v: 1, action: 'notify', title: 'Hana', body: '回复已完成' });
  bridge.dispose();
});

await t('标题 / 正文超长会被截断，换行与控制字符被压平', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  const port = fakePort();
  win.dispatchMessage(helloEvent(win, port));
  assert.equal(await bridge.notify('助'.repeat(200), 'a\nb\r\nc\u0007' + '字'.repeat(400)), true);
  const msg = JSON.parse(port.sent.at(-1));
  assert.equal(msg.title.length, NOTIFY_TITLE_MAX);
  assert.equal(msg.body.length, NOTIFY_BODY_MAX);
  assert.ok(msg.body.startsWith('a b c'), `换行应压成空格：${msg.body.slice(0, 8)}`);
  assert.ok(!/[\u0000-\u001f]/.test(msg.title + msg.body), '不许带控制字符进原生');
  bridge.dispose();
});

await t('端口已经死了：notify 返回 false 并降级，不抛错', async () => {
  const win = fakeWindow();
  const bridge = createNativeBridge({ window: win, expectedOrigin: ORIGIN, handshakeTimeoutMs: 50 });
  const dead = fakePort();
  win.dispatchMessage(helloEvent(win, dead));
  dead.closed = true;
  assert.equal(await bridge.notify('Hana', '回复已完成'), false);
  assert.equal(bridge.available, false, '发不出去就认定不可用');
  bridge.dispose();
});

/* ------------------------------------------------------------------ */
/* 5. 权限：只认合法的回执                                              */
/* ------------------------------------------------------------------ */

async function readyBridge(overrides = {}) {
  const win = fakeWindow();
  const port = fakePort();
  const bridge = createNativeBridge({
    window: win,
    expectedOrigin: ORIGIN,
    handshakeTimeoutMs: 50,
    permissionReplyTimeoutMs: 40,
    ...overrides,
  });
  win.dispatchMessage(helloEvent(win, port));
  return { win, port, bridge };
}

await t('requestPermission 等到原生回执才返回结论', async () => {
  const { port, bridge } = await readyBridge();
  const pending = bridge.requestPermission();
  await tick(5);
  const outbound = JSON.parse(port.sent.at(-1));
  assert.equal(outbound.action, 'requestPermission');
  assert.equal(outbound.v, 1);
  assert.equal(typeof outbound.id, 'string');
  port.emit(JSON.stringify({ v: 1, reply: 'permission', id: outbound.id, status: 'granted' }));
  assert.equal(await pending, 'granted');
  bridge.dispose();
});

await t('denied / unsupported 原样回传，未知状态收敛成 unknown', async () => {
  for (const [status, expected] of [['denied', 'denied'], ['unsupported', 'unsupported'], ['whatever', 'unknown']]) {
    const { port, bridge } = await readyBridge();
    const pending = bridge.requestPermission();
    await tick(5);
    const id = JSON.parse(port.sent.at(-1)).id;
    port.emit(JSON.stringify({ v: 1, reply: 'permission', id, status }));
    assert.equal(await pending, expected, `status=${status}`);
    bridge.dispose();
  }
});

await t('超长回执被丢弃：不会被当成 granted，而是等到回执超时（unknown）', async () => {
  const { port, bridge } = await readyBridge({ permissionReplyTimeoutMs: 30 });
  const pending = bridge.requestPermission();
  await tick(5);
  const id = JSON.parse(port.sent.at(-1)).id;
  port.emit('{"v":1,"reply":"permission","id":"' + id + '","status":"granted"}' + ' '.repeat(3000));
  assert.equal(await pending, 'unknown');
  bridge.dispose();
});

await t('非 JSON / 版本不符 / 不是权限回执 / id 不匹配都不影响结论', async () => {
  const { port, bridge } = await readyBridge({ permissionReplyTimeoutMs: 30 });
  const pending = bridge.requestPermission();
  await tick(5);
  const id = JSON.parse(port.sent.at(-1)).id;
  port.emit('这不是 json');
  port.emit(JSON.stringify({ v: 2, reply: 'permission', id, status: 'granted' }));
  port.emit(JSON.stringify({ v: 1, reply: 'card', id, status: 'granted' }));
  port.emit(JSON.stringify({ v: 1, reply: 'permission', id: id + '-x', status: 'granted' }));
  port.emit(JSON.stringify({ v: 1, reply: 'permission', status: 'granted' }));
  port.emit(42);
  port.emit(null);
  assert.equal(await pending, 'unknown');
  bridge.dispose();
});

/* ------------------------------------------------------------------ */
/* 6. 重新握手与销毁                                                    */
/* ------------------------------------------------------------------ */

await t('原生重投端口时页面接管新的那条（重投是安全的，不会两边各拿半条死端口）', async () => {
  const { win, port: first, bridge } = await readyBridge();
  const second = fakePort();
  win.dispatchMessage(helloEvent(win, second));
  assert.equal(first.closed, true, '旧端口应该被关掉');
  assert.equal(second.closed, false);
  assert.equal(second.sent.length, 1, '新端口上也要回 hello');
  assert.equal(await bridge.notify('Hana', 'x'), true);
  assert.equal(JSON.parse(second.sent.at(-1)).action, 'notify');
  bridge.dispose();
});

await t('同一个端口重复投不会把它关掉', async () => {
  const { win, port, bridge } = await readyBridge();
  win.dispatchMessage(helloEvent(win, port));
  assert.equal(port.closed, false);
  assert.equal(await bridge.notify('Hana', 'x'), true);
  bridge.dispose();
});

await t('dispose 会关端口、摘监听，并把在途的权限请求收成 unsupported', async () => {
  const { win, port, bridge } = await readyBridge({ permissionReplyTimeoutMs: 500 });
  const pending = bridge.requestPermission();
  await tick(5);
  bridge.dispose();
  assert.equal(await pending, 'unsupported');
  assert.equal(port.closed, true);
  assert.equal(win.listenerCount(), 0);
  assert.equal(bridge.available, false);
  assert.equal(await bridge.notify('Hana', 'x'), false);
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
