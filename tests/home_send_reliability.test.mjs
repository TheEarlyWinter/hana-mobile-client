/* tests/home_send_reliability.test.mjs
 *
 * 首页 sendFromHome 可靠性与草稿保护测试
 * 契约：
 * 1. WS 连上稍慢时（例如 1.2s），sendFromHome 必须复用 composer 的发送就绪等待，
 *    在连接可用后成功发送，不得静默吞消息
 * 2. 连接超时（例如服务器断开）时，聊天输入框必须保留草稿并给出明确提示；
 *    首页草稿只有在安全移交到聊天输入框/附件后才清空
 * 3. create 成功但会话列表加载失败：首页草稿必须保留
 * 4. create/open 成功但等待历史期间用户导航中止：首页草稿必须保留
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

let createdSession = {
  path: 'C:/sessions/new-home.jsonl',
  sessionId: 'sess-home-1',
  title: '新对话',
  agentId: 'agent-1',
  cwd: 'C:/work',
  namespace: 'home',
};

h.setFetch(async (url, init = {}) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
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
  if (path === '/api/sessions/new') {
    return h.jsonRes(createdSession);
  }
  if (path.startsWith('/api/sessions/list') || path === '/api/sessions') {
    return h.jsonRes({ ok: true, sessions: [createdSession] });
  }
  if (path.includes('/entries')) {
    return h.jsonRes({ entries: [], hasMore: false });
  }
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

await t('首页发送：WS 就绪稍慢时（1.2 秒后才就绪），消息仍能成功发送', async () => {
  const homeInput = h.getEl('homeInput');
  assert.ok(homeInput, '首页输入框存在');
  homeInput.value = '首页慢连测试';

  // 触发首页发送
  const sendPromise = hana.sendFromHome();

  // 等待进入创建与导航
  await sleep(100);

  // 此时处于聊天页，模拟 WS 实例生成并就绪
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, 'WS 实例应被创建');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];

  // 延迟 1.2s 模拟网络建立
  await sleep(1200);
  ws.open();

  await sendPromise;

  // 检验 ws 发出的消息是否包含草稿（协议中帧类型为 prompt）
  const found = ws.sent.find((f) => f.type === 'prompt' && f.text === '首页慢连测试');
  assert.ok(found, '延迟就绪后消息必须被成功送出，不得静默丢失');
});

await t('首页发送：WS 彻底连接超时时，聊天输入框保留用户草稿且给出提示，不静默丢失', async () => {
  const homeInput = h.getEl('homeInput');
  homeInput.value = '网络故障保留草稿测试';

  // 会话重置
  const chatInput = h.getEl('input');

  // 触发首页发送
  const sendPromise = hana.sendFromHome();
  await sleep(100);

  // 获取新建的 WS 实例但故意不打开（模拟连接挂死/离线超时）
  await h.waitFor(() => h.MockWebSocket.instances.length > 0);
  // 保持 CONNECTING 状态直至 composer 的 waitForReady 超时

  await sendPromise;

  // 验证：消息没有被丢弃，已填入聊天输入框
  assert.equal(chatInput.value, '网络故障保留草稿测试', '连接超时后草稿必须保留在聊天输入框供用户重试');
  assert.ok(
    h.getEl('transcript').textContent.includes('连接还没就绪'),
    '连接超时必须给出明确提示，不能静默失败',
  );
});

await t('首页发送：create 成功但会话列表加载失败，首页草稿必须保留', async () => {
  // 先回到列表页，避免沿用上一条用例停留的聊天视图。
  S.session = null;
  h.getEl('view-chat').hidden = true;
  h.getEl('view-list').hidden = false;

  const homeInput = h.getEl('homeInput');
  homeInput.value = '列表失败保留草稿';
  let listRequests = 0;

  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/new') return h.jsonRes(createdSession);
    if (path === '/api/sessions/list' || path === '/api/sessions') {
      listRequests += 1;
      if (listRequests === 1) return h.jsonRes({ error: 'list down' }, { ok: false, status: 500 });
      return h.jsonRes({ ok: true, sessions: [createdSession] });
    }
    if (path === '/api/sessions/messages') return h.jsonRes({ entries: [], hasMore: false });
    return h.jsonRes({});
  });

  await hana.sendFromHome();

  assert.equal(listRequests, 1, '首页发送应实际请求会话列表');
  assert.equal(homeInput.value, '列表失败保留草稿', '列表失败时首页草稿不得被清空');
  assert.equal(h.getEl('view-chat').hidden, true, '列表失败时不得进入聊天页');
});

await t('首页发送：历史等待期间用户导航中止，首页草稿必须保留', async () => {
  const homeInput = h.getEl('homeInput');
  homeInput.value = '导航中止保留草稿';
  let historyStarted = false;
  let resolveHistory;

  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/new') return h.jsonRes(createdSession);
    if (path === '/api/sessions/messages') {
      historyStarted = true;
      return new Promise((resolve) => {
        resolveHistory = () => resolve(h.jsonRes({ entries: [], hasMore: false }));
      });
    }
    if (path === '/api/sessions/list' || path === '/api/sessions') {
      return h.jsonRes({ ok: true, sessions: [createdSession] });
    }
    return h.jsonRes({});
  });

  const pending = hana.sendFromHome();
  await h.waitFor(() => historyStarted, '新会话历史请求已挂起');

  // 用户自己退回列表：navigationEpoch 变化，sendFromHome 必须放弃打开/发送。
  assert.equal(hana.backToList(), true, '返回键应先退出刚打开的聊天页');
  resolveHistory();
  await pending;

  assert.equal(homeInput.value, '导航中止保留草稿', '等待历史期间导航中止时首页草稿必须保留');
  assert.equal(h.getEl('view-list').hidden, false, '用户应停留在列表页');
});

await t('旧身份 logout 后，旧 create 迟到不得把旧草稿复制给新身份', async () => {
  S.session = null;
  h.getEl('view-chat').hidden = true;
  h.getEl('view-list').hidden = false;
  const homeInput = h.getEl('homeInput');
  const chatInput = h.getEl('input');
  homeInput.value = '旧身份草稿';
  chatInput.value = '';

  const gate = deferred();
  let createStarted = false;
  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/new') {
      createStarted = true;
      return gate.promise;
    }
    if (path === '/api/web-auth/logout') return h.jsonRes({ ok: true });
    if (path === '/api/sessions/messages') return h.jsonRes({ entries: [], hasMore: false });
    if (path === '/api/sessions' || path === '/api/sessions/list') {
      return h.jsonRes({ ok: true, sessions: [createdSession] });
    }
    return h.jsonRes({});
  });

  const pending = hana.sendFromHome();
  await h.waitFor(() => createStarted, '旧身份 create 已发出');

  assert.equal(await hana.loginController.logout(), true, '旧身份 logout 应成功');
  assert.equal(homeInput.value, '', 'logout 可以清掉旧身份首页草稿');
  S.principal = { id: 'user-2' };

  gate.resolve(h.jsonRes(createdSession));
  await pending;

  assert.equal(homeInput.value, '', '旧 create 迟到不得把旧草稿复制给新身份');
  assert.equal(chatInput.value, '', '旧 create 迟到不得把旧草稿塞进新身份聊天框');
  assert.equal(S.session, null, '旧 create 迟到不得替新身份打开会话');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
