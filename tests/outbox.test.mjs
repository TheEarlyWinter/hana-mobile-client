/* tests/outbox.test.mjs
 *
 * web/outbox.js 单元测试（纯模块，不碰 DOM、不真等待）：
 * 1. enqueue 返回稳定 id，list() 能看到状态与 attempts；
 * 2. 成功即出队；失败必须留在队列里，绝不假装成功；
 * 3. 失败按退避记下 nextAttemptAt，且退避时间递增；
 * 4. 达到 maxAttempts 转 failed 并保留，不会被 flush 自动重发；
 * 5. retry(id) 重置为待发并立即尝试；
 * 6. flush 并发调用复用同一次，同一条消息只发一次；
 * 7. 重启（新实例 + 同一份 storage）后未完成条目还在；
 * 8. 损坏的持久化数据不影响启动。
 *
 * 时钟用注入的 now()，退避等待用注入的 sleep(ms)，全程不碰真实定时器。
 */

import assert from 'node:assert/strict';
import {
  createOutbox,
  OUTBOX_STORAGE_KEY,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAYS,
} from '../web/outbox.js';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ---------------------------- 测试夹具 ---------------------------- */

function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(value) {
      current = value;
    },
  };
}

/** 按脚本逐次决定成败的假发送器：'ok' / 'fail' / 'reject' / Error 实例。 */
function createScriptedSender(script = []) {
  const calls = [];
  const queue = script.slice();
  async function send(payload) {
    calls.push(payload);
    const step = queue.length > 0 ? queue.shift() : 'ok';
    if (step instanceof Error) throw step;
    if (step === 'fail') throw new Error('network down');
    if (step === 'reject') return false;
    return { ok: true };
  }
  return { send, calls };
}

/** 等微任务跑完，让 flush 里的 send 真正被调用。 */
function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

console.log('outbox 测试');

/* ---------------------------- 用例 ---------------------------- */

await t('导出常量符合约定', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 6);
  assert.deepEqual([...DEFAULT_RETRY_DELAYS], [1000, 2000, 4000, 8000, 16000, 32000]);
});

await t('enqueue 返回稳定 id，list() 能看到待发条目', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send } = createScriptedSender();
  const outbox = createOutbox({ send, storage, now: clock.now });

  const id1 = outbox.enqueue({
    sessionKey: 'session:/a#1',
    text: '你好',
    attachments: [{ mimeType: 'image/png', data: 'AAA' }],
  });
  const id2 = outbox.enqueue({ sessionKey: 'session:/b#2', text: '第二条' });

  assert.equal(typeof id1, 'string');
  assert.ok(id1.length > 0);
  assert.notEqual(id1, id2, '两条消息的 id 必须不同');

  const list = outbox.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, id1);
  assert.equal(list[1].id, id2);
  assert.equal(list[0].text, '你好');
  assert.equal(list[0].sessionKey, 'session:/a#1');
  assert.deepEqual(list[0].attachments, [{ mimeType: 'image/png', data: 'AAA' }]);
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].attempts, 0);
  assert.ok(list[0].nextAttemptAt <= clock.now(), '刚入队应立即可发');

  // id 稳定：多次读取不变
  assert.equal(outbox.list()[0].id, id1);

  // 返回的是快照
  list[0].text = '被外部改掉';
  assert.equal(outbox.list()[0].text, '你好');
});

await t('发送成功即出队', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender();
  const outbox = createOutbox({ send, storage, now: clock.now });

  outbox.enqueue({ sessionKey: 's', text: '会成功的消息' });
  const summary = await outbox.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(summary.sent.length, 1);
  assert.deepEqual(outbox.list(), [], '发成功必须从队列移除');
});

await t('首次失败留在队列：attempts=1、状态 pending、记下退避时间', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['fail']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 3,
    retryDelays: [1000, 2000],
  });

  const id = outbox.enqueue({ sessionKey: 's', text: '会失败的消息' });
  const failedAt = clock.now();
  const summary = await outbox.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(summary.sent, [], '失败不能算发送成功');
  assert.deepEqual(summary.failed, [], '还没到上限，不能直接判死');

  const list = outbox.list();
  assert.equal(list.length, 1, '失败的消息必须留在队列里');
  assert.equal(list[0].id, id);
  assert.equal(list[0].status, 'pending', '还有重试机会，状态是待发');
  assert.equal(list[0].attempts, 1);
  assert.equal(list[0].nextAttemptAt, failedAt + 1000, '按第一档退避安排在何时重试');
  assert.equal(list[0].lastError, 'network down');
});

await t('退避时间递增，且未到期的条目不会被提前重试', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['fail', 'fail']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 5,
    retryDelays: [1000, 3000],
  });

  outbox.enqueue({ sessionKey: 's', text: '连续失败' });
  await outbox.flush();

  const firstGap = outbox.list()[0].nextAttemptAt - clock.now();
  await outbox.flush();
  assert.equal(calls.length, 1, '还没到 nextAttemptAt，不允许重试');

  clock.advance(firstGap);
  await outbox.flush();
  const second = outbox.list()[0];
  const secondGap = second.nextAttemptAt - clock.now();

  assert.equal(calls.length, 2);
  assert.equal(second.attempts, 2);
  assert.ok(secondGap > firstGap, `退避必须递增：${firstGap} → ${secondGap}`);
});

await t('达到 maxAttempts 转 failed 并保留，不再自动重发', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const calls = [];
  const alwaysFail = async (payload) => {
    calls.push(payload);
    throw new Error('一直失败');
  };

  const outbox = createOutbox({
    send: alwaysFail,
    storage,
    now: clock.now,
    maxAttempts: 3,
    retryDelays: [1000, 2000],
  });

  const id = outbox.enqueue({ sessionKey: 's', text: '注定失败' });

  for (let i = 0; i < 3; i += 1) {
    await outbox.flush();
    clock.advance(5000); // 推到任何退避都到期
  }

  const list = outbox.list();
  assert.equal(calls.length, 3, `最多尝试 ${3} 次，实际 ${calls.length}`);
  assert.equal(list.length, 1, 'failed 的消息不能丢，要留给人看');
  assert.equal(list[0].id, id);
  assert.equal(list[0].status, 'failed');
  assert.equal(list[0].attempts, 3);

  // 再 flush 也不会自动重发
  const before = calls.length;
  await outbox.flush();
  clock.advance(10 * 60 * 1000);
  await outbox.flush();
  assert.equal(calls.length, before, 'failed 后不再自动重发，必须等人工 retry');
  assert.equal(outbox.list()[0].status, 'failed');
});

await t('retry(id) 把 failed 重置为待发并立即尝试', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['fail', 'fail', 'ok']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 2,
    retryDelays: [1000],
  });

  const id = outbox.enqueue({ sessionKey: 's', text: '手动重试' });
  await outbox.flush(); // 第 1 次失败
  clock.advance(1000);
  await outbox.flush(); // 第 2 次失败 → failed
  assert.equal(outbox.list()[0].status, 'failed');
  assert.equal(calls.length, 2);

  const result = await outbox.retry(id);
  assert.equal(result.ok, true);
  assert.equal(result.sent, true, 'retry 后应立即把这条发出去');
  assert.equal(calls.length, 3);
  assert.deepEqual(outbox.list(), [], '成功后出队');
});

await t('retry(id) 再次失败时留在队列并重置 attempts', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['fail', 'fail', 'fail']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 2,
    retryDelays: [1000],
  });

  const id = outbox.enqueue({ sessionKey: 's', text: '重试仍失败' });
  await outbox.flush();
  clock.advance(1000);
  await outbox.flush();
  assert.equal(outbox.list()[0].status, 'failed');

  const result = await outbox.retry(id);
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(calls.length, 3);

  const item = outbox.list()[0];
  assert.equal(item.status, 'pending', '重试失败后回到 pending，等着下一轮');
  assert.equal(item.attempts, 1, 'retry 重置计数，这一轮只算一次失败');
});

await t('retry 未知 id 返回 ok:false，不抛异常', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender();
  const outbox = createOutbox({ send, storage, now: clock.now });

  const result = await outbox.retry('不存在-id');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-found');
  assert.equal(calls.length, 0);
});

await t('flush 并发调用复用同一次，同一条消息只发一次', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const calls = [];
  let release;
  const send = (payload) => {
    calls.push(payload);
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  const outbox = createOutbox({ send, storage, now: clock.now });
  outbox.enqueue({ sessionKey: 's', text: '只发一次' });

  const first = outbox.flush();
  const second = outbox.flush();
  assert.equal(first, second, '并发 flush 必须返回同一次运行');

  await nextTick();
  assert.equal(calls.length, 1, '并发 flush 不能把同一条发两遍');
  assert.equal(outbox.list()[0].status, 'sending', '发送过程中状态是 sending');

  release({ ok: true });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b, '两次调用拿到同一份结果');
  assert.equal(a.sent.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(outbox.list(), []);

  // 跑完之后还能再开新一轮
  outbox.enqueue({ sessionKey: 's', text: '第二条' });
  const third = outbox.flush();
  assert.notEqual(third, first, '上一轮结束后必须能重新发起');
  await nextTick();
  release({ ok: true });
  await third;
  assert.deepEqual(outbox.list(), []);
});

await t('按加入顺序逐条发送', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const sent = [];
  const send = async (payload) => {
    sent.push(payload.text);
    return { ok: true };
  };
  const outbox = createOutbox({ send, storage, now: clock.now });

  outbox.enqueue({ sessionKey: 's', text: '第一条' });
  outbox.enqueue({ sessionKey: 's', text: '第二条' });
  outbox.enqueue({ sessionKey: 's', text: '第三条' });

  await outbox.flush();
  assert.deepEqual(sent, ['第一条', '第二条', '第三条']);
});

await t('一条失败不影响后面的消息发出（不堵队头）', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['fail']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 3,
    retryDelays: [1000],
  });

  outbox.enqueue({ sessionKey: 's', text: '会失败的第一条' });
  outbox.enqueue({ sessionKey: 's', text: '会成功的第二条' });

  const summary = await outbox.flush();
  assert.equal(calls.length, 2, '两条都要尝试');
  assert.equal(summary.sent.length, 1);
  const list = outbox.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '会失败的第一条');
});

await t('send 返回 false（而不是抛错）同样算失败', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send, calls } = createScriptedSender(['reject']);
  const outbox = createOutbox({ send, storage, now: clock.now });

  outbox.enqueue({ sessionKey: 's', text: '被拒收' });
  await outbox.flush();

  assert.equal(calls.length, 1);
  const list = outbox.list();
  assert.equal(list.length, 1, 'resolve(false) 不能被当成发送成功');
  assert.equal(list[0].attempts, 1);
  assert.equal(list[0].status, 'pending');
});

await t('send 抛错时 flush 不炸，返回摘要', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const send = async () => {
    throw new Error('socket closed');
  };
  const outbox = createOutbox({ send, storage, now: clock.now });

  outbox.enqueue({ sessionKey: 's', text: '连接断了' });
  const summary = await outbox.flush();

  assert.deepEqual(summary.sent, []);
  assert.equal(summary.remaining, 1);
  assert.equal(outbox.list()[0].lastError, 'socket closed');
});

await t('重启（新实例 + 同一份 storage）后未完成条目还在', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();

  const first = createOutbox({
    send: createScriptedSender(['fail']).send,
    storage,
    now: clock.now,
    maxAttempts: 5,
    retryDelays: [1000],
  });
  const id = first.enqueue({
    sessionKey: 'session:/a#1',
    text: '重启前没发出去',
    attachments: [{ mimeType: 'image/png', data: 'AAA' }],
  });
  first.enqueue({ sessionKey: 'session:/b#2', text: '这条会成功' });
  await first.flush(); // 第一条失败，第二条成功

  const restoredSender = createScriptedSender([]);
  const second = createOutbox({
    send: restoredSender.send,
    storage,
    now: clock.now,
    maxAttempts: 5,
    retryDelays: [1000],
  });

  const restored = second.list();
  assert.equal(restored.length, 1, '重启后未完成的条目必须还在');
  assert.equal(restored[0].id, id, 'id 要稳定，重启后还是同一个');
  assert.equal(restored[0].text, '重启前没发出去');
  assert.equal(restored[0].sessionKey, 'session:/a#1');
  assert.deepEqual(restored[0].attachments, [{ mimeType: 'image/png', data: 'AAA' }]);
  assert.equal(restored[0].status, 'pending');
  assert.equal(restored[0].attempts, 1);
  assert.equal(restored[0].lastError, 'network down');

  clock.advance(1000);
  await second.flush();
  assert.equal(restoredSender.calls.length, 1, '重启后接着把队列发完');
  assert.deepEqual(second.list(), []);
});

await t('重启时把残留的 sending 当作待发，不能丢消息', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  let release;
  const send = () =>
    new Promise((resolve) => {
      release = resolve;
    });

  const first = createOutbox({ send, storage, now: clock.now });
  first.enqueue({ sessionKey: 's', text: '发到一半崩溃' });
  const running = first.flush();
  await nextTick();

  const second = createOutbox({ send: async () => ({ ok: true }), storage, now: clock.now });
  const restored = second.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, 'pending', '重启后 sending 必须回落成 pending');

  release({ ok: true });
  await running;
});

await t('损坏的持久化数据不影响启动', async () => {
  const clock = createFakeClock();

  const cases = [
    ['非 JSON', '{这不是 JSON'],
    ['顶层是数组', '[]'],
    ['items 不是数组', '{"version":1,"items":{"a":1}}'],
    ['items 为 null', '{"version":1,"items":null}'],
  ];

  for (const [label, raw] of cases) {
    const storage = createMemoryStorage({ [OUTBOX_STORAGE_KEY]: raw });
    const outbox = createOutbox({ send: async () => ({ ok: true }), storage, now: clock.now });
    assert.deepEqual(outbox.list(), [], `${label}：队列应为空`);
    assert.equal(storage.getItem(OUTBOX_STORAGE_KEY), null, `${label}：脏数据必须被清除`);
  }
});

await t('单条结构不对只丢这一条，其余仍然能发', async () => {
  const clock = createFakeClock(1_700_000_000_000);
  const raw = JSON.stringify({
    version: 1,
    items: [
      { id: 'bad-1', text: 42, status: 'pending' },
      { id: 'bad-2' },
      'not an object',
      {
        id: 'good-1',
        sessionKey: 's',
        text: '好的消息',
        attachments: [],
        status: 'pending',
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 2,
        lastError: null,
      },
    ],
  });
  const storage = createMemoryStorage({ [OUTBOX_STORAGE_KEY]: raw });
  const sent = [];
  const outbox = createOutbox({
    send: async (payload) => {
      sent.push(payload.text);
      return { ok: true };
    },
    storage,
    now: clock.now,
  });

  const list = outbox.list();
  assert.equal(list.length, 1, '坏条目被丢弃');
  assert.equal(list[0].id, 'good-1');
  assert.equal(list[0].attempts, 1, '已有的重试次数要保留');

  await outbox.flush();
  assert.deepEqual(sent, ['好的消息']);
  assert.deepEqual(outbox.list(), []);
});

await t('storage 写不进去时，队列在内存里照常工作', async () => {
  const clock = createFakeClock();
  const storage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {},
  };
  const { send, calls } = createScriptedSender(['fail', 'ok']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 3,
    retryDelays: [1000],
  });

  const id = outbox.enqueue({ sessionKey: 's', text: '写不进存储' });
  assert.equal(outbox.list().length, 1, '内存队列必须还在');

  await outbox.flush();
  assert.equal(outbox.list()[0].id, id);
  clock.advance(1000);
  await outbox.flush();
  assert.equal(calls.length, 2, '存储坏掉不能阻断重试');
  assert.deepEqual(outbox.list(), []);
});

await t('flush({ wait: true }) 用注入的 sleep 等到期再重试', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const slept = [];
  const sleep = async (ms) => {
    slept.push(ms);
    clock.advance(ms);
  };
  const { send, calls } = createScriptedSender(['fail', 'fail', 'ok']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    sleep,
    maxAttempts: 4,
    retryDelays: [1000, 2000, 4000],
  });

  outbox.enqueue({ sessionKey: 's', text: '等退避后再发' });
  const summary = await outbox.flush({ wait: true });

  assert.deepEqual(slept, [1000, 2000], '等待时长应为两档退避，全程没有真实等待');
  assert.equal(calls.length, 3);
  assert.equal(summary.sent.length, 1);
  assert.deepEqual(outbox.list(), []);
});

await t('flush({ wait: true }) 在达到上限后停下，不会无限重试', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const slept = [];
  const sleep = async (ms) => {
    slept.push(ms);
    clock.advance(ms);
  };
  let attempts = 0;
  const send = async () => {
    attempts += 1;
    throw new Error('永远失败');
  };
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    sleep,
    maxAttempts: 3,
    retryDelays: [100, 200],
  });

  outbox.enqueue({ sessionKey: 's', text: '等不到成功' });
  const summary = await outbox.flush({ wait: true });

  assert.equal(attempts, 3);
  assert.deepEqual(slept, [100, 200]);
  assert.equal(summary.remaining, 1);
  assert.equal(outbox.list()[0].status, 'failed');
});

await t('空队列 flush 返回空摘要', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const outbox = createOutbox({ send: async () => ({ ok: true }), storage, now: clock.now });

  const summary = await outbox.flush();
  assert.deepEqual(summary.sent, []);
  assert.deepEqual(summary.failed, []);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.nextDueAt, null);
});

await t('nextDueAt() 告诉装配层什么时候该再 flush', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const { send } = createScriptedSender(['fail']);
  const outbox = createOutbox({
    send,
    storage,
    now: clock.now,
    maxAttempts: 3,
    retryDelays: [4000],
  });

  assert.equal(outbox.nextDueAt(), null, '空队列没有待办');

  outbox.enqueue({ sessionKey: 's', text: '会失败' });
  assert.equal(outbox.nextDueAt(), clock.now(), '刚入队应当立刻可以发');

  await outbox.flush();
  assert.equal(outbox.nextDueAt(), clock.now() + 4000, '失败后给出下次可发时间');
});

await t('持久化的 JSON 结构稳定（版本号 + items 数组）', async () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const outbox = createOutbox({ send: async () => ({ ok: true }), storage, now: clock.now });

  const id = outbox.enqueue({ sessionKey: 'sk', text: '结构检查' });
  const raw = storage.getItem(OUTBOX_STORAGE_KEY);
  assert.equal(typeof raw, 'string', '必须落盘');

  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.items));
  assert.equal(parsed.items.length, 1);

  const item = parsed.items[0];
  assert.equal(item.id, id);
  assert.equal(item.sessionKey, 'sk');
  assert.equal(item.text, '结构检查');
  assert.deepEqual(item.attachments, []);
  assert.equal(item.status, 'pending');
  assert.equal(item.attempts, 0);
  assert.equal(typeof item.createdAt, 'number');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
