/* 图片全屏查看（E12）测试
 *
 * 跑法：node tests/lightbox.test.mjs
 *
 * 假 DOM 复用 tests/support/app_harness.mjs。真实手势没法在这里跑，但状态机可以：
 * 直接往 root 上派发带 pointerId / clientX / clientY 的 pointerdown/move/up，
 * 判定规则本身另用 resolveDrag() 的纯函数表覆盖。
 *
 * 夹具约定：harness 的 window.innerWidth=400、innerHeight=800，
 * 而假节点的 getBoundingClientRect() 恒为 0，于是模块会退到 innerWidth：
 * 横向阈值 = max(24, 400*0.15) = 60px。
 */

import { createHarness } from './support/app_harness.mjs';
import { createLightbox, resolveDrag } from '../web/lightbox.js';

const h = createHarness();
const { doc } = h;

function cleanupDom() {
  for (const host of doc.body.querySelectorAll('.lb-host')) host.remove();
  for (const root of doc.body.querySelectorAll('.lightbox-root')) root.remove();
}

let bad = 0;

function runCheck(name, fn) {
  // 上一个用例失败时可能留下没关的灯箱：每个用例开跑前先清场，数字才可比
  cleanupDom();
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || '值'}不相等\n      期望 ${e}\n      实际 ${a}`);
}

function assertClose(actual, expected, label, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label || '值'}不接近\n      期望 ${expected}\n      实际 ${actual}`);
  }
}

/* ---------------------------- 夹具 ---------------------------- */

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    src: `https://ex.test/img-${i}.jpg`,
    alt: `图片${i}`,
  }));
}

/** 可控定时器：单击关闭的延迟窗口由用例决定何时到点。 */
function createTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, entry] of due) entry.fn();
    },
    get size() {
      return pending.size;
    },
    get lastMs() {
      const entries = [...pending.values()];
      return entries.length ? entries[entries.length - 1].ms : null;
    },
  };
}

/** 可控时钟：双击判定依赖 now()，不能让真实时间抖。 */
function createClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    set(value) {
      t = value;
    },
    advance(ms) {
      t += ms;
    },
  };
}

/** 假的文档级键盘挂点：能 fire，也能数监听器个数（验证 close 时解绑）。 */
function createKeyTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners.has(type)) return;
      listeners.set(type, listeners.get(type).filter((item) => item !== fn));
    },
    count(type) {
      return (listeners.get(type) || []).length;
    },
    fire(type, extra = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, preventDefault() {}, stopPropagation() {}, ...extra });
      }
    },
  };
}

function setup() {
  const mount = doc.createElement('div');
  mount.className = 'lb-host';
  doc.body.appendChild(mount);

  const timers = createTimers();
  const clock = createClock();
  const keys = createKeyTarget();
  const closes = [];

  const lightbox = createLightbox({
    doc,
    mount,
    timers,
    now: clock.now,
    keyTarget: keys,
    win: h.window,
    onClose: () => closes.push('close'),
  });

  return { lightbox, mount, timers, clock, keys, closes };
}

const rootOf = (mount) => mount.querySelector('.lightbox-root');
const trackOf = (mount) => mount.querySelector('.lightbox-track');
const counterOf = (mount) => mount.querySelector('.lightbox-counter');

function counterText(mount) {
  const node = counterOf(mount);
  return node ? String(node.textContent).trim() : null;
}

function trackX(mount) {
  const node = trackOf(mount);
  if (!node) return null;
  const m = /translate3d\((-?[\d.]+)px/.exec(String(node.style.transform || ''));
  return m ? Number(m[1]) : null;
}

function currentImg(mount, index) {
  return mount.querySelectorAll('.lightbox-img')[index];
}

/** 派发一个指针事件；事件对象是数据，处理器只读 pointerId / clientX / clientY。 */
function pointer(mount, type, { id = 1, x = 0, y = 0 } = {}) {
  const root = rootOf(mount);
  assert(root, '灯箱根节点不存在');
  root.dispatchEvent({
    type,
    pointerId: id,
    pointerType: 'touch',
    isPrimary: id === 1,
    clientX: x,
    clientY: y,
  });
}

/** 一次完整的单指拖动。 */
function drag(mount, from, to, id = 1) {
  pointer(mount, 'pointerdown', { id, x: from.x, y: from.y });
  pointer(mount, 'pointermove', { id, x: to.x, y: to.y });
  pointer(mount, 'pointerup', { id, x: to.x, y: to.y });
}

/** 一次点按（按下与抬起同点）。 */
function tap(mount, x, y) {
  pointer(mount, 'pointerdown', { x, y });
  pointer(mount, 'pointerup', { x, y });
}

/** 双指捏合：把两指距离从 from 拉到 to（两指对称地外扩）。 */
function pinch(mount, from = 100, to = 200) {
  pointer(mount, 'pointerdown', { id: 1, x: 200 - from / 2, y: 400 });
  pointer(mount, 'pointerdown', { id: 2, x: 200 + from / 2, y: 400 });
  pointer(mount, 'pointermove', { id: 1, x: 200 - to / 2, y: 400 });
  pointer(mount, 'pointermove', { id: 2, x: 200 + to / 2, y: 400 });
  pointer(mount, 'pointerup', { id: 2, x: 200 + to / 2, y: 400 });
  pointer(mount, 'pointerup', { id: 1, x: 200 - to / 2, y: 400 });
}

/* ---------------------------- 用例 ---------------------------- */

runCheck('open(items, 2)：打开、定位到第 3 张、计数 3 / 7', () => {
  const { lightbox, mount } = setup();
  const items = makeItems(7);

  assertEqual(lightbox.open(items, 2), true, 'open 返回值');
  assertEqual(lightbox.isOpen(), true, 'isOpen()');
  assertEqual(counterText(mount), '3 / 7', '计数');
  assertEqual(mount.querySelectorAll('.lightbox-img').length, 7, '图片数量');
  assertEqual(currentImg(mount, 0).src, items[0].src, '第一张的 src');
  assertEqual(currentImg(mount, 0).alt, items[0].alt, '第一张的 alt');
  assertEqual(trackX(mount), -800, '轨道位移（第 3 张 = -2×400）');
  assertEqual(lightbox.getState().index, 2, '当前序号');

  lightbox.close();
});

runCheck('next() / prev() 在首尾夹住，不循环', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(3), 2);

  assertEqual(lightbox.next(), false, '末张再 next 的返回值');
  assertEqual(lightbox.getState().index, 2, '末张再 next 后序号');
  assertEqual(counterText(mount), '3 / 3', '末张计数');

  assertEqual(lightbox.prev(), true, '末张 prev 的返回值');
  assertEqual(lightbox.getState().index, 1, 'prev 后序号');
  assertEqual(counterText(mount), '2 / 3', 'prev 后计数');
  assertEqual(trackX(mount), -400, 'prev 后轨道位移');

  lightbox.prev();
  assertEqual(lightbox.getState().index, 0, '到首张');
  assertEqual(lightbox.prev(), false, '首张再 prev 的返回值');
  assertEqual(lightbox.getState().index, 0, '首张不应回绕到末张');
  assertEqual(counterText(mount), '1 / 3', '首张计数');

  lightbox.close();
});

runCheck('键盘：左右切换、Esc 关闭、关闭后解绑', () => {
  const { lightbox, mount, keys, closes } = setup();
  lightbox.open(makeItems(4), 1);
  assertEqual(keys.count('keydown'), 1, '打开时挂上的键盘监听数');

  keys.fire('keydown', { key: 'ArrowRight' });
  assertEqual(lightbox.getState().index, 2, '右方向键');
  keys.fire('keydown', { key: 'ArrowLeft' });
  keys.fire('keydown', { key: 'ArrowLeft' });
  assertEqual(lightbox.getState().index, 0, '左方向键');

  keys.fire('keydown', { key: 'Escape' });
  assertEqual(lightbox.isOpen(), false, 'Esc 后应关闭');
  assertEqual(rootOf(mount), null, 'Esc 后根节点应移除');
  assertEqual(closes.length, 1, 'onClose 调用次数');
  assertEqual(keys.count('keydown'), 0, '关闭后键盘监听应解绑');

  keys.fire('keydown', { key: 'Escape' });
  assertEqual(closes.length, 1, '关闭后再按键不应再回调');
  assertEqual(lightbox.isOpen(), false, '保持关闭');
});

runCheck('横拖未过阈值（60px）不翻页，轨道回位', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(5), 0);

  drag(mount, { x: 200, y: 400 }, { x: 160, y: 400 }); // dx=-40
  assertEqual(lightbox.getState().index, 0, '未过阈值不应翻页');
  assertEqual(trackX(mount), 0, '松手后轨道应回到原位');
  assertEqual(lightbox.isOpen(), true, '不应误关');
  assertEqual(counterText(mount), '1 / 5', '计数不变');

  // 纵向小抖动同样不能当翻页
  drag(mount, { x: 200, y: 400 }, { x: 210, y: 430 });
  assertEqual(lightbox.getState().index, 0, '小幅斜拖不应翻页');

  lightbox.close();
});

runCheck('横拖过阈值翻页，方向决定前后', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(5), 1);

  drag(mount, { x: 300, y: 400 }, { x: 180, y: 400 }); // 向左 dx=-120
  assertEqual(lightbox.getState().index, 2, '向左拖应下一张');
  assertEqual(trackX(mount), -800, '翻页后轨道位移');
  assertEqual(counterText(mount), '3 / 5', '翻页后计数');

  drag(mount, { x: 100, y: 400 }, { x: 240, y: 400 }); // 向右 dx=+140
  assertEqual(lightbox.getState().index, 1, '向右拖应上一张');

  // 首张继续向右拖：夹住，不循环
  drag(mount, { x: 100, y: 400 }, { x: 240, y: 400 });
  assertEqual(lightbox.getState().index, 0, '首张再向右拖应夹住');
  assertEqual(trackX(mount), 0, '夹住后轨道位移');

  lightbox.close();
});

runCheck('下滑关闭并回调 onClose', () => {
  const { lightbox, mount, closes } = setup();
  lightbox.open(makeItems(3), 0);

  drag(mount, { x: 200, y: 200 }, { x: 205, y: 330 }); // dy=+130
  assertEqual(lightbox.isOpen(), false, '下滑后应关闭');
  assertEqual(closes.length, 1, 'onClose 调用次数');
  assertEqual(rootOf(mount), null, '关闭后根节点应移除');

  // 上滑不关闭
  const second = setup();
  second.lightbox.open(makeItems(3), 0);
  drag(second.mount, { x: 200, y: 400 }, { x: 200, y: 240 }); // dy=-160
  assertEqual(second.lightbox.isOpen(), true, '上滑不应关闭');
  assertEqual(second.lightbox.getState().index, 0, '上滑也不应翻页');
  second.lightbox.close();
});

runCheck('双指捏合改变 scale，松手后保留', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(3), 0);

  pinch(mount, 100, 200); // 距离翻倍
  assertClose(lightbox.getState().scale, 2, '捏合后 scale');
  const img = currentImg(mount, 0);
  assert(String(img.style.transform).includes('scale(2)'), `当前图应带缩放：${img.style.transform}`);
  assertEqual(lightbox.getState().index, 0, '捏合不应翻页');
  assertEqual(lightbox.isOpen(), true, '捏合不应关闭');

  // 继续捏到超过上限：夹在 4x
  pinch(mount, 100, 900);
  assertClose(lightbox.getState().scale, 4, '超过上限应夹在 4x');

  lightbox.close();
});

runCheck('双击在 1x 与 2x 之间切换，且第一次点按不误关', () => {
  const { lightbox, mount, timers, clock } = setup();
  lightbox.open(makeItems(3), 0);

  clock.set(1000);
  tap(mount, 200, 400);
  // 单击会挂一个「稍后关闭」的定时器，给双击留窗口；此刻还没关
  assertEqual(timers.size, 1, '单击后应有待执行的关闭定时器');
  assertEqual(lightbox.isOpen(), true, '双击窗口内不应关闭');

  clock.set(1100);
  tap(mount, 200, 400);
  assertEqual(timers.size, 0, '第二次点按应取消关闭定时器');
  assertClose(lightbox.getState().scale, 2, '双击后 scale');
  assert(timers.size === 0, '双击不应再排关闭');

  clock.set(3000);
  tap(mount, 200, 400);
  clock.set(3100);
  tap(mount, 200, 400);
  assertClose(lightbox.getState().scale, 1, '再双击应复原');
  assertEqual(lightbox.getState().panX, 0, '复原后 panX');
  assertEqual(lightbox.getState().panY, 0, '复原后 panY');

  lightbox.close();
});

runCheck('放大时横拖是平移，不翻页；边界夹住', () => {
  const { lightbox, mount, clock } = setup();
  lightbox.open(makeItems(5), 1);

  clock.set(1000);
  tap(mount, 200, 400);
  clock.set(1100);
  tap(mount, 200, 400);
  assertClose(lightbox.getState().scale, 2, '先放大到 2x');

  drag(mount, { x: 300, y: 400 }, { x: 200, y: 400 }); // dx=-100
  assertEqual(lightbox.getState().index, 1, '放大时横拖不应翻页');
  assertClose(lightbox.getState().panX, -100, '放大时横拖应平移');
  const img = currentImg(mount, 1);
  assert(String(img.style.transform).includes('scale(2)'), '平移后仍应保持缩放');

  // 拖出边界：夹在 ±(scale-1)*宽/2 = ±200
  drag(mount, { x: 380, y: 400 }, { x: -820, y: 400 }); // dx=-1200
  assertClose(lightbox.getState().panX, -200, '平移应夹在左边界');
  assertEqual(lightbox.getState().index, 1, '越界拖动也不翻页');

  drag(mount, { x: 20, y: 400 }, { x: 1220, y: 400 }); // dx=+1200
  assertClose(lightbox.getState().panX, 200, '平移应夹在右边界');

  lightbox.close();
});

runCheck('切换即复原：翻页后缩放与平移归零', () => {
  const { lightbox, mount, clock } = setup();
  lightbox.open(makeItems(4), 1);

  clock.set(1000);
  tap(mount, 200, 400);
  clock.set(1100);
  tap(mount, 200, 400);
  drag(mount, { x: 300, y: 400 }, { x: 200, y: 400 });
  assertClose(lightbox.getState().scale, 2, '翻页前 scale');

  lightbox.next();
  assertEqual(lightbox.getState().index, 2, '翻页后序号');
  assertEqual(lightbox.getState().scale, 1, '翻页后 scale 应复原');
  assertEqual(lightbox.getState().panX, 0, '翻页后 panX 应复原');
  assertEqual(String(currentImg(mount, 2).style.transform), '', '新图不应带旧变换');
  assertEqual(String(currentImg(mount, 1).style.transform), '', '旧图变换应清掉');

  lightbox.close();
});

runCheck('单击（非拖动）延迟关闭，onClose 恰好一次', () => {
  const { lightbox, mount, timers, closes } = setup();
  lightbox.open(makeItems(3), 0);

  tap(mount, 200, 400);
  assertEqual(lightbox.isOpen(), true, '点按当下还在（等双击窗口）');
  assertEqual(timers.lastMs, 220, '单击关闭的延迟');
  timers.runAll();

  assertEqual(lightbox.isOpen(), false, '延迟到点后应关闭');
  assertEqual(closes.length, 1, 'onClose 调用次数');

  // 已经关了：再 close() / next() 都不能重复回调，也不能炸
  lightbox.close();
  assertEqual(lightbox.next(), false, '关闭后 next 的返回值');
  timers.runAll();
  assertEqual(closes.length, 1, '关闭后重复触发不应再回调');
});

runCheck('关闭后 DOM 清干净，重新打开不残留旧图', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(7), 0);
  assertEqual(mount.querySelectorAll('.lightbox-img').length, 7, '第一次打开图片数');

  lightbox.close();
  assertEqual(rootOf(mount), null, '关闭后根节点');
  assertEqual(mount.querySelectorAll('.lightbox-img').length, 0, '关闭后图片节点');
  assertEqual(mount.querySelectorAll('.lightbox-track').length, 0, '关闭后轨道节点');

  lightbox.open(makeItems(2), 1);
  assertEqual(mount.querySelectorAll('.lightbox-img').length, 2, '重新打开图片数');
  assertEqual(counterText(mount), '2 / 2', '重新打开计数');
  assertEqual(trackX(mount), -400, '重新打开轨道位移');

  lightbox.close();
});

runCheck('重复 open 覆盖上一组，不叠加节点', () => {
  const { lightbox, mount, closes } = setup();
  lightbox.open(makeItems(7), 3);
  lightbox.open(makeItems(2), 0);

  assertEqual(mount.querySelectorAll('.lightbox-root').length, 1, '根节点数');
  assertEqual(mount.querySelectorAll('.lightbox-img').length, 2, '图片数');
  assertEqual(counterText(mount), '1 / 2', '计数');
  assertEqual(closes.length, 0, '重开不是关闭，不应回调 onClose');

  lightbox.close();
  assertEqual(closes.length, 1, '真正关闭时才回调');
  assertEqual(mount.querySelectorAll('.lightbox-root').length, 0, '关闭后根节点数');
});

runCheck('空列表 / 越界 startIndex / 缺参数', () => {
  const { lightbox, mount } = setup();

  assertEqual(lightbox.open([]), false, '空列表 open 返回值');
  assertEqual(lightbox.isOpen(), false, '空列表不应打开');
  assertEqual(rootOf(mount), null, '空列表不应建 DOM');

  assertEqual(lightbox.open(null), false, 'null 输入的返回值');
  assertEqual(lightbox.isOpen(), false, 'isOpen() 初值');

  lightbox.open(makeItems(3), 99);
  assertEqual(lightbox.getState().index, 2, '越界 startIndex 应夹到末张');
  assertEqual(counterText(mount), '3 / 3', '越界 startIndex 的计数');
  lightbox.close();

  lightbox.open(makeItems(3), -5);
  assertEqual(lightbox.getState().index, 0, '负数 startIndex 应夹到首张');
  lightbox.close();

  let message = '';
  try {
    createLightbox({ doc: null, mount });
  } catch (err) {
    message = String(err && err.message);
  }
  assert(message.includes('document'), `缺少 doc 应给出明确错误，实际：${message}`);

  // mount 是可选的：不给就挂到 doc.body，装配层只传 doc 也能用
  const fallback = createLightbox({ doc });
  assertEqual(fallback.open(makeItems(1)), true, '缺省 mount 应能打开');
  assertEqual(doc.body.querySelectorAll('.lightbox-img').length, 1, '缺省 mount 挂到 body');
  fallback.close();
  assertEqual(doc.body.querySelectorAll('.lightbox-root').length, 0, '缺省 mount 关闭后应清干净');
});

runCheck('两侧箭头按钮可切换，单图时隐藏、首末张置灰', () => {
  const { lightbox, mount } = setup();
  lightbox.open(makeItems(3), 1);

  mount.querySelector('.lightbox-next').click();
  assertEqual(lightbox.getState().index, 2, '点右箭头应下一张');
  assertEqual(mount.querySelector('.lightbox-next').disabled, true, '末张右箭头应置灰');

  mount.querySelector('.lightbox-prev').click();
  assertEqual(lightbox.getState().index, 1, '点左箭头应上一张');
  assertEqual(mount.querySelector('.lightbox-prev').disabled, false, '中间张左箭头可点');

  mount.querySelector('.lightbox-close').click();
  assertEqual(lightbox.isOpen(), false, '点关闭按钮应关闭');

  const single = setup();
  single.lightbox.open(makeItems(1), 0);
  assertEqual(counterText(single.mount), '1 / 1', '单图计数');
  assertEqual(single.mount.querySelector('.lightbox-prev').hidden, true, '单图左箭头应隐藏');
  assertEqual(single.mount.querySelector('.lightbox-next').hidden, true, '单图右箭头应隐藏');
  assertEqual(rootOf(single.mount).classList.contains('is-single'), true, '单图标记');
  single.lightbox.close();
});

runCheck('pointercancel（浏览器抢走手势）只回位，不关闭也不翻页', () => {
  const { lightbox, mount, closes, timers } = setup();
  lightbox.open(makeItems(3), 0);

  pointer(mount, 'pointerdown', { x: 200, y: 200 });
  pointer(mount, 'pointermove', { x: 200, y: 400 }); // 下滑轨迹
  pointer(mount, 'pointercancel', { x: 200, y: 400 });

  assertEqual(lightbox.isOpen(), true, '不应关闭');
  assertEqual(lightbox.getState().index, 0, '不应翻页');
  assertEqual(closes.length, 0, '不应回调 onClose');
  assertEqual(timers.size, 0, '不应排上单击关闭的定时器');

  lightbox.close();
});

runCheck('resolveDrag 判定表（纯函数）', () => {
  const width = 400; // 阈值 60

  assertEqual(resolveDrag({ dx: -80, dy: 0, scale: 1, width }), 'next', '左拖过阈值');
  assertEqual(resolveDrag({ dx: 80, dy: 0, scale: 1, width }), 'prev', '右拖过阈值');
  assertEqual(resolveDrag({ dx: -59, dy: 0, scale: 1, width }), 'none', '左拖差 1px 到阈值');
  assertEqual(resolveDrag({ dx: -60, dy: 0, scale: 1, width }), 'next', '左拖正好阈值');
  assertEqual(resolveDrag({ dx: -20, dy: -10, scale: 1, width }), 'none', '小幅斜拖');
  assertEqual(resolveDrag({ dx: 0, dy: 120, scale: 1, width }), 'close', '下滑过阈值');
  assertEqual(resolveDrag({ dx: 0, dy: -120, scale: 1, width }), 'none', '上滑不关闭');
  assertEqual(resolveDrag({ dx: 0, dy: 40, scale: 1, width }), 'none', '下滑未过阈值');
  assertEqual(resolveDrag({ dx: -300, dy: 0, scale: 2, width }), 'pan', '放大时横拖是平移');
  assertEqual(resolveDrag({ dx: 0, dy: 300, scale: 1.5, width }), 'pan', '放大时竖拖也是平移');
  assertEqual(resolveDrag({ dx: -70, dy: 10, scale: 1, width }), 'next', '横向占优');
  assertEqual(resolveDrag({ dx: -70, dy: 90, scale: 1, width }), 'close', '纵向占优时按关闭');
  assertEqual(resolveDrag({ dx: -100, dy: 0, scale: 1, width: 0 }), 'next', '拿不到宽度时用缺省视口');
  assertEqual(resolveDrag({ dx: -40, dy: 0, scale: 1, width: 0 }), 'none', '缺省视口下 40px 不够');
  assertEqual(resolveDrag({ dx: -40, dy: 0, scale: 1, width, threshold: 30 }), 'next', '显式阈值');
  assertEqual(resolveDrag({}), 'none', '空输入');
});

if (bad === 0) console.log('\nALL PASS');
else console.log(`\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
