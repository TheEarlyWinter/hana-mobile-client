/* tests/logout_features_cleanup.test.mjs
 *
 * W9 返修：真实 logout 链路上的 feature / 设置清理与同 Agent 重登的旧异步作废。
 * 覆盖：
 * 1. 真实 loginController.logout 关闭设置与会话菜单；re-login 后仍能打开设置
 * 2. 退出失败不得清空任何 feature 状态
 * 3. archive 列表请求实际挂起后 logout，迟到数据不得回填
 * 4. archive restore 实际挂起后 logout/re-login，旧成功不得删新 rows、不得 onRestored/flash
 * 5. archive restore 旧失败不得给新面板 setStatus
 * 6. casual refresh 实际挂起后 logout/re-login，旧结果不得回填
 * 7. search 面板在 logout 后关闭且重登仍能打开
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const h = createHarness();
h.getEl('homeScroll').appendChild(h.getEl('sessionList'));

let archiveRows = [{ path: 'C:/arc.jsonl', title: '旧用户归档' }];
let delayedArchiveLoad = null;
let delayedRestore = null;
let delayedCasualSummary = null;
let delayedCasualEntries = null;
let logoutFail = false;
let archiveLoadCalls = 0;
let restoreCalls = 0;
let listCalls = 0;
let casualSummaryCalls = 0;
let casualEntriesCalls = 0;

h.setFetch(async (url, init = {}) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    // 每次返回新的 principal 对象，模拟真实 JSON 反序列化；旧上下文不能靠对象复用蒙混过关。
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/web-auth/login') {
    return h.jsonRes({ ok: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/web-auth/logout') {
    if (logoutFail) return h.jsonRes({ error: 'logout down' }, { ok: false, status: 500 });
    return h.jsonRes({ ok: true });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: '助手1' }],
      currentAgent: { id: 'agent-1', name: '助手1' },
      sessions: [],
      homeFolder: 'C:/work',
      auth: { token: 't-1' },
    });
  }
  if (path === '/api/sessions/archived') {
    archiveLoadCalls += 1;
    if (delayedArchiveLoad) return delayedArchiveLoad.promise;
    return h.jsonRes({ sessions: archiveRows });
  }
  if (path === '/api/sessions/restore') {
    restoreCalls += 1;
    if (delayedRestore) return delayedRestore.promise;
    return h.jsonRes({ ok: true });
  }
  if (path === '/api/sessions' || path === '/api/sessions/list') {
    listCalls += 1;
    return h.jsonRes({ sessions: [] });
  }
  if (path === '/api/casual/agent-1/summary') {
    casualSummaryCalls += 1;
    if (delayedCasualSummary) return delayedCasualSummary.promise;
    return h.jsonRes({ unread: 0, preview: null });
  }
  if (path === '/api/casual/agent-1/entries') {
    casualEntriesCalls += 1;
    if (delayedCasualEntries) return delayedCasualEntries.promise;
    return h.jsonRes({ entries: [], hasMore: false });
  }
  if (path === '/api/sessions/search') {
    return h.jsonRes({ results: [{ path: 'C:/search.jsonl', sessionId: 's-1', title: '机密记录' }] });
  }
  if (path === '/api/models') return h.jsonRes({ models: [], current: null });
  if (path === '/api/session-thinking-level') {
    return h.jsonRes({ thinkingLevel: null, thinkingLevels: null });
  }
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const nodeById = (id) => h.allNodes.find((n) => n && n.id === id) || null;
const nodeByClass = (cls) =>
  h.allNodes.find((n) => n && typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) || null;

async function logoutOk() {
  const ok = await hana.loginController.logout();
  assert.equal(ok, true, '真实 logout 应成功');
}

async function loginOk() {
  const ok = await hana.loginController.login({ username: 'user', password: 'pass' });
  assert.equal(ok, true, '同 Agent re-login 应成功');
}

function clearFlash() {
  for (const node of h.allNodes.filter((n) => n && n.id === 'flashBar')) node.remove();
  h.elements.delete('flashBar');
}

await t('真实 logout：关闭设置与会话菜单，重置设置控制器；re-login 后仍能打开设置', async () => {
  hana.settingsView.open();
  assert.equal(hana.settingsView.isOpen(), true, '设置已打开');
  hana.sessionActionsView.open({ path: 'C:/sessions/menu.jsonl', title: '菜单会话' });
  assert.equal(hana.sessionActionsView.isOpen(), true, '会话菜单已打开');

  await logoutOk();

  assert.equal(hana.settingsView.isOpen(), false, '设置不得继续盖在登录页上');
  assert.equal(hana.sessionActionsView.isOpen(), false, '会话菜单不得继续盖在登录页上');
  assert.equal(hana.settingsController.getState().status, 'idle', '设置控制器应复位但不 disposed');
  assert.equal(hana.settingsController.isDisposed(), false);

  await loginOk();
  hana.settingsView.open();
  assert.equal(hana.settingsView.isOpen(), true, '新登录仍能打开设置');
  hana.settingsView.close();
});

await t('真实 logout 失败：不得清空任何 feature 状态', async () => {
  const casual = hana.casual;
  const archive = hana.features.get('archive');
  casual.open();
  await archive.open();
  const rowsBefore = archive.getRows().length;
  hana.settingsView.open();

  logoutFail = true;
  const ok = await hana.loginController.logout();
  logoutFail = false;

  assert.equal(ok, false, 'logout 失败应返回 false');
  assert.equal(casual.isOpen(), true, '退出失败不得关闭闲聊');
  assert.equal(archive.isOpen(), true, '退出失败不得关闭归档');
  assert.equal(archive.getRows().length, rowsBefore, '退出失败不得清空归档行');
  assert.equal(hana.settingsView.isOpen(), true, '退出失败不得关闭设置');

  casual.close();
  archive.close();
  hana.settingsView.close();
});

await t('真实 logout：archive 列表请求实际挂起后 reset，迟到数据不回填；重登可重载', async () => {
  const archive = hana.features.get('archive');
  await archive.open();
  assert.ok(archive.getRows().length > 0, '归档首屏已有数据');

  const gate = deferred();
  delayedArchiveLoad = gate;
  const before = archiveLoadCalls;
  const pending = archive.reload();
  await h.waitFor(() => archiveLoadCalls > before, '归档列表请求已发出');
  assert.equal(delayedArchiveLoad, gate, '测试夹具必须拿到真正挂起的请求');

  await logoutOk();
  delayedArchiveLoad = null;
  archiveRows = [{ path: 'C:/arc-new.jsonl', title: '新用户归档' }];
  await loginOk();

  gate.resolve(h.jsonRes({ sessions: [{ path: 'C:/arc-old.jsonl', title: '旧用户迟到' }] }));
  await pending;

  assert.equal(archive.getRows().length, 0, '迟到归档数据不得回填已 reset 的 feature');
  const statusEl = nodeByClass('archive-panel-status');
  assert.equal(statusEl?.textContent || '', '', '迟到归档不得写状态行');

  await archive.open();
  assert.deepEqual(archive.getRows().map((row) => row.path), ['C:/arc-new.jsonl']);
  archive.close();
});

await t('真实 logout：旧 restore 成功不得删除新 rows、不得 onRestored/flash', async () => {
  const archive = hana.features.get('archive');
  archiveRows = [{ path: 'C:/arc.jsonl', title: '旧归档' }];
  await archive.open();
  const oldRow = archive.getRows()[0];

  const gate = deferred();
  delayedRestore = gate;
  const before = restoreCalls;
  const pending = archive._restore(oldRow);
  await h.waitFor(() => restoreCalls > before, 'restore 请求已发出');
  assert.equal(delayedRestore, gate);

  await logoutOk();
  delayedRestore = null;
  // 同路径的新归档行：旧成功若不设代次，会把这一行误删。
  archiveRows = [{ path: 'C:/arc.jsonl', title: '新用户归档' }];
  await loginOk();
  await archive.open();
  assert.deepEqual(archive.getRows().map((row) => row.title), ['新用户归档']);

  const listBefore = listCalls;
  clearFlash();
  gate.resolve(h.jsonRes({ ok: true }));
  await pending;

  assert.deepEqual(archive.getRows().map((row) => row.title), ['新用户归档'], '旧 restore 成功不得删新 rows');
  assert.equal(listCalls, listBefore, '旧 restore 成功不得触发 onRestored 重拉列表');
  const statusEl = nodeByClass('archive-panel-status');
  assert.equal(statusEl?.textContent || '', '', '旧 restore 成功不得写状态行');
  const flashEl = h.elements.get('flashBar');
  assert.ok(!flashEl || !flashEl.textContent, '旧 restore 成功不得 flash');
  archive.close();
});

await t('真实 logout：旧 restore 失败不得给新面板 setStatus', async () => {
  const archive = hana.features.get('archive');
  archiveRows = [{ path: 'C:/arc.jsonl', title: '旧归档' }];
  await archive.open();
  const oldRow = archive.getRows()[0];

  const gate = deferred();
  delayedRestore = gate;
  const before = restoreCalls;
  const pending = archive._restore(oldRow);
  await h.waitFor(() => restoreCalls > before, 'restore 请求已发出');
  assert.equal(delayedRestore, gate);

  await logoutOk();
  delayedRestore = null;
  archiveRows = [{ path: 'C:/arc-new.jsonl', title: '新用户归档' }];
  await loginOk();
  await archive.open();

  gate.reject(new Error('旧 restore 失败'));
  await pending;

  const statusEl = nodeByClass('archive-panel-status');
  assert.equal(statusEl?.textContent || '', '', '旧 restore 失败不得写新面板状态');
  assert.equal(statusEl?.hidden, true, '状态行必须保持隐藏');
  assert.deepEqual(archive.getRows().map((row) => row.path), ['C:/arc-new.jsonl'], '新 rows 必须保留');
  archive.close();
});

await t('archive 普通 close 不得废弃在途 restore：成功仍更新 rows 并通知刷新', async () => {
  const archive = hana.features.get('archive');
  archiveRows = [{ path: 'C:/arc-close.jsonl', title: '关闭后恢复' }];
  await archive.open();
  const oldRow = archive.getRows()[0];

  const gate = deferred();
  delayedRestore = gate;
  const before = restoreCalls;
  const pending = archive._restore(oldRow);
  await h.waitFor(() => restoreCalls > before, 'restore 请求已发出');
  archive.close();

  const listBefore = listCalls;
  gate.resolve(h.jsonRes({ ok: true }));
  await pending;
  delayedRestore = null;

  assert.equal(archive.getRows().length, 0, '普通 close 不应让成功的 restore 失效');
  assert.ok(listCalls > listBefore, '普通 close 后 restore 成功仍应通知刷新活跃列表');
  archive.close();
});

await t('真实 logout：同 Agent re-login 后旧 casual refresh 不得回填', async () => {
  const casual = hana.casual;
  const store = casual.getStore();
  await store.open();
  casual.open();
  assert.equal(casual.isOpen(), true);

  const summaryGate = deferred();
  const entriesGate = deferred();
  delayedCasualSummary = summaryGate;
  delayedCasualEntries = entriesGate;
  const summaryBefore = casualSummaryCalls;
  const entriesBefore = casualEntriesCalls;
  const pending = store.refresh();
  await h.waitFor(
    () => casualSummaryCalls > summaryBefore && casualEntriesCalls > entriesBefore,
    'casual refresh 请求已发出',
  );

  await logoutOk();
  delayedCasualSummary = null;
  delayedCasualEntries = null;
  await loginOk();

  summaryGate.resolve(h.jsonRes({ unread: 7, preview: { text: '旧摘要' } }));
  entriesGate.resolve(h.jsonRes({
    entries: [{
      id: 'old-entry',
      sourceEntryId: 'old-source',
      actor: 'agent',
      occurredAt: '2026-11-04T05:00:00.000Z',
      item: { kind: 'text', text: '旧条目' },
    }],
    hasMore: false,
  }));
  assert.equal(await pending, false);

  const state = store.getState();
  assert.ok(!state.entries.some((entry) => entry.id === 'old-entry'), '旧 refresh 不得回填新登录');
  assert.equal(state.unread, 0, '旧摘要不得回填 unread');
  assert.equal(state.loading, false);

  casual.open();
  assert.equal(casual.isOpen(), true, '新登录仍能打开闲聊');
  casual.close();
});

await t('真实 logout：search 面板关闭、查询清空；re-login 后仍能打开', async () => {
  const search = hana.features.get('search');
  search.open();
  assert.equal(search.isOpen(), true);

  const inputEl = h.allNodes.find((n) => n.tagName === 'INPUT' && n.className.includes('search'));
  assert.ok(inputEl, '搜索输入框存在');
  inputEl.value = '私密搜索词';
  inputEl.dispatchEvent({ type: 'input' });
  await sleep(220);

  await logoutOk();

  assert.equal(search.isOpen(), false, '搜索面板必须关闭');
  assert.equal(inputEl.value, '', '搜索输入词必须清空');
  assert.ok(nodeById('btnSearch'), '搜索入口按钮依然挂载');

  await loginOk();
  search.open();
  assert.equal(search.isOpen(), true, '新登录仍能打开搜索');
  search.close();
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
