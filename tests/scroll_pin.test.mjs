/* tests/scroll_pin.test.mjs — web/scroll-pin.js 的规则测试
 *
 * 这个模块是两个视图共用的「贴着底」规则，所以这里锁的是**规则本身**，
 * 不是某个界面的表现：
 * 1. 贴底是意图：用户往上翻就松手，翻回底部再挂上
 * 2. 程序滚底产生的 scroll 事件不能算用户翻了
 * 3. 补帧只在用户没动过的前提下生效（图片异步撑高的场景）
 * 4. 容器缺失时不抛错（视图创建早于上屏）
 */

import assert from 'node:assert/strict';
import { createScrollPin } from '../web/scroll-pin.js';

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

/** 假滚动容器：没有真实布局，几何全部由测试摆。 */
function makeBox({ scrollHeight = 2000, clientHeight = 600, scrollTop = 0 } = {}) {
  const listeners = [];
  const box = {
    scrollHeight,
    clientHeight,
    scrollTop,
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    /** 模拟用户滚动：先改位置，再抛事件。 */
    userScrollTo(top) {
      box.scrollTop = top;
      for (const l of [...listeners]) l.fn({ type: 'scroll' });
    },
    /** 模拟内容变高（图片加载、新消息插入）。 */
    growTo(height) { box.scrollHeight = height; },
  };
  return box;
}

/** 可手动驱动的帧调度器。 */
function makeRaf() {
  const queue = [];
  return {
    raf: (fn) => { queue.push(fn); },
    flush() {
      const pending = queue.splice(0, queue.length);
      for (const fn of pending) fn();
    },
    get size() { return queue.length; },
  };
}

await t('容器还没上屏时：不抛错，几何判定按「到底」处理', () => {
  const pin = createScrollPin({ getElement: () => null });
  assert.equal(pin.nearBottom(), true);
  assert.equal(pin.isPinned(), true);
  assert.doesNotThrow(() => pin.pin());
  assert.doesNotThrow(() => pin.follow());
  assert.equal(pin.attach(), false, '容器不存在时 attach 应返回 false');
});

await t('阈值边界：距底部 48px 内算贴着底，超过就算脱钩', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const pin = createScrollPin({ element: box, threshold: 48, raf: () => {} });

  box.scrollTop = 1400; // 2000 - 1400 - 600 = 0
  assert.equal(pin.nearBottom(), true);
  box.scrollTop = 1352; // 差 48
  assert.equal(pin.nearBottom(), true, '正好 48 算到底');
  box.scrollTop = 1300; // 差 100
  assert.equal(pin.nearBottom(), false, '超过阈值不算到底');
});

await t('内容比视口还短时按「到底」算，空列表不会被判成离底', () => {
  const box = makeBox({ scrollHeight: 300, clientHeight: 600, scrollTop: 0 });
  const pin = createScrollPin({ element: box });
  assert.equal(pin.nearBottom(), true);
});

await t('pin()：立即贴底，下一帧再补一次', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const raf = makeRaf();
  const pin = createScrollPin({ element: box, raf: raf.raf });

  pin.pin();
  assert.equal(box.scrollTop, 2000, 'pin() 应当即到底');
  assert.equal(raf.size, 1, '应当排一次补帧');

  box.growTo(2600); // 图片撑高
  raf.flush();
  assert.equal(box.scrollTop, 2600, '补帧要跟上撑高后的高度');
});

await t('用户往上翻之后：follow() 不再拽人', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const raf = makeRaf();
  const pin = createScrollPin({ element: box, raf: raf.raf });
  pin.attach();

  box.userScrollTo(400); // 用户翻上去看历史
  assert.equal(pin.isPinned(), false, '往上翻应脱钩');

  box.growTo(2400); // 新消息进来
  assert.equal(pin.follow(), false, '脱钩状态下不跟');
  assert.equal(box.scrollTop, 400, '视口不能被拽到底');
});

await t('只往上拖一点，即使还在阈值内也立刻脱钩（流式内容涨得比手快的情况）', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const pin = createScrollPin({ element: box, threshold: 160, raf: () => {} });
  pin.attach();

  pin.pin(); // 贴底到 2000
  box.userScrollTo(1350); // 只往上拖了 50px，离底部还有 50px
  assert.equal(pin.isPinned(), false, '方向优先：往上拖就是不想跟了');

  box.growTo(2400);
  assert.equal(pin.follow(), false, '脱钩后不再跟');
  assert.equal(box.scrollTop, 1350);
});

await t('往下翻回底部后重新挂上', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const pin = createScrollPin({ element: box, threshold: 160, raf: () => {} });
  pin.attach();

  pin.pin();
  box.userScrollTo(1000);
  assert.equal(pin.isPinned(), false);

  box.userScrollTo(1400); // 自己翻回底部
  assert.equal(pin.isPinned(), true);
});

await t('翻回底部后重新挂钩', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const pin = createScrollPin({ element: box, raf: () => {} });
  pin.attach();

  box.userScrollTo(400);
  assert.equal(pin.isPinned(), false);

  box.userScrollTo(1400); // 自己翻回底部
  assert.equal(pin.isPinned(), true, '回到阈值内应重新挂上');

  box.growTo(2400);
  assert.equal(pin.follow(), true);
  assert.equal(box.scrollTop, 2400);
});

await t('程序滚底抛出的 scroll 事件不算用户操作', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const raf = makeRaf();
  const pin = createScrollPin({ element: box, raf: raf.raf });
  pin.attach();

  pin.pin();
  // 浏览器会把这次设值补一个 scroll 事件出来
  for (const l of [...box.listeners]) l.fn({ type: 'scroll' });

  assert.equal(pin.isPinned(), true, '自己滚的不算用户翻走');
  raf.flush();
  assert.equal(box.scrollTop, 2000);
});

await t('补帧前用户已经翻走：补帧作废', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const raf = makeRaf();
  const pin = createScrollPin({ element: box, raf: raf.raf });
  pin.attach();

  pin.pin();
  box.userScrollTo(300); // 同一帧里用户往上翻
  box.growTo(2600);
  raf.flush();

  assert.equal(box.scrollTop, 300, '用户翻走之后补帧不能再拽到底');
});

await t('follow({force:true})：无视脱钩状态强行贴底（用户自己发消息）', () => {
  const box = makeBox({ scrollHeight: 2000, clientHeight: 600 });
  const pin = createScrollPin({ element: box, raf: () => {} });
  pin.attach();

  box.userScrollTo(200);
  assert.equal(pin.isPinned(), false);

  assert.equal(pin.follow({ force: true }), true);
  assert.equal(box.scrollTop, 2000, '强制跟到底');
  assert.equal(pin.isPinned(), true, '强制之后重新挂钩');
});

await t('attach() 幂等，detach() 之后不再响应滚动', () => {
  const box = makeBox();
  const pin = createScrollPin({ element: box, raf: () => {} });

  assert.equal(pin.attach(), true);
  assert.equal(pin.attach(), true);
  assert.equal(box.listeners.length, 1, '重复 attach 不能绑出两份监听');

  pin.detach();
  assert.equal(box.listeners.length, 0);

  box.scrollTop = 300;
  assert.equal(pin.isPinned(), true, 'detach 之后不再跟踪');
});

await t('容器被替换（getElement 每次现取）：跟着新容器走', () => {
  const first = makeBox({ scrollHeight: 1000, clientHeight: 600 });
  const second = makeBox({ scrollHeight: 3000, clientHeight: 600 });
  let current = first;
  const pin = createScrollPin({ getElement: () => current, raf: () => {} });

  pin.pin();
  assert.equal(first.scrollTop, 1000);

  current = second;
  pin.pin();
  assert.equal(second.scrollTop, 3000, '应当滚新的容器');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
