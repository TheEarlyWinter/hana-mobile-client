/* web/feed/client.js 契约测试
 *
 * 只替换 api：不启动服务、不碰 DOM、不读真实 HANA_HOME 或 feed 数据。
 * 覆盖：每个方法的方法/路径/请求体、条目与任务形状归一化、可选 cursor/lanes、
 * 空列表与协议错误/401/422 的区分、卡片版本漂移、非 folio 无 documentPath、
 * prepare 身份不符。外部数据只在这里校验，错误必须明确抛出，不能吞成空列表。
 */

import assert from 'node:assert/strict';
import { createFeedClient } from '../web/feed/client.js';

const ULID_A = '0123456789ABCDEFGHJKMNPQRS';
const ULID_B = 'ZYXWVTSRQPNMKJHGFEDCBA9876';
const ITEM_ID = `fi_${ULID_A}`;
const ITEM_ID_B = `fi_${ULID_B}`;

const WIRE_ITEM = {
  itemId: ITEM_ID,
  revision: 3,
  lane: 'task',
  laneKind: 'task',
  template: 'folio-card',
  title: '今日待办',
  ask: '要跟进吗？',
  topics: ['工作', '日报'],
  explain: '因为你订阅了这个项目',
  expiresAt: '2026-11-06T09:00:00.000Z',
  source: { sourceId: 'src-1', agentId: 'agent-1', displayName: '主代理' },
  createdAt: '2026-11-05T09:00:00.000Z',
  unread: true,
  favorite: false,
  task: {
    state: 'pending',
    actions: [
      { id: 'act-done', kind: 'confirm', label: '已完成', extra: 'drop-me' },
      { id: 'act-dismiss', kind: 'dismiss', label: '忽略' },
    ],
    dueAt: '2026-11-06T10:00:00.000Z',
    extra: 'drop-me',
  },
  ignoredField: 'drop-me',
};

const NORMALIZED_ITEM = {
  itemId: ITEM_ID,
  revision: 3,
  lane: 'task',
  laneKind: 'task',
  template: 'folio-card',
  title: '今日待办',
  ask: '要跟进吗？',
  topics: ['工作', '日报'],
  source: { sourceId: 'src-1', agentId: 'agent-1', displayName: '主代理' },
  createdAt: '2026-11-05T09:00:00.000Z',
  unread: true,
  favorite: false,
  explain: '因为你订阅了这个项目',
  expiresAt: '2026-11-06T09:00:00.000Z',
  task: {
    state: 'pending',
    actions: [
      { id: 'act-done', kind: 'confirm', label: '已完成' },
      { id: 'act-dismiss', kind: 'dismiss', label: '忽略' },
    ],
    dueAt: '2026-11-06T10:00:00.000Z',
  },
};

/* ---- 工具 ---- */

let bad = 0;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** 记录调用的假 api；handler 返回响应体或直接抛出。 */
function fakeApi(handler) {
  const calls = [];
  const api = async (pathname, init = {}) => {
    calls.push({ pathname, init });
    return handler({ pathname, init, index: calls.length - 1 });
  };
  api.calls = calls;
  return api;
}

/** 与 web/http-client.js 一致的失败形状：status/body 齐备。 */
function httpError(status, body) {
  const detail = body && (body.detail || body.error || body.message);
  const err = new Error(`${status} ${detail || 'error'}`);
  err.status = status;
  err.body = body;
  return err;
}

async function caught(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('期望抛出异常，但没有');
}

/* ---- slate ---- */

t('slate：默认只带 clientKind=mobile&size=12，返回归一化条目', async () => {
  const api = fakeApi(() => ({
    slateId: 'slate-1',
    items: [clone(WIRE_ITEM)],
    unreadTaskCount: 4,
    rankerId: 'ranker-x',
    cursor: 'CUR-2',
    nextPatrolAt: '2026-11-05T10:00:00.000Z',
  }));
  const client = createFeedClient({ api });

  const snapshot = await client.slate();
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].pathname, '/api/feed/slate?clientKind=mobile&size=12');
  assert.equal(api.calls[0].init.body, undefined, 'slate 是只读 GET，不能带 body');
  assert.deepEqual(snapshot, {
    slateId: 'slate-1',
    items: [NORMALIZED_ITEM],
    unreadTaskCount: 4,
    cursor: 'CUR-2',
    nextPatrolAt: '2026-11-05T10:00:00.000Z',
  });
});

t('slate：cursor 与 lanes 进入查询串；空 cursor 表示末页不带参数', async () => {
  const api = fakeApi(() => ({ slateId: 's', items: [], unreadTaskCount: 0 }));
  const client = createFeedClient({ api });

  await client.slate({ cursor: 'a/b c', lanes: ['task', 'content'] });
  assert.equal(
    api.calls[0].pathname,
    '/api/feed/slate?clientKind=mobile&size=12&cursor=a%2Fb%20c&lanes=task,content',
  );

  await client.slate({ cursor: '', lanes: [] });
  assert.equal(api.calls[1].pathname, '/api/feed/slate?clientKind=mobile&size=12');

  await client.slate({ cursor: null });
  assert.equal(api.calls[2].pathname, '/api/feed/slate?clientKind=mobile&size=12');
});

t('slate：空列表是合法结果，不冒充错误', async () => {
  const api = fakeApi(() => ({ slateId: 'slate-empty', items: [], unreadTaskCount: 0 }));
  const snapshot = await createFeedClient({ api }).slate();
  assert.deepEqual(snapshot, {
    slateId: 'slate-empty',
    items: [],
    unreadTaskCount: 0,
    cursor: null,
    nextPatrolAt: null,
  });
});

t('slate：协议形状错误明确抛出，不返回空列表', async () => {
  const bodies = [
    null,
    { items: [], unreadTaskCount: 0 },
    { slateId: 's', unreadTaskCount: 0 },
    { slateId: 's', items: {}, unreadTaskCount: 0 },
    { slateId: 's', items: [], unreadTaskCount: 'x' },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), title: undefined }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), revision: 0 }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), source: null }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), source: { sourceId: 'src' } }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), itemId: 'fi_short' }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), unread: 'yes' }], unreadTaskCount: 0 },
  ];
  for (const body of bodies) {
    const api = fakeApi(() => body);
    const err = await caught(() => createFeedClient({ api }).slate());
    assert.equal(err.code, 'feed_protocol_error', `应报协议错误：${JSON.stringify(body)}`);
    assert.ok(err.message && err.message.length > 0, '错误消息不能为空');
  }
});

t('slate：ask/topics 缺失或 null 是协议错误（不是可选字段）', async () => {
  const withoutAsk = clone(WIRE_ITEM);
  delete withoutAsk.ask;
  const withoutTopics = clone(WIRE_ITEM);
  delete withoutTopics.topics;
  const bodies = [
    { slateId: 's', items: [withoutAsk], unreadTaskCount: 0 },
    { slateId: 's', items: [withoutTopics], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), ask: null }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), topics: null }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), ask: 3 }], unreadTaskCount: 0 },
    { slateId: 's', items: [{ ...clone(WIRE_ITEM), topics: ['ok', 1] }], unreadTaskCount: 0 },
  ];
  for (const body of bodies) {
    const api = fakeApi(() => body);
    const err = await caught(() => createFeedClient({ api }).slate());
    assert.equal(err.code, 'feed_protocol_error', `ask/topics 坏形状应报协议错误：${JSON.stringify(body.items[0])}`);
  }
});

t('slate：ask 空串、topics 空数组是合法值；其他可选字段仍可缺', async () => {
  const short = clone(WIRE_ITEM);
  short.ask = '';
  short.topics = [];
  delete short.explain;
  delete short.expiresAt;
  delete short.task;
  short.source = { sourceId: 'src-1', displayName: '主代理' };
  const api = fakeApi(() => ({ slateId: 's', items: [short], unreadTaskCount: 1 }));
  const snapshot = await createFeedClient({ api }).slate();
  assert.deepEqual(snapshot.items[0], {
    itemId: ITEM_ID,
    revision: 3,
    lane: 'task',
    laneKind: 'task',
    template: 'folio-card',
    title: '今日待办',
    ask: '',
    topics: [],
    source: { sourceId: 'src-1', displayName: '主代理' },
    createdAt: '2026-11-05T09:00:00.000Z',
    unread: true,
    favorite: false,
  });
  assert.equal('task' in snapshot.items[0], false);
  assert.equal('explain' in snapshot.items[0], false);
  assert.equal('agentId' in snapshot.items[0].source, false);
});

t('slate：HTTP 401 保留宿主 code/message/status，不吞成空列表', async () => {
  const original = httpError(401, { error: 'feed_unauthorized', message: '未登录' });
  const api = fakeApi(() => {
    throw original;
  });
  const err = await caught(() => createFeedClient({ api }).slate());
  assert.equal(err, original, '不得换掉原错误对象');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'feed_unauthorized', '宿主 code 必须保留在 err.code');
  assert.deepEqual(err.body, { error: 'feed_unauthorized', message: '未登录' });
  assert.match(err.message, /401/);
});

/* ---- item ---- */

t('item：GET 带 clientKind=mobile，返回校验后的条目与 payloadSummary', async () => {
  const api = fakeApi(() => ({ ...clone(WIRE_ITEM), payloadSummary: { title: '摘要', text: '正文预览' } }));
  const item = await createFeedClient({ api }).item(ITEM_ID);
  assert.equal(api.calls[0].pathname, `/api/feed/items/${ITEM_ID}?clientKind=mobile`);
  assert.equal(api.calls[0].init.body, undefined);
  assert.deepEqual({ ...item, payloadSummary: undefined }, { ...NORMALIZED_ITEM, payloadSummary: undefined });
  assert.deepEqual(item.payloadSummary, { title: '摘要', text: '正文预览' });
});

t('item：缺 wire 字段与非法 itemId 都明确抛出', async () => {
  const api = fakeApi(() => ({ ...clone(WIRE_ITEM), createdAt: null }));
  const err = await caught(() => createFeedClient({ api }).item(ITEM_ID));
  assert.equal(err.code, 'feed_protocol_error');

  const api2 = fakeApi(() => clone(WIRE_ITEM));
  const err2 = await caught(() => createFeedClient({ api: api2 }).item('../etc'));
  assert.equal(err2.code, 'feed_invalid_argument');
  assert.equal(api2.calls.length, 0, '非法 itemId 不应发请求');
});

/* ---- card ---- */

t('card：POST 不带 body，有 documentPath 时 URL 由可信 id/revision 构造', async () => {
  const api = fakeApi(() => ({ cardId: 'card-1', revision: 3, documentPath: 'C:/somewhere/private/index.html' }));
  const card = await createFeedClient({ api }).card(ITEM_ID, 3);
  assert.equal(api.calls[0].pathname, `/api/feed/items/${ITEM_ID}/card`);
  assert.equal(api.calls[0].init.method, 'POST');
  assert.equal(api.calls[0].init.body, undefined, '铸造卡片不发送 revision/clientKind 参数');
  assert.deepEqual(card, { cardId: 'card-1', revision: 3, url: `/gw/feed/${ITEM_ID}/r3/` });
  assert.ok(!JSON.stringify(card).includes('somewhere'), '不能把宿主本机路径带给界面');
});

t('card：非 folio 模板没有 documentPath 时 url=null，不猜本地路径', async () => {
  const api = fakeApi(() => ({ cardId: 'card-2', revision: 5 }));
  const card = await createFeedClient({ api }).card(ITEM_ID, 5);
  assert.deepEqual(card, { cardId: 'card-2', revision: 5, url: null });
});

t('card：返回 revision 与请求不符 → feed_card_revision_mismatch', async () => {
  const api = fakeApi(() => ({ cardId: 'card-3', revision: 4, documentPath: 'x/index.html' }));
  const err = await caught(() => createFeedClient({ api }).card(ITEM_ID, 3));
  assert.equal(err.code, 'feed_card_revision_mismatch');
  assert.match(err.message, /版本/);
});

t('card：非法 itemId/revision 不发请求', async () => {
  const api = fakeApi(() => ({ cardId: 'c', revision: 1 }));
  const client = createFeedClient({ api });
  assert.equal((await caught(() => client.card('fi_bad', 1))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.card(ITEM_ID, 0))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.card(ITEM_ID, 1.5))).code, 'feed_invalid_argument');
  assert.equal(api.calls.length, 0);
});

/* ---- signals ---- */

t('signals：一次 1–100 条，body 带 clientKind=mobile 与校验后的信号', async () => {
  const api = fakeApi(() => ({ accepted: 2, unreadTaskCount: 1 }));
  const result = await createFeedClient({ api }).signals([
    { eventId: 'e1', itemId: ITEM_ID, type: 'impression', at: '2026-11-05T09:00:00.000Z', slateId: 'slate-1', position: 0 },
    { eventId: 'e2', itemId: ITEM_ID, type: 'dwell', at: '2026-11-05T09:00:01.000Z', slateId: 'slate-1', position: 0, value: 900 },
  ]);
  assert.equal(api.calls[0].pathname, '/api/feed/signals');
  assert.equal(api.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(api.calls[0].init.body), {
    clientKind: 'mobile',
    signals: [
      { eventId: 'e1', itemId: ITEM_ID, type: 'impression', at: '2026-11-05T09:00:00.000Z', slateId: 'slate-1', position: 0 },
      { eventId: 'e2', itemId: ITEM_ID, type: 'dwell', at: '2026-11-05T09:00:01.000Z', slateId: 'slate-1', position: 0, value: 900 },
    ],
  });
  assert.deepEqual(result, { accepted: 2, unreadTaskCount: 1 });
});

t('signals：0 条/101 条/缺字段/非法时间 → 抛错且不发请求', async () => {
  const api = fakeApi(() => ({ accepted: 0, unreadTaskCount: 0 }));
  const client = createFeedClient({ api });
  const one = { eventId: 'e1', itemId: ITEM_ID, type: 'impression', at: '2026-11-05T09:00:00.000Z' };

  assert.equal((await caught(() => client.signals([]))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.signals(new Array(101).fill(one)))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.signals([{ ...one, eventId: '' }]))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.signals([{ ...one, itemId: 'nope' }]))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.signals([{ ...one, at: 'yesterday' }]))).code, 'feed_invalid_argument');
  assert.equal((await caught(() => client.signals([{ ...one, type: '' }]))).code, 'feed_invalid_argument');
  assert.equal(api.calls.length, 0);
});

t('signals：dwell 必须带 value 且不少于 600ms', async () => {
  const api = fakeApi(() => ({ accepted: 1, unreadTaskCount: 0 }));
  const client = createFeedClient({ api });
  const dwell = { eventId: 'e1', itemId: ITEM_ID, type: 'dwell', at: '2026-11-05T09:00:00.000Z' };

  assert.equal((await caught(() => client.signals([dwell]))).code, 'feed_invalid_argument', 'dwell 缺 value 必须拒绝');
  assert.equal(
    (await caught(() => client.signals([{ ...dwell, value: 599 }]))).code,
    'feed_invalid_argument',
    'dwell 599ms 必须拒绝',
  );
  assert.equal(api.calls.length, 0, '无效阅读信号不发请求');

  assert.deepEqual(await client.signals([{ ...dwell, value: 600 }]), { accepted: 1, unreadTaskCount: 0 });
  assert.equal(JSON.parse(api.calls[0].init.body).signals[0].value, 600, '600ms 应当原样发出');
});

t('signals：at 只接受 ISO 日期时间（Z 或时区偏移），可解析的非 ISO 文本也拒绝', async () => {
  const api = fakeApi(() => ({ accepted: 1, unreadTaskCount: 0 }));
  const client = createFeedClient({ api });
  const base = { eventId: 'e1', itemId: ITEM_ID, type: 'impression', at: '2026-11-05T09:00:00.000Z' };

  const rejected = [
    '2026-11-05',
    '2026-11-05 09:00:00Z',
    '2026-11-05T09:00:00',
    'November 5, 2026 09:00:00 GMT',
    'Thu, 05 Nov 2026 09:00:00 GMT',
    '2026-11-05T09:00:00.000Z ',
  ];
  for (const at of rejected) {
    const err = await caught(() => client.signals([{ ...base, at }]));
    assert.equal(err.code, 'feed_invalid_argument', `应拒绝非 ISO 时间：${at}`);
  }
  assert.equal(api.calls.length, 0, '非 ISO 时间不发请求');

  const valid = ['2026-11-05T09:00:00.000Z', '2026-11-05T09:00:00Z', '2026-11-05T09:00:00+08:00', '2026-11-05T09:00Z'];
  for (const at of valid) {
    await client.signals([{ ...base, eventId: `e-${valid.indexOf(at)}`, at }]);
    assert.equal(JSON.parse(api.calls.at(-1).init.body).signals[0].at, at, `ISO 时间应原样发出：${at}`);
  }
});

t('signals：响应形状不对时明确抛出', async () => {
  const api = fakeApi(() => ({ accepted: 1 }));
  const err = await caught(() =>
    createFeedClient({ api }).signals([
      { eventId: 'e1', itemId: ITEM_ID, type: 'impression', at: '2026-11-05T09:00:00.000Z' },
    ]),
  );
  assert.equal(err.code, 'feed_protocol_error');
});

/* ---- favorite ---- */

t('favorite：PUT/DELETE 都带 JSON body，返回 favorite', async () => {
  const api = fakeApi(({ init }) => ({ favorite: init.method === 'PUT' }));
  const client = createFeedClient({ api });

  assert.deepEqual(await client.favorite(ITEM_ID, true), { favorite: true });
  assert.equal(api.calls[0].pathname, `/api/feed/items/${ITEM_ID}/favorite`);
  assert.equal(api.calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { clientKind: 'mobile' });

  assert.deepEqual(await client.favorite(ITEM_ID, false), { favorite: false });
  assert.equal(api.calls[1].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(api.calls[1].init.body), { clientKind: 'mobile' }, 'DELETE 取消收藏也要带 body');

  assert.equal((await caught(() => client.favorite(ITEM_ID, 'yes'))).code, 'feed_invalid_argument');
  assert.equal(api.calls.length, 2);
});

t('favorite：响应缺 favorite 布尔 → 协议错误', async () => {
  const api = fakeApi(() => ({ ok: true }));
  const err = await caught(() => createFeedClient({ api }).favorite(ITEM_ID, true));
  assert.equal(err.code, 'feed_protocol_error');
});

/* ---- hide ---- */

t('hide：POST hide 带 clientKind，返回 hiddenAt', async () => {
  const api = fakeApi(() => ({ hiddenAt: '2026-11-05T09:30:00.000Z' }));
  const result = await createFeedClient({ api }).hide(ITEM_ID);
  assert.equal(api.calls[0].pathname, `/api/feed/items/${ITEM_ID}/hide`);
  assert.equal(api.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { clientKind: 'mobile' });
  assert.deepEqual(result, { hiddenAt: '2026-11-05T09:30:00.000Z' });
});

t('hide：缺 hiddenAt → 协议错误', async () => {
  const api = fakeApi(() => ({}));
  const err = await caught(() => createFeedClient({ api }).hide(ITEM_ID));
  assert.equal(err.code, 'feed_protocol_error');
});

/* ---- task ---- */

t('task：发送宿主 action.id（不是 kind），返回归一化 task', async () => {
  const api = fakeApi(() => ({
    task: {
      state: 'done',
      actions: [{ id: 'act-done', kind: 'confirm', label: '已完成', extra: 'drop-me' }],
      dueAt: null,
    },
  }));
  const result = await createFeedClient({ api }).task(ITEM_ID, 'act-done');
  assert.equal(api.calls[0].pathname, `/api/feed/items/${ITEM_ID}/task`);
  assert.equal(api.calls[0].init.method, 'POST');
  const body = JSON.parse(api.calls[0].init.body);
  assert.deepEqual(body, { clientKind: 'mobile', actionId: 'act-done' });
  assert.equal('kind' in body, false, '请求里不能出现 kind 字段');
  assert.deepEqual(result, {
    task: { state: 'done', actions: [{ id: 'act-done', kind: 'confirm', label: '已完成' }] },
  });
});

t('task：actionId 为空/缺 task 响应 → 明确抛出', async () => {
  const api = fakeApi(() => ({}));
  const client = createFeedClient({ api });
  assert.equal((await caught(() => client.task(ITEM_ID, ''))).code, 'feed_invalid_argument');
  assert.equal(api.calls.length, 0);
  const err = await caught(() => client.task(ITEM_ID, 'act-done'));
  assert.equal(err.code, 'feed_protocol_error');
});

t('task：422 feed_task_not_pending 保留 status/code/message', async () => {
  const original = httpError(422, { error: 'feed_task_not_pending', message: '这条待办已经处理过了' });
  const api = fakeApi(() => {
    throw original;
  });
  const err = await caught(() => createFeedClient({ api }).task(ITEM_ID, 'act-done'));
  assert.equal(err, original, '不得换掉原错误对象');
  assert.equal(err.status, 422);
  assert.equal(err.code, 'feed_task_not_pending');
  assert.deepEqual(err.body, { error: 'feed_task_not_pending', message: '这条待办已经处理过了' });
});

/* ---- prepare ---- */

t('prepare：POST 冻结引用，id/revision 与请求一致才返回', async () => {
  const api = fakeApi(() => ({ ok: true, feedCard: { itemId: ITEM_ID, revision: 3, title: '今日待办' } }));
  const reference = await createFeedClient({ api }).prepare('sess-1', ITEM_ID, 3);
  assert.equal(api.calls[0].pathname, '/api/feed/send/prepare');
  assert.equal(api.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { sessionId: 'sess-1', feedItemId: ITEM_ID, revision: 3 });
  assert.deepEqual(reference, { itemId: ITEM_ID, revision: 3, title: '今日待办' });
});

t('prepare：返回身份与请求不符 → feed_prepare_mismatch', async () => {
  const wrongItem = fakeApi(() => ({ ok: true, feedCard: { itemId: ITEM_ID_B, revision: 3, title: 'T' } }));
  const errItem = await caught(() => createFeedClient({ api: wrongItem }).prepare('sess-1', ITEM_ID, 3));
  assert.equal(errItem.code, 'feed_prepare_mismatch');

  const wrongRev = fakeApi(() => ({ ok: true, feedCard: { itemId: ITEM_ID, revision: 4, title: 'T' } }));
  const errRev = await caught(() => createFeedClient({ api: wrongRev }).prepare('sess-1', ITEM_ID, 3));
  assert.equal(errRev.code, 'feed_prepare_mismatch');
});

t('prepare：ok=false 时保留宿主 code/message 并抛出', async () => {
  const api = fakeApi(() => ({ ok: false, error: 'feed_send_unavailable', message: '来源 Agent 不可用' }));
  const err = await caught(() => createFeedClient({ api }).prepare('sess-1', ITEM_ID, 3));
  assert.equal(err.code, 'feed_send_unavailable');
  assert.match(err.message, /来源 Agent 不可用/);
});

t('prepare：非法 sessionId 不发请求', async () => {
  const api = fakeApi(() => ({ ok: true, feedCard: { itemId: ITEM_ID, revision: 3, title: 'T' } }));
  const err = await caught(() => createFeedClient({ api }).prepare('', ITEM_ID, 3));
  assert.equal(err.code, 'feed_invalid_argument');
  assert.equal(api.calls.length, 0);
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
