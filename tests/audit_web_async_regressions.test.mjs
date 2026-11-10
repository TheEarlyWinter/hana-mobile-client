/* Web 异步回归独立复审：直接调用真实 app/store/feature 方法，不复制业务逻辑。
 *
 * 覆盖 W1–W9，重点验证 W6 / W8 / W9 的身份边界与异步收尾。
 * 所有 app case 各自创建 app_harness；casual/archive case 各自注入真实 feature/store。
 * 请求用可控 Promise 挂起；不访问服务、浏览器或设备。每例结束都释放请求并清理自己创建的 timer。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createWebsocketClient } from '../web/websocket-client.js';
import { createSessionListView } from '../web/session-list-view.js';
import { openFilePreview } from '../web/file-preview.js';
import { createCasualFeature } from '../web/features/casual.js';
import { createArchiveFeature } from '../web/features/archive.js';

let failedCases = 0;
let passedCases = 0;
let skippedCases = 0;
let appImportSeq = 0;
const AUDIT_SKIP = Symbol('audit-skip');

function skipCase(reason) {
  return { [AUDIT_SKIP]: reason };
}

async function test(name, body) {
  try {
    const result = await body();
    if (result && result[AUDIT_SKIP]) {
      skippedCases += 1;
      console.log(`SKIP  ${name}\n      reason: ${result[AUDIT_SKIP]}`);
      return;
    }
    passedCases += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failedCases += 1;
    console.log(`FAIL  ${name}\n      ${String(error?.stack || error?.message || error).split('\n').join('\n      ')}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 追踪 app/harness 本例的 timer；finally 会逐一清除，避免测试把进程留住。 */
function trackGlobalTimers() {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const pendingTimeouts = new Set();
  const pendingIntervals = new Set();

  globalThis.setTimeout = (fn, ms, ...args) => {
    let handle;
    handle = original.setTimeout(() => {
      pendingTimeouts.delete(handle);
      fn(...args);
    }, ms);
    pendingTimeouts.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pendingTimeouts.delete(handle);
    return original.clearTimeout(handle);
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    const handle = original.setInterval(fn, ms, ...args);
    pendingIntervals.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    pendingIntervals.delete(handle);
    return original.clearInterval(handle);
  };

  return {
    clearAll() {
      for (const handle of pendingTimeouts) original.clearTimeout(handle);
      for (const handle of pendingIntervals) original.clearInterval(handle);
      pendingTimeouts.clear();
      pendingIntervals.clear();
    },
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
    },
  };
}

function makeRow(id, title = id, namespace = 'home') {
  return {
    path: `C:/sessions/${id}.jsonl`,
    sessionId: id,
    title,
    namespace,
    cwd: 'C:/work',
    agentId: 'agent-1',
    agentName: '同一助手',
    modified: 100,
  };
}

async function withApp(caseName, { initialSessions = [], onRequest = null } = {}, body) {
  const h = createHarness();
  h.getEl('homeScroll').appendChild(h.getEl('sessionList'));
  const timers = trackGlobalTimers();
  const requests = [];
  let hana = null;

  h.setFetch(async (url, init = {}) => {
    const fullUrl = String(url);
    const pathname = fullUrl.split('?')[0];
    const record = { url: fullUrl, pathname, init };
    requests.push(record);

    if (typeof onRequest === 'function') {
      const custom = await onRequest({ h, record, requests });
      if (custom !== undefined) return custom;
    }

    if (pathname === '/api/web-auth/session') {
      return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
    }
    if (pathname === '/api/mobile/bootstrap') {
      return h.jsonRes({
        agents: [{ id: 'agent-1', name: '同一助手', isPrimary: true }],
        currentAgent: { id: 'agent-1', name: '同一助手' },
        sessions: [],
        homeFolder: 'C:/work',
        auth: { token: 'fake-token' },
      });
    }
    if (pathname === '/api/sessions' && fullUrl.includes('namespace=')) {
      return h.jsonRes({ sessions: initialSessions });
    }
    if (pathname === '/api/sessions/archived') {
      return h.jsonRes({ sessions: [] });
    }
    if (pathname === '/api/sessions/new') {
      return h.jsonRes({
        path: 'C:/sessions/home-created.jsonl',
        sessionId: 'home-created',
        title: '新对话',
        namespace: 'home',
        agentId: 'agent-1',
        agentName: '同一助手',
      });
    }
    if (pathname === '/api/sessions/messages') {
      return h.jsonRes({ entries: [], hasMore: false, sessionFiles: [] });
    }
    if (pathname.startsWith('/api/casual/')) {
      if (pathname.endsWith('/summary')) return h.jsonRes({ unread: 0, preview: null });
      if (pathname.endsWith('/entries')) return h.jsonRes({ entries: [], hasMore: false, typing: false });
      return h.jsonRes({ ok: true, entries: [] });
    }
    return h.jsonRes({});
  });

  try {
    delete h.window.__hana;
    const moduleUrl = new URL('../web/app.js', import.meta.url);
    moduleUrl.searchParams.set('audit-case', `${++appImportSeq}-${caseName}`);
    await import(moduleUrl.href);
    await h.waitFor(
      () => Boolean(h.window.__hana?.S?.currentAgent) && h.getEl('view-list').hidden === false,
      `${caseName}: app boot`,
    );
    hana = h.window.__hana;
    return await body({ h, hana, requests });
  } finally {
    try {
      hana?.resetAfterLogout?.();
    } catch {
      // 本例的断言仍是主结果；timer 清理不能因 app teardown 异常而跳过。
    }
    for (const ws of h.MockWebSocket.instances) {
      try { ws.close(); } catch { /* fake socket */ }
    }
    timers.clearAll();
    timers.restore();
    delete h.window.__hana;
  }
}

function makeEntry(id, sourceEntryId = id, actor = 'agent', text = id) {
  return {
    id,
    sourceEntryId,
    actor,
    occurredAt: '2026-11-04T02:00:00.000Z',
    item: { kind: 'text', text },
  };
}

function makePage(entries = [], hasMore = false) {
  return { entries, hasMore, typing: false };
}

function makeCasualEnv() {
  const h = createHarness();
  const state = {
    principal: { id: 'user-1' },
    currentAgent: { id: 'agent-1', name: '同一助手' },
    agentName: '同一助手',
  };
  const calls = [];
  const handlers = {
    summary: () => ({ unread: 0, preview: null }),
    page: () => makePage(),
    send: () => ({ entryId: 'sent', entries: [], reset: false }),
    read: () => ({ ok: true }),
  };
  const api = async (path, init = {}) => {
    const call = { path: String(path), init };
    calls.push(call);
    if (call.path.endsWith('/summary')) return handlers.summary(call);
    if (call.path.includes('/entries')) return handlers.page(call);
    if (call.path.endsWith('/messages')) return handlers.send(call);
    if (call.path.endsWith('/read')) return handlers.read(call);
    return {};
  };
  const feature = createCasualFeature({
    state,
    getElement: h.getEl,
    api,
    flash: () => {},
    avatarUrl: () => null,
    document: h.doc,
  });
  return { h, state, calls, handlers, feature, store: feature.getStore() };
}

function seedNewCasualIdentity(env, { unread = 7, entry = makeEntry('new-user-entry') } = {}) {
  env.state.principal = { id: 'user-2' };
  env.feature.reset();
  assert.equal(env.store.getState().agentId, 'agent-1', '新身份仍使用同一个 Agent ID');
  env.store.applyEvent({ type: 'casual_entry', agentId: 'agent-1', entry });
  env.store.applyEvent({
    type: 'casual_unread',
    agentId: 'agent-1',
    unread,
    preview: { text: '新身份摘要', occurredAt: '2026-11-04T03:00:00.000Z' },
  });
}

async function withCasualEnv(body) {
  const env = makeCasualEnv();
  try {
    return await body(env);
  } finally {
    env.feature.reset();
  }
}

function makeArchiveEnv({ rows, apiOverride = null } = {}) {
  const h = createHarness();
  h.getEl('homeScroll').appendChild(h.getEl('sessionList'));
  let currentRows = rows || [];
  let principalId = 'user-1';
  const flashes = [];
  let restored = 0;
  const calls = [];
  const api = async (path, init = {}) => {
    const call = { path: String(path), init, principalId };
    calls.push(call);
    if (typeof apiOverride === 'function') {
      const custom = await apiOverride({ call, h, getRows: () => currentRows });
      if (custom !== undefined) return custom;
    }
    if (call.path === '/api/sessions/archived') return { sessions: currentRows };
    if (call.path === '/api/sessions/restore') return { ok: true };
    return {};
  };
  const feature = createArchiveFeature({
    getElement: h.getEl,
    api,
    flash: (text) => flashes.push(text),
    onRestored: () => { restored += 1; },
    document: h.doc,
  });
  feature.mount();
  return {
    h,
    feature,
    calls,
    flashes,
    get restored() { return restored; },
    setRows(value) { currentRows = value; },
    setPrincipal(value) { principalId = value; },
  };
}

/* -------------------------------- W1 / W2 -------------------------------- */

function runReconnectBoundary(allowAtFire) {
  const h = createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let timerId = 0;
  let allowReconnect = true;
  const state = { ws: null, wsReady: false, reconnectDelay: 5, pendingAbort: null, session: null };
  const client = createWebsocketClient({
    state,
    getSession: () => null,
    shouldReconnect: () => allowReconnect,
    getWebSocket: () => h.MockWebSocket,
    getLocation: () => ({ protocol: 'http:', host: 'offline.test' }),
  });

  globalThis.setTimeout = (fn, ms) => {
    timerId += 1;
    timers.set(timerId, { fn, ms });
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);

  try {
    client.connect();
    const first = state.ws;
    first.open();
    state.reconnectDelay = 5;
    first.serverClose();
    assert.equal(timers.size, 1, '应确实排入一个重连 timer');
    assert.equal(h.MockWebSocket.instances.length, 1);

    allowReconnect = allowAtFire;
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.fn();
    return h.MockWebSocket.instances.length;
  } finally {
    client.drop();
    timers.clear();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

await test('W1 无会话但闲聊仍活跃：重连 timer 按 shouldReconnect 决策', () => {
  assert.equal(runReconnectBoundary(true), 2,
    'getSession() 为 null 不能压过 shouldReconnect()=true');
  assert.equal(runReconnectBoundary(false), 1,
    'timer 执行时 shouldReconnect()=false 必须抑制重连');
});

await test('W2 真实列表按 pinned 布尔状态分组，不被陈旧 pinnedAt 覆盖', () => {
  const h = createHarness();
  const container = h.getEl('sessionList');
  const view = createSessionListView({
    document: h.doc,
    container,
    getContext: () => ({ agentName: '同一助手', homeFolder: 'C:/work', agents: [] }),
    onOpenSession: () => {},
    now: () => Date.parse('2026-11-04T12:00:00.000Z'),
  });
  const rows = [
    { path: 'C:/sessions/unpinned.jsonl', title: '已取消置顶', pinned: false, pinnedAt: '2026-11-03T00:00:00Z', modified: 2 },
    { path: 'C:/sessions/pinned.jsonl', title: '刚置顶', pinned: true, modified: 1 },
  ];

  view.render(rows);

  const labels = h.findAll(container, '.group-label').map((node) => node.textContent);
  const titles = h.findAll(container, '.session-item')
    .map((node) => h.find(node, '.session-title')?.textContent || '');
  assert.equal(labels[0], '置顶', '置顶组必须排在日期组之前');
  assert.equal(titles[0], '刚置顶', '仅 pinned=true 的行进入置顶组');
  assert.equal(titles.includes('已取消置顶'), true, 'pinned=false 必须压过旧 pinnedAt');
  assert.equal(titles.at(-1), '已取消置顶');
});

/* -------------------------------- W3 -------------------------------- */

await test('W3 返回层级：设置 > 归档 > 贴纸抽屉 > 闲聊 > 搜索；每次只消费最上层', async () => {
  await withApp('w3-real-return-stack', {}, async ({ h, hana }) => {
    const archive = hana.features.get('archive');
    const casual = hana.casual;
    const search = hana.features.get('search');
    await archive.open();
    casual.open();
    const stickerButton = h.allNodes.find((node) => node.className?.split(/\s+/).includes('casual-header-sticker'));
    assert.ok(stickerButton, '真实闲聊视图应提供贴纸入口');
    stickerButton.dispatchEvent('click');
    search.open();
    hana.settingsView.open();

    const archivePanel = h.find(h.body, '.archive-panel');
    const casualPanel = h.find(h.body, '.casual-view');
    const stickerPanel = h.find(h.body, '.casual-sticker-overlay');
    assert.equal(hana.settingsView.isOpen(), true);
    assert.equal(archive.isOpen(), true);
    assert.equal(casual.isOpen(), true);
    assert.equal(search.isOpen(), true);
    assert.equal(stickerPanel?.hidden, false);

    const back = h.window.HanaMobile.back;
    assert.equal(back(), true, '设置层应消费第一次返回');
    assert.equal(hana.settingsView.isOpen(), false);
    assert.equal(archive.isOpen(), true, '关设置不能连带关归档');

    assert.equal(back(), true, '归档层应先于低层闲聊关闭');
    assert.equal(archivePanel.hidden, true);
    assert.equal(casual.isOpen(), true);
    assert.equal(search.isOpen(), true);

    assert.equal(back(), true, '贴纸抽屉应先于闲聊面板关闭');
    assert.equal(stickerPanel.hidden, true);
    assert.equal(casualPanel.hidden, false);

    assert.equal(back(), true, '贴纸收起后再关闭闲聊');
    assert.equal(casualPanel.hidden, true);
    assert.equal(search.isOpen(), true);

    assert.equal(back(), true, '剩余搜索浮层再消费一次返回');
    assert.equal(search.isOpen(), false);
    assert.equal(h.getEl('view-list').hidden, false, '退浮层不能退出底层列表');
  });
});

// 不把「搜索浮层与消息操作菜单同时打开」作为契约：搜索层是 fixed/inset:0 的全屏遮罩，
// 且对话框标记 aria-modal；消息菜单也覆盖整个视口。用户操作搜索时触不到被遮罩的 transcript，
// 只能从该 transcript 长按/右键打开消息菜单；反向打开时，消息菜单也遮住搜索入口。
// 搜索结果选择会关闭搜索层，不提供同时打开消息菜单的入口。旧用例只靠直接调用两个 controller API
// 强行共存，无法代表产品交互；真实搜索入口与真实消息菜单返回分别由下方 W3 用例覆盖。


await test('W3 真实入口：搜索结果关闭搜索并进入聊天，真实消息菜单返回不退出会话', async () => {
  await withApp('w3-real-search-to-message-menu', {
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=title')) {
        return h.jsonRes({ results: [{
          path: 'C:/sessions/w3-real-entry.jsonl',
          sessionId: 'w3-real-entry',
          title: '真实搜索结果',
          agentId: 'agent-1',
          agentName: '同一助手',
          cwd: 'C:/work',
        }] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=content')) {
        return h.jsonRes({ results: [] });
      }
      return undefined;
    },
  }, async ({ h, hana }) => {
    const search = hana.features.get('search');
    const searchButton = h.allNodes.find((node) => node.id === 'btnSearch');
    assert.ok(searchButton, '搜索入口必须通过主页真实按钮挂载');
    searchButton.dispatchEvent('click');
    assert.equal(search.isOpen(), true);

    const input = h.find(h.body, '.message-search-input');
    input.value = 'w3-real-entry';
    input.dispatchEvent('input');
    await h.waitFor(() => h.findAll(h.body, '.message-search-item').length === 1, '真实搜索结果出现');
    h.findAll(h.body, '.message-search-item')[0].dispatchEvent('click');

    await h.waitFor(() => hana.S.session?.path === 'C:/sessions/w3-real-entry.jsonl', '真实搜索结果打开会话');
    await h.waitFor(() => h.getEl('view-chat').hidden === false, '进入聊天视图');
    assert.equal(search.isOpen(), false, '选择结果必须先关闭搜索浮层');
    const activeSession = hana.S.session;
    assert.ok(activeSession, '当前聊天会话必须真实存在');

    hana.appendUser('真实渲染的用户消息');
    const transcript = h.getEl('transcript');
    const turn = h.find(transcript, '.turn');
    assert.ok(turn, '消息必须由真实 renderer 写入 transcript');
    transcript.dispatchEvent('contextmenu', { target: turn });
    assert.equal(hana.messageActionsMenu.isOpen(), true, 'contextmenu 必须走 app 的真实消息菜单入口');
    assert.equal(search.isOpen(), false);

    assert.equal(h.window.HanaMobile.back(), true);
    assert.equal(hana.messageActionsMenu.isOpen(), false, '返回只关闭真实消息菜单');
    assert.equal(search.isOpen(), false);
    assert.equal(hana.S.session, activeSession, '返回不能退出当前搜索结果会话');
    assert.equal(h.getEl('view-chat').hidden, false, '底层聊天视图必须保留');
  });
});

/* -------------------------------- W4 -------------------------------- */

async function selectRealSearchResult(h, query = 'needle') {
  const search = h.find(h.body, '.message-search-input');
  assert.ok(search, '真实搜索面板必须有输入框');
  search.value = query;
  search.dispatchEvent('input');
  await h.waitFor(() => h.findAll(h.body, '.message-search-item').length > 0, '搜索结果出现');
  h.findAll(h.body, '.message-search-item')[0].dispatchEvent('click');
}

await test('W4 搜索时 namespace 固定；跨 namespace 等待期间打开仍使用搜索结果元数据', async () => {
  const resultGate = deferred();
  const result = {
    path: 'C:/sessions/api-result.jsonl',
    sessionId: 'api-session',
    title: '搜索结果自带元数据',
    agentId: 'agent-from-search',
    agentName: '搜索命中的助手',
    cwd: 'D:/repos/search-repo',
    workspaceMountId: 'mount-from-search',
    workspaceLabel: '搜索工作区',
  };
  await withApp('w4-search-namespace-snapshot', {
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/sessions' && record.url.includes('namespace=code')) {
        return h.jsonRes({ sessions: [] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=title')) {
        return resultGate.promise;
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=content')) {
        return h.jsonRes({ results: [] });
      }
      return undefined;
    },
  }, async ({ h, hana, requests }) => {
    try {
      h.getEl('btnNamespaceCode').dispatchEvent('click');
      const searchFeature = hana.features.get('search');
      searchFeature.open();
      const input = h.find(h.body, '.message-search-input');
      input.value = 'needle';
      input.dispatchEvent('input');
      await h.waitFor(() => requests.some((request) => request.pathname === '/api/sessions/search'
        && request.url.includes('phase=title')), 'title phase 发出');

      // 模拟请求在途期间 namespace 改变；响应仍应沿用发起搜索时的 code。
      h.getEl('btnNamespaceHome').dispatchEvent('click');
      assert.equal(h.getEl('btnNamespaceHome').getAttribute('aria-pressed'), 'true');
      resultGate.resolve(h.jsonRes({ results: [result] }));
      await h.waitFor(() => h.findAll(h.body, '.message-search-item').length > 0, '搜索结果出现');
      h.findAll(h.body, '.message-search-item')[0].dispatchEvent('click');

      assert.equal(hana.S.session?.namespace, 'code', '打开结果不能读取点击时的新 namespace');
      assert.equal(hana.S.session?.agentId, 'agent-from-search');
      assert.equal(hana.S.session?.agentName, '搜索命中的助手');
      assert.equal(hana.S.session?.folder, 'search-repo');
      assert.equal(hana.S.session?.workspaceMountId, 'mount-from-search');
      assert.equal(hana.S.session?.workspaceLabel, '搜索工作区');
    } finally {
      resultGate.resolve(h.jsonRes({ results: [] }));
    }
  });
});

await test('W4 搜索元数据缺失时按规范化 path 从真实 S.sessions 补齐，不猜全局 Agent', async () => {
  const cached = {
    path: 'C:\\Work\\Cached.JSONL',
    sessionId: 'cached-session',
    title: '列表缓存行',
    namespace: 'code',
    agentId: 'agent-cached',
    agentName: '缓存助手',
    cwd: 'E:/cached-project',
    workspaceMountId: 'mount-cached',
    workspaceLabel: '缓存工作区',
  };
  await withApp('w4-search-cache-enrichment', {
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/sessions' && record.url.includes('namespace=code')) {
        return h.jsonRes({ sessions: [cached] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=title')) {
        return h.jsonRes({ results: [{ path: 'c:/work/cached.jsonl', sessionId: 'cached-session', title: '命中标题' }] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=content')) {
        return h.jsonRes({ results: [] });
      }
      return undefined;
    },
  }, async ({ h, hana }) => {
    h.getEl('btnNamespaceCode').dispatchEvent('click');
    await h.waitFor(() => hana.S.sessions.length === 1, 'Code 列表加载');
    hana.features.get('search').open();
    await selectRealSearchResult(h);

    assert.equal(hana.S.session?.agentId, 'agent-cached');
    assert.equal(hana.S.session?.agentName, '缓存助手');
    assert.equal(hana.S.session?.folder, 'cached-project');
    assert.equal(hana.S.session?.workspaceMountId, 'mount-cached');
    assert.equal(hana.S.session?.workspaceLabel, '缓存工作区');
    assert.equal(hana.S.session?.namespace, 'code');
  });
});

await test('W4 搜索与缓存都没有 agent 元数据时保持 null，不借用当前 Agent', async () => {
  await withApp('w4-search-no-guess', {
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/sessions' && record.url.includes('namespace=code')) {
        return h.jsonRes({ sessions: [] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=title')) {
        return h.jsonRes({ results: [{ path: 'C:/sessions/unknown.jsonl', sessionId: 'unknown', title: '未知会话' }] });
      }
      if (record.pathname === '/api/sessions/search' && record.url.includes('phase=content')) {
        return h.jsonRes({ results: [] });
      }
      return undefined;
    },
  }, async ({ h, hana }) => {
    h.getEl('btnNamespaceCode').dispatchEvent('click');
    await h.waitFor(() => hana.S.sessions.length === 0 && h.getEl('btnNamespaceCode').getAttribute('aria-pressed') === 'true', 'Code namespace');
    hana.features.get('search').open();
    await selectRealSearchResult(h);

    assert.equal(hana.S.session?.agentId, null, '不能用当前全局 agent 补未知搜索结果');
    assert.equal(hana.S.session?.agentName, null, '不能借用当前 Agent 的显示名冒充归属');
    assert.equal(hana.S.session?.namespace, 'code');
  });
});

/* -------------------------------- W5 -------------------------------- */

await test('W5 闲聊首次打开：未等 API 响应就同步把真实 Agent 状态送进 view', async () => {
  await withCasualEnv(async (env) => {
    env.feature.mount();
    const summaryGate = deferred();
    const pageGate = deferred();
    env.handlers.summary = () => summaryGate.promise;
    env.handlers.page = () => pageGate.promise;
    const title = env.h.find(env.h.body, '.casual-header-title');

    try {
      env.feature.open();
      assert.equal(env.store.getState().loading, true, '首屏请求启动时应同步进入 loading');
      assert.equal(title.textContent, '同一助手', 'onState 的同步 loading emit 必须初始化标题与 Agent 展示');
      assert.equal(env.store.getState().agentId, 'agent-1');
    } finally {
      env.feature.reset();
      summaryGate.resolve({ unread: 0, preview: null });
      pageGate.resolve(makePage());
      await env.h.settle(4);
    }
  });
});

await test('W5 切 Agent：同一 feature/store 绑定新 Agent，旧 badge summary 与旧 WS 事件不覆盖', async () => {
  await withCasualEnv(async (env) => {
    env.feature.mount();
    const badge = env.h.find(env.h.getEl('homeHeadActions'), '.casual-dot');
    assert.ok(badge, '入口必须挂载角标');
    const oldSummary = deferred();
    env.handlers.summary = (call) => call.path.includes('/agent-1/')
      ? oldSummary.promise
      : { unread: 3, preview: null };
    let oldRefresh;

    try {
      oldRefresh = env.feature.refreshBadge();
      env.state.currentAgent = { id: 'agent-2', name: '第二助手' };
      env.feature.setAgent();
      await env.h.waitFor(() => badge.textContent === '3' && !badge.hidden, '新 Agent badge 到达');

      oldSummary.resolve({ unread: 99, preview: null });
      await oldRefresh;
      assert.equal(env.store.getState().agentId, 'agent-2', 'store 必须切到新 Agent');
      assert.equal(badge.textContent, '3', '旧 Agent 的迟到 summary 不得覆盖新角标');

      assert.equal(env.feature.handleSocketMessage({
        type: 'casual_unread', agentId: 'agent-2', unread: 4,
        preview: { text: '新身份消息', occurredAt: '2026-11-04T03:00:00.000Z' },
      }), true);
      assert.equal(badge.textContent, '4', '新 Agent 的 WS unread 应同步刷新未打开面板的角标');
      env.feature.handleSocketMessage({
        type: 'casual_unread', agentId: 'agent-1', unread: 8,
        preview: { text: '旧身份消息', occurredAt: '2026-11-04T03:00:00.000Z' },
      });
      assert.equal(badge.textContent, '4', '旧 Agent 的 WS 事件不得改变新角标');
    } finally {
      oldSummary.resolve({ unread: 99, preview: null });
      await oldRefresh?.catch(() => {});
    }
  });
});

/* -------------------------------- W6 -------------------------------- */

await test('W6 active archive: 请求未成功前保持当前会话', async () => {
  const row = makeRow('active', '活动会话');
  const gate = deferred();
  await withApp('w6-active-archive-pending', {
    initialSessions: [row],
    onRequest: ({ record }) => record.pathname === '/api/sessions/archive' ? gate.promise : undefined,
  }, async ({ h, hana, requests }) => {
    await hana.openSession(row);
    const activeSession = hana.S.session;
    assert.ok(activeSession, '测试前必须处于活动会话');

    const action = hana.sessionActions.archive(row);
    assert.ok(requests.some((request) => request.pathname === '/api/sessions/archive'),
      '必须实际发出归档请求，不能让 UI 渲染错误造成假绿');
    try {
      assert.equal(hana.S.session, activeSession,
        '归档请求 pending 时不能因乐观移除列表项而退出当前会话');
      assert.equal(hana.S.session?.path, row.path, 'pending 期间当前会话身份不变');
      assert.equal(hana.S.sessions.some((item) => item.path === row.path), false,
        '列表可乐观移除，但不能据此退出活动会话');
    } finally {
      gate.resolve(h.jsonRes({ ok: true }));
      await action;
    }
    assert.equal(hana.S.session, null, '归档成功后才退出原活动会话');
    assert.equal(hana.S.sessions.some((item) => item.path === row.path), false);
  });
});

await test('W6 active archive: 失败必须回到原会话，不能停在列表页', async () => {
  const row = makeRow('active-fail', '活动会话');
  const gate = deferred();
  await withApp('w6-active-archive-failure', {
    initialSessions: [row],
    onRequest: ({ record }) => record.pathname === '/api/sessions/archive' ? gate.promise : undefined,
  }, async ({ hana, requests }) => {
    await hana.openSession(row);
    const activeSession = hana.S.session;
    const action = hana.sessionActions.archive(row);
    try {
      assert.ok(requests.some((request) => request.pathname === '/api/sessions/archive'),
        '必须实际发出归档请求');
      gate.reject(new Error('归档失败'));
      await action;
      assert.equal(hana.S.session, activeSession, '归档失败后仍应显示原活动会话');
      assert.equal(hana.S.session?.path, row.path);
    } finally {
      gate.reject(new Error('cleanup: 归档请求未完成'));
      await action.catch(() => {});
    }
  });
});

await test('W6 其他列表行操作不能把不在当前筛选列表中的活动会话退掉', async () => {
  const active = makeRow('active-code', '当前 Code 会话', 'code');
  const other = makeRow('other-home', '当前筛选里的另一行', 'home');
  const gate = deferred();
  await withApp('w6-filtered-list-other-action', {
    initialSessions: [other],
    onRequest: ({ record }) => record.pathname === '/api/sessions/pin' ? gate.promise : undefined,
  }, async ({ hana, requests }) => {
    await hana.openSession(active);
    const activeSession = hana.S.session;
    assert.ok(activeSession, '测试前必须处于 Code 会话');

    const action = hana.sessionActions.togglePin(other);
    try {
      assert.ok(requests.some((request) => request.pathname === '/api/sessions/pin'),
        '必须实际执行其他行置顶请求');
      assert.equal(hana.S.session, activeSession,
        '对筛选列表中的其他行置顶，不得把当前但未列出的会话当成已归档');
    } finally {
      gate.resolve({ ok: true });
      await action;
    }
  });
});

await test('W6 logout/relogin: 旧身份的延迟 rename 失败不得向新身份 flash', async () => {
  const oldRow = makeRow('old-user', '旧标题');
  const gate = deferred();
  await withApp('w6-old-rename-error', {
    initialSessions: [oldRow],
    onRequest: ({ record }) => record.pathname === '/api/sessions/rename' ? gate.promise : undefined,
  }, async ({ h, hana, requests }) => {
    const action = hana.sessionActions.rename(oldRow, '旧用户的新标题');
    try {
      assert.ok(requests.some((request) => request.pathname === '/api/sessions/rename'),
        '必须先实际启动旧身份 rename');
      hana.resetAfterLogout();
      hana.S.principal = { id: 'user-2' };
      const newRows = [makeRow('new-user', '新用户会话')];
      hana.S.sessions = newRows;

      gate.reject(new Error('旧用户请求失败'));
      const result = await action;

      assert.equal(result?.stale, true, '旧 owner 回调应被标为 stale');
      assert.equal(hana.S.sessions, newRows, '旧身份回滚不得替换新身份列表引用');
      const flash = h.allNodes.find((node) => node.id === 'flashBar' && !node.hidden);
      assert.equal(flash?.textContent || '', '', '旧身份错误不得显示在新身份界面');
    } finally {
      gate.reject(new Error('cleanup: rename 请求未完成'));
      await action.catch(() => {});
    }
  });
});

await test('W6 rename 回滚：活动会话已切走时，只恢复原行，不改新活动会话标题', async () => {
  const renamed = makeRow('rename-target', '旧会话标题');
  const nextActive = makeRow('next-active', '新活动标题');
  const gate = deferred();
  await withApp('w6-same-session-rollback', {
    initialSessions: [renamed, nextActive],
    onRequest: ({ record }) => record.pathname === '/api/sessions/rename' ? gate.promise : undefined,
  }, async ({ hana, requests }) => {
    let action;
    try {
      await hana.openSession(renamed);
      action = hana.sessionActions.rename(renamed, '乐观新标题');
      assert.ok(requests.some((request) => request.pathname === '/api/sessions/rename'),
        'rename 请求必须真实进入 pending');
      assert.equal(hana.S.session.title, '乐观新标题', '活动目标行可乐观更新标题');

      await hana.openSession(nextActive);
      gate.reject(new Error('rename 保存失败'));
      const result = await action;

      assert.equal(result?.ok, false);
      assert.equal(hana.S.session?.path, nextActive.path);
      assert.equal(hana.S.session?.title, '新活动标题', '旧 rename 回滚不得改写已切换的活动会话');
      assert.equal(hana.S.sessions.find((item) => item.path === renamed.path)?.title, '旧会话标题',
        '原行只恢复自己的旧标题');
    } finally {
      gate.reject(new Error('cleanup: rename 请求未完成'));
      await action?.catch(() => {});
    }
  });
});

/* -------------------------------- W8 -------------------------------- */

async function runHomeListFailure(caseName) {
  let listCalls = 0;
  return withApp(caseName, {
    initialSessions: [],
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/sessions' && record.url.includes('namespace=home')) {
        listCalls += 1;
        if (listCalls > 1) return h.jsonRes({ error: '列表暂不可用' }, { ok: false, status: 503 });
      }
      return undefined;
    },
  }, async ({ h, hana, requests }) => {
    const homeInput = h.getEl('homeInput');
    homeInput.value = 'list-failure-draft';
    const MockWebSocket = h.MockWebSocket;
    h.window.WebSocket = class AutoOpenWebSocket extends MockWebSocket {
      constructor(url) {
        super(url);
        queueMicrotask(() => this.open());
      }
    };
    const sending = hana.sendFromHome();
    try {
      await sending;
      const promptFrames = h.MockWebSocket.instances.flatMap((socket) => socket.frames('prompt'));
      return {
        draft: homeInput.value,
        promptTexts: promptFrames.map((frame) => frame.text),
        listCalls,
        createCalls: requests.filter((request) => request.pathname === '/api/sessions/new').length,
        openedPath: hana.S.session?.path || null,
      };
    } finally {
      for (const socket of h.MockWebSocket.instances) socket.open();
      await sending.catch(() => {});
    }
  });
}

await test('W8 create 成功但 home 列表失败：首页草稿仍保留', async () => {
  const observed = await runHomeListFailure('w8-draft-retained');
  assert.equal(observed.listCalls, 2, '必须确实经历启动列表成功、发送后列表失败');
  assert.equal(observed.createCalls, 1, '测试必须确实创建了新会话');
  assert.equal(observed.draft, 'list-failure-draft', '列表刷新失败不能清掉首页草稿');
  assert.equal(observed.openedPath, null, '列表刷新失败时不得进入半初始化会话');
});

await test('W8 create 成功但 home 列表失败：不能把草稿继续发送', async () => {
  const observed = await runHomeListFailure('w8-no-send-after-list-failure');
  assert.equal(observed.createCalls, 1, '测试必须到达 create 成功');
  assert.equal(observed.openedPath, null, '失败列表不能放行进入发送流程');
  assert.deepEqual(observed.promptTexts, [], '列表失败时不得向 WebSocket 发送首页草稿');
});

/* -------------------------------- W9 casual store -------------------------------- */

await test('W9 app logout/relogin：真实 resetAfterLogout 使同 Agent 的闲聊旧请求失效', async () => {
  const oldSummary = deferred();
  const oldPage = deferred();
  const newRead = deferred();
  let identity = 'user-1';
  let activePhase = 'boot';
  await withApp('w9-casual-app-reset-same-agent', {
    onRequest: ({ h, record }) => {
      if (record.pathname.endsWith('/summary') && record.pathname.startsWith('/api/casual/')) {
        if (activePhase === 'boot') return h.jsonRes({ unread: 0, preview: null });
        if (identity === 'user-1') return oldSummary.promise;
        return h.jsonRes({ unread: 7, preview: { text: '新身份摘要', occurredAt: '2026-11-04T03:00:00.000Z' } });
      }
      if (record.pathname.endsWith('/entries') && record.pathname.startsWith('/api/casual/')) {
        if (identity === 'user-1') return oldPage.promise;
        return h.jsonRes({ entries: [makeEntry('new-login-entry')], hasMore: false, typing: false });
      }
      if (record.pathname.endsWith('/read') && identity === 'user-2') return newRead.promise;
      return undefined;
    },
  }, async ({ h, hana, requests }) => {
    let oldRefresh;
    let newRefresh;
    try {
      activePhase = 'requests';
      hana.casual.open();
      oldRefresh = hana.casual.getStore().refresh();
      await h.waitFor(() => requests.some((request) => request.pathname.endsWith('/summary'))
        && requests.some((request) => request.pathname.endsWith('/entries')), '旧身份 summary 和 entries 都在途');

      hana.resetAfterLogout();
      identity = 'user-2';
      hana.S.principal = { id: identity };
      assert.equal(hana.S.currentAgent.id, 'agent-1', '新身份沿用相同 Agent');
      const newRequestStart = requests.length;
      hana.casual.open();
      newRefresh = hana.casual.getStore().refresh();
      await newRefresh;
      const newRequests = requests.slice(newRequestStart).filter((request) => request.pathname.startsWith('/api/casual/'));
      assert.ok(newRequests.some((request) => request.pathname.endsWith('/summary')),
        `新身份应重新拉 summary：${newRequests.map((request) => request.url).join(', ')}`);
      assert.ok(newRequests.some((request) => request.pathname.endsWith('/entries')),
        `新身份应重新拉 entries：${newRequests.map((request) => request.url).join(', ')}`);
      assert.equal(hana.casual.getStore().getState().unread, 7,
        `新身份 read 回执仍 pending 时 unread 应保持；calls=${newRequests.map((request) => request.url).join(', ')}`);
      assert.deepEqual(hana.casual.getStore().getState().entries.map((entry) => entry.id), ['new-login-entry']);

      oldSummary.resolve(h.jsonRes({ unread: 99, preview: { text: '旧身份摘要', occurredAt: '2026-11-04T01:00:00.000Z' } }));
      oldPage.resolve(h.jsonRes({ entries: [makeEntry('old-login-entry')], hasMore: false, typing: false }));
      await oldRefresh;
      assert.equal(hana.casual.getStore().getState().unread, 7);
      assert.deepEqual(hana.casual.getStore().getState().entries.map((entry) => entry.id), ['new-login-entry']);
    } finally {
      oldSummary.resolve(h.jsonRes({ unread: 99, preview: null }));
      oldPage.resolve(h.jsonRes({ entries: [makeEntry('old-login-entry')], hasMore: false, typing: false }));
      newRead.resolve(h.jsonRes({ ok: true }));
      await Promise.all([oldRefresh, newRefresh].filter(Boolean).map((task) => task.catch(() => {})));
      await h.settle(4);
    }
  });
});

await test('W9 casual refresh 成功迟到：同 Agent 新身份的数据不能被旧响应覆盖/混入', async () => {
  await withCasualEnv(async (env) => {
    const summaryGate = deferred();
    const pageGate = deferred();
    env.handlers.summary = () => summaryGate.promise;
    env.handlers.page = () => pageGate.promise;
    const refresh = env.store.refresh();

    seedNewCasualIdentity(env, { entry: makeEntry('new-refresh') });
    summaryGate.resolve({ unread: 1, preview: { text: '旧身份摘要', occurredAt: '2026-11-04T01:00:00.000Z' } });
    pageGate.resolve(makePage([makeEntry('old-refresh')], false));
    await refresh;

    assert.deepEqual(env.store.getState().entries.map((entry) => entry.id), ['new-refresh'],
      '旧 refresh 不能把旧身份条目并入新身份');
    assert.equal(env.store.getState().unread, 7, '旧 refresh 不能覆盖新身份未读数');
  });
});

await test('W9 casual refresh 失败迟到：旧错误不能写入同 Agent 新身份', async () => {
  await withCasualEnv(async (env) => {
    const summaryGate = deferred();
    env.handlers.summary = () => summaryGate.promise;
    env.handlers.page = () => makePage();
    const refresh = env.store.refresh();

    seedNewCasualIdentity(env, { entry: makeEntry('new-refresh-failure') });
    summaryGate.reject(new Error('旧身份 refresh 失败'));
    await refresh;

    assert.equal(env.store.getState().error, null, '旧身份失败不能把新身份状态标红');
    assert.deepEqual(env.store.getState().entries.map((entry) => entry.id), ['new-refresh-failure']);
  });
});

await test('W9 casual send 成功迟到：旧回执不能回填新身份条目', async () => {
  await withCasualEnv(async (env) => {
    const gate = deferred();
    env.handlers.send = () => gate.promise;
    const send = env.store.send('旧身份草稿');

    seedNewCasualIdentity(env, { entry: makeEntry('new-send') });
    gate.resolve({
      entryId: 'old-send',
      entries: [makeEntry('old-send', 'old-send-source', 'user', '旧身份草稿')],
      reset: false,
    });
    await send;

    assert.deepEqual(env.store.getState().entries.map((entry) => entry.id), ['new-send'],
      '旧 send 成功回执不得写进新身份');
    assert.equal(env.store.getState().sending.size, 0);
  });
});

await test('W9 casual send 失败迟到：失败项不能回填新身份', async () => {
  await withCasualEnv(async (env) => {
    const gate = deferred();
    env.handlers.send = () => gate.promise;
    const send = env.store.send('旧身份失败草稿');

    seedNewCasualIdentity(env, { entry: makeEntry('new-send-failure') });
    gate.reject(new Error('旧身份 send 失败'));
    await send;

    assert.deepEqual(env.store.getState().entries.map((entry) => entry.id), ['new-send-failure']);
    assert.equal(env.store.getState().sending.size, 0);
    assert.equal(env.store.getState().error, null);
  });
});

async function runLoadEarlierAfterReset(rejectOld) {
  return withCasualEnv(async (env) => {
    const cursor = makeEntry('cursor-entry', 'cursor-source');
    env.handlers.page = () => makePage([cursor], true);
    env.handlers.summary = () => ({ unread: 2, preview: null });
    await env.store.refresh();

    const gate = deferred();
    env.handlers.page = (call) => call.path.includes('before=') ? gate.promise : makePage([cursor], true);
    const loading = env.store.loadEarlier();
    seedNewCasualIdentity(env, { entry: makeEntry('new-earlier') });
    if (rejectOld) gate.reject(new Error('旧身份 loadEarlier 失败'));
    else gate.resolve(makePage([makeEntry('old-earlier')], false));
    await loading;

    return env.store.getState();
  });
}

await test('W9 casual loadEarlier 成功迟到：旧历史不能前插到新身份', async () => {
  const state = await runLoadEarlierAfterReset(false);
  assert.deepEqual(state.entries.map((entry) => entry.id), ['new-earlier'],
    '旧 loadEarlier 成功页不得并入新身份');
  assert.equal(state.error, null);
});

await test('W9 casual loadEarlier 失败迟到：旧错误不能写入新身份', async () => {
  const state = await runLoadEarlierAfterReset(true);
  assert.equal(state.error, null, '旧 loadEarlier 错误不得污染新身份');
  assert.deepEqual(state.entries.map((entry) => entry.id), ['new-earlier']);
});

async function runMarkReadAfterReset(rejectOld) {
  return withCasualEnv(async (env) => {
    const sameEntry = makeEntry('shared-entry', 'shared-source');
    env.handlers.page = () => makePage([sameEntry]);
    env.handlers.summary = () => ({ unread: 4, preview: null });
    await env.store.refresh();

    const gate = deferred();
    env.handlers.read = () => gate.promise;
    const marking = env.store.markReadThrough('shared-entry');
    seedNewCasualIdentity(env, {
      unread: 7,
      entry: makeEntry('shared-entry', 'shared-source', 'agent', '新身份同 ID 条目'),
    });
    if (rejectOld) gate.reject(new Error('旧身份 markRead 失败'));
    else gate.resolve({ ok: true });
    await marking;

    return env.store.getState();
  });
}

await test('W9 casual markRead 成功迟到：不得清零新身份未读数', async () => {
  const state = await runMarkReadAfterReset(false);
  assert.equal(state.unread, 7, '旧已读回执不能清掉新身份未读数');
});

await test('W9 casual markRead 失败迟到：不得改变新身份状态', async () => {
  const state = await runMarkReadAfterReset(true);
  assert.equal(state.unread, 7);
  assert.equal(state.error, null);
});

await test('W9 logout cleanup：关掉所有旧浮层，settings controller reset 后仍可复用', async () => {
  const oldModels = deferred();
  await withApp('w9-logout-overlay-settings-reset', {
    onRequest: ({ h, record }) => {
      if (record.pathname === '/api/models' && record.url.includes('agentId=agent-1')) return oldModels.promise;
      if (record.pathname === '/api/models' && record.url.includes('agentId=agent-2')) {
        return h.jsonRes({ models: [{ id: 'new-model', provider: 'test' }], current: 'new-model' });
      }
      if (record.pathname === '/api/session-thinking-level') {
        return h.jsonRes({ thinkingLevel: 'balanced', thinkingLevels: ['balanced'] });
      }
      return undefined;
    },
  }, async ({ h, hana, requests }) => {
    let oldLoad;
    let newLoad;
    try {
      hana.settingsView.open();
      oldLoad = hana.settingsController.load({ sessionPath: null, agentId: 'agent-1' });
      await h.waitFor(() => requests.some((request) => request.pathname === '/api/models'
        && request.url.includes('agentId=agent-1')), '旧设置请求已在途');

      const menuRow = makeRow('menu-before-logout', '退出前菜单行');
      assert.equal(hana.sessionActionsView.open(menuRow), true, '会话菜单应真实打开');
      assert.equal(hana.messageActionsMenu.open({
        message: { role: 'assistant', id: 'assistant-1', text: '旧身份消息', isLastAssistant: true },
        context: { session: { path: menuRow.path, sessionId: menuRow.sessionId }, streaming: false },
      }), true, '消息菜单应真实打开');
      await openFilePreview({ file: { label: '旧身份图片', ext: 'png' }, readUrl: 'offline://old-user.png' });
      const preview = h.find(h.body, '.file-preview');
      assert.equal(hana.settingsView.isOpen(), true);
      assert.equal(hana.sessionActionsView.isOpen(), true);
      assert.equal(hana.messageActionsMenu.isOpen(), true);
      assert.equal(preview?.hidden, false);

      hana.resetAfterLogout();
      assert.equal(hana.settingsView.isOpen(), false, 'logout 必须关设置浮层');
      assert.equal(hana.sessionActionsView.isOpen(), false, 'logout 必须关会话操作菜单');
      assert.equal(hana.messageActionsMenu.isOpen(), false, 'logout 必须关消息操作菜单');
      assert.equal(preview?.hidden, true, 'logout 必须关文件预览浮层');
      assert.equal(hana.settingsController.isDisposed(), false, 'logout 不能永久 dispose 可复用控制器');

      hana.S.principal = { id: 'user-2' };
      newLoad = hana.settingsController.load({ sessionPath: null, agentId: 'agent-2' });
      await newLoad;
      oldModels.resolve(h.jsonRes({ models: [{ id: 'old-model', provider: 'test' }], current: 'old-model' }));
      await oldLoad;

      const settings = hana.settingsController.getState();
      assert.equal(settings.status, 'loaded');
      assert.deepEqual(settings.models.map((model) => model.id), ['new-model'],
        '旧身份 load 迟到不能覆盖新身份设置');
      hana.settingsView.open();
      assert.equal(hana.settingsView.isOpen(), true, 'reset 后的设置面板可供新身份继续使用');
    } finally {
      oldModels.resolve(h.jsonRes({ models: [{ id: 'old-model', provider: 'test' }], current: 'old-model' }));
      await Promise.all([oldLoad, newLoad].filter(Boolean).map((task) => task.catch(() => {})));
    }
  });
});

/* -------------------------------- W9 archive feature -------------------------------- */

async function runArchiveRestoreAfterReset(rejectOld) {
  const gate = deferred();
  const oldRow = {
    path: 'C:/archive/shared.jsonl',
    sessionId: 'shared-session',
    title: '旧身份归档',
    archivedAt: '2026-11-03T09:00:00.000Z',
    agentId: 'agent-1',
    agentName: '同一助手',
  };
  const newRow = { ...oldRow, title: '新身份同路径行' };
  const env = makeArchiveEnv({
    rows: [oldRow],
    apiOverride: ({ call }) => call.path === '/api/sessions/restore' ? gate.promise : undefined,
  });
  try {
    await env.feature.open();
    const restore = env.feature._restore(env.feature.getRows()[0], { disabled: false });

    env.feature.reset();
    env.setPrincipal('user-2');
    env.setRows([newRow]);
    await env.feature.open();

    if (rejectOld) gate.reject(new Error('旧身份 restore 失败'));
    else gate.resolve({ ok: true });
    await restore;
    return {
      paths: env.feature.getRows().map((row) => row.path),
      titles: env.feature.getRows().map((row) => row.title),
      status: env.h.find(env.h.body, '.archive-panel-status'),
      flashes: env.flashes.slice(),
      restored: env.restored,
    };
  } finally {
    // 即使断言/fixture 出错，也释放挂起请求；feature.reset 会关自己的面板状态。
    gate.resolve({ ok: true });
    env.feature.reset();
  }
}

await test('W9 archive restore 成功迟到：不能删新身份同路径行，也不能 onRestored/flash', async () => {
  const result = await runArchiveRestoreAfterReset(false);
  assert.deepEqual(result.paths, ['C:/archive/shared.jsonl'], '旧 restore 不得删除新身份同路径行');
  assert.deepEqual(result.titles, ['新身份同路径行']);
  assert.equal(result.restored, 0, '旧 restore 不得触发新身份列表刷新');
  assert.deepEqual(result.flashes, [], '旧 restore 不得给新身份提示成功');
});

await test('W9 archive restore 失败迟到：不能改新身份状态栏', async () => {
  const result = await runArchiveRestoreAfterReset(true);
  assert.equal(result.status?.textContent || '', '', '旧 restore 失败不能覆盖新身份状态栏');
  assert.equal(result.status?.hidden, true, '新身份状态栏应保持隐藏');
});

console.log(`\nCASE_COUNTS PASS=${passedCases} SKIP=${skippedCases} FAIL=${failedCases}`);
if (failedCases > 0) {
  console.log(`${failedCases} TEST CASES FAILED`);
  process.exitCode = 1;
} else {
  console.log(`ALL PASS (SKIP=${skippedCases})`);
  process.exitCode = 0;
}
