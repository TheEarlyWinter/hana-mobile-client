/* tests/settings_navigation_integration.test.mjs
 *
 * 模型 chip 与会话导航的集成测试：真实 app.js + 真实 conversation-controller +
 * 真实 settings-controller/settings-view，只替换 DOM / fetch / WebSocket。
 *
 * 覆盖（先红后绿的真实业务缺口）：
 * 1. btnNew / btnNewChat 两个新建入口都在打开新会话后刷新模型 chip
 * 2. A 会话慢切模型期间用户打开 B：A 的写成功/失败都不能覆盖 B 的 chip、不能冒旧 flash
 * 3. 写之前发出的 chip GET 晚到，不能盖掉刚写成功的新模型
 * 4. 退出登录后旧身份的在途写回调不能改界面
 * 5. 打开设置时用目标会话自己的 Agent（不是当前 Agent）取模型兜底
 */

import assert from 'node:assert/strict';

let bad = 0;
async function t(name, fn) {
  // 每个用例自己设置 handler；失败也不能漏给下一个用例。
  net.login = null;
  net.logout = null;
  net.holdModels = 0;
  net.pendingModels.length = 0;
  net.switchGate = null;
  net.thinkingGate = null;
  net.modelsResponse = null;
  net.createQueue.length = 0;
  resetFlash();
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await delay(0);
}
async function waitFor(pred, label, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

/* ------------------------------------------------------------------ */
/* DOM 模拟                                                             */
/* ------------------------------------------------------------------ */

const elements = new Map();
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
    _html: '',
    get innerHTML() { return node._html; },
    set innerHTML(val) {
      node._html = String(val == null ? '' : val);
      if (node._html === '') children.length = 0;
    },
    scrollHeight: 100,
    scrollTop: 0,
    get className() { return Array.from(classListSet).join(' '); },
    set className(val) {
      classListSet.clear();
      if (val) val.split(/\s+/).filter(Boolean).forEach((c) => classListSet.add(c));
    },
    classList: {
      add: (...args) => args.forEach((c) => classListSet.add(c)),
      remove: (...args) => args.forEach((c) => classListSet.delete(c)),
      contains: (c) => classListSet.has(c),
    },
    appendChild(child) {
      if (child) { child.parentNode = this; children.push(child); }
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
      if (idx !== -1) { children.splice(idx, 1); child.parentNode = null; }
      return child;
    },
    replaceChildren(...nextChildren) {
      for (const child of [...children]) this.removeChild(child);
      for (const child of nextChildren) {
        if (child?.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
          child.parentNode.removeChild(child);
        }
        this.appendChild(child);
      }
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.get(k) || null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      const type = typeof ev === 'string' ? ev : ev.type;
      const fns = listeners.get(type) ? [...listeners.get(type)] : [];
      for (const fn of fns) fn.call(this, typeof ev === 'string' ? { type, target: this } : { ...ev, target: this });
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    focus: () => {},
  };
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements.has(id)) elements.set(id, makeEl('div', id));
  return elements.get(id);
}

for (const id of ['view-login', 'view-list', 'view-chat', 'settingsContainer']) getEl(id);
// 真实 index.html 里调试抽屉默认 hidden；夹具不预设就会被当成「盖在上面」吃掉返回键。
getEl('debug').hidden = true;

const docListeners = new Map();
const mockBody = makeEl('body');
mockBody.className = 'body';

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
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
    for (const fn of docListeners.get(type) || []) fn(typeof ev === 'string' ? { type } : ev);
  },
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0 };

const wsInstances = [];
globalThis.WebSocket = class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    wsInstances.push(this);
  }
  addEventListener() {}
  close() { this.readyState = MockWebSocket.CLOSED; }
  send(data) { this.sent.push(JSON.parse(String(data))); }
};

/* ------------------------------------------------------------------ */
/* 数据                                                                 */
/* ------------------------------------------------------------------ */

const AGENTS = [
  { id: 'agent-home', name: 'Hakimi', isPrimary: true, chatModel: 'Home Default' },
  { id: 'agent-2', name: 'Second', chatModel: 'model-2' },
];

const MODELS = [
  { id: 'model-a', provider: 'prov', name: 'Model A' },
  { id: 'model-b', provider: 'prov', name: 'Model B' },
  { id: 'model-x', provider: 'prov', name: 'Model X' },
  { id: 'model-y', provider: 'prov', name: 'Model Y' },
  { id: 'model-z', provider: 'prov', name: 'Model Z' },
  { id: 'model-2', provider: 'prov', name: 'Model Two' },
];

const SESSION_A = { path: 'C:/sessions/a.jsonl', sessionId: 'sess-a', title: '会话 A', agentId: 'agent-home', updatedAt: Date.now() };
const SESSION_B = { path: 'C:/sessions/b.jsonl', sessionId: 'sess-b', title: '会话 B', agentId: 'agent-home', updatedAt: Date.now() };
const SESSION_A2 = { path: 'C:/sessions/a2.jsonl', sessionId: 'sess-a2', title: '会话 A2', agentId: 'agent-2', updatedAt: Date.now() };

const MODEL_BY_PATH = new Map([
  [SESSION_A.path, 'model-a'],
  [SESSION_B.path, 'model-b'],
  [SESSION_A2.path, 'model-2'],
  ['C:/sessions/new-1.jsonl', 'model-x'],
  ['C:/sessions/new-2.jsonl', 'model-y'],
]);

function modelsFor(path) {
  const id = MODEL_BY_PATH.get(path) || null;
  const active = MODELS.find((m) => m.id === id) || null;
  return {
    models: MODELS,
    activeModel: active ? { id: active.id, provider: active.provider, name: active.name } : null,
  };
}

/* ------------------------------------------------------------------ */
/* 路由化 fetch                                                         */
/* ------------------------------------------------------------------ */

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : `HTTP ${status}`,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const net = {
  calls: [],
  authenticated: true,
  principal: { id: 'real-user', scopes: [] },
  login: null,
  logout: null,
  sessions: [],
  modelsResponse: null,
  holdModels: 0,
  pendingModels: [],
  switchGate: null,
  switchCalls: [],
  thinkingGate: null,
  thinkingCalls: [],
  createQueue: [],
};

globalThis.fetch = async (url, init = {}) => {
  const full = String(url);
  const [path, query = ''] = full.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const method = String(init.method || 'GET').toUpperCase();
  net.calls.push({ path, query, params, method, body: init.body, url: full });

  if (path === '/api/web-auth/session') {
    return jsonRes(net.authenticated ? { authenticated: true, principal: net.principal } : { authenticated: false });
  }
  if (path === '/api/web-auth/login' && method === 'POST') {
    if (net.login) return net.login(JSON.parse(init.body || '{}'));
    net.authenticated = true;
    return jsonRes({ ok: true, principal: net.principal });
  }
  if (path === '/api/web-auth/logout') {
    if (net.logout) return net.logout();
    net.authenticated = false;
    return jsonRes({ ok: true });
  }
  if (path === '/api/mobile/bootstrap') {
    return jsonRes({
      agents: AGENTS,
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions') {
    return jsonRes(params.namespace === 'code' ? [] : net.sessions);
  }
  if (path === '/api/sessions/new' && method === 'POST') {
    if (net.createQueue.length) return jsonRes(net.createQueue.shift());
    return jsonRes({ path: 'C:/sessions/new-default.jsonl', sessionId: 'sess-new-default', agentId: 'agent-home' });
  }
  if (path === '/api/sessions/messages') {
    return jsonRes({ messages: [], blocks: [], hasMore: false });
  }
  if (path === '/api/models' && method === 'GET') {
    if (net.holdModels > 0) {
      net.holdModels -= 1;
      return new Promise((resolve) => net.pendingModels.push({ params, resolve }));
    }
    return jsonRes(net.modelsResponse ? net.modelsResponse(params) : modelsFor(params.sessionPath));
  }
  if (path === '/api/models/switch' && method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    net.switchCalls.push({ body, path });
    if (net.switchGate) {
      const gate = net.switchGate;
      net.switchGate = null;
      return gate.promise;
    }
    const model = MODELS.find((m) => m.id === body.modelId) || { id: body.modelId };
    return jsonRes({ model });
  }
  if (path === '/api/session-thinking-level' && method === 'GET') {
    return jsonRes({ thinkingLevel: 'off', thinkingLevels: ['off', 'high'] });
  }
  if (path === '/api/session-thinking-level' && method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    net.thinkingCalls.push({ body });
    if (net.thinkingGate) {
      const gate = net.thinkingGate;
      net.thinkingGate = null;
      return gate.promise;
    }
    return jsonRes({ thinkingLevel: body.level, thinkingLevels: ['off', 'high'] });
  }
  throw new Error(`unexpected fetch: ${full}`);
};

/* ------------------------------------------------------------------ */
/* 加载真 app                                                           */
/* ------------------------------------------------------------------ */

const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(err); });

await import('../web/app.js');
await waitFor(() => globalThis.__hana, 'window.__hana 就绪');
const hana = globalThis.__hana;
const S = hana.S;
await waitFor(() => S.principal && S.currentAgent, '已登录启动完成');

const chip = () => getEl('modelChip');
const chipText = () => chip().textContent;
const showLogin = () => getEl('view-login').hidden === false && getEl('view-list').hidden === true;
const showList = () => getEl('view-list').hidden === false && getEl('view-login').hidden === true;

function resetFlash() {
  // E5 起 #flashBar 是容器，不再是装文字的那个节点：删 map 项还不够，
  // 容器里的旧提示要一并摘掉，否则下一次 flash 会把旧错误一起带出来。
  const stale = elements.get('flashBar');
  if (stale) for (const child of [...(stale.children || [])]) stale.removeChild(child);
  elements.delete('flashBar');
}

/** 容器里的可见文本（正文在 .toast-text 上，容器自身 textContent 是空的）。 */
function flashText(root = getEl('flashBar')) {
  return walk(root).map((n) => String(n.textContent || '')).join(' ').trim();
}

function flashVisible() {
  return elements.has('flashBar') && getEl('flashBar').hidden === false && flashText() !== '';
}

function walk(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}
function modelButton(modelId) {
  return walk(getEl('settingsContainer')).find((n) => n.attributes?.get('data-model-id') === modelId) || null;
}
function levelButton(level) {
  return walk(getEl('settingsContainer')).find((n) => n.attributes?.get('data-level') === level) || null;
}

async function openListSession(s) {
  hana.paintSessions([s]);
  const listEl = getEl('sessionList');
  const row = (listEl.children || []).find((n) => String(n.className).split(/\s+/).includes('session-item'));
  assert.ok(row, '列表里应有会话行');
  row.dispatchEvent({ type: 'click' });
  await waitFor(() => S.session && S.session.path === s.path, `应打开会话 ${s.path}`);
}

async function clickModel(modelId) {
  getEl('btnSettings').dispatchEvent({ type: 'click' });
  await waitFor(() => modelButton(modelId), `设置里应出现模型 ${modelId}`);
  modelButton(modelId).dispatchEvent({ type: 'click' });
}

async function clickThinking(level) {
  getEl('btnSettings').dispatchEvent({ type: 'click' });
  await waitFor(() => levelButton(level), `设置里应出现思考级别 ${level}`);
  levelButton(level).dispatchEvent({ type: 'click' });
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('新建会话：btnNew 与 btnNewChat 都刷新模型 chip', async () => {
  net.createQueue.push(
    { path: 'C:/sessions/new-1.jsonl', sessionId: 'sess-new-1', agentId: 'agent-home' },
    { path: 'C:/sessions/new-2.jsonl', sessionId: 'sess-new-2', agentId: 'agent-home' },
  );

  assert.equal(chipText(), 'Home Default', '启动时应显示当前 Agent 默认模型');
  getEl('btnNew').dispatchEvent({ type: 'click' });
  await waitFor(() => chipText() === 'Model X', 'btnNew 后 chip 应为新会话模型 Model X');

  getEl('btnBack').dispatchEvent({ type: 'click' });
  await waitFor(() => S.session === null, '应退回列表');
  assert.equal(chipText(), 'Home Default', '回列表应恢复当前 Agent 默认模型');

  getEl('btnNewChat').dispatchEvent({ type: 'click' });
  await waitFor(() => chipText() === 'Model Y', 'btnNewChat 后 chip 应为新会话模型 Model Y');
});

await t('A 慢切模型期间打开 B：A 的成功结果不能覆盖 B 的 chip', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeSwitch = net.switchCalls.length;
  const gate = deferred();
  net.switchGate = gate;
  await clickModel('model-x');
  await waitFor(() => net.switchCalls.length === beforeSwitch + 1, '应发出模型切换请求');

  await openListSession(SESSION_B);
  await waitFor(() => chipText() === 'Model B', 'B 会话 chip 应为 Model B');

  gate.resolve(jsonRes({ model: { id: 'model-x', name: 'Model X' } }));
  await settle(12);
  assert.equal(chipText(), 'Model B', 'A 的迟到成功不能覆盖 B 的 chip');
  assert.equal(flashVisible(), false, 'A 的成功不能在新会话上冒错');
});

await t('A 慢切模型期间打开 B：A 的失败不能覆盖 B、也不能冒旧 flash', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeSwitch = net.switchCalls.length;
  const gate = deferred();
  net.switchGate = gate;
  await clickModel('model-y');
  await waitFor(() => net.switchCalls.length === beforeSwitch + 1, '应发出模型切换请求');

  await openListSession(SESSION_B);
  await waitFor(() => chipText() === 'Model B', 'B 会话 chip 应为 Model B');

  gate.reject(new Error('写模型失败'));
  await settle(12);
  assert.equal(chipText(), 'Model B', 'A 的失败不能覆盖 B 的 chip');
  assert.equal(flashVisible(), false, 'A 的失败不能在新会话上冒 flash');
});

await t('写之前发出的 chip GET 晚到，不能盖掉刚写成功的新模型', async () => {
  // 打开 A 时发出的 chip GET 先挂住：它读到的是写之前的旧模型。
  net.holdModels = 1;
  await openListSession(SESSION_A);
  await waitFor(() => net.pendingModels.length === 1, 'chip GET 应已挂起');

  await clickModel('model-y');
  await waitFor(() => chipText() === 'Model Y', '写成功后 chip 应为 Model Y');

  net.pendingModels.shift().resolve(jsonRes(modelsFor(SESSION_A.path)));
  await settle(12);
  assert.equal(chipText(), 'Model Y', '写之前的旧 GET 晚到不能盖掉新模型');
});

await t('打开设置按目标会话自己的 Agent 取模型，不用当前 Agent 兜底', async () => {
  // 宿主只给模型列表、不给 activeModel：设置面板应退回「该会话 Agent 的 chatModel」。
  net.modelsResponse = (params) => (params.sessionPath === SESSION_A2.path
    ? { models: MODELS, activeModel: null }
    : modelsFor(params.sessionPath));

  await openListSession(SESSION_A2);
  await waitFor(() => chipText() === 'model-2', 'A2 会话 chip 应退回其 Agent 的 chatModel');

  const before = net.calls.length;
  getEl('btnSettings').dispatchEvent({ type: 'click' });
  await waitFor(
    () => net.calls.slice(before).some((c) => c.path === '/api/models' && c.params.sessionPath === SESSION_A2.path),
    '设置应加载 A2 的模型列表',
  );
  const call = net.calls.slice(before).find((c) => c.path === '/api/models' && c.params.sessionPath === SESSION_A2.path);
  assert.equal(call.params.agentId, 'agent-2', '必须用会话自己的 Agent，而不是当前 Agent');
  assert.equal(call.params.agentId === 'agent-home', false, '不能拿当前 Agent 替别的会话兜底');

  await waitFor(() => modelButton('model-2'), '设置应渲染模型列表');
  assert.equal(
    String(modelButton('model-2').className).split(/\s+/).includes('active'),
    true,
    '没有 activeModel 时必须用目标会话 Agent 的 chatModel 高亮，而不是列表首项',
  );
  assert.equal(
    String(modelButton('model-a').className).split(/\s+/).includes('active'),
    false,
    '不能把当前 Agent 的首个模型当成会话模型',
  );
});

await t('思考级别跨会话成功：A 的迟到结果不能改 B 的界面', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeThinking = net.thinkingCalls.length;
  const gate = deferred();
  net.thinkingGate = gate;
  await clickThinking('high');
  await waitFor(() => net.thinkingCalls.length === beforeThinking + 1, '应发出思考级别写请求');

  await openListSession(SESSION_B);
  await waitFor(() => chipText() === 'Model B', 'B 会话 chip 应为 Model B');

  const beforeUnhandled = unhandled.length;
  gate.resolve(jsonRes({ thinkingLevel: 'high', thinkingLevels: ['off', 'high'] }));
  await settle(12);
  assert.equal(chipText(), 'Model B', 'A 的思考写成功不能改 B 的 chip');
  assert.equal(flashVisible(), false, 'A 的思考写成功不能在新会话上冒提示');
  assert.equal(unhandled.length, beforeUnhandled, '过期的思考写不能产生未处理拒绝');
});

await t('思考级别跨会话失败：不能覆盖 B、也不能冒旧 flash', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeThinking = net.thinkingCalls.length;
  const gate = deferred();
  net.thinkingGate = gate;
  await clickThinking('high');
  await waitFor(() => net.thinkingCalls.length === beforeThinking + 1, '应发出思考级别写请求');

  await openListSession(SESSION_B);
  await waitFor(() => chipText() === 'Model B', 'B 会话 chip 应为 Model B');

  const beforeUnhandled = unhandled.length;
  gate.reject(new Error('思考写失败'));
  await settle(12);
  assert.equal(chipText(), 'Model B', 'A 的思考写失败不能覆盖 B 的 chip');
  assert.equal(flashVisible(), false, 'A 的思考写失败不能在新会话上冒 flash');
  assert.equal(unhandled.length, beforeUnhandled, '过期的思考写失败不能产生未处理拒绝');
});

await t('思考级别同会话失败：要给安全提示，不能变成未处理拒绝', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeThinking = net.thinkingCalls.length;
  const gate = deferred();
  net.thinkingGate = gate;
  await clickThinking('high');
  await waitFor(() => net.thinkingCalls.length === beforeThinking + 1, '应发出思考级别写请求');

  const beforeUnhandled = unhandled.length;
  gate.reject(new Error('思考写失败'));
  await settle(12);
  assert.equal(flashVisible(), true, '同会话失败应有提示');
  assert.ok(flashText().includes('思考写失败'), '提示应来自安全错误文案');
  assert.equal(unhandled.length, beforeUnhandled, '同会话失败不能产生未处理拒绝');
});

await t('退出登录后旧身份的思考写回调不能改界面', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeThinking = net.thinkingCalls.length;
  const gate = deferred();
  net.thinkingGate = gate;
  await clickThinking('high');
  await waitFor(() => net.thinkingCalls.length === beforeThinking + 1, '应发出思考级别写请求');

  getEl('btnSwitchLogin').dispatchEvent({ type: 'click' });
  await waitFor(showLogin, '应退出到登录页');
  await settle(4);

  const beforeUnhandled = unhandled.length;
  gate.reject(new Error('旧身份思考失败'));
  await settle(12);
  assert.equal(chipText(), 'Model A', '旧身份的思考回调不能改登录页的 chip');
  assert.equal(flashVisible(), false, '旧身份的思考回调不能冒错');
  assert.equal(unhandled.length, beforeUnhandled, '旧身份的思考写失败不能产生未处理拒绝');

  // 恢复登录状态，后续用例还要在已登录会话里跑。
  getEl('inUser').value = 'qa';
  getEl('inPass').value = 'pw';
  getEl('btnLogin').dispatchEvent({ type: 'click' });
  await waitFor(showList, '重新登录应进主页');
  await settle(3);
});

await t('退出登录后旧身份的在途写回调不能改界面', async () => {
  await openListSession(SESSION_A);
  await waitFor(() => chipText() === 'Model A', 'A 会话 chip 应为 Model A');

  const beforeSwitch = net.switchCalls.length;
  const gate = deferred();
  net.switchGate = gate;
  await clickModel('model-z');
  await waitFor(() => net.switchCalls.length === beforeSwitch + 1, '应发出模型切换请求');

  getEl('btnSwitchLogin').dispatchEvent({ type: 'click' });
  await waitFor(showLogin, '应退出到登录页');
  await settle(4);

  gate.resolve(jsonRes({ model: { id: 'model-z', name: 'Model Z' } }));
  await settle(12);
  assert.equal(chipText(), 'Model A', '旧身份的写回调不能改登录页/新身份的 chip');
  assert.equal(flashVisible(), false, '旧身份回调不能冒错');
});

/* ------------------------------------------------------------------ */

if (unhandled.length) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝（${unhandled.length} 条）`);
  for (const err of unhandled) console.log(`      ${err?.stack || err}`);
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
  // 同 login_integration：app.js 留下的定时器不会自己收，必须显式退。
  process.exit(0);
}
