/* tests/connection_banner.test.mjs — E9 断线细条
 *
 * 假 DOM 复用 tests/support/app_harness.mjs 的节点实现（appendChild / classList / hidden /
 * textContent 都按真 DOM 的语义实现）；时钟是本文件里的 createClock：
 * 600ms 防抖、2 秒自消如果用真定时器，用例既慢又飘，所以模块必须能注入
 * setTimeout / clearTimeout / now 三件套。
 *
 * 覆盖的行为（父代理给的验收点，一条一个用例）：
 *   1. 首屏第一次 connected 什么都不显示；
 *   2. 断开 → 600ms 后才显示；
 *   3. 600ms 内又连上 → 整条不出现；
 *   4. 恢复 → 显示「连接已恢复」，2 秒后自消；
 *   5. dispose() 之后不再响应 update。
 * 另外补了几条状态机的边界：主动断开（closed）静默收掉、恢复态 2 秒内又断、
 * 重连尝试中（connecting）不撤掉已显示的提示、定时器提前唤醒时按注入时钟补足。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createConnectionBanner } from '../web/connection-banner.js';

const h = createHarness();

const DOWN_TEXT = '连接已断开，正在重连…';
const UP_TEXT = '连接已恢复';

/* --------------------------- 可控时钟 --------------------------- */

function createClock(start = 0) {
  let nowMs = start;
  let seq = 0;
  const timers = new Map();

  function add(fn, ms) {
    seq += 1;
    const id = seq;
    timers.set(id, { fn, at: nowMs + Math.max(0, Number(ms) || 0) });
    return id;
  }

  function remove(id) {
    timers.delete(id);
  }

  /** 到期时间最近的一个；同一时刻按创建顺序（Map 的插入顺序）。 */
  function nextDue(limit) {
    let best = null;
    for (const [id, timer] of timers) {
      if (limit != null && timer.at > limit) continue;
      if (!best || timer.at < best.timer.at) best = { id, timer };
    }
    return best;
  }

  return {
    now: () => nowMs,
    setTimeout: add,
    clearTimeout: remove,
    /** 推进时钟：按到期顺序逐个触发，触发前把时钟拨到那一刻（和真定时器一致）。 */
    advance(ms) {
      const target = nowMs + Math.max(0, Number(ms) || 0);
      for (;;) {
        const due = nextDue(target);
        if (!due) break;
        timers.delete(due.id);
        nowMs = Math.max(nowMs, due.timer.at);
        due.timer.fn();
      }
      nowMs = target;
    },
    /** 不推进时钟，强行触发最近一个定时器：模拟浏览器提前/异常唤醒。 */
    fireNext() {
      const due = nextDue(null);
      if (!due) return false;
      timers.delete(due.id);
      due.timer.fn();
      return true;
    },
    pending: () => timers.size,
  };
}

/* --------------------------- 夹具 --------------------------- */

function createFixture(options = {}) {
  const clock = createClock(1000);
  const mount = h.makeNode('div', 'banner-host');
  const banner = createConnectionBanner({
    doc: h.doc,
    mount,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...options,
  });
  const bar = mount.children.find((node) => node.tagName !== '#TEXT');
  assert.ok(bar, '细条必须挂到 mount 上');
  return { clock, mount, banner, bar };
}

let failed = 0;

function test(name, run) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* --------------------------- 用例 --------------------------- */

test('首屏第一次 connected 什么都不显示，也不留定时器', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connecting');           // 页面初始化：正在建连接
  banner.update('connected');
  assert.equal(bar.hidden, true, '首次连上不该出现任何提示');
  assert.equal(clock.pending(), 0, '首次连上不该留任何定时器');
  clock.advance(5000);
  assert.equal(bar.hidden, true, '过多久都不该冒出提示');
});

test('断开后 600ms 才显示，599ms 时还不能出现', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');

  clock.advance(599);
  assert.equal(bar.hidden, true, '600ms 内不能闪出来');

  clock.advance(1);
  assert.equal(bar.hidden, false, '600ms 到点应显示');
  assert.equal(bar.textContent, DOWN_TEXT, '文案必须是断线那句');
  assert.equal(bar.classList.contains('is-down'), true, '断线态应有 is-down');
  assert.equal(bar.dataset.state, 'down');
});

test('600ms 内又连上：整条不出现（防抖）', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(300);
  banner.update('connected');            // 掐在 600ms 之前恢复

  clock.advance(5000);
  assert.equal(bar.hidden, true, '瞬断不能留下任何痕迹');
  assert.notEqual(bar.textContent, UP_TEXT, '也不该改成「已恢复」');
  assert.equal(clock.pending(), 0, '防抖窗口内恢复后不该再有定时器');

  // 状态机没被卡住：真断了还是会报
  banner.update('reconnecting');
  clock.advance(600);
  assert.equal(bar.hidden, false, '之后真正断开仍要提示');
  assert.equal(bar.textContent, DOWN_TEXT);
});

test('恢复：立即显示「连接已恢复」，2 秒后自消', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(600);
  assert.equal(bar.hidden, false, '夹具：断线提示应已出现');

  banner.update('connected');
  assert.equal(bar.hidden, false, '恢复态要立刻可见');
  assert.equal(bar.textContent, UP_TEXT);
  assert.equal(bar.dataset.state, 'up');
  assert.equal(bar.classList.contains('is-up'), true);

  clock.advance(1999);
  assert.equal(bar.hidden, false, '2 秒内不能提前消失');

  clock.advance(1);
  assert.equal(bar.hidden, true, '2 秒后应自消');
  assert.equal(bar.dataset.state, 'idle', '自消后回到空闲态');
  assert.equal(clock.pending(), 0);
});

test('dispose() 之后不再响应 update，并从挂载点摘掉', () => {
  const { clock, mount, bar, banner } = createFixture();
  banner.update('reconnecting');         // 先把防抖定时器排上
  assert.equal(clock.pending(), 1, '夹具：应有一个待触发的显示定时器');

  banner.dispose();
  assert.equal(clock.pending(), 0, 'dispose 必须清掉排队中的定时器');
  assert.equal(mount.children.length, 0, 'dispose 必须把细条从挂载点摘掉');

  banner.update('reconnecting');
  banner.update('connected');
  clock.advance(5000);
  assert.equal(bar.hidden, true, 'dispose 之后任何 update 都不能再显示');
  assert.equal(mount.children.length, 0, 'dispose 之后不能再挂回去');
});

test('主动断开（closed）：立刻收掉且不提示', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(600);
  assert.equal(bar.hidden, false, '夹具：断线提示应已出现');

  banner.update('closed');               // 退出登录 / 回首页
  assert.equal(bar.hidden, true, '主动断开不是故障，不能留着提示');
  assert.equal(clock.pending(), 0, '也不能留定时器');

  clock.advance(5000);
  assert.equal(bar.hidden, true, '之后也不能自己冒出来');
});

test('「已恢复」还没消失又断了：同一条原地换文案，不重新出场退场', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(600);
  banner.update('connected');
  assert.equal(bar.textContent, UP_TEXT);

  clock.advance(500);
  banner.update('reconnecting');         // 恢复态 2 秒窗口内再次断开
  assert.equal(bar.hidden, false, '同一条细条不能消失再出现');
  assert.equal(bar.textContent, DOWN_TEXT, '文案要跟着改回断线');
  assert.equal(bar.dataset.state, 'down');
  assert.equal(clock.pending(), 0, '恢复态的 2 秒自消定时器必须被取消');

  // 再次恢复仍走完整流程：显示「已恢复」→ 2 秒后自消
  banner.update('connected');
  assert.equal(bar.textContent, UP_TEXT);
  clock.advance(2000);
  assert.equal(bar.hidden, true);
});

test('重连尝试中（connecting）不撤掉已显示的断线提示', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(600);
  assert.equal(bar.hidden, false, '夹具：断线提示应已出现');

  banner.update('connecting');           // 800ms 退避到了，开始下一轮连接
  assert.equal(bar.hidden, false, '正在重连时提示要留着');
  assert.equal(bar.textContent, DOWN_TEXT, '文案说的就是这件事，不用换');

  banner.update('connected');
  assert.equal(bar.textContent, UP_TEXT);
  clock.advance(2000);
  assert.equal(bar.hidden, true);
});

test('定时器被提前唤醒时按注入时钟补足剩余时间，不提前显示', () => {
  const { clock, bar, banner } = createFixture();
  banner.update('connected');
  banner.update('reconnecting');
  clock.advance(100);
  assert.equal(clock.fireNext(), true, '夹具：应能手动唤醒排队中的定时器');

  assert.equal(bar.hidden, true, '实际才过 100ms，不能显示');
  assert.equal(clock.pending(), 1, '应按剩余 500ms 重新排一个');

  clock.advance(500);
  assert.equal(bar.hidden, false, '补足 600ms 后应显示');
});

test('delayMs 可覆盖：数字只改「断开后多久显示」，对象可同时改两段', () => {
  const slow = createFixture({ delayMs: 1000 });
  slow.banner.update('connected');
  slow.banner.update('reconnecting');
  slow.clock.advance(600);
  assert.equal(slow.bar.hidden, true, '传了 1000 就不能按默认 600 显示');
  slow.clock.advance(400);
  assert.equal(slow.bar.hidden, false);

  const quick = createFixture({ delayMs: { show: 0, hide: 100 } });
  quick.banner.update('connected');
  quick.banner.update('reconnecting');
  quick.clock.advance(0);
  assert.equal(quick.bar.hidden, false, 'show: 0 应立刻显示');
  quick.banner.update('connected');
  assert.equal(quick.bar.textContent, UP_TEXT);
  quick.clock.advance(100);
  assert.equal(quick.bar.hidden, true, 'hide: 100 应按覆盖值自消');
});

test('文案可覆盖（labels），默认仍是父代理定的两句', () => {
  const custom = createFixture({ labels: { down: '网络断了', up: '回来了' } });
  custom.banner.update('reconnecting');
  custom.clock.advance(600);
  assert.equal(custom.bar.textContent, '网络断了');
  custom.banner.update('connected');
  assert.equal(custom.bar.textContent, '回来了');
});

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
