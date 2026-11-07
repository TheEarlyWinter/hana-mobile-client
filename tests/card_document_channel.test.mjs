/* tests/card_document_channel.test.mjs
 *
 * 卡片文档通道（MessageChannel）最小生命周期测试：
 * - register 生成 256bit nonce，只接受精确 source + nonce 的一次连接
 * - 请求/响应只走该文档 port；window 裸 card:request 一律拒绝
 * - 同一 iframe WindowProxy 导航后，旧 port 失效、新文档不能复用旧 nonce
 *
 * 只使用 Node 本地 MessageChannel，不启动服务、不访问网络。
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCardBridge } from '../web/card-bridge.js';
import { CARD_RUNTIME_SCRIPT } from '../shared/card-runtime.mjs';

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  const listeners = [];
  const windowReplies = [];
  const apiCalls = [];

  const fakeWindow = {
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener(type, fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  const api = async (path, init = {}) => {
    apiCalls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, result: {} };
  };

  const bridge = createCardBridge({
    api,
    window: fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write', 'tools.run', 'studio.owner'] }),
  });

  function createIframe() {
    const contentWindow = {
      postMessage(data) { windowReplies.push(data); },
    };
    const loadListeners = [];
    return {
      contentWindow,
      isConnected: true,
      addEventListener(type, fn) {
        if (type === 'load') loadListeners.push(fn);
      },
      removeEventListener(type, fn) {
        const idx = loadListeners.indexOf(fn);
        if (idx !== -1) loadListeners.splice(idx, 1);
      },
      fireLoad() {
        for (const fn of [...loadListeners]) fn({ type: 'load' });
      },
      replaceContentWindow(next) {
        this.contentWindow = next;
      },
    };
  }

  function connect(iframe, nonce, port) {
    for (const fn of [...listeners]) {
      fn({
        data: { type: 'card:connect', nonce },
        source: iframe.contentWindow,
        ports: [port],
      });
    }
  }

  function sendRawWindowMessage(iframe, data) {
    for (const fn of [...listeners]) {
      fn({ data, source: iframe.contentWindow, ports: [] });
    }
  }

  return { bridge, fakeWindow, apiCalls, windowReplies, createIframe, connect, sendRawWindowMessage };
}

function makePort() {
  const channel = new MessageChannel();
  const inbox = [];
  channel.port1.onmessage = (ev) => inbox.push(ev.data);
  channel.port1.start();
  return { port1: channel.port1, port2: channel.port2, inbox };
}

function context() {
  return {
    cardEntityId: 'chat-card:doc-1',
    cardId: 'doc-1',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/sess-1',
  };
}

await t('register 生成 256bit nonce，精确 source + nonce 连接后才绑定 port', async () => {
  const env = createHarness();
  const iframe = env.createIframe();
  const reg = env.bridge.register(iframe, context());

  assert.ok(reg && typeof reg.nonce === 'string');
  assert.match(reg.nonce, /^[0-9a-f]{64}$/);

  const p = makePort();
  // 错 nonce 不能连接
  env.connect(iframe, '0'.repeat(64), p.port2);
  await delay(10);
  assert.equal(p.inbox.length, 0);

  // 正确 nonce 连接
  env.connect(iframe, reg.nonce, p.port2);
  p.port1.postMessage({
    type: 'card:request',
    requestId: 'req_caps_1',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  await delay(60);
  assert.equal(p.inbox.length, 1);
  assert.equal(p.inbox[0].requestId, 'req_caps_1');
  assert.equal(p.inbox[0].ok, true);
});

await t('window 裸 card:request 无 nonce/port 一律拒绝，不调用 API 也不回敏感结果', async () => {
  const env = createHarness();
  const iframe = env.createIframe();
  env.bridge.register(iframe, context());

  env.sendRawWindowMessage(iframe, {
    type: 'card:request',
    requestId: 'req_raw',
    capability: 'host.capabilities',
    payload: {},
  });
  await delay(20);

  assert.equal(env.apiCalls.length, 0);
  assert.equal(env.windowReplies.length, 0, '不得通过 window 回响应');
});

await t('每 registration 只允许一次连接，第二 port 被拒绝', async () => {
  const env = createHarness();
  const iframe = env.createIframe();
  const reg = env.bridge.register(iframe, context());

  const first = makePort();
  const second = makePort();
  env.connect(iframe, reg.nonce, first.port2);
  env.connect(iframe, reg.nonce, second.port2);

  first.port1.postMessage({
    type: 'card:request',
    requestId: 'req_first',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  second.port1.postMessage({
    type: 'card:request',
    requestId: 'req_second',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  await delay(20);

  assert.equal(first.inbox.length, 1);
  assert.equal(second.inbox.length, 0, '第二连接不得接管');
});

await t('同一 iframe WindowProxy A→B 导航后，旧 port 失效且 B 不能复用 A 的 nonce', async () => {
  const env = createHarness();
  const iframe = env.createIframe();
  const reg = env.bridge.register(iframe, context());

  const portA = makePort();
  env.connect(iframe, reg.nonce, portA.port2);
  iframe.fireLoad(); // 首次文档 load，不应误销

  portA.port1.postMessage({
    type: 'card:request',
    requestId: 'req_A',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  await delay(20);
  assert.equal(portA.inbox.length, 1);

  // 模拟同一 iframe 导航：WindowProxy 换成 B，随后触发第二次 load
  iframe.replaceContentWindow({});
  iframe.fireLoad();
  await delay(10);

  // 旧 port 再发请求，不得再得到结果
  portA.port1.postMessage({
    type: 'card:request',
    requestId: 'req_A_after_nav',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  await delay(20);
  assert.equal(portA.inbox.length, 1, '旧文档 port 不得继续服务');

  // B 知道旧 nonce 也不能第二次连接
  const portB = makePort();
  env.connect(iframe, reg.nonce, portB.port2);
  portB.port1.postMessage({
    type: 'card:request',
    requestId: 'req_B',
    capability: 'host.capabilities',
    payload: {},
    timeoutMs: 1000,
  });
  await delay(20);
  assert.equal(portB.inbox.length, 0, '新文档不得继承旧权限');
});

await t('SDK 短超时取消后，确认恢复也不得开始 invoke', async () => {
  const listeners = [];
  const apiCalls = [];
  let confirmCalls = 0;
  const fakeWindow = {
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener() {},
  };
  const api = async (path) => {
    apiCalls.push(path);
    return { ok: true, result: {} };
  };
  const bridge = createCardBridge({
    api,
    window: fakeWindow,
    confirmAction: async () => {
      confirmCalls += 1;
      await delay(220);
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', sessionPath: '/sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] }),
  });

  const child = {};
  child.window = child;
  child.globalThis = child;
  child.console = console;
  child.setTimeout = setTimeout;
  child.clearTimeout = clearTimeout;
  child.MessageChannel = MessageChannel;
  child.location = { hash: '' };
  child.addEventListener = (type, fn) => {
    if (type === 'pagehide') child.__pagehide = fn;
  };
  child.removeEventListener = () => {};
  child.document = {
    querySelector(selector) {
      if (selector === 'meta[name="hana-mobile-bridge"]') return { getAttribute: () => registration.nonce };
      return null;
    },
  };
  child.parent = {
    postMessage(data, targetOrigin, transfer) {
      for (const fn of [...listeners]) {
        fn({ data, source: child, ports: transfer || [] });
      }
    },
  };
  const iframe = {
    contentWindow: child,
    isConnected: true,
    addEventListener() {},
    removeEventListener() {},
  };
  const registration = bridge.register(iframe, {
    cardEntityId: 'chat-card:timeout-doc',
    cardId: 'timeout-doc',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/sess-1',
  });

  const context = vm.createContext(child);
  vm.runInContext('window.__HANA_CARD_RUNTIME_CONFIG__ = { actionTimeoutMs: 100, readTimeoutMs: 100 };', context);
  vm.runInContext(CARD_RUNTIME_SCRIPT, context);

  const res = await child.card.invoke('tool-x', { value: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CARD_TIMEOUT');
  assert.equal(confirmCalls, 1);
  await delay(30);
  assert.equal(apiCalls.includes('/api/card-host/tools/invoke'), false, 'SDK 已超时取消，恢复确认后不得开始 invoke');
  if (typeof child.__pagehide === 'function') child.__pagehide();
  bridge.dispose();
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll card document channel tests passed.');
  process.exit(0);
}
