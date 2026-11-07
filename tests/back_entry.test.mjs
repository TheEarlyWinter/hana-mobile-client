/* Android 返回键：网页侧返回入口契约测试
 *
 * 背景：WebView 里的聊天界面是 SPA，`canGoBack()` 恒为 false，原生壳拿到返回键
 * 只能直接 finish()。所以回来问网页「这一下你能不能退」。
 *
 * 这份测试钉死网页侧必须守住的三件事：
 * 1. 只暴露一个返回函数（window.HanaMobile.back），不夹带任何能改地址/执行特权的接口；
 * 2. 聊天页返回 true（自己退到列表），并且真的把会话状态清干净、连接关掉；
 * 3. 已经在列表/登录页返回 false —— 把「退出 App」的决定权留给原生原策略。
 *
 * 另有工作区层级回归：预览打开时返回只关预览、面板保留；再返回才关面板，聊天仍在。
 * 那里用真的 workspaceView（面板/预览都由它自己建），不 mock 一个 back() 出来。
 */

import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* 极简 DOM（与 tests/send_race.test.mjs 同一套做法：在 Node 里跑真 app.js）   */
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
    insertBefore(child, ref) {
      const index = ref ? this.children.indexOf(ref) : -1;
      this.children.splice(index === -1 ? this.children.length : index, 0, child);
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
    removeAttribute() {},
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

globalThis.location = { protocol: 'http:', host: 'localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
const docBody = makeEl('body');
globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  documentElement: { style: { setProperty() {} } },
  addEventListener: () => {},
  body: docBody,
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
globalThis.fetch = async () => ({ ok: false });

await import('../web/app.js');

const S = globalThis.__hana.S;
const workspaceView = globalThis.__hana.workspaceView;
const settingsView = globalThis.__hana.settingsView;
const messageActionsMenu = globalThis.__hana.messageActionsMenu;
const sessionActionsView = globalThis.__hana.sessionActionsView;
const hook = globalThis.HanaMobile || globalThis.window?.HanaMobile;

let bad = 0;
async function t(name, fn) {
  resetEnv();
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** 每个用例从「什么都没有」开始，避免上一个用例的视图状态漏过来。 */
function resetEnv() {
  S.session = null;
  S.ws = null;
  S.wsReady = false;
  S.attach = [];
  S.homeAttach = [];
  getEl('view-login').hidden = true;
  getEl('view-list').hidden = true;
  getEl('view-chat').hidden = true;
  getEl('debug').hidden = true;
  getEl('attachSheet').hidden = true;
  getEl('transcript').children = [];
}

function enterChat() {
  S.session = { path: 'p-1', sessionId: 'sess-1', title: '会话' };
  getEl('view-login').hidden = true;
  getEl('view-list').hidden = true;
  getEl('view-chat').hidden = false;
}

function currentView() {
  if (getEl('view-chat').hidden === false) return 'chat';
  if (getEl('view-list').hidden === false) return 'list';
  if (getEl('view-login').hidden === false) return 'login';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('只暴露一个返回函数，没有特权入口', async () => {
  assert.ok(hook, 'app.js 必须在 window 上暴露返回入口（window.HanaMobile）');
  assert.equal(typeof hook.back, 'function', 'window.HanaMobile.back 必须是函数');
  assert.deepEqual(
    Object.keys(hook),
    ['back'],
    `返回入口只该有 back 一个键，实际：${JSON.stringify(Object.keys(hook))}`,
  );
  for (const forbidden of ['saveUrl', 'currentUrl', 'defaultUrl', 'load', 'exec', 'bridge']) {
    assert.equal(hook[forbidden], undefined, `不得暴露 ${forbidden}()`);
  }
  assert.ok(Object.isFrozen(hook), '返回入口应当冻结，避免被页面脚本换掉');
  assert.equal(globalThis.HanaBridge, undefined, '网页侧不得再依赖 HanaBridge');
});

await t('聊天页返回：退到列表并返回 true', async () => {
  enterChat();
  const handled = hook.back();
  assert.equal(handled, true, '聊天页的返回必须被网页消费（true），原生不该退出 App');
  assert.equal(currentView(), 'list', `期望退到列表，实际视图：${currentView()}`);
  assert.equal(S.session, null, '退列表时必须清掉当前会话');
});

await t('聊天页返回：关掉 WS 连接并复位就绪标志', async () => {
  enterChat();
  let closed = 0;
  S.ws = { close() { closed += 1; } };
  S.wsReady = true;
  hook.back();
  assert.equal(closed, 1, `期望关闭 1 次 WS，实际 ${closed} 次`);
  assert.equal(S.ws, null, '退列表后 S.ws 必须置空');
  assert.equal(S.wsReady, false, '退列表后 S.wsReady 必须为 false');
});

await t('列表页返回：返回 false，把退出策略留给原生', async () => {
  getEl('view-list').hidden = false;
  const handled = hook.back();
  assert.equal(handled, false, '列表页不该消费返回，原生继续走 canGoBack()/finish()');
  assert.equal(currentView(), 'list', '列表页返回不得改变视图');
});

await t('登录页返回：返回 false', async () => {
  getEl('view-login').hidden = false;
  assert.equal(hook.back(), false, '登录页不该消费返回');
  assert.equal(currentView(), 'login', '登录页返回不得改变视图');
});

await t('启动中（视图还没切）返回：返回 false，不误判成聊天', async () => {
  // 视图都没显示（hidden 为 undefined/true），此时不能吃掉返回键
  assert.equal(hook.back(), false, '任何视图都还没显示时不该消费返回');
});

await t('连续返回：先回列表再交回原生', async () => {
  enterChat();
  assert.equal(hook.back(), true, '第一下：聊天 → 列表');
  assert.equal(hook.back(), false, '第二下：列表 → 交回原生退出');
  assert.equal(currentView(), 'list');
});

await t('调试抽屉开着时先关抽屉，不退出 App', async () => {
  enterChat();
  getEl('debug').hidden = false;
  assert.equal(hook.back(), true, '抽屉开着时返回键应先收起抽屉');
  assert.equal(getEl('debug').hidden, true, '抽屉应被收起');
  assert.equal(currentView(), 'chat', '收起抽屉不应同时退出聊天');
});

await t('返回按钮与返回键入口行为一致', async () => {
  enterChat();
  getEl('btnBack').dispatchEvent('click');
  assert.equal(currentView(), 'list', '点返回按钮也必须回到列表');
  assert.equal(S.session, null, '点返回按钮也要清会话');
});

/* ------------------------------------------------------------------ */
/* 工作区返回：一次只退一层（真 workspaceView，不凭空 mock 新方法）     */
/* ------------------------------------------------------------------ */

/**
 * 预览层是否真的开着。
 *
 * 只看 workspaceView 自己挂在 body 上的预览弹层；测试不改 app、不读 view 内部变量。
 * 类名是 workspace-view 自己的输出（ensureDom 里的 'workspace-preview-modal'）。
 */
function previewModal() {
  const body = globalThis.document.body;
  if (!body) return null;
  return body.children.find((n) => String(n.className || '').split(/\s+/).includes('workspace-preview-modal')) || null;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : `HTTP ${status}`,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

await t('工作区预览返回：只关预览，面板和聊天都保留；再返回才关面板', async () => {
  enterChat();

  // 真 view 懒建 DOM 时要用 document.body；这个文件的其他用例不需要 body。
  if (!globalThis.document.body) globalThis.document.body = makeEl('body');

  const text = 'hello preview';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/mobile/workspace/files?')) {
      return jsonResponse({ ok: true, mountId: 'default', subdir: '', files: [{ name: 'notes.txt', isDir: false, size: text.length }] });
    }
    if (u.startsWith('/api/mobile/workspace/content-chunk?')) {
      return jsonResponse({
        ok: true,
        offset: 0,
        length: text.length,
        totalBytes: text.length,
        eof: true,
        data: Buffer.from(text, 'utf8').toString('base64'),
      });
    }
    throw new Error('unexpected fetch: ' + u);
  };

  // 用真 view：打开面板 + 真预览（previewFile 就是文件行点击调的同一个方法）。
  await workspaceView.open({ mountId: 'default', agentId: 'agent-1' });
  await workspaceView.previewFile('notes.txt');

  assert.equal(workspaceView.isOpen(), true, '夹具：工作区面板应已打开');
  assert.ok(previewModal(), '夹具：workspaceView 应已把预览弹层挂到 body');
  assert.equal(previewModal().hidden, false, '夹具：预览应已打开');

  // 第一下：只退预览。
  assert.equal(hook.back(), true, '预览打开时返回必须被网页消费');
  assert.equal(previewModal().hidden, true, '第一下返回应关掉预览');
  assert.equal(
    workspaceView.isOpen(),
    true,
    '预览返回只该关预览：面板必须仍然开着（当前 app 直接 close()，会把面板一起关掉）',
  );
  assert.equal(currentView(), 'chat', '关预览不应动聊天视图');

  // 第二下：关面板，聊天仍在。
  assert.equal(hook.back(), true, '面板还开着时返回仍应被网页消费');
  assert.equal(workspaceView.isOpen(), false, '第二下返回应关掉工作区面板');
  assert.equal(currentView(), 'chat', '关面板不应退出聊天');
  assert.notEqual(S.session, null, '关面板不应清掉当前会话');

  // 第三下：才回列表（原有行为）。
  assert.equal(hook.back(), true, '聊天页返回仍应回列表');
  assert.equal(currentView(), 'list');
  assert.equal(S.session, null);
});

/* ------------------------------------------------------------------ */
/* 附件选择 Sheet 返回链契约测试                                        */
/* ------------------------------------------------------------------ */

await t('主页打开附件 sheet 时按返回键：收起 sheet 且返回 true，不退页、不清草稿、不进原生', async () => {
  getEl('view-list').hidden = false;
  getEl('view-chat').hidden = true;
  getEl('homeInput').value = '保留主页草稿';
  S.homeAttach = [{ name: 'home.png', base64: 'data123' }];

  // 点击主页添加附件按钮打开 sheet
  getEl('btnHomeAttach').dispatchEvent('click');
  assert.equal(getEl('attachSheet').hidden, false, '点击主页附件按钮应打开 sheet');

  // 按返回键
  const handled = hook.back();
  assert.equal(handled, true, '主页打开附件 sheet 时按 BACK 必须被消费并返回 true，不进原生');
  assert.equal(getEl('attachSheet').hidden, true, '按 BACK 必须关闭 sheet');
  assert.equal(currentView(), 'list', '不得退页');
  assert.equal(getEl('homeInput').value, '保留主页草稿', '不得清草稿输入');
  assert.deepEqual(S.homeAttach, [{ name: 'home.png', base64: 'data123' }], '不得清已选附件');

  // 再次按返回键交回原生
  assert.equal(hook.back(), false, 'sheet 关闭后下一次返回交回原生');
  assert.equal(currentView(), 'list');
});

await t('聊天页打开附件 sheet 时按返回键：收起 sheet 且返回 true，不提前退到列表、不清草稿、沿用旧返回链', async () => {
  enterChat();
  getEl('input').value = '保留聊天草稿';
  S.attach = [{ name: 'chat.png', base64: 'data456' }];

  // 点击聊天页添加附件按钮打开 sheet
  getEl('btnAttach').dispatchEvent('click');
  assert.equal(getEl('attachSheet').hidden, false, '点击聊天页附件按钮应打开 sheet');

  // 按返回键
  const handled = hook.back();
  assert.equal(handled, true, '聊天页打开附件 sheet 时按 BACK 必须被消费并返回 true');
  assert.equal(getEl('attachSheet').hidden, true, '按 BACK 必须关闭 sheet');
  assert.equal(currentView(), 'chat', '只关 sheet，不得提前退回列表页');
  assert.notEqual(S.session, null, '只关 sheet，不得清空当前会话');
  assert.equal(getEl('input').value, '保留聊天草稿', '不得清空聊天输入草稿');
  assert.deepEqual(S.attach, [{ name: 'chat.png', base64: 'data456' }], '不得清空已选附件');

  // 再次按返回键：沿用旧返回链（聊天 -> 列表）
  assert.equal(hook.back(), true, 'sheet 关闭后按返回键沿旧返回链退到列表');
  assert.equal(currentView(), 'list', '退出聊天回到列表');
  assert.equal(S.session, null, '退出聊天清空当前会话');

  // 第三次按返回键：列表 -> 原生
  assert.equal(hook.back(), false, '列表页按返回键交回原生退出');
});

/* ------------------------------------------------------------------ */
/* 既有各层级返回不退化测试                                            */
/* ------------------------------------------------------------------ */

await t('既有层级返回不退化：设置面板打开时按返回键先关设置，不退页面', async () => {
  enterChat();
  if (settingsView && typeof settingsView.open === 'function') {
    settingsView.open();
    assert.equal(settingsView.isOpen(), true, '设置面板应已打开');

    assert.equal(hook.back(), true, '设置面板打开时返回键应被消费');
    assert.equal(settingsView.isOpen(), false, '返回键应关闭设置面板');
    assert.equal(currentView(), 'chat', '关设置不应退聊天');
    assert.notEqual(S.session, null, '关设置不应清会话');
  }
});

await t('既有层级返回不退化：消息操作菜单打开时按返回键先关菜单', async () => {
  enterChat();
  if (messageActionsMenu && typeof messageActionsMenu.open === 'function') {
    messageActionsMenu.open({
      message: { role: 'user', text: '测试' },
      context: { session: S.session },
    });
    assert.equal(messageActionsMenu.isOpen(), true, '消息操作菜单应已打开');

    assert.equal(hook.back(), true, '消息菜单打开时返回键应被消费');
    assert.equal(messageActionsMenu.isOpen(), false, '返回键应关闭消息菜单');
    assert.equal(currentView(), 'chat', '关消息菜单不应退聊天');
  }
});

await t('既有层级返回不退化：会话操作菜单打开时按返回键先关会话菜单', async () => {
  getEl('view-list').hidden = false;
  getEl('view-chat').hidden = true;
  if (sessionActionsView && typeof sessionActionsView.open === 'function') {
    sessionActionsView.setList([{ sessionId: 's1', title: '会话1' }]);
    sessionActionsView.open({ sessionId: 's1', title: '会话1' });
    assert.equal(sessionActionsView.isOpen(), true, '会话菜单应已打开');

    assert.equal(hook.back(), true, '会话菜单打开时返回键应被消费');
    assert.equal(sessionActionsView.isOpen(), false, '返回键应关闭会话菜单');
    assert.equal(currentView(), 'list', '关会话菜单保持在列表');
  }
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
