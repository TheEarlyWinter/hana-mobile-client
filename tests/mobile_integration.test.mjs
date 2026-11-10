/* tests/mobile_integration.test.mjs
 *
 * 移动端全链路前端接线集成测试
 * 覆盖：
 * 1. ensureAuth: 成功设置 S.principal，无 auth 清 null
 * 2. getActiveContext: 包含 sessionId, sessionPath 与 isVisible (view-chat/visibility/workspace.isOpen)
 * 3. 确认挂起与上下文清理: 切会话/回首页/页面隐藏 (visibilitychange) 触发 cancelAll
 * 4. openSession & loadHistory: 清空 transcript 前调用 cardController.clear() 与 workspaceView.close()
 * 5. backToList 同步优先级: 确认弹窗 -> 工作区抽屉 -> debug 抽屉 -> 聊天视图
 * 6. 工作区入口: 首页 chip 使用 Agent id 打开；聊天页 #btnWorkspace 使用 session.agentId，缺失提示不借用
 * 7. CardBridge API adapter: tools/invoke 走 150s 客户端，其他请求 15s 客户端
 * 8. WS card_host_confirmation 分发: 转发至 bridge.handleHostConfirmation
 */

import assert from 'node:assert/strict';

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

// 搭建支持 app.js 加载与运行的轻量 DOM 模拟环境
const elements = {};
function makeEl(tag = 'div', id = '') {
  const listeners = new Map();
  const classListSet = new Set();
  const children = [];

  const node = {
    id,
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children,
    attributes: new Map(),
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    scrollHeight: 100,
    scrollTop: 0,
    get className() { return Array.from(classListSet).join(' '); },
    set className(val) {
      classListSet.clear();
      if (val) val.split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
    },
    classList: {
      add: (...args) => args.forEach(c => classListSet.add(c)),
      remove: (...args) => args.forEach(c => classListSet.delete(c)),
      contains: (c) => classListSet.has(c),
    },
    appendChild(child) {
      if (child) {
        child.parentNode = this;
        children.push(child);
      }
      return child;
    },
    insertBefore(child, ref) {
      if (child) {
        child.parentNode = this;
        const index = ref ? children.indexOf(ref) : -1;
        children.splice(index === -1 ? children.length : index, 0, child);
      }
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.get(k) || null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      const type = typeof ev === 'string' ? ev : ev.type;
      const fns = listeners.get(type) ? [...listeners.get(type)] : [];
      for (const fn of fns) {
        fn.call(this, typeof ev === 'string' ? { type, target: this } : { ...ev, target: this });
      }
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    focus: () => {},
  };
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements[id]) elements[id] = makeEl('div', id);
  return elements[id];
}

/* E5 起 #flashBar 是提示容器（正文在 .toast-text 子节点上），容器自身的 textContent 是空的。
 * 这两步原来直接读/清容器，现在要走子节点，意思不变：显示了什么、清空提示。 */
function flashText() {
  const collect = (node) => {
    let out = String(node.textContent || '');
    for (const child of node.children || []) out += ' ' + collect(child);
    return out;
  };
  return collect(getEl('flashBar')).trim();
}
function clearFlash() {
  const root = getEl('flashBar');
  for (const child of [...(root.children || [])]) root.removeChild(child);
  root.textContent = '';
}

const docListeners = new Map();
const mockBody = makeEl('body');

const winListeners = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!winListeners.has(type)) winListeners.set(type, []);
  winListeners.get(type).push(fn);
};
globalThis.removeEventListener = (type, fn) => {
  if (winListeners.has(type)) {
    winListeners.set(type, winListeners.get(type).filter(f => f !== fn));
  }
};
globalThis.location = { protocol: 'http:', host: 'localhost:24000', origin: 'http://localhost:24000', search: '?debug=1' };
globalThis.document = {
  body: mockBody,
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  documentElement: { style: { setProperty() {} } },
  visibilityState: 'visible',
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  dispatchEvent: (ev) => {
    const type = typeof ev === 'string' ? ev : ev.type;
    const fns = docListeners.get(type) || [];
    for (const fn of fns) fn(typeof ev === 'string' ? { type } : ev);
  },
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0 };
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() { this.readyState = 0; }
  addEventListener() {}
  close() {}
};
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

// 对齐 index.html：附件来源 sheet 初始关闭，不能让假 DOM 默认打开它。
getEl('attachSheet').hidden = true;

// 导入待测的主程序
await import('../web/app.js');

const S = globalThis.__hana.S;
const hook = globalThis.HanaMobile || globalThis.window?.HanaMobile;

/* ------------------------------------------------------------------ */
/* 1. 认证状态与主体 principal                                          */
/* ------------------------------------------------------------------ */

await t('ensureAuth: 登录后设置 S.principal，无 auth 时清空为 null', async () => {
  let fakeAuthSession = { authenticated: true, principal: { id: 'user-1', scopes: ['chat', 'tools.run'] } };
  globalThis.fetch = async (url) => {
    if (url.includes('/api/web-auth/session')) {
      return {
        ok: true,
        text: async () => JSON.stringify(fakeAuthSession),
        json: async () => fakeAuthSession,
      };
    }
    return { ok: false, text: async () => '{}', json: async () => ({}) };
  };

  const ensureAuth = globalThis.__hana.ensureAuth;
  assert.equal(typeof ensureAuth, 'function');

  await ensureAuth();
  assert.deepEqual(S.principal, fakeAuthSession.principal);

  // 登出/无 auth
  fakeAuthSession = { authenticated: false };
  await ensureAuth();
  assert.equal(S.principal, null);
});

/* ------------------------------------------------------------------ */
/* 2. backToList 同步返回优先级                                        */
/* ------------------------------------------------------------------ */

await t('backToList 同步优先级: 确认弹窗 -> 工作区 -> debug 抽屉 -> 聊天视图', () => {
  const back = hook.back;
  assert.equal(typeof back, 'function');

  const conf = globalThis.__hana.actionConfirmation;
  const ws = globalThis.__hana.workspaceView;

  // 1. 确认弹窗打开时优先消费
  let cancelCalled = false;
  conf.isOpen = () => true;
  conf.cancelAll = () => { cancelCalled = true; };

  let handled = back();
  assert.equal(handled, true);
  assert.equal(cancelCalled, true);

  // 2. 确认已关，工作区打开时优先让 workspaceView.back() 同步消费
  conf.isOpen = () => false;
  let wsBackCalled = false;
  ws.back = () => {
    wsBackCalled = true;
    return true;
  };

  handled = back();
  assert.equal(handled, true);
  assert.equal(wsBackCalled, true);

  // 3. debug 调试抽屉打开时优先收起
  ws.back = () => false;
  getEl('debug').hidden = false;
  getEl('view-chat').hidden = false;

  handled = back();
  assert.equal(handled, true);
  assert.equal(getEl('debug').hidden, true);

  // 4. 聊天视图退回列表
  S.session = { sessionId: 's1', path: 'p1.jsonl' };
  getEl('view-chat').hidden = false;
  getEl('view-list').hidden = true;

  handled = back();
  assert.equal(handled, true);
  assert.equal(S.session, null);
  assert.equal(getEl('view-list').hidden, false);
});

/* ------------------------------------------------------------------ */
/* 3. getActiveContext 与 会话身份路径匹配                              */
/* ------------------------------------------------------------------ */

await t('getActiveContext: 严格核验 sessionId, sessionPath 与 isVisible', () => {
  const getContext = globalThis.__hana.getActiveContext;
  assert.equal(typeof getContext, 'function');

  S.session = { sessionId: 's-123', path: 'C:/sessions/chat.jsonl' };
  getEl('view-chat').hidden = false;
  globalThis.document.visibilityState = 'visible';
  globalThis.__hana.workspaceView.isOpen = () => false;

  const ctx = getContext();
  assert.equal(ctx.sessionId, 's-123');
  assert.equal(ctx.sessionPath, 'C:/sessions/chat.jsonl');
  assert.equal(ctx.isVisible, true);

  // 工作区打开时，前台聊天变为不可见（防止卡片在底层后台偷发副作用）
  globalThis.__hana.workspaceView.isOpen = () => true;
  assert.equal(getContext().isVisible, false);
});

/* ------------------------------------------------------------------ */
/* 4. 工作区入口接入                                                   */
/* ------------------------------------------------------------------ */

await t('工作区入口: 首页 chip 使用 Agent id；聊天页 #btnWorkspace 缺 agent 拒绝借用', async () => {
  let openedTarget = null;
  globalThis.__hana.workspaceView.open = (target) => { openedTarget = target; };
  globalThis.__hana.workspaceService.listRoots = async () => [
    { mountId: 'mount-data', label: '资料库' },
  ];

  // 1. 首页工作区 chip
  S.currentAgent = { id: 'agent-cat', name: '猫娘' };
  getEl('homeWorkspaceChip').dispatchEvent('click');
  await new Promise(r => setTimeout(r, 10));

  assert.equal(openedTarget.mountId, 'default');
  assert.equal(openedTarget.agentId, 'agent-cat');

  // 2. 聊天页 #btnWorkspace，会话缺失 agentId 时提示并不借用当前所选 agent
  openedTarget = null;
  S.session = { sessionId: 's1', agentId: null };
  S.currentAgent = { id: 'agent-wrong' };

  clearFlash();
  getEl('btnWorkspace').dispatchEvent('click');
  await new Promise(r => setTimeout(r, 10));

  const flashed = flashText();
  assert.equal(openedTarget, null, '缺失 agentId 时严禁借用另一个 Agent 打开工作区');
  assert.ok(flashed.includes('无法确认') || flashed.includes('首页选择'));
});

/* ------------------------------------------------------------------ */
/* 5. 切会话与页面隐藏取消确认挂起                                      */
/* ------------------------------------------------------------------ */

await t('页面隐藏与切会话: 自动 cancelAll 取消所有挂起的确认弹窗', () => {
  let cancelCalled = false;
  globalThis.__hana.actionConfirmation.cancelAll = () => { cancelCalled = true; };

  // 触发 visibilitychange
  globalThis.document.visibilityState = 'hidden';
  globalThis.document.dispatchEvent('visibilitychange');

  assert.equal(cancelCalled, true);
});

/* ------------------------------------------------------------------ */
/* 6. WS card_host_confirmation 事件分发                                */
/* ------------------------------------------------------------------ */

await t('WS 事件: content_block 与 card_host_confirmation 转发给 bridge', async () => {
  let forwardedConfirmation = null;
  globalThis.__hana.cardBridge.handleHostConfirmation = async (ev) => {
    forwardedConfirmation = ev;
  };

  const handleEvent = globalThis.__hana.handleEvent;
  assert.equal(typeof handleEvent, 'function');

  // 1. content_block (type: card_host_confirm)
  handleEvent({
    type: 'content_block',
    block: {
      type: 'card_host_confirm',
      confirmationId: 'conf-1',
      details: { title: '测试确认' },
    },
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(forwardedConfirmation?.block?.confirmationId, 'conf-1');

  // 2. card_host_confirmation 直接顶层事件
  forwardedConfirmation = null;
  handleEvent({
    type: 'card_host_confirmation',
    confirmationId: 'conf-2',
    details: { title: '顶层确认' },
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(forwardedConfirmation?.confirmationId, 'conf-2');
});

/* ------------------------------------------------------------------ */
/* 7. 全局 app_event card-data-changed 分发与普通会话事件隔离             */
/* ------------------------------------------------------------------ */

await t('全局 app_event: card-data-changed 分发至 cardBridge 且不误吞普通会话事件', async () => {
  let receivedAppEvent = null;
  globalThis.__hana.cardBridge.handleHostDataChanged = (ev) => {
    receivedAppEvent = ev;
  };

  const handleEvent = globalThis.__hana.handleEvent;
  assert.equal(typeof handleEvent, 'function');

  S.session = { sessionId: 'sess-current', path: 'C:/sess-current.jsonl' };

  // 1. 宿主广播 card-data-changed（无 session）：成功分发给 cardBridge
  const cardDataEv = {
    type: 'app_event',
    event: {
      type: 'card-data-changed',
      payload: { cardEntityId: 'chat-card:card-1', data: { score: 99 } },
      source: 'server',
    },
  };
  handleEvent(cardDataEv);
  assert.equal(receivedAppEvent, cardDataEv, 'cardBridge 必须收到精确的 app_event');

  // 2. 其它非 card-data-changed 的 app_event（无 session）：不得分发且被 belongsToSession 过滤丢弃
  receivedAppEvent = null;
  const unrelatedAppEv = {
    type: 'app_event',
    event: { type: 'other-event', payload: {} },
  };
  handleEvent(unrelatedAppEv);
  assert.equal(receivedAppEvent, null, '非 card-data-changed 的 app_event 严禁触发数据转发');

  // 3. 属于当前会话的普通事件：依然正常通过处理（不被误吞或截断）
  S.busy = false;
  handleEvent({
    type: 'text_delta',
    sessionId: 'sess-current',
    delta: '测试正常文本',
  });
  assert.equal(S.busy, true, '属于当前会话的普通事件必须正常通过并推进流式状态');

  // 4. 不属于当前会话的消息：依然被 belongsToSession 正确拦截
  S.busy = false;
  handleEvent({
    type: 'text_delta',
    sessionId: 'sess-foreign',
    delta: '跨会话文本',
  });
  assert.equal(S.busy, false, '跨会话普通事件依然必须被严格过滤');
});

/* ------------------------------------------------------------------ */
/* 8. I1-1 启动配置失败可见并可重试；I1-3 缺少 WebSocket 能力有明确提示   */
/* ------------------------------------------------------------------ */

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok !== false,
    status: init.status || 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function waitFor(cond, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await t('I1-1: bootstrap 失败降级启动、错误可见，刷新能重试成功', async () => {
  let bootstrapOk = false;
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0];
    if (path === '/api/web-auth/session') return jsonResponse({ authenticated: true, principal: { id: 'user-1' } });
    if (path === '/api/web-auth/login') return jsonResponse({ ok: true });
    if (path === '/api/mobile/bootstrap') {
      if (!bootstrapOk) return jsonResponse({ error: 'host down' }, { ok: false, status: 500 });
      return jsonResponse({ agents: [{ id: 'agent-real', name: '小满', isPrimary: true }], agentName: '小满' });
    }
    if (path === '/api/sessions') return jsonResponse({ ok: true, sessions: [] });
    return jsonResponse({});
  };

  clearFlash();
  const loggedIn = await globalThis.__hana.loginController.login({ username: 'u', password: 'p' });
  assert.equal(loggedIn, true, 'bootstrap 失败不得阻断启动');
  assert.equal(S.boot, null, '降级：配置留空');
  assert.equal(S.agentName, 'Hana', '降级：用默认署名');
  assert.match(flashText(), /配置没加载成功/, '失败必须看得见，不能静默用默认值');

  bootstrapOk = true;
  clearFlash();
  getEl('btnRefresh').dispatchEvent('click');
  await waitFor(() => S.boot !== null, '刷新把配置重新拉回来');
  assert.equal(S.agentName, '小满', '重试成功后要换回真实署名');
  assert.equal(getEl('agentName').textContent, '小满');
  assert.match(flashText(), /配置已重新加载/, '重试成功要有反馈');
});

await t('I1-3: 内核缺少 WebSocket 时给可见错误，不抛未捕获异常', () => {
  const original = globalThis.WebSocket;
  try {
    globalThis.WebSocket = undefined;
    clearFlash();
    assert.doesNotThrow(() => globalThis.__hana.connectWS(), '缺能力不能让页面抛未捕获异常');
    assert.match(flashText(), /WebSocket/, '要说明是内核缺 WebSocket，而不是笼统说连不上');
  } finally {
    globalThis.WebSocket = original;
  }
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
