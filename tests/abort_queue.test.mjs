/* 断线时「停止」的待补发队列：纯单测，不碰 DOM / 连接 / 定时器。
 *
 * 锁的行为：
 *   1. 空队列 peek/take 都是 null、size 是 0；
 *   2. 同一时刻只有一条：重复 push 覆盖旧的并返回 false（第一次返回 true）；
 *   3. take 取走并清空，再 take 得 null；
 *   4. clear 之后什么都没有；
 *   5. 条目原样收、原样给：不转换字段、不补默认值；
 *   6. peek 返回的是入队时那个引用（不复制），改它不会生出一份影子副本。
 */

import assert from 'node:assert/strict';
import { createAbortQueue } from '../web/abort-queue.js';

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

test('空队列：peek / take 都是 null，size 是 0', () => {
  const queue = createAbortQueue();
  assert.equal(queue.peek(), null);
  assert.equal(queue.take(), null);
  assert.equal(queue.size(), 0);
});

test('push 后取得到同一条，重复 push 覆盖旧条目并返回 false', () => {
  const queue = createAbortQueue();
  const first = { sessionPath: 'p-1', sessionId: 's-1', streamId: 'st-1' };
  const second = { sessionPath: 'p-2', sessionId: 's-2', streamId: 'st-2' };

  assert.equal(queue.push(first), true, '队列空时 push 应返回 true（这次新排上）');
  assert.equal(queue.peek(), first, 'peek 应取到刚入队的那一条');
  assert.equal(queue.size(), 1);

  assert.equal(queue.push(second), false, '已有条目时 push 应返回 false（覆盖）');
  assert.equal(queue.peek(), second, '覆盖之后 peek 必须是新条目');
  assert.equal(queue.size(), 1, '覆盖不能把队列撑成两条');
});

test('take 取走并清空，再 take 得 null', () => {
  const queue = createAbortQueue();
  const entry = { sessionPath: 'p-1' };
  queue.push(entry);

  assert.equal(queue.take(), entry, 'take 应返回被取走的那一条');
  assert.equal(queue.peek(), null, 'take 之后队列必须空');
  assert.equal(queue.size(), 0);
  assert.equal(queue.take(), null, '空队列再 take 仍是 null');
});

test('clear 之后 peek 是 null、size 是 0', () => {
  const queue = createAbortQueue();
  queue.push({ sessionPath: 'p-1' });
  queue.clear();
  assert.equal(queue.peek(), null);
  assert.equal(queue.take(), null);
  assert.equal(queue.size(), 0);
});

test('条目原样保留：不转换字段、不补默认值', () => {
  const queue = createAbortQueue();
  const full = { sessionId: 's-1', sessionPath: 'p-1', streamId: 'st-1' };
  queue.push(full);
  assert.deepEqual(queue.peek(), full);

  // 只带 sessionPath：缺的字段不许被补成 null / 空串，取回来还是原样三缺二。
  const minimal = { sessionPath: 'p-2' };
  queue.push(minimal);
  const got = queue.peek();
  assert.deepEqual(got, { sessionPath: 'p-2' });
  assert.equal('sessionId' in got, false, '不能补 sessionId 默认值');
  assert.equal('streamId' in got, false, '不能补 streamId 默认值');
});

test('peek 返回同一引用：改它等于改队列里的那条（不复制）', () => {
  const queue = createAbortQueue();
  const entry = { sessionPath: 'p-1', streamId: 'st-1' };
  queue.push(entry);

  const looked = queue.peek();
  assert.equal(looked, entry, '契约：peek 返回入队时的引用，不是副本');
  looked.streamId = 'st-2';
  assert.equal(queue.peek().streamId, 'st-2', '同引用，所以看得见改动');
  assert.equal(queue.size(), 1, '改字段不改变队列长度');
  assert.equal(queue.take(), entry, '取走的还是同一个对象');
});

test('push 空值等同于 clear()：只认条目，不认空值', () => {
  const queue = createAbortQueue();
  queue.push({ sessionPath: 'p-1' });
  assert.equal(queue.push(null), false);
  assert.equal(queue.peek(), null);
  assert.equal(queue.size(), 0);
});

test('工厂实例互相隔离', () => {
  const left = createAbortQueue();
  const right = createAbortQueue();
  left.push({ sessionPath: 'left' });
  assert.equal(right.peek(), null);
  assert.equal(right.size(), 0);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
