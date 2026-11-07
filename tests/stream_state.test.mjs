/* 解耦流状态回归：独立实例、普通事件游标与 replay 游标契约。 */

import assert from 'node:assert/strict';
import { createStreamState } from '../web/stream-state.js';

const failures = [];
function test(name, run) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

function fresh() {
  return createStreamState();
}

test('初始状态与恢复请求字段', () => {
  const state = fresh();
  assert.deepEqual(state.snapshot(), { streamId: null, lastSeq: 0 });
  assert.deepEqual(state.resumeFields(), { streamId: null, sinceSeq: 0 });
});

test('工厂实例互相隔离', () => {
  const left = fresh();
  const right = fresh();
  left.observe({ streamId: 'left', seq: 7 });
  assert.deepEqual(left.snapshot(), { streamId: 'left', lastSeq: 7 });
  assert.deepEqual(right.snapshot(), { streamId: null, lastSeq: 0 });
});

test('observe 推进同一 stream 的最大 number seq，不倒退', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 7, type: 'text_delta' });
  state.observe({ streamId: 's1', seq: 3, type: 'thinking_delta' });
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 7 });
});

test('observe 换 stream 时清游标，再应用新事件 seq', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 20 });
  state.observe({ streamId: 's2', seq: 4 });
  assert.deepEqual(state.snapshot(), { streamId: 's2', lastSeq: 4 });
});

test('observe 忽略空或非字符串 streamId，但仍推进 number seq', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 2 });
  state.observe({ streamId: '', seq: 5 });
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 5 });
  state.observe({ streamId: 3, seq: 6 });
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 6 });
});

test('普通事件重复 seq 不触发额外的 replay 去重门槛', () => {
  const state = fresh();
  const event = { streamId: 's1', seq: 4, type: 'text_delta', delta: 'x' };
  state.observe(event);
  state.observe({ ...event });
  state.observe({ streamId: 's1', seq: 5, type: 'text_delta', delta: 'y' });
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 5 });
});

test('beginReplay 同 stream 只忽略 envelope 游标字段', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 8 });
  state.beginReplay({ streamId: 's1', seq: 100, nextSeq: 500 });
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 8 });
});

test('beginReplay 换 stream 清游标，不采用外层 seq 或 nextSeq', () => {
  const state = fresh();
  state.observe({ streamId: 'live', seq: 8 });
  state.beginReplay({ streamId: 'replay', seq: 100, nextSeq: 500 });
  assert.deepEqual(state.snapshot(), { streamId: 'replay', lastSeq: 0 });
});

test('acceptReplay 拒绝重复与倒退 seq，允许非连续递增 seq', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 3 });
  assert.equal(state.acceptReplay(3), false);
  assert.equal(state.acceptReplay(2), false);
  assert.equal(state.acceptReplay(6), true, '非连续递增的 replay seq 应被接受');
  assert.equal(state.acceptReplay(5), false);
  assert.equal(state.snapshot().lastSeq, 6);
});

test('acceptReplay 缺失或非 number seq 时允许事件但不推进游标', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 4 });
  assert.equal(state.acceptReplay(undefined), true);
  assert.equal(state.acceptReplay(null), true);
  assert.equal(state.acceptReplay('5'), true);
  assert.equal(state.snapshot().lastSeq, 4);
});

test('snapshot 返回新对象，修改快照不能反写内部状态', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 9 });
  const first = state.snapshot();
  const second = state.snapshot();
  assert.notEqual(first, second);
  first.streamId = 'tampered';
  first.lastSeq = 1000;
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 9 });
});

test('resumeFields 始终反映当前 stream 与 lastSeq', () => {
  const state = fresh();
  state.observe({ streamId: 's1', seq: 9 });
  assert.deepEqual(state.resumeFields(), { streamId: 's1', sinceSeq: 9 });
  state.beginReplay({ streamId: 's2', nextSeq: 200 });
  assert.deepEqual(state.resumeFields(), { streamId: 's2', sinceSeq: 0 });
});

test('有序 replay 完成后 reset 清掉 stream 与游标', () => {
  const state = fresh();
  state.beginReplay({ streamId: 's1', nextSeq: 100 });
  assert.equal(state.acceptReplay(1), true);
  assert.equal(state.acceptReplay(2), true);
  assert.equal(state.acceptReplay(3), true);
  assert.deepEqual(state.snapshot(), { streamId: 's1', lastSeq: 3 });

  state.reset();
  assert.deepEqual(state.snapshot(), { streamId: null, lastSeq: 0 });
  assert.deepEqual(state.resumeFields(), { streamId: null, sinceSeq: 0 });
});

if (failures.length) {
  console.error(`\n${failures.length} stream-state test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
