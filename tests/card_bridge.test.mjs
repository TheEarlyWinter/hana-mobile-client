/* tests/card_bridge.test.mjs
 *
 * web/card-bridge.js 宿主桥契约与安全测试：
 * 1. 伪造 source：非登记 iframe 来源的消息一律忽略
 * 2. identity / session 覆盖防御：强制使用 parent 冻结 context
 * 3. detach / 切 session 确认后不 POST：确认期间会话切换或 iframe detach，阻断 POST
 * 4. 重放 requestId：去重并返回缓存结果，不重复发送 POST
 * 5. 缺 metadata / 权限 caps：缺少 cardId/sourceVersion 或对应 scope 时，capabilities 准确返回 requires_host
 * 6. state HTTP 200 ok:false 错误透出：宿主返回错误时不乐观伪造成功
 * 7. invoke 拒绝和固定 body：用户拒绝时无 POST，通过时 body 仅含固定合法字段且不包含 client.binding/cardId 误传
 * 8. emit 确认与执行顺序：禁止 iframe 指定 to，严格 confirm -> prepare -> ticket 顺序
 * 9. payload 大小限制防护：emit > 8KiB 与 state > 64KiB 直接拒绝
 * 10. card.js 渲染与沙箱防御：sandbox 仅 allow-scripts，前置注入 meta CSP 与 SDK 脚本
 * 11. card.js renderCardByPath 支持 hostBridge 注册与 dispose
 * 12. 跨卡片隔离：卡片 A 与卡片 B 使用相同 requestId，结果互不共享且互不抑制
 * 13. 严格 fail-closed：缺 confirmAction、confirmAction 抛错或返回非 true 均拒绝且无 POST
 * 14. getActiveContext 严格 fail-closed：缺失、isVisible!==true 或 sessionId 不符均拒绝且无 POST
 * 15. 竞态防御：在 confirm pending 或 prepare pending 期间卡片 unregister/clear/切会话，阻断后续 POST
 * 16. 真实宿主 state 接口返回格式解构：正确 unwrap { ok: true, result: { state, seeded } }
 * 17. 实体正则与严格权限：不合法 cardEntityId 或缺少 chat/studio 权限时真实 disabled
 * 18. 恶意 HTML 绕过防御：script 早于 head 或注释中包含假 head，受控 meta CSP 与 SDK 永远最优先
 * 19. chat 隐式派生 sessions.read/write：典型 password scopes 开启 state/emit
 * 20. 同 frame 单副作用互斥锁：同一时刻只允许一个 invoke/emit，并发请求返回 CARD_ACTION_BUSY
 * 21. handleHostConfirmation 宿主第二道确认：正确匹配 pending invoke、二次弹窗确认并 POST /api/confirm
 * 22. handleHostConfirmation 防御：用户拒绝时 POST rejected、跨会话/非 pending invoke 忽略、防重复 confirmId、注销后不放行
 * 24. studio 命名空间不能冒充 studio.owner：track/data 缺精确 owner 零 POST
 * 25. invoke 输入预算与超大响应：超限不进入确认/API，超大结果不缓存
 * 26. 宿主确认 ok:false 抛错；已完成 pendingInvoke 不得被旧确认放行
 */

import assert from 'node:assert/strict';
import { createCardBridge as createRealCardBridge } from '../web/card-bridge.js';
import { renderCard, renderCardByPath } from '../web/card.js';

/** 测试夹具：register 后立即用返回 nonce 建立真实 MessageChannel。 */
function createCardBridge(options) {
  const bridge = createRealCardBridge(options);
  const realRegister = bridge.register;
  bridge.register = (iframe, context) => {
    const registration = realRegister(iframe, context);
    if (registration && registration.nonce && typeof iframe?.__connectPort === 'function') {
      iframe.__connectPort(registration.nonce);
    }
    return registration;
  };
  return bridge;
}

// 为 renderCard 提供最小 document mock
if (!globalThis.document) {
  globalThis.document = {
    createElement(tag) {
      const attrs = new Map();
      const children = [];
      return {
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        dataset: {},
        children,
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute(k) { return attrs.get(k); },
        appendChild(child) { children.push(child); return child; },
      };
    }
  };
}

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

function createMockHostEnvironment() {
  const windowListeners = [];
  const fakeWindow = {
    addEventListener(type, fn) {
      if (type === 'message') windowListeners.push(fn);
    },
    removeEventListener(type, fn) {
      const idx = windowListeners.indexOf(fn);
      if (idx !== -1) windowListeners.splice(idx, 1);
    }
  };

  const apiCalls = [];
  const apiHandler = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const callRecord = { path, method: init.method || 'GET', body, headers: init.headers };
    apiCalls.push(callRecord);

    if (apiHandler.mockResponse) {
      const resp = await apiHandler.mockResponse(path, body, init);
      if (resp !== undefined) return resp;
    }

    if (path === '/api/card-host/state/get') {
      return { ok: true, result: { state: { count: 10 }, seeded: false } };
    }
    if (path === '/api/card-host/state/set') {
      return { ok: true, result: { state: body.state || { [body.key]: body.value } } };
    }
    if (path === '/api/card-host/events/prepare') {
      return { ok: true, result: { submitTicket: 'ticket_12345', expiresAt: Date.now() + 60000 } };
    }
    if (path === '/api/card-host/events/emit') {
      return { ok: true, accepted: true };
    }
    if (path === '/api/card-host/tools/invoke') {
      return { ok: true, result: { invoked: true, tool: 'sample' } };
    }
    if (path.startsWith('/api/confirm/')) {
      return { ok: true };
    }
    return { ok: true };
  };

  function createMockIframe() {
    const postedToIframe = [];
    let channel = null;
    const contentWindow = {
      postMessage(data) {
        // 旧 window 广播只能记录，不能作为卡片响应通道
        postedToIframe.push(data);
      }
    };
    const iframe = {
      contentWindow,
      isConnected: true,
      postedToIframe,
      __connectPort(nonce) {
        channel = new MessageChannel();
        channel.port1.onmessage = (ev) => postedToIframe.push(ev.data);
        channel.port1.start();
        for (const fn of [...windowListeners]) {
          fn({
            data: { type: 'card:connect', nonce },
            source: iframe.contentWindow,
            ports: [channel.port2]
          });
        }
      },
      simulatePostMessage(data) {
        if (channel) {
          channel.port1.postMessage({ timeoutMs: 60000, ...data });
          return;
        }
        // 未注册的 iframe 只发裸 window 消息，必须被拒绝
        for (const fn of [...windowListeners]) {
          fn({
            data,
            source: iframe.contentWindow,
            ports: []
          });
        }
      }
    };
    return iframe;
  }

  return {
    fakeWindow,
    apiCalls,
    apiHandler,
    createMockIframe
  };
}

/* ---- 测试用例 ---- */

await t('1. 伪造 source：未注册或未知的 iframe 发来的请求必须被完全忽略', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write', 'tools.run'] })
  });

  const registeredIframe = env.createMockIframe();
  bridge.register(registeredIframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  const unknownIframe = env.createMockIframe();
  unknownIframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_unknown',
    capability: 'host.capabilities',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 10));

  assert.equal(unknownIframe.postedToIframe.length, 0, '未注册的 iframe 不应收到任何响应');
  assert.equal(env.apiCalls.length, 0, '不应向宿主发任何请求');
});

await t('2. identity / session 覆盖防御：iframe 企图伪造 sessionId/cardEntityId 时，强制使用 parent 冻结 context', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write', 'tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:trusted-id',
    cardId: 'trusted-id',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/path/to/sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_steal',
    capability: 'state.get',
    payload: {
      sessionId: 'malicious-sess-999',
      cardEntityId: 'chat-card:victim-card'
    }
  });

  await new Promise(r => setTimeout(r, 10));

  assert.equal(env.apiCalls.length, 1);
  const call = env.apiCalls[0];
  assert.equal(call.path, '/api/card-host/state/get');
  assert.equal(call.body.sessionId, 'sess-1');
  assert.equal(call.body.cardEntityId, 'chat-card:trusted-id');
  assert.equal(call.body.sessionPath, '/path/to/sess-1');
});

await t('3. detach / 切 session 确认后不 POST：确认期间会话切换或 iframe detach，绝不发起 POST', async () => {
  const env = createMockHostEnvironment();
  let currentActiveSession = 'sess-1';

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => {
      currentActiveSession = 'sess-other';
      return true;
    },
    getActiveContext: () => ({ sessionId: currentActiveSession, isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_invoke_switch',
    capability: 'tool.invoke',
    payload: { bindingId: 'doWork', input: {} }
  });

  await new Promise(r => setTimeout(r, 20));

  assert.equal(env.apiCalls.length, 0, '确认后发现上下文失效，绝不能发 POST！');
  assert.equal(iframe.postedToIframe.length, 1);
  const resp = iframe.postedToIframe[0];
  assert.equal(resp.ok, false);
  assert.ok(resp.code.includes('CONTEXT'));
});

await t('4. 重放 requestId：去重并返回缓存结果，不重复发送 POST', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  const msg = {
    type: 'card:request',
    requestId: 'req_dup_1',
    capability: 'state.get',
    payload: {}
  };

  iframe.simulatePostMessage(msg);
  await new Promise(r => setTimeout(r, 10));

  assert.equal(env.apiCalls.length, 1);
  assert.equal(iframe.postedToIframe.length, 1);

  iframe.simulatePostMessage(msg);
  await new Promise(r => setTimeout(r, 10));

  assert.equal(env.apiCalls.length, 1, '重复 requestId 不应导致第二次 POST');
  assert.equal(iframe.postedToIframe.length, 2, '第二次应直接命中缓存返回相同响应');
  assert.equal(iframe.postedToIframe[1].requestId, 'req_dup_1');
});

await t('5. 缺 metadata / 权限 caps：缺少 cardId/sourceVersion 或对应 scope 时，capabilities 准确返回 requires_host', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_caps',
    capability: 'host.capabilities',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  const resp = iframe.postedToIframe[0];
  assert.equal(resp.ok, true);
  const caps = resp.result.capabilities;
  assert.equal(caps.state, 'requires_host');
  assert.equal(caps.emit, 'requires_host');
  assert.equal(caps.invoke, 'available');
});

await t('6. state HTTP 200 ok:false 错误透出：宿主返回错误时不乐观伪造成功', async () => {
  const env = createMockHostEnvironment();
  env.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/state/set') {
      return { ok: false, code: 'CARD_HOST_STATE_SCHEMA_VIOLATION', error: 'Invalid schema' };
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_state_set',
    capability: 'state.set',
    payload: { state: { a: 1 } }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  const resp = iframe.postedToIframe[0];
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'CARD_HOST_STATE_SCHEMA_VIOLATION');
  assert.equal(resp.error, 'Invalid schema');
});

await t('7. invoke 拒绝和固定 body：用户拒绝时无 POST，通过时 body 仅含固定合法字段且不包含 client.binding/cardId 误传', async () => {
  const env = createMockHostEnvironment();
  let userAllowed = false;

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => userAllowed,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:trusted-1',
    cardId: 'trusted-1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  // 1. 用户拒绝场景
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_inv_1',
    capability: 'tool.invoke',
    payload: { bindingId: 'deleteFile', input: { path: '/tmp' }, binding: { malicious: true } }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.apiCalls.length, 0, '用户拒绝不应发 POST');
  assert.equal(iframe.postedToIframe[0].ok, false);
  assert.equal(iframe.postedToIframe[0].code, 'CARD_HOST_INVOKE_DENIED');

  // 2. 用户允许场景
  userAllowed = true;
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_inv_2',
    capability: 'tool.invoke',
    payload: { bindingId: 'readFile', input: { path: 'a.txt' }, binding: { exploit: true } }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.apiCalls.length, 1);
  const call = env.apiCalls[0];
  assert.equal(call.path, '/api/card-host/tools/invoke');
  assert.deepEqual(call.body, {
    bindingId: 'readFile',
    input: { path: 'a.txt' },
    cardEntityId: 'chat-card:trusted-1',
    executionSessionId: 'sess-1',
    confirmationSessionId: 'sess-1'
  }, '绝不发送 client.binding 或将 cardId 错误映射为 cardInstanceId');
});

await t('8. emit 确认与执行顺序：禁止 iframe 指定 to，严格 confirm -> prepare -> ticket 顺序', async () => {
  const env = createMockHostEnvironment();
  const callSequence = [];

  env.apiHandler.mockResponse = async (path, body) => {
    callSequence.push({ path, body });
    if (path === '/api/card-host/events/prepare') {
      return { ok: true, result: { submitTicket: 'ticket_abc_999' } };
    }
    if (path === '/api/card-host/events/emit') {
      return { ok: true, accepted: true };
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => {
      callSequence.push({ action: 'user_confirmed' });
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1.0.0',
    sessionId: 'sess-1'
  });

  // 禁止指定 to 其它会话
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_emit_bad_to',
    capability: 'emit',
    payload: { name: 'on_move', payload: { x: 1 }, to: 'other-session' }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  assert.equal(iframe.postedToIframe[0].ok, false);
  assert.equal(iframe.postedToIframe[0].code, 'CARD_EMIT_ROUTE_FORBIDDEN');
  assert.equal(env.apiCalls.length, 0);

  // 正确合法 emit
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_emit_good',
    capability: 'emit',
    payload: { name: 'on_move', payload: { x: 1 } }
  });

  await new Promise(r => setTimeout(r, 20));

  assert.equal(callSequence[0].action, 'user_confirmed', '第1步必须先由用户确认');
  assert.equal(callSequence[1].path, '/api/card-host/events/prepare', '第2步 POST /events/prepare 拿 ticket');
  assert.deepEqual(callSequence[1].body, {
    cardId: '1',
    sessionId: 'sess-1',
    sourceVersion: 'v1.0.0',
    name: 'on_move',
    payload: { x: 1 }
  });
  assert.equal(callSequence[2].path, '/api/card-host/events/emit', '第3步 POST /events/emit 提交 ticket');
  assert.deepEqual(callSequence[2].body, {
    submitTicket: 'ticket_abc_999'
  });
});

await t('9. payload 大小限制防护：emit > 8KiB 与 state > 64KiB 直接拒绝', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  // 超大 emit
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_huge_emit',
    capability: 'emit',
    payload: { name: 'huge', payload: { big: 'x'.repeat(9000) } }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  assert.equal(iframe.postedToIframe[0].ok, false);
  assert.equal(iframe.postedToIframe[0].code, 'CARD_PAYLOAD_TOO_LARGE');

  // 超大 state
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_huge_state',
    capability: 'state.set',
    payload: { state: { big: 'x'.repeat(70000) } }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 2);
  assert.equal(iframe.postedToIframe[1].ok, false);
  assert.equal(iframe.postedToIframe[1].code, 'CARD_PAYLOAD_TOO_LARGE');
  assert.equal(env.apiCalls.length, 0);
});

await t('10. card.js 渲染与沙箱防御：sandbox 仅 allow-scripts，前置注入 meta CSP 与 SDK 脚本', async () => {
  const customHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Business Card</title>
        <script>console.log("business logic");</script>
      </head>
      <body><h1>Content</h1></body>
    </html>
  `;

  const registered = [];
  const unregistered = [];
  const testNonce = 'a'.repeat(64);
  const mockBridge = {
    register: (iframe, ctx) => {
      registered.push({ iframe, ctx, srcdocAtRegister: iframe.srcdoc });
      return { nonce: testNonce };
    },
    unregister: (iframe) => unregistered.push(iframe)
  };
  const testContext = { cardEntityId: 'chat-card:abc', sessionId: 'sess-xyz' };

  const { iframe, dispose } = renderCard(customHtml, {
    title: '安全测试卡片',
    hostBridge: mockBridge,
    context: testContext
  });

  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(iframe.getAttribute('sandbox').includes('allow-same-origin'), false);
  assert.equal(iframe.getAttribute('title'), '安全测试卡片');

  const srcdoc = iframe.srcdoc;
  assert.ok(srcdoc.includes('Content-Security-Policy'));
  assert.ok(srcdoc.includes('default-src \'none\''));
  assert.ok(srcdoc.includes('window.__HANA_CARD_RUNTIME_INSTALLED__'));
  assert.ok(srcdoc.includes(`<meta name="hana-mobile-bridge" content="${testNonce}">`));
  assert.equal(registered[0].srcdocAtRegister, undefined, 'register 必须先于 srcdoc 写入');

  const sdkPos = srcdoc.indexOf('window.__HANA_CARD_RUNTIME_INSTALLED__');
  const businessLogicPos = srcdoc.indexOf('console.log("business logic")');
  assert.ok(sdkPos !== -1 && businessLogicPos !== -1);
  assert.ok(sdkPos < businessLogicPos, 'SDK 脚本必须在业务脚本之前注入');

  assert.equal(registered.length, 1);
  assert.equal(registered[0].iframe, iframe);
  assert.equal(registered[0].ctx, testContext);

  dispose();
  assert.equal(unregistered.length, 1);
  assert.equal(unregistered[0], iframe);
});

await t('11. card.js renderCardByPath 支持 hostBridge 注册与 dispose', async () => {
  const registered = [];
  const unregistered = [];
  const testNonce = 'b'.repeat(64);
  const mockBridge = {
    register: (iframe, ctx) => {
      registered.push({ iframe, ctx, srcAtRegister: iframe.src });
      return { nonce: testNonce };
    },
    unregister: (iframe) => unregistered.push(iframe)
  };
  const testContext = { cardEntityId: 'chat-card:dir-1', sessionId: 'sess-1' };

  const { iframe, dispose } = renderCardByPath('D:/workspace/cards/demo', {
    title: '目录卡片',
    hostBridge: mockBridge,
    context: testContext
  });

  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.ok(iframe.src.startsWith('/gw/card/'));
  assert.ok(iframe.src.includes(`#hana-mobile-bridge=${testNonce}`), 'path 卡片 nonce 必须经 fragment 注入');
  assert.equal(registered[0].srcAtRegister, undefined, 'register 必须先于 src 写入');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].iframe, iframe);
  assert.equal(registered[0].ctx, testContext);

  dispose();
  assert.equal(unregistered.length, 1);
  assert.equal(unregistered[0], iframe);

  const second = renderCardByPath('D:/workspace/cards/demo', {
    title: 'token 卡片',
    hostBridge: mockBridge,
    context: testContext,
    sourceUrl: 'http://localhost/gw/card/abc/token/'
  });
  assert.ok(second.iframe.src.includes('/gw/card/abc/token/#hana-mobile-bridge=' + testNonce), 'sourceUrl 必须保留 token 并追加 nonce fragment');
  second.dispose();
  assert.equal(unregistered.length, 2);
});

await t('12. 跨卡片隔离：卡片 A 与卡片 B 使用相同 requestId，结果互不共享且互不抑制', async () => {
  const env = createMockHostEnvironment();
  env.apiHandler.mockResponse = async (path, body) => {
    if (path === '/api/card-host/state/get') {
      if (body.cardEntityId === 'chat-card:card-A') {
        return { ok: true, result: { state: { secret: 'secret-A' } } };
      }
      if (body.cardEntityId === 'chat-card:card-B') {
        return { ok: true, result: { state: { secret: 'secret-B' } } };
      }
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write', 'tools.run', 'studio.owner'] })
  });

  const iframeA = env.createMockIframe();
  const iframeB = env.createMockIframe();

  bridge.register(iframeA, {
    cardEntityId: 'chat-card:card-A',
    cardId: 'card-A',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });
  bridge.register(iframeB, {
    cardEntityId: 'chat-card:card-B',
    cardId: 'card-B',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframeA.simulatePostMessage({
    type: 'card:request',
    requestId: 'shared_collision_id',
    capability: 'state.get',
    payload: {}
  });

  iframeB.simulatePostMessage({
    type: 'card:request',
    requestId: 'shared_collision_id',
    capability: 'state.get',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 20));

  assert.equal(iframeA.postedToIframe.length, 1, '卡片 A 应收到自身结果');
  assert.equal(iframeB.postedToIframe.length, 1, '卡片 B 应收到自身结果且不被 A 的 requestId 抑制');

  const resA = iframeA.postedToIframe[0];
  const resB = iframeB.postedToIframe[0];

  assert.equal(resA.result.state.secret, 'secret-A');
  assert.equal(resB.result.state.secret, 'secret-B');
});

await t('13. 严格 fail-closed：缺 confirmAction、confirmAction 抛错或返回非 true 均拒绝且无 POST', async () => {
  const env = createMockHostEnvironment();

  const bridgeNoConfirm = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });

  const iframe1 = env.createMockIframe();
  bridgeNoConfirm.register(iframe1, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe1.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_no_confirm',
    capability: 'tool.invoke',
    payload: { bindingId: 'testTool', input: {} }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.apiCalls.length, 0, '缺省 confirmAction 坚决不能发 POST');
  assert.equal(iframe1.postedToIframe[0].ok, false);

  const bridgeThrow = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => { throw new Error('UI modal crash'); },
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });

  const iframe2 = env.createMockIframe();
  bridgeThrow.register(iframe2, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe2.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_throw_confirm',
    capability: 'tool.invoke',
    payload: { bindingId: 'testTool', input: {} }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.apiCalls.length, 0, 'confirmAction 抛错坚决不能发 POST');
  assert.equal(iframe2.postedToIframe[0].ok, false);
});

await t('14. getActiveContext 严格 fail-closed：缺失、isVisible!==true 或 sessionId 不符均拒绝且无 POST', async () => {
  const env = createMockHostEnvironment();

  const bridgeNoCtx = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getPrincipal: () => ({ scopes: ['sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridgeNoCtx.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_no_act_ctx',
    capability: 'emit',
    payload: { name: 'ping', payload: {} }
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(env.apiCalls.length, 0, '缺失 getActiveContext 必须 fail-closed 无 POST');
  assert.equal(iframe.postedToIframe[0].ok, false);
});

await t('15. 竞态防御：在 confirm pending 或 prepare pending 期间卡片 unregister/clear/切会话，阻断后续 POST', async () => {
  const env = createMockHostEnvironment();
  let triggerUnregister = null;

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => {
      if (triggerUnregister) triggerUnregister();
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run', 'sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  triggerUnregister = () => {
    bridge.unregister(iframe);
  };

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_pending_unregister',
    capability: 'tool.invoke',
    payload: { bindingId: 'action', input: {} }
  });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(env.apiCalls.length, 0, '旧 await 恢复时检测到已 unregister，绝不发 POST');
});

await t('16. 真实宿主 state 接口返回格式解构：正确 unwrap { ok: true, result: { state, seeded } }', async () => {
  const env = createMockHostEnvironment();
  env.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/state/get') {
      return {
        ok: true,
        result: {
          state: { counter: 42, theme: 'dark' },
          seeded: false
        }
      };
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write', 'chat'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_real_state',
    capability: 'state.get',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  const resp = iframe.postedToIframe[0];
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.result.state, { counter: 42, theme: 'dark' });
});

await t('17. 实体正则与严格权限：不合法 cardEntityId 或缺少 chat/studio 权限时真实 disabled', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    // 只有 sessions.read，缺少 chat 权限
    getPrincipal: () => ({ scopes: ['sessions.read'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'invalid-entity-id-without-prefix',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_check_caps',
    capability: 'host.capabilities',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  const caps = iframe.postedToIframe[0].result.capabilities;
  assert.equal(caps.state, 'requires_host');
  assert.equal(caps.invoke, 'requires_host');
  assert.equal(caps.track.status, 'requires_host');
});

await t('18. 恶意 HTML 绕过防御：script 早于 head 或注释中包含假 head，受控 meta CSP 与 SDK 永远最优先', async () => {
  const maliciousHtml = `
    <!-- <head> 恶意假head注释 </head> -->
    <script src="https://evil.com/leak.js"></script>
    <html>
      <head>
        <title>Malicious</title>
      </head>
      <body>Payload</body>
    </html>
  `;

  const { iframe } = renderCard(maliciousHtml, { title: '防御测试' });
  const srcdoc = iframe.srcdoc;

  const cspIndex = srcdoc.indexOf('Content-Security-Policy');
  const sdkIndex = srcdoc.indexOf('window.__HANA_CARD_RUNTIME_INSTALLED__');
  const evilScriptIndex = srcdoc.indexOf('https://evil.com/leak.js');

  assert.ok(cspIndex !== -1, 'CSP 必须存在');
  assert.ok(sdkIndex !== -1, 'SDK 必须存在');
  assert.ok(evilScriptIndex !== -1, '不可信内容依然作为内容渲染');

  assert.ok(cspIndex < evilScriptIndex, 'CSP 必须先于恶意脚本');
  assert.ok(sdkIndex < evilScriptIndex, 'SDK 必须先于恶意脚本');

  assert.ok(srcdoc.includes("base-uri 'none'"));
  assert.ok(srcdoc.includes("form-action 'none'"));
  assert.ok(srcdoc.includes("object-src 'none'"));
  assert.ok(srcdoc.includes("frame-src 'none'"));
  assert.ok(srcdoc.includes("connect-src 'none'"));
});

await t('19. chat 隐式派生 sessions.read/write：典型 password scopes 开启 state 与 emit', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    // 典型 password scopes：拥有 chat, studio.owner, tools.run
    getPrincipal: () => ({ scopes: ['chat', 'studio.owner', 'tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1.0.0',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_chat_caps',
    capability: 'host.capabilities',
    payload: {}
  });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(iframe.postedToIframe.length, 1);
  const caps = iframe.postedToIframe[0].result.capabilities;
  assert.equal(caps.state, 'available', 'chat 派生了 sessions.read/write，state 应为 available');
  assert.equal(caps.emit, 'available', 'chat 派生了 sessions.write，emit 应为 available');
  assert.equal(caps.invoke, 'available');
  assert.equal(caps.track.status, 'available');
});

await t('20. 同 frame 单副作用互斥锁：同一时刻只允许一个 invoke/emit，并发请求返回 CARD_ACTION_BUSY', async () => {
  const env = createMockHostEnvironment();
  let releaseFirstConfirm;
  const firstConfirmPromise = new Promise(resolve => { releaseFirstConfirm = resolve; });

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async ({ title, message }) => {
      if ((title && title.includes('tool-1')) || (message && message.includes('tool-1'))) {
        await firstConfirmPromise;
        return true;
      }
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['chat', 'tools.run', 'studio.owner'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:1',
    cardId: '1',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  // 第一个 action 挂起在 confirm 中
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_action_1',
    capability: 'tool.invoke',
    payload: { bindingId: 'tool-1', input: {} }
  });

  await new Promise(r => setTimeout(r, 10));

  // 第二个 action 立即发出（不同 requestId）
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_action_2',
    capability: 'emit',
    payload: { name: 'move', payload: {} }
  });

  await new Promise(r => setTimeout(r, 10));

  // 第二个请求应直接被互斥锁拒绝
  assert.equal(iframe.postedToIframe.length, 1);
  const resp2 = iframe.postedToIframe[0];
  assert.equal(resp2.requestId, 'req_action_2');
  assert.equal(resp2.ok, false);
  assert.equal(resp2.code, 'CARD_ACTION_BUSY');

  // 释放第一个 action
  releaseFirstConfirm();
  await new Promise(r => setTimeout(r, 20));

  // 第一个请求成功完成
  assert.equal(iframe.postedToIframe.length, 2);
  const resp1 = iframe.postedToIframe[1];
  assert.equal(resp1.requestId, 'req_action_1');
  assert.equal(resp1.ok, true);
});

await t('21. handleHostConfirmation 宿主第二道确认：匹配 pending invoke 并 POST /api/confirm', async () => {
  const env = createMockHostEnvironment();
  let releaseInvokeApi;
  const invokeApiPromise = new Promise(resolve => { releaseInvokeApi = resolve; });

  env.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/tools/invoke') {
      await invokeApiPromise;
      return { ok: true, result: { invoked: 'final_tool_output' } };
    }
    if (path.startsWith('/api/confirm/')) {
      return { ok: true };
    }
  };

  const confirmedTitles = [];
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async ({ title }) => {
      confirmedTitles.push(title);
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', sessionPath: '/path/sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['chat', 'tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:target-card',
    cardId: 'target-card',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/path/sess-1'
  });

  // 启动 invoke，等待宿主返回（此时处于 pending invoke 状态）
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_inv_2_step',
    capability: 'tool.invoke',
    payload: { bindingId: 'terminalRun', input: { cmd: 'ls' } }
  });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(confirmedTitles.length, 1, '第1道：parent pre-confirm 已执行');

  // 宿主通过 WS 推送第二道 card_host_confirm 事件
  const hostEvent = {
    type: 'content_block',
    sessionId: 'sess-1',
    sessionPath: '/path/sess-1',
    block: {
      type: 'card_host_confirm',
      confirmId: 'conf_xyz_777',
      cardEntityId: 'chat-card:target-card',
      cardTitle: '代码终端卡片',
      grantKind: 'command.run',
      subject: 'ls',
      toolName: 'terminal',
      params: { cmd: 'ls' },
      combinationWarning: '此命令将访问宿主终端',
      status: 'pending'
    }
  };

  await bridge.handleHostConfirmation(hostEvent);

  assert.equal(confirmedTitles.length, 2, '第2道：host confirmation 必须独立弹出确认');
  const confirmPost = env.apiCalls.find(c => c.path === '/api/confirm/conf_xyz_777');
  assert.ok(confirmPost, '必须向 /api/confirm/conf_xyz_777 发送 POST');
  assert.deepEqual(confirmPost.body, { action: 'confirmed' });

  // 释放 invoke API
  releaseInvokeApi();
  await new Promise(r => setTimeout(r, 20));

  const invokeResp = iframe.postedToIframe.find(m => m.requestId === 'req_inv_2_step');
  assert.ok(invokeResp);
  assert.equal(invokeResp.ok, true);
  assert.equal(invokeResp.result.invoked, 'final_tool_output');
});

await t('22. handleHostConfirmation 防御：用户拒绝时 POST rejected、跨会话忽略、防重复 confirmId、注销后不放行', async () => {
  const env = createMockHostEnvironment();
  let userApprovedSecond = false;
  let triggerUnregisterDuringConfirm = false;

  let releaseInvokeApi22;
  const invokeApiPromise22 = new Promise(resolve => { releaseInvokeApi22 = resolve; });

  env.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/tools/invoke') {
      await invokeApiPromise22;
      return { ok: true, result: { invoked: true } };
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async ({ title }) => {
      if (title.includes('宿主工具权限确认')) {
        if (triggerUnregisterDuringConfirm) {
          bridge.unregister(iframe);
        }
        return userApprovedSecond;
      }
      return true;
    },
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['chat', 'tools.run'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:card-X',
    cardId: 'card-X',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  // 启动 invoke，让其保持在 pending 状态
  iframe.simulatePostMessage({
    type: 'card:request',
    requestId: 'req_inv_refuse',
    capability: 'tool.invoke',
    payload: { bindingId: 'tool-x', input: {} }
  });
  await new Promise(r => setTimeout(r, 10));

  // 1. 跨会话推送：事件属于 sess-other，必须忽略
  const crossSessionEvent = {
    type: 'content_block',
    sessionId: 'sess-other',
    block: {
      type: 'card_host_confirm',
      confirmId: 'conf_cross_1',
      cardEntityId: 'chat-card:card-X',
      status: 'pending'
    }
  };
  await bridge.handleHostConfirmation(crossSessionEvent);
  assert.ok(!env.apiCalls.some(c => c.path.includes('conf_cross_1')), '跨会话事件不应触发任何 POST');

  // 2. 用户第二道拒绝：发送 rejected
  userApprovedSecond = false;
  const legitEvent = {
    type: 'content_block',
    sessionId: 'sess-1',
    block: {
      type: 'card_host_confirm',
      confirmId: 'conf_refused_1',
      cardEntityId: 'chat-card:card-X',
      status: 'pending'
    }
  };
  await bridge.handleHostConfirmation(legitEvent);
  const rejectPost = env.apiCalls.find(c => c.path === '/api/confirm/conf_refused_1');
  assert.ok(rejectPost, '拒绝时必须 POST rejected');
  assert.deepEqual(rejectPost.body, { action: 'rejected' });

  // 3. 重复 confirmId 必须忽略
  await bridge.handleHostConfirmation(legitEvent);
  const countRefused = env.apiCalls.filter(c => c.path === '/api/confirm/conf_refused_1').length;
  assert.equal(countRefused, 1, '重复的 confirmId 绝不二次 POST');

  releaseInvokeApi22();
});

await t('23. handleHostDataChanged 全局广播：精确匹配实体，受限数据大小，严格权限与生命周期防护', async () => {
  const env = createMockHostEnvironment();
  let currentScopes = ['chat', 'studio.owner'];

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: currentScopes })
  });

  const iframeA = env.createMockIframe();
  const iframeB = env.createMockIframe();
  const iframeUnregistered = env.createMockIframe();

  bridge.register(iframeA, {
    cardEntityId: 'chat-card:target-doc',
    cardId: 'doc-a',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  bridge.register(iframeB, {
    cardEntityId: 'chat-card:other-doc',
    cardId: 'doc-b',
    sourceVersion: 'v1',
    sessionId: 'sess-2'
  });

  bridge.register(iframeUnregistered, {
    cardEntityId: 'chat-card:target-doc',
    cardId: 'doc-unreg',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });
  bridge.unregister(iframeUnregistered);

  const testDoc = { score: 99, status: 'updated' };
  const legitAppEvent = {
    type: 'app_event',
    event: {
      type: 'card-data-changed',
      payload: {
        cardEntityId: 'chat-card:target-doc',
        data: testDoc
      },
      source: 'server'
    }
  };

  // 1. 正常广播给匹配实体
  const resSuccess = bridge.handleHostDataChanged(legitAppEvent);
  assert.equal(resSuccess, true);
  await new Promise(r => setTimeout(r, 30));

  assert.equal(iframeA.postedToIframe.length, 1, '实体相同的卡片 A 必须收到广播');
  assert.deepEqual(iframeA.postedToIframe[0], {
    type: 'hana.card-data-changed',
    data: testDoc
  });

  assert.equal(iframeB.postedToIframe.length, 0, '不同实体的卡片 B 绝不能收到广播');
  assert.equal(iframeUnregistered.postedToIframe.length, 0, '已注销的卡片绝不能收到广播');

  // 2. 伪造非 app_event 或来源不符
  const fakeEvent1 = { type: 'content_block', event: legitAppEvent.event };
  const fakeEvent2 = { type: 'app_event', event: { ...legitAppEvent.event, source: 'client' } };
  const fakeEvent3 = { type: 'app_event', event: { ...legitAppEvent.event, type: 'other_event' } };

  assert.equal(bridge.handleHostDataChanged(fakeEvent1), false);
  assert.equal(bridge.handleHostDataChanged(fakeEvent2), false);
  assert.equal(bridge.handleHostDataChanged(fakeEvent3), false);

  // 3. 无 studio.owner 权限不广播
  currentScopes = ['chat']; // 缺少 studio.owner
  const resNoScope = bridge.handleHostDataChanged(legitAppEvent);
  assert.equal(resNoScope, false, '无 studio.owner 权限不得广播');

  // 恢复权限
  currentScopes = ['chat', 'studio.owner'];

  // 4. 超大对象数据 (>256KiB) 返回 false 且不广播
  const hugeDoc = { big: 'x'.repeat(270000) };
  const hugeAppEvent = {
    type: 'app_event',
    event: {
      type: 'card-data-changed',
      payload: {
        cardEntityId: 'chat-card:target-doc',
        data: hugeDoc
      },
      source: 'server'
    }
  };
  const resHuge = bridge.handleHostDataChanged(hugeAppEvent);
  assert.equal(resHuge, false, '超大对象数据必须拒绝广播');
  assert.equal(iframeA.postedToIframe.length, 1, '超大对象不应推送到 iframe');
});

await t('24. studio 命名空间不能冒充 studio.owner：track/data 缺少精确 owner 时零 POST', async () => {
  const env = createMockHostEnvironment();
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['chat', 'studio', 'tools.run', 'sessions.read', 'sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:scope-doc',
    cardId: 'scope-doc',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_track_scope', capability: 'track',
    payload: { name: 'viewed', payload: {} }
  });
  iframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_data_scope', capability: 'data.get',
    payload: {}
  });
  await new Promise(r => setTimeout(r, 30));

  assert.equal(env.apiCalls.length, 0, 'track/data 在无 studio.owner 时不得调用 API');
  const trackResp = iframe.postedToIframe.find(m => m.requestId === 'req_track_scope');
  const dataResp = iframe.postedToIframe.find(m => m.requestId === 'req_data_scope');
  assert.equal(trackResp?.code, 'CARD_HOST_FORBIDDEN');
  assert.equal(dataResp?.code, 'CARD_HOST_FORBIDDEN');
});

await t('25. invoke 输入预算与超大响应：超限不进入确认/API，超大结果不缓存', async () => {
  const env = createMockHostEnvironment();
  let confirmCalls = 0;
  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => { confirmCalls += 1; return true; },
    getActiveContext: () => ({ sessionId: 'sess-1', path: '/sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run', 'sessions.read', 'sessions.write'] })
  });

  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:budget-doc',
    cardId: 'budget-doc',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/sess-1'
  });

  iframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_binding_long', capability: 'tool.invoke',
    payload: { bindingId: 'b'.repeat(129), input: {} }
  });
  iframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_input_huge', capability: 'tool.invoke',
    payload: { bindingId: 'tool-x', input: { text: 'x'.repeat(70000) } }
  });
  await new Promise(r => setTimeout(r, 30));

  assert.equal(confirmCalls, 0, '超限 invoke 不得进入用户确认');
  assert.equal(env.apiCalls.length, 0, '超限 invoke 不得调用宿主 API');
  assert.equal(iframe.postedToIframe.find(m => m.requestId === 'req_binding_long')?.code, 'CARD_HOST_TOOL_BINDING_ID_INVALID');
  assert.equal(iframe.postedToIframe.find(m => m.requestId === 'req_input_huge')?.code, 'CARD_INVOKE_INPUT_TOO_LARGE');

  const hugeEnv = createMockHostEnvironment();
  hugeEnv.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/state/get') {
      return { ok: true, result: { state: { big: 'y'.repeat(300000) } } };
    }
    return undefined;
  };
  const hugeBridge = createCardBridge({
    api: hugeEnv.apiHandler,
    window: hugeEnv.fakeWindow,
    getActiveContext: () => ({ sessionId: 'sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['sessions.read', 'sessions.write'] })
  });
  const hugeIframe = hugeEnv.createMockIframe();
  hugeBridge.register(hugeIframe, {
    cardEntityId: 'chat-card:huge-doc',
    cardId: 'huge-doc',
    sourceVersion: 'v1',
    sessionId: 'sess-1'
  });
  hugeIframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_huge_state', capability: 'state.get', payload: {}
  });
  await new Promise(r => setTimeout(r, 30));
  const hugeResp = hugeIframe.postedToIframe.find(m => m.requestId === 'req_huge_state');
  assert.equal(hugeResp?.code, 'CARD_RESPONSE_TOO_LARGE');
});

await t('26. 宿主确认 HTTP 200 ok:false 必须抛错；已完成的 pendingInvoke 不可被旧确认放行', async () => {
  const env = createMockHostEnvironment();
  let releaseInvoke;
  const invokePromise = new Promise(resolve => { releaseInvoke = resolve; });
  env.apiHandler.mockResponse = async (path) => {
    if (path === '/api/card-host/tools/invoke') {
      await invokePromise;
      return { ok: true, result: { invoked: true } };
    }
    if (path.startsWith('/api/confirm/')) {
      return { ok: false, error: 'host refused confirmation' };
    }
  };

  const bridge = createCardBridge({
    api: env.apiHandler,
    window: env.fakeWindow,
    confirmAction: async () => true,
    getActiveContext: () => ({ sessionId: 'sess-1', sessionPath: '/sess-1', isVisible: true }),
    getPrincipal: () => ({ scopes: ['tools.run'] })
  });
  const iframe = env.createMockIframe();
  bridge.register(iframe, {
    cardEntityId: 'chat-card:confirm-doc',
    cardId: 'confirm-doc',
    sourceVersion: 'v1',
    sessionId: 'sess-1',
    sessionPath: '/sess-1'
  });
  iframe.simulatePostMessage({
    type: 'card:request', requestId: 'req_confirm_okfalse', capability: 'tool.invoke',
    payload: { bindingId: 'tool-x', input: {} }
  });
  await new Promise(r => setTimeout(r, 20));

  const hostEvent = {
    type: 'content_block',
    sessionId: 'sess-1',
    sessionPath: '/sess-1',
    block: {
      type: 'card_host_confirm',
      confirmId: 'conf_ok_false',
      cardEntityId: 'chat-card:confirm-doc',
      status: 'pending'
    }
  };
  await assert.rejects(() => bridge.handleHostConfirmation(hostEvent), /host refused confirmation/);

  releaseInvoke();
  await new Promise(r => setTimeout(r, 30));
  // 已完成 invoke 后再来旧 confirmId，不得再次 POST confirmed
  await bridge.handleHostConfirmation({ ...hostEvent, block: { ...hostEvent.block, confirmId: 'conf_after_done' } });
  assert.ok(!env.apiCalls.some(c => c.path === '/api/confirm/conf_after_done'), '已完成 invoke 不得被旧确认放行');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll card bridge tests passed.');
  process.exit(0);
}
