/* tests/login_integration.test.mjs
 *
 * 登录接线集成测试（账号密码单模式）：真实 app.js + 真实 login-view/login-controller，
 * 只替换 DOM / fetch / WebSocket。手机凭证方案已移除，不再模拟签发/凭证登录。
 * 覆盖：
 * 1. 已有有效 Cookie 直接进主页，不自动 logout、不发登录请求；页面没有凭证入口
 * 2. 显式退出登录；空值零请求；401/403 脱敏提示、字段清空、按钮恢复、不自动重试
 * 3. 双击只发一次；body 只含 username/password；登录响应 principal 不被信任
 * 4. 密码空格保留、用户名 trim；busy 拒绝切换登录
 * 5. 退出成功：WS/卡片/历史/列表在途/草稿清理，回密码登录页且可再次登录
 * 6. 退出失败：保留旧页面、登录态与草稿
 * 7. 登录 200 但 /session 未生效：不制造登录成功；boot 未完成期间不能再登录/退出
 * 8. 跨身份旧 create / 旧首页发送 / 旧失败不能影响新身份；同一身份切会话不串草稿
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let bad = 0;
async function t(name, fn) {
  // 每个用例自己设置 handler；失败时也不能把 handler 漏给下一个用例。
  net.login = null;
  net.logout = null;
  net.holdNamespace = null;
  net.createGate = null;
  net.createResult = null;
  net.holdMessagesFor = null;
  while (net.pendingMessages.length) {
    net.pendingMessages.shift().resolve(jsonRes({ messages: [], blocks: [], hasMore: false }));
  }
  while (net.pendingList.length) net.pendingList.shift().resolve(jsonRes([]));
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await delay(0);
}
async function waitFor(pred, label, timeoutMs = 2500) {
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
      // 与浏览器一致：写空 innerHTML 会清掉子节点。
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

/* E5 起 #flashBar 是提示容器（正文在 .toast-text 子节点上），容器自身的 textContent 是空的。
 * 读完/清空提示都得走子节点，判断的意思不变。 */
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
  const kids = [...(root.children || [])];
  if (typeof root.replaceChildren === 'function') root.replaceChildren();
  else for (const child of kids) root.removeChild(child);
  root.textContent = '';
}

// 登录视图在 app 导入时就会绑定这些节点，必须先建好；凭证相关节点不应存在。
for (const id of [
  'view-login', 'view-list', 'view-chat',
  'inUser', 'inPass', 'btnLogin', 'loginErr', 'loginHint', 'btnSwitchLogin',
]) getEl(id);

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
    this.closeCalls = 0;
    this.sent = [];
    wsInstances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closeCalls += 1;
  }
  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }
};

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
  login: null, // (body) => Response | Promise<Response>
  logout: null, // () => Response | Promise<Response>
  sessions: [],
  holdNamespace: null,
  pendingList: [],
  bootstrapGate: null,
  bootstrapHeld: 0,
  createGate: null,
  createHeld: 0,
  createResult: null,
  holdMessagesFor: null,
  pendingMessages: [],
};

globalThis.fetch = async (url, init = {}) => {
  const full = String(url);
  const [path, query = ''] = full.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const method = String(init.method || 'GET').toUpperCase();
  net.calls.push({ path, query, params, method, body: init.body, headers: init.headers, url: full });

  if (path === '/api/web-auth/session') {
    return jsonRes(net.authenticated ? { authenticated: true, principal: net.principal } : { authenticated: false });
  }
  if (path === '/api/web-auth/login' && method === 'POST') {
    if (net.login) return net.login(JSON.parse(init.body || '{}'));
    net.authenticated = true;
    return jsonRes({ ok: true, expiresAt: '2030-01-01T00:00:00Z', principal: net.principal });
  }
  if (path === '/api/web-auth/logout') {
    if (net.logout) return net.logout();
    net.authenticated = false;
    return jsonRes({ ok: true });
  }
  if (path === '/api/mobile/bootstrap') {
    if (net.bootstrapGate) {
      const gate = net.bootstrapGate;
      net.bootstrapGate = null; // one-shot
      net.bootstrapHeld += 1;
      return gate.promise;
    }
    return jsonRes({
      agents: [{ id: 'agent-home', name: 'Hakimi', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions') {
    if (net.holdNamespace === params.namespace) {
      return new Promise((resolve) => net.pendingList.push({ params, resolve }));
    }
    return jsonRes(params.namespace === 'code' ? [] : net.sessions);
  }
  if (path === '/api/sessions/new' && method === 'POST') {
    if (net.createGate) {
      const gate = net.createGate;
      net.createGate = null; // one-shot
      net.createHeld += 1;
      return gate.promise;
    }
    return jsonRes(net.createResult || {
      path: 'C:/sessions/new-default.jsonl',
      sessionId: 'sess-new-default',
      agentId: 'agent-home',
    });
  }
  if (path === '/api/sessions/messages') {
    if (net.holdMessagesFor && params.sessionId === net.holdMessagesFor) {
      return new Promise((resolve) => net.pendingMessages.push({ params, resolve }));
    }
    return jsonRes({ messages: [], blocks: [], hasMore: false });
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
const loginCalls = () => net.calls.filter((c) => c.path === '/api/web-auth/login');
const logoutCalls = () => net.calls.filter((c) => c.path === '/api/web-auth/logout');
const loginBody = (call) => JSON.parse(call.body || '{}');

const showLogin = () => getEl('view-login').hidden === false && getEl('view-list').hidden === true;
const showList = () => getEl('view-list').hidden === false && getEl('view-login').hidden === true;

async function switchToLogin() {
  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '应回到登录页');
  await settle(3);
}

async function openChat() {
  await hana.openSession({ path: 'C:/sessions/chat.jsonl', sessionId: 'sess-login-1', title: '登录会话', agentId: 'agent-home' });
  await waitFor(() => getEl('view-chat').hidden === false, '应进入聊天');
  await settle(2);
}

async function loginPassword(username, password) {
  getEl('inUser').value = username;
  getEl('inPass').value = password;
  getEl('btnLogin').dispatchEvent('click');
  await waitFor(showList, '登录应进主页');
  await settle(3);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('已有有效 Cookie：直接进主页，不自动 logout、不发登录请求；页面无凭证入口', async () => {
  await waitFor(showList, '有效登录应直接进主页');
  assert.equal(showList(), true, '有效登录应直接进主页');
  assert.equal(S.principal.id, 'real-user');
  assert.equal(loginCalls().length, 0, '不能自动弹登录/发登录请求');
  assert.equal(logoutCalls().length, 0, '不能自动退出已登录用户');
  assert.equal(elements.has('inCredential'), false, '视图不能绑定凭证输入');

  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const banned of ['inCredential', 'tabLoginPassword', 'tabLoginCredential', 'loginCredentialPanel', 'login-mode-tab']) {
    assert.equal(html.includes(banned), false, `index.html 不能还有 ${banned}`);
  }
});

await t('退出登录：只发一次 logout，进入账号密码登录页', async () => {
  await switchToLogin();
  assert.equal(logoutCalls().length, 1, '退出登录只发一次请求');
  assert.equal(logoutCalls()[0].method, 'POST');
  assert.equal(S.principal, null, '退出后本地 principal 清空');
  assert.equal(getEl('inUser').value, '', '登录页不应预填用户名');
  assert.equal(getEl('inPass').value, '', '登录页不应预填密码');
});

await t('空值零请求：用户名/密码缺失都给安全提示，不发登录请求', async () => {
  const before = loginCalls().length;
  getEl('inUser').value = 'alice';
  getEl('inPass').value = '';
  getEl('btnLogin').dispatchEvent('click');
  await settle(2);
  assert.ok(getEl('loginErr').textContent.length > 0, '要有中文提示');

  getEl('inUser').value = '   ';
  getEl('inPass').value = 'pw';
  getEl('btnLogin').dispatchEvent('click');
  await settle(2);
  assert.equal(loginCalls().length, before, '必填缺失不能发请求');
  assert.equal(getEl('btnLogin').disabled, false, '空值后按钮不能卡死');
});

await t('401：安全提示、密码已清、按钮恢复、不自动重试', async () => {
  net.login = () => jsonRes({ detail: 'invalid password SECRET-PW' }, { ok: false, status: 401 });
  getEl('inUser').value = 'alice';
  getEl('inPass').value = 'SECRET-PW';
  const before = loginCalls().length;
  getEl('btnLogin').dispatchEvent('click');
  await waitFor(() => loginCalls().length === before + 1, '应发一次登录请求');
  await settle(4);

  assert.equal(loginCalls().length, before + 1, '失败不能自动重试');
  assert.equal(getEl('inPass').value, '', '提交后密码必须清空');
  assert.equal(getEl('btnLogin').disabled, false, '失败后按钮要恢复');
  const text = getEl('loginErr').textContent;
  assert.ok(text.includes('用户名或密码'), '应提示账号密码问题');
  assert.equal(text.includes('SECRET-PW'), false, '错误不能回显密码');
  assert.equal(showLogin(), true, '失败后留在登录页');
  net.login = null;
});

await t('双击只发一次；body 只有 username/password；伪造 principal 不被信任', async () => {
  const gate = deferred();
  net.login = () => gate.promise;
  net.principal = { id: 'real-user', scopes: [] };
  getEl('inUser').value = '  alice  ';
  getEl('inPass').value = '  p w  ';
  const before = loginCalls().length;
  getEl('btnLogin').dispatchEvent('click');
  getEl('btnLogin').dispatchEvent('click');
  await settle(2);
  assert.equal(loginCalls().length, before + 1, '双击只能发一次');
  const call = loginCalls().at(-1);
  assert.deepEqual(loginBody(call), { username: 'alice', password: '  p w  ' });
  assert.deepEqual(Object.keys(loginBody(call)).sort(), ['password', 'username']);
  assert.equal(call.url.includes('p w'), false, '密码不能进 URL');
  assert.equal(/authorization/i.test(Object.keys(call.headers || {}).join('|')), false, '不能被塞 Authorization');
  assert.equal(JSON.stringify(call.body).includes('credential'), false, '不能带 credential');

  gate.resolve(jsonRes({ ok: true, principal: { id: 'fake-admin', scopes: ['sessions.create'] } }));
  net.authenticated = true;
  await waitFor(showList, '登录成功后应进主页');
  await settle(3);
  assert.equal(S.principal.id, 'real-user', 'principal 必须以 /session 官方为准');
  net.login = null;
});

await t('退出成功：关旧 WS 不重连，卡片/历史/列表在途/草稿全部废弃，可再次密码登录', async () => {
  await openChat();
  assert.ok(S.ws, '聊天应有 WS');
  const ws = S.ws;
  const wsCount = wsInstances.length;
  hana.appendUser('OLD-PRIVATE-TEXT');
  assert.ok(getEl('transcript').children.length > 0, '应有旧消息');
  getEl('input').value = 'OLD-CHAT-DRAFT';
  getEl('homeInput').value = 'OLD-HOME-DRAFT';

  net.holdNamespace = 'code';
  getEl('btnNamespaceCode').dispatchEvent('click');
  await waitFor(() => net.pendingList.length === 1, '列表请求应挂起');

  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '退出后应回登录页');
  await settle(4);

  assert.equal(S.session, null, '退出后活动会话清空');
  assert.equal(S.ws, null, '退出后 WS 引用清空');
  assert.equal(ws.closeCalls, 1, '旧 WS 必须被关闭');
  assert.equal(wsInstances.length, wsCount, '关旧 WS 不能触发重连');
  assert.deepEqual(S.sessions, [], '旧用户列表要清空');
  assert.equal(getEl('transcript').children.length, 0, '旧用户私有历史必须从 DOM 清掉');
  assert.equal(getEl('input').value, '', '旧聊天草稿必须清掉');
  assert.equal(getEl('homeInput').value, '', '旧首页草稿必须清掉');
  assert.equal(getEl('btnNamespaceHome').getAttribute('aria-pressed'), 'true', '筛选回 Chat');

  net.pendingList[0].resolve(jsonRes([{ sessionId: 'old-user-row', namespace: 'code', title: 'OLD-USER-ROW' }]));
  net.pendingList.length = 0;
  net.holdNamespace = null;
  await settle(6);
  assert.deepEqual(S.sessions, [], '旧用户在途列表不能回填新登录页');
  assert.equal(getEl('sessionList').innerHTML.includes('OLD-USER-ROW'), false);

  // 退出后可以再次用账号密码登录。
  net.principal = { id: 'user-2', scopes: [] };
  await loginPassword('bob', 'pw2');
  assert.equal(showList(), true, '退出后应能再次登录');
});

await t('退出失败：保留旧页面、登录态与草稿，不假装成功', async () => {
  await openChat();
  net.logout = () => jsonRes({ detail: 'boom' }, { ok: false, status: 500 });
  const sessionBefore = S.session;
  const wsBefore = S.ws;
  getEl('input').value = 'KEEP-CHAT';
  getEl('homeInput').value = 'KEEP-HOME';
  getEl('btnSwitchLogin').dispatchEvent('click');
  await settle(6);

  assert.equal(getEl('view-chat').hidden, false, '退出失败不能离开聊天');
  assert.equal(S.session, sessionBefore, '退出失败不能清会话');
  assert.equal(S.principal.id, 'user-2', '退出失败不能清 principal');
  assert.equal(S.ws, wsBefore, '退出失败不能关 WS');
  assert.equal(getEl('input').value, 'KEEP-CHAT', '退出失败必须保留聊天草稿');
  assert.equal(getEl('homeInput').value, 'KEEP-HOME', '退出失败必须保留首页草稿');
  assert.ok(getEl('loginErr').textContent.length > 0, '要有安全错误提示');
  assert.ok(flashText().length > 0, '隐藏登录页时错误要浮在当前页');
  net.logout = null;
});

await t('403：不被当成成功，客户端不发 scope/credential、不重试', async () => {
  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '正常退出应回登录页');

  net.login = () => jsonRes({ detail: 'forbidden' }, { ok: false, status: 403 });
  net.authenticated = false;
  const before = loginCalls().length;
  getEl('inUser').value = 'alice';
  getEl('inPass').value = 'pw';
  getEl('btnLogin').dispatchEvent('click');
  await waitFor(() => loginCalls().length === before + 1, '应发一次登录');
  await settle(4);

  assert.equal(loginCalls().length, before + 1, '403 不能自动重试');
  assert.equal(showLogin(), true, '403 后不能进主页');
  assert.equal(S.principal, null, '403 不能制造登录态');
  assert.ok(getEl('loginErr').textContent.includes('登录被拒绝'));
  const call = loginCalls().at(-1);
  assert.deepEqual(Object.keys(loginBody(call)).sort(), ['password', 'username']);
  assert.equal(JSON.stringify(call.body).includes('sessions.create'), false, '请求里不能伪造 scope');
  assert.equal(JSON.stringify(call.body).includes('credential'), false, '请求里不能带 credential');
  net.login = null;
});

await t('登录 200 但 /session 未生效：不制造登录成功', async () => {
  net.login = () => jsonRes({ ok: true, principal: { id: 'ghost' } });
  net.authenticated = false;
  getEl('inUser').value = 'alice';
  getEl('inPass').value = 'ghost-pw';
  const before = loginCalls().length;
  getEl('btnLogin').dispatchEvent('click');
  await waitFor(() => loginCalls().length === before + 1, '应发一次登录请求');
  await settle(8);

  assert.equal(showLogin(), true, '会话未生效必须留在登录页');
  assert.equal(S.principal, null, '不能把登录响应体当 principal');
  assert.equal(getEl('loginErr').textContent, '登录没有生效，请重试', '错误由 controller 统一给');
  assert.equal(getEl('btnLogin').disabled, false, '未生效也要恢复按钮');
  net.login = null;
});

await t('P0：登录 200 但 boot 未完成时，不能再登录/退出，只核一份官方 principal', async () => {
  const gate = deferred();
  net.bootstrapGate = gate;
  net.bootstrapHeld = 0;
  net.authenticated = true;
  net.principal = { id: 'real-user', scopes: [] };
  const bootBefore = net.calls.filter((c) => c.path === '/api/mobile/bootstrap').length;
  const sessionBefore = net.calls.filter((c) => c.path === '/api/web-auth/session').length;
  const loginBefore = loginCalls().length;
  const logoutBefore = logoutCalls().length;

  getEl('inUser').value = 'alice';
  getEl('inPass').value = 'slow-boot-pw';
  getEl('btnLogin').dispatchEvent('click');

  await waitFor(() => net.bootstrapHeld === 1, '登录后 boot 应挂起');
  assert.equal(S.principal.id, 'real-user', '此时官方 principal 已经核对完');
  assert.equal(getEl('btnLogin').disabled, true, 'boot 完成前按钮必须仍 disabled');
  assert.equal(getEl('btnLogin').textContent, '登录中…');

  getEl('btnLogin').dispatchEvent('click');
  getEl('btnSwitchLogin').dispatchEvent('click');
  await settle(5);

  assert.equal(loginCalls().length, loginBefore + 1, 'boot 完成前不能再发登录');
  assert.equal(logoutCalls().length, logoutBefore, 'boot 完成前不能发退出');

  gate.resolve(jsonRes({
    agents: [{ id: 'agent-home', name: 'Hakimi', isPrimary: true }],
    userName: 'qa',
    homeFolder: 'C:/work/workspace',
  }));
  await waitFor(showList, '释放后应进主页');
  await settle(4);

  assert.equal(
    net.calls.filter((c) => c.path === '/api/mobile/bootstrap').length,
    bootBefore + 1,
    '只应 boot 一次',
  );
  assert.equal(
    net.calls.filter((c) => c.path === '/api/web-auth/session').length,
    sessionBefore + 1,
    '只应核对一次官方 principal',
  );
  assert.equal(S.principal.id, 'real-user');
  assert.equal(getEl('btnLogin').disabled, false, '完成后按钮恢复');
});

await t('新建会话：旧身份的 create 响应迟到，不能重开旧会话/改新列表', async () => {
  await waitFor(showList, '应已在主页');
  net.principal = { id: 'user-1', scopes: [] };
  const gate = deferred();
  net.createGate = gate;
  net.createHeld = 0;
  getEl('btnNew').dispatchEvent('click');
  await waitFor(() => net.createHeld === 1, '新建请求应挂起');

  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '应回登录页');
  net.principal = { id: 'user-2', scopes: [] };
  await loginPassword('u2', 'pw2');

  const listCalls = net.calls.filter((c) => c.path === '/api/sessions').length;
  const msgCalls = net.calls.filter((c) => c.path === '/api/sessions/messages').length;

  gate.resolve(jsonRes({ path: 'C:/sessions/stale.jsonl', sessionId: 'sess-stale', agentId: 'agent-home' }));
  await settle(10);

  assert.equal(S.session, null, '旧 create 迟到不能打开旧会话');
  assert.equal(getEl('view-chat').hidden, true, '不能进入聊天');
  assert.equal(net.calls.filter((c) => c.path === '/api/sessions').length, listCalls, '不能刷新新用户列表');
  assert.equal(net.calls.filter((c) => c.path === '/api/sessions/messages').length, msgCalls, '不能拉旧会话历史');
  assert.equal(getEl('btnNew').disabled, false, '按钮必须恢复');
});

await t('首页发送：旧身份等 WS 时切登录，旧草稿不能发进新会话', async () => {
  await waitFor(showList, '应已在主页');
  // 当前是 user-2，先切回 user-1 发起首页发送。
  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '应回登录页');
  net.principal = { id: 'user-1', scopes: [] };
  await loginPassword('u1', 'pw1');

  net.createResult = { path: 'C:/sessions/u1-home.jsonl', sessionId: 'sess-u1-home', agentId: 'agent-home' };
  net.holdMessagesFor = 'sess-u1-home';
  getEl('homeInput').value = 'OLD-HOME-DRAFT';
  getEl('btnHomeSend').dispatchEvent('click');
  await waitFor(() => net.pendingMessages.length === 1, '旧会话历史应挂起');

  // 旧身份卡在 openSession 里时，用户退出登录。
  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '应回登录页');
  assert.equal(getEl('btnHomeSend').disabled, false, '退出后首页发送锁必须复位');
  await delay(150); // 让旧的 WS 等待循环至少跑过一轮（修复后应已退出）
  net.principal = { id: 'user-2', scopes: [] };
  await loginPassword('u2', 'pw2');

  // 新身份打开自己的会话，并让 WS 就绪。
  await hana.openSession({ path: 'C:/sessions/u2.jsonl', sessionId: 'sess-u2', title: 'U2', agentId: 'agent-home' });
  await waitFor(() => S.session?.sessionId === 'sess-u2', '用户 2 会话应打开');
  const ws = S.ws;
  ws.readyState = 1;
  S.wsReady = true;

  // 释放旧身份的历史响应：旧回调不能把旧草稿填进新 composer 或发出去。
  net.pendingMessages.shift().resolve(jsonRes({ messages: [], blocks: [], hasMore: false }));
  net.holdMessagesFor = null;
  await settle(12);

  const leaked = wsInstances
    .flatMap((instance) => instance.sent)
    .some((frame) => JSON.stringify(frame).includes('OLD-HOME-DRAFT'));
  assert.equal(leaked, false, '旧草稿不能发进任何新会话');
  assert.equal(String(getEl('input').value).includes('OLD-HOME-DRAFT'), false, '新登录的 composer 不能被旧草稿污染');
  assert.equal(S.session.sessionId, 'sess-u2', '当前会话必须还是用户 2 的');
});

await t('新建失败：旧身份的失败不能覆盖新用户界面', async () => {
  await waitFor(() => S.principal, '应已登录');
  const gate = deferred();
  net.createGate = gate;
  net.createHeld = 0;
  getEl('btnNew').dispatchEvent('click');
  await waitFor(() => net.createHeld === 1, '新建请求应挂起');

  getEl('btnSwitchLogin').dispatchEvent('click');
  await waitFor(showLogin, '应回登录页');
  net.principal = { id: 'user-3', scopes: [] };
  await loginPassword('u3', 'pw3');

  clearFlash();
  const boom = new Error('500 boom');
  boom.status = 500;
  gate.reject(boom);
  await settle(8);

  assert.equal(flashText().includes('新建失败'), false, '旧失败不能覆盖新用户界面');
  assert.equal(getEl('btnNew').disabled, false, '按钮要恢复');
  assert.equal(showList(), true);
});

await t('首页发送：同一身份在历史等待期切会话，旧草稿不能进入新会话', async () => {
  await waitFor(() => S.principal, '应已登录');
  net.createResult = { path: 'C:/sessions/home-nav.jsonl', sessionId: 'sess-home-nav', agentId: 'agent-home' };
  net.holdMessagesFor = 'sess-home-nav';
  getEl('homeInput').value = 'NAV-HOME-DRAFT';
  getEl('btnHomeSend').dispatchEvent('click');
  await waitFor(() => net.pendingMessages.length === 1, '首页的新会话历史应挂起');

  const owner = S.principal;
  await hana.openSession({ path: 'C:/sessions/nav-target.jsonl', sessionId: 'sess-nav-target', title: 'Target', agentId: 'agent-home' });
  assert.equal(S.principal, owner, '这里没有切登录，必须验证同一身份的导航竞态');
  S.ws.readyState = 1;
  S.wsReady = true;
  getEl('input').value = 'TARGET-DRAFT';

  net.pendingMessages.shift().resolve(jsonRes({ messages: [], blocks: [], hasMore: false }));
  net.holdMessagesFor = null;
  await settle(12);

  assert.equal(getEl('input').value, 'TARGET-DRAFT', '旧首页回调不能覆盖新会话草稿');
  assert.equal(S.session.sessionId, 'sess-nav-target');
  assert.equal(wsInstances.flatMap((ws) => ws.sent).some((frame) => JSON.stringify(frame).includes('NAV-HOME-DRAFT')), false, '不能把首页旧草稿发进用户后来选的会话');
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
  // 必须显式退出：这个文件通过 app.js 装了一堆定时器和假连接，
  // 没有对应的拆解路径，不退出就会挂在那里永远不退。
  // 外层 runner 只能靠超时把它判成失败，看上去像是“还在跑”。
  process.exit(0);
}
