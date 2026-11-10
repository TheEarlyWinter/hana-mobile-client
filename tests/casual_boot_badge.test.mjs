/* tests/casual_boot_badge.test.mjs
 *
 * 冷启动后「不打开闲聊」这条路径：WS 推来的 casual_unread 必须能更新主页角标。
 *
 * 为什么要单独一条：casual_integration 里那条「未打开面板时接收 casual_unread」是在
 * 打开过面板之后跑的，而 open() 顺手把 store 的 agentId 补上了，于是掩盖了一个真实缺陷：
 * feature 在 boot() 之前构造，那时 currentAgent 还是 null，store 的 agentId 定成 null；
 * boot() 选出主助手后只刷新了角标，没给 store 绑 agent。之后 WS 推来的事件在
 * casual-store 里按 agentId 过滤时被丢掉，而 handleSocketMessage 照样 return true，
 * 事件就此消失——用户看到的是「冷启动后角标一直不涨，打开一次闲聊就好了」。
 *
 * 这条用例全程不碰面板，只推 WS 事件，直接盯角标。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
const calls = [];

h.setFetch(async (url, init = {}) => {
  const raw = String(url);
  const path = raw.split('?')[0];
  calls.push({ path, method: (init.method || 'GET').toUpperCase() });

  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  if (path === '/api/preferences/chat-ui') return h.jsonRes({ chatUi: { viewMode: 'serene' } });
  if (path === '/api/casual/agent-1/summary') {
    return h.jsonRes({ preview: { text: '在吗', occurredAt: '2026-11-04T03:00:00.000Z' }, unread: 1 });
  }
  if (path === '/api/casual/agent-1/entries') {
    return h.jsonRes({ entries: [], hasMore: false, typing: false });
  }
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeById = (id) => h.allNodes.find((n) => n && n.id === id) || null;
const nodeByClass = (cls) =>
  h.allNodes.find((n) => n && typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) || null;

await h.waitFor(() => S.currentAgent, 'boot 完成');
await h.waitFor(
  () => calls.some((c) => c.path === '/api/casual/agent-1/summary'),
  '启动后应读一次闲聊摘要',
);

await t('冷启动后尚未打开过闲聊：WS 推来 casual_unread，角标要跟着涨', async () => {
  const dot = nodeByClass('casual-dot');
  assert.ok(dot, '入口按钮上应有角标节点');
  await h.waitFor(() => !dot.hidden, '启动后的基线角标应显示');

  const view = nodeByClass('casual-view');
  assert.ok(!view || view.hidden === true, '这条用例全程不打开面板');

  hana.connectWS();
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '应建立 WS 实例');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();

  ws.push({
    type: 'casual_unread',
    agentId: 'agent-1',
    unread: 7,
    preview: { text: '新消息', occurredAt: '2026-11-04T03:10:00.000Z' },
  });

  await h.waitFor(() => dot.textContent === '7', 'WS 推送的未读数必须直接上图');
  assert.equal(dot.hidden, false, '角标应可见');
});

await t('别的 agent 的 unread 事件不会改当前角标', async () => {
  const dot = nodeByClass('casual-dot');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.push({ type: 'casual_unread', agentId: 'agent-other', unread: 99 });
  await sleep(60);
  assert.equal(dot.textContent, '7', '不是当前助手的事件必须丢掉');
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
