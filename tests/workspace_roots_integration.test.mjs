/* 工作区根列表接线回归（app.js → workspaceService.listRoots → workspaceView）
 *
 * 真机缺陷：app.js 把 listRoots() 的返回对象当成数组展开，具名根全被丢掉，
 * 下拉里只剩硬编码的「Agent 默认工作区」。这里锁的就是这条接线：
 *
 * 1. 首页入口：默认根 + 具名根都要传给 view，默认根的 agentId 取自 S.currentAgent.id；
 * 2. 聊天入口：具名根仍要在，默认根的 agentId 必须取自当前会话 S.session.agentId，
 *    不能串成首页选中的 agent；
 * 3. 具名根的 mountId 原样来自 /api/studio/workspaces，不允许用 label 或 workspaceId 顶替。
 *
 * 做法：加载真的 web/app.js（DEBUG 下它会把 workspaceView 挂到 window.__hana），
 * 用真 createWorkspaceService 解析一份真实形状的 /api/studio/workspaces 响应，
 * 只把视图的 setRoots/open 换成探针（不建 DOM、不发请求）。
 */

import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* 极简 DOM（与 tests/back_entry.test.mjs 同一套：在 Node 里跑真 app.js）    */
/* ------------------------------------------------------------------ */

const elements = {};
function makeEl(tag = 'div', id = '') {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    listeners: {},
    children: [],
    style: {},
    classList: {
      add(cls) {
        const current = (node.className || '').split(/\s+/).filter(Boolean);
        if (!current.includes(cls)) current.push(cls);
        node.className = current.join(' ');
      },
      remove(cls) {
        node.className = (node.className || '').split(/\s+/).filter((c) => c && c !== cls).join(' ');
      },
      contains(cls) {
        return (node.className || '').split(/\s+/).includes(cls);
      },
    },
    addEventListener(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    },
    removeEventListener(evt, fn) {
      if (this.listeners[evt]) this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn);
    },
    dispatchEvent(evt, data) {
      (this.listeners[evt] || []).forEach((f) => f(data));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    scrollHeight: 32,
  };
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements[id]) elements[id] = makeEl('div', id);
  return elements[id];
}

/* ------------------------------------------------------------------ */
/* 路由化 fetch：真实形状的宿主响应                                      */
/* ------------------------------------------------------------------ */

// 宿主 GET /api/studio/workspaces 的真实形状（父代理已核实 workspaces[].mountId）
const ROOTS_RESPONSE = {
  ok: true,
  studioId: 'studio-1',
  localDeviceName: 'qa-pc',
  workspaces: [
    { mountId: 'mount-alpha', workspaceId: 'ws-alpha', label: '项目 Alpha' },
    { mountId: 'mount-beta', workspaceId: 'ws-beta', label: '项目 Beta' },
  ],
};

const routes = {
  '/api/web-auth/session': { authenticated: true },
  '/api/mobile/bootstrap': {
    agents: [{ id: 'agent-home', name: 'Hakimi', isPrimary: true }],
    userName: 'qa',
    homeFolder: 'C:/work/workspace',
  },
  '/api/sessions': [],
  '/api/studio/workspaces': ROOTS_RESPONSE,
  '/api/mobile/workspace/files': { ok: true, files: [] },
};

const fetchLog = [];
globalThis.fetch = async (url) => {
  const key = String(url).split('?')[0];
  fetchLog.push(key);
  if (!(key in routes)) throw new Error(`unexpected fetch: ${key}`);
  const body = routes[key];
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
};

globalThis.location = { protocol: 'http:', host: 'localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  documentElement: { style: { setProperty() {} } },
  addEventListener: () => {},
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0 };
globalThis.WebSocket = class {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    this.readyState = 0;
  }
  addEventListener() {}
};

await import('../web/app.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, label, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

// __hana 在 DEBUG 下暴露真 workspaceView / S
await waitFor(() => globalThis.__hana, 'window.__hana 就绪');
const hana = globalThis.__hana;
await waitFor(() => hana.S?.currentAgent, 'boot 完成（S.currentAgent 就绪）');

const { workspaceView, S } = hana;
assert.equal(typeof workspaceView.setRoots, 'function', 'workspaceView 必须是真视图实例');

/** 用探针替换视图的写入口：只记录 app 传了什么，不建 DOM、不发请求。 */
let probe = null;
function armProbe() {
  probe = { setRoots: [], open: [] };
  workspaceView.setRoots = (roots) => {
    probe.setRoots.push(roots);
  };
  workspaceView.open = (opts) => {
    probe.open.push(opts);
    return Promise.resolve();
  };
  return probe;
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

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('首页入口: 默认根 + 具名根都传给 view，默认根 agentId 取自当前 Agent', async () => {
  S.currentAgent = { id: 'agent-home', name: 'Hakimi' };
  S.session = null;
  const p = armProbe();

  getEl('homeWorkspaceChip').dispatchEvent('click');
  await waitFor(() => p.setRoots.length > 0 && p.open.length > 0, '首页入口完成取根');

  assert.equal(p.setRoots.length, 1, '首页入口应只注入一次根列表');
  const roots = p.setRoots[0];
  assert.ok(Array.isArray(roots), `注入 view 的必须是数组，实际 ${typeof roots}`);

  const labels = roots.map((r) => r?.label);
  assert.deepEqual(
    labels,
    ['Agent 默认工作区', '项目 Alpha', '项目 Beta'],
    `具名根没有传给 view（app 层丢根）：${JSON.stringify(labels)}`
  );

  assert.equal(roots[0].mountId, 'default', '第一条必须是默认根');
  assert.equal(roots[0].agentId, 'agent-home', '默认根 agentId 必须取自 S.currentAgent.id');

  // 具名根身份只认宿主给的 mountId，不许拿 label / workspaceId 顶替
  assert.equal(roots[1].mountId, 'mount-alpha');
  assert.equal(roots[2].mountId, 'mount-beta');

  assert.equal(p.open.length, 1, '入口应打开一次默认工作区');
  assert.deepEqual(p.open[0], {
    mountId: 'default',
    agentId: 'agent-home',
    label: 'Agent 默认工作区',
  });
});

await t('聊天入口: 具名根仍在，默认根 agentId 取自当前 session 而不是首页 Agent', async () => {
  S.currentAgent = { id: 'agent-home', name: 'Hakimi' };
  S.session = { agentId: 'agent-session', path: 'p-1', sessionId: 'sess-1' };
  const p = armProbe();

  getEl('btnWorkspace').dispatchEvent('click');
  await waitFor(() => p.setRoots.length > 0 && p.open.length > 0, '聊天入口完成取根');

  const roots = p.setRoots[0];
  assert.deepEqual(
    roots.map((r) => r?.label),
    ['Agent 默认工作区', '项目 Alpha', '项目 Beta'],
    '聊天入口同样不能丢具名根'
  );
  assert.equal(
    roots[0].agentId,
    'agent-session',
    '聊天入口的默认根必须绑定当前会话 Agent（串成首页 Agent 会越权看别人的工作区）'
  );
  assert.equal(p.open[0].agentId, 'agent-session');
  assert.equal(p.open[0].mountId, 'default');
});

await t('具名根条数与宿主响应一致，不凭空增删', async () => {
  S.session = { agentId: 'agent-session', path: 'p-1', sessionId: 'sess-1' };
  const p = armProbe();

  getEl('btnWorkspace').dispatchEvent('click');
  await waitFor(() => p.setRoots.length > 0, '取根完成');

  const roots = p.setRoots[0];
  assert.equal(roots.length, 1 + ROOTS_RESPONSE.workspaces.length, '默认根 1 条 + 宿主具名根若干条');
  const named = roots.slice(1).map((r) => r.mountId);
  assert.deepEqual(named, ROOTS_RESPONSE.workspaces.map((w) => w.mountId));
  assert.ok(
    fetchLog.includes('/api/studio/workspaces'),
    '取根必须真的走 GET /api/studio/workspaces，而不是从 bootstrap 猜'
  );
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
