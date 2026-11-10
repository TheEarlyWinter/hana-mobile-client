/* tests/session_panel.test.mjs
 *
 * web/session-panel.js（抽屉 + 会话列表接线）的单元测试。
 *
 * 覆盖拆出去的这一块必须一模一样的行为：
 *   1. openDrawer / closeDrawer 只做三件事：mask.hidden、面板 'open' class、aria-hidden；
 *      dispose 之后四个 DOM 监听不再生效；
 *   2. loadSessions 走 list controller：onLoading 先 showLoading 并交空列表（宿主据此清
 *      S.sessions），onLoaded 把 list 交给 render / setList 与 onSessionsLoaded；
 *   3. onNamespaceChange 之后 namespace 变化，tabs 与新建按钮文案都跟着切；
 *   4. paint / row / sessionFolder 三个薄适配转发正确，sessionFolder 用 homeFolderOf 兜底；
 *   5. isDrawerOpen 就是 primeStartupAvatars 判断「抽屉开着别重画」的依据。
 *
 * 全部离线：假 DOM、假视图、假 api 由本文件提供；没有浏览器、没有定时器等待。
 */

import assert from 'node:assert/strict';
import { createSessionPanel } from '../web/session-panel.js';

/* ------------------------------------------------------------------ */
/* 假 DOM                                                             */
/* ------------------------------------------------------------------ */

function makeEl(tag = 'div', id = '') {
  const listeners = new Map();
  const classes = new Set();
  const attrs = new Map();
  const children = [];

  const node = {
    id,
    tagName: String(tag).toUpperCase(),
    hidden: false,
    textContent: '',
    children,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(key, value) {
      attrs.set(key, String(value));
    },
    getAttribute(key) {
      return attrs.has(key) ? attrs.get(key) : null;
    },
    removeAttribute(key) {
      attrs.delete(key);
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = node;
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    dispatch(type, extra = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn.call(node, { type, target: node, ...extra });
    },
    querySelector(selector) {
      const want = String(selector || '').toUpperCase();
      return children.find((child) => child.tagName === want) || null;
    },
  };

  return node;
}

function makeDoc() {
  const nodes = new Map();
  const getEl = (id) => {
    if (!id) return null;
    if (!nodes.has(id)) nodes.set(id, makeEl('div', id));
    return nodes.get(id);
  };

  // index.html 里抽屉遮罩自带 hidden；列表标签与新建按钮都预先存在。
  const mask = getEl('drawerMask');
  mask.hidden = true;
  getEl('drawerPanel');
  getEl('btnNamespaceHome');
  getEl('btnNamespaceCode');
  getEl('btnNew').appendChild(makeEl('span'));
  getEl('btnNewChat');

  return {
    getElementById: getEl,
    createElement: (tag) => makeEl(tag, ''),
    getEl,
  };
}

/* ------------------------------------------------------------------ */
/* 假 api / 假视图                                                    */
/* ------------------------------------------------------------------ */

function makeApi() {
  const calls = [];
  const pending = [];
  const api = (pathname) => {
    calls.push(pathname);
    return new Promise((resolve, reject) => pending.push({ pathname, resolve, reject }));
  };
  return { api, calls, pending };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function makeHarness({ api } = {}) {
  const doc = makeDoc();
  const viewCalls = { rendered: [], loading: 0, errors: [], rowArgs: [] };
  const lastRow = makeEl('div');

  const view = {
    render(list) {
      viewCalls.rendered.push(list);
    },
    row(s) {
      viewCalls.rowArgs.push(s);
      return lastRow;
    },
    showLoading() {
      viewCalls.loading += 1;
    },
    showError(error) {
      viewCalls.errors.push(error);
    },
  };

  const actionLists = [];
  const actionsView = {
    setList(list) {
      actionLists.push(list);
    },
  };

  const state = { sessions: null, loaded: [], homeFolder: 'ws-home', homeFolderCalls: 0 };
  const apiImpl = api || (async () => ({ sessions: [] }));

  const panel = createSessionPanel({
    document: doc,
    getElement: doc.getElementById,
    api: apiImpl,
    sessionListView: view,
    sessionActionsView: actionsView,
    onSessionsLoaded: (list) => {
      // 宿主在 onSessionsLoaded 里维护 S.sessions。
      state.sessions = list;
      state.loaded.push(list);
    },
    homeFolderOf: () => {
      state.homeFolderCalls += 1;
      return state.homeFolder;
    },
  });

  return { doc, panel, view, viewCalls, actionsView, actionLists, state, lastRow, apiImpl };
}

const pathsOf = (list) => (Array.isArray(list) ? list.map((s) => s.path) : list);

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('openDrawer / closeDrawer 只动 mask.hidden、open class 与 aria-hidden', () => {
  const { doc, panel } = makeHarness();
  const mask = doc.getEl('drawerMask');
  const panelEl = doc.getEl('drawerPanel');

  assert.equal(mask.hidden, true, '前置：遮罩默认 hidden');
  assert.equal(panelEl.classList.contains('open'), false, '前置：面板默认没开');

  panel.openDrawer();
  assert.equal(mask.hidden, false, '打开：mask.hidden 必须为 false');
  assert.equal(panelEl.classList.contains('open'), true, '打开：面板要有 open class');
  assert.equal(panelEl.getAttribute('aria-hidden'), 'false', '打开：aria-hidden 必须是 false');

  panel.closeDrawer();
  assert.equal(mask.hidden, true, '关闭：mask.hidden 必须为 true');
  assert.equal(panelEl.classList.contains('open'), false, '关闭：open class 要摘掉');
  assert.equal(panelEl.getAttribute('aria-hidden'), 'true', '关闭：aria-hidden 必须是 true');
});

t('四个抽屉监听都接上了：btnOpenDrawer / btnPeekRecent 打开，btnCloseDrawer / mask 关闭', () => {
  const { doc, panel } = makeHarness();
  const mask = doc.getEl('drawerMask');
  const panelEl = doc.getEl('drawerPanel');

  doc.getEl('btnOpenDrawer').dispatch('click');
  assert.equal(panel.isDrawerOpen(), true, 'btnOpenDrawer 应打开抽屉');

  doc.getEl('btnCloseDrawer').dispatch('click');
  assert.equal(panel.isDrawerOpen(), false, 'btnCloseDrawer 应关闭抽屉');

  doc.getEl('btnPeekRecent').dispatch('click');
  assert.equal(panel.isDrawerOpen(), true, 'btnPeekRecent 应打开抽屉');
  assert.equal(mask.hidden, false, '抽屉打开时遮罩要显示');

  mask.dispatch('click');
  assert.equal(panel.isDrawerOpen(), false, '点遮罩应关闭抽屉');
  assert.equal(mask.hidden, true, '关闭后遮罩要藏');
  assert.equal(panelEl.getAttribute('aria-hidden'), 'true');
});

t('isDrawerOpen 只看面板的 open class（primeStartupAvatars 的依据）', () => {
  const { panel } = makeHarness();
  assert.equal(panel.isDrawerOpen(), false, '初始应为关着');
  panel.openDrawer();
  assert.equal(panel.isDrawerOpen(), true, '打开后应为 true');
  panel.closeDrawer();
  assert.equal(panel.isDrawerOpen(), false, '关闭后应为 false');
});

t('dispose 摘掉四个 DOM 监听，之后的点击不再生效', () => {
  const { doc, panel } = makeHarness();
  const ids = ['btnOpenDrawer', 'btnPeekRecent', 'btnCloseDrawer', 'drawerMask'];

  for (const id of ids) {
    assert.equal(doc.getEl(id).listenerCount('click'), 1, `${id} 应各有一个 click 监听`);
  }

  panel.dispose();

  for (const id of ids) {
    assert.equal(doc.getEl(id).listenerCount('click'), 0, `dispose 后 ${id} 的监听应摘掉`);
  }

  doc.getEl('btnOpenDrawer').dispatch('click');
  doc.getEl('btnPeekRecent').dispatch('click');
  assert.equal(panel.isDrawerOpen(), false, 'dispose 后点打开按钮不应再打开抽屉');
  assert.equal(doc.getEl('drawerMask').hidden, true, 'dispose 后遮罩不应被改动');

  panel.openDrawer();
  doc.getEl('drawerMask').dispatch('click');
  assert.equal(panel.isDrawerOpen(), true, 'dispose 后点遮罩不应再关闭抽屉（监听已摘）');

  // 幂等：生命周期里 controller 与 tabs 两个槽位会各调一次。
  panel.dispose();
});

t('loadSessions 走 controller：显式 namespace、onLoaded 交 list 给 render / setList / onSessionsLoaded', async () => {
  const api = makeApi();
  const { panel, viewCalls, actionLists, state } = makeHarness({ api: api.api });

  const pending = panel.loadSessions();
  assert.deepEqual(api.calls, ['/api/sessions?namespace=home'], '默认按 home 拉列表');

  api.pending.shift().resolve({
    sessions: [
      { path: 'home-1', namespace: 'home' },
      { path: 'code-1', namespace: 'code' },
    ],
  });

  const list = await pending;
  assert.deepEqual(pathsOf(list), ['home-1'], '返回值是规范化后的当前 namespace 列表');

  assert.equal(viewCalls.rendered.at(-1), list, 'render 拿到的就是这份 list');
  assert.equal(actionLists.at(-1), list, 'setList 拿到的也是这份 list');
  assert.equal(state.sessions, list, 'onSessionsLoaded 把 list 交给宿主（S.sessions）');

  // 第一次回调是 onLoading 的空列表，第二次才是落地数据。
  assert.deepEqual(state.loaded.map(pathsOf), [[], ['home-1']], 'onLoading 先清空、onLoaded 再落地');
  assert.equal(viewCalls.loading, 1, 'onLoading 要 showLoading 一次');
});

t('loadSessions(namespace) 的 namespace 变化会切 tabs 与新建按钮文案', async () => {
  const { doc, panel, viewCalls } = makeHarness();

  assert.equal(panel.namespace, 'home', '初始筛选是 home');
  assert.equal(doc.getEl('btnNamespaceHome').getAttribute('aria-pressed'), 'true', '初始 home 标签高亮');
  assert.equal(doc.getEl('btnNew').getAttribute('title'), '新建 Chat 对话', '初始新建按钮写 Chat');

  doc.getEl('btnNamespaceCode').dispatch('click');
  assert.equal(panel.namespace, 'code', '点 Code 之后 namespace 要变');
  assert.equal(doc.getEl('btnNamespaceCode').getAttribute('aria-pressed'), 'true', 'Code 标签高亮');
  assert.equal(doc.getEl('btnNamespaceHome').getAttribute('aria-pressed'), 'false', 'Home 标签取消高亮');
  assert.equal(doc.getEl('btnNamespaceCode').classList.contains('is-active'), true, 'Code 标签要有 is-active');
  assert.equal(doc.getEl('btnNew').getAttribute('title'), '新建 Code 对话', '新建按钮文案跟着切 Code');
  assert.equal(doc.getEl('btnNew').getAttribute('aria-label'), '新建 Code 对话', 'aria-label 同步');
  assert.equal(doc.getEl('btnNew').querySelector('span').textContent, '新建 Code 对话', '带文字的那个按钮要改内部 span');

  await flush();
  assert.equal(viewCalls.loading, 1, '切筛选会走一次 onLoading');
});

t('paint / row / sessionFolder 三个适配都转发给对应的下游', () => {
  const { panel, viewCalls, lastRow, state } = makeHarness();

  const list = [{ path: 'a' }, { path: 'b' }];
  panel.paint(list);
  assert.equal(viewCalls.rendered.at(-1), list, 'paint 原样转给 view.render');

  const session = { path: 'p-1' };
  const rowEl = panel.row(session);
  assert.equal(rowEl, lastRow, 'row 原样转给 view.row');
  assert.equal(viewCalls.rowArgs.at(-1), session, 'row 的入参原样转给 view.row');

  // 行里带目录：取 basename，win32 / posix 两种分隔符都认。
  assert.equal(panel.sessionFolder({ cwd: 'C:/work/alpha' }), 'alpha');
  assert.equal(panel.sessionFolder({ workspace: '/srv/ws/beta' }), 'beta');
  assert.equal(panel.sessionFolder({ folder: 'C:/x/gamma/' }), 'gamma');

  // 行里没有目录：用 homeFolderOf 兜底（app 传的是 S.homeFolder）。
  const before = state.homeFolderCalls;
  assert.equal(panel.sessionFolder({}), 'ws-home', '每行都该问一次 homeFolderOf');
  assert.equal(panel.sessionFolder(null), 'ws-home', '空行也要兜底');
  assert.equal(state.homeFolderCalls - before, 2, 'homeFolderOf 是每次取，不是缓存');
});

t('onError 交给 view.showError，loadSessions 不 reject', async () => {
  const api = makeApi();
  const { panel, viewCalls } = makeHarness({ api: api.api });

  const pending = panel.loadSessions();
  api.pending.shift().reject(new Error('boom'));
  const result = await pending;

  assert.equal(result, undefined, '失败时解析为 undefined（调用方据此判断没落地）');
  assert.equal(viewCalls.errors.length, 1, '失败要交给 showError');
  assert.match(String(viewCalls.errors[0]?.message), /boom/);
  assert.equal(viewCalls.rendered.length, 0, '失败不能伪装成空列表');
});

t('reset 把筛选与新建按钮文案一起收回 Chat，且不额外发请求', async () => {
  const api = makeApi();
  const { doc, panel, state } = makeHarness({ api: api.api });

  const pending = panel.loadSessions('code');
  api.pending.shift().resolve({ sessions: [{ path: 'code-1', namespace: 'code' }] });
  await pending;
  assert.equal(panel.namespace, 'code', '前置：已切到 Code');
  const calls = api.calls.length;

  panel.reset();
  assert.equal(panel.namespace, 'home', 'reset 后筛选回 home');
  assert.equal(doc.getEl('btnNamespaceHome').getAttribute('aria-pressed'), 'true', 'Home 标签恢复高亮');
  assert.equal(doc.getEl('btnNew').getAttribute('title'), '新建 Chat 对话', '新建按钮文案回 Chat');
  assert.equal(api.calls.length, calls, 'reset 只是复位，不能再发请求');

  // reset 之后控制器仍可用：下一次 load 照常带当前（home）筛选。
  const again = panel.loadSessions();
  assert.equal(api.calls.at(-1), '/api/sessions?namespace=home');
  api.pending.shift().resolve({ sessions: [] });
  assert.deepEqual(await again, [], 'reset 之后仍能正常加载');
  assert.equal(state.sessions.length, 0);
});

t('dispose 之后 loadSessions 变成空操作（生命周期收尾）', async () => {
  const api = makeApi();
  const { panel } = makeHarness({ api: api.api });

  panel.dispose();
  const result = await panel.loadSessions();

  assert.equal(result, undefined, 'dispose 后 loadSessions 解析为 undefined');
  assert.deepEqual(api.calls, [], 'dispose 后不再发列表请求');
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error?.stack || error}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed) {
  console.log(`${failed} 个用例失败`);
  process.exitCode = 1;
}
