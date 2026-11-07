/* 引用条（web/quote-bar.js）在装配层（web/app.js）的行为回归。
 *
 * 纯模块自己已有 12 条契约测试（quote_bar.test.mjs）；这里只锁「app 真的接上了」，
 * 而且必须能从真实入口观察到结果：
 *   - 引用从消息菜单（长按 / contextmenu 入口）发起；
 *   - 「清掉没有」用发送帧（WebSocket 实际写出的 prompt）判断，不看源码、不看内部状态。
 *
 * 契约：
 * 1. 引用是「这条会话、这条消息」的：换到另一个会话后，旧引用不能跟着发出去；
 * 2. 退出登录后，上一条引用不能留给下一个身份；
 * 3. 正常发送一次后引用即被消费（下一条不带）；
 * 4. 同一个会话重开（同一条路径）不算切换：引用和草稿一样留着。
 *
 * 不启动浏览器、不连网关：fetch 全走假路由，WebSocket 用 harness 的 MockWebSocket。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 草稿库读 globalThis.localStorage；装一个进程内假实现，避免受宿主环境影响。 */
const backing = new Map();
globalThis.localStorage = {
  getItem: (key) => (backing.has(key) ? backing.get(key) : null),
  setItem: (key, value) => {
    backing.set(key, String(value));
  },
  removeItem: (key) => {
    backing.delete(key);
  },
  clear: () => backing.clear(),
  key: (index) => [...backing.keys()][index] ?? null,
  get length() {
    return backing.size;
  },
};

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

const h = createHarness();
h.getEl('homeScroll').appendChild(h.getEl('sessionList'));

/* index.html 里引用条挂在 .composer-card 上沿；没有这个挂载点 quoteBar 会整体降级，
 * 用例就观察不到「引用条有没有被收掉」。必须在 loadApp 之前建好。 */
const composerCard = h.makeNode('div', '');
composerCard.className = 'composer-card';
h.body.appendChild(composerCard);

const sessionA = {
  path: 'C:/sessions/quote-a.jsonl',
  sessionId: 'sess-quote-a',
  title: '会话 A',
  agentId: 'agent-1',
  namespace: 'home',
};
const sessionB = {
  path: 'C:/sessions/quote-b.jsonl',
  sessionId: 'sess-quote-b',
  title: '会话 B',
  agentId: 'agent-1',
  namespace: 'home',
};

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: '助手1' }],
      currentAgent: { id: 'agent-1', name: '助手1' },
      sessions: [sessionA, sessionB],
      homeFolder: 'C:/work',
      auth: { token: 't-1' },
    });
  }
  if (path === '/api/web-auth/logout') return h.jsonRes({ ok: true });
  if (path === '/api/sessions/new') {
    return h.jsonRes({
      path: 'C:/sessions/quote-new.jsonl',
      sessionId: 'sess-quote-new',
      title: '新对话',
      agentId: 'agent-1',
      namespace: 'home',
    });
  }
  if (path.startsWith('/api/sessions/list') || path === '/api/sessions') {
    return h.jsonRes({ ok: true, sessions: [sessionA, sessionB] });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ entries: [], hasMore: false });
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

/* ------------------------------------------------------------------ */
/* 真实入口与观察点                                                    */
/* ------------------------------------------------------------------ */

function quoteBarEl() {
  return h.find(composerCard, '.quote-bar');
}

/** 打开会话并等到它自己的连接就绪（发送要过 waitForReady）。 */
async function openAndConnect(session) {
  const before = h.MockWebSocket.instances.length;
  await hana.openSession(session);
  await h.waitFor(() => S.session?.path === session.path, `切到 ${session.title}`);
  await h.waitFor(() => h.MockWebSocket.instances.length > before, `${session.title} 的连接已建立`);
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();
  await h.waitFor(() => S.wsReady === true, `${session.title} 连接就绪`);
  return ws;
}

/** 从真实消息菜单点「引用」：长按/contextmenu 入口 → 菜单项 → app 层 quoteBar.set。 */
function quoteViaMenu(text) {
  const turn = hana.appendUser(text);
  const transcript = h.getEl('transcript');
  transcript.dispatchEvent('contextmenu', { target: turn });
  assert.equal(hana.messageActionsMenu.isOpen(), true, '消息菜单必须由真实 contextmenu 入口打开');

  const quoteButton = h
    .findAll(h.body, '.msg-actions-item')
    .find((node) => node.getAttribute('data-action') === 'quote');
  assert.ok(quoteButton, '菜单里必须有引用入口');
  quoteButton.dispatchEvent('click');
}

async function sendText(text) {
  const input = h.getEl('input');
  input.value = text;
  input.dispatchEvent('input', { target: input });
  await hana.sendMessage();
}

function lastPrompt(ws) {
  const prompts = ws.frames('prompt');
  return prompts[prompts.length - 1] || null;
}

/* ------------------------------------------------------------------ */
/* 1. 换会话                                                           */
/* ------------------------------------------------------------------ */

await t('引用后切到另一个会话：旧引用不进入新会话的发送帧', async () => {
  const wsA = await openAndConnect(sessionA);
  quoteViaMenu('A 里被引用的那句');
  assert.ok(quoteBarEl(), '引用条应挂在输入区上沿');
  assert.equal(quoteBarEl().hidden, false, '引用后引用条应可见');
  assert.match(quoteBarEl().textContent, /A 里被引用的那句/);

  // 真实路径：先退回列表，再从列表进入另一个会话。
  assert.equal(hana.backToList(), true, '聊天页返回应被页面自己处理');

  const wsB = await openAndConnect(sessionB);
  await sendText('发给 B 的话');
  const sent = lastPrompt(wsB);
  assert.ok(sent, 'B 必须真的发出了一帧 prompt');
  assert.equal(sent.sessionPath, sessionB.path, '帧必须落在 B 上');
  assert.equal(sent.text, '发给 B 的话', '新会话的第一条不能带上一会话的引用');
  assert.equal(quoteBarEl().hidden, true, '换到另一个会话后，旧引用条必须收起');

  // 对照：A 那条连接上除了打开时的握手，没有发出任何 prompt。
  assert.equal(wsA.frames('prompt').length, 0, '切走前没有发送');
});

/* ------------------------------------------------------------------ */
/* 2. 首页发送打开新会话：也是一次真实切换                             */
/* ------------------------------------------------------------------ */

await t('引用后从首页发送新会话：旧引用不进入移交后的第一条', async () => {
  await openAndConnect(sessionA);
  quoteViaMenu('A 里最后被引用的那句');
  assert.equal(quoteBarEl().hidden, false, '引用后引用条应可见');
  assert.equal(hana.backToList(), true, '先退回列表');

  const homeInput = h.getEl('homeInput');
  const before = h.MockWebSocket.instances.length;
  homeInput.value = '首页移交的话';
  const pending = hana.sendFromHome();
  await h.waitFor(() => h.MockWebSocket.instances.length > before, '首页发送已打开新连接');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();
  await pending;

  const sent = lastPrompt(ws);
  assert.ok(sent, '首页发送必须真的发出一帧 prompt');
  assert.equal(sent.text, '首页移交的话', '移交后的第一条不能带旧会话的引用');
  assert.equal(quoteBarEl().hidden, true, '换到新会话后旧引用条必须收起');
});

/* ------------------------------------------------------------------ */
/* 3. 退出登录                                                         */
/* ------------------------------------------------------------------ */

await t('退出登录：旧引用不留给下一个身份的第一条发送', async () => {
  await openAndConnect(sessionB);
  quoteViaMenu('B 里被引用的那句');
  assert.equal(quoteBarEl().hidden, false, '引用后引用条应可见');

  assert.equal(await hana.loginController.logout(), true, '退登应成功');
  assert.equal(hana.S.principal, null, '夹具：已退出登录');

  // 新身份登录后打开会话并发送（登出后的登录页与正常登录共用同一套 app 实例）。
  S.principal = { id: 'user-2' };
  const wsB = await openAndConnect(sessionB);
  await sendText('新身份的话');
  const sent = lastPrompt(wsB);
  assert.ok(sent, '新身份必须真的发出了一帧 prompt');
  assert.equal(sent.text, '新身份的话', '上一条引用不能跟着新身份发出去');
  assert.equal(quoteBarEl().hidden, true, '退登后旧引用条必须收起');
});

/* ------------------------------------------------------------------ */
/* 4. 正常发送即消费                                                   */
/* ------------------------------------------------------------------ */
await t('同一条引用只作用于一次发送：发完下一条不带', async () => {
  const ws = await openAndConnect(sessionA);
  quoteViaMenu('A 里要引用的话');

  await sendText('带引用的话');
  const first = lastPrompt(ws);
  assert.ok(first, '第一条必须发出去');
  assert.equal(first.text, '> 你：A 里要引用的话\n\n带引用的话', '发出去的正文必须是「引用 + 空行 + 原文」');
  assert.equal(quoteBarEl().hidden, true, '发出去之后引用条应收起');

  hana.composer.setBusy(false); // 模拟本轮结束
  await sendText('第二条');
  const second = lastPrompt(ws);
  assert.equal(second.text, '第二条', '第二条不能再带已经发过的引用');
});

/* ------------------------------------------------------------------ */
/* 5. 同会话重开不算切换                                               */
/* ------------------------------------------------------------------ */

await t('同一个会话重开（同一条路径）保留引用，不清空也不重复拼', async () => {
  await openAndConnect(sessionA);
  quoteViaMenu('A 里保留的引用');
  assert.equal(quoteBarEl().hidden, false, '引用后引用条应可见');

  // 同一条路径重新打开：不是「切到另一个会话」。
  const ws = await openAndConnect(sessionA);
  assert.equal(quoteBarEl().hidden, false, '同一个会话重开不该把引用丢掉');

  await sendText('重进后发的话');
  assert.equal(
    lastPrompt(ws).text,
    '> 你：A 里保留的引用\n\n重进后发的话',
    '同会话重开后引用仍应拼在正文前，且只拼一次',
  );

  // 收尾：点 × 清掉，避免把状态留给后面的用例。
  quoteBarEl().querySelector('.quote-bar-cancel').dispatchEvent('click');
  assert.equal(quoteBarEl().hidden, true, '点 × 应收起引用条');
});

/* ------------------------------------------------------------------ */
/* 6. 引用消费：按发起时的版本，与输入框是否被改过无关               */
/* ------------------------------------------------------------------ */

/** 打开会话但先不打开它的 WS：制造「等待连接」的发送窗口。 */
async function openAndHold(session) {
  const before = h.MockWebSocket.instances.length;
  await hana.openSession(session);
  await h.waitFor(() => S.session?.path === session.path, `切到 ${session.title}`);
  await h.waitFor(() => h.MockWebSocket.instances.length > before, `${session.title} 的连接已建立`);
  return h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
}

await t('等待连接时改稿：旧引用成功发送后不复用', async () => {
  const ws = await openAndHold(sessionA);
  quoteViaMenu('A 里要被消费的引用');
  const input = h.getEl('input');
  input.value = '带引用的话';
  input.dispatchEvent('input', { target: input });

  const sending = hana.sendMessage();
  // 等待期间用户继续改草稿（引用不动）：这次发送成功后引用照样该被消费。
  input.value = '等待时改的草稿';
  input.dispatchEvent('input', { target: input });

  ws.open();
  await sending;

  assert.equal(
    lastPrompt(ws).text,
    '> 你：A 里要被消费的引用\n\n带引用的话',
    '发出去的必须是发起时的快照',
  );
  assert.equal(quoteBarEl().hidden, true, '发送成功后旧引用必须被消费，与输入框是否被改过无关');

  hana.composer.setBusy(false);
  await sendText('等待时改的草稿');
  assert.equal(lastPrompt(ws).text, '等待时改的草稿', '等待期间的新草稿不能复用已经发出去的引用');
});

await t('等待连接时改选新引用：新引用留给下一条', async () => {
  const ws = await openAndHold(sessionB);
  quoteViaMenu('旧引用');
  const input = h.getEl('input');
  input.value = '第一条';
  input.dispatchEvent('input', { target: input });

  const sending = hana.sendMessage();
  // 等待期间改选另一条引用：它属于下一条消息，不能被这次旧发送清掉。
  quoteViaMenu('等待时改选的新引用');

  ws.open();
  await sending;

  assert.equal(lastPrompt(ws).text, '> 你：旧引用\n\n第一条', '发出去的仍是发起时的旧引用');
  assert.equal(quoteBarEl().hidden, false, '等待期间改选的新引用不能被旧发送清掉');
  assert.match(quoteBarEl().textContent, /等待时改选的新引用/);

  hana.composer.setBusy(false);
  await sendText('第二条');
  assert.equal(lastPrompt(ws).text, '> 你：等待时改选的新引用\n\n第二条', '新引用必须留给下一条');
  assert.equal(quoteBarEl().hidden, true, '新引用发出去后才该收起');
});

await t('发送失败：原引用与草稿都保留', async () => {
  const ws = await openAndConnect(sessionA);
  quoteViaMenu('失败也要留着的引用');
  const input = h.getEl('input');
  input.value = '发不出去的话';
  input.dispatchEvent('input', { target: input });

  const sending = hana.sendMessage();
  // 握手后、写帧前断线：sendFrame 返回 false，commitSent 不会发生。
  ws.serverClose();
  await sending;

  assert.equal(ws.frames('prompt').length, 0, '失败时不能写出 prompt 帧');
  assert.equal(input.value, '发不出去的话', '发送失败必须保留草稿');
  assert.equal(quoteBarEl().hidden, false, '发送失败必须保留引用');
  assert.match(quoteBarEl().textContent, /失败也要留着的引用/);

  // serverClose 会排一个重连定时器；退回列表会 drop 连接并取消它。
  hana.backToList();
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
