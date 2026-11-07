/* tests/casual_store.test.mjs — 闲聊状态机测试
 *
 * 用假 client + 假定时器，覆盖：首屏加载与轮询启动、轮询去重合并、乐观发送与对账、
 * 失败标记与 retry 复用 clientMessageId、loadEarlier 前插与 hasMore、已读去重、
 * 换 agent 清空重载、连续三次失败才上报并恢复、reset 回执清空、close 停轮询。
 */

import assert from 'node:assert/strict';
import { createCasualStore } from '../web/casual-store.js';

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

function serverEntry({ id, sourceEntryId, actor = 'agent', occurredAt, item, clientMessageId }) {
  const entry = {
    id,
    sourceEntryId,
    actor,
    occurredAt: occurredAt || '2026-11-04T02:00:00.000Z',
    item: item || { kind: 'text', text: id },
  };
  if (clientMessageId) entry.clientMessageId = clientMessageId;
  return entry;
}

function createClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    size() {
      return timers.size;
    },
    list() {
      return [...timers.values()].map((timer) => ({ ms: timer.ms }));
    },
    async tick() {
      const batch = [...timers.entries()];
      timers.clear();
      for (const [, timer] of batch) await timer.fn();
    },
  };
}

function createFakeClient({ agentId = 'agent-1', summary, page } = {}) {
  const client = {
    agentId,
    summary: summary ?? { preview: null, unread: 0 },
    page: page ?? { entries: [], hasMore: false, typing: false },
    summaryCalls: 0,
    pageCalls: [],
    sendCalls: [],
    readCalls: [],
    agentChanges: [],
    onSend: null,
    onMarkRead: null,
    getAgentId() {
      return client.agentId;
    },
    setAgentId(id) {
      client.agentChanges.push(id);
      client.agentId = id;
    },
    async loadSummary() {
      client.summaryCalls += 1;
      const value = typeof client.summary === 'function' ? client.summary(client) : client.summary;
      if (value instanceof Error) throw value;
      return value;
    },
    async loadPage(options) {
      client.pageCalls.push(options);
      const value = typeof client.page === 'function' ? client.page(client, options) : client.page;
      if (value instanceof Error) throw value;
      return value;
    },
    async send(message) {
      client.sendCalls.push(message);
      if (typeof client.onSend === 'function') return client.onSend(message, client);
      return { entryId: `srv-${message.clientMessageId}`, entries: [], reset: false };
    },
    async markRead(entryId) {
      client.readCalls.push(entryId);
      if (typeof client.onMarkRead === 'function') return client.onMarkRead(entryId, client);
      return { ok: true, reset: false };
    },
  };
  return client;
}

function createStore(client, clock) {
  const states = [];
  const store = createCasualStore({
    client,
    now: () => 1_760_000_000_000,
    pollMs: 4000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (state) => states.push(state),
  });
  return { store, states };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const summary1 = {
  preview: { text: '在吗', occurredAt: '2026-11-04T02:00:00.000Z' },
  unread: 2,
};

const page1 = {
  entries: [
    serverEntry({ id: 'e1', sourceEntryId: 's1', occurredAt: '2026-11-04T01:00:00.000Z' }),
    serverEntry({ id: 'e2', sourceEntryId: 's2', occurredAt: '2026-11-04T02:00:00.000Z' }),
  ],
  hasMore: true,
  typing: true,
};

/* ---- 1. 首屏 ---- */

await t('首屏加载 summary + 第一页，启动 4s 轮询，快照不可变', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store, states } = createStore(client, clock);

  const ok = await store.open();
  assert.equal(ok, true);

  const snap = store.getState();
  assert.equal(snap.agentId, 'agent-1');
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['e1', 'e2']);
  assert.equal(snap.hasMore, true);
  assert.equal(snap.typing, true);
  assert.equal(snap.unread, 2);
  assert.deepEqual(snap.preview, { text: '在吗', occurredAt: '2026-11-04T02:00:00.000Z' });
  assert.equal(snap.loading, false);
  assert.equal(snap.loadingEarlier, false);
  assert.equal(snap.error, null);
  assert.equal(snap.sending.size, 0);
  assert.ok(snap.sending instanceof Map, 'sending 必须是 Map');

  assert.equal(client.pageCalls.length, 1);
  assert.equal(client.pageCalls[0], undefined, '首屏不能带 before');
  assert.equal(client.summaryCalls, 1);

  assert.equal(clock.size(), 1, 'open() 后应有一个轮询定时器');
  assert.deepEqual(clock.list(), [{ ms: 4000 }]);
  assert.ok(states.length >= 2, '至少要有 loading 开始与结束两次通知');

  assert.throws(() => {
    snap.entries.push({});
  }, TypeError);
  assert.throws(() => {
    snap.entries[0].item.text = '改一下';
  }, TypeError);
  assert.equal(snap.entries[0].item.text, 'e1', '外部改快照不能影响内部状态');
});

await t('快照深拷贝：嵌套 block 与数组也不能被监听器改动', async () => {
  const clock = createClock();
  const page = {
    entries: [
      serverEntry({
        id: 'c1',
        sourceEntryId: 'cs1',
        item: { kind: 'card', cardId: 'card-1', title: '卡片', block: { rows: [{ text: 'a' }] } },
      }),
    ],
    hasMore: false,
    typing: false,
  };
  const client = createFakeClient({ summary: { preview: null, unread: 0 }, page });
  const { store } = createStore(client, clock);
  await store.open();

  const snap = store.getState();
  assert.throws(() => {
    snap.entries[0].item.block.rows[0].text = '篡改';
  }, TypeError);
  assert.throws(() => {
    snap.entries[0].item.block.rows.push({});
  }, TypeError);
  assert.equal(store.getState().entries[0].item.block.rows[0].text, 'a');
  assert.notEqual(store.getState().entries[0].item.block, page.entries[0].item.block, '快照不能与内部对象同引用');
});

/* ---- 2. 轮询 ---- */

await t('轮询合并新条目、去重、更新未读与 typing，并继续排下一轮', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  client.page = {
    entries: [
      page1.entries[1], // 同 s2，必须去重
      serverEntry({ id: 'e3', sourceEntryId: 's3', occurredAt: '2026-11-04T03:00:00.000Z' }),
    ],
    hasMore: true,
    typing: false,
  };
  client.summary = { preview: null, unread: 5 };

  await clock.tick();

  const snap = store.getState();
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['e1', 'e2', 'e3']);
  assert.equal(snap.unread, 5);
  assert.equal(snap.typing, false);
  assert.equal(client.pageCalls.length, 2);
  assert.equal(client.pageCalls[1], undefined, '轮询拉的是第一页，不带 before');
  assert.equal(clock.size(), 1, '每轮结束都要排下一轮');
});

/* ---- 3. 乐观发送 ---- */

await t('乐观发送：先插本地 pending 条目，成功后按 clientMessageId 与回显对账', async () => {
  const clock = createClock();
  const client = createFakeClient({
    summary: { preview: null, unread: 0 },
    page: { entries: [], hasMore: false, typing: false },
  });
  const { store } = createStore(client, clock);
  await store.open();

  const gate = deferred();
  client.onSend = () => gate.promise;

  const sending = store.send('你好');
  const clientMessageId = client.sendCalls[0].clientMessageId;
  assert.equal(typeof clientMessageId, 'string');
  assert.ok(clientMessageId.length > 0);

  let snap = store.getState();
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].actor, 'user');
  assert.equal(snap.entries[0].pending, true);
  assert.equal(snap.entries[0].failed, false);
  assert.equal(snap.entries[0].clientMessageId, clientMessageId);
  assert.equal(snap.entries[0].item.text, '你好');
  assert.equal(snap.sending.get(clientMessageId).status, 'sending');
  assert.equal(snap.sending.get(clientMessageId).payload.text, '你好');

  gate.resolve({
    entryId: 'srv-1',
    entries: [
      serverEntry({
        id: 'srv-1',
        sourceEntryId: 'src-1',
        actor: 'user',
        occurredAt: '2026-11-04T04:00:00.000Z',
        item: { kind: 'text', text: '你好' },
        clientMessageId,
      }),
    ],
    reset: false,
  });

  const result = await sending;
  assert.equal(result.ok, true);
  assert.equal(result.entryId, 'srv-1');

  snap = store.getState();
  assert.equal(snap.entries.length, 1, '本地乐观条目必须被服务端条目替换，不能重复');
  assert.equal(snap.entries[0].id, 'srv-1');
  assert.equal(Boolean(snap.entries[0].pending), false);
  assert.equal(snap.sending.size, 0);

  // 下一轮轮询再拿到同一条也不应重复
  client.page = {
    entries: [
      serverEntry({
        id: 'srv-1',
        sourceEntryId: 'src-1',
        actor: 'user',
        occurredAt: '2026-11-04T04:00:00.000Z',
        item: { kind: 'text', text: '你好' },
        clientMessageId,
      }),
    ],
    hasMore: false,
    typing: false,
  };
  await clock.tick();
  assert.equal(store.getState().entries.length, 1);
});

await t('send 支持贴纸对象；空内容直接拒绝', async () => {
  const clock = createClock();
  const client = createFakeClient({
    summary: { preview: null, unread: 0 },
    page: { entries: [], hasMore: false, typing: false },
  });
  const { store } = createStore(client, clock);
  await store.open();

  const result = await store.send({ stickerId: 'st-1', stickerUrl: '/stickers/st-1.png' });
  assert.equal(result.ok, true);
  const snap = store.getState();
  assert.equal(snap.entries.length, 1);
  assert.deepEqual(snap.entries[0].item, {
    kind: 'sticker',
    stickerId: 'st-1',
    url: '/stickers/st-1.png',
  });
  assert.deepEqual(client.sendCalls[0].stickerId, 'st-1');

  await assert.rejects(() => store.send('   '), /发送内容为空/);
  await assert.rejects(() => store.send({}), /发送内容为空/);
  await assert.rejects(() => store.send(null), /send 需要/);
});

/* ---- 4. 失败与重试 ---- */

await t('发送失败标记 failed；retry 复用同一个 clientMessageId 并对账', async () => {
  const clock = createClock();
  const client = createFakeClient({
    summary: { preview: null, unread: 0 },
    page: { entries: [], hasMore: false, typing: false },
  });
  const { store } = createStore(client, clock);
  await store.open();

  client.onSend = async () => {
    throw new Error('网络连接异常');
  };

  const first = await store.send('在吗');
  assert.equal(first.ok, false);
  const clientMessageId = first.clientMessageId;
  let snap = store.getState();
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].failed, true);
  assert.equal(snap.entries[0].pending, false);
  assert.match(snap.entries[0].error, /网络连接异常/);
  assert.equal(snap.sending.get(clientMessageId).status, 'failed');
  assert.match(snap.sending.get(clientMessageId).error.message, /网络连接异常/);

  client.onSend = async (message) => ({
    entryId: 'srv-2',
    entries: [
      serverEntry({
        id: 'srv-2',
        sourceEntryId: 'src-2',
        actor: 'user',
        occurredAt: '2026-11-04T05:00:00.000Z',
        item: { kind: 'text', text: '在吗' },
        clientMessageId: message.clientMessageId,
      }),
    ],
    reset: false,
  });

  const second = await store.retry(clientMessageId);
  assert.equal(second.ok, true);
  assert.equal(client.sendCalls.length, 2);
  assert.equal(client.sendCalls[1].clientMessageId, clientMessageId, '重试必须沿用原 clientMessageId');

  snap = store.getState();
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].id, 'srv-2');
  assert.equal(snap.sending.size, 0);

  const third = await store.retry(clientMessageId);
  assert.equal(third.ok, false, '已成功的不允许再重发');
  assert.equal(client.sendCalls.length, 2);
});

await t('retry 兼容视图层传的 local:<clientMessageId> 条目 id', async () => {
  const clock = createClock();
  const client = createFakeClient({
    summary: { preview: null, unread: 0 },
    page: { entries: [], hasMore: false, typing: false },
  });
  const { store } = createStore(client, clock);
  await store.open();

  client.onSend = async () => {
    throw new Error('发送失败');
  };
  const failed = await store.send('再来一次');
  assert.equal(failed.ok, false);
  const clientMessageId = failed.clientMessageId;

  client.onSend = async (message) => ({
    entryId: 'srv-3',
    entries: [
      serverEntry({
        id: 'srv-3',
        sourceEntryId: 'src-3',
        actor: 'user',
        occurredAt: '2026-11-04T07:00:00.000Z',
        item: { kind: 'text', text: '再来一次' },
        clientMessageId: message.clientMessageId,
      }),
    ],
    reset: false,
  });

  const retried = await store.retry(`local:${clientMessageId}`);
  assert.equal(retried.ok, true);
  assert.equal(retried.clientMessageId, clientMessageId);
  assert.equal(client.sendCalls.at(-1).clientMessageId, clientMessageId);
  assert.deepEqual(store.getState().entries.map((entry) => entry.id), ['srv-3']);
});

/* ---- 5. 加载更早 ---- */

await t('loadEarlier 用最早一条的 sourceEntryId 前插，并更新 hasMore', async () => {
  const clock = createClock();
  const page = {
    entries: [
      serverEntry({ id: 'e10', sourceEntryId: 's10', occurredAt: '2026-11-04T10:00:00.000Z' }),
      serverEntry({ id: 'e11', sourceEntryId: 's11', occurredAt: '2026-11-04T11:00:00.000Z' }),
    ],
    hasMore: true,
    typing: false,
  };
  const older = {
    entries: [
      serverEntry({ id: 'e5', sourceEntryId: 's5', occurredAt: '2026-11-04T05:00:00.000Z' }),
      serverEntry({ id: 'e6', sourceEntryId: 's6', occurredAt: '2026-11-04T06:00:00.000Z' }),
    ],
    hasMore: false,
    typing: false,
  };

  const client = createFakeClient({ summary: { preview: null, unread: 0 }, page });
  client.page = (c, options) => (options && options.before === 's10' ? older : page);

  const { store } = createStore(client, clock);
  await store.open();

  const loaded = await store.loadEarlier();
  assert.equal(loaded, true);
  assert.deepEqual(client.pageCalls[1], { before: 's10' });

  const snap = store.getState();
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['e5', 'e6', 'e10', 'e11'], '更早的必须前插');
  assert.equal(snap.hasMore, false);
  assert.equal(snap.loadingEarlier, false);
  assert.equal(snap.error, null);

  const again = await store.loadEarlier();
  assert.equal(again, false, 'hasMore=false 后不应再请求');
  assert.equal(client.pageCalls.length, 2);
});

/* ---- 6. 已读 ---- */

await t('markReadThrough 去重：同一条只上报一次，local 条目忽略，失败可再试', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  assert.equal(await store.markReadThrough('e2'), true);
  assert.deepEqual(client.readCalls, ['e2']);
  assert.equal(store.getState().unread, 0, '读到最新 agent 条目后本地未读清零');

  assert.equal(await store.markReadThrough('e2'), false, '重复上报要被去重');
  assert.deepEqual(client.readCalls, ['e2']);

  assert.equal(await store.markReadThrough('local:cm-1'), false);
  assert.equal(await store.markReadThrough(null), false);
  assert.equal(await store.markReadThrough(''), false);
  assert.deepEqual(client.readCalls, ['e2']);

  client.onMarkRead = () => {
    throw new Error('网络异常');
  };
  assert.equal(await store.markReadThrough('e1'), false);
  assert.deepEqual(client.readCalls, ['e2', 'e1']);

  client.onMarkRead = async () => ({ ok: true });
  assert.equal(await store.markReadThrough('e1'), true, '失败没有记账，下次应该重试');
  assert.deepEqual(client.readCalls, ['e2', 'e1', 'e1']);
});

/* ---- 7. 换 agent ---- */

await t('setAgentId 清空旧状态并重载新对象，发送队列一并清空', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  client.onSend = async () => {
    throw new Error('发送失败');
  };
  const failed = await store.send('发不出去');
  assert.equal(failed.ok, false);
  assert.equal(store.getState().sending.size, 1);

  client.page = (c) =>
    c.agentId === 'agent-2'
      ? {
          entries: [serverEntry({ id: 'n1', sourceEntryId: 'ns1', occurredAt: '2026-11-05T01:00:00.000Z' })],
          hasMore: false,
          typing: false,
        }
      : page1;
  client.summary = (c) => (c.agentId === 'agent-2' ? { preview: null, unread: 1 } : summary1);

  const switched = await store.setAgentId('agent-2');
  assert.equal(switched, true);
  assert.deepEqual(client.agentChanges, ['agent-2']);
  assert.equal(client.agentId, 'agent-2');

  const snap = store.getState();
  assert.equal(snap.agentId, 'agent-2');
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['n1'], '旧 agent 的条目必须清空');
  assert.equal(snap.sending.size, 0, '失败队列必须清空');
  assert.equal(snap.unread, 1);
  assert.equal(snap.error, null);
  assert.equal(snap.hasMore, false);
  assert.equal(clock.size(), 1, '换 agent 后轮询继续（且只有一个定时器）');

  await assert.rejects(() => store.setAgentId(''), /agentId/);
});

/* ---- 8. 轮询失败 ---- */

await t('轮询连续失败 3 次才置 error，恢复后清零；单次失败不上报', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  client.page = new Error('网络断了');
  client.summary = new Error('网络断了');

  await clock.tick();
  assert.equal(store.getState().error, null, '第 1 次失败不报');
  await clock.tick();
  assert.equal(store.getState().error, null, '第 2 次失败不报');
  await clock.tick();
  assert.ok(store.getState().error, '第 3 次失败必须上报');
  assert.match(store.getState().error.message, /网络断了/);

  client.page = page1;
  client.summary = { preview: null, unread: 0 };
  await clock.tick();
  assert.equal(store.getState().error, null, '恢复后清掉 error');

  client.page = new Error('又断了');
  await clock.tick();
  assert.equal(store.getState().error, null, '恢复后计数归零，单次失败不再上报');
  assert.equal(clock.size(), 1);
});

await t('首屏失败：open 返回 false、立刻上报 error，但仍安排轮询重试', async () => {
  const clock = createClock();
  const client = createFakeClient({ page: new Error('首屏失败') });
  const { store } = createStore(client, clock);

  const ok = await store.open();
  assert.equal(ok, false);
  assert.match(store.getState().error.message, /首屏失败/);
  assert.equal(store.getState().loading, false);
  assert.equal(clock.size(), 1);
});

/* ---- 9. reset ---- */

await t('发送 /reset 收到 reset:true 后清空旧条目，只保留回执里的新条目', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  client.onSend = async (message) => ({
    entryId: 'r-1',
    entries: [
      serverEntry({
        id: 'r-1',
        sourceEntryId: 'sr-1',
        actor: 'user',
        occurredAt: '2026-11-04T06:00:00.000Z',
        item: { kind: 'reset' },
        clientMessageId: message.clientMessageId,
      }),
    ],
    reset: true,
  });

  const result = await store.send('/reset');
  assert.equal(result.ok, true);
  assert.deepEqual(client.sendCalls[0].text, '/reset');

  const snap = store.getState();
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['r-1'], '旧闲聊条目必须被清空');
  assert.equal(snap.entries[0].item.kind, 'reset');
  assert.equal(snap.unread, 0);
  assert.equal(snap.hasMore, false);
  assert.equal(snap.sending.size, 0);
});

/* ---- 10. refresh ---- */

await t('refresh() 重拉第一页与 summary，失败立刻上报、恢复后清掉', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  client.summary = new Error('刷新失败');
  assert.equal(await store.refresh(), false);
  assert.match(store.getState().error.message, /刷新失败/);
  assert.equal(store.getState().loading, false);

  client.summary = { preview: null, unread: 3 };
  client.page = {
    entries: [serverEntry({ id: 'e9', sourceEntryId: 's9', occurredAt: '2026-11-04T09:00:00.000Z' })],
    hasMore: true,
    typing: false,
  };
  assert.equal(await store.refresh(), true);

  const snap = store.getState();
  assert.equal(snap.error, null);
  assert.equal(snap.unread, 3);
  assert.equal(snap.preview, null);
  assert.deepEqual(
    snap.entries.map((entry) => entry.id),
    ['e1', 'e2', 'e9'],
    'refresh 只合并第一页，已加载的旧条目不能丢',
  );
  assert.equal(clock.size(), 1, 'refresh 不能打乱轮询定时器');
});

/* ---- 11. open / close ---- */

await t('open 幂等、close 停轮询且幂等', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);

  assert.equal(await store.open(), true);
  assert.equal(await store.open(), true);
  assert.equal(client.summaryCalls, 1, '重复 open 不应重复首屏请求');
  assert.equal(clock.size(), 1);

  const pageCallsBefore = client.pageCalls.length;
  store.close();
  assert.equal(clock.size(), 0, 'close 必须清掉轮询定时器');
  await clock.tick();
  assert.equal(client.pageCalls.length, pageCallsBefore, '关闭后不能再发请求');
  store.close();
});

/* ---- 12. 构造校验 ---- */

await t('构造参数校验：缺 client / 缺方法都会报错', async () => {
  assert.throws(() => createCasualStore({}), /client/);
  assert.throws(
    () =>
      createCasualStore({
        client: { getAgentId: () => 'a' },
      }),
    /缺少/,
  );
  assert.throws(() => createCasualStore({ client: createFakeClient(), now: 1 }), /now/);
});

/* ---- 13. WS 事件 ---- */

await t('casual_entry：直接合并进列表，不用等轮询', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  const ok = store.applyEvent({
    type: 'casual_entry',
    agentId: 'agent-1',
    entry: serverEntry({ id: 'e1', sourceEntryId: 'src-e1' }),
  });

  assert.equal(ok, true);
  const state = store.getState();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].sourceEntryId, 'src-e1');
  store.close();
});

await t('casual_entry：重复推同一条不会变成两条', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  const entry = serverEntry({ id: 'e1', sourceEntryId: 'src-e1', item: { kind: 'text', text: '先' } });
  store.applyEvent({ type: 'casual_entry', agentId: 'agent-1', entry });
  store.applyEvent({
    type: 'casual_entry',
    agentId: 'agent-1',
    entry: { ...entry, item: { kind: 'text', text: '改过' } },
  });

  const state = store.getState();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].item.text, '改过', '同 sourceEntryId 要用新对象覆盖');
  store.close();
});

await t('不是本 agent 的事件一律丢掉', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  const ok = store.applyEvent({
    type: 'casual_entry',
    agentId: 'agent-2',
    entry: serverEntry({ id: 'x', sourceEntryId: 'src-x' }),
  });

  assert.equal(ok, false);
  assert.equal(store.getState().entries.length, 0);
  store.close();
});

await t('casual_typing：start / end 切换 typing，未知状态忽略', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  assert.equal(store.applyEvent({ type: 'casual_typing', agentId: 'agent-1', state: 'start' }), true);
  assert.equal(store.getState().typing, true);
  assert.equal(store.applyEvent({ type: 'casual_typing', agentId: 'agent-1', state: 'end' }), true);
  assert.equal(store.getState().typing, false);
  // 重复的 end 不该再触发一次渲染
  assert.equal(store.applyEvent({ type: 'casual_typing', agentId: 'agent-1', state: 'end' }), false);
  assert.equal(store.applyEvent({ type: 'casual_typing', agentId: 'agent-1', state: '??' }), false);
  store.close();
});

await t('casual_unread：接受摘要推送，未读数变了才算变化', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  assert.equal(
    store.applyEvent({ type: 'casual_unread', agentId: 'agent-1', unread: 3, preview: { text: '在' } }),
    true,
  );
  assert.equal(store.getState().unread, 3);
  assert.equal(store.applyEvent({ type: 'casual_unread', agentId: 'agent-1', unread: 3, preview: { text: '在' } }), false);
  store.close();
});

await t('casual_error：抬成界面错误，带 code', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  store.applyEvent({ type: 'casual_error', agentId: 'agent-1', code: 'casual_model_unavailable' });
  const err = store.getState().error;
  assert.ok(err, '要抬出错误');
  assert.equal(err.code, 'casual_model_unavailable');
  assert.match(String(err.message), /不可用/);
  store.close();
});

await t('超大条目只推壳时，转去拉一次整页', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();
  const callsBefore = client.pageCalls.length;

  const ok = store.applyEvent({
    type: 'casual_entry',
    agentId: 'agent-1',
    entry: { id: 'big', sourceEntryId: 'src-big', deferred: true },
  });
  await clock.tick();

  assert.equal(ok, true);
  assert.ok(client.pageCalls.length > callsBefore, 'deferred 条目应该触发一次重拉');
  store.close();
});

await t('格式不对的事件安静返回，不抛', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  for (const bad of [null, undefined, 1, 'casual_entry', {}, { type: 'casual_entry' }, { type: 'other' }]) {
    assert.equal(store.applyEvent(bad), false);
  }
  store.close();
});

await t('casual_style 不动状态：它属于外观，不归状态机', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();
  assert.equal(store.applyEvent({ type: 'casual_style', agentId: 'agent-1' }), false);
  store.close();
});

/* ---- 14. 轮询间隔可调 ---- */

await t('setPollMs：WS 连上后放宽轮询，断线后收回', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  await store.open();

  assert.equal(clock.list()[0].ms, 4000, '默认 4 秒');
  assert.equal(store.setPollMs(30000), true);
  assert.equal(clock.list()[0].ms, 30000, '改完要重排定时器');
  assert.equal(store.setPollMs(30000), false, '同一个值不重复重排');

  await clock.tick();
  assert.equal(clock.list()[0].ms, 30000, '下一轮沿新间隔');
  store.close();
});

await t('setPollMs：非法值拒绝', async () => {
  const clock = createClock();
  const client = createFakeClient();
  const { store } = createStore(client, clock);
  assert.throws(() => store.setPollMs(0), /不小于 1000/);
  assert.throws(() => store.setPollMs('x'), /不小于 1000/);
});

/* ---- 15. 退出登录 / 同 Agent 重登：上下文代次 ---- */

await t('reset 作废旧 refresh 成功结果，并释放单飞便于同 Agent 重登重拉', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const oldSummary = deferred();
  const oldPage = deferred();
  client.summary = () => oldSummary.promise;
  client.page = () => oldPage.promise;
  const oldRefresh = store.refresh();
  assert.equal(store.getState().loading, true);

  store.reset();
  assert.equal(store.getState().loading, false);
  assert.equal(clock.size(), 0, 'reset 必须停掉旧轮询');

  const newSummary = deferred();
  const newPage = deferred();
  client.summary = () => newSummary.promise;
  client.page = () => newPage.promise;
  const fresh = store.refresh();
  assert.equal(store.getState().loading, true, 'reset 后新 refresh 必须能立即启动');

  oldSummary.resolve({ unread: 9, preview: { text: '旧摘要' } });
  oldPage.resolve({
    entries: [serverEntry({ id: 'old-1', sourceEntryId: 'old-s1', occurredAt: '2026-11-04T03:00:00.000Z' })],
    hasMore: true,
    typing: false,
  });
  assert.equal(await oldRefresh, false);

  let snap = store.getState();
  assert.equal(snap.entries.length, 0, '旧 refresh 成功不得回填新上下文');
  assert.equal(snap.loading, true, '旧 refresh 不得清掉新 refresh 的 loading');
  assert.equal(snap.error, null);

  newSummary.resolve({ unread: 1, preview: null });
  newPage.resolve({
    entries: [serverEntry({ id: 'new-1', sourceEntryId: 'new-s1', occurredAt: '2026-11-04T04:00:00.000Z' })],
    hasMore: false,
    typing: false,
  });
  assert.equal(await fresh, true);
  snap = store.getState();
  assert.deepEqual(snap.entries.map((entry) => entry.id), ['new-1']);
  assert.equal(snap.loading, false);
});

await t('reset 作废旧 send 成功结果，不让旧结果回填或清掉新发送标记', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const oldGate = deferred();
  client.onSend = () => oldGate.promise;
  const oldSend = store.send('旧消息');
  const oldId = client.sendCalls[0].clientMessageId;

  store.reset();

  const newGate = deferred();
  client.onSend = () => newGate.promise;
  const newSend = store.send('新消息');
  const newId = client.sendCalls[1].clientMessageId;
  assert.equal(store.getState().sending.get(newId).status, 'sending');

  oldGate.resolve({
    entryId: 'old-1',
    entries: [serverEntry({ id: 'old-1', sourceEntryId: 'old-s1', item: { kind: 'text', text: '旧消息' } })],
    reset: false,
  });
  const oldResult = await oldSend;
  assert.equal(oldResult.stale, true, 'reset 后旧发送必须标记 stale');

  let snap = store.getState();
  assert.ok(!snap.entries.some((entry) => entry.id === 'old-1'), '旧发送成功不得回填');
  assert.equal(snap.sending.get(newId)?.status, 'sending', '旧发送不得清掉新发送标记');

  newGate.resolve({
    entryId: 'new-1',
    entries: [serverEntry({ id: 'new-1', sourceEntryId: 'new-s1', item: { kind: 'text', text: '新消息' } })],
    reset: false,
  });
  await newSend;
  snap = store.getState();
  assert.ok(snap.entries.some((entry) => entry.id === 'new-1'));
  assert.equal(snap.sending.size, 0);
});

await t('reset 作废旧 send 失败结果，不让旧 catch 污染新发送', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const oldGate = deferred();
  client.onSend = () => oldGate.promise;
  const oldSend = store.send('旧失败消息');

  store.reset();

  const newGate = deferred();
  client.onSend = () => newGate.promise;
  const newSend = store.send('新消息');
  const newId = client.sendCalls[1].clientMessageId;

  oldGate.reject(new Error('旧上下文发送失败'));
  const oldResult = await oldSend;
  assert.equal(oldResult.stale, true, 'reset 后旧发送失败必须标记 stale');

  let snap = store.getState();
  assert.equal(snap.error, null, '旧发送失败不得写成新上下文 error');
  assert.equal(snap.sending.get(newId)?.status, 'sending', '旧 catch 不得碰新发送标记');
  assert.ok(!snap.entries.some((entry) => entry.failed), '旧失败不得回填新上下文');

  newGate.resolve({ entryId: 'new-2', entries: [], reset: false });
  await newSend;
  snap = store.getState();
  assert.equal(snap.sending.size, 0);
});

await t('reset 作废旧 loadEarlier，旧 finally 不得清掉新加载标记', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const oldGate = deferred();
  client.page = () => oldGate.promise;
  const oldLoad = store.loadEarlier();
  assert.equal(store.getState().loadingEarlier, true);

  store.reset();

  client.page = {
    entries: [serverEntry({ id: 'new-1', sourceEntryId: 'new-s1', occurredAt: '2026-11-04T04:00:00.000Z' })],
    hasMore: true,
    typing: false,
  };
  await store.refresh();

  const newGate = deferred();
  client.page = () => newGate.promise;
  const newLoad = store.loadEarlier();
  assert.equal(store.getState().loadingEarlier, true, '新 loadEarlier 必须能启动');

  oldGate.resolve({
    entries: [serverEntry({ id: 'old-earlier', sourceEntryId: 'old-s0', occurredAt: '2026-10-01T00:00:00.000Z' })],
    hasMore: false,
    typing: false,
  });
  assert.equal(await oldLoad, false);

  let snap = store.getState();
  assert.ok(!snap.entries.some((entry) => entry.id === 'old-earlier'), '旧分页结果不得回填');
  assert.equal(snap.loadingEarlier, true, '旧 finally 不得清掉新 loadEarlier 标记');

  newGate.resolve({
    entries: [serverEntry({ id: 'new-earlier', sourceEntryId: 'new-s0', occurredAt: '2026-10-02T00:00:00.000Z' })],
    hasMore: false,
    typing: false,
  });
  assert.equal(await newLoad, true);
  snap = store.getState();
  assert.equal(snap.loadingEarlier, false);
  assert.ok(snap.entries.some((entry) => entry.id === 'new-earlier'));
});

await t('reset 作废旧 markRead 成功，不让旧已读记账吞掉新登录的已读', async () => {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const oldGate = deferred();
  client.onMarkRead = () => oldGate.promise;
  const oldRead = store.markReadThrough('e2');
  assert.equal(client.readCalls.filter((id) => id === 'e2').length, 1);

  store.reset();
  client.onMarkRead = async () => ({ ok: true });
  const newRead = store.markReadThrough('e2');
  assert.equal(
    client.readCalls.filter((id) => id === 'e2').length,
    2,
    'reset 后同一条已读必须能重新上报',
  );

  oldGate.resolve({ ok: true });
  assert.equal(await oldRead, false, '旧已读成功不得在新上下文记账');
  assert.equal(await newRead, true);
  assert.equal(client.readCalls.filter((id) => id === 'e2').length, 2, '旧 finally 不得吞掉新的上报');
});

async function queuedReadAfterReset({ aFails }) {
  const clock = createClock();
  const client = createFakeClient({ summary: summary1, page: page1 });
  const { store } = createStore(client, clock);
  await store.open();

  const aGate = deferred();
  client.onMarkRead = () => aGate.promise;
  const aRead = store.markReadThrough('e2');
  assert.deepEqual(client.readCalls, ['e2'], 'A 必须已经发出请求并挂起');

  // B 进入 readInFlight.promise 等待；请求计数仍应只有 A。
  const bRead = store.markReadThrough('e1');
  await tick();
  assert.deepEqual(client.readCalls, ['e2'], 'B 必须在等待 A，不得发出请求');

  // 同 Agent 重登：reset 推进 contextEpoch，但 agentId 不变。
  store.reset();
  assert.equal(store.getState().agentId, 'agent-1', 'reset 后仍是同一 Agent 的新上下文');
  store.applyEvent({
    type: 'casual_entry',
    agentId: 'agent-1',
    entry: serverEntry({
      id: 'e1',
      sourceEntryId: 's-new',
      occurredAt: '2026-11-05T00:00:00.000Z',
      item: { kind: 'text', text: '新上下文条目' },
    }),
  });
  assert.ok(store.getState().entries.some((entry) => entry.id === 'e1'), '新上下文应有一条 e1');
  store.applyEvent({ type: 'casual_unread', agentId: 'agent-1', unread: 5, preview: null });
  assert.equal(store.getState().unread, 5, '新上下文先设置一个可观察的 unread');
  client.onMarkRead = async () => ({ ok: true });

  if (aFails) aGate.reject(new Error('A 旧请求失败'));
  else aGate.resolve({ ok: true });
  const [aResult, bResult] = await Promise.all([aRead, bRead]);
  assert.equal(aResult, false, 'A 的旧结果不得在新上下文记账');
  assert.equal(bResult, false, 'B 的旧快照在等待结束后必须直接返回 false');
  assert.deepEqual(client.readCalls, ['e2'], 'B 不得对新身份发出 markRead');
  assert.equal(store.getState().unread, 5, 'B 不得改掉新上下文的 unread');

  // 若 B 错误地把 e1 记进新 reportedRead，这里会被去重而发不出去。
  assert.equal(await store.markReadThrough('e1'), true, '新上下文仍应能正常发新的 markRead');
  assert.deepEqual(client.readCalls, ['e2', 'e1'], 'B 不得污染新上下文的 reportedRead');
}

await t('reset 后等待 A 的 B（A 成功）不得用新身份发请求或污染新状态', async () => {
  await queuedReadAfterReset({ aFails: false });
});

await t('reset 后等待 A 的 B（A 失败）不得用新身份发请求或污染新状态', async () => {
  await queuedReadAfterReset({ aFails: true });
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
