/* 「这条回显是不是我刚发的」：纯单测，不碰 DOM / 连接 / 定时器。
 *
 * 锁的行为（对应 web/echo-guard.js 的公开接口）：
 *   1. noteSent 记 id，takeEcho 核销一次就删掉，再核销返回 false；
 *   2. 最多记 32 条，超了丢最老的（34 条后最老两条不在、最新一条在）；
 *   3. matchesRecent 只认「记过之后、同文本、5 秒内」，窗口边界与老判断一致（< 5000）；
 *   4. backing 模式：读写落在 backing.sentInputs / backing.lastLocalUser 上；
 *   5. reset 两份一起清空；
 *   6. 两个无 backing 的实例互不影响。
 */

import assert from 'node:assert/strict';
import { createEchoGuard } from '../web/echo-guard.js';

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

test('noteSent 记 id，takeEcho 只核销一次', () => {
  const echo = createEchoGuard();
  echo.noteSent('in-1', '第一条');

  assert.equal(echo.ids.has('in-1'), true, 'noteSent 之后 ids 里要有这个 id');
  assert.equal(echo.ids.size, 1);

  assert.equal(echo.takeEcho('in-1'), true, '第一次核销要吃掉这条回显');
  assert.equal(echo.ids.size, 0, '核销之后 id 必须删掉');
  assert.equal(echo.ids.has('in-1'), false);
  assert.equal(echo.takeEcho('in-1'), false, '同一条回显再来就认不出来了');
});

test('takeEcho 对空 id / 非字符串一律 false（没记过的不可能命中）', () => {
  const echo = createEchoGuard();
  echo.noteSent('in-2', '第二条');

  assert.equal(echo.takeEcho(''), false);
  assert.equal(echo.takeEcho(undefined), false);
  assert.equal(echo.takeEcho(null), false);
  assert.equal(echo.takeEcho(123), false);
  assert.equal(echo.ids.has('in-2'), true, '空/非字符串的探测不能顺手删掉别的 id');
});

test('超过 32 条丢最老的：34 条之后最老两条不在、最新一条在', () => {
  const echo = createEchoGuard();
  for (let i = 1; i <= 34; i += 1) echo.noteSent(`in-${i}`, `第 ${i} 条`, 1000 + i);

  assert.equal(echo.ids.size, 32, '上限 32 条');
  assert.equal(echo.ids.has('in-1'), false, '最老的一条要被挤出去');
  assert.equal(echo.ids.has('in-2'), false, '第二老的也要被挤出去');
  assert.equal(echo.ids.has('in-3'), true, '第 3 条还在');
  assert.equal(echo.ids.has('in-34'), true, '最新一条必须在');

  // 被挤出去的 id 的迟到回显不该再被吞掉（宁可在屏上画出来，也不能静默丢掉别人的消息）。
  assert.equal(echo.takeEcho('in-1'), false);
  assert.equal(echo.takeEcho('in-34'), true);
});

test('matchesRecent：记过之后、同文本、5 秒内才算', () => {
  const echo = createEchoGuard();

  // 没记过任何发送：怎么比对都不算。
  assert.equal(echo.matchesRecent('刚发的', 1000), false, '还没 noteSent 就不能命中');

  echo.noteSent('in-9', '刚发的', 1000);
  assert.equal(echo.matchesRecent('刚发的', 1000), true, '刚记完立刻比对：命中');
  assert.equal(echo.matchesRecent('刚发的', 5999), true, '4.999 秒仍在窗口内');
  assert.equal(echo.matchesRecent('刚发的', 6000), false, '正好 5 秒出窗口（与旧判断 < 5000 一致）');
  assert.equal(echo.matchesRecent('刚发的', 4999), true, '4.999 秒（另一侧边界）仍在窗口内');
  assert.equal(echo.matchesRecent('别的话', 1000), false, '文本不同不算自己发的');

  // 每次发送整条换掉：上一条的文本不再命中。
  echo.noteSent('in-10', '第二条', 20000);
  assert.equal(echo.matchesRecent('刚发的', 20000), false, '上一条发送已经被换掉');
  assert.equal(echo.matchesRecent('第二条', 20000), true);

  // 窗口可传：默认 5 秒，显式给值就按给的算。
  assert.equal(echo.matchesRecent('第二条', 20499, 500), true);
  assert.equal(echo.matchesRecent('第二条', 20500, 500), false);
  assert.equal(echo.matchesRecent('第二条', 24999), true, '默认窗口仍是 5000ms');
  assert.equal(echo.matchesRecent('第二条', 25000), false);
});

test('backing 模式：读写落在 backing 的 sentInputs / lastLocalUser 上', () => {
  const backing = { sentInputs: new Set(), lastLocalUser: null };
  const echo = createEchoGuard(backing);

  echo.noteSent('in-b', '带 backing 的', 5000);
  assert.equal(backing.sentInputs.size, 1, 'id 要写进 backing.sentInputs');
  assert.equal(backing.sentInputs.has('in-b'), true);
  assert.deepEqual(backing.lastLocalUser, { text: '带 backing 的', at: 5000 }, '最近一次发送要写回 backing');
  assert.equal(echo.ids, backing.sentInputs, 'ids 就是 backing 那份 Set，不是副本');
  assert.equal(echo.lastLocalUser, backing.lastLocalUser);

  assert.equal(echo.takeEcho('in-b'), true);
  assert.equal(backing.sentInputs.size, 0, '核销删除的也是 backing 那份');

  // 老单测的写法：直接改 state 上的两份，这个实例立刻看得见。
  backing.sentInputs.add('manual');
  assert.equal(echo.takeEcho('manual'), true, '外面 add 进去的 id 也要能被核销');

  backing.lastLocalUser = { text: '外面写的', at: 6000 };
  assert.equal(echo.matchesRecent('外面写的', 6000), true);
  assert.equal(echo.matchesRecent('外面写的', 11000), false);

  // backing 上还没有这两个字段时按需补，不能抛。
  const bare = {};
  const bareEcho = createEchoGuard(bare);
  bareEcho.noteSent('in-c', '裸 state', 7000);
  assert.equal(bare.sentInputs instanceof Set, true);
  assert.equal(bare.sentInputs.has('in-c'), true);
  assert.deepEqual(bare.lastLocalUser, { text: '裸 state', at: 7000 });
});

test('reset 清空 ids 与 lastLocalUser（backing 也一起清）', () => {
  const echo = createEchoGuard();
  echo.noteSent('in-r', '要清掉的', 1000);
  echo.reset();
  assert.equal(echo.ids.size, 0, 'reset 之后 ids 必须空');
  assert.equal(echo.lastLocalUser, null, 'reset 之后没有「最近一次发送」');
  assert.equal(echo.matchesRecent('要清掉的', 1000), false);
  assert.equal(echo.takeEcho('in-r'), false);

  // backing 模式：清的是 backing 那份（同一个 Set 原地 clear，持有引用的人照样看得见）。
  const backing = { sentInputs: new Set(), lastLocalUser: null };
  const guarded = createEchoGuard(backing);
  const sameSet = backing.sentInputs;
  guarded.noteSent('in-rb', '要清掉的', 2000);
  guarded.reset();
  assert.equal(backing.sentInputs, sameSet, 'reset 不能换掉 backing 的 Set 引用');
  assert.equal(backing.sentInputs.size, 0);
  assert.equal(backing.lastLocalUser, null);
});

test('两个无 backing 的实例互不影响', () => {
  const left = createEchoGuard();
  const right = createEchoGuard();

  left.noteSent('in-left', '左边发的', 1000);
  assert.equal(left.ids.size, 1);
  assert.equal(right.ids.size, 0, '右边不能看见左边的 id');
  assert.equal(right.lastLocalUser, null, '右边不能看见左边的发送');
  assert.equal(right.matchesRecent('左边发的', 1000), false);
  assert.equal(right.takeEcho('in-left'), false);

  right.noteSent('in-left', '右边也发同一条 id', 1001);
  assert.equal(left.takeEcho('in-left'), true, '左边核销的是自己那份');
  assert.equal(right.ids.size, 1, '右边的同 id 不受影响');
});

if (failures.length > 0) {
  console.log(`\n${failures.length} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
