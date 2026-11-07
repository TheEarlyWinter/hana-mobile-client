/* tests/history_pagination_view.test.mjs
 *
 * web/history-pagination-view.js 的单测（纯 DOM，无 app、无 fetch、无 S）。
 *
 * 锁的行为：
 * 1. hasMore 时可见「加载更早」，点击回调；没有更早时整条控制带隐藏；
 * 2. loading 时按钮禁用且点击不触发，避免并发；
 * 3. 失败显示「重试」+ 错误文案；生成中（code=busy）显示明确的稍后重试提示；
 *    失败文案按 phase 区分：首屏（initial）失败是「会话加载失败」，
 *    翻页（older / 缺省）失败才是「加载更早失败」，缺 phase 按 older 兼容；
 * 4. beginPrepend / append / endPrepend：更早页节点从一开始就插在旧消息之前，
 *    旧节点对象不搬家；
 * 5. 滚动补偿走「锚点位移」而不是 scrollHeight 增量（契约 2.4）：
 *    - prepend 把旧内容第一条往下推了多少就补多少（同步那一次和之后晚到的图片/卡片都算）；
 *    - 生成中的流式内容长在锚点**下方**，scrollHeight 涨而锚点 top 不动 → 一律不补（核心验收）；
 *    - 用户自己滚过之后立刻收手，不再抢滚动位置；
 *    - 锚点被移除时结束观察，不退回高度法；
 * 6. 实时消息（不在 prepend 中）仍追加到末尾；
 * 7. 容器被 innerHTML 清空后，控制带能重新挂回第一个子节点；
 * 8. reset / dispose 清干净，dispose 后不再回调；
 * 9. 模块边界：源码不 fetch、不读 S、不 import 业务模块；
 * 10. G7 程序化滚动的认领：本模块自己的写入、装配层报备过的写入都不算用户滚动，窗口继续；
 *     没报备的写入仍按用户滚动处理（安全方向）；
 * 11. G8 负位移：控制带收起拿掉锚点上方的高度，按记账额度补回来（内容坐标等价）；
 *     没有记账额度的缩水不补；用户刚滚过（scroll 事件还在路上）也不补；
 * 12. G9 夹具跟真浏览器一样 clamp scrollHeight - clientHeight，且程序化写之后会排一个
 *     scroll 事件（flush() 派发）：补偿写入不会被自己误判，补不到的位置不硬塞也不反复补。
 *
 * 夹具没有真实布局：每个元素带一个可改的 `rect`，`getBoundingClientRect()` 读它；
 * 容器装了「会真的滚动」的 scrollTop——改 scrollTop 时把全部后代的 rect.top 反向平移，
 * 和浏览器一样。所以「补完之后锚点回到原位」在夹具里是可验证的事实，不是假设。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ */
/* 极简 DOM                                                            */
/* ------------------------------------------------------------------ */

function makeEl(tag = 'div') {
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    listeners,
    hidden: false,
    disabled: false,
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    parentNode: null,
    // overflowAnchor 要有键，否则「窗口内关、窗口外还原」在夹具里是死分支，测了等于没测
    style: { overflowAnchor: '' },
    attributes: {},
    // 夹具的布局：视口坐标由用例显式摆，模块只能读。
    rect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
    classList: {
      add(cls) {
        const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
        set.add(cls);
        node.className = Array.from(set).join(' ');
      },
      contains(cls) {
        return String(node.className || '').split(/\s+/).includes(cls);
      },
    },
    getBoundingClientRect() {
      return { ...node.rect };
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const index = ref ? node.children.indexOf(ref) : -1;
      node.children.splice(index === -1 ? node.children.length : index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index !== -1) node.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(key, value) {
      node.attributes[key] = String(value);
    },
    getAttribute(key) {
      return key in node.attributes ? node.attributes[key] : null;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt?.type;
      for (const fn of [...(listeners[type] || [])]) fn.call(node, { type, target: node });
    },
  };
  return node;
}

const doc = {
  createElement: (tag) => makeEl(tag),
};

function descendants(root, out = []) {
  for (const child of root.children || []) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

/**
 * 让容器像真浏览器一样滚动：
 *   - 改 scrollTop 时内容整体相对视口位移，所以后代 rect.top 反向平移；
 *   - 按 scrollHeight - clientHeight clamp（浏览器就是这样：写到范围外只停在上限，不报错）；
 *   - echo=true：任何写入都排一个 scroll 事件，由 flush() 在「下一拍」派发——浏览器也是异步
 *     派发，写的那一刻事件还没到，这正是 G7 要测的时序。
 * 不装这个，「补完之后锚点回到原位」在夹具里根本没有发生，位移法的断言会假绿（重复补偿也看不出来）。
 */
function wireScroll(container, { echo = false } = {}) {
  let top = 0;
  let pendingEcho = false;
  const maxScroll = () =>
    Math.max(0, (Number(container.scrollHeight) || 0) - (Number(container.clientHeight) || 0));
  const apply = (next) => {
    const clamped = Math.min(maxScroll(), Math.max(0, Number(next) || 0));
    const shift = clamped - top;
    top = clamped;
    if (!shift) return top;
    for (const node of descendants(container)) node.rect.top -= shift;
    if (echo) pendingEcho = true;
    return top;
  };
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get: () => top,
    set(value) {
      apply(value);
    },
  });
  return {
    get top() {
      return top;
    },
    maxScroll,
    /** 内容变矮时浏览器会顺手 clamp scrollTop，夹具也一样。 */
    setScrollHeight(height) {
      container.scrollHeight = height;
      apply(top);
    },
    /** 把排队的 scroll 事件派发掉（相当于浏览器下一拍才送到）。 */
    flush() {
      if (!pendingEcho) return false;
      pendingEcho = false;
      container.dispatchEvent('scroll');
      return true;
    },
    pending: () => pendingEcho,
  };
}

/** 夹具不做布局计算：把某个元素在视口里往下推 h 像素 ≡ 它上面长出了 h 像素内容。 */
function pushDown(node, h) {
  node.rect.top += h;
}

/** 手动推进的时钟 + 定时器队列：prepend 之后的观察窗口不真等 1.2 秒。 */
function makeClock(start = 0) {
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

const { createHistoryPaginationView } = await import('../web/history-pagination-view.js');

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

function makeView(overrides = {}) {
  const container = makeEl('div');
  // 视口 800、内容 1000：初始 scrollTop 200 正好在底部，和真浏览器一样不能凭空写任意值。
  container.clientHeight = 800;
  container.scrollHeight = 1000;
  const scroll = wireScroll(container, { echo: Boolean(overrides.echo) });
  const calls = { loadOlder: 0 };
  const clock = overrides.clock || makeClock();
  const view = createHistoryPaginationView({
    document: doc,
    container,
    onLoadOlder: () => {
      calls.loadOlder += 1;
      if (overrides.onLoadOlder) overrides.onLoadOlder();
    },
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });
  // 控制带在第一次 setState 时挂载；先给一个空状态把结构建出来。
  view.setState({ loading: false, hasMore: false, error: null });
  const bar = container.children[0];
  const button = bar.children[0];
  const status = bar.children[1];
  return { container, view, calls, bar, button, status, clock, scroll };
}

/**
 * 标准布局夹具：容器里已有一条旧消息（视口 top=220，scrollTop=200），
 * 开一页 prepend 并把首页节点插进去，再在同步渲染里把旧消息往下推 syncGrowth 像素。
 */
function setupPrepend({ syncGrowth = 300, tag = 'turn user', echo = false } = {}) {
  const ctx = makeView({ echo });
  const oldTurn = makeEl('div');
  oldTurn.className = tag;
  ctx.container.appendChild(oldTurn);
  ctx.container.scrollTop = 200;
  oldTurn.rect.top = 220; // 用户正看着的那条消息在视口里的位置
  ctx.view.setState({ loading: true, hasMore: true, error: null });
  ctx.oldTurn = oldTurn;
  ctx.OLD_TOP = 220;
  ctx.syncGrowth = syncGrowth;

  ctx.view.beginPrepend();
  ctx.page = makeEl('div');
  ctx.page.className = 'turn user';
  ctx.view.append(ctx.page);
  if (syncGrowth) {
    pushDown(oldTurn, syncGrowth);
    ctx.container.scrollHeight = 1000 + syncGrowth;
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* 控制带与文案                                                        */
/* ------------------------------------------------------------------ */

t('hasMore=true：控制带可见、按钮是「加载更早」，点击回调一次', () => {
  const { container, view, calls, bar, button } = makeView();
  view.setState({ loading: false, hasMore: true, error: null });

  assert.equal(bar.hidden, false, '有更早消息时控制带必须可见');
  assert.equal(container.children[0], bar, '控制带必须挂在容器最前面');
  assert.equal(button.textContent, '加载更早');
  assert.equal(button.disabled, false);

  button.dispatchEvent('click');
  assert.equal(calls.loadOlder, 1, '点击应触发 onLoadOlder');
});

t('hasMore=false 且无错误：整条控制带隐藏', () => {
  const { view, bar } = makeView();
  view.setState({ loading: false, hasMore: false, error: null });
  assert.equal(bar.hidden, true);
});

t('loading：按钮禁用并显示加载中，点击不触发', () => {
  const { view, calls, button } = makeView();
  view.setState({ loading: true, hasMore: true, error: null });
  assert.equal(button.disabled, true, '加载中不能重复点');
  assert.equal(button.textContent, '加载中…');
  button.dispatchEvent('click');
  assert.equal(calls.loadOlder, 0, '禁用状态下点击不能发请求');
});

t('首屏错误后手动 retry 阶段：loading=true, hasMore=false, error=null 时控制带必须可见且按钮禁用', () => {
  const { view, calls, bar, button, status } = makeView();
  // 模拟首屏报错：hasMore: false, error: Error('500')
  view.setState({ loading: false, hasMore: false, error: new Error('网络异常'), phase: 'initial' });
  assert.equal(bar.hidden, false, '报错时控制带可见');
  assert.equal(button.textContent, '重试');

  // 用户点击重试后，pager 进入 loading 阶段：loading: true, hasMore: false, error: null
  view.setState({ loading: true, hasMore: false, error: null, phase: 'initial' });
  assert.equal(bar.hidden, false, '手动 retry 阶段即使 hasMore 为 false，控制带也必须保持可见');
  assert.equal(button.textContent, '加载中…', '重试中按钮必须展示加载中文案');
  assert.equal(button.disabled, true, '重试中按钮必须禁用');
  assert.equal(status.textContent, '', '重试中错误信息应清空');

  button.dispatchEvent('click');
  assert.equal(calls.loadOlder, 0, 'loading 期间点击不能重复发请求');
});

t('加载完成且无更多（loading=false, hasMore=false, error=null）：控制带隐藏', () => {
  const { view, bar } = makeView();
  view.setState({ loading: false, hasMore: false, error: null });
  assert.equal(bar.hidden, true, '完成加载且无更多数据时控制带必须隐藏');
});

t('失败：显示「重试」和错误文案，点击可重试', () => {
  const { view, calls, button, status } = makeView();
  view.setState({ loading: false, hasMore: true, error: new Error('boom') });
  assert.equal(button.textContent, '重试');
  assert.equal(button.disabled, false);
  assert.ok(status.textContent.includes('加载更早失败'), `实际文案：${status.textContent}`);
  assert.ok(status.textContent.includes('boom'));
  button.dispatchEvent('click');
  assert.equal(calls.loadOlder, 1);
});

t('生成中（busy）：给出稍后重试提示，不用普通失败文案', () => {
  const { view, status } = makeView();
  const busy = new Error('正在生成回复，稍后再加载更早的消息');
  busy.code = 'busy';
  view.setState({ loading: false, hasMore: true, error: busy });
  assert.ok(status.textContent.includes('稍后'), `实际文案：${status.textContent}`);
  assert.ok(!status.textContent.includes('加载更早失败'), 'busy 不是普通失败');
});

t('首屏失败（phase=initial）：文案是「会话加载失败：...」', () => {
  const { view, status } = makeView();
  view.setState({
    loading: false,
    hasMore: false,
    error: new Error('502 Bad Gateway'),
    phase: 'initial',
  });
  assert.equal(status.textContent, '会话加载失败：502 Bad Gateway', `实际文案：${status.textContent}`);
  assert.ok(!status.textContent.includes('加载更早失败'), '首屏失败不能读成「翻页断了一半」');
});

t('翻页失败（phase=older）：文案是「加载更早失败：...」', () => {
  const { view, status } = makeView();
  view.setState({ loading: false, hasMore: true, error: new Error('boom'), phase: 'older' });
  assert.equal(status.textContent, '加载更早失败：boom', `实际文案：${status.textContent}`);
});

t('phase 缺失：按 older 兼容，文案仍是「加载更早失败：...」', () => {
  const { view, status } = makeView();
  view.setState({ loading: false, hasMore: true, error: new Error('boom') });
  assert.equal(status.textContent, '加载更早失败：boom', `实际文案：${status.textContent}`);
});

t('phase=initial 但 code=busy：说的是「重新加载会话」，不套失败前缀也不说「加载更早」', () => {
  const { view, status } = makeView();
  const busy = new Error('正在生成回复，稍后再加载更早的消息');
  busy.code = 'busy';
  view.setState({ loading: false, hasMore: true, error: busy, phase: 'initial' });
  assert.equal(status.textContent, '正在生成回复，稍后重新加载会话', `实际文案：${status.textContent}`);
  assert.ok(!status.textContent.includes('会话加载失败'), 'busy 不能套失败前缀');
  assert.ok(!status.textContent.includes('加载更早失败'), 'busy 不是普通失败');
  assert.ok(!status.textContent.includes('加载更早的消息'), '首屏被拦不是「加载更早」这个动作');
});

t('无 error：任何 phase 下都不显示错误文案', () => {
  for (const phase of ['initial', 'older', undefined]) {
    const { view, status } = makeView();
    view.setState({ loading: false, hasMore: true, error: null, phase });
    assert.equal(status.textContent, '', `phase=${phase} 无错误时不该有文案`);
  }
});

/* ------------------------------------------------------------------ */
/* prepend 结构 + 锚点位移补偿                                          */
/* ------------------------------------------------------------------ */

t('prepend：新节点插在旧消息前，旧节点不搬家，滚动位置按锚点位移回填', () => {
  const { container, view } = makeView();
  const oldTurn = makeEl('div');
  oldTurn.className = 'turn user';
  container.appendChild(oldTurn);
  container.scrollTop = 200;
  oldTurn.rect.top = 220;
  view.setState({ loading: true, hasMore: true, error: null });

  view.beginPrepend();
  assert.equal(view.isPrepending(), true);
  const earlyOne = makeEl('div');
  earlyOne.className = 'turn user';
  const earlyTwo = makeEl('div');
  earlyTwo.className = 'turn assistant';
  view.append(earlyOne);
  view.append(earlyTwo);

  const order = container.children.filter(
    (n) => !['history-pagination-bar', 'history-pagination-anchor'].includes(n.className),
  );
  assert.deepEqual(order, [earlyOne, earlyTwo, oldTurn], '更早页必须插在旧消息之前，且保持页内顺序');
  assert.equal(oldTurn.parentNode, container, '旧消息节点不能被移除重建');

  // 更早页在同步渲染里撑开 300px：旧的第一条被顶下去 300（夹具不做布局，位移由用例显式给出）。
  pushDown(oldTurn, 300);
  container.scrollHeight = 1300;

  view.endPrepend();
  assert.equal(view.isPrepending(), false);
  assert.ok(!container.children.some((n) => n.className === 'history-pagination-anchor'), '拼接完成后锚点必须移除');
  assert.ok(container.children.includes(earlyOne) && container.children.includes(earlyTwo), '更早页节点必须留在容器里');
  assert.equal(container.scrollTop, 500, 'scrollTop 必须按锚点位移回填（200 + 300）');
  assert.equal(oldTurn.rect.top, 220, '补完之后锚点必须回到原来的视口位置');
});

t('滚动补偿量来自锚点位移，不是 scrollHeight 差：只涨高度不动锚点就不补', () => {
  const { container, view, oldTurn, OLD_TOP } = setupPrepend({ syncGrowth: 0 });
  // 预置：prepend 期间 scrollHeight 一直在涨（内容在下面长），但旧消息的位置没动。
  container.scrollHeight = 4000;
  view.endPrepend();
  assert.equal(container.scrollTop, 200, 'scrollHeight 涨了 3000 也不能算成 prepend 高度');
  assert.equal(oldTurn.rect.top, OLD_TOP, '锚点没动过，位置本来就该稳住');
});

t('prepend 落地后：锚点上方晚到的高度继续补进 scrollTop', () => {
  const { container, view, oldTurn, clock, OLD_TOP } = setupPrepend({ syncGrowth: 300 });
  view.endPrepend();
  assert.equal(container.scrollTop, 500, '夹具：同步这一次先按锚点位移回填');

  // 图片 / 卡片 iframe 在之后陆续撑开：它们在 prepend 的内容里，把锚点继续往下推。
  pushDown(oldTurn, 220);
  container.scrollHeight = 1520;
  clock.advance(100);
  assert.equal(container.scrollTop, 720, '晚到 220px 也要补进 scrollTop，用户正在看的那行不能往下跑');
  assert.equal(oldTurn.rect.top, OLD_TOP, '补完之后锚点仍在原位');

  pushDown(oldTurn, 100);
  container.scrollHeight = 1620;
  clock.advance(100);
  assert.equal(container.scrollTop, 820, '连续晚到的位移要累计补偿');

  // 窗口（1.2 秒）结束后收手。
  clock.advance(2000);
  pushDown(oldTurn, 500);
  clock.advance(500);
  assert.equal(container.scrollTop, 820, '补偿窗口结束后锚点再被推也不许动用户的位置');
});

t('生成中：锚点下方的流式增长不触发补偿（核心验收）', () => {
  const { container, view, oldTurn, clock, OLD_TOP } = setupPrepend({ syncGrowth: 300 });
  // 请求还在飞的时候助手就在下面往下长：scrollHeight 又涨 400，锚点 top 一动不动。
  container.scrollHeight += 400;

  view.endPrepend();
  assert.equal(container.scrollTop, 500, '只补 prepend 的 300，流式增长的 400 一分都不能算进来');
  assert.equal(oldTurn.rect.top, OLD_TOP, '锚点回到原位');

  // 观察窗口里流式继续涨：每次采样只看到 scrollHeight 变大。
  container.scrollHeight += 600;
  clock.advance(100);
  container.scrollHeight += 600;
  clock.advance(100);
  assert.equal(container.scrollTop, 500, '流式增长发生在锚点下方，不能触发补偿');
  assert.equal(oldTurn.rect.top, OLD_TOP, '也不会把锚点拖离原位');

  clock.advance(2000);
  container.scrollHeight += 600;
  clock.advance(500);
  assert.equal(container.scrollTop, 500, '窗口内外都不许因流式增长改 scrollTop');
});

t('prepend 结束后用户自己滚动：立刻停止补偿，以用户位置为准', () => {
  const { container, view, oldTurn, clock } = setupPrepend({ syncGrowth: 300 });
  view.endPrepend();
  assert.equal(container.scrollTop, 500);

  // 用户往上翻了一点：滚动事件报告的位置和补偿预期对不上。
  container.scrollTop = 460;
  container.dispatchEvent('scroll');

  pushDown(oldTurn, 200);
  container.scrollHeight = 1500;
  clock.advance(300);
  assert.equal(container.scrollTop, 460, '用户自己滚过之后不许抢滚动位置');

  pushDown(oldTurn, 200);
  container.scrollHeight = 1700;
  clock.advance(500);
  assert.equal(container.scrollTop, 460, '停止之后更不能偷偷补偿');
  assert.equal(clock.pending(), 0, '用户滚动后观察定时器要收掉');
});

t('观察期间锚点被移除：结束观察，不退回高度法', () => {
  const { container, view, oldTurn, clock } = setupPrepend({ syncGrowth: 300 });
  view.endPrepend();
  assert.equal(container.scrollTop, 500);

  // 锚点被重绘换掉：此后分不清「上面插进来的」和「下面流式长出来的」，只能收手。
  container.removeChild(oldTurn);
  container.scrollHeight = 2600;
  clock.advance(100);
  assert.equal(container.scrollTop, 500, '锚点消失后不许按高度继续补偿');
  assert.equal(clock.pending(), 0, '锚点消失后不能再挂定时器');
});

t('容器里没有旧内容（没有锚点）：不动 scrollTop，也不开观察窗口', () => {
  const { container, view, clock } = makeView();
  container.scrollTop = 0;
  view.setState({ loading: true, hasMore: true, error: null });

  view.beginPrepend();
  view.append(makeEl('div'));
  container.scrollHeight = 500;
  view.endPrepend();

  assert.equal(container.scrollTop, 0, '没有可参照的旧内容就不存在「保持阅读位置」这件事');
  assert.equal(clock.pending(), 0, '没有锚点就别开观察窗口');
});

t('reset 之后晚到的位移不再补偿', () => {
  const { container, view, oldTurn, clock } = setupPrepend({ syncGrowth: 300 });
  view.endPrepend();

  view.reset();
  pushDown(oldTurn, 400);
  container.scrollHeight = 1800;
  clock.advance(300);
  assert.equal(container.scrollTop, 500, 'reset 之后不能再补');
  assert.equal(clock.pending(), 0, 'reset 要把观察定时器一起收掉');
});

t('重新开始一页 prepend：上一页的补偿先停，不会把两页的增量叠在一起', () => {
  const { container, view, clock } = makeView();
  const oldTurn = makeEl('div');
  container.appendChild(oldTurn);
  container.scrollTop = 200;
  oldTurn.rect.top = 220;
  view.setState({ loading: true, hasMore: true, error: null });

  view.beginPrepend();
  const page1 = makeEl('div');
  view.append(page1);
  pushDown(oldTurn, 200);
  container.scrollHeight = 1200;
  view.endPrepend();
  assert.equal(container.scrollTop, 400, '第一页：200 + 200');
  assert.equal(oldTurn.rect.top, 220);
  const page1Top = page1.rect.top;

  // 第一页的晚到位移还没来，用户就点了第二次「加载更早」。
  view.beginPrepend();
  assert.equal(clock.pending(), 0, 'beginPrepend 必须停掉上一页的观察');

  view.append(makeEl('div'));
  // 新一页插在第一页上面：第一页那条（第二页的锚点）和它下面的旧消息一起被往下推 300。
  pushDown(page1, 300);
  pushDown(oldTurn, 300);
  container.scrollHeight = 1500;
  view.endPrepend();
  assert.equal(container.scrollTop, 700, '新一页按自己的锚点位移回填（400 + 300）');
  assert.equal(page1.rect.top, page1Top, '第一页那条回到它在第二页开始前的位置');
  assert.equal(oldTurn.rect.top, 220, '两页下来用户的阅读位置没动');

  clock.advance(2000);
  assert.equal(container.scrollTop, 700, '旧页残留的补偿不能再动位置');
});

/* ------------------------------------------------------------------ */
/* 其它结构行为                                                        */
/* ------------------------------------------------------------------ */

t('实时消息（无 prepend）追加到末尾', () => {
  const { container, view } = makeView();
  const oldTurn = makeEl('div');
  container.appendChild(oldTurn);
  const live = makeEl('div');
  view.append(live);
  assert.equal(container.children[container.children.length - 1], live, '实时消息应追加到末尾');
});

t('容器被清空后，控制带能重新挂回第一个子节点', () => {
  const { container, view, bar } = makeView();
  container.children = []; // 模拟 #transcript.innerHTML = ''
  bar.parentNode = null;
  view.setState({ loading: false, hasMore: true, error: null });
  assert.equal(container.children[0], bar, '清空后 setState 应把控制带重新挂回最前');
});

t('reset：隐藏控制带、撤销 prepend 锚点', () => {
  const { container, view, bar } = makeView();
  view.setState({ loading: false, hasMore: true, error: null });
  view.beginPrepend();
  view.reset();
  assert.equal(view.isPrepending(), false);
  assert.equal(bar.hidden, true);
  assert.ok(!container.children.some((n) => n.className === 'history-pagination-anchor'), '锚点必须移除');
});

t('dispose：移除监听并摘掉控制带，之后点击不回调', () => {
  const { container, view, calls, button } = makeView();
  view.setState({ loading: false, hasMore: true, error: null });
  view.dispose();
  button.dispatchEvent('click');
  assert.equal(calls.loadOlder, 0, 'dispose 后不能再回调');
  assert.ok(!container.children.includes(button.parentNode), '控制带应被摘掉');
});

t('模块边界：不 fetch、不读 S、不 import 业务模块', () => {
  const raw = readFileSync(new URL('../web/history-pagination-view.js', import.meta.url), 'utf8');
  // 去掉注释再查，避免注释里的说明文字误报。
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bfetch\s*\(/.test(source), 'view 不能发请求');
  assert.ok(!/\bS\.[A-Za-z]/.test(source), 'view 不能读 app 的 S');
  assert.ok(!/^\s*import\s/m.test(source), 'view 不应 import 任何业务模块');
});

t('请求期间用户自己滚动：只补 prepend 的高度，不吃掉用户滚的那一段', () => {
  const { container, view, oldTurn } = setupPrepend({ syncGrowth: 300 });
  // 等网络时用户又往上翻了 100（scrollTop 200 → 100），锚点在视口里因此下移 100。
  container.scrollTop = 100;
  assert.equal(oldTurn.rect.top, 620, '夹具：用户上翻后锚点应在 620');

  view.endPrepend();
  assert.equal(container.scrollTop, 400, '用户滚的 100 要保留，只加 prepend 的 300');
  assert.equal(
    oldTurn.rect.top,
    320,
    '锚点应在「没长高时用户原本该看到的位置」：300 也被补回去，但 100 不能被抵消',
  );
});

t('补偿窗口内临时关掉浏览器锚定，窗口结束必须还原', () => {
  const { container, view, clock } = setupPrepend({ syncGrowth: 300 });
  assert.equal(container.style.overflowAnchor, 'none', '窗口期要关掉浏览器自己的锚定');
  view.endPrepend();
  assert.equal(container.style.overflowAnchor, 'none', '观察窗口里仍然关闭');
  clock.advance(2000);
  assert.equal(container.style.overflowAnchor, '', '窗口结束必须还原，不能永久残留');
});

/* ------------------------------------------------------------------ */
/* G7：程序化滚动的认领（记账）                                          */
/* ------------------------------------------------------------------ */

t('G9 程序化写 scrollTop 后派发 scroll：我自己的补偿写入不会被当成用户滚动', () => {
  const ctx = setupPrepend({ syncGrowth: 300, echo: true });
  ctx.view.endPrepend();
  assert.equal(ctx.container.scrollTop, 500, '夹具：同步回填到 500');
  assert.equal(ctx.scroll.flush(), true, '夹具：程序化写必须排一个 scroll 事件');

  pushDown(ctx.oldTurn, 200);
  ctx.container.scrollHeight = 1500;
  ctx.clock.advance(100);
  assert.equal(ctx.container.scrollTop, 700, '认领自己的写入之后，窗口不能提前收手');
  assert.equal(ctx.oldTurn.rect.top, ctx.OLD_TOP, '锚点仍在原位');
});

t('G7 装配层报备过的程序化滚动（恢复阅读位置）不打断补偿窗口', () => {
  const ctx = setupPrepend({ syncGrowth: 300, echo: true });
  ctx.view.endPrepend();
  ctx.scroll.flush();

  // restorePendingScroll 的等价物：滚到记录的阅读位置（不是底部，所以不会被 clamp）。
  ctx.container.scrollHeight = 3000;
  ctx.container.scrollTop = 1200;
  ctx.view.noteProgrammaticScroll(1200);
  ctx.scroll.flush();

  pushDown(ctx.oldTurn, 150);
  ctx.clock.advance(100);
  assert.equal(
    ctx.container.scrollTop,
    1350,
    '报备过的写入不能打断补偿窗口：晚到的 prepend 高度照样补（1200 + 150）',
  );
});

t('G7 没报备的写入仍按用户滚动处理：窗口立刻收手（安全方向）', () => {
  const ctx = setupPrepend({ syncGrowth: 300, echo: true });
  ctx.view.endPrepend();
  ctx.scroll.flush();

  ctx.container.scrollHeight = 3000;
  ctx.container.scrollTop = 1200; // 没调 noteProgrammaticScroll
  ctx.scroll.flush();

  pushDown(ctx.oldTurn, 150);
  ctx.clock.advance(100);
  assert.equal(ctx.container.scrollTop, 1200, '不认领的写入按用户滚动处理，位置以它为准');
  assert.equal(ctx.clock.pending(), 0, '窗口要收掉');
});

/* ------------------------------------------------------------------ */
/* G8：负位移（控制带收起）的补偿                                        */
/* ------------------------------------------------------------------ */

t('G8 控制带收起后锚点上方少了高度：负位移按记账额度补回来', () => {
  const ctx = setupPrepend({ syncGrowth: 300 });
  ctx.view.endPrepend();
  assert.equal(ctx.container.scrollTop, 500);
  assert.equal(ctx.oldTurn.rect.top, ctx.OLD_TOP);
  ctx.container.scrollHeight = 3000; // 上下都留余量，不会被 clamp 干扰

  // 控制带高 50px，挂在容器第一个子节点（锚点上方）。
  ctx.bar.rect.height = 50;
  ctx.bar.rect.bottom = 50;
  // pager 先 onPage 再 onState：prepend 落地之后才把控制带隐藏（hasMore 用完了）。
  ctx.view.setState({ loading: false, hasMore: false, error: null });
  assert.equal(ctx.bar.hidden, true, '夹具：最后一页要把控制带收起来');

  // 布局事实：控制带在锚点上方，收起后整块内容上移 50。
  pushDown(ctx.oldTurn, -50);
  ctx.scroll.setScrollHeight(2950);
  ctx.clock.advance(100);

  assert.equal(ctx.container.scrollTop, 450, '负位移要按记账额度补回来（500 - 50）');
  assert.equal(ctx.oldTurn.rect.top, ctx.OLD_TOP, '补完之后锚点仍在原来的视口位置（内容坐标等价）');

  // 额度用完：再缩水就不补了。“外部内容自己塌下去”不是“我改了高度”。
  pushDown(ctx.oldTurn, -30);
  ctx.clock.advance(100);
  assert.equal(ctx.container.scrollTop, 450, '没有记账额度的缩水不补，只跟基准');
});

t('G8 用户向上滚动的意图不被负位移补偿抵消（scroll 事件晚到一拍也不补）', () => {
  const ctx = setupPrepend({ syncGrowth: 300, echo: true });
  ctx.view.endPrepend();
  ctx.scroll.flush();
  ctx.container.scrollHeight = 3000;

  ctx.bar.rect.height = 50;
  ctx.view.setState({ loading: false, hasMore: false, error: null });

  // 用户往上翻 100：位置已经不是“我写的那个值”，而 scroll 事件还没到（不 flush）。
  ctx.container.scrollTop = 400;
  // 控制带收起的高度变化这时才落地。
  pushDown(ctx.oldTurn, -50);
  ctx.scroll.setScrollHeight(2950);
  ctx.clock.advance(100);

  assert.equal(ctx.container.scrollTop, 400, '用户刚滚过就交给用户：宁可少补一像素');

  ctx.scroll.flush();
  assert.equal(ctx.clock.pending(), 0, '事件到了之后窗口照旧收手');
});

/* ------------------------------------------------------------------ */
/* G9：夹具 clamp 与 expectTop 的正确性                                  */
/* ------------------------------------------------------------------ */

t('G9 夹具 clamp scrollHeight - clientHeight：补不到的位置不硬塞，也不反复补', () => {
  const ctx = setupPrepend({ syncGrowth: 300 });
  // 容器只能滚到 200（1000 - 800）：想补到 500 也到不了。
  ctx.container.scrollHeight = 1000;
  ctx.view.endPrepend();

  assert.equal(ctx.container.scrollTop, 200, '写 500 被容器 clamp 到 maxScroll=200');
  assert.equal(ctx.oldTurn.rect.top, ctx.OLD_TOP + 300, '补不到就是补不到：锚点仍在下面 300，不造假');

  ctx.clock.advance(300);
  assert.equal(ctx.container.scrollTop, 200, 'clamp 之后不许反复补（基线要按实测复位）');
  assert.equal(ctx.oldTurn.rect.top, ctx.OLD_TOP + 300, '也不会把锚点再推动');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
