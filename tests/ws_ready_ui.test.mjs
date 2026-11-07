/* 缺陷回归：WS 替换 / 主动断开时，页面上的「连接点」和发送按钮必须跟着变
 *
 * 根因：connect() 替换旧连接只摘引用、关旧 socket，没有把 wsReady 打回 false，
 * 也没通知 onReadyChange(false)；drop() 只改了状态，同样没通知界面。
 * 结果：切会话后新连接还没 open，指示灯还亮着、发送按钮还能点，消息会写进空气。
 *
 * 锁的行为：从「已就绪」进入替换或 drop 时，立刻 wsReady=false 并回调 onReadyChange(false)；
 * 新连接 open 之后才恢复。不改 app.js，只验证现有接线拿到的结果。
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
      homeFolder: 'C:/work/OH-WorkSpace',
    });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const dot = h.getEl('connDot');
const sendBtn = h.getEl('btnSend');
const input = h.getEl('input');

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

await t('连接就绪：连接点亮、发送按钮可用', async () => {
  S.session = { path: 'p-ui', sessionId: 's-ui', title: 'UI' };
  S.busy = false;
  input.value = '草稿';
  input.dispatchEvent('input');

  hana.connectWS();
  const ws = h.MockWebSocket.instances.at(-1);
  ws.open();
  await h.settle(2);

  assert.equal(S.wsReady, true, '夹具：连接应已就绪');
  assert.equal(dot.className, 'dot on', '就绪时连接点应亮');
  assert.equal(sendBtn.disabled, false, '有草稿且连接就绪时应能发送');
});

await t('替换连接：立刻熄灭连接点并禁用发送，新连接 open 后恢复', async () => {
  hana.connectWS();                    // 切会话 / 回前台会走这里

  assert.equal(S.wsReady, false, '替换连接后必须立刻认为未就绪');
  assert.equal(dot.className, 'dot off', '旧连接关掉后不能继续显示已连接');
  assert.equal(sendBtn.disabled, true, '新连接没就绪前不能允许发送');

  const ws2 = h.MockWebSocket.instances.at(-1);
  ws2.open();
  await h.settle(2);

  assert.equal(S.wsReady, true);
  assert.equal(dot.className, 'dot on', '新连接 open 后才恢复连接点');
  assert.equal(sendBtn.disabled, false, '新连接就绪后发送按钮应恢复');
});

await t('主动断开（退列表）：连接点熄灭、发送按钮禁用', async () => {
  h.getEl('view-chat').hidden = false;
  S.busy = false;
  const handled = hana.backToList();
  assert.equal(handled, true, '夹具：应真的退回列表');

  assert.equal(S.session, null);
  assert.equal(S.wsReady, false);
  assert.equal(dot.className, 'dot off', '主动收摊也必须把连接点熄掉');
  assert.equal(sendBtn.disabled, true, '断开后不能还留着可点的发送按钮');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
