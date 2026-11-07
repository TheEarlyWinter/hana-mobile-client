/* web/feed/read-tracker.js 契约测试
 *
 * 只替换 IntersectionObserver / document / 时钟 / 发送函数：不启动服务、不开浏览器、
 * 不读真实 feed 或日志。覆盖：IO 相交门槛、长卡可见、0/599/600ms、批量新卡挂载生命周期、document 隐藏与关闭取消、
 * ready/active 门禁、失败不伪装已读且不自动重试、每 revision 只结算一次、reset/destroy
 * 释放、缺少 IntersectionObserver 不崩也不伪造曝光、LAN HTTP 下 crypto 不可用时的事件 ID。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createFeedReadTracker } from '../web/feed/read-tracker.js';

const ID_A = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'fi_ZYXWVTSRQPNMKJHGFEDCBA9876';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const START = 1762300000000;

let bad = 0;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeItem(itemId, revision = 1) {
  return { itemId, revision };
}

/** 受控时钟：advance 时按到期顺序跑 setTimeout 回调。 */
function createClock() {
  let now = START;
  let next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next;
      next += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
    size: () => timers.size,
  };
}

function setup({ visibility = 'visible', ioClass } = {}) {
  const h = createHarness({ debug: false });
  h.doc.visibilityState = visibility;
  const makeNode = h.makeNode.bind(h);
  h.makeNode = (...args) => {
    const element = makeNode(...args);
    // 这些用例把节点作为已挂载的卡片使用；未挂载批次会显式覆盖为 false。
    element.isConnected = true;
    return element;
  };
  const clock = createClock();
  const sent = [];
  const reads = [];
  const ioInstances = [];
  let sendImpl = null;

  class FakeIO {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.disconnected = false;
      ioInstances.push(this);
    }

    observe(element) {
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }

    fire(entries) {
      this.callback(
        entries.map(([target, ratio]) => ({
          target,
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
        })),
      );
    }
  }

  const Observer = ioClass === undefined ? FakeIO : ioClass;
  const options = {
    document: h.doc,
    sendSignals: async (signals) => {
      sent.push(signals);
      if (sendImpl) return sendImpl(signals);
      return { accepted: signals.length, unreadTaskCount: 0 };
    },
    onRead: (itemId, revision) => reads.push([itemId, revision]),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  if (Observer !== undefined) options.IntersectionObserver = Observer;
  const tracker = createFeedReadTracker(options);

  return {
    h,
    clock,
    sent,
    reads,
    tracker,
    ioInstances,
    lastIO: () => ioInstances[ioInstances.length - 1],
    setSend: (fn) => {
      sendImpl = fn;
    },
  };
}

async function readOnce(s) {
  const element = s.h.makeNode('div');
  const item = makeItem(ID_A, 3);
  s.tracker.setActive(true);
  s.tracker.observe(element, item, { slateId: 'slate-1', position: 2 });
  s.tracker.markReady(ID_A, 3);
  s.lastIO().fire([[element, 0.8]]);
  assert.equal(s.clock.size(), 1, '可见且 ready 后应有一个 600ms 计时器');
  s.clock.advance(600);
  await tick();
  return { element, item };
}

/* ---- 可见与计时 ---- */

t('长卡超过两倍视口：IO 微小相交后 0/599ms 不结算，600ms 成对发送信号', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  element.style.height = '1700px';
  const viewportHeight = 800;
  assert.ok(Number.parseFloat(element.style.height) > viewportHeight * 2);
  const item = makeItem(ID_A, 3);
  s.tracker.setActive(true);
  s.tracker.observe(element, item, { slateId: 'slate-1', position: 2 });
  s.tracker.markReady(ID_A, 3);

  assert.equal(s.lastIO().options.threshold, 0);
  s.lastIO().fire([[element, 0]]);
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 0, '非相交不计时');
  assert.equal(s.clock.size(), 0);

  s.lastIO().fire([[element, 0.01]]);
  assert.equal(s.clock.size(), 1, '长卡只有少量相交也按曝光计时');
  s.clock.advance(599);
  await tick();
  assert.equal(s.sent.length, 0, '599ms 不发阅读信号');

  s.clock.advance(1);
  await tick();
  assert.equal(s.sent.length, 1);
  const signals = s.sent[0];
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.type), ['impression', 'dwell']);
  for (const signal of signals) {
    assert.equal(signal.itemId, ID_A);
    assert.equal(signal.slateId, 'slate-1');
    assert.equal(signal.position, 2);
    assert.match(signal.at, ISO_RE, 'at 必须是可被 client 接受的 ISO 时间');
  }
  assert.equal(signals[0].at, signals[1].at);
  assert.notEqual(signals[0].eventId, signals[1].eventId, '两类信号各自独立 eventId');
  assert.ok(signals[1].value >= 600, 'dwell.value 至少 600ms');
  assert.deepEqual(s.reads, [[ID_A, 3]], '发送成功后回调 onRead 一次');
});

t('卡片在计时中脱离连接后不再发送阅读信号', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A, 1));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.5]]);
  assert.equal(s.clock.size(), 1);

  s.clock.advance(300);
  element.isConnected = false;
  s.clock.advance(300);
  await tick();
  assert.equal(s.sent.length, 0, '脱离 DOM 的旧条目不能完成 dwell');
  assert.equal(s.reads.length, 0);
});

t('单卡 unobserve 取消在途计时并保留同 revision settled 去重', async () => {
  const s = setup();
  const { element } = await readOnce(s);
  assert.equal(typeof s.tracker.unobserve, 'function', 'tracker 提供 owner 可调用的单条释放接口');
  if (typeof s.tracker.unobserve !== 'function') return;

  s.tracker.unobserve(element);
  assert.equal(s.lastIO().observed.has(element), false, '单卡释放同步 unobserve');
  s.tracker.observe(element, makeItem(ID_A, 3));
  s.tracker.markReady(ID_A, 3);
  s.lastIO().fire([[element, 0.8]]);
  assert.equal(s.clock.size(), 0, '单条释放不能清空已结算 revision 去重');
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 1);

  const pending = s.h.makeNode('div');
  s.tracker.observe(pending, makeItem(ID_B, 4));
  s.tracker.markReady(ID_B, 4);
  s.lastIO().fire([[pending, 0.7]]);
  assert.equal(s.clock.size(), 1);
  s.tracker.unobserve(pending);
  assert.equal(s.clock.size(), 0, 'unobserve 清掉该条 dwell timer');
  s.lastIO().fire([[pending, 0.7]]);
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 1, '释放后排队的 IO 不能重建计时');
});

t('两卡先未挂载再同时连接：observe 清理不误删，IO+ready 后都见读', async () => {
  const s = setup();
  const first = s.h.makeNode('div');
  const second = s.h.makeNode('div');
  first.isConnected = false;
  second.isConnected = false;

  s.tracker.setActive(true);
  s.tracker.observe(first, makeItem(ID_A, 1), { position: 0 });
  s.tracker.observe(second, makeItem(ID_B, 2), { position: 1 });

  first.isConnected = true;
  second.isConnected = true;
  s.lastIO().fire([[first, 0.01], [second, 0.02]]);
  s.tracker.markReady(ID_A, 1);
  s.tracker.markReady(ID_B, 2);
  assert.equal(s.clock.size(), 2, '两条都应开始 600ms 计时');
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 2, '两条都发送 impression+dwell');
  assert.deepEqual(s.reads, [[ID_A, 1], [ID_B, 2]]);
});

t('IO 报告不再相交：取消连续计时，不发信号', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.8]]);
  s.clock.advance(200);
  s.lastIO().fire([[element, 0]]);
  assert.equal(s.clock.size(), 0);
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.reads.length, 0);
});

t('ready 门禁：卡片高度未到不计时；错误 revision 的 ready 无效', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A, 2));
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(1000);
  assert.equal(s.clock.size(), 0, '未 ready 不开始计时');

  s.tracker.markReady(ID_A, 1);
  s.clock.advance(1000);
  assert.equal(s.clock.size(), 0, 'revision 不匹配的 ready 不能放行');

  s.tracker.markReady(ID_A, 2);
  assert.equal(s.clock.size(), 1);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);
});

t('active 门禁：关闭时不计时，重新激活从 0 重新累计', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  s.tracker.setActive(false);
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  assert.equal(s.clock.size(), 0);

  s.tracker.setActive(true);
  assert.equal(s.clock.size(), 1);
  s.clock.advance(300);
  s.tracker.setActive(false);
  assert.equal(s.clock.size(), 0, '隐藏时取消未完成的计时');
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 0);

  s.tracker.setActive(true);
  s.clock.advance(599);
  await tick();
  assert.equal(s.sent.length, 0, '重新激活后不足 600ms 不结算');
  s.clock.advance(1);
  await tick();
  assert.equal(s.sent.length, 1);
});

t('document 隐藏：不计时；阅读中途隐藏取消并丢弃已有停留', async () => {
  const hidden = setup({ visibility: 'hidden' });
  const element = hidden.h.makeNode('div');
  hidden.tracker.observe(element, makeItem(ID_A));
  hidden.tracker.markReady(ID_A, 1);
  hidden.lastIO().fire([[element, 0.9]]);
  hidden.clock.advance(1000);
  assert.equal(hidden.clock.size(), 0, 'document 不可见时不排计时器');
  assert.equal(hidden.sent.length, 0);

  hidden.h.doc.visibilityState = 'visible';
  hidden.h.fireDocument('visibilitychange');
  assert.equal(hidden.clock.size(), 1);
  hidden.clock.advance(600);
  await tick();
  assert.equal(hidden.sent.length, 1);

  const mid = setup();
  const midElement = mid.h.makeNode('div');
  mid.tracker.observe(midElement, makeItem(ID_B));
  mid.tracker.markReady(ID_B, 1);
  mid.lastIO().fire([[midElement, 0.9]]);
  mid.clock.advance(300);
  mid.h.doc.visibilityState = 'hidden';
  mid.h.fireDocument('visibilitychange');
  assert.equal(mid.clock.size(), 0);
  mid.clock.advance(1000);
  await tick();
  assert.equal(mid.sent.length, 0);

  mid.h.doc.visibilityState = 'visible';
  mid.h.fireDocument('visibilitychange');
  mid.clock.advance(599);
  await tick();
  assert.equal(mid.sent.length, 0, '隐藏过的时间不算进 600ms');
  mid.clock.advance(1);
  await tick();
  assert.equal(mid.sent.length, 1);
});

/* ---- 失败与去重 ---- */

t('发送失败：不调用 onRead、不自动循环重试；再次可见才允许重试', async () => {
  const s = setup();
  let attempts = 0;
  s.setSend(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return { accepted: 2, unreadTaskCount: 0 };
  });
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.reads.length, 0, '失败不能伪装已读');
  assert.equal(s.clock.size(), 0, '失败后不自动排重试计时器');
  s.clock.advance(5000);
  await tick();
  assert.equal(s.sent.length, 1, '不自动循环重试');

  s.tracker.setActive(false);
  s.tracker.setActive(true);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 2, '用户重新看到后允许再试一次');
  assert.deepEqual(s.reads, [[ID_A, 1]]);
});

t('服务端只接受部分信号：不回调 onRead，允许下次重新计时', async () => {
  const s = setup();
  let accepted = 1;
  s.setSend(async () => ({ accepted, unreadTaskCount: 0 }));
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.reads.length, 0, 'accepted 不足成对信号不能算已读');

  accepted = 2;
  s.tracker.setActive(false);
  s.tracker.setActive(true);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.reads, [[ID_A, 1]]);
});

t('每个 revision 只结算一次：返回再开、重新 observe 都不重复发信号', async () => {
  const s = setup();
  const { element } = await readOnce(s);
  assert.equal(s.sent.length, 1);

  s.tracker.setActive(false);
  s.tracker.setActive(true);
  s.lastIO().fire([[element, 0.1]]);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1, '已结算的 revision 不再发信号');
  assert.equal(s.reads.length, 1);

  s.tracker.observe(element, makeItem(ID_A, 3));
  s.tracker.markReady(ID_A, 3);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1, '同一元素重新登记同一 revision 也不重复');
});

t('同一 revision 的多个元素同时可见也只结算一次', async () => {
  const s = setup();
  const first = s.h.makeNode('div');
  const second = s.h.makeNode('div');
  const item = makeItem(ID_A, 4);
  s.tracker.observe(first, item);
  s.tracker.observe(second, item);
  s.tracker.markReady(ID_A, 4);
  s.lastIO().fire([[first, 0.9], [second, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.reads.length, 1);
});

/* ---- 释放 ---- */

t('reset：清掉未完成计时，同时清空已结算记录以便新会话重新计数', async () => {
  const s = setup();
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  assert.equal(s.clock.size(), 1);
  s.tracker.reset();
  assert.equal(s.clock.size(), 0);
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 0);

  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1, 'reset 后的新会话可以重新结算');
});

t('reset：进行中的发送结果不再回调 onRead', async () => {
  const s = setup();
  let resolveSend;
  s.setSend(() => new Promise((resolve) => { resolveSend = resolve; }));
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);

  s.tracker.reset();
  resolveSend({ accepted: 2, unreadTaskCount: 0 });
  await tick();
  assert.equal(s.reads.length, 0, 'reset 后旧发送结果不能写入新会话');
});

t('destroy：计时器与回调释放，延迟发送结果不回写 onRead', async () => {
  const s = setup();
  let resolveSend;
  s.setSend(() => new Promise((resolve) => { resolveSend = resolve; }));
  const element = s.h.makeNode('div');
  s.tracker.observe(element, makeItem(ID_A));
  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(600);
  await tick();
  assert.equal(s.sent.length, 1);

  s.tracker.destroy();
  resolveSend({ accepted: 2, unreadTaskCount: 0 });
  await tick();
  assert.equal(s.reads.length, 0, 'destroy 后迟到结果不再回调');

  s.tracker.markReady(ID_A, 1);
  s.lastIO().fire([[element, 0.9]]);
  s.clock.advance(1000);
  await tick();
  assert.equal(s.sent.length, 1);

  const before = s.clock.size();
  s.tracker.destroy();
  assert.equal(s.clock.size(), before);
});

t('缺少 IntersectionObserver：不崩、不伪造曝光', async () => {
  const s = setup({ ioClass: null });
  const element = s.h.makeNode('div');
  s.tracker.setActive(true);
  assert.doesNotThrow(() => s.tracker.observe(element, makeItem(ID_A)));
  assert.doesNotThrow(() => s.tracker.markReady(ID_A, 1));
  s.clock.advance(2000);
  await tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.reads.length, 0);
  assert.equal(s.ioInstances.length, 0);

  const throwing = setup({
    ioClass: class BrokenIO {
      constructor() {
        throw new Error('IntersectionObserver 不可用');
      }
    },
  });
  const other = throwing.h.makeNode('div');
  assert.doesNotThrow(() => throwing.tracker.observe(other, makeItem(ID_A)));
  throwing.clock.advance(1000);
  await tick();
  assert.equal(throwing.sent.length, 0);
});

/* ---- 信号形状 ---- */

t('没有上下文时不写 slateId/position；LAN HTTP 无 crypto 时事件 ID 仍唯一', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const s = setup();
    const element = s.h.makeNode('div');
    s.tracker.observe(element, makeItem(ID_A, 1));
    s.tracker.markReady(ID_A, 1);
    s.lastIO().fire([[element, 0.9]]);
    s.clock.advance(600);
    await tick();
    assert.equal(s.sent.length, 1);
    const signals = s.sent[0];
    assert.equal('slateId' in signals[0], false);
    assert.equal('position' in signals[0], false);
    assert.notEqual(signals[0].eventId, signals[1].eventId);
    assert.notEqual(signals[0].eventId, '');
    assert.ok(signals.every((signal) => typeof signal.eventId === 'string'));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
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
