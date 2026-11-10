/* 缺陷 1 回归：断线时点「停止」不能只在本地把生成态收掉
 *
 * 根因：abortTurn() 不看 wsSend() 的返回值。连接没打开时 wsSend 返回 false，
 * 代码照样 finishTurn()：按钮回到「发送」、气泡收尾，用户以为停了，
 * 服务端那一轮其实还在跑（重连后 resume_stream 又把它拉回来）。
 *
 * 锁的行为：
 *   1. abort 发不出去时不清本地生成态，记为 pendingAbort；
 *   2. 连接恢复后先补发 abort，再决定要不要续流（要停的那一轮不续）；
 *   3. abort 真的发出去之后才收本地生成态；
 *   4. 断线期间换了会话，排队的 abort 作废，绝不发给新会话。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

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
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

// setBusy() 会改写 .send-label 的文案：按 index.html 的真实结构先把这个子节点建出来。
{
  const label = h.makeNode('span', '');
  label.className = 'send-label';
  h.getEl('btnSend').appendChild(label);
}

const hana = await h.loadApp();
const S = hana.S;
/* 渲染进度袋：D2 起测试直接读它，S 上不再转发这些字段。 */
const R = hana?.rendererState || globalThis.__hana.rendererState;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const btnSend = h.getEl('btnSend');
const sendLabel = () => btnSend.querySelector('.send-label')?.textContent || '';
const systemLines = () => h.getEl('transcript').children
  .filter((n) => String(n.className || '').includes('msg-system')).length;

/** 一个「已经断开」的连接桩：任何写入都算违规。 */
function closedSocket() {
  return {
    readyState: 3,
    closed: true,
    close() {},
    send() {
      throw new Error('不该往已关闭的连接写帧');
    },
  };
}

/** 模拟一轮正在生成的回复（走真事件入口，顺带把按钮切成「停止」）。 */
function startGenerating(session) {
  S.session = session;
  h.getEl('transcript').innerHTML = '';
  S.pendingAbort = null;
  S.busy = false;
  hana.handleEvent({ type: 'text_delta', delta: '正在生成', sessionId: session.sessionId, sessionPath: session.path });
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

await t('断线时点停止：保持生成态，重连后补发 abort 才收尾', async () => {
  startGenerating({ path: 'p-1', sessionId: 's-1', title: '断线停止' });
  S.ws = closedSocket();
  S.wsReady = false;
  S.reconnectDelay = 20;
  const turn = R.turn;
  assert.equal(S.busy, true, '夹具：应已进入生成态');
  assert.equal(sendLabel(), '停止', '夹具：生成中按钮应是「停止」');

  btnSend.dispatchEvent('click');

  // 1) 没有发出去就不能假装停了
  assert.equal(S.busy, true, 'abort 没发出去时不得清掉本地生成态（按钮还是「停止」）');
  assert.equal(sendLabel(), '停止', `按钮文案必须仍是「停止」，实际 ${sendLabel()}`);
  assert.ok(R.turn === turn, '本轮消息节点不能被 finishTurn 收掉');
  assert.ok(S.pendingAbort, 'abort 必须记为待补发');
  assert.equal(S.pendingAbort.sessionPath, 'p-1');
  assert.equal(S.pendingAbort.sessionId, 's-1');

  // 2) 立刻尝试重连（不能等重连退避）
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '断线后应立刻发起重连');
  const ws = h.MockWebSocket.instances.at(-1);
  ws.open();
  await h.settle(4);

  const aborts = ws.frames('abort');
  assert.equal(aborts.length, 1, `连接恢复后必须补发 1 帧 abort，实际 ${aborts.length}`);
  assert.equal(aborts[0].sessionPath, 'p-1');
  assert.equal(aborts[0].sessionId, 's-1');
  assert.equal(ws.frames('resume_stream').length, 0, '要停的那一轮不能先续流再停');

  // 3) abort 真的发出去了，这时才收本地生成态
  assert.equal(S.busy, false, 'abort 补发成功后应收掉本地生成态');
  assert.equal(sendLabel(), '发送');
  assert.equal(S.pendingAbort, null, '补发成功后排队要清空');
});

await t('重复点停止：排队期间不重复提示、不重复排队', async () => {
  startGenerating({ path: 'p-2', sessionId: 's-2', title: '重复停止' });
  S.ws = closedSocket();
  S.wsReady = false;
  S.reconnectDelay = 4000;   // 本用例不让它真的重连

  btnSend.dispatchEvent('click');
  const afterFirst = systemLines();
  btnSend.dispatchEvent('click');
  btnSend.dispatchEvent('click');

  assert.equal(systemLines(), afterFirst, '排队期间再点停止不该反复插提示');
  assert.equal(S.busy, true, '仍然是生成态');
  S.pendingAbort = null;
  S.session = null;
});

await t('断线期间换了会话：排队的 abort 作废，不发给新会话', async () => {
  startGenerating({ path: 'p-old', sessionId: 's-old', title: '旧会话' });
  S.ws = closedSocket();
  S.wsReady = false;
  S.reconnectDelay = 4000;
  btnSend.dispatchEvent('click');
  assert.ok(S.pendingAbort, '夹具：应已排队');

  // 用户换了一个会话，并手动连上（openSession 尾部就是 connectWS）
  S.session = { path: 'p-new', sessionId: 's-new', title: '新会话' };
  hana.connectWS();
  const ws = h.MockWebSocket.instances.at(-1);
  ws.open();
  await h.settle(4);

  assert.equal(S.pendingAbort, null, '会话换了，排队的 abort 必须作废');
  assert.equal(ws.frames('abort').length, 0, '绝不能把上一个会话的 abort 发给新会话');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
