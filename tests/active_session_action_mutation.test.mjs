/* tests/active_session_action_mutation.test.mjs
 *
 * 当前活跃会话在外部被改名或归档时的联动契约测试
 * 覆盖主控要求的场景：
 * 1. 处于聊天页且归档当前活跃会话：触发 backToList()，状态复位并退出聊天页
 * 2. 归档非当前活跃会话：不触发退出聊天页
 * 3. 处于聊天页且重命名当前活跃会话：chatTitle 即时更新为新标题，S.session.title 一同更新
 * 4. 重命名失败回滚时：chatTitle 和 S.session.title 回滚为原标题
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

const initialSessions = [
  {
    path: 'C:/sessions/active.jsonl',
    sessionId: 'sess-active',
    title: '活跃会话',
    agentId: 'agent-1',
    cwd: 'C:/work',
    namespace: 'home',
  },
  {
    path: 'C:/sessions/other.jsonl',
    sessionId: 'sess-other',
    title: '其他会话',
    agentId: 'agent-1',
    cwd: 'C:/work',
    namespace: 'home',
  },
];

h.setFetch(async (url, init = {}) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: '助手1' }],
      currentAgent: { id: 'agent-1', name: '助手1' },
      sessions: initialSessions,
      homeFolder: 'C:/work',
      auth: { token: 't-1' },
    });
  }
  if (path.startsWith('/api/sessions/list') || path === '/api/sessions') {
    return h.jsonRes({ ok: true, sessions: initialSessions });
  }
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

// 打开活跃会话进入聊天页
await h.window.__hana.openSession(initialSessions[0]);
assert.equal(h.getEl('view-chat').hidden, false, '应处于聊天页');
assert.equal(h.getEl('chatTitle').textContent, '活跃会话', '聊天头部应显示活跃会话标题');

await t('重命名当前活跃会话：chatTitle 与 S.session.title 即时更新', async () => {
  // 配置 api 响应
  h.setFetch(async (url, init = {}) => {
    if (url.includes('/api/sessions/rename')) {
      return h.jsonRes({ ok: true });
    }
    return h.jsonRes({});
  });

  const actions = h.window.__hana.sessionActions;
  assert.ok(actions, 'sessionActions 必须存在');

  const res = await actions.rename(initialSessions[0], '新活跃标题');

  assert.equal(res?.ok, true, '重命名请求成功');
  assert.equal(h.getEl('chatTitle').textContent, '新活跃标题', '顶部标题必须实时更新');
  assert.equal(S.session?.title, '新活跃标题', 'S.session.title 必须同步更新');
});

await t('重命名失败回滚：chatTitle 与 S.session.title 回滚为原标题', async () => {
  // 配置 api 响应失败
  h.setFetch(async (url, init = {}) => {
    if (url.includes('/api/sessions/rename')) {
      return h.jsonRes({ error: 'Server Error' }, { ok: false, status: 500, statusText: 'Server Error' });
    }
    return h.jsonRes({});
  });

  const actions = h.window.__hana.sessionActions;
  const res = await actions.rename(S.session, '将失败的新标题');

  assert.equal(res?.ok, false, '重命名应失败回滚');
  assert.equal(h.getEl('chatTitle').textContent, '新活跃标题', '顶部标题必须回滚到上一版有效标题');
  assert.equal(S.session?.title, '新活跃标题', 'S.session.title 必须同步回滚');
});

await t('归档非当前会话：不影响当前聊天页', async () => {
  h.setFetch(async (url, init = {}) => {
    if (url.includes('/api/sessions/archive')) {
      return h.jsonRes({ ok: true });
    }
    return h.jsonRes({});
  });

  const actions = h.window.__hana.sessionActions;
  await actions.archive(initialSessions[1]);

  assert.equal(h.getEl('view-chat').hidden, false, '聊天页仍应保持打开');
  assert.ok(S.session, '当前活跃会话状态不应被清空');
});

await t('归档当前活跃会话：退出聊天页，退回列表并清空 S.session', async () => {
  h.setFetch(async (url, init = {}) => {
    if (url.includes('/api/sessions/archive')) {
      return h.jsonRes({ ok: true });
    }
    return h.jsonRes({});
  });

  const actions = h.window.__hana.sessionActions;
  await actions.archive(S.session);

  assert.equal(h.getEl('view-chat').hidden, true, '聊天页必须被关闭');
  assert.equal(h.getEl('view-list').hidden, false, '必须退回到列表页');
  assert.equal(S.session, null, 'S.session 必须清空');
});

/* ------------------------------------------------------------------ */
/* W6 返修：归档必须等请求成功，且只退发起时仍为当前的会话               */
/* ------------------------------------------------------------------ */

function setArchiveAwareFetch({ archive, rename, list = initialSessions } = {}) {
  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/archive' && archive) return archive(url, init);
    if (path === '/api/sessions/rename' && rename) return rename(url, init);
    if (path === '/api/sessions/list' || path === '/api/sessions') {
      return h.jsonRes({ ok: true, sessions: list });
    }
    if (path === '/api/sessions/messages') {
      return h.jsonRes({ entries: [], hasMore: false });
    }
    return h.jsonRes({});
  });
}

await t('W6 归档当前会话请求挂起时：只能乐观移出列表，不得提前退出聊天', async () => {
  await h.window.__hana.openSession(initialSessions[0]);
  assert.equal(h.getEl('view-chat').hidden, false, '会话已打开');

  const gate = deferred();
  const started = deferred();
  setArchiveAwareFetch({ archive: () => { started.resolve(); return gate.promise; } });

  const pending = h.window.__hana.sessionActions.archive(initialSessions[0]);
  await started.promise;

  assert.equal(h.getEl('view-chat').hidden, false, '请求未成功前聊天页必须保持打开');
  assert.ok(S.session, '请求未成功前 S.session 不得清空');

  gate.resolve(h.jsonRes({ ok: true }));
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(h.getEl('view-chat').hidden, true, '请求成功且活动会话仍是当前时才退出聊天');
  assert.equal(S.session, null);
});

await t('W6 归档当前会话请求失败：回滚列表且不得退出聊天', async () => {
  await h.window.__hana.openSession(initialSessions[0]);
  assert.equal(h.getEl('view-chat').hidden, false, '会话已打开');

  const gate = deferred();
  const started = deferred();
  setArchiveAwareFetch({ archive: () => { started.resolve(); return gate.promise; } });

  const pending = h.window.__hana.sessionActions.archive(initialSessions[0]);
  await started.promise;
  assert.equal(h.getEl('view-chat').hidden, false, '失败前不得退出');

  gate.reject(new Error('归档失败'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, '失败必须回滚乐观删除');
  assert.equal(h.getEl('view-chat').hidden, false, '归档失败不得退出聊天');
  assert.ok(S.session, '归档失败不得清空当前会话');
  assert.equal(S.session.path, initialSessions[0].path);
  assert.ok(
    S.sessions.some((row) => row.path === initialSessions[0].path),
    '失败回滚后当前会话必须回到列表',
  );
});

await t('W6 当前会话不在筛选列表中：归档其他行不得误退聊天', async () => {
  await h.window.__hana.openSession(initialSessions[0]);
  assert.equal(h.getEl('view-chat').hidden, false, '会话已打开');

  // 模拟当前 namespace 的筛选结果不含当前活跃会话。
  S.sessions = [initialSessions[1]];
  setArchiveAwareFetch({ archive: () => h.jsonRes({ ok: true }), list: [initialSessions[1]] });

  const result = await h.window.__hana.sessionActions.archive(initialSessions[1]);

  assert.equal(result.ok, true);
  assert.equal(h.getEl('view-chat').hidden, false, '归档其他行不得退出当前聊天');
  assert.ok(S.session, '归档其他行不得清空当前会话');
  assert.equal(S.session.path, initialSessions[0].path);
});

await t('W6 改名挂起期间切到筛选外会话：失败回滚不得改新标题或退出', async () => {
  await h.window.__hana.openSession(initialSessions[0]);
  assert.equal(h.getEl('view-chat').hidden, false, '会话已打开');
  S.sessions = [initialSessions[0]];

  const gate = deferred();
  const started = deferred();
  setArchiveAwareFetch({ rename: () => { started.resolve(); return gate.promise; } });

  const pending = h.window.__hana.sessionActions.rename(initialSessions[0], '旧会话待回滚标题');
  await started.promise;

  // 切到一条不在当前筛选列表里的会话；旧回滚逻辑会因列表缺当前而 backToList。
  await h.window.__hana.openSession(initialSessions[1]);
  assert.equal(S.session.path, initialSessions[1].path);
  const newTitle = S.session.title;

  gate.reject(new Error('旧标题写失败'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(h.getEl('view-chat').hidden, false, '旧改名的回滚不得退出新会话');
  assert.equal(S.session.path, initialSessions[1].path);
  assert.equal(S.session.title, newTitle, '旧改名的回滚不得改新会话标题');
  assert.equal(h.getEl('chatTitle').textContent, newTitle);
});

await t('W6 旧 principal 的迟到回调：不写新列表、不 flash', async () => {
  await h.window.__hana.openSession(initialSessions[0]);
  assert.equal(h.getEl('view-chat').hidden, false, '会话已打开');

  const gate = deferred();
  const started = deferred();
  setArchiveAwareFetch({ rename: () => { started.resolve(); return gate.promise; } });

  const pending = h.window.__hana.sessionActions.rename(initialSessions[0], '旧身份标题');
  await started.promise;

  // 身份切换：旧请求此后晚到，既不能回滚新列表，也不能弹旧错误。
  h.window.__hana.resetAfterLogout();
  S.principal = { id: 'user-2' };
  S.sessions = [{ path: 'C:/sessions/new.jsonl', sessionId: 'sess-new', title: '新身份会话' }];
  for (const node of h.allNodes.filter((n) => n && n.id === 'flashBar')) node.remove();
  h.elements.delete('flashBar');

  gate.reject(new Error('旧身份改名失败'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.stale, true, '旧 principal 的结果必须标记为 stale');
  assert.equal(S.sessions.length, 1, '旧回调不得回滚新身份的列表');
  assert.equal(S.sessions[0].path, 'C:/sessions/new.jsonl');
  assert.equal(S.sessions[0].title, '新身份会话');
  const flashEl = h.elements.get('flashBar');
  assert.ok(!flashEl || !flashEl.textContent, '旧 principal 的失败不得 flash 到新身份界面');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
