/**
 * finished-notice 的单元测试。
 *
 * 重点盯三件事：基线没建好时不许误报、条数只增才算、以及「在跑 → 空闲」这条旁路。
 * 上一版（用会话列表时间戳）在真机上把整张列表报成新回复，所以这里对误报特别苛刻。
 */

import assert from 'node:assert/strict';
import { createFinishedNotice, formatNotice, MAX_NOTICE_ITEMS } from '../web/finished-notice.js';

let pass = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok ${pass} - ${name}`);
  } catch (err) {
    console.error(`not ok ${pass + 1} - ${name}`);
    console.error(err);
    process.exit(1);
  }
}

const row = (sessionId, messageCount, extra = {}) => ({ sessionId, title: `T-${sessionId}`, messageCount, isStreaming: false, ...extra });

test('基线之前 diff 一律空（宁可不说不误报）', () => {
  const notice = createFinishedNotice();
  const report = notice.diff([row('a', 9)]);
  assert.deepEqual(report, { total: 0, items: [] });
  assert.equal(notice.primed, false);
});

test('snapshot 之后同一份列表做差为空', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 2), row('b', 5)]);
  assert.deepEqual(notice.diff([row('a', 2), row('b', 5)]), { total: 0, items: [] });
});

test('条数变多的会话被报出来，并带增量', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 2), row('b', 5)]);
  const report = notice.diff([row('a', 4), row('b', 5)]);
  assert.equal(report.total, 1);
  assert.deepEqual(report.items[0], { sessionId: 'a', title: 'T-a', reason: 'replied', delta: 2 });
});

test('「在跑 → 空闲」但没有新条数，也算跑完一次', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 2, { isStreaming: true })]);
  const report = notice.diff([row('a', 2, { isStreaming: false })]);
  assert.equal(report.total, 1);
  assert.equal(report.items[0].reason, 'finished');
  assert.equal(report.items[0].delta, 0);
});

test('一直在跑（两次都是 true）不报', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 2, { isStreaming: true })]);
  assert.equal(notice.diff([row('a', 2, { isStreaming: true })]).total, 0);
});

test('基线里没有的新会话不报（分不清新建还是别人写的）', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 2)]);
  const report = notice.diff([row('a', 2), row('brand-new', 40)]);
  assert.equal(report.total, 0);
});

test('条数变少的会话不报（可能被删消息，不是新回复）', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 5)]);
  assert.equal(notice.diff([row('a', 2)]).total, 0);
});

test('只改标题不改条数不报', () => {
  const notice = createFinishedNotice();
  notice.snapshot([{ sessionId: 'a', title: '旧名', messageCount: 3 }]);
  const report = notice.diff([{ sessionId: 'a', title: '新名', messageCount: 3 }]);
  assert.equal(report.total, 0);
});

test('多个会话时按增量降序，报表只留前 maxItems 条但总数是全部', () => {
  const notice = createFinishedNotice({ maxItems: 2 });
  notice.snapshot([row('a', 1), row('b', 1), row('c', 1)]);
  const report = notice.diff([row('a', 9), row('b', 3), row('c', 2)]);
  assert.equal(report.total, 3);
  assert.deepEqual(report.items.map((i) => i.sessionId), ['a', 'b']);
});

test('默认上限是 MAX_NOTICE_ITEMS', () => {
  const notice = createFinishedNotice();
  const base = Array.from({ length: MAX_NOTICE_ITEMS + 3 }, (_, i) => row(`s${i}`, 0));
  notice.snapshot(base);
  const after = base.map((r, i) => ({ ...r, messageCount: i + 1 }));
  const report = notice.diff(after);
  assert.equal(report.items.length, MAX_NOTICE_ITEMS);
  assert.equal(report.total, MAX_NOTICE_ITEMS + 3);
});

test('上报完 snapshot 立刻变成新基线：同一份列表再问一次不重复报', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 1)]);
  const first = notice.diff([row('a', 5)]);
  assert.equal(first.total, 1);
  notice.snapshot([row('a', 5)]);
  assert.equal(notice.diff([row('a', 5)]).total, 0);
});

test('reset 之后回到「不许说话」状态', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 1)]);
  notice.reset();
  assert.equal(notice.primed, false);
  assert.equal(notice.diff([row('a', 9)]).total, 0);
});

test('脏数据行被忽略，好行照常比较', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 1), { sessionId: '', messageCount: 3 }, { messageCount: 'x' }, null]);
  const report = notice.diff([row('a', 3), { sessionId: '', messageCount: 9 }, null]);
  assert.equal(report.total, 1);
  assert.equal(report.items[0].sessionId, 'a');
});

test('非数组输入不抛，也不破坏已有基线', () => {
  const notice = createFinishedNotice();
  notice.snapshot([row('a', 1)]);
  assert.equal(notice.diff(null).total, 0);
  assert.equal(notice.diff(undefined).total, 0);
  assert.equal(notice.diff([row('a', 2)]).total, 1);
});

test('formatNotice：单个 / 多个 / 空', () => {
  assert.equal(formatNotice({ total: 0, items: [] }), '');
  assert.equal(formatNotice(null), '');
  assert.equal(
    formatNotice({ total: 1, items: [{ sessionId: 'a', title: '写周报', reason: 'replied', delta: 2 }] }),
    '「写周报」有新回复',
  );
  assert.equal(
    formatNotice({
      total: 3,
      items: [{ sessionId: 'a', title: '写周报', reason: 'replied', delta: 2 }],
    }),
    '3 个会话有新回复（含「写周报」）',
  );
});

test('formatNotice：标题缺失时用「会话」兜底', () => {
  assert.equal(
    formatNotice({ total: 1, items: [{ sessionId: 'a', title: '', reason: 'replied', delta: 1 }] }),
    '「会话」有新回复',
  );
});

console.log(`\n${pass} passed`);
