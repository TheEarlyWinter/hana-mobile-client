/* tests/card_runtime.test.mjs
 *
 * shared/card-runtime.mjs 契约测试：
 * 1. 导出 CARD_RUNTIME_SCRIPT 与 getCardRuntimeScript
 * 2. 注入后挂载 window.card 与同对象 window.hana，具备规范 API 及 card.request
 * 3. 采用 canonical capability: host.capabilities, state.get, state.set, tool.invoke, emit, track, data.get
 * 4. 所有异步 API 永不 reject，统一返回 { ok, result } 或 { ok: false, code, error, result: {} }
 * 5. state.get(key) 提取 result.value 且保留整体 result.state
 * 6. 安全性：从受控 meta 读 nonce + MessageChannel 连接；裸 window 响应不 resolve
 * 7. 兼容响应格式：支持 card:response 以及旧版 hana.card-host-response
 * 8. 超时分流：动作类 5 分钟并提示勿重复提交，状态类 15 秒；有界 pending 超额拒绝
 * 9. 重复注入保护：已存在可用 SDK 时不重复覆盖，不重复建立 MessageChannel/pagehide 监听
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CARD_RUNTIME_SCRIPT, getCardRuntimeScript } from '../shared/card-runtime.mjs';

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

// 构造沙箱内的 mock window 与 parent
function createRuntimeEnvironment({ existingCard = null, nonce = 'a'.repeat(64) } = {}) {
  const messageListeners = [];
  const pagehideListeners = [];
  const parentMessages = [];
  const connectMessages = [];
  let remotePort = null;

  const parentWindow = {
    postMessage(data, targetOrigin, transfer) {
      if (data && data.type === 'card:connect') {
        connectMessages.push({ data, targetOrigin, transfer });
        const transferred = transfer && transfer[0];
        if (transferred) {
          remotePort = transferred;
          remotePort.onmessage = (ev) => parentMessages.push({ data: ev.data, targetOrigin: '*' });
          remotePort.start();
        }
        return;
      }
      // 旧 window 广播只能记录，不能作为卡片响应通道
      parentMessages.push({ data, targetOrigin });
    }
  };

  const fakeWindow = {
    __parentMessages: parentMessages,
    parent: parentWindow,
    MessageChannel: globalThis.MessageChannel,
    document: {
      querySelector(selector) {
        if (selector === 'meta[name="hana-mobile-bridge"]') {
          return { getAttribute: () => nonce };
        }
        return null;
      }
    },
    location: { hash: '' },
    addEventListener(event, fn) {
      if (event === 'message') messageListeners.push(fn);
      if (event === 'pagehide') pagehideListeners.push(fn);
    },
    removeEventListener(event, fn) {
      const list = event === 'pagehide' ? pagehideListeners : messageListeners;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    Math: globalThis.Math,
    JSON: globalThis.JSON,
    console: globalThis.console,
    card: existingCard
  };

  fakeWindow.window = fakeWindow;
  fakeWindow.globalThis = fakeWindow;

  const context = vm.createContext(fakeWindow);

  function runScript(code = CARD_RUNTIME_SCRIPT) {
    vm.runInContext(code, context);
  }

  function simulateParentMessage(data) {
    if (!remotePort) throw new Error('runtime did not create a MessageChannel connection');
    remotePort.postMessage(data);
  }

  function simulateLegacyWindowMessage(data, { source = parentWindow } = {}) {
    for (const fn of [...messageListeners]) {
      fn({ data, source });
    }
  }

  return {
    window: fakeWindow,
    parentMessages,
    connectMessages,
    messageListeners,
    pagehideListeners,
    runScript,
    simulateParentMessage,
    simulateLegacyWindowMessage
  };
}

await t('导出检查：CARD_RUNTIME_SCRIPT 为非空字符串，getCardRuntimeScript 返回相同内容', async () => {
  assert.equal(typeof CARD_RUNTIME_SCRIPT, 'string');
  assert.ok(CARD_RUNTIME_SCRIPT.length > 100);
  assert.equal(getCardRuntimeScript(), CARD_RUNTIME_SCRIPT);
});

await t('注入初始化：同时挂载 window.card 与同对象 window.hana，包含 card.request', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  const { card, hana } = env.window;
  assert.ok(card, 'window.card 应存在');
  assert.equal(card, hana, 'window.hana 与 window.card 应指向同一对象');
  assert.equal(typeof card.capabilities, 'function');
  assert.equal(typeof card.invoke, 'function');
  assert.equal(typeof card.emit, 'function');
  assert.equal(typeof card.track, 'function');
  assert.equal(typeof card.request, 'function');
  assert.equal(typeof card.state?.get, 'function');
  assert.equal(typeof card.state?.set, 'function');
  assert.equal(typeof card.data?.get, 'function');
  assert.equal(typeof card.data?.onChange, 'function');
});

await t('请求与响应正常流转：发出 canonical host.capabilities 并成功返回标准化 envelope', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  const promise = env.window.card.capabilities();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.parentMessages.length, 1);

  const req = env.parentMessages[0].data;
  assert.equal(req.type, 'card:request');
  assert.equal(req.capability, 'host.capabilities', '必须使用 canonical host.capabilities');
  assert.ok(req.requestId);

  // parent 回复响应
  env.simulateParentMessage({
    type: 'card:response',
    requestId: req.requestId,
    ok: true,
    result: { environment: 'host', capabilities: { emit: 'available' } }
  });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.result.environment, 'host');
  assert.equal(res.result.capabilities.emit, 'available');
});

await t('状态读取：发出 canonical state.get 并提取 result.value 与整体 result.state', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  const promise = env.window.card.state.get('user_score');
  await new Promise(r => setTimeout(r, 10));
  const req = env.parentMessages[0].data;
  assert.equal(req.capability, 'state.get', '必须使用 canonical state.get');
  assert.deepEqual(JSON.parse(JSON.stringify(req.payload)), { key: 'user_score' });

  env.simulateParentMessage({
    type: 'card:response',
    requestId: req.requestId,
    ok: true,
    result: {
      state: { user_score: 99, level: 2 }
    }
  });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.result.value, 99);
  assert.deepEqual(JSON.parse(JSON.stringify(res.result.state)), { user_score: 99, level: 2 });
});

await t('安全校验：非 parent 来源的消息必须被彻底忽略', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  let resolved = false;
  const promise = env.window.card.invoke('doSomething', { x: 1 });
  promise.then(() => { resolved = true; });
  await new Promise(r => setTimeout(r, 10));

  const req = env.parentMessages[0].data;
  assert.equal(req.capability, 'tool.invoke', '必须使用 canonical tool.invoke');

  // 裸 window 广播不再被 runtime 监听；即使伪造 parent 也不能 resolve
  const maliciousWindow = {};
  env.simulateLegacyWindowMessage({
    type: 'card:response',
    requestId: req.requestId,
    ok: true,
    result: { fake: true }
  }, { source: maliciousWindow });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(resolved, false, '非 parent 发来的响应不应触发 promise resolve');

  // 用真实的 parent 回复
  env.simulateParentMessage({
    type: 'card:response',
    requestId: req.requestId,
    ok: true,
    result: { real: true }
  });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.result.real, true);
});

await t('响应格式兼容：支持旧版 hana.card-host-response 平铺响应', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  const promise = env.window.card.emit('on_win', { score: 100 });
  await new Promise(r => setTimeout(r, 10));
  const req = env.parentMessages[0].data;
  assert.equal(req.capability, 'emit', '必须使用 canonical emit');

  // 使用旧版 hana.card-host-response
  env.simulateParentMessage({
    type: 'hana.card-host-response',
    requestId: req.requestId,
    ok: true,
    result: { accepted: true }
  });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(res.result)), { accepted: true });
});

await t('错误响应统一规范：宿主返回错误时不 reject，补全 code/error/result:{}', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  const promise = env.window.card.emit('custom-event', { a: 1 });
  await new Promise(r => setTimeout(r, 10));
  const req = env.parentMessages[0].data;

  env.simulateParentMessage({
    type: 'card:response',
    requestId: req.requestId,
    ok: false,
    code: 'CARD_HOST_EMIT_DENIED',
    error: 'User denied emit'
  });

  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CARD_HOST_EMIT_DENIED');
  assert.equal(res.error, 'User denied emit');
  assert.deepEqual(JSON.parse(JSON.stringify(res.result)), {});
});

await t('超时分流与安全提示：action 超时提示未确认勿重复提交', async () => {
  const env = createRuntimeEnvironment();
  // 注入快速超时配置
  env.runScript(`
    window.__HANA_CARD_RUNTIME_CONFIG__ = { actionTimeoutMs: 50, readTimeoutMs: 30 };
  ` + CARD_RUNTIME_SCRIPT);

  const res = await env.window.card.invoke('slow-tool', {});
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CARD_TIMEOUT');
  assert.ok(res.error.includes('勿重复提交') || res.error.includes('未确认'));
  assert.deepEqual(JSON.parse(JSON.stringify(res.result)), {});
});

await t('保护已有可用 SDK：如果 window.card 已经就绪，不覆盖已有实现', async () => {
  const existing = {
    invoke: () => 'existing_invoke',
    state: { get: () => 'existing_get' }
  };
  const env = createRuntimeEnvironment({ existingCard: existing });
  env.runScript();

  assert.equal(env.window.card.invoke(), 'existing_invoke');
  assert.equal(env.window.card.state.get(), 'existing_get');
});

await t('重复注入不重复监听 message 事件', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();
  const pagehideCount1 = env.pagehideListeners.length;
  const connectCount1 = env.connectMessages.length;

  env.runScript();
  const pagehideCount2 = env.pagehideListeners.length;
  const connectCount2 = env.connectMessages.length;

  assert.equal(pagehideCount1, pagehideCount2, '重复注入不应重复添加 pagehide 监听');
  assert.equal(connectCount1, connectCount2, '重复注入不应重复建立 MessageChannel');
});

await t('data.onChange 监听：正确接收 hana.card-data-changed 广播并将 document 本身传入回调', async () => {
  const env = createRuntimeEnvironment();
  env.runScript();

  let receivedDoc = null;
  const unsubscribe = env.window.card.data.onChange((doc) => {
    receivedDoc = doc;
  });

  const testDoc = { score: 100, status: 'live' };
  env.simulateParentMessage({
    type: 'hana.card-data-changed',
    data: testDoc
  });
  await new Promise(r => setTimeout(r, 20));

  assert.deepEqual(JSON.parse(JSON.stringify(receivedDoc)), testDoc);

  // 取消监听验证
  receivedDoc = null;
  unsubscribe();
  env.simulateParentMessage({
    type: 'hana.card-data-changed',
    data: { score: 200 }
  });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(receivedDoc, null, '取消订阅后不应再触发回调');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll card runtime tests passed.');
  process.exit(0);
}
