/* web/feed/conversation.js lifecycle and prepared-send contract.
 * Deterministic fake API/session/send capabilities only; no DOM, service, or real feed data.
 */

import assert from 'node:assert/strict';
import { createFeedConversation } from '../web/feed/conversation.js';

const ITEM = {
  itemId: 'fi_0123456789ABCDEFGHJKMNPQRS',
  revision: 7,
  title: '日报标题',
  source: { sourceId: 'src-1', agentId: 'agent-source', displayName: '日报助手' },
};
const IDENTITY = { id: 'user-1' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  let identity = IDENTITY;
  let epoch = 10;
  let session = { path: '/old/session', sessionId: 'old-session' };
  let active = true;
  const calls = { api: [], prepare: [], open: [], send: [] };
  const api = async (path, init) => {
    calls.api.push({ path, init, body: JSON.parse(init?.body || '{}') });
    if (overrides.api) return overrides.api(path, init, calls);
    return { path: '/new/session', sessionId: 'new-session', agentId: 'agent-source' };
  };
  const client = {
    async prepare(...args) {
      calls.prepare.push(args);
      if (overrides.prepare) return overrides.prepare(...args, calls);
      return { itemId: ITEM.itemId, revision: ITEM.revision, title: ITEM.title };
    },
  };
  const openSession = (...args) => {
    calls.open.push(args[0]);
    if (overrides.openSession) return overrides.openSession(...args, calls, {
      get epoch() { return epoch; },
      set epoch(value) { epoch = value; },
      get session() { return session; },
      set session(value) { session = value; },
    });
    epoch += 1;
    session = { path: args[0].path, sessionId: args[0].sessionId, token: 'opened-session' };
    return Promise.resolve();
  };
  const sendPrepared = (...args) => {
    calls.send.push(args[0]);
    if (overrides.sendPrepared) return overrides.sendPrepared(...args, calls);
    return Promise.resolve({ frameWritten: true, committed: true, inputId: 'input-1' });
  };
  const conversation = createFeedConversation({
    api,
    client,
    getIdentity: () => identity,
    getNavigationEpoch: () => epoch,
    getSession: () => session,
    openSession,
    sendPrepared,
    isActive: () => active,
  });
  return {
    conversation,
    calls,
    get identity() { return identity; },
    set identity(value) { identity = value; },
    get epoch() { return epoch; },
    set epoch(value) { epoch = value; },
    get session() { return session; },
    set session(value) { session = value; },
    get active() { return active; },
    set active(value) { active = value; },
  };
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('只在 ask 确认时建来源 Agent 的 home 会话，prepare 冻结后发送唯一顶层引用', async () => {
  const h = setup();
  assert.equal(h.calls.api.length, 0, '创建必须等用户明确调用 ask');
  const result = await h.conversation.ask({ item: ITEM, text: '  为什么推荐？  ' });
  assert.deepEqual(h.calls.api.map((call) => call.path), ['/api/sessions/new']);
  assert.deepEqual(h.calls.api[0].body, { agentId: 'agent-source', namespace: 'home' });
  assert.deepEqual(h.calls.prepare, [['new-session', ITEM.itemId, 7]]);
  assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.open[0].agentId, 'agent-source');
  assert.equal(h.calls.open[0].namespace, 'home');
  assert.equal(h.calls.send.length, 1);
  assert.equal(h.calls.send[0].text, '  为什么推荐？  ');
  assert.deepEqual(h.calls.send[0].feed, { itemId: ITEM.itemId, revision: 7, title: ITEM.title });
  assert.equal(h.calls.send[0].isCurrent(), true, '自身 openSession 增加 epoch 后仍属于本尝试');
  assert.equal(result.frameWritten, true);
  assert.equal(result.committed, true);
});

test('缺来源 Agent 或创建响应边界错误均不得打开或发送', async () => {
  const missingAgent = setup();
  const noSource = await missingAgent.conversation.ask({ item: { ...ITEM, source: {} }, text: '问题' });
  assert.equal(noSource.frameWritten, false);
  assert.equal(missingAgent.calls.api.length, 0);
  assert.equal(missingAgent.calls.prepare.length, 0);
  assert.equal(missingAgent.calls.open.length, 0);
  assert.equal(missingAgent.calls.send.length, 0);

  const badResponse = setup({ api: async () => ({ path: '/new/session' }) });
  const invalid = await badResponse.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(invalid.frameWritten, false);
  assert.ok(invalid.error instanceof Error);
  assert.equal(badResponse.calls.prepare.length, 0, '创建响应只在 API 边界校验一次后才流转');
  assert.equal(badResponse.calls.open.length, 0);
  assert.equal(badResponse.calls.send.length, 0);
});

test('重复确认共享同一次创建/prepare/open/send，在途不重复建会话', async () => {
  const gate = deferred();
  const h = setup({ api: () => gate.promise });
  const first = h.conversation.ask({ item: ITEM, text: '问题' });
  const duplicate = h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(duplicate, first, '同一尝试在途返回相同 promise');
  assert.equal(h.calls.api.length, 1);
  gate.resolve({ path: '/new/session', sessionId: 'new-session' });
  await Promise.all([first, duplicate]);
  assert.equal(h.calls.api.length, 1);
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.send.length, 1);
});

test('prepare 拒绝不打开/不发送；手动重试复用已创建 session', async () => {
  let prepareCalls = 0;
  const h = setup({
    prepare: async () => {
      prepareCalls += 1;
      if (prepareCalls === 1) throw new Error('freeze unavailable');
      return { itemId: ITEM.itemId, revision: ITEM.revision, title: ITEM.title };
    },
  });
  const first = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(first.frameWritten, false);
  assert.match(first.error.message, /freeze unavailable/);
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.send.length, 0);

  const retry = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(retry.frameWritten, true);
  assert.equal(h.calls.api.length, 1, '准备失败后重试不能重复创建会话');
  assert.equal(h.calls.prepare.length, 2);
  assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.send.length, 1);
});

test('openSession 失败不发标题或消息；手动重试复用同一创建会话并重新打开', async () => {
  const failure = new Error('history open failed');
  let opens = 0;
  const h = setup({ openSession: (created, _calls, nav) => {
    opens += 1;
    nav.epoch += 1;
    nav.session = { path: created.path, sessionId: created.sessionId, token: `opened-${opens}` };
    return opens === 1 ? Promise.reject(failure) : Promise.resolve();
  } });
  const first = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(first.frameWritten, false);
  assert.equal(first.error, failure);
  assert.equal(h.calls.send.length, 0, '打开历史失败后不能写帧');

  const retry = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(retry.frameWritten, true);
  assert.equal(h.calls.api.length, 1, '手动重试不能重复创建会话');
  assert.equal(h.calls.prepare.length, 1, '冻结上下文仍属于同一会话');
  assert.equal(h.calls.open.length, 2);
  assert.equal(h.calls.send.length, 1);
});

test('创建期间 logout 或手动导航使迟到结果作废', async () => {
  const gate = deferred();
  const h = setup({ api: () => gate.promise });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  h.identity = { id: 'user-2' };
  gate.resolve({ path: '/new/session', sessionId: 'new-session' });
  const result = await pending;
  assert.equal(result.frameWritten, false);
  assert.equal(h.calls.prepare.length, 0);
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.send.length, 0);

  const navGate = deferred();
  const navigating = setup({ api: () => navGate.promise });
  const another = navigating.conversation.ask({ item: ITEM, text: '问题' });
  navigating.epoch += 1;
  navGate.resolve({ path: '/new/session', sessionId: 'new-session' });
  await another;
  assert.equal(navigating.calls.prepare.length, 0);
  assert.equal(navigating.calls.open.length, 0);
  assert.equal(navigating.calls.send.length, 0);
});

test('openSession 前核旧 epoch；同步调用后捕获自有新 epoch/session 再判断归属', async () => {
  const h = setup();
  const result = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.send[0].isCurrent(), true);
  assert.equal(result.frameWritten, true);

  const gate = deferred();
  const pendingOpen = setup({ openSession: (_session, _calls, nav) => {
    nav.epoch += 1;
    nav.session = { path: '/new/session', sessionId: 'new-session', token: 'opened-session' };
    return gate.promise;
  } });
  const pending = pendingOpen.conversation.ask({ item: ITEM, text: '问题' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pendingOpen.calls.send.length, 0, 'openSession 尚未完成不得发送');
  gate.resolve();
  const opened = await pending;
  assert.equal(opened.frameWritten, true);
  assert.equal(pendingOpen.calls.send.length, 1);
});

test('prepare 等待期间 logout 后的迟到冻结结果不得打开或发送', async () => {
  const gate = deferred();
  const h = setup({ prepare: () => gate.promise });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.calls.prepare.length, 1, '测试已进入 prepare 等待');
  h.identity = null;
  gate.resolve({ itemId: ITEM.itemId, revision: ITEM.revision, title: ITEM.title });
  const result = await pending;
  assert.equal(result.frameWritten, false);
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.send.length, 0);
});

test('openSession 等待期间切走再回同一对象，epoch 变化仍应作废且不得发送', async () => {
  const gate = deferred();
  const h = setup({ openSession: (_session, _calls, nav) => {
    nav.epoch += 1;
    nav.session = { path: '/new/session', sessionId: 'new-session', token: 'own-session' };
    return gate.promise;
  } });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const ownSession = h.session;
  assert.ok(ownSession);
  h.epoch += 1;
  h.session = { path: '/user/session', sessionId: 'user-session' };
  h.epoch += 1;
  h.session = ownSession;
  gate.resolve();
  const result = await pending;
  assert.equal(result.frameWritten, false);
  assert.equal(h.calls.send.length, 0);
});

test('logout 在 WS 等待期使传给 prepared sender 的同一归属谓词失效', async () => {
  const gate = deferred();
  let sendOptions = null;
  const h = setup({ sendPrepared: (options) => {
    sendOptions = options;
    return gate.promise;
  } });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(sendOptions, '已进入发送器的 WS 等待');
  h.identity = null;
  assert.equal(sendOptions.isCurrent(), false);
  gate.resolve({ frameWritten: false, committed: false, inputId: null });
  const result = await pending;
  assert.equal(result.frameWritten, false);
});

test('等待 WS 时切走再回同一 session 对象，isCurrent 仍为 false 且不得写帧', async () => {
  const gate = deferred();
  let sendOptions = null;
  const h = setup({ sendPrepared: (options) => {
    sendOptions = options;
    return gate.promise;
  } });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(sendOptions, '应已进入 WS 就绪等待');
  const opened = h.session;
  h.epoch += 1;
  h.session = null;
  h.epoch += 1;
  h.session = opened;
  assert.equal(sendOptions.isCurrent(), false, '仅对象相同不代表导航归属相同');
  gate.resolve({ frameWritten: false, committed: false, inputId: null });
  const result = await pending;
  assert.equal(result.frameWritten, false);
});

test('未写帧的 WS 失败可手动重试同一 session；写帧后任意 UI/commit 错误不能重发', async () => {
  let sends = 0;
  const h = setup({ sendPrepared: () => {
    sends += 1;
    return sends === 1
      ? { frameWritten: false, committed: false, inputId: null, error: new Error('not ready') }
      : { frameWritten: true, committed: true, inputId: 'input-2' };
  } });
  const first = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(first.frameWritten, false);
  const retry = await h.conversation.ask({ item: ITEM, text: '问题' });
  assert.equal(retry.frameWritten, true);
  assert.equal(h.calls.api.length, 1);
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.open.length, 1);
  assert.equal(sends, 2);

  for (const committed of [false, true]) {
    let postWriteSends = 0;
    const postWrite = setup({ sendPrepared: () => {
      postWriteSends += 1;
      return { frameWritten: true, committed, inputId: 'written-id', error: new Error('local UI error') };
    } });
    const sent = await postWrite.conversation.ask({ item: ITEM, text: '问题' });
    const retried = await postWrite.conversation.ask({ item: ITEM, text: '问题' });
    assert.equal(sent.frameWritten, true);
    assert.equal(retried.frameWritten, true);
    assert.equal(retried.inputId, 'written-id');
    assert.equal(retried.error, sent.error, '已写帧后的重试应保留同一 error 结果');
    assert.equal(postWriteSends, 1, '写帧后再次点不能二次发送');
    assert.equal(postWrite.calls.api.length, 1);
  }
});

test('reset 期间迟到的 prepare 不得打开或发送', async () => {
  const gate = deferred();
  const h = setup({ prepare: () => gate.promise });
  const pending = h.conversation.ask({ item: ITEM, text: '问题' });
  await Promise.resolve();
  await Promise.resolve();
  h.conversation.reset();
  gate.resolve({ itemId: ITEM.itemId, revision: ITEM.revision, title: ITEM.title });
  const result = await pending;
  assert.equal(result.frameWritten, false);
  assert.equal(h.calls.open.length, 0);
  assert.equal(h.calls.send.length, 0);
});

let failed = 0;
for (const entry of cases) {
  try {
    await entry.fn();
    console.log(`PASS  ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${entry.name}\n      ${error.stack || error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exitCode = 1;
