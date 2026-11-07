/* tests/subagent_bar.test.mjs — 输入框上方的「运行中子代理」胶囊（web/subagent-bar.js）
 *
 * 起点：桌面端把分身进度挂在输入区上方，手机端只有正文里的大卡片，
 * 跑到一半想知道「谁在干活」得往下翻。这里钉住胶囊的契约：
 * 1. 只有 subagent 的 content_block / block_update 会生成胶囊，别的动静一律忽略；
 * 2. 同一 taskId 多次事件是更新，不是叠加；
 * 3. 终态（done / failed / aborted）把胶囊收掉；
 * 4. 拿不到头像就画名字首字，avatarUrlById 抛错也不能把整个事件链带崩；
 * 5. 没有挂载点时所有方法都能调、不抛错。
 *
 * 夹具纪律（这几条是修过的坑，别退回去）：
 *   - 每个用例都注入 makeClock()，不用真 setInterval：否则跑完整个文件期间，
 *     废弃假节点上还在每秒回调，进程退出只靠 unref 兜着；
 *   - 每个用例结束都 bar.destroy()：摘监听、停表、把栏从挂载点摘掉；
 *   - setAttribute 真的记进 Map（以前是空实现，aria-label / role 写进去就消失，
 *     任何属性回归都看不见）；
 *   - 计时起点用 0 起步的时钟，专门钉「0 是合法起点，不是「不知道开始时间」」。
 */

import assert from 'node:assert/strict';
import { createSubagentBar, statusTextOf } from '../web/subagent-bar.js';

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

/* 最小 DOM 夹具：只实现 subagent-bar 用到的 API */
function makeDoc() {
  const mk = (tag) => {
    const attrs = new Map();
    return {
      tagName: tag,
      children: [],
      dataset: {},
      hidden: false,
      className: '',
      textContent: '',
      src: '',
      listeners: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      // 属性要留下来：role / aria-label 是胶囊对读屏器的全部交代，空实现等于没测
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      insertBefore(child) { this.children.unshift(child); child.parentNode = this; return child; },
      remove() {
        const p = this.parentNode;
        if (!p) return;
        p.children = p.children.filter((c) => c !== this);
        this.parentNode = null;
      },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      get firstChild() { return this.children[0] || null; }
    };
  };
  // 文档自己也是一个事件目标（visibilitychange 挂在它上面）
  const doc = makeTarget({ createElement: (tag) => mk(tag), hidden: false, visibilityState: 'visible' });
  return doc;
}

/** 可注入的事件目标：记录监听，能主动派发，也能验证监听被摘掉。 */
function makeTarget(base = {}) {
  base.listeners = {};
  base.addEventListener = (name, fn) => { (base.listeners[name] ||= []).push(fn); };
  base.removeEventListener = (name, fn) => {
    base.listeners[name] = (base.listeners[name] || []).filter((f) => f !== fn);
  };
  base.fire = (name) => { for (const fn of [...(base.listeners[name] || [])]) fn({ type: name }); };
  return base;
}

/** 假时钟：手动推进，记下定时器回调被叫了几次、还有几个在跑。
 *  默认从 0 起：起点为 0 也得能正常计时（不能把 0 当「没有开始时间」）。 */
function makeClock(start = 0) {
  let now = start;
  let seq = 0;
  let calls = 0;
  const timers = new Map();
  return {
    now: () => now,
    setInterval(fn) { seq += 1; timers.set(seq, () => { calls += 1; fn(); }); return seq; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const fn of [...timers.values()]) fn();
    },
    get calls() { return calls; },
    get active() { return timers.size; }
  };
}

const subagentBlock = (extra = {}) => ({
  type: 'content_block',
  block: { type: 'subagent', taskId: 't1', agentName: '寻迹', streamStatus: 'running', ...extra }
});

/** 一条 block_update：胶囊的第二种（也是唯一另一种）输入。 */
const update = (taskId, patch) => ({ type: 'block_update', taskId, patch });

t('子代理事件生成一条胶囊：名字 + 计时 + 状态点 + 无 onOpen 时不可点（桌面端同位）', () => {
  const doc = makeDoc();
  const mount = doc.createElement('div');
  const bar = createSubagentBar({ document: doc, mount, clock: makeClock() });
  const ok = bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't1', agentName: '寻迹', streamStatus: 'running' }
  });
  assert.equal(ok, true);
  assert.equal(bar.element.hidden, false);
  const chip = bar.element.children[0];
  // 文字只写名字；“运行中”不再占胶囊宽度，改成点的颜色 + aria-label
  assert.match(chip.children[1].textContent, /寻迹/);
  assert.match(chip.children[2].textContent, /^\d+:\d{2}$/, '第二段是已跑时长（分:秒）');
  assert.equal(chip.dataset.status, 'running', '状态仍落在 dataset 上，用来上点的颜色');
  // 读屏器只有 aria-label 可读：名字和状态都必须进得去（以前 setAttribute 是空实现，这条过不了）
  const label = chip.getAttribute('aria-label');
  assert.equal(typeof label, 'string', '胶囊必须有 aria-label');
  assert.match(label, /寻迹/, 'aria-label 要念得出是谁');
  assert.match(label, /运行中/, 'aria-label 要念得出在跑什么状态');
  // 没接 onOpen 就不装可点能力，也不加可点暗示
  assert.equal(chip.getAttribute('role'), null, '没接 onOpen 不该声明成按钮');
  assert.equal(chip.classList.contains('is-openable'), false, '没接 onOpen 不该加可点样式');
  bar.destroy();
});

t('同一 taskId 再来事件是更新，不是叠加，而且补丁真的写回去了', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 't1', agentName: '寻迹' } });
  const chip = bar.element.children[0];
  const labelEl = chip.children[1];
  assert.equal(labelEl.textContent, '寻迹');

  bar.consume({
    type: 'block_update',
    taskId: 't1',
    patch: { streamStatus: 'running', label: '审查2：收尾', agentName: 'DeepSeek' },
  });
  assert.equal(bar.element.children.length, 1, '不能叠出第二个胶囊');
  assert.equal(bar.element.children[0], chip, '还是同一个节点，原地更新');
  assert.equal(bar.list().length, 1, '表里也只能有一条');
  // 只断言长度的话，「更新」写成「什么都不做」也能过；这里钉住补丁真的落到 DOM 上
  assert.equal(labelEl.textContent, '审查2', '后到的 label 要顶掉执行者名字');
  assert.equal(bar.list()[0].status, 'running');
  assert.match(chip.getAttribute('aria-label'), /审查2/);
  bar.destroy();
});

t('胶囊要能分辨是哪一个：有派活标题就显标题，不靠同名执行者区分', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 'r1', label: '审查1：分页器', agentName: 'DeepSeek', streamStatus: 'running' },
  });
  // 后续 update 只带 agentName，不能把标题冲掉回「DeepSeek」
  bar.consume({ type: 'block_update', taskId: 'r1', patch: { streamStatus: 'running', agentName: 'DeepSeek' } });
  assert.equal(bar.element.children[0].children[1].textContent, '审查1');
  bar.destroy();
});

/**
 * 给胶囊接一个「跟着 class 缩」的宽度：真 DOM 里 .is-dense 会把胶囊压窄，
 * 假 DOM 不会，所以这里显式模拟宽 → 窄，否则 syncDensity 的第一阶是死分支，
 * 实现「永远直接 compact」也照样绿。
 */
function fakeShrink(bar, { full = 80, dense = 40 } = {}) {
  for (const chip of bar.element.children) {
    Object.defineProperty(chip, 'offsetWidth', {
      configurable: true,
      get: () => (bar.element.classList.contains('is-dense') ? dense : full),
    });
  }
}

const twoChips = (bar) => {
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 'a', agentName: '很长很长的分身名字', streamStatus: 'running' } });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 'b', agentName: '另一个很长的名字', streamStatus: 'running' } });
};

t('放不下先压窄：压窄后就够用时只加 is-dense，不跳到只剩头像', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  twoChips(bar);
  bar.element.clientWidth = 100;          // 两个 80 + 间距 6 = 166 > 100
  fakeShrink(bar);                        // 压窄后 40*2 + 6 = 86 ≤ 100
  bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
  assert.equal(bar.element.classList.contains('is-dense'), true, '先试压窄');
  assert.equal(bar.element.classList.contains('is-compact'), false, '压窄够用就不该只剩头像');
  bar.destroy();
});

t('压窄还放不下才切紧凑：只留头像', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  twoChips(bar);
  bar.element.clientWidth = 70;           // 压窄后 86 仍然 > 70
  fakeShrink(bar);
  bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
  assert.equal(bar.element.classList.contains('is-dense'), true, '第一阶还是要先试');
  assert.equal(bar.element.classList.contains('is-compact'), true, '放不下就整排转紧凑');
  bar.destroy();
});

t('宽度回来就把两阶收缩都摘掉（不能留着 is-dense / is-compact）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  twoChips(bar);
  bar.element.clientWidth = 70;
  fakeShrink(bar);
  bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
  assert.equal(bar.element.classList.contains('is-compact'), true, '先确认已经收紧了');

  bar.element.clientWidth = 400;          // 转屏 / 收起键盘后空间回来了
  bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
  assert.equal(bar.element.classList.contains('is-dense'), false, '空间够了要摘掉压窄');
  assert.equal(bar.element.classList.contains('is-compact'), false, '空间够了要摘掉紧凑');
  bar.destroy();
});

t('历史回灌的胶囊不编造计时（块里没有开始时间）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(
    { type: 'content_block', block: { type: 'subagent', taskId: 'h1', agentName: 'DeepSeek', streamStatus: 'running' } },
    { startUnknown: true }
  );
  const chip = bar.element.children[0];
  assert.equal(chip.children[2].textContent, '', '不知道开始时间就不显示计时');
  assert.equal(chip.children[2].hidden, true, '空计时不能留一个空白段占位');
  bar.destroy();
});

t('计时：起点 0 是合法起点，后到的补丁不能把 startedAt 重置成「现在」', () => {
  const doc = makeDoc();
  const clock = makeClock(0);             // 时钟从 0 起：0 不能被当成「没有开始时间」
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock());
  const timeEl = bar.element.children[0].children[2];
  assert.equal(timeEl.textContent, '0:00', '刚派活是 0:00');

  clock.advance(3000);
  // 实现若写成 `prev.startedAt || nowFn()`，这里会从 0 重新起算变成 0:00；
  // 用 `??` 才是「只在真的没有起点时才取现在」。
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', agentName: '寻迹' } });
  assert.equal(timeEl.textContent, '0:03', '补丁来了不能重置起点');

  clock.advance(4000);
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running' } });
  assert.equal(timeEl.textContent, '0:07', '多条补丁之后仍然按第一次见到的起点算');
  assert.equal(bar.list()[0].startedAt, 0, '起点就是 0，不该被改写成后来某个时刻');
  bar.destroy();
});

t('终态把胶囊收掉', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 't1', agentName: '寻迹' } });
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'done' } });
  assert.equal(bar.element.children.length, 0);
  assert.equal(bar.element.hidden, true);
  bar.destroy();
});

t('不是子代理的事件一律不碰', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  assert.equal(bar.consume({ type: 'content_block', block: { type: 'text' } }), false);
  assert.equal(bar.consume({ type: 'block_update', taskId: 'x', patch: { summary: 'hi' } }), false);
  assert.equal(bar.consume(null), false);
  assert.equal(bar.element.hidden, true);
  bar.destroy();
});

t('没有头像地址就画名字首字', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({
    document: doc, mount: doc.createElement('div'), clock: makeClock(), avatarUrlById: () => null
  });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 't1', agentName: '寻迹' } });
  assert.equal(bar.element.children[0].children[0].textContent, '寻');
  bar.destroy();
});

t('avatarUrlById 抛错也不影响事件链', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    avatarUrlById: () => { throw new Error('boom'); }
  });
  assert.equal(bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 't1', agentName: '寻迹' } }), true);
  assert.equal(bar.element.children.length, 1);
  bar.destroy();
});

t('有头像地址时渲染 img', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    avatarUrlById: (id) => `/api/agents/${id}/avatar`
  });
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't1', agentName: '寻迹', executorAgentId: 'hana-explorer' }
  });
  const avatar = bar.element.children[0].children[0];
  assert.equal(avatar.children[0].src, '/api/agents/hana-explorer/avatar');
  bar.destroy();
});

t('没有挂载点：全部降级，不抛错', () => {
  const bar = createSubagentBar({ document: makeDoc(), mount: null, clock: makeClock() });
  assert.equal(bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 't1' } }), false);
  assert.equal(bar.remove('t1'), false);
  bar.clear();
  assert.deepEqual(bar.list(), []);
  bar.destroy();
});

t('clear 收掉所有胶囊（切会话用）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 'a', agentName: 'A' } });
  bar.consume({ type: 'content_block', block: { type: 'subagent', taskId: 'b', agentName: 'B' } });
  assert.equal(bar.element.children.length, 2);
  bar.clear();
  assert.equal(bar.element.children.length, 0);
  assert.equal(bar.element.hidden, true);
  bar.destroy();
});

/* ---------- 收尾四件：后台停表 / destroy / 头像去重 / 载荷补全 ---------- */

t('G1 切后台就停表：隐藏后 ticker 不再回调，回来再起，计时按 startedAt 现算不归零', () => {
  const visual = makeTarget({});
  const view = makeTarget({ visualViewport: visual });
  const doc = makeDoc();
  doc.defaultView = view;
  const clock = makeClock(0);
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock());
  const timeEl = bar.element.children[0].children[2];
  assert.equal(clock.active, 1, '有胶囊就有计时器');
  clock.advance(1000);
  assert.equal(clock.calls, 1);
  assert.equal(timeEl.textContent, '0:01');

  // 切到后台：停表，之后的每秒不再白白唤醒
  doc.hidden = true;
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  assert.equal(clock.active, 0, '隐藏时把计时器摘掉');
  clock.advance(5000);
  assert.equal(clock.calls, 1, '后台期间回调次数不再增长');

  // 回前台：还有条目就重新起表，而且不是从 0:00 重来
  doc.hidden = false;
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  assert.equal(clock.active, 1, '回来后重新起表');
  clock.advance(1000);
  assert.equal(clock.calls, 2);
  assert.equal(timeEl.textContent, '0:07', '计时从 startedAt 现算，切后台再回来不归零');
  bar.destroy();
});

t('G1 没有条目时回前台不空转：不建表', () => {
  const doc = makeDoc();
  const clock = makeClock(0);
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock());
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'done' } });
  assert.equal(clock.active, 0, '全部收掉本来就停表');
  doc.hidden = true;
  doc.fire('visibilitychange');
  doc.hidden = false;
  doc.fire('visibilitychange');
  assert.equal(clock.active, 0, '没有条目就没有要刷的，别起空表');
  bar.destroy();
});

t('G1 visibilitychange 只在工厂里注册一次', () => {
  const doc = makeDoc();
  const clock = makeClock(0);
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock());
  bar.consume(subagentBlock());
  bar.consume(subagentBlock({ taskId: 't2', agentName: 'DeepSeek' }));
  assert.equal((doc.listeners.visibilitychange || []).length, 1, '多一条事件不能多挂一个监听');
  bar.destroy();
});

t('G2 destroy() 摘监听、清胶囊、停表，之后 consume 无效且不再建节点', () => {
  const visual = makeTarget({});
  const view = makeTarget({ visualViewport: visual });
  const doc = makeDoc();
  doc.defaultView = view;
  const clock = makeClock(0);
  const mount = doc.createElement('div');
  const bar = createSubagentBar({ document: doc, mount, clock });
  assert.equal(typeof bar.destroy, 'function', '返回对象里要有 destroy');
  assert.equal(doc.listeners.visibilitychange.length, 1);
  assert.equal(view.listeners.resize.length, 1);
  assert.equal(visual.listeners.resize.length, 1);

  bar.consume(subagentBlock());
  assert.equal(bar.element.children.length, 1);
  assert.equal(clock.active, 1);

  bar.destroy();
  assert.equal(doc.listeners.visibilitychange.length, 0, 'visibilitychange 要摘');
  assert.equal(view.listeners.resize.length, 0, 'resize 要摘');
  assert.equal(visual.listeners.resize.length, 0, 'visualViewport.resize 要摘');
  assert.equal(clock.active, 0, '计时器要停');
  assert.deepEqual(bar.list(), [], '胶囊要清');
  assert.equal(mount.children.length, 0, '栏自己也从挂载点摘掉');

  assert.equal(bar.consume(subagentBlock({ taskId: 't9' })), false, '拆了以后不再接事件');
  assert.equal(bar.element.children.length, 0, '也不再建节点');
  assert.equal(bar.remove('t9'), false);
  bar.clear();
  bar.destroy(); // 幂等：再拆一次不抛错
});

t('G3 同一个头像连续事件不重建 <img>，换身份才重画（含回落到首字）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    avatarUrlById: (id) => (id === 'a1' ? '/api/agents/a1/avatar' : null)
  });
  bar.consume(subagentBlock({ executorAgentId: 'a1' }));
  const avatar = bar.element.children[0].children[0];
  const first = avatar.children[0];
  assert.equal(first.src, '/api/agents/a1/avatar');

  // 同一身份再来两条事件：节点原地不动（不新建、不闪白）
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', agentName: '寻迹', executorAgentId: 'a1' } });
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', executorAgentId: 'a1' } });
  assert.equal(avatar.children.length, 1, '同一个地址不会叠出第二张图');
  assert.equal(avatar.children[0], first, '而且就是原来那个 <img>，没重建');

  // 换成没头像的身份：首字进 key，所以要重画，不能留着一张旧图
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', executorAgentId: 'a2' } });
  assert.equal(avatar.children.length, 0, '没图的身份不能留着旧 <img>');
  assert.equal(avatar.textContent, '寻', '回落到名字首字');
  assert.equal(avatar.classList.contains('has-image'), false);

  // 没有头像的条目反复更新：不来回擦写首字
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running' } });
  assert.equal(avatar.textContent, '寻');
  assert.equal(avatar.children.length, 0);
  bar.destroy();
});

t('G3 头像换地址会重建 <img>', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    avatarUrlById: (id) => (id ? `/api/agents/${id}/avatar` : null)
  });
  bar.consume(subagentBlock({ executorAgentId: 'a1' }));
  const avatar = bar.element.children[0].children[0];
  const first = avatar.children[0];
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', executorAgentId: 'a2' } });
  assert.equal(avatar.children.length, 1);
  assert.notEqual(avatar.children[0], first, '地址变了要重建');
  assert.equal(avatar.children[0].src, '/api/agents/a2/avatar');
  bar.destroy();
});

t('G4 onOpen 载荷含 task / model（详情页的「它被要求」与「角色 · 模型」）', () => {
  const doc = makeDoc();
  const seen = [];
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    onOpen: (target) => seen.push(target)
  });
  bar.consume(subagentBlock({
    label: '审查1：分页器',
    executorAgentId: 'hana-deepseek',
    model: 'deepseek-v4',
    task: '把分页器的边界条件补上'
  }));
  const chip = bar.element.children[0];
  // 接了 onOpen 才是可点的：role/aria 与会话身份一起钉住
  assert.equal(chip.getAttribute('role'), 'button', '接了 onOpen 要声明成按钮');
  assert.equal(chip.tabIndex, 0, '接了 onOpen 要能 Tab 到');
  assert.equal(chip.classList.contains('is-openable'), true);

  chip.listeners.click[0]();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].task, '把分页器的边界条件补上', '派活原文要透传');
  assert.equal(seen[0].model, 'deepseek-v4', '模型要透传');

  // 后到的补丁带来的 model 也要能被点出来
  bar.consume({ type: 'block_update', taskId: 't1', patch: { streamStatus: 'running', model: 'deepseek-v4-pro' } });
  chip.listeners.click[0]();
  assert.equal(seen[1].model, 'deepseek-v4-pro');
  assert.equal(seen[1].task, '把分页器的边界条件补上', '补丁没带 task 不能把原文冲掉');
  bar.destroy();
});

t('G4 没有 task / model 时给 null，不编字段', () => {
  const doc = makeDoc();
  const seen = [];
  const bar = createSubagentBar({
    document: doc,
    mount: doc.createElement('div'),
    clock: makeClock(),
    onOpen: (target) => seen.push(target)
  });
  bar.consume(subagentBlock());
  bar.element.children[0].listeners.click[0]();
  assert.equal(seen[0].task, null);
  assert.equal(seen[0].model, null);
  bar.destroy();
});

/* ---------- 第二轮：终态记忆 / 状态别名 / 名字链 / 首字 / 门槛 ----------
 * 这一批盯的是「宿主事件顺序不讲武德」的那些缝：终态可能比胶囊早到、
 * running 可能在终态之后才补过来、补丁里可能只有 id 没有名字。
 */

t('1 终态先到、带 running 的 content_block 后到不复活', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  // 宿主顺序：finishRun 先到（这时可能连胶囊都没建过），tool_end 之后还会补一条 running
  assert.equal(bar.consume(update('t1', { streamStatus: 'done', agentName: '寻迹' })), false,
    '没胶囊可收的终态如实返回 false，但必须记账');
  assert.equal(bar.element.children.length, 0);

  assert.equal(bar.consume(subagentBlock({ streamStatus: 'running' })), false,
    '已经收过终态的 taskId 不能再复活');
  assert.equal(bar.element.children.length, 0, '不能造出收不掉的胶囊');
  assert.equal(bar.element.hidden, true);
  bar.destroy();
});

t('2 终态别名表驱动：十个别名都收胶囊', () => {
  const aliases = [
    'interrupted', 'cancelled', 'canceled', 'success', 'complete',
    'completed', 'resolved', 'error', 'failure', 'abort',
  ];
  for (const alias of aliases) {
    const doc = makeDoc();
    const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
    assert.equal(bar.consume(subagentBlock()), true, `${alias}：先要有一个胶囊`);
    assert.equal(bar.element.children.length, 1);

    assert.equal(bar.consume(update('t1', { streamStatus: alias })), true, `${alias} 要折断成终态并收掉胶囊`);
    assert.equal(bar.element.children.length, 0, `${alias} 之后不该还剩胶囊`);
    assert.equal(bar.element.hidden, true);
    bar.destroy();
  }
});

t('3 queued / dispatched 归一成 running：建胶囊，同类补丁也不收', () => {
  for (const alias of ['queued', 'dispatched']) {
    const doc = makeDoc();
    const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
    assert.equal(bar.consume(subagentBlock({ streamStatus: alias })), true);
    assert.equal(bar.element.children[0].dataset.status, 'running', `${alias} 要归一成 running`);

    assert.equal(bar.consume(update('t1', { streamStatus: alias })), true);
    assert.equal(bar.element.children.length, 1, `${alias} 不是终态，不能收胶囊`);
    assert.equal(bar.element.children[0].dataset.status, 'running');
    bar.destroy();
  }
});

t('4 clearChips() 只清胶囊，终态记忆保留（历史整页替换走这里）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock());
  bar.consume(update('t1', { streamStatus: 'done' }));
  assert.equal(bar.element.children.length, 0);

  bar.clearChips();
  assert.deepEqual(bar.list(), []);
  // 同一会话里历史整页重画，旧 taskId 的终态不能被忘掉：否则回灌一条 running 就复活
  assert.equal(bar.consume(subagentBlock({ streamStatus: 'running' })), false,
    'clearChips 不该抹掉终态记忆');
  assert.equal(bar.element.children.length, 0);
  bar.destroy();
});

t('5 clear() 清终态记忆：同一 taskId 能重新出胶囊（新会话可能重用 taskId）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock());
  bar.consume(update('t1', { streamStatus: 'done' }));

  bar.clear();
  assert.deepEqual(bar.list(), []);
  assert.equal(bar.consume(subagentBlock({ streamStatus: 'running' })), true, 'clear 之后应该能重新出现');
  assert.equal(bar.element.children.length, 1);
  assert.equal(bar.element.hidden, false);
  bar.destroy();
});

t('6 onOpen 载荷带 label，key 集合与卡片入口一致', () => {
  const doc = makeDoc();
  const seen = [];
  const bar = createSubagentBar({
    document: doc, mount: doc.createElement('div'), clock: makeClock(), onOpen: (target) => seen.push(target)
  });
  bar.consume(subagentBlock({
    label: '审查1：分页器',
    executorAgentId: 'hana-deepseek',
    model: 'deepseek-v4',
    task: '把分页器的边界条件补上',
    sessionId: 'sess-1',
    streamKey: 'sess-1/child',
  }));
  bar.element.children[0].listeners.click[0]();

  assert.equal(seen.length, 1);
  // 字段名与 web/subagent-view.js 的卡片入口同一套：少一个，详情页就和卡片两张脸
  assert.deepEqual(Object.keys(seen[0]).sort(), [
    'agentId', 'label', 'model', 'name', 'sessionId', 'sessionPath', 'startedAt', 'status', 'task', 'taskId',
  ], 'onOpen 载荷的 key 集合');
  // 详情页「用时」在跑的过程中只能靠起点现算（宿主跑完才给 durationMs）
  assert.equal(typeof seen[0].startedAt, 'number', 'onOpen 要带 startedAt');
  assert.equal(seen[0].label, '审查1：分页器', 'label 原样透传（身份行靠它拼「label · model」）');
  assert.equal(seen[0].taskId, 't1');
  assert.equal(seen[0].sessionId, 'sess-1');
  assert.equal(seen[0].sessionPath, 'sess-1/child', 'streamKey 就是子会话的 sessionPath');
  assert.equal(seen[0].agentId, 'hana-deepseek');
  assert.equal(seen[0].status, 'running');
  assert.equal(seen[0].model, 'deepseek-v4');
  assert.equal(seen[0].task, '把分页器的边界条件补上');
  bar.destroy();
});

t('7 名字走名字链，summary 不当名字', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  // 只有 summary + 执行者快照：胶囊上要显执行者，不是那句结论
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 's1', summary: '把分页器改完了', executorAgentNameSnapshot: 'Luna' },
  });
  const chip = bar.element.children[0];
  assert.equal(chip.children[1].textContent, 'Luna', 'summary 是一句话结果，不能当名字');
  assert.ok(!String(chip.getAttribute('aria-label')).includes('把分页器改完了'), 'aria-label 也不该念结论');

  // 只带 summary 的补丁不能把已有名字冲掉
  bar.consume(subagentBlock({ taskId: 's2', agentName: '寻迹' }));
  const chip2 = bar.element.children[1];
  assert.equal(chip2.children[1].textContent, '寻迹');
  bar.consume(update('s2', { summary: '跑完了，结论在正文' }));
  assert.equal(chip2.children[1].textContent, '寻迹', 'summary 不是名字，顶不掉已有的');
  assert.match(chip2.getAttribute('aria-label'), /寻迹/);
  bar.destroy();
});

t('8 首字认执行者快照，不认 label', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 'l1', label: '审查1', executorAgentNameSnapshot: 'Luna', streamStatus: 'running' },
  });
  const chip = bar.element.children[0];
  assert.equal(chip.children[1].textContent, '审查1', '胶囊上显的是派活标题');
  assert.equal(chip.children[0].textContent, 'L', '首字要认执行者快照，不是标题首字「审」');
  bar.destroy();
});

t('9 只带 executorAgentId 的补丁不改名字、也不换首字', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock({ agentName: '寻迹' }));
  const chip = bar.element.children[0];
  assert.equal(chip.children[1].textContent, '寻迹');
  assert.equal(chip.children[0].textContent, '寻');

  bar.consume(update('t1', { executorAgentId: 'hana-x' }));
  assert.equal(chip.children[1].textContent, '寻迹', 'id 不能把已有名字顶掉');
  assert.equal(chip.children[0].textContent, '寻', '首字也不能变成 id 的首字母 h');
  assert.equal(bar.list()[0].agentId, 'hana-x', 'id 本身要记下来（头像与详情页要用）');
  bar.destroy();
});

t('10 shortOf：按分隔符切段，且不数字数（DeepSeek 原样保留）', () => {
  const seps = ['：', ':', '·', '・', '｜', '|', '（'];
  for (const sep of seps) {
    const doc = makeDoc();
    const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
    bar.consume(subagentBlock({ label: `短名${sep}很长的说明文字`, agentName: 'DeepSeek' }));
    assert.equal(bar.element.children[0].children[1].textContent, '短名',
      `分隔符 ${sep} 之前那一截才是几个胶囊之间的区别`);
    bar.destroy();
  }

  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock({ agentName: 'DeepSeek' }));
  const chip = bar.element.children[0];
  assert.equal(chip.children[1].textContent, 'DeepSeek',
    '宽度交给 CSS：JS 里硬截 6 字会把 DeepSeek 切成 DeepSe，还看不到省略号');
  assert.match(chip.getAttribute('aria-label'), /DeepSeek/);
  bar.destroy();
});

t('11 没有起点就不建 ticker：历史回灌不空转，来一条实时事件才起表', () => {
  const doc = makeDoc();
  const clock = makeClock(0);
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock(), { startUnknown: true });
  assert.equal(bar.element.children.length, 1, '胶囊还是要画出来');
  assert.equal(clock.active, 0, '起点未知的条目没有要刷的数，不该建每秒空转的表');

  bar.consume(update('t1', { streamStatus: 'running' }));
  assert.equal(clock.active, 1, '来了实时事件就有起点了，这时才起表');
  assert.equal(bar.element.children[0].children[2].hidden, false, '计时段该露出来了');

  bar.consume(update('t1', { streamStatus: 'done' }));
  assert.equal(clock.active, 0, '终态收掉后表要停');
  assert.equal(bar.element.children.length, 0);
  bar.destroy();
});

t('12 block_update 门槛：只有 summary 不建胶囊，四种身份字段各建一个', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  assert.equal(bar.consume(update('x', { summary: '一句话结果' })), false,
    'workflow 也发同一种补丁，没有身份就不该建胶囊');
  assert.equal(bar.element.children.length, 0, '没身份的补丁不能留下一个等不到终态的胶囊');

  const cases = [
    ['agentName', { agentName: '甲' }],
    ['executorAgentNameSnapshot', { executorAgentNameSnapshot: '乙' }],
    ['streamKey', { streamKey: 'sess/child' }],
    ['executorAgentId', { executorAgentId: 'hana-丙' }],
  ];
  let n = 0;
  for (const [field, patch] of cases) {
    n += 1;
    assert.equal(bar.consume(update(`g-${field}`, { streamStatus: 'running', ...patch })), true,
      `带 ${field} 的补丁说明这是个刚派出去的分身`);
    assert.equal(bar.element.children.length, n, `${field} 应该只多一个胶囊`);
  }
  assert.equal(bar.list().length, 4);
  bar.destroy();
});

t('13 consume 返回值如实：被终态记忆挡下的 content_block 返回 false', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock());
  assert.equal(bar.consume(update('t1', { streamStatus: 'done' })), true, '真的收了才返回 true');
  assert.equal(bar.consume(subagentBlock({ streamStatus: 'running' })), false, '没画也没收，如实返回 false');
  assert.equal(bar.consume({ type: 'content_block', block: { type: 'text' } }), false);
  assert.equal(bar.consume(null), false);
  bar.destroy();
});

/* ---------- 第三轮：起点跨 clearChips / 记性上限 / 状态文案 / 内容盒宽度 / label 语义 ----------
 * 这一批盯的是「胶囊换了身子还认不认得人」和「文字到底在说谁」：
 * 历史整页替换会把胶囊全收掉重建，起点与终态都得从胶囊之外的表里捞；
 * label 的语义定死为「这次派活的短标签」（人写的），不是角色、不是执行者名字。
 */

t('14 clearChips() 之后重灌（历史整页替换）计时接着走，不从 0:00 重来', () => {
  const doc = makeDoc();
  const clock = makeClock(0);
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock });
  bar.consume(subagentBlock());
  clock.advance(3000);
  assert.equal(bar.element.children[0].children[2].textContent, '0:03');

  // 整页替换：胶囊全收掉（节点换新的），重灌的块里没有时间戳（startUnknown）
  bar.clearChips();
  assert.deepEqual(bar.list(), []);
  assert.equal(clock.active, 0, '清空后表停掉');

  bar.consume(subagentBlock(), { startUnknown: true });
  const chip = bar.element.children[0];
  assert.equal(chip.children[2].hidden, false, '起点在记性里，重灌的胶囊要显计时');
  assert.equal(chip.children[2].textContent, '0:03', '起点跨 clearChips 存活，不是从 0:00 重来');
  assert.equal(bar.list()[0].startedAt, 0, '起点原样接着用');
  clock.advance(2000);
  assert.equal(chip.children[2].textContent, '0:05', '重灌之后表也接着走');

  // clear() 才是「换会话」：起点可以忘（新会话里 taskId 可能重用）
  bar.clear();
  bar.consume(subagentBlock(), { startUnknown: true });
  assert.equal(bar.element.children[0].children[2].hidden, true, 'clear() 之后回灌的胶囊不知道起点，不编计时');
  bar.destroy();
});

t('15 记性上限 200：第 201 条淘汰最旧的 taskId，旧终态随之忘掉（刻意的代价）', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume(subagentBlock({ taskId: 'old' }));
  bar.consume(update('old', { streamStatus: 'done' }));
  assert.equal(bar.consume(subagentBlock({ taskId: 'old' })), false, '终态还记着，不会复活');

  // 再灌 199 个不同 taskId：加上 old 正好 200 条，old 仍在
  for (let i = 0; i < 199; i += 1) bar.consume(subagentBlock({ taskId: `n${i}` }));
  assert.equal(bar.consume(subagentBlock({ taskId: 'old' })), false, '上限以内 old 的终态还在');

  // 第 201 条：按插入序淘汰最旧的 old
  bar.consume(subagentBlock({ taskId: 'n199' }));
  assert.equal(bar.consume(subagentBlock({ taskId: 'old' })), true,
    '淘汰即忘：旧事件能重新长出胶囊，这是内存有界的代价');
  assert.equal(bar.element.hidden, false);
  bar.destroy();
});

t('16 STATUS_TEXT 五个状态都补齐：已知状态不会被兜底成「运行中」', () => {
  // 终态胶囊一出现就被收掉，这些文案在胶囊上走不到 paint，所以直接钉这张表
  assert.equal(statusTextOf('running'), '运行中');
  assert.equal(statusTextOf('done'), '已完成');
  assert.equal(statusTextOf('success'), '已完成', '别名也要归一后再取文案');
  assert.equal(statusTextOf('failed'), '失败');
  assert.equal(statusTextOf('error'), '失败');
  assert.equal(statusTextOf('aborted'), '已中止');
  assert.equal(statusTextOf('cancelled'), '已中止');
  assert.equal(statusTextOf('interrupted'), '已中断', '缺这个键就会把「已中断」念成「运行中」');
  assert.equal(statusTextOf('weird-status'), '运行中', '只有认不出来的脏值才兜底');
  assert.equal(statusTextOf(''), '运行中');
  assert.equal(statusTextOf(null), '运行中');
});

t('17 可用宽度按内容盒算（clientWidth 含 padding，会高估）', () => {
  const doc = makeDoc();
  // .subagent-bar 是 `padding: 0 4px 8px`；这里把左右各 10px 明确造出来
  doc.defaultView = { getComputedStyle: () => ({ paddingLeft: '10px', paddingRight: '10px' }) };
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  twoChips(bar);
  bar.element.clientWidth = 100;   // 内容盒只有 80：压窄后 40*2 + 6 = 86 仍然放不下
  fakeShrink(bar);
  bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
  assert.equal(bar.element.classList.contains('is-dense'), true, '第一阶还是要先试');
  assert.equal(bar.element.classList.contains('is-compact'), true,
    '86 > 内容盒 80，要切紧凑（拿 clientWidth 100 算会误判成放得下）');
  bar.destroy();
});

t('18 读不到/读崩计算样式就退回 clientWidth，不把「刚好放得下」误判成紧凑', () => {
  for (const defaultView of [{}, { getComputedStyle: () => { throw new Error('boom'); } }]) {
    const doc = makeDoc();
    doc.defaultView = defaultView;
    const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
    twoChips(bar);
    bar.element.clientWidth = 100;   // 退回 clientWidth：压窄后 86 ≤ 100
    fakeShrink(bar);
    bar.consume({ type: 'block_update', taskId: 'a', patch: { streamStatus: 'running' } });
    assert.equal(bar.element.classList.contains('is-dense'), true);
    assert.equal(bar.element.classList.contains('is-compact'), false,
      '读不到 padding 就按宽松算，别误判成只剩头像');
    bar.destroy();
  }
});

t('19 label 是派活短标签：胶囊取第一段，aria 念全名，和名字相同不重复', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({
    type: 'content_block',
    block: {
      type: 'subagent',
      taskId: 'L1',
      label: '审3：theme 模块',
      executorAgentNameSnapshot: 'Luna',
      streamStatus: 'running'
    }
  });
  const chip = bar.element.children[0];
  // 名字与标签分开存：卡片主标题、详情页主标题都用执行者名字，标签只当标签
  assert.equal(bar.list()[0].name, 'Luna', 'name 是执行者');
  assert.equal(bar.list()[0].label, '审3：theme 模块', 'label 原样存（人写的短标签）');
  assert.equal(chip.children[1].textContent, '审3', '胶囊只显标签第一段，宽度交 CSS');
  assert.equal(chip.getAttribute('aria-label'), 'Luna · 审3：theme 模块 · 运行中 · 0:00',
    '读屏要听到执行者 + 完整标签 + 状态 + 时长');

  // 后到的标签就是名字本身：不重复念
  bar.consume(update('L1', { label: 'Luna' }));
  assert.equal(chip.getAttribute('aria-label'), 'Luna · 运行中 · 0:00', '同名不重复');
  assert.equal(chip.children[1].textContent, 'Luna');
  bar.destroy();
});

t('20 没名字也没标签时，胶囊拿 agentId 尾段顶上', () => {
  const doc = makeDoc();
  const bar = createSubagentBar({ document: doc, mount: doc.createElement('div'), clock: makeClock() });
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 'id1', executorAgentId: 'prov:quill', streamStatus: 'running' }
  });
  const chip = bar.element.children[0];
  assert.equal(chip.children[1].textContent, 'quill', 'prov:quill → quill');
  assert.equal(bar.list()[0].name, 'quill', '详情页主标题也用它，不能是「子代理」');
  assert.match(chip.getAttribute('aria-label'), /quill/);

  // 连字符也算分隔：整条 id 塞进胶囊既长又认不出是谁
  bar.consume({
    type: 'content_block',
    block: { type: 'subagent', taskId: 'id2', executorAgentId: 'hana-deepseek', streamStatus: 'running' }
  });
  assert.equal(bar.element.children[1].children[1].textContent, 'deepseek', 'hana-deepseek → deepseek');
  bar.destroy();
});

if (bad > 0) {
  console.log(`\n${bad} 个用例失败`);
  process.exit(1);
}
console.log('\nALL PASS');
