/* Chat / Code 命名空间：主界面接线集成测试（TDD 红灯 → 集成后复验）
 *
 * 目标契约（父代理已定，本文件只锁接线，不锁模块内部实现）：
 *
 * 1. 列表默认显式 GET /api/sessions?namespace=home，两个筛选按钮 id 为
 *    btnNamespaceHome / btnNamespaceCode；
 * 2. 点 Code 后 GET /api/sessions?namespace=code，响应数组项含
 *    path / sessionId / namespace / cwd / agentId / workspaceMountId / workspaceLabel；
 * 3. 迟到 home（无论成功还是失败）不得覆盖已经落地的 Code 列表；
 * 4. 刷新按钮重载「当前」namespace，而不是永远回 home；
 * 5. 打开 Code 行后 DEBUG 的 S.session 仍保留 namespace='code'、cwd、
 *    workspaceMountId / workspaceLabel 以及 path / sessionId / agentId；
 *    历史接口仍是 /api/sessions/messages?sessionId=...&path=...，不加 namespace；
 * 6. WS prompt 仍用会话自己的 sessionId / sessionPath，不从「当前列表筛选」推断活动会话；
 * 7. 新建按钮仍然开 Chat：成功后列表回 home，不实现 Code 新建；
 * 8. 已打开 Code 活动会话后切到 Chat 列表：S.session 的 namespace / sessionId / path / cwd
 *    不变——目录筛选不是活动会话状态；
 * 9. 首页快捷发送（sendFromHome）也算新建 Chat：从 Code 筛选出发成功后目录回 home，
 *    真实发出的 prompt 仍按新会话身份，不带 namespace。
 *
 * 做法与 tests/workspace_roots_integration.test.mjs、tests/back_entry.test.mjs 一致：
 * 在 Node 里加载真的 web/app.js（DEBUG 下它把 S 等挂到 window.__hana），
 * 用极简 DOM + 路由化 fetch 把宿主换成可观测的探针，不引任何依赖、不启服务、不发真实请求。
 *
 * 关于列表 DOM：目前 __hana 没有暴露 sessionListView，并且 B 正在改 session-list-view，
 * 所以本文件先检查暴露情况，但断言只依赖稳定的 DEBUG 面（S.sessions / S.session）
 * 与 sessionList 容器的可点击行，不依赖未定的 view exports。
 *
 * 红灯口径：旧 app 能正常启动（bootstrap 与列表都回真实形状数据），
 * 失败点必须是「没带 namespace」「按钮没接线」「S.session 丢上下文」这类业务缺口，
 * 不允许以「导入缺模块 / app 启动崩溃」冒充红灯。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ */
/* 极简 DOM（在 Node 里跑真 app.js）                                     */
/* ------------------------------------------------------------------ */

const elements = new Map();

function makeEl(tag = 'div', id = '') {
  const listeners = {};
  const classes = new Set();
  const children = [];

  const node = {
    tagName: String(tag).toUpperCase(),
    id,
    children,
    listeners,
    style: {},
    dataset: {},
    attributes: new Map(),
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    scrollHeight: 32,
    scrollTop: 0,
    clientHeight: 800,
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    classList: {
      add(...cls) {
        for (const c of cls) classes.add(c);
      },
      remove(...cls) {
        for (const c of cls) classes.delete(c);
      },
      contains(cls) {
        return classes.has(cls);
      },
      toggle(cls, force) {
        const want = force === undefined ? !classes.has(cls) : Boolean(force);
        if (want) classes.add(cls);
        else classes.delete(cls);
        return want;
      },
    },
    addEventListener(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    removeEventListener(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((f) => f !== fn);
    },
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt?.type;
      const payload = typeof evt === 'string'
        ? { type, target: node, preventDefault() {}, stopPropagation() {} }
        : { ...evt, target: evt?.target || node };
      for (const fn of [...(listeners[type] || [])]) fn.call(node, payload);
    },
    appendChild(child) {
      if (child) {
        child.parentNode = node;
        children.push(child);
      }
      return child;
    },
    insertBefore(child, ref) {
      const idx = children.indexOf(ref);
      children.splice(idx === -1 ? children.length : idx, 0, child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector(sel) {
      // app 里只用来取 .send-label；给一个稳定的占位节点，不在探针里造真实 DOM。
      const key = String(sel || '');
      const pool = [];
      const collect = (n) => {
        for (const c of n.children || []) {
          pool.push(c);
          collect(c);
        }
      };
      collect(node);
      if (key.startsWith('.')) return pool.find((n) => n.classList.contains(key.slice(1))) || makeEl('span');
      if (key.startsWith('#')) return pool.find((n) => n.id === key.slice(1)) || makeEl('div', key.slice(1));
      return makeEl('div');
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(k, v) {
      node.attributes.set(k, String(v));
    },
    getAttribute(k) {
      return node.attributes.has(k) ? node.attributes.get(k) : null;
    },
    removeAttribute(k) {
      node.attributes.delete(k);
    },
    hasAttribute(k) {
      return node.attributes.has(k);
    },
    focus() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };

  // 真实视图用 innerHTML = '' 清空列表；探针必须同样丢掉旧行，否则迟到响应看不出来。
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() {
      return html;
    },
    set(v) {
      html = String(v ?? '');
      if (!html) children.length = 0;
    },
  });

  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements.has(id)) elements.set(id, makeEl('div', id));
  return elements.get(id);
}

const docListeners = new Map();
const mockBody = makeEl('body');
const mockRoot = makeEl('html');
mockRoot.style.setProperty = () => {};

globalThis.location = { protocol: 'http:', host: 'localhost:8080', origin: 'http://localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  body: mockBody,
  documentElement: mockRoot,
  visibilityState: 'visible',
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  // 只为可能的 tab 模块留最小入口；固定 id 的按钮仍走 getElementById。
  querySelector(sel) {
    const key = String(sel || '');
    if (key.startsWith('#')) return getEl(key.slice(1));
    if (key.startsWith('.')) return [...elements.values()].find((n) => n.classList.contains(key.slice(1))) || null;
    return null;
  },
  querySelectorAll(sel) {
    const key = String(sel || '');
    if (key.startsWith('.')) return [...elements.values()].filter((n) => n.classList.contains(key.slice(1)));
    if (key.startsWith('#')) return [getEl(key.slice(1))];
    return [];
  },
  addEventListener(type, fn) {
    (docListeners.get(type) || docListeners.set(type, []).get(type)).push(fn);
  },
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0, width: 400 };
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------------------------------------------ */
/* 可观测的 WS                                                         */
/* ------------------------------------------------------------------ */

const wsInstances = [];
globalThis.WebSocket = class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    wsInstances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
};

function lastWs() {
  return wsInstances[wsInstances.length - 1] || null;
}

/** 让当前连接「连上」：app 的 open 回调会置 S.wsReady 并补发关注/续流帧。 */
function openSocket() {
  const ws = lastWs();
  assert.ok(ws, '打开会话后 app 应建立 WS 连接');
  ws.readyState = 1;
  for (const fn of [...(ws.listeners.open || [])]) fn({});
}

/* ------------------------------------------------------------------ */
/* 路由化 fetch：真实形状的宿主响应，列表请求可挂起                       */
/* ------------------------------------------------------------------ */

const now = () => Date.now();
const iso = (hoursAgo) => new Date(now() - hoursAgo * 3600e3).toISOString();

// 宿主 GET /api/sessions?namespace=home 的真实形状（父代理已核实路径字段）
const HOME_ROWS = [
  {
    path: 'C:/Users/qa/.hana/sessions/home-1',
    sessionId: 'sess-home-1',
    namespace: 'home',
    cwd: 'C:/work/workspace',
    agentId: 'agent-home',
    title: '首页会话一',
    messageCount: 4,
    modified: iso(1),
  },
  {
    path: 'C:/Users/qa/.hana/sessions/home-2',
    sessionId: 'sess-home-2',
    namespace: 'home',
    cwd: 'C:/work/workspace/notes',
    agentId: 'agent-home',
    title: '首页会话二',
    messageCount: 2,
    modified: iso(5),
  },
];

// 宿主 GET /api/sessions?namespace=code 的真实形状
const CODE_ROWS = [
  {
    path: 'C:/Users/qa/.hana/sessions/code-1',
    sessionId: 'sess-code-1',
    namespace: 'code',
    cwd: 'C:/work/workspace/hana-mobile',
    agentId: 'agent-code',
    workspaceMountId: 'mount-code-1',
    workspaceLabel: 'hana-mobile',
    title: 'Code 会话一',
    messageCount: 7,
    modified: iso(2),
  },
];

// 刷新后宿主返回的新一版 Code 列表：用来证明刷新真的重新取了，而不是重绘旧数组。
const CODE_ROWS_V2 = [
  {
    path: 'C:/Users/qa/.hana/sessions/code-9',
    sessionId: 'sess-code-9',
    namespace: 'code',
    cwd: 'C:/work/workspace/gateway',
    agentId: 'agent-code',
    workspaceMountId: 'mount-code-9',
    workspaceLabel: 'gateway',
    title: 'Code 会话九',
    messageCount: 1,
    modified: iso(0.5),
  },
];

const BOOTSTRAP = {
  agents: [{ id: 'agent-home', name: 'Hakimi', isPrimary: true }],
  userName: 'qa',
  homeFolder: 'C:/work/workspace',
};

const CREATE_RESPONSE = {
  path: 'C:/Users/qa/.hana/sessions/chat-new',
  sessionId: 'sess-chat-new',
  agentId: 'agent-home',
};

// 首页快捷发送（sendFromHome）单独建一条，避免和「新建对话」按钮共用同一个身份。
const CREATE_FROM_HOME = {
  path: 'C:/Users/qa/.hana/sessions/chat-from-home',
  sessionId: 'sess-chat-from-home',
  agentId: 'agent-home',
};

const state = {
  log: [],
  hold: false,
  pending: [], // { ns, query, url, resolve }
  homeRows: HOME_ROWS,
  codeRows: CODE_ROWS,
  createResponse: CREATE_RESPONSE,
};

function rowsFor(ns) {
  return ns === 'code' ? state.codeRows : state.homeRows;
}

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : `HTTP ${status}`,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

globalThis.fetch = async (url, init = {}) => {
  const full = String(url);
  const [path, query = ''] = full.split('?');
  const params = new URLSearchParams(query);
  const method = String(init?.method || 'GET').toUpperCase();
  const entry = { url: full, path, query, method, ns: params.get('namespace'), body: init?.body ?? null };
  state.log.push(entry);

  if (path === '/api/sessions') {
    if (state.hold) {
      return new Promise((resolve) => {
        state.pending.push({ ns: entry.ns, query, url: full, resolve });
      });
    }
    return jsonRes(rowsFor(entry.ns));
  }
  if (path === '/api/web-auth/session') return jsonRes({ authenticated: true, principal: { id: 'user-qa' } });
  if (path === '/api/mobile/bootstrap') return jsonRes(BOOTSTRAP);
  if (path === '/api/sessions/new') return jsonRes(state.createResponse);
  if (path === '/api/sessions/messages') return jsonRes([]);
  throw new Error(`unexpected fetch: ${full}`);
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

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

const listRequests = (ns) => state.log.filter(
  (r) => r.path === '/api/sessions' && (ns === undefined || r.ns === ns),
);

const requestsTo = (path) => state.log.filter((r) => r.path === path);

/** 释放一个挂起的列表请求（按 namespace 取最早的那条），默认回该 namespace 的正常数据。 */
async function release(ns, { body, ok = true, status = 200 } = {}) {
  const idx = state.pending.findIndex((p) => p.ns === ns);
  assert.notEqual(idx, -1, `没有挂起中的 namespace=${ns} 列表请求，实际挂起：${JSON.stringify(state.pending.map((p) => p.ns))}`);
  const [pending] = state.pending.splice(idx, 1);
  pending.resolve(jsonRes(body === undefined ? rowsFor(ns) : body, { ok, status }));
  await settle();
}

function subtreeText(node) {
  let out = String(node?.textContent ?? '');
  for (const child of node?.children || []) out += ' ' + subtreeText(child);
  return out;
}

function listText() {
  return subtreeText(getEl('sessionList'));
}

/** 在 sessionList 里找可点击、且文本包含 title 的会话行（不依赖具体 class 名）。 */
function findClickableRow(title) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if ((n.listeners?.click || []).length) out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(getEl('sessionList'));
  return out.find((n) => subtreeText(n).includes(title)) || null;
}

const click = (id) => getEl(id).dispatchEvent('click');

/* ------------------------------------------------------------------ */
/* 加载真 app.js（DEBUG 下暴露 window.__hana）                          */
/* ------------------------------------------------------------------ */

const unhandled = [];
process.on('unhandledRejection', (err) => {
  unhandled.push(err);
});

await import('../web/app.js');

await waitFor(() => globalThis.__hana, 'window.__hana 就绪');
const hana = globalThis.__hana;
const S = hana.S;
await waitFor(() => S.currentAgent, 'boot 完成（S.currentAgent 就绪）');

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

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('页面里有 btnNamespaceHome / btnNamespaceCode 两个筛选按钮', async () => {
  // mock DOM 的 getElementById 会随手造节点，光靠点击没法发现「接到空气」；
  // 所以这里对真页面做一次最小核对，生产视图仍由 B 负责。
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const id of ['btnNamespaceHome', 'btnNamespaceCode']) {
    assert.ok(
      new RegExp(`id="${id}"`).test(html),
      `web/index.html 缺少筛选按钮 id="${id}"（app 接线后点不到真节点）`,
    );
  }
});

await t('默认进入 Chat：列表请求显式带 namespace=home', async () => {
  await waitFor(() => listRequests().length > 0, '首页应发出一次会话列表请求');
  const first = listRequests()[0];
  assert.equal(
    first.ns,
    'home',
    `首页列表必须显式请求 GET /api/sessions?namespace=home，实际 URL：${first.url}`,
  );
  assert.equal(first.method, 'GET', `列表读取必须是 GET，实际 ${first.method}`);
  await waitFor(
    () => S.sessions?.[0]?.sessionId === HOME_ROWS[0].sessionId,
    'home 列表应落到 DEBUG 的 S.sessions',
  );
  assert.deepEqual(
    S.sessions.map((s) => s.sessionId),
    HOME_ROWS.map((s) => s.sessionId),
    'S.sessions 必须就是 home 列表',
  );
});

await t('点 Code：GET ?namespace=code，列表切到 code 数组', async () => {
  click('btnNamespaceCode');
  await waitFor(
    () => listRequests('code').length > 0,
    '点 btnNamespaceCode 后应发 GET /api/sessions?namespace=code（旧 app 没有这个按钮接线）',
  );
  const req = listRequests('code').at(-1);
  assert.equal(
    req.ns,
    'code',
    `namespace 必须是字符串 'code'，实际 ${JSON.stringify(req.ns)}`
      + '（把 click 事件对象直接当 namespace 会变成 "[object PointerEvent]"）',
  );
  assert.equal(req.method, 'GET');

  await waitFor(() => S.sessions?.[0]?.sessionId === CODE_ROWS[0].sessionId, 'Code 列表应落到 S.sessions');
  assert.deepEqual(
    S.sessions.map((s) => s.sessionId),
    CODE_ROWS.map((s) => s.sessionId),
    '列表内容必须换成 Code namespace 的数据，不能混入 home 会话',
  );
  assert.ok(S.sessions.every((s) => s.namespace === 'code'), 'Code 列表项必须都带 namespace=code');

  const title = CODE_ROWS[0].title;
  assert.ok(listText().includes(title), `列表容器应渲染出 Code 会话「${title}」，实际：${listText()}`);
});

await t('竞态：迟到的 home 成功响应不能覆盖 Code 列表', async () => {
  assert.equal(S.sessions?.[0]?.namespace, 'code', '前置：当前应停留在 Code 列表');

  state.hold = true;
  click('btnNamespaceHome');
  await waitFor(() => state.pending.some((p) => p.ns === 'home'), '切 home 的列表请求应挂起');

  click('btnNamespaceCode');
  await waitFor(() => state.pending.some((p) => p.ns === 'code'), '切回 code 的列表请求应挂起');

  state.hold = false;
  await release('code');
  await waitFor(() => S.sessions?.[0]?.namespace === 'code', 'Code 列表先落地');
  const before = S.sessions.map((s) => s.sessionId);

  await release('home'); // 迟到的 home 成功
  await settle(10);

  assert.deepEqual(
    S.sessions.map((s) => s.sessionId),
    before,
    '迟到的 home 成功响应覆盖了 Code 列表（需要按 namespace / 请求代号丢弃过期响应）',
  );
  assert.ok(S.sessions.every((s) => s.namespace === 'code'), '迟到响应落地后列表项必须仍是 code');
});

await t('竞态：迟到的 home 失败响应不能清空或报错覆盖 Code 列表', async () => {
  assert.equal(S.sessions?.[0]?.namespace, 'code', '前置：当前应停留在 Code 列表');

  state.hold = true;
  click('btnNamespaceHome');
  await waitFor(() => state.pending.some((p) => p.ns === 'home'), '切 home 的列表请求应挂起');

  click('btnNamespaceCode');
  await waitFor(() => state.pending.some((p) => p.ns === 'code'), '切回 code 的列表请求应挂起');

  state.hold = false;
  await release('code');
  await waitFor(() => S.sessions?.[0]?.namespace === 'code', 'Code 列表先落地');
  const before = S.sessions.map((s) => s.sessionId);

  await release('home', { ok: false, status: 500, body: { detail: 'boom' } }); // 迟到的 home 失败
  await settle(10);

  assert.deepEqual(
    S.sessions.map((s) => s.sessionId),
    before,
    '迟到的 home 失败响应清空/覆盖了 Code 列表',
  );
  assert.ok(S.sessions.every((s) => s.namespace === 'code'), '列表项必须仍是 code');
  assert.ok(
    !listText().includes('失败'),
    `Code 列表上不该出现迟到 home 请求的错误提示，实际：${listText()}`,
  );
});

await t('刷新：沿用当前 namespace=code，不偷偷回 home', async () => {
  state.codeRows = CODE_ROWS_V2;
  const before = listRequests('code').length;

  click('btnRefresh');
  await waitFor(
    () => listRequests('code').length > before,
    '在 Code 下点刷新应发 GET /api/sessions?namespace=code（旧 app 的刷新固定请求无 namespace 的列表）',
  );
  const req = listRequests('code').at(-1);
  assert.equal(req.ns, 'code', `刷新必须沿用当前 namespace，实际 URL：${req.url}`);

  await waitFor(
    () => S.sessions?.[0]?.sessionId === CODE_ROWS_V2[0].sessionId,
    '刷新后应换成宿主新返回的 Code 列表',
  );
  assert.deepEqual(
    S.sessions.map((s) => s.sessionId),
    CODE_ROWS_V2.map((s) => s.sessionId),
    '刷新后列表必须是新数据（重绘旧数组不算刷新）',
  );
});

await t('打开 Code 行：S.session 保留 code 上下文，历史请求不带 namespace', async () => {
  const row = CODE_ROWS_V2[0];
  await waitFor(() => findClickableRow(row.title), `列表里应有可点击的 Code 行「${row.title}」`);
  findClickableRow(row.title).dispatchEvent('click');
  await waitFor(() => S.session?.path === row.path, '点行后应进入该会话');

  const s = S.session;
  assert.equal(s.namespace, 'code', `打开 Code 行后 S.session.namespace 必须保留 'code'，实际 ${JSON.stringify(s.namespace)}`);
  assert.equal(s.cwd, row.cwd, 'S.session 必须保留行的 cwd');
  assert.equal(s.workspaceMountId, row.workspaceMountId, 'S.session 必须保留行的 workspaceMountId');
  assert.equal(s.workspaceLabel, row.workspaceLabel, 'S.session 必须保留行的 workspaceLabel');
  assert.equal(s.sessionId, row.sessionId, 'S.session.sessionId 必须来自该行');
  assert.equal(s.path, row.path, 'S.session.path 必须来自该行');
  assert.equal(s.agentId, row.agentId, 'S.session.agentId 必须来自该行');

  await waitFor(() => requestsTo('/api/sessions/messages').length > 0, '打开会话应拉历史');
  const hist = requestsTo('/api/sessions/messages').at(-1);
  const histParams = Object.fromEntries(new URLSearchParams(hist.query));
  // 历史接口仍以会话身份为准：不能混入目录筛选的 namespace；limit 属于分页参数，允许存在。
  assert.equal(histParams.sessionId, row.sessionId, `历史请求必须带会话自己的 sessionId，实际：${hist.url}`);
  assert.equal(histParams.path, row.path, `历史请求必须带会话自己的 path，实际：${hist.url}`);
  assert.equal(
    new URLSearchParams(hist.query).has('namespace'),
    false,
    `历史接口不该加 namespace，实际：${hist.url}`,
  );

  // 打开会话的尾段会建 WS；等它建好再交棒给下一条「WS prompt」用例。
  await waitFor(() => S.ws && S.ws === wsInstances.at(-1), '打开会话后应建立 WS 连接');
});

await t('WS prompt：仍用会话自己的 sessionId/sessionPath，不从列表筛选推断', async () => {
  assert.equal(S.session?.namespace, 'code', '前置：当前活动会话是 Code 会话');
  const row = CODE_ROWS_V2[0];

  openSocket();
  await waitFor(() => S.wsReady, 'WS 应就绪');
  getEl('input').value = '继续实现';
  await hana.sendMessage();

  const frames = lastWs().sent;
  const prompt = frames.find((f) => f?.type === 'prompt');
  assert.ok(prompt, `发送后应发出 prompt 帧，实际帧类型：${frames.map((f) => f?.type).join(',')}`);
  assert.equal(prompt.sessionId, row.sessionId, 'prompt.sessionId 必须来自活动会话，不能取自 Code 筛选');
  assert.equal(prompt.sessionPath, row.path, 'prompt.sessionPath 必须来自活动会话，不能取自 Code 筛选');
});

await t('新建按钮跟随当前列表：在 Code 下新建的就是 Code 会话', async () => {
  assert.equal(S.session?.namespace, 'code', '前置：当前仍在 Code 会话里点新建');
  const mark = state.log.length;

  click('btnNewChat');
  await waitFor(
    () => state.log.slice(mark).some((r) => r.path === '/api/sessions/new' && r.method === 'POST'),
    '新建按钮应发 POST /api/sessions/new',
  );
  const post = state.log.slice(mark).find((r) => r.path === '/api/sessions/new');
  const body = post.body ? JSON.parse(post.body) : {};
  // 宿主 bundle 里 `X === "code" && (le.namespace = "code")`，X 只来自 body.namespace；
  // 不传就一律建 Chat，所以这里必须显式带 code。
  assert.equal(body.namespace, 'code', `Code 列表下新建必须带 namespace=code，实际 body：${post.body}`);
  // 宿主不会替 Code 会话挑目录：不带 cwd 直接 400 code_repository_required。
  // 手机端拿当前 Code 列表里最近一个会话的目录当默认值。
  assert.equal(
    body.cwd,
    state.codeRows[0].cwd,
    `Code 新建必须带上项目目录，实际 body：${post.body}`,
  );

  await waitFor(
    () => state.log.slice(mark).some((r) => r.path === '/api/sessions' && r.ns === 'code'),
    '新建成功后列表应拉回 namespace=code',
  );
  const afterNew = state.log.slice(mark).filter((r) => r.path === '/api/sessions');
  assert.ok(
    afterNew.every((r) => r.ns === 'code'),
    `新建过程中列表请求只能回 code，实际：${afterNew.map((r) => r.ns).join(',')}`,
  );

  await waitFor(() => S.session?.path === CREATE_RESPONSE.path, '新建成功后应打开新会话');
  assert.equal(S.session.namespace, 'code', '新建的会话必须沿用 Code 命名空间，不能退回 Chat');
});

await t('边界：切到 Chat 列表不改动已打开的 Code 活动会话', async () => {
  // 前置：用真实按钮回 Code 列表，再用真实行打开一个 Code 会话。
  click('btnNamespaceCode');
  await waitFor(() => S.sessions?.[0]?.namespace === 'code', '切回 Code 列表');
  const row = state.codeRows[0];
  await waitFor(() => findClickableRow(row.title), `列表里应有可点击的 Code 行「${row.title}」`);
  findClickableRow(row.title).dispatchEvent('click');
  await waitFor(() => S.session?.path === row.path, '打开 Code 会话');

  const before = {
    namespace: S.session.namespace,
    sessionId: S.session.sessionId,
    path: S.session.path,
    cwd: S.session.cwd,
  };
  const historyCount = requestsTo('/api/sessions/messages').length;

  click('btnNamespaceHome');
  await waitFor(
    () => S.sessions?.length > 0 && S.sessions.every((s) => s.namespace === 'home'),
    '点 Chat 后列表应换成 home',
  );
  await settle(8);

  assert.deepEqual(
    {
      namespace: S.session?.namespace,
      sessionId: S.session?.sessionId,
      path: S.session?.path,
      cwd: S.session?.cwd,
    },
    before,
    '目录筛选（Chat / Code）不是活动会话状态：切列表不能改 S.session 的 namespace/id/path/cwd',
  );
  // 只锁「活动会话没被重开」；视图层怎么排布归前端，不在这里加断言。
  assert.equal(
    requestsTo('/api/sessions/messages').length,
    historyCount,
    '切目录筛选不应重新拉活动会话的历史（筛选不是重新打开会话）',
  );
});

await t('边界：首页快捷发送也是新建 Chat，从 Code 出发成功后回 home 且 prompt 用新会话身份', async () => {
  // 前置：目录停在 Code。
  click('btnNamespaceCode');
  await waitFor(() => S.sessions?.[0]?.namespace === 'code', '切回 Code 列表');

  state.createResponse = CREATE_FROM_HOME;
  const mark = state.log.length;
  const wsMark = wsInstances.length;

  getEl('homeInput').value = '从首页发一条';
  click('btnHomeSend');

  await waitFor(
    () => state.log.slice(mark).some((r) => r.path === '/api/sessions/new' && r.method === 'POST'),
    '首页快捷发送应发 POST /api/sessions/new（仍属于新建 Chat）',
  );
  await waitFor(
    () => state.log.slice(mark).some((r) => r.path === '/api/sessions' && r.ns === 'home'),
    '首页快捷发送成功后目录应回 home（不实现 Code 新建）',
  );
  const listAfter = state.log.slice(mark).filter((r) => r.path === '/api/sessions');
  assert.ok(
    listAfter.every((r) => r.ns === 'home'),
    `首页新建后的列表请求只能回 home，实际：${listAfter.map((r) => r.ns).join(',')}`,
  );

  await waitFor(() => S.session?.path === CREATE_FROM_HOME.path, '首页快捷发送应打开新建的会话');
  assert.notEqual(
    S.session.namespace,
    'code',
    '首页新建的 Chat 会话不能继承 Code 命名空间',
  );

  // 真实流程会在 WS 就绪后自动发送；这里只把新连接打开，prompt 仍由 sendFromHome 自己发。
  await waitFor(() => wsInstances.length > wsMark, '打开新会话应建立新的 WS 连接');
  openSocket();
  await waitFor(
    () => (lastWs()?.sent || []).some((f) => f?.type === 'prompt'),
    '首页快捷发送应真的发出 prompt 帧',
    5000,
  );

  const prompt = lastWs().sent.find((f) => f?.type === 'prompt');
  assert.equal(
    prompt.sessionId,
    CREATE_FROM_HOME.sessionId,
    'prompt.sessionId 必须是新建会话的身份，不能沿用 Code 筛选里的会话',
  );
  assert.equal(
    prompt.sessionPath,
    CREATE_FROM_HOME.path,
    'prompt.sessionPath 必须是新建会话的身份，不能沿用 Code 筛选里的会话',
  );
  assert.equal(
    prompt.namespace,
    undefined,
    'prompt 帧不该带目录筛选的 namespace',
  );
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
}
