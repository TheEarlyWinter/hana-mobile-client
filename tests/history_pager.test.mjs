/* tests/history_pager.test.mjs
 *
 * web/history-pager.js 契约测试（纯控制器，不加载 app.js、不碰 DOM）
 * 覆盖：
 * 1. open：显式身份 + limit=50 拉最新页；path/sessionId 至少一者有效；参数不带 namespace/all
 * 2. loadOlder：before=当前最早 raw message id；canonical messages+blocks 按 afterIndex
 *    交错成 entries（早期 interactive_card 从 blocks 带出，不伪造进 messages）
 * 3. 两页顺序 / 消息与块重叠去重 / 重复锚点块不重复 / sourceIndex+身份 key
 * 4. 同页双击 loadOlder 只发一次请求
 * 5. 换会话时旧成功/旧失败都不落地；reset/dispose 废弃在途
 * 6. 当前页错误保留 cursor/hasMore 可重试，不伪装空成功
 * 7. cursor 为 0 / 缺失 / 不前进时停止，绝不请求 before=0；cursor 只取 messages
 * 8. canLoad 在请求前与响应提交前拦截，保留重试能力
 * 9. 响应 malformed 清楚报错；数组 / {entries} / {items} / {messages} 兼容；
 *    blocks 缺失/null 兼容、显式非数组报错、锚点缺失/越界不挂错位、packageRef 原样透传
 * 10. legacy toolResult 条目只保留兼容说明，不作为真实宿主形状
 * 11. sessionFiles 当前页数组原样交付；旧页不污染；缺失/null 为 []；显式非数组报错
 */

import assert from 'node:assert/strict';
import { createHistoryPager } from '../web/history-pager.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi() {
  const calls = [];
  const pending = [];
  function api(url) {
    const d = deferred();
    calls.push(String(url));
    pending.push(d);
    return d.promise;
  }
  return { api, calls, pending };
}

function harness({ canLoad = () => true, pageSize } = {}) {
  const { api, calls, pending } = makeApi();
  const pages = [];
  const states = [];
  const options = {
    api,
    onPage: (page) => pages.push(page),
    onState: (state) => states.push(state),
    canLoad,
  };
  if (pageSize !== undefined) options.pageSize = pageSize;
  const pager = createHistoryPager(options);
  return { pager, calls, pending, pages, states };
}

function queryOf(url) {
  const [pathname, query = ''] = String(url).split('?');
  return { pathname, params: Object.fromEntries(new URLSearchParams(query)) };
}

function msg(id, extra = {}) {
  const numeric = Number(id);
  return {
    id: String(id),
    role: Number.isInteger(numeric) && numeric % 2 === 0 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `m${id}` }],
    ...extra,
  };
}

function rows(from, to, extra) {
  const out = [];
  for (let i = from; i <= to; i += 1) {
    out.push(msg(i, typeof extra === 'function' ? extra(i) : extra));
  }
  return out;
}

function cardBlock(extra = {}) {
  return {
    type: 'interactive_card',
    cardId: 'card-x',
    title: '卡片',
    code: '<div class="safe-card">ok</div>',
    ...extra,
  };
}

const lastState = (h) => h.states[h.states.length - 1];
const idsOf = (entries) => entries.map((entry) => entry.id);
const messageIdsOf = (entries) => entries
  .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant'))
  .map((entry) => entry.id);

const SESSION = { sessionId: 'sess-1', path: 'C:/Users/qa/.hana/sessions/s1.jsonl' };

/* ------------------------------------------------------------------ */
/* 1. open                                                             */
/* ------------------------------------------------------------------ */

await t('open：显式身份 + limit=50 拉最新页，onPage 初始页 prepend=false', async () => {
  const h = harness();
  const session = { ...SESSION, namespace: 'code', cwd: 'C:/repo', all: '1' };
  const p = h.pager.open(session);

  assert.equal(h.states.length, 1);
  // phase 是新增字段：进行中的 open 就是 'initial'（视图只在有 error 时读它）。
  assert.deepEqual(h.states[0], { loading: true, hasMore: false, error: null, phase: 'initial' });
  assert.equal(h.calls.length, 1);

  const { pathname, params } = queryOf(h.calls[0]);
  assert.equal(pathname, '/api/sessions/messages');
  assert.deepEqual(params, {
    sessionId: 'sess-1',
    path: 'C:/Users/qa/.hana/sessions/s1.jsonl',
    limit: '50',
  });
  assert.equal('namespace' in params, false);
  assert.equal('all' in params, false);
  assert.equal('before' in params, false);

  const tail = rows(150, 199);
  h.pending[0].resolve({ messages: tail, hasMore: true, blocks: [] });
  assert.equal(await p, true);

  assert.equal(h.pages.length, 1);
  const page = h.pages[0];
  assert.equal(page.prepend, false);
  assert.equal(page.hasMore, true);
  assert.deepEqual(idsOf(page.entries), idsOf(tail));
  assert.equal(page.entries[0], tail[0], '条目对象身份必须原样保留');
  assert.deepEqual(lastState(h), { loading: false, hasMore: true, error: null, phase: 'initial' });
});

await t('open：只给 path 或只给 sessionId 时只带有效身份', async () => {
  const byPath = harness();
  byPath.pager.open({ path: 'C:/sessions/only-path.jsonl' });
  assert.deepEqual(queryOf(byPath.calls[0]).params, {
    path: 'C:/sessions/only-path.jsonl',
    limit: '50',
  });

  const byId = harness();
  byId.pager.open({ sessionId: 'sess-only' });
  assert.deepEqual(queryOf(byId.calls[0]).params, {
    sessionId: 'sess-only',
    limit: '50',
  });
});

await t('open：无有效身份同步抛错且不发请求', () => {
  const h = harness();
  for (const session of [null, {}, { sessionId: '   ' }, { path: '' }, { sessionId: 42, path: null }]) {
    assert.throws(() => h.pager.open(session), /sessionId 或 path/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.pages.length, 0);
  assert.equal(h.states.length, 0);
});

await t('open：同步捕获身份标量，调用后改 session 对象不影响请求', async () => {
  const h = harness();
  const session = { sessionId: 'sess-old', path: 'C:/old.jsonl' };
  h.pager.open(session);
  session.sessionId = 'sess-new';
  session.path = 'C:/new.jsonl';

  assert.deepEqual(queryOf(h.calls[0]).params, {
    sessionId: 'sess-old',
    path: 'C:/old.jsonl',
    limit: '50',
  });
});

/* ------------------------------------------------------------------ */
/* 2. loadOlder：before / prepend / canonical messages+blocks          */
/* ------------------------------------------------------------------ */

await t('canonical：messages 仅 user/assistant，早期 interactive_card 按 afterIndex 交错', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  const tailCard = cardBlock({
    cardId: 'card-tail',
    title: '尾部卡片',
    code: '<div>tail</div>',
    afterIndex: 5,
    sourceIndex: 1005,
  });
  h.pending[0].resolve({ messages: rows(150, 199), blocks: [tailCard], hasMore: true });
  await p1;

  const page1 = h.pages[0];
  assert.deepEqual(messageIdsOf(page1.entries), idsOf(rows(150, 199)), 'messages 仍按原顺序交付');
  const tailIndex = page1.entries.indexOf(tailCard);
  assert.notEqual(tailIndex, -1, '初始页的交互卡片块必须交付');
  assert.equal(page1.entries[tailIndex - 1].id, '155', '卡片块必须紧跟 afterIndex=5 的消息');
  assert.equal(page1.entries[tailIndex + 1].id, '156', '卡片块之后继续原消息顺序');
  assert.equal(tailCard.type, 'interactive_card');
  assert.equal('role' in tailCard, false, 'block 不得被伪造成 toolResult');

  const p2 = h.pager.loadOlder();
  assert.equal(queryOf(h.calls[1]).params.before, '150');
  const earlyCard = cardBlock({
    cardId: 'card-early',
    title: '早期卡片',
    code: '<div class="early">safe</div>',
    afterIndex: 10,
    sourceIndex: 1010,
  });
  const olderMessages = rows(100, 149);
  h.pending[1].resolve({ messages: olderMessages, blocks: [earlyCard], hasMore: true });
  assert.equal(await p2, true);

  const page2 = h.pages[1];
  assert.equal(page2.prepend, true);
  assert.equal(page2.hasMore, true);
  assert.deepEqual(messageIdsOf(page2.entries), idsOf(olderMessages), '早期 messages 顺序不变');
  const earlyIndex = page2.entries.indexOf(earlyCard);
  assert.notEqual(earlyIndex, -1, '早期卡片块必须交付');
  assert.equal(page2.entries[earlyIndex], earlyCard, 'block 对象必须原样透传');
  assert.equal(page2.entries[earlyIndex - 1].id, '110', 'afterIndex=10 对应页内第 11 条消息');
  assert.equal(page2.entries[earlyIndex + 1].id, '111');
  assert.equal(page2.entries.length, olderMessages.length + 1);
  assert.equal('role' in earlyCard, false, '不得把 block 伪造成 toolResult');
  assert.ok(!olderMessages.includes(earlyCard), 'block 不得混进 messages');
  assert.deepEqual(lastState(h), { loading: false, hasMore: true, error: null, phase: 'older' });
});

await t('blocks.packageRef 原样透传：不补 sessionId/path，不改写身份', async () => {
  const h = harness();
  const p = h.pager.open(SESSION);
  const packageCard = {
    type: 'interactive_card',
    cardId: 'card-pkg',
    title: '包卡片',
    packageRef: { fileId: 'file-1', sessionId: 'sess-pkg', entryName: 'index.html' },
    afterIndex: 0,
    sourceIndex: 77,
  };
  h.pending[0].resolve({ messages: rows(1, 2), blocks: [packageCard], hasMore: false });
  await p;

  const entries = h.pages[0].entries;
  assert.equal(entries[0].id, '1');
  assert.equal(entries[1], packageCard, 'package block 必须原样交付');
  assert.equal(entries[2].id, '2');
  assert.deepEqual(packageCard.packageRef, {
    fileId: 'file-1',
    sessionId: 'sess-pkg',
    entryName: 'index.html',
  }, 'packageRef 不得被改写');
  assert.equal('sessionPath' in packageCard.packageRef, false, '不得用其它字段补 sessionPath');
  assert.equal('sessionId' in packageCard, false, '不得把 packageRef.sessionId 提升到 block');
});

await t('跨页重叠：重复消息锚点的 block 不重复交付，新锚点 block 正常插入', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  const cardA = cardBlock({ cardId: 'card-a', afterIndex: 49, sourceIndex: 900 });
  h.pending[0].resolve({ messages: rows(100, 149), blocks: [cardA], hasMore: true });
  await p1;

  const p2 = h.pager.loadOlder();
  const cardB = cardBlock({ cardId: 'card-b', afterIndex: 49, sourceIndex: 901 });
  const cardC = cardBlock({ cardId: 'card-c', afterIndex: 10, sourceIndex: 902 });
  h.pending[1].resolve({ messages: rows(80, 129), blocks: [cardB, cardC], hasMore: false });
  await p2;

  const delivered = h.pages.flatMap((page) => page.entries);
  assert.equal(delivered.filter((entry) => entry.type === 'interactive_card').length, 2, '只应有首页 cardA 与新锚点 cardC');
  assert.ok(delivered.includes(cardA));
  assert.ok(delivered.includes(cardC));
  assert.ok(!delivered.includes(cardB), '锚在重复消息上的 block 不得重复交付');

  const page2 = h.pages[1];
  assert.equal(page2.entries.includes(cardB), false);
  const cardIndex = page2.entries.indexOf(cardC);
  assert.notEqual(cardIndex, -1);
  assert.equal(page2.entries[cardIndex - 1].id, '90', 'cardC 必须挂在页内新锚点消息 90 之后');
  assert.equal(page2.entries[cardIndex + 1].id, '91');
});

await t('blocks 按 afterIndex 分组：不依赖 blocks 全局顺序，同锚点保持宿主顺序', async () => {
  const h = harness();
  const p = h.pager.open(SESSION);
  const afterSecond = cardBlock({ cardId: 'after-second', afterIndex: 1, sourceIndex: 12 });
  const firstAtZero = cardBlock({ cardId: 'zero-1', afterIndex: 0, sourceIndex: 10 });
  const secondAtZero = cardBlock({ cardId: 'zero-2', afterIndex: 0, sourceIndex: 11 });
  h.pending[0].resolve({
    messages: rows(10, 11),
    blocks: [afterSecond, firstAtZero, secondAtZero],
    hasMore: false,
  });
  await p;

  assert.deepEqual(
    h.pages[0].entries.map((entry) => entry.cardId || entry.id),
    ['10', 'zero-1', 'zero-2', '11', 'after-second'],
    '块必须按 afterIndex 挂到对应消息之后，同锚点按 blocks 原顺序',
  );
});

await t('block 去重 key：同 source 同身份的重复块只交付一次，不同 cardId 都保留', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  const first = cardBlock({ cardId: 'dup', afterIndex: 0, sourceIndex: 500 });
  const twice = cardBlock({ cardId: 'dup', afterIndex: 0, sourceIndex: 500 });
  const other = cardBlock({ cardId: 'other', afterIndex: 0, sourceIndex: 500 });
  h.pending[0].resolve({
    messages: rows(1, 2),
    blocks: [first, twice, other],
    hasMore: false,
  });
  await p1;

  const cards = h.pages[0].entries.filter((entry) => entry.type === 'interactive_card');
  assert.equal(cards.length, 2, '同 source/type/cardId 的重复块只交付一次');
  assert.equal(cards[0], first);
  assert.equal(cards[1], other, '不同 cardId 的块必须都保留');
});

await t('cursor 只按 raw messages 最小 id，不采用 block 的 cardId/sourceIndex/id', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  const tricky = cardBlock({ cardId: '0', afterIndex: 0, sourceIndex: 1, id: '0' });
  h.pending[0].resolve({ messages: rows(100, 149), blocks: [tricky], hasMore: true });
  await p1;

  const p2 = h.pager.loadOlder();
  assert.equal(queryOf(h.calls[1]).params.before, '100', 'before 必须来自 messages 而不是 block 字段');
  h.pending[1].resolve({ messages: rows(50, 99), blocks: [], hasMore: false });
  await p2;
});

await t('分页顺序与重叠去重：第二页重叠 20 条只交付新条目', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  const p2 = h.pager.loadOlder();
  // 服务端返回 70..119：100..119 与首页重叠，只应交付 70..99。
  h.pending[1].resolve({ messages: rows(70, 119), hasMore: true });
  await p2;

  const delivered = h.pages.flatMap((page) => idsOf(page.entries));
  assert.deepEqual(delivered, [
    ...idsOf(rows(100, 149)),
    ...idsOf(rows(70, 99)),
  ]);
  assert.equal(new Set(delivered).size, delivered.length, '跨页不得重复交付同一 id');
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(70, 99)));

  // 下一轮 before 必须是最早 raw id 70，而不是去重后最后一条。
  const p3 = h.pager.loadOlder();
  assert.equal(queryOf(h.calls[2]).params.before, '70');
  h.pending[2].resolve({ messages: rows(20, 69), hasMore: false });
  await p3;
  assert.equal(lastState(h).hasMore, false);
  assert.deepEqual(idsOf(h.pages[2].entries), idsOf(rows(20, 69)));
});

await t('同页双击 loadOlder：并行只发一次请求，第二次直接拒绝', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  const first = h.pager.loadOlder();
  const second = h.pager.loadOlder();
  assert.equal(h.calls.length, 2, '只允许一个在途 loadOlder 请求');
  assert.equal(await second, false);

  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await first, true);
  assert.equal(h.pages.length, 2);
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(50, 99)));
});

/* ------------------------------------------------------------------ */
/* 3. 换会话 / reset / dispose                                         */
/* ------------------------------------------------------------------ */

await t('换会话：旧 open 成功晚到不得落地', async () => {
  const h = harness();
  const oldOpen = h.pager.open({ sessionId: 'sess-old' });
  const newOpen = h.pager.open({ sessionId: 'sess-new' });
  assert.equal(h.calls.length, 2);

  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await oldOpen, false);
  assert.equal(h.pages.length, 0, '旧会话成功不得触发 onPage');

  h.pending[1].resolve({ messages: rows(200, 249), hasMore: false });
  assert.equal(await newOpen, true);
  assert.deepEqual(idsOf(h.pages[0].entries), idsOf(rows(200, 249)));
  assert.equal(lastState(h).error, null);
});

await t('换会话：旧 open 失败晚到不得报错', async () => {
  const h = harness();
  const oldOpen = h.pager.open({ sessionId: 'sess-old' });
  const newOpen = h.pager.open({ sessionId: 'sess-new' });

  h.pending[1].resolve({ messages: rows(200, 249), hasMore: false });
  await newOpen;
  const stateBefore = lastState(h);

  h.pending[0].reject(new Error('旧会话失败'));
  assert.equal(await oldOpen, false);
  assert.equal(lastState(h), stateBefore, '旧失败不得改写当前状态');
  assert.equal(lastState(h).error, null);
  assert.equal(h.pages.length, 1);
});

await t('reset：废弃在途 loadOlder，清空游标并通知状态', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  const older = h.pager.loadOlder();
  const stateCount = h.states.length;
  h.pager.reset();
  assert.equal(h.states.length, stateCount + 1);
  // 没有请求时 phase 沿用最近一次（这里是 loadOlder 的 'older'），reset 不归零。
  assert.deepEqual(lastState(h), { loading: false, hasMore: false, error: null, phase: 'older' });
  assert.equal(await h.pager.loadOlder(), false, 'reset 后 loadOlder 无操作');
  assert.equal(h.calls.length, 2);

  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, false);
  assert.equal(h.pages.length, 1, 'reset 后旧响应不得触发 onPage');
  assert.deepEqual(lastState(h), { loading: false, hasMore: false, error: null, phase: 'older' });

  // reset 后重新 open 应正常，且 seen 已清空可再次交付相同 id。
  const reopened = h.pager.open(SESSION);
  h.pending[2].resolve({ messages: rows(100, 149), hasMore: false });
  await reopened;
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(100, 149)));
});

await t('dispose：废弃在途结果且不再回调，之后 open 不发请求', async () => {
  const h = harness();
  const p = h.pager.open(SESSION);
  const stateCount = h.states.length;

  h.pager.dispose();
  assert.equal(h.states.length, stateCount, 'dispose 本身不回调');

  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await p, false);
  assert.equal(h.pages.length, 0);
  assert.equal(h.states.length, stateCount);

  assert.equal(await h.pager.open(SESSION), false);
  assert.equal(await h.pager.loadOlder(), false);
  assert.equal(h.calls.length, 1, 'dispose 后不得再发请求');

  h.pager.dispose(); // 幂等
  h.pager.reset();   // dispose 后 reset 无操作
  assert.equal(h.states.length, stateCount);
});

/* ------------------------------------------------------------------ */
/* 4. 错误与重试                                                       */
/* ------------------------------------------------------------------ */

await t('loadOlder 的 4xx 失败：不自动重试，报 onState error，保留 cursor/hasMore 可重试', async () => {
  const h = harness();
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  // 4xx 不重试（瞬时故障的自动重试在 history_pager_retry.test.mjs）；这里锁「最终失败
  // 仍保留 cursor/hasMore，用户手动重试从原 before 开始」。
  const error = Object.assign(new Error('403 无权限读取该会话'), { status: 403 });
  const failed = h.pager.loadOlder();
  h.pending[1].reject(error);
  assert.equal(await failed, false);
  assert.equal(h.calls.length, 2, '4xx 不得自动重试');

  assert.equal(h.pages.length, 1, '失败不得伪装空成功');
  assert.deepEqual(lastState(h), { loading: false, hasMore: true, error, phase: 'older' });

  const retry = h.pager.loadOlder();
  assert.equal(queryOf(h.calls[2]).params.before, '100', '重试必须沿用原 cursor');
  h.pending[2].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await retry, true);
  assert.equal(h.pages.length, 2);
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(50, 99)));
  assert.equal(lastState(h).error, null);
});

/* ------------------------------------------------------------------ */
/* 5. cursor 防御                                                      */
/* ------------------------------------------------------------------ */

await t('cursor 为 0 或缺失：hasMore 关闭，绝不请求 before=0', async () => {
  const zero = harness();
  const zeroOpen = zero.pager.open({ sessionId: 'sess-zero' });
  zero.pending[0].resolve({ messages: rows(0, 49), hasMore: true });
  await zeroOpen;
  assert.equal(lastState(zero).hasMore, false, '最早 id=0 且 hasMore=true 属于不可翻页状态');
  assert.equal(await zero.pager.loadOlder(), false);
  assert.equal(zero.calls.length, 1);
  assert.equal(queryOf(zero.calls[0]).params.before, undefined);

  const missing = harness();
  const missingOpen = missing.pager.open({ sessionId: 'sess-missing' });
  missing.pending[0].resolve({
    messages: [{ role: 'user' }, { role: 'assistant' }],
    hasMore: true,
  });
  await missingOpen;
  assert.equal(lastState(missing).hasMore, false, '没有数值 id 时不能产生游标');
  assert.equal(await missing.pager.loadOlder(), false);
  assert.equal(missing.calls.length, 1);
});

await t('cursor 不前进：重复页/更晚 id/非法 id 都会停止，不产生死循环', async () => {
  const cases = [
    { olderRows: rows(100, 149), delivered: false },            // 原样重复
    { olderRows: rows(120, 149), delivered: false },            // 最早 id 比 cursor 更晚
    // 无有效 id 的条目不参与去重/游标，可以交付，但游标仍不得前进。
    { olderRows: [{ id: 'abc', role: 'user' }, ...rows(100, 149)], delivered: true },
  ];

  for (const { olderRows, delivered } of cases) {
    const h = harness();
    const p1 = h.pager.open(SESSION);
    h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
    await p1;

    const p2 = h.pager.loadOlder();
    h.pending[1].resolve({ messages: olderRows, hasMore: true });
    await p2;

    assert.equal(lastState(h).hasMore, false, `不前进的页必须关闭 hasMore：${JSON.stringify(idsOf(olderRows.slice(0, 3)))}`);
    assert.equal(h.pages.length, delivered ? 2 : 1, '重叠页不得重复交付；无 id 条目无法判定重叠');
    assert.equal(await h.pager.loadOlder(), false);
    assert.equal(h.calls.length, 2, '停止后不得再次请求');
  }
});

/* ------------------------------------------------------------------ */
/* 6. canLoad                                                          */
/* ------------------------------------------------------------------ */

await t('canLoad=false 在请求前：不发请求、保留 hasMore，并给出可重试错误', async () => {
  let busy = false;
  const h = harness({ canLoad: () => !busy });
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  busy = true;
  const blocked = h.pager.loadOlder();
  assert.equal(await blocked, false);
  assert.equal(h.calls.length, 1, '生成中不得发 loadOlder 请求');
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).hasMore, true, '必须保留重试能力');
  assert.equal(lastState(h).error?.code, 'busy');
  assert.match(lastState(h).error.message, /稍后/);

  busy = false;
  const retry = h.pager.loadOlder();
  assert.equal(h.calls.length, 2);
  assert.equal(queryOf(h.calls[1]).params.before, '100');
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await retry, true);
  assert.equal(h.pages.length, 2);
});

await t('canLoad=false 在响应提交前：不 render、不推进 cursor，恢复后可重试', async () => {
  let busy = false;
  const h = harness({ canLoad: () => !busy });
  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  await p1;

  const older = h.pager.loadOlder();
  busy = true;
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, false);

  assert.equal(h.pages.length, 1, '生成中返回的旧页不得上屏');
  assert.equal(lastState(h).error?.code, 'busy');
  assert.equal(lastState(h).hasMore, true, 'cursor 未推进，hasMore 必须保留');

  busy = false;
  const retry = h.pager.loadOlder();
  assert.equal(queryOf(h.calls[2]).params.before, '100', '重试仍从原 cursor 开始');
  h.pending[2].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await retry, true);
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(50, 99)));
});

await t('canLoad=false 在 open 响应提交前：不交付初始页，报 busy', async () => {
  let busy = false;
  const h = harness({ canLoad: () => !busy });
  const p = h.pager.open(SESSION);
  busy = true;
  h.pending[0].resolve({ messages: rows(150, 199), hasMore: true });
  assert.equal(await p, false);

  assert.equal(h.pages.length, 0);
  assert.equal(lastState(h).error?.code, 'busy');
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).hasMore, false);
});

/* ------------------------------------------------------------------ */
/* 7. 响应形状                                                         */
/* ------------------------------------------------------------------ */

await t('malformed 响应：清楚报错，不当空成功', async () => {
  for (const raw of [{}, { messages: 'nope' }, { sessions: [] }, null, 'oops', 42]) {
    const h = harness();
    const p = h.pager.open({ sessionId: 'sess-bad' });
    h.pending[0].resolve(raw);
    assert.equal(await p, false);
    assert.equal(h.pages.length, 0, `响应 ${JSON.stringify(raw)} 不得触发 onPage`);
    assert.equal(lastState(h).loading, false);
    assert.match(lastState(h).error.message, /历史消息响应格式/);
  }
});

await t('响应兼容：数组 / entries / items，canonical messages+hasMore 正常分页', async () => {
  const arrayShape = harness();
  const p1 = arrayShape.pager.open({ sessionId: 's' });
  arrayShape.pending[0].resolve(rows(1, 3));
  await p1;
  assert.deepEqual(idsOf(arrayShape.pages[0].entries), ['1', '2', '3']);
  assert.equal(lastState(arrayShape).hasMore, false);

  const entriesShape = harness();
  const p2 = entriesShape.pager.open({ sessionId: 's' });
  entriesShape.pending[0].resolve({ entries: rows(4, 6) });
  await p2;
  assert.deepEqual(idsOf(entriesShape.pages[0].entries), ['4', '5', '6']);
  assert.equal(lastState(entriesShape).hasMore, false, 'hasMore 不明确时按无更早处理');

  const itemsShape = harness();
  const p3 = itemsShape.pager.open({ sessionId: 's' });
  itemsShape.pending[0].resolve({ items: rows(7, 9) });
  await p3;
  assert.deepEqual(idsOf(itemsShape.pages[0].entries), ['7', '8', '9']);
  assert.equal(lastState(itemsShape).hasMore, false);

  const empty = harness();
  const p4 = empty.pager.open({ sessionId: 's' });
  empty.pending[0].resolve({ messages: [], hasMore: false });
  await p4;
  assert.deepEqual(empty.pages[0], { entries: [], prepend: false, hasMore: false, sessionFiles: [] });
  assert.deepEqual(lastState(empty), { loading: false, hasMore: false, error: null, phase: 'initial' });
});

await t('blocks 缺失/null 兼容；显式非数组清楚报错', async () => {
  const messages = rows(1, 2);

  const noBlocks = harness();
  const p1 = noBlocks.pager.open({ sessionId: 's' });
  noBlocks.pending[0].resolve({ messages, hasMore: false });
  await p1;
  assert.deepEqual(noBlocks.pages[0].entries, messages, '没有 blocks 时消息原样交付');

  const nullBlocks = harness();
  const p2 = nullBlocks.pager.open({ sessionId: 's' });
  nullBlocks.pending[0].resolve({ messages, blocks: null, hasMore: false });
  await p2;
  assert.deepEqual(nullBlocks.pages[0].entries, messages, 'blocks=null 按缺失兼容');

  for (const badBlocks of [{}, 'nope', 42]) {
    const h = harness();
    const p = h.pager.open({ sessionId: 's' });
    h.pending[0].resolve({ messages, blocks: badBlocks, hasMore: false });
    await p;
    assert.equal(h.pages.length, 0, `blocks=${JSON.stringify(badBlocks)} 不得伪装成成功页`);
    assert.match(lastState(h).error.message, /blocks/, '错误信息必须指向 blocks 形状');
  }
});

await t('blocks 锚点缺失/越界不挂错位置；未知类型原样交付', async () => {
  const h = harness();
  const p = h.pager.open(SESSION);
  const unknown = { type: 'mystery_block', payload: { a: 1 }, afterIndex: 1, sourceIndex: 42 };
  h.pending[0].resolve({
    messages: rows(1, 3),
    blocks: [
      unknown,
      cardBlock({ cardId: 'bad-future', afterIndex: 99, sourceIndex: 43 }),
      cardBlock({ cardId: 'bad-negative', afterIndex: -1, sourceIndex: 44 }),
      cardBlock({ cardId: 'bad-missing', sourceIndex: 45 }),
      { cardId: 'not-a-block' },
      null,
    ],
    hasMore: false,
  });
  await p;

  const entries = h.pages[0].entries;
  assert.deepEqual(messageIdsOf(entries), ['1', '2', '3'], '消息仍完整交付');
  assert.equal(entries.filter((entry) => entry.type === 'interactive_card').length, 0, '越界/缺失锚点的卡片不得挂载');
  assert.equal(entries[1].id, '2');
  assert.equal(entries[2], unknown, '未知类型 block 只要锚点有效就原样交付');
  assert.equal(entries[3].id, '3');
});

await t('messages 为空时 blocks 不猜锚点、不交付', async () => {
  const h = harness();
  const p = h.pager.open({ sessionId: 's' });
  h.pending[0].resolve({
    messages: [],
    blocks: [cardBlock({ cardId: 'orphan', afterIndex: 0, sourceIndex: 1 })],
    hasMore: false,
  });
  await p;
  assert.deepEqual(h.pages[0].entries, []);
  assert.equal(lastState(h).error, null);
});

await t('legacy toolResult 仅作兼容：无 blocks 的旧响应仍原样交付（非真实宿主形状）', async () => {
  const h = harness();
  const legacy = [
    { id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: '2', role: 'toolResult', toolName: 'show_card', details: { cardId: 'legacy-card' } },
  ];
  const p = h.pager.open({ sessionId: 's' });
  h.pending[0].resolve(legacy);
  await p;
  assert.deepEqual(h.pages[0].entries, legacy);
  assert.deepEqual(h.pages[0].sessionFiles, []);
  assert.equal(lastState(h).hasMore, false);
});

await t('sessionFiles：canonical 数组原样交付且不并入 entries/blocks', async () => {
  const h = harness();
  const p = h.pager.open(SESSION);
  const files = [
    { fileId: 'file-1', name: 'photo.png', mimeType: 'image/png', size: 1234, sessionId: 'sess-1' },
    { fileId: 'file-2', name: 'doc.pdf', mimeType: 'application/pdf', size: 88 },
  ];
  const card = cardBlock({ cardId: 'card-1', afterIndex: 0, sourceIndex: 10 });
  h.pending[0].resolve({
    messages: rows(1, 2),
    blocks: [card],
    hasMore: false,
    sessionFiles: files,
  });
  await p;

  const page = h.pages[0];
  assert.equal(page.sessionFiles, files, 'sessionFiles 数组身份必须原样透传');
  assert.equal(page.sessionFiles[0], files[0], 'metadata 对象不得复制/改写');
  assert.deepEqual(page.sessionFiles, files);
  assert.equal('sessionFiles' in card, false, '不得把 metadata 猜合并进 block');
  assert.equal('files' in card, false);
  assert.equal('sessionFiles' in page.entries[0], false, '不得把 metadata 注入 message');
});

await t('旧页各自 sessionFiles 不污染，缺失页为 []', async () => {
  const h = harness();
  const filesA = [{ fileId: 'file-a', sessionId: 'sess-1' }];
  const filesB = [{ fileId: 'file-b', sessionId: 'sess-1' }];

  const p1 = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true, sessionFiles: filesA });
  await p1;

  const p2 = h.pager.loadOlder();
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: true, sessionFiles: filesB });
  await p2;

  assert.equal(h.pages[0].sessionFiles, filesA);
  assert.equal(h.pages[1].sessionFiles, filesB);
  assert.equal(h.pages[1].sessionFiles.includes(filesA[0]), false, '旧页 metadata 不得混进新页');
  assert.equal(h.pages[0].sessionFiles.includes(filesB[0]), false);
  assert.deepEqual(filesA, [{ fileId: 'file-a', sessionId: 'sess-1' }], 'metadata 不得被改写');

  const p3 = h.pager.loadOlder();
  h.pending[2].resolve({ messages: rows(0, 49), hasMore: false });
  await p3;
  assert.deepEqual(h.pages[2].sessionFiles, [], '缺失 sessionFiles 的旧页为 []');
  assert.equal(h.pages[0].sessionFiles, filesA, '后续页不得清掉首页 metadata');
});

await t('换会话：旧会话迟到的 sessionFiles 不交付', async () => {
  const h = harness();
  const filesA = [{ fileId: 'file-old', sessionId: 'sess-old' }];
  const filesB = [{ fileId: 'file-new', sessionId: 'sess-new' }];

  const oldOpen = h.pager.open({ sessionId: 'sess-old' });
  const newOpen = h.pager.open({ sessionId: 'sess-new' });

  h.pending[0].resolve({ messages: rows(1, 2), hasMore: false, sessionFiles: filesA });
  assert.equal(await oldOpen, false);
  assert.equal(h.pages.length, 0, '旧会话迟到 metadata 不得触发 onPage');

  h.pending[1].resolve({ messages: rows(3, 4), hasMore: false, sessionFiles: filesB });
  assert.equal(await newOpen, true);
  assert.equal(h.pages.length, 1);
  assert.equal(h.pages[0].sessionFiles, filesB);
  assert.ok(!h.pages.some((page) => page.sessionFiles === filesA));
});

await t('sessionFiles 缺失/null 为 []，显式非数组清楚报错', async () => {
  const missing = harness();
  const p1 = missing.pager.open({ sessionId: 's' });
  missing.pending[0].resolve({ messages: rows(1, 2), hasMore: false });
  await p1;
  assert.deepEqual(missing.pages[0].sessionFiles, []);

  const nullFiles = harness();
  const p2 = nullFiles.pager.open({ sessionId: 's' });
  nullFiles.pending[0].resolve({ messages: rows(1, 2), hasMore: false, sessionFiles: null });
  await p2;
  assert.deepEqual(nullFiles.pages[0].sessionFiles, []);

  for (const bad of [{}, 'nope', 42]) {
    const h = harness();
    const p = h.pager.open({ sessionId: 's' });
    h.pending[0].resolve({ messages: rows(1, 2), hasMore: false, sessionFiles: bad });
    await p;
    assert.equal(h.pages.length, 0, `sessionFiles=${JSON.stringify(bad)} 不得伪装成成功页`);
    assert.match(lastState(h).error.message, /sessionFiles/, '错误信息必须指向 sessionFiles 形状');
  }
});

/* ------------------------------------------------------------------ */
/* 8. 其它                                                             */
/* ------------------------------------------------------------------ */

await t('pageSize：默认 50，自定义生效，超过宿主上限 200 时收敛', async () => {
  const custom = harness({ pageSize: 20 });
  custom.pager.open(SESSION);
  assert.equal(queryOf(custom.calls[0]).params.limit, '20');

  const clamped = harness({ pageSize: 500 });
  clamped.pager.open(SESSION);
  assert.equal(queryOf(clamped.calls[0]).params.limit, '200');
});

await t('open 之前 loadOlder / reset 均无请求；接口仅四个方法', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.pager).sort(), ['dispose', 'loadOlder', 'open', 'reset'].sort());
  assert.equal(await h.pager.loadOlder(), false);
  h.pager.reset();
  assert.equal(h.calls.length, 0);
  assert.equal(h.pages.length, 0);
});

await t('同会话 open 被 busy 拦下：不清已加载页的游标，随后仍能加载更早', async () => {
  let allowOpen = true;
  const h = harness({ canLoad: (kind) => (kind === 'older' ? true : allowOpen) });

  const first = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(51, 100), blocks: [], hasMore: true });
  assert.equal(await first, true);

  allowOpen = false;
  assert.equal(await h.pager.open(SESSION), false, '生成中重载应该被拦下');
  const blocked = lastState(h);
  assert.equal(blocked.error?.code, 'busy', '拦下的原因要是 busy');
  assert.equal(blocked.hasMore, true, '被拦不能把已加载页的 hasMore 清掉');
  assert.equal(h.calls.length, 1, '被拦的 open 不发请求');

  // 关键：后台补拉被拦过之后，同一个会话里「加载更早」必须还能用
  const older = h.pager.loadOlder();
  assert.equal(h.calls.length, 2, '生成中点加载更早仍要发请求');
  assert.equal(queryOf(h.calls[1]).params.before, '51', '游标不该被被拦的 open 冲掉');
  h.pending[1].resolve({ messages: rows(1, 50), blocks: [], hasMore: false });
  assert.equal(await older, true, '生成中「加载更早」应该成功交付');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
