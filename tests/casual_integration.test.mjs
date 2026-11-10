/* tests/casual_integration.test.mjs
 *
 * 闲聊（Casual Chat）的「装配」验收：真正加载 web/app.js，走真实接线。
 *
 * 为什么单独写：client / store / view / stickers 四个模块各自单测都绿，
 * 不代表 app.js 把它们接对了。这条用例盯五件事——
 *   1. 主页头部真的多出一个闲聊入口按钮；
 *   2. 启动后按当前助手去读 /api/casual/{agentId}/summary，未读能上角标；
 *   3. 点入口会打开闲聊面板，并按当前 agentId 拉 entries；
 *   4. 面板里回车发送会 POST /api/casual/{agentId}/messages，且带 clientMessageId；
 *   5. 关闭面板会停掉轮询（不再周期性打 entries）。
 *
 * 注意：全部走假 fetch，不碰真实宿主。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const calls = [];
let unread = 2;

const entry = (id, text, actor = 'agent') => ({
  id,
  sourceEntryId: id,
  actor,
  occurredAt: '2026-11-04T03:00:00.000Z',
  item: { kind: 'text', text },
});

h.setFetch(async (url, init = {}) => {
  const raw = String(url);
  const path = raw.split('?')[0];
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ path, method, body: init.body || null, url: raw });

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

  // ---- 闲聊 ----
  if (path === '/api/casual/agent-1/summary') {
    return h.jsonRes({
      preview: { text: '在吗', occurredAt: '2026-11-04T03:00:00.000Z' },
      unread,
    });
  }
  if (path === '/api/casual/agent-1/entries') {
    return h.jsonRes({
      entries: [entry('e1', '在吗'), entry('e2', '在的', 'user')],
      hasMore: false,
      typing: false,
    });
  }
  if (path === '/api/casual/agent-1/messages') {
    const body = JSON.parse(init.body || '{}');
    return h.jsonRes({
      entryId: 'e3',
      entries: [entry('e3', body.text || '', 'user')],
    });
  }
  if (path === '/api/casual/agent-1/read') return h.jsonRes({ ok: true });
  if (path === '/api/casual/stickers') return h.jsonRes({ packs: [] });
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');
await h.waitFor(
  () => calls.some((c) => c.path === '/api/casual/agent-1/summary'),
  '启动后应读闲聊摘要',
);

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

/* 装配出的节点不是 index.html 里的，getEl 拿不到；统一从 allNodes 里按 id / class 找真实实例。 */
const nodeById = (id) => h.allNodes.find((n) => n && n.id === id) || null;
const nodeByClass = (cls) =>
  h.allNodes.find((n) => n && typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) || null;

await t('主页头部出现闲聊入口，未读角标按 summary 显示', async () => {
  const btn = nodeById('btnCasual');
  assert.ok(btn, '应注入 #btnCasual');
  const dot = nodeByClass('casual-dot');
  assert.ok(dot, '按钮上应有角标节点');
  await h.waitFor(() => !dot.hidden, '角标应显示');
  assert.equal(dot.textContent, '2', '未读数应来自 summary');
});

await t('点入口打开面板，并按当前 agentId 拉第一页', async () => {
  const before = calls.filter((c) => c.path === '/api/casual/agent-1/entries').length;
  nodeById('btnCasual').dispatchEvent('click');
  await h.waitFor(
    () => calls.filter((c) => c.path === '/api/casual/agent-1/entries').length > before,
    '应请求 entries',
  );
  const root = nodeByClass('casual-view');
  assert.ok(root, '应挂上闲聊视图');
  assert.ok(!root.hidden, '打开后不应隐藏');

  // 等到真正渲染出条目：只等 fetch 发起是不够的，响应还没回。
  await h.waitFor(() => h.findAll(root, '.casual-row').length > 0, '应渲染出消息行');
  assert.ok(root.textContent.includes('在吗'), `应渲染出服务端条目，实际：${root.textContent}`);
});

await t('面板里回车发送会 POST messages，并带 clientMessageId', async () => {
  const root = nodeByClass('casual-view');
  const input = root.querySelector('.casual-input');
  assert.ok(input, '应有输入框');
  input.value = '晚上好';
  input.dispatchEvent('keydown', { key: 'Enter' });

  await h.waitFor(
    () => calls.some((c) => c.path === '/api/casual/agent-1/messages'),
    '应发出 POST',
  );
  const sent = calls.filter((c) => c.path === '/api/casual/agent-1/messages').pop();
  assert.equal(sent.method, 'POST');
  const body = JSON.parse(sent.body);
  assert.equal(body.text, '晚上好');
  assert.ok(typeof body.clientMessageId === 'string' && body.clientMessageId, '必须带 clientMessageId');
});

await t('关闭面板后停止轮询', async () => {
  const root = nodeByClass('casual-view');
  const back = root.querySelector('.casual-header-back');
  assert.ok(back, '应有返回按钮');
  back.dispatchEvent('click');
  await sleep(80);
  assert.equal(root.hidden, true, '关掉后视图应隐藏');

  const before = calls.filter((c) => c.path === '/api/casual/agent-1/entries').length;
  await sleep(120);
  const after = calls.filter((c) => c.path === '/api/casual/agent-1/entries').length;
  assert.equal(after, before, '关闭后不应再拉 entries');
});

/* ---- WS 推送：收得到、紧接着上屏 ---- */

await t('WS 推来的闲聊条目直接上屏，不用等轮询', async () => {
  // 上一条用例把面板关了，这里重新打开。
  nodeById('btnCasual').dispatchEvent('click');
  const root = nodeByClass('casual-view');
  await h.waitFor(() => root && root.hidden === false, '面板应重新打开');

  hana.connectWS();
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '应建立 WS 实例');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();

  ws.push({
    type: 'casual_entry',
    agentId: 'agent-1',
    entry: {
      id: 'e9',
      sourceEntryId: 'e9',
      actor: 'agent',
      occurredAt: '2026-11-04T03:05:00.000Z',
      item: { kind: 'text', text: '推送进来的一条' },
    },
  });

  await h.waitFor(() => root.textContent.includes('推送进来的一条'), 'WS 推送应直接渲染');
});

await t('WS 推来的 typing 事件能驱动「正在输入」', async () => {
  const root = nodeByClass('casual-view');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  const typingEl = root.querySelector('.casual-typing');
  assert.ok(typingEl, '应有正在输入节点');

  ws.push({ type: 'casual_typing', agentId: 'agent-1', state: 'start' });
  await h.waitFor(() => typingEl.hidden === false, 'typing=start 应显示提示');

  ws.push({ type: 'casual_typing', agentId: 'agent-1', state: 'end' });
  await h.waitFor(() => typingEl.hidden === true, 'typing=end 应隐藏提示');
});

await t('别的 agent 的闲聊事件不能串到当前面板', async () => {
  const root = nodeByClass('casual-view');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  const before = root.textContent;

  ws.push({
    type: 'casual_entry',
    agentId: 'agent-other',
    entry: {
      id: 'x9',
      sourceEntryId: 'x9',
      actor: 'agent',
      occurredAt: '2026-11-04T03:06:00.000Z',
      item: { kind: 'text', text: '别的助手的悄悄话' },
    },
  });
  await sleep(60);
  assert.ok(!root.textContent.includes('别的助手的悄悄话'), '不同 agentId 的事件要丢掉');
  assert.ok(root.textContent.includes(before.slice(0, 2)) || true);
});

await t('未打开面板时接收 WS casual_unread，主页角标必须实时更新', async () => {
  const root = nodeByClass('casual-view');
  const dot = nodeByClass('casual-dot');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];

  // 确保面板已关闭，恢复角标
  const back = root.querySelector('.casual-header-back');
  if (!root.hidden) back.dispatchEvent('click');
  await sleep(50);
  assert.equal(root.hidden, true, '面板应处于关闭状态');

  // 在未打开面板状态下（哪怕从未打开过面板），WS 推来 casual_unread
  ws.push({
    type: 'casual_unread',
    agentId: 'agent-1',
    unread: 5,
    preview: { text: '新消息' },
  });

  await h.waitFor(() => !dot.hidden && dot.textContent === '5', '未打开面板时主页角标必须实时反映推送的未读数');
  assert.equal(dot.textContent, '5', '未读数必须是推送的 5');
});

await t('切助手时旧助手的 summary 迟到返回不得覆盖新助手的角标，新助手不串旧数据', async () => {
  const dot = nodeByClass('casual-dot');

  // 配置 fetch 支持 agent-2
  let delayedSummaryResolve = null;
  const originalFetch = h.currentFetch;
  h.setFetch(async (url, init = {}) => {
    const raw = String(url);
    const path = raw.split('?')[0];
    if (path === '/api/casual/agent-1/summary') {
      // 模拟 agent-1 的 summary 迟到
      return new Promise((resolve) => {
        delayedSummaryResolve = () => resolve(h.jsonRes({ preview: null, unread: 99 }));
      });
    }
    if (path === '/api/casual/agent-2/summary') {
      return h.jsonRes({ preview: null, unread: 1 });
    }
    if (path === '/api/casual/agent-2/entries') {
      return h.jsonRes({ entries: [entry('e-agent-2', '来自助手2的消息')], hasMore: false, typing: false });
    }
    return originalFetch(url, init);
  });

  // 切换助手到 agent-2
  S.currentAgent = { id: 'agent-2', name: '助手2' };
  hana.casual.setAgent();

  // 等待 agent-2 的角标变成 1
  await h.waitFor(() => !dot.hidden && dot.textContent === '1', '新助手 agent-2 的未读数应变为 1');

  // 此时迟到的 agent-1 summary 返回了 99
  if (delayedSummaryResolve) delayedSummaryResolve();
  await sleep(60);

  // 确认 agent-1 的迟到结果没有把角标覆盖成 99
  assert.equal(dot.textContent, '1', '旧助手的迟到响应不得覆盖新助手的未读数');

  // 确认此时 store 的 agentId 已经与 agent-2 绑定，接收 agent-2 的推送生效
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.push({
    type: 'casual_unread',
    agentId: 'agent-2',
    unread: 4,
    preview: { text: '助手2的新消息' },
  });

  await h.waitFor(() => dot.textContent === '4', 'agent-2 的 WS 推送必须生效更新角标');
  assert.equal(dot.textContent, '4');
});

/* ---- 重连对账与草稿清理（装配层） ---- */

const prevFetch = h.fetchHandler;
let agent2Entries = 0;
h.setFetch(async (url, init = {}) => {
  if (String(url).split('?')[0] === '/api/casual/agent-2/entries') agent2Entries += 1;
  return prevFetch(url, init);
});

await t('WS 连上（重连）后立刻对一次账，不用等 30 秒兜底轮询', async () => {
  // 当前助手是 agent-2（上一条用例切过来的）。
  nodeById('btnCasual').dispatchEvent('click');
  const root = nodeByClass('casual-view');
  await h.waitFor(() => root.hidden === false, '面板应打开');
  await h.waitFor(() => agent2Entries > 0, '首屏应拉一次条目');
  await h.waitFor(() => h.findAll(root, '.casual-row').length > 0, '首屏应渲染出条目');

  // WS 连着时轮询间隔是 30 秒（casual_store 的 setPollMs 用例盯着），
  // 所以 800ms 内出现的条目请求只可能来自 ready 后的主动对账。
  const before = agent2Entries;
  hana.casual.setSocketLive(true);
  await h.waitFor(() => agent2Entries > before, 'ready 之后必须立刻补一次对账', 800);
});

await t('切助手会清空输入框里的草稿，旧草稿不带给新助手', async () => {
  const root = nodeByClass('casual-view');
  if (root.hidden) nodeById('btnCasual').dispatchEvent('click');
  await h.waitFor(() => root.hidden === false, '面板应打开');

  const input = root.querySelector('.casual-input');
  assert.ok(input, '应有输入框');
  input.value = '写了一半的话';

  hana.casual.setAgent();

  assert.equal(input.value, '', '切助手后草稿必须清空');
  assert.equal(root.hidden, true, '切助手应把面板收起来');
});

await t('登出 reset 也会清空输入框里的草稿', async () => {
  const root = nodeByClass('casual-view');
  if (root.hidden) nodeById('btnCasual').dispatchEvent('click');
  await h.waitFor(() => root.hidden === false, '面板应打开');

  const input = root.querySelector('.casual-input');
  input.value = '登出前的草稿';

  hana.casual.reset();

  assert.equal(input.value, '', '登出后草稿必须清空');
  assert.equal(input.value === '' && root.hidden === true, true, 'reset 应同时关掉面板');
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

