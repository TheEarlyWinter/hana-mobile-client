/* tests/scroll_memory.test.mjs
 *
 * web/scroll-memory.js 的单测（纯逻辑，无 DOM、无 localStorage 依赖）。
 *
 * 锁的行为：
 * 1. remember / recall：存进去的读数能原样取回，没有记录返回 null；
 * 2. atBottom 判定：scrollHeight - scrollTop - clientHeight < 160 才算贴底；
 * 3. 坏数据：storage 里的 JSON 坏了、形状不对、字段类型不对，一律忽略且不抛；
 * 4. forget / list：逐条删除、列表按时间从新到旧；
 * 5. prune：超过 7 天丢、超过 maxEntries 丢最旧；
 * 6. 节流：同一窗口内多次 remember 只写一次 storage，窗口结束后补写一次最新值；
 *    flush() 立即落盘；
 * 7. clearAll：内存与 storage 一起清空（换账号用）；
 * 8. storage 抛异常（隐私模式 / 配额满）不冒泡，模块退化成仅内存；
 * 9. 同一份 storage 重新建实例能读回上次的位置。
 */

import assert from 'node:assert/strict';
import { createScrollMemory } from '../web/scroll-memory.js';

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 假时钟 / 假 storage                                                  */
/* ------------------------------------------------------------------ */

/** 手动推进的时钟 + 定时器队列：节流用例不真等 400ms。 */
function makeClock(start = 1000) {
  let t = start;
  let timers = [];
  return {
    now: () => t,
    schedule(fn, ms) {
      const timer = { at: t + Math.max(0, Number(ms) || 0), fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule(timer) {
      if (timer) timer.cancelled = true;
    },
    advance(ms) {
      const target = t + Math.max(0, ms);
      // 按到期时间顺序执行；同一时刻多次调度也按注册顺序跑。
      for (let guard = 0; guard < 1000; guard += 1) {
        const due = timers
          .filter((x) => !x.cancelled && x.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = Math.max(t, due.at);
        due.fn();
      }
      t = target;
    },
    pending: () => timers.filter((x) => !x.cancelled).length,
  };
}

function makeStorage({ raw = null, failWrites = false } = {}) {
  const writes = [];
  let current = raw;
  return {
    writes,
    getRaw: () => current,
    getItem() {
      return current;
    },
    setItem(_key, value) {
      if (failWrites) throw new Error('QuotaExceededError');
      writes.push(String(value));
      current = String(value);
    },
    removeItem() {
      current = null;
    },
  };
}

function makeMemory(overrides = {}) {
  const clock = overrides.clock || makeClock();
  const storage = overrides.storage || makeStorage();
  const memory = createScrollMemory({
    storage,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    ...overrides.options,
  });
  return { memory, clock, storage };
}

const pos = (scrollTop, scrollHeight = 1000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

t('remember / recall：存进去的读数原样取回，没记过返回 null', () => {
  const { memory } = makeMemory();
  assert.equal(memory.recall('s1'), null);

  memory.remember('s1', pos(320, 2000, 600));
  const got = memory.recall('s1');
  assert.ok(got, '记过之后必须能取回');
  assert.equal(got.scrollTop, 320);
  assert.equal(got.atBottom, false, '2000 - 320 - 600 = 1080，不算贴底');
  assert.equal(memory.recall('s2'), null, '别的会话不能串味');
});

t('atBottom：差值 < 160 才算贴底（159 是，160 不是）', () => {
  const { memory } = makeMemory();
  memory.remember('true', pos(241));   // 1000 - 241 - 600 = 159
  memory.remember('false', pos(240));  // 1000 - 240 - 600 = 160
  memory.remember('bottom', pos(400)); // = 0
  memory.remember('over', pos(430));   // 负数（惯性滚动）也是贴底

  assert.equal(memory.recall('true').atBottom, true);
  assert.equal(memory.recall('false').atBottom, false);
  assert.equal(memory.recall('bottom').atBottom, true);
  assert.equal(memory.recall('over').atBottom, true);
});

t('坏数据：storage 里的 JSON 坏了 / 形状不对时忽略，不抛异常', () => {
  for (const raw of ['{not json', '{"entries":1}', '42', '"text"', 'null', '[]']) {
    const { memory } = makeMemory({ storage: makeStorage({ raw }) });
    assert.equal(memory.recall('anything'), null, `坏数据 ${raw} 不能变成记录`);
    // 坏数据之后仍要能正常写入
    memory.remember('ok', pos(10));
    assert.equal(memory.recall('ok').scrollTop, 10);
  }
});

t('坏数据：数组里混着坏项时只丢坏项，好项照常恢复', () => {
  const raw = JSON.stringify([
    null,
    7,
    'x',
    { key: '' },
    { key: 'bad-top', scrollTop: 'abc', ts: 1000 },
    { key: 'bad-ts', scrollTop: 10 },
    { key: 'good', scrollTop: 321, atBottom: false, ts: 1000 },
  ]);
  const { memory } = makeMemory({ storage: makeStorage({ raw }) });
  assert.equal(memory.recall('bad-top'), null);
  assert.equal(memory.recall('bad-ts'), null);
  assert.deepEqual(
    { scrollTop: memory.recall('good').scrollTop, atBottom: memory.recall('good').atBottom },
    { scrollTop: 321, atBottom: false },
  );
  assert.equal(memory.list().length, 1);
});

t('坏入参：key 为空 / 读数不是对象 / 数字是 NaN 都不抛', () => {
  const { memory } = makeMemory();
  assert.doesNotThrow(() => {
    memory.remember('', pos(1));
    memory.remember(null, pos(1));
    memory.remember('x', null);
    memory.remember('y', { scrollTop: NaN, scrollHeight: undefined, clientHeight: 'x' });
  });
  assert.equal(memory.recall(''), null);
  assert.equal(memory.recall('x'), null);
  // 读数字段坏了按 0 处理，仍然记下一条可用记录
  assert.equal(memory.recall('y').scrollTop, 0);
});

t('forget：只删指定会话；list 按时间从新到旧', () => {
  const { memory, clock } = makeMemory();
  memory.remember('a', pos(10));
  clock.advance(10);
  memory.remember('b', pos(20));

  const keys = memory.list().map((e) => e.key);
  assert.deepEqual(keys, ['b', 'a'], 'list 最新在前');
  assert.equal(memory.forget('a'), true);
  assert.equal(memory.forget('a'), false, '重复 forget 返回 false');
  assert.deepEqual(memory.list().map((e) => e.key), ['b']);
});

t('prune：超过 7 天的记录丢掉，新的保留', () => {
  const clock = makeClock(1_000_000);
  const { memory } = makeMemory({ clock });
  memory.remember('old', pos(10));
  clock.advance(8 * 24 * 60 * 60 * 1000);

  assert.equal(memory.prune(clock.now()), 1, '8 天前的记录要丢掉');
  assert.equal(memory.recall('old'), null);

  memory.remember('new', pos(20));
  assert.equal(memory.prune(clock.now()), 0, '新记录不能被误删');
  assert.equal(memory.recall('new').scrollTop, 20);
});

t('prune：超过 maxEntries 丢最旧，默认上限 50', () => {
  const { memory, clock } = makeMemory({ options: { maxEntries: 5 } });
  for (let i = 0; i < 8; i += 1) {
    memory.remember(`k${i}`, pos(i));
    clock.advance(1);
  }
  assert.equal(memory.list().length, 5, '上限之外的最旧记录要被丢掉');
  assert.deepEqual(memory.list().map((e) => e.key), ['k7', 'k6', 'k5', 'k4', 'k3']);
  memory.prune(clock.now());
  assert.equal(memory.list().length, 5, 'prune 不误删仍在窗口内的记录');
});

t('节流：窗口内多次 remember 只写一次 storage，窗口结束后补写最新值', () => {
  const { memory, clock, storage } = makeMemory({ options: { throttleMs: 400 } });

  memory.remember('s', pos(10));
  assert.equal(storage.writes.length, 1, '第一次立即落盘');
  clock.advance(100);
  memory.remember('s', pos(20));
  memory.remember('s', pos(30));
  memory.remember('s', pos(40));
  assert.equal(storage.writes.length, 1, '400ms 窗口内不许反复写 storage');
  assert.equal(memory.recall('s').scrollTop, 40, '内存里的读数必须立即是最新的');

  clock.advance(400);
  assert.equal(storage.writes.length, 2, '窗口结束后把最新值补写一次');
  const persisted = JSON.parse(storage.getRaw());
  assert.equal(persisted.find((e) => e.key === 's').scrollTop, 40, '补写的是最后一次读数');
  assert.equal(clock.pending(), 0, '补写之后不能再挂着定时器');
});

t('flush：立即落盘并取消待写定时器', () => {
  const { memory, clock, storage } = makeMemory({ options: { throttleMs: 400 } });
  memory.remember('s', pos(1));
  clock.advance(10);
  memory.remember('s', pos(2));
  assert.equal(storage.writes.length, 1);
  memory.flush();
  assert.equal(storage.writes.length, 2, 'flush 立刻写');
  assert.equal(clock.pending(), 0, 'flush 后没有残留定时器');
  clock.advance(1000);
  assert.equal(storage.writes.length, 2, '取消掉的补写不能再触发');
});

t('clearAll：内存与 storage 一起清空，定时器也收掉', () => {
  const { memory, clock, storage } = makeMemory({ options: { throttleMs: 400 } });
  memory.remember('a', pos(1));
  memory.remember('b', pos(2));
  clock.advance(10);
  memory.remember('b', pos(3)); // 落进节流窗口，挂一个待写定时器

  memory.clearAll();
  assert.deepEqual(memory.list(), []);
  assert.equal(memory.recall('a'), null);
  assert.equal(storage.getRaw(), null, 'storage 里的记录也要删');
  assert.equal(clock.pending(), 0, 'clearAll 之后不能再补写旧数据');

  clock.advance(1000);
  assert.equal(storage.getRaw(), null, '旧定时器不能把清空的记录写回来');
});

t('storage 抛异常（隐私模式 / 配额满）：不冒泡，退化成仅内存', () => {
  const { memory } = makeMemory({ storage: makeStorage({ failWrites: true }) });
  assert.doesNotThrow(() => memory.remember('a', pos(5)));
  assert.equal(memory.recall('a').scrollTop, 5);
  assert.doesNotThrow(() => memory.clearAll());
});

t('持久化：同一份 storage 重建实例能读回上次的位置', () => {
  const clock = makeClock();
  const storage = makeStorage();
  const first = createScrollMemory({
    storage,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });
  first.remember('persisted', pos(777, 2000, 600));
  first.flush();

  const second = createScrollMemory({
    storage,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });
  const got = second.recall('persisted');
  assert.equal(got.scrollTop, 777);
  assert.equal(got.atBottom, false);
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
