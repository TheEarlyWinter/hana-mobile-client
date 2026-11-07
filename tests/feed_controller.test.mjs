/* web/feed/controller.js 契约测试
 *
 * 只替换 client 与身份/时钟：不启动服务、不碰 DOM、不读真实 feed 数据。
 * 覆盖：首屏/分页去重、乱序条目、lane 切换、收藏无广播更新、隐藏、任务 action.id
 * 与 edit 不提交、task 冲突刷新、阅读信号计数、feed-changed 合并刷新（可 await 到
 * 实际完成）、reset/换身份丢弃迟到结果、错误与空列表。
 */

import assert from 'node:assert/strict';
import { createFeedController } from '../web/feed/controller.js';

const ID_A = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'fi_ZYXWVTSRQPNMKJHGFEDCBA9876';
const ID_C = 'fi_0123456789ABCDEFGHJKMNPQRT';
const IDENTITY = { ownerId: 'owner-1', deviceId: 'dev-1', clientKind: 'mobile' };
const ISO = '2026-11-05T09:00:00.000Z';

let bad = 0;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeItem(itemId, extra = {}) {
  return {
    itemId,
    revision: 1,
    lane: 'task',
    laneKind: 'task',
    template: 'folio-card',
    title: `标题-${itemId.slice(-1)}`,
    ask: '',
    topics: [],
    source: { sourceId: 'src-1', displayName: '日报助手' },
    createdAt: ISO,
    unread: true,
    favorite: false,
    ...extra,
  };
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** 受控计时器：只有 flush() 才让 controller 排的合并窗口计时器执行。 */
function createClock() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn) {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    flush() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    size() {
      return timers.size;
    },
  };
}

function makeClient() {
  const calls = { slate: [], favorite: [], hide: [], task: [], signals: [] };
  const handlers = {
    slate: async () => ({ slateId: 'slate-1', items: [], unreadTaskCount: 0, cursor: null, nextPatrolAt: null }),
    favorite: async () => ({ favorite: true }),
    hide: async () => ({ hiddenAt: ISO }),
    task: async () => ({ task: { state: 'done', actions: [] } }),
    signals: async (list) => ({ accepted: list.length, unreadTaskCount: 0 }),
  };
  const client = {
    async slate(args = {}) {
      calls.slate.push(args);
      return handlers.slate(args);
    },
    async favorite(itemId, value) {
      calls.favorite.push({ itemId, value });
      return handlers.favorite(itemId, value);
    },
    async hide(itemId) {
      calls.hide.push({ itemId });
      return handlers.hide(itemId);
    },
    async task(itemId, actionId) {
      calls.task.push({ itemId, actionId });
      return handlers.task(itemId, actionId);
    },
    async signals(list) {
      calls.signals.push(list);
      return handlers.signals(list);
    },
  };
  return { client, calls, handlers };
}

function setup({ clock = null, getIdentity = () => IDENTITY } = {}) {
  const { client, calls, handlers } = makeClient();
  const states = [];
  const errors = [];
  const options = {
    client,
    getIdentity,
    onChange: (snapshot) => states.push(snapshot),
    onError: (err) => errors.push(err),
  };
  if (clock) {
    options.mergeDelayMs = 20;
    options.setTimeout = clock.setTimeout;
    options.clearTimeout = clock.clearTimeout;
  }
  const controller = createFeedController(options);
  return { controller, calls, handlers, states, errors };
}

/* ---- 首屏 ---- */

t('open：首屏一页，状态字段齐全，onChange 派发新快照', async () => {
  const c = setup();
  c.handlers.slate = async () => ({
    slateId: 'slate-1',
    items: [makeItem(ID_A), makeItem(ID_B)],
    unreadTaskCount: 5,
    cursor: 'CUR-2',
    nextPatrolAt: ISO,
  });

  assert.deepEqual(c.controller.getState(), {
    open: false,
    loading: false,
    loadingMore: false,
    error: null,
    items: [],
    cursor: null,
    slateId: null,
    unreadTaskCount: 0,
    nextPatrolAt: null,
    lane: 'all',
    pendingIds: [],
  });

  const pending = c.controller.open();
  assert.equal(c.controller.getState().open, true, 'open 先置打开，用户可以立刻看到面板');
  assert.equal(c.controller.getState().loading, true, '加载中要能被界面看到');
  await pending;

  const state = c.controller.getState();
  assert.equal(state.open, true);
  assert.equal(state.loading, false);
  assert.equal(state.items.length, 2);
  assert.equal(state.unreadTaskCount, 5);
  assert.equal(state.cursor, 'CUR-2');
  assert.equal(state.slateId, 'slate-1');
  assert.equal(state.nextPatrolAt, ISO);
  assert.equal(c.calls.slate.length, 1, '首屏只取一页');
  assert.ok(c.calls.slate[0].cursor === null || c.calls.slate[0].cursor === undefined);
  assert.deepEqual(c.calls.slate[0].lanes, []);
  assert.ok(c.states.length >= 2);
  assert.notEqual(c.states[0], c.states[1], '每次派发新的快照对象');
});

t('open：重复调用复用同一在途首屏请求', async () => {
  const c = setup();
  let resolveSlate;
  c.handlers.slate = () => new Promise((resolve) => { resolveSlate = resolve; });

  const first = c.controller.open();
  const second = c.controller.open();
  assert.equal(c.calls.slate.length, 1);
  resolveSlate({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 1, cursor: null, nextPatrolAt: null });
  await Promise.all([first, second]);
  assert.equal(c.calls.slate.length, 1);
  assert.equal(c.controller.getState().items.length, 1);
});

t('空列表与 401 是不同状态，错误码和消息保留', async () => {
  const c = setup();
  await c.controller.open();
  let state = c.controller.getState();
  assert.equal(state.error, null);
  assert.deepEqual(state.items, []);
  assert.equal(state.loading, false);

  const failed = setup();
  failed.handlers.slate = async () => {
    throw httpError(401, 'feed_unauthorized', '登录已失效，请重新登录');
  };
  await failed.controller.open();
  state = failed.controller.getState();
  assert.equal(state.items.length, 0);
  assert.equal(state.loading, false);
  assert.equal(state.error.code, 'feed_unauthorized');
  assert.equal(state.error.message, '登录已失效，请重新登录');
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.errors[0].status, 401);
});

/* ---- 分页与列表顺序 ---- */

t('乱序列表与同页重复条目：按服务器顺序保留首条', async () => {
  const c = setup();
  c.handlers.slate = async () => ({
    slateId: 's',
    items: [makeItem(ID_B), makeItem(ID_A), makeItem(ID_B, { revision: 2, title: '重复旧版' })],
    unreadTaskCount: 0,
    cursor: null,
  });
  await c.controller.open();
  const state = c.controller.getState();
  assert.deepEqual(state.items.map((item) => item.itemId), [ID_B, ID_A]);
  assert.equal(state.items[0].revision, 1, '同页重复条目只保留第一条');
});

t('loadMore：带 cursor 追加并按 itemId 去重，末页后不再请求', async () => {
  const c = setup();
  c.handlers.slate = async (args) => {
    if (!args.cursor) {
      return { slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 4, cursor: 'CUR-1', nextPatrolAt: null };
    }
    return {
      slateId: 's',
      items: [makeItem(ID_A, { revision: 2 }), makeItem(ID_C)],
      unreadTaskCount: 2,
      cursor: null,
      nextPatrolAt: null,
    };
  };
  await c.controller.open();
  await c.controller.loadMore();
  let state = c.controller.getState();
  assert.equal(c.calls.slate.length, 2);
  assert.equal(c.calls.slate[1].cursor, 'CUR-1');
  assert.deepEqual(state.items.map((item) => item.itemId), [ID_A, ID_C]);
  assert.equal(state.items[0].revision, 1, '已展示的条目不被分页结果替换版本');
  assert.equal(state.cursor, null);
  assert.equal(state.unreadTaskCount, 2);

  await c.controller.loadMore();
  assert.equal(c.calls.slate.length, 2, '末页之后不再请求');
  state = c.controller.getState();
  assert.equal(state.loadingMore, false);
});

t('setLane：切换筛选清空旧页并带 lanes 重新取首屏', async () => {
  const c = setup();
  c.handlers.slate = async (args) => {
    const task = Array.isArray(args.lanes) && args.lanes.includes('task');
    return {
      slateId: task ? 'slate-task' : 'slate-all',
      items: task ? [makeItem(ID_B)] : [makeItem(ID_A)],
      unreadTaskCount: task ? 1 : 0,
      cursor: null,
    };
  };
  await c.controller.open();
  assert.equal(c.controller.getState().items[0].itemId, ID_A);

  await c.controller.setLane('task');
  let state = c.controller.getState();
  assert.equal(state.lane, 'task');
  assert.deepEqual(c.calls.slate[1].lanes, ['task']);
  assert.deepEqual(state.items.map((item) => item.itemId), [ID_B]);

  await c.controller.setLane('all');
  state = c.controller.getState();
  assert.equal(state.lane, 'all');
  assert.deepEqual(c.calls.slate[2].lanes, []);
  assert.deepEqual(state.items.map((item) => item.itemId), [ID_A]);
});

/* ---- 条目操作 ---- */

t('setFavorite：同一请求单飞，成功后本地更新且不依赖广播', async () => {
  const c = setup();
  c.handlers.slate = async () => ({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 0, cursor: null });
  await c.controller.open();

  let resolveFavorite;
  c.handlers.favorite = () => new Promise((resolve) => { resolveFavorite = resolve; });
  const first = c.controller.setFavorite(ID_A, true);
  const second = c.controller.setFavorite(ID_A, true);
  assert.equal(c.calls.favorite.length, 1, '请求完成前重复操作不再提交');
  assert.deepEqual(c.calls.favorite[0], { itemId: ID_A, value: true });
  assert.deepEqual(c.controller.getState().pendingIds, [ID_A]);

  resolveFavorite({ favorite: true });
  await Promise.all([first, second]);

  const state = c.controller.getState();
  assert.equal(state.items[0].favorite, true);
  assert.deepEqual(state.pendingIds, []);
  assert.equal(c.calls.slate.length, 1, '收藏成功不需要重新拉列表');
});

t('setFavorite 失败：保留原状态、清空 pending、错误可读', async () => {
  const c = setup();
  c.handlers.slate = async () => ({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 0, cursor: null });
  await c.controller.open();
  c.handlers.favorite = async () => {
    throw httpError(503, 'feed_unavailable', '日报服务暂时不可用');
  };
  await c.controller.setFavorite(ID_A, true);

  const state = c.controller.getState();
  assert.equal(state.items[0].favorite, false);
  assert.deepEqual(state.pendingIds, []);
  assert.equal(state.error.code, 'feed_unavailable');
  assert.equal(c.errors.length, 1);
});

t('hide：成功后从当前列表移除', async () => {
  const c = setup();
  c.handlers.slate = async () => ({
    slateId: 's',
    items: [makeItem(ID_A), makeItem(ID_B)],
    unreadTaskCount: 0,
    cursor: null,
  });
  await c.controller.open();
  await c.controller.hide(ID_A);
  assert.deepEqual(c.calls.hide, [{ itemId: ID_A }]);
  assert.deepEqual(c.controller.getState().items.map((item) => item.itemId), [ID_B]);
});

t('resolveTask：发送宿主 action.id，成功后本地更新任务', async () => {
  const c = setup();
  const item = makeItem(ID_A, {
    task: {
      state: 'pending',
      actions: [
        { id: 'act-done', kind: 'confirm', label: '已完成' },
        { id: 'act-dismiss', kind: 'dismiss', label: '忽略' },
      ],
    },
  });
  c.handlers.slate = async () => ({ slateId: 's', items: [item], unreadTaskCount: 1, cursor: null });
  await c.controller.open();

  await c.controller.resolveTask(ID_A, 'act-done');
  assert.deepEqual(c.calls.task, [{ itemId: ID_A, actionId: 'act-done' }]);
  assert.equal(c.controller.getState().items[0].task.state, 'done');
});

t('resolveTask：edit/未知动作不提交状态接口，只报不可用', async () => {
  const c = setup();
  const item = makeItem(ID_A, {
    task: {
      state: 'pending',
      actions: [
        { id: 'act-edit', kind: 'edit', label: '改写' },
        { id: 'act-snooze', kind: 'snooze', label: '明天再说' },
      ],
    },
  });
  c.handlers.slate = async () => ({ slateId: 's', items: [item], unreadTaskCount: 1, cursor: null });
  await c.controller.open();

  await c.controller.resolveTask(ID_A, 'act-edit');
  await c.controller.resolveTask(ID_A, 'act-snooze');
  await c.controller.resolveTask(ID_A, 'act-missing');
  assert.equal(c.calls.task.length, 0);
  assert.equal(c.controller.getState().error.code, 'feed_task_unsupported');
  assert.equal(c.controller.getState().items[0].task.state, 'pending');
});

t('resolveTask 冲突：保留原状态、刷新对账、不自动重试任务', async () => {
  const c = setup();
  const pendingItem = makeItem(ID_A, {
    task: { state: 'pending', actions: [{ id: 'act-done', kind: 'confirm', label: '已完成' }] },
  });
  let resolveRefresh;
  c.handlers.slate = async () => {
    if (c.calls.slate.length === 1) {
      return { slateId: 's', items: [pendingItem], unreadTaskCount: 1, cursor: null };
    }
    return new Promise((resolve) => { resolveRefresh = resolve; });
  };
  await c.controller.open();
  c.handlers.task = async () => {
    throw httpError(422, 'feed_task_not_pending', '这个待办已经处理过了');
  };

  const resolving = c.controller.resolveTask(ID_A, 'act-done');
  await tick();
  assert.equal(c.calls.task.length, 1, '任务接口只调用一次');
  assert.equal(c.calls.slate.length, 2, '冲突后拉一次列表对账');
  let state = c.controller.getState();
  assert.equal(state.items[0].task.state, 'pending', '对账完成前保留原状态');
  assert.equal(state.error.code, 'feed_task_not_pending');

  resolveRefresh({
    slateId: 's',
    items: [{ ...makeItem(ID_A), task: undefined }],
    unreadTaskCount: 0,
    cursor: null,
  });
  await resolving;
  state = c.controller.getState();
  assert.equal(state.items[0].task, undefined);
  assert.equal(c.calls.task.length, 1, '不自动重试写操作');
});

/* ---- 阅读信号 ---- */

t('recordSignals：用响应 unreadTaskCount 更新角标，成对 accepted 才标记已读', async () => {
  const c = setup();
  c.handlers.slate = async () => ({
    slateId: 's',
    items: [makeItem(ID_A), makeItem(ID_B)],
    unreadTaskCount: 3,
    cursor: null,
  });
  await c.controller.open();
  c.handlers.signals = async (list) => ({ accepted: list.length, unreadTaskCount: 2 });
  const signals = [
    { eventId: 'e-1', itemId: ID_A, type: 'impression', at: ISO },
    { eventId: 'e-2', itemId: ID_A, type: 'dwell', at: ISO, value: 700 },
  ];
  const result = await c.controller.recordSignals(signals);
  assert.equal(result.unreadTaskCount, 2);
  assert.equal(c.calls.signals.length, 1);
  assert.deepEqual(c.calls.signals[0], signals);
  const state = c.controller.getState();
  assert.equal(state.unreadTaskCount, 2, '角标以响应为准');
  assert.equal(state.items.find((item) => item.itemId === ID_A).unread, false);
  assert.equal(state.items.find((item) => item.itemId === ID_B).unread, true, '不按本页数量强制清零');

  const partial = setup();
  partial.handlers.slate = async () => ({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 1, cursor: null });
  await partial.controller.open();
  partial.handlers.signals = async () => ({ accepted: 1, unreadTaskCount: 9 });
  await partial.controller.recordSignals(signals);
  const partialState = partial.controller.getState();
  assert.equal(partialState.unreadTaskCount, 9);
  assert.equal(partialState.items[0].unread, true, '未被全部接受时不伪装已读');
});

/* ---- feed-changed 合并刷新 ---- */

t('onChanged：合并多次触发，返回的 Promise 等到真实刷新完成才结算', async () => {
  const clock = createClock();
  const c = setup({ clock });
  c.handlers.slate = async () => ({ slateId: 's1', items: [makeItem(ID_A)], unreadTaskCount: 1, cursor: null });
  await c.controller.open();

  const pendingResolvers = [];
  c.handlers.slate = () => new Promise((resolve) => { pendingResolvers.push(resolve); });

  const first = c.controller.onChanged();
  const second = c.controller.onChanged();
  assert.equal(first, second, '同一合并窗口共享同一个 Promise');
  assert.equal(clock.size(), 1, '先排一个短窗口计时器');
  assert.equal(c.calls.slate.length, 1, '窗口内不立即发请求');

  clock.flush();
  await tick();
  assert.equal(c.calls.slate.length, 2, '窗口结束后只发一次刷新');

  let settled = false;
  first.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, '刷新没完成前不能宣称完成');

  // 刷新途中又收到 feed-changed：同一轮还要再补一次，最终 Promise 仍等最后一次。
  const during = c.controller.onChanged();
  assert.equal(during, first);
  pendingResolvers.shift()({ slateId: 's2', items: [makeItem(ID_B)], unreadTaskCount: 2, cursor: null });
  await tick();
  assert.equal(c.calls.slate.length, 3, '刷新途中的通知要补一轮刷新');
  assert.equal(settled, false);

  pendingResolvers.shift()({ slateId: 's3', items: [makeItem(ID_C)], unreadTaskCount: 3, cursor: null });
  await first;
  assert.equal(settled, true);
  const state = c.controller.getState();
  assert.deepEqual(state.items.map((item) => item.itemId), [ID_C]);
  assert.equal(state.unreadTaskCount, 3);
  assert.equal(clock.size(), 0);
});

/* ---- 生命周期与归属 ---- */

t('close 不冒充 logout，reset 才清数据并丢弃迟到结果', async () => {
  const c = setup();
  c.handlers.slate = async () => ({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 1, cursor: null });
  await c.controller.open();
  c.controller.close();
  let state = c.controller.getState();
  assert.equal(state.open, false);
  assert.equal(state.items.length, 1, '关闭面板不清身份数据');

  let resolveLate;
  c.handlers.slate = () => new Promise((resolve) => { resolveLate = resolve; });
  const late = c.controller.refresh();
  c.controller.reset();
  state = c.controller.getState();
  assert.equal(state.open, false);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.pendingIds, []);
  resolveLate({ slateId: 'late', items: [makeItem(ID_B)], unreadTaskCount: 9, cursor: null });
  await late;
  state = c.controller.getState();
  assert.deepEqual(state.items, [], 'reset 后旧请求结果不能回填');
  assert.equal(state.unreadTaskCount, 0);
});

t('换身份后的迟到结果不写入新身份状态', async () => {
  let identity = { ownerId: 'owner-1', deviceId: 'dev-1', clientKind: 'mobile' };
  const clock = createClock();
  const c = setup({ clock, getIdentity: () => identity });
  let resolveSlate;
  c.handlers.slate = () => new Promise((resolve) => { resolveSlate = resolve; });

  const opening = c.controller.open();
  identity = { ownerId: 'owner-2', deviceId: 'dev-2', clientKind: 'mobile' };
  resolveSlate({ slateId: 'old', items: [makeItem(ID_A)], unreadTaskCount: 1, cursor: null });
  await opening;

  const state = c.controller.getState();
  assert.deepEqual(state.items, []);
  assert.equal(state.loading, false, '旧身份的加载不能把新身份的加载态卡住');
  assert.equal(state.unreadTaskCount, 0);
});

t('操作请求期间 reset：旧结果不更新条目、pending 清空', async () => {
  const c = setup();
  c.handlers.slate = async () => ({ slateId: 's', items: [makeItem(ID_A)], unreadTaskCount: 0, cursor: null });
  await c.controller.open();

  let resolveFavorite;
  c.handlers.favorite = () => new Promise((resolve) => { resolveFavorite = resolve; });
  const op = c.controller.setFavorite(ID_A, true);
  assert.deepEqual(c.controller.getState().pendingIds, [ID_A]);
  c.controller.reset();
  resolveFavorite({ favorite: true });
  await op;

  const state = c.controller.getState();
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.pendingIds, []);
  assert.equal(state.items.find((item) => item.itemId === ID_A), undefined);
});

/* ---- 运行 ---- */

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

if (bad) {
  console.log(`\n${bad} 个用例失败（共 ${tests.length} 个）`);
  process.exitCode = 1;
} else {
  console.log(`\nALL PASS（${tests.length} 个用例）`);
}
