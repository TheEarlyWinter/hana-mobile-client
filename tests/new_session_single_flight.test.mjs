/* 缺陷 4 回归：新建会话的单飞锁与导航代次
 *
 * 根因：
 *   - 只禁用 btnNew，没管 btnNewChat，也没有单飞锁：两个入口连着点会各发一次
 *     POST /api/sessions/new（建出两个空会话）；
 *   - 创建成功后无条件 openSession(created)：用户在 create 期间自己选了一个会话，
 *     也会被这次创建的结果顶掉。首页发送流程同病。
 *
 * 锁的行为：所有新建入口共用一把锁；每次用户导航（打开会话 / 退回列表 / 退出）
 * 递增导航代次，异步流程每个 await 之后核对，代次变了就放弃打开与发送。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const state = {
  createCalls: 0,
  pendingCreates: [],
  holdCreate: true,
};

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions/new') {
    state.createCalls += 1;
    if (!state.holdCreate) return h.jsonRes({ path: 'p-created', sessionId: 's-created' });
    return new Promise((resolve) => {
      state.pendingCreates.push((body) => resolve(h.jsonRes(body)));
    });
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const releaseCreate = (body = { path: 'p-created', sessionId: 's-created' }) => {
  const next = state.pendingCreates.shift();
  assert.ok(next, '没有挂起中的 /api/sessions/new 可释放');
  next(body);
};

const promptFrames = () => h.MockWebSocket.instances
  .flatMap((ws) => ws.sent.filter((f) => f && f.type === 'prompt'));

function resetFlow() {
  state.createCalls = 0;
  state.pendingCreates.length = 0;
  state.holdCreate = true;
  S.session = null;
  h.getEl('btnNew').disabled = false;
  h.getEl('btnNewChat').disabled = false;
  h.getEl('btnHomeSend').disabled = false;
  h.getEl('homeInput').value = '';
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

await t('两个新建入口共用单飞锁：请求在途时连点只创建一次', async () => {
  resetFlow();
  h.getEl('btnNew').dispatchEvent('click');
  await h.settle(2);
  assert.equal(state.createCalls, 1, '夹具：第一次点击应发出 create');

  // 侧栏顶部按钮 + 抽屉里的按钮一起点，都不能再来一次
  h.getEl('btnNewChat').dispatchEvent('click');
  h.getEl('btnNewChat').dispatchEvent('click');
  await h.settle(4);

  assert.equal(state.createCalls, 1, `只应创建 1 个会话，实际发起了 ${state.createCalls} 次`);
  assert.equal(h.getEl('btnNew').disabled, true, '在途时侧栏按钮应禁用');
  assert.equal(h.getEl('btnNewChat').disabled, true, '在途时抽屉按钮也应一起禁用');

  // 正常路径不能被锁死：放行后要真的打开新会话
  releaseCreate();
  await h.waitFor(() => S.session?.path === 'p-created', '放行后应打开新建的会话');
  assert.equal(h.getEl('btnNew').disabled, false, '完成后侧栏按钮应恢复');
  assert.equal(h.getEl('btnNewChat').disabled, false, '完成后抽屉按钮应恢复');
  S.session = null;
});

await t('create 期间用户自己选了会话：不能被新建结果顶掉', async () => {
  resetFlow();
  h.getEl('btnNew').dispatchEvent('click');
  await h.settle(2);
  assert.equal(state.createCalls, 1, '夹具：create 已发出');

  // 用户在 create 在途时打开了另一个会话
  await hana.openSession({ path: 'p-user', sessionId: 's-user', title: '用户选的', agentId: 'agent-1' });
  assert.equal(S.session.path, 'p-user', '夹具：用户已选中自己的会话');

  releaseCreate({ path: 'p-created', sessionId: 's-created' });
  await h.settle(12);

  assert.equal(S.session.path, 'p-user', `用户刚选的会话不能被新建结果顶掉，实际 ${S.session.path}`);
  assert.equal(h.getEl('btnNew').disabled, false, '流程结束后锁要释放');
  S.session = null;
});

await t('首页发送在途时用户自己选了会话：不抢焦点、不发送、草稿不丢', async () => {
  resetFlow();
  const promptsBefore = promptFrames().length;
  h.getEl('homeInput').value = '首页草稿不能没';
  h.getEl('btnHomeSend').dispatchEvent('click');
  await h.settle(2);
  assert.equal(state.createCalls, 1, '夹具：首页发送已发起 create');

  await hana.openSession({ path: 'p-user', sessionId: 's-user', title: '用户选的', agentId: 'agent-1' });
  releaseCreate({ path: 'p-created', sessionId: 's-created' });
  await h.settle(12);

  assert.equal(S.session.path, 'p-user', '首页发送不能把用户刚选的会话换掉');
  assert.equal(promptFrames().length, promptsBefore, '这次首页发送不能被补发出去');
  assert.equal(h.getEl('homeInput').value, '首页草稿不能没', '没发出去的首页草稿必须留在输入框里');
  S.session = null;
});

await t('没有被打断时：首页发送照常创建并发送', async () => {
  resetFlow();
  state.holdCreate = false;
  h.getEl('homeInput').value = '正常首页发送';
  h.getEl('btnHomeSend').dispatchEvent('click');

  await h.waitFor(() => S.session?.path === 'p-created', '应打开新建的会话');
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '应建立连接');
  const ws = h.MockWebSocket.instances.at(-1);
  ws.open();
  await h.waitFor(() => promptFrames().length > 0, '应发出 prompt 帧');

  const frame = promptFrames().at(-1);
  assert.equal(frame.text, '正常首页发送');
  assert.equal(frame.sessionPath, 'p-created');
  assert.equal(h.getEl('homeInput').value, '', '发送成功后首页输入框应清空');
  S.session = null;
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
