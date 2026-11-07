/* 子代理详情 sheet 的视图与交互测试（契约 2.x / 5 节单元 A）
 *
 * 跑法：node tests/subagent_sheet.test.mjs
 *
 * 假 DOM 走 tests/support/app_harness.mjs（与 lightbox / feed_view 同一套写法）。
 * 异步一律用显式 flush + 注入的假定时器推进，不写固定 sleep：
 *   - sheet 用 timers.setTimeout 排「骨架至少一帧」与关闭动画的兜底；
 *   - 用例用 tick() 把微任务跑完，再用 timers.runAll() 让那一帧到期。
 *
 * 覆盖：打开/关闭幂等、四态互斥、错误态可重试、无身份进空态、update 只改顶部、
 * destroy 后不再响应，外加结构/类名、状态文案、头像回落、三种关闭 reason、下滑阈值；
 * 视图模式（沉静 / 经典）的在位切换与重开切换、过程折叠行、思考行点击与键盘展开，
 * 以及一条读 CSS 文本的样式契约（限高与折叠只能落在 [data-view="serene"] 下）。
 *
 * 注意：所有 test(...) 必须写在文件末尾的跑测循环之前，否则用例只会被 push 进已遍历完的数组。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHarness } from './support/app_harness.mjs';
import { createSubagentSheet } from '../web/subagent-sheet.js';

let bad = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

/** 跑完当前微任务队列：loader 的 await 链只靠它推进，不靠真实时间。 */
async function tick(turns = 10) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/** 假定时器：只认「排上去」和「全部到期」，用例完全掌握推进时机。 */
function createTimers() {
  let seq = 0;
  const pending = new Map();
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
      for (let guard = 0; guard < 200 && pending.size; guard += 1) {
        const [id, timer] = pending.entries().next().value;
        pending.delete(id);
        timer.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

const TASK = {
  taskId: 'task-1',
  name: '寻迹',
  label: '只读调查',
  model: 'claude-sonnet',
  status: 'done',
  sessionId: 'sess-1',
  sessionPath: null,
  agentId: 'agent-x',
  durationMs: 12400,
  stepCount: 5,
  toolCount: 3,
  task: '查一下 web/ 的模块边界',
};

function makeTarget(extra = {}) {
  return { ...TASK, ...extra };
}

function makeSteps(count = 3) {
  const kinds = ['think', 'tool', 'say'];
  return Array.from({ length: count }, (_, i) => ({
    id: String(i),
    kind: kinds[i % kinds.length],
    title: `步骤${i}`,
    meta: i === 1 ? 'web/app.js' : null,
    text: `正文${i}`,
    status: i === count - 1 ? 'failed' : 'ok',
  }));
}

/**
 * @param {object} [options]
 * @param {(target: object) => Promise<Array>|Array} [options.load]
 * @param {(id: string) => (string|null)} [options.avatarUrlById]
 * @param {() => void} [options.focusReturn]
 */
function setup({ load = null, avatarUrlById = null, focusReturn = null } = {}) {
  const h = createHarness({ debug: false });
  const mount = h.doc.createElement('div');
  mount.className = 'ss-host';
  h.doc.body.appendChild(mount);

  const timers = createTimers();
  const dismissals = [];
  const loaderCalls = [];
  const baseLoad = load || (() => makeSteps());

  const sheet = createSubagentSheet({
    document: h.doc,
    mount,
    timers,
    avatarUrlById,
    focusReturn,
    loadTranscript: async (target) => {
      loaderCalls.push(target);
      return baseLoad(target);
    },
    onDismiss: (reason) => dismissals.push(reason),
  });

  return { h, doc: h.doc, mount, timers, sheet, dismissals, loaderCalls };
}

const rootOf = (mount) => mount.querySelector('.subagent-sheet');
const partOf = (mount, selector) => {
  const root = rootOf(mount);
  return root ? root.querySelector(selector) : null;
};
const flowOf = (mount) => partOf(mount, '.ss-flow');

function stepNodes(mount) {
  const flow = flowOf(mount);
  return flow ? flow.querySelectorAll('.ss-step') : [];
}

/** .ss-flow 里同一时刻挂了哪几态；契约要求恰好一种。 */
function bodyStates(mount) {
  const flow = flowOf(mount);
  if (!flow) return [];
  const states = [];
  if (flow.querySelectorAll('.ss-step').length) states.push('steps');
  if (flow.querySelectorAll('.ss-skeleton').length) states.push('skeleton');
  if (flow.querySelectorAll('.ss-empty').length) states.push('empty');
  if (flow.querySelectorAll('.ss-error').length) states.push('error');
  return states;
}

function textOf(node) {
  return node ? String(node.textContent).trim() : null;
}

/**
 * 把 subagent-sheet.css 粗切成「选择器 / 声明块」对：去注释后按 `}` 切，取第一个 `{` 之前那段。
 * 本文件的规则都是扁平的，够用；`@media` 那块的「选择器」会带上前缀，
 * 而它里面没有限高 / 折叠规则，断言不会误中。
 */
function cssRules() {
  const path = fileURLToPath(new URL('../web/subagent-sheet.css', import.meta.url));
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const chunk of text.split('}')) {
    const at = chunk.indexOf('{');
    if (at === -1) continue;
    rules.push({ selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1) });
  }
  return rules;
}

/** 打开并把「一帧 + 正文」都推到位（多数用例的起点）。 */
async function openSettled(ctx, target = makeTarget()) {
  assert.equal(ctx.sheet.open(target), true, 'open() 应返回 true');
  await tick();
  ctx.timers.runAll();
  await tick();
}

/** 拖动中的移动 / 结束派发到根节点（它是铺满全屏的那层，与真实冒泡路径一致）。 */
function pointerOnRoot(ctx, type, y) {
  const root = rootOf(ctx.mount);
  assert.ok(root, '根节点不存在，无法派发指针事件');
  root.dispatchEvent({ type, clientY: y });
}

function dragHead(ctx, fromY, toY) {
  const head = partOf(ctx.mount, '.ss-head');
  assert.ok(head, '头部节点不存在，无法拖动');
  head.dispatchEvent({ type: 'pointerdown', clientY: fromY });
  pointerOnRoot(ctx, 'pointermove', toY);
  pointerOnRoot(ctx, 'pointerup', toY);
}

/* ---------------------------------- 用例 ---------------------------------- */

test('open：契约 2.3 的结构/类名/数据集齐备，首帧是骨架，且不写内联样式', async () => {
  const ctx = setup();
  ctx.sheet.open(makeTarget());

  const root = rootOf(ctx.mount);
  assert.ok(root, '打开后应有 .subagent-sheet 根节点');
  assert.equal(root.dataset.state, 'closed', '刚插进文档时状态应是 closed，下一帧才翻 open');
  assert.equal(root.dataset.taskId, 'task-1', 'taskId 应落到数据集里');
  assert.equal(root.getAttribute('role'), 'dialog', '根节点应声明为 dialog');

  for (const selector of ['.ss-backdrop', '.ss-panel', '.ss-grab', '.ss-head', '.ss-avatar',
    '.ss-id', '.ss-name', '.ss-role', '.ss-status', '.ss-close', '.ss-stats', '.ss-task', '.ss-flow']) {
    assert.ok(partOf(ctx.mount, selector), `缺少结构节点 ${selector}`);
  }

  const name = partOf(ctx.mount, '.ss-name');
  assert.equal(textOf(name), '寻迹', '名字');
  const role = partOf(ctx.mount, '.ss-role');
  assert.equal(textOf(role), '只读调查 · claude-sonnet', '角色 · 模型');
  assert.equal(role.hidden, false, '有角色时不该隐藏');

  const status = partOf(ctx.mount, '.ss-status');
  assert.equal(textOf(status), '已完成', '状态文案');
  assert.equal(status.dataset.status, 'done', '状态落到 data-status 供 CSS 上色');

  const close = partOf(ctx.mount, '.ss-close');
  assert.equal(close.getAttribute('aria-label'), '关闭', '关闭按钮要有 aria-label');

  const stats = partOf(ctx.mount, '.ss-stats');
  const cells = stats.querySelectorAll('.ss-stat');
  assert.equal(cells.length, 3, '统计应为三格');
  assert.deepEqual(cells.map((cell) => textOf(cell.querySelector('b'))), ['12s', '5', '3'], '统计数值');
  assert.deepEqual(cells.map((cell) => textOf(cell.querySelector('small'))), ['用时', '步骤', '工具'], '统计标签');

  const task = partOf(ctx.mount, '.ss-task');
  assert.equal(task.hidden, false, '有 task 时应显示');
  assert.equal(textOf(task.querySelector('em')), '它被要求', 'task 的固定小标题');
  assert.equal(textOf(task.querySelector('p')), '查一下 web/ 的模块边界', 'task 正文');

  assert.deepEqual(bodyStates(ctx.mount), ['skeleton'], '首帧正文只能挂骨架');

  // 指针交互之外的视觉一律进 CSS：DOM 上不该有内联样式
  const panel = partOf(ctx.mount, '.ss-panel');
  assert.deepEqual(Object.keys(panel.style), [], '面板不该带内联样式');
  assert.deepEqual(Object.keys(root.style), [], '根节点不该带内联样式');
  assert.deepEqual(Object.keys(flowOf(ctx.mount).style), [], '正文容器不该带内联样式');

  await tick();
  ctx.timers.runAll();
  await tick();
  assert.equal(root.dataset.state, 'open', '一帧后应翻成 open 触发进场过渡');
  assert.deepEqual(bodyStates(ctx.mount), ['steps'], '正文应换成步骤');
  ctx.sheet.destroy();
});

test('骨架至少显示一帧：定时器没到期就不换内容', async () => {
  const ctx = setup();
  ctx.sheet.open(makeTarget());
  await tick();                       // loader 已经 resolve
  assert.deepEqual(bodyStates(ctx.mount), ['skeleton'], '空转一帧内容还得是骨架');
  assert.equal(stepNodes(ctx.mount).length, 0, '骨架阶段不该有步骤');

  ctx.timers.runAll();                // 让「一帧」到期
  await tick();
  assert.deepEqual(bodyStates(ctx.mount), ['steps'], '一帧之后才换成步骤');
  assert.equal(stepNodes(ctx.mount).length, 3, '步骤数应与 loader 返回一致');
  ctx.sheet.destroy();
});

test('四态互斥：步骤态里没有骨架/空态/错误态，反之亦然', async () => {
  const steps = makeSteps(4);
  const ctx = setup({ load: () => steps });
  await openSettled(ctx);
  assert.deepEqual(bodyStates(ctx.mount), ['steps'], '成功态只挂步骤');
  assert.equal(stepNodes(ctx.mount).length, 4, '步骤数');

  // 切到空态：同一实例重开一个没有正文的目标
  const emptyCtx = setup({ load: () => [] });
  await openSettled(emptyCtx, makeTarget({ taskId: 'task-empty' }));
  assert.deepEqual(bodyStates(emptyCtx.mount), ['empty'], '空结果只挂空态');
  assert.equal(stepNodes(emptyCtx.mount).length, 0, '空态不该残留步骤');

  // 切到错误态
  const errCtx = setup({ load: () => { throw new Error('boom'); } });
  await openSettled(errCtx, makeTarget({ taskId: 'task-err' }));
  assert.deepEqual(bodyStates(errCtx.mount), ['error'], '异常只挂错误态');
  assert.equal(flowOf(errCtx.mount).querySelectorAll('.ss-empty').length, 0, '错误态不该叠空态');

  ctx.sheet.destroy();
  emptyCtx.sheet.destroy();
  errCtx.sheet.destroy();
});

test('状态文案与 data-status 按契约 2.6 的表，别名收拢到五个', async () => {
  const cases = [
    [{ status: 'running' }, '运行中', 'running'],
    [{ status: 'done' }, '已完成', 'done'],
    [{ status: 'failed' }, '失败', 'failed'],
    [{ status: 'canceled' }, '已取消', 'canceled'],
    [{ status: 'idle' }, '未开始', 'idle'],
    [{ status: 'aborted' }, '已取消', 'canceled'],       // 宿主的 aborted → 详情页记作已取消
    [{ status: 'in_progress' }, '运行中', 'running'],    // 认不出的非空状态按运行中
    [{ status: null }, '未开始', 'idle'],                // 没给状态才是未开始
  ];

  for (const [patch, label, key] of cases) {
    const ctx = setup({ load: () => [] });
    await openSettled(ctx, makeTarget(patch));
    const status = partOf(ctx.mount, '.ss-status');
    assert.equal(textOf(status), label, `status=${patch.status} 的文案`);
    assert.equal(status.dataset.status, key, `status=${patch.status} 的 data-status`);
    ctx.sheet.destroy();
  }
});

test('头像：没接来源用首字，接了用图片，图片坏掉就原地回落首字', async () => {
  const noSource = setup({ load: () => [] });
  await openSettled(noSource);
  let avatar = partOf(noSource.mount, '.ss-avatar');
  assert.ok(avatar, '.ss-avatar 容器应始终存在');
  let first = avatar.children[0];
  assert.equal(first.className, 'ss-avatar-initial', '没有头像来源时应是首字');
  assert.equal(textOf(first), '寻', '中文取第一个字');
  noSource.sheet.destroy();

  const urls = { 'agent-x': 'https://ex.test/avatar.png' };
  const withSource = setup({ load: () => [], avatarUrlById: (id) => urls[id] || null });
  await openSettled(withSource);
  avatar = partOf(withSource.mount, '.ss-avatar');
  first = avatar.children[0];
  assert.equal(first.className, 'ss-avatar-img', '有地址时应是图片');
  assert.equal(first.src, 'https://ex.test/avatar.png', '图片地址');
  assert.equal(first.alt, '', '装饰性头像不给 alt，名字已经念过了');

  first.dispatchEvent('error');       // 撞 404
  const fallback = partOf(withSource.mount, '.ss-avatar').children[0];
  assert.equal(fallback.className, 'ss-avatar-initial', '坏图应换回首字');
  assert.equal(textOf(fallback), '寻', '回落的首字');
  withSource.sheet.destroy();

  // 供给方返回 null：等同没地址
  const nullSource = setup({ load: () => [], avatarUrlById: () => null });
  await openSettled(nullSource);
  assert.equal(partOf(nullSource.mount, '.ss-avatar').children[0].className, 'ss-avatar-initial',
    '来源返回 null 时应是首字');
  nullSource.sheet.destroy();
});

test('没有 sessionId / sessionPath：照样打开，但直接空态且不调 loadTranscript', async () => {
  const ctx = setup({ load: () => makeSteps() });
  ctx.sheet.open(makeTarget({ sessionId: null, sessionPath: null }));

  assert.equal(ctx.sheet.isOpen(), true, '没身份也要打开——用户点了必须有反馈');
  assert.equal(rootOf(ctx.mount) !== null, true, '根节点应存在');
  assert.deepEqual(bodyStates(ctx.mount), ['empty'], '没身份直接进空态');
  assert.equal(textOf(partOf(ctx.mount, '.ss-empty')), '没有可读的过程', '空态文案');

  await tick();
  ctx.timers.runAll();
  await tick();
  assert.equal(ctx.loaderCalls.length, 0, '没身份不该调用载荷函数');
  assert.deepEqual(bodyStates(ctx.mount), ['empty'], '空态不该被换掉');

  // 没注入 loader 但给了子会话身份：同样是空态，不能抛
  const noLoader = setup();
  const sheet = createSubagentSheet({
    document: noLoader.doc,
    mount: noLoader.mount,
    timers: noLoader.timers,
  });
  assert.equal(sheet.open(makeTarget()), true, '缺 loadTranscript 也应能打开');
  assert.deepEqual(bodyStates(noLoader.mount), ['empty'], '缺 loader 进空态');
  sheet.destroy();
  ctx.sheet.destroy();
});

test('loadTranscript 抛错进错误态，.ss-retry 重试一次后成功', async () => {
  let attempt = 0;
  const ctx = setup({
    load: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('过程读取失败：boom');
      return makeSteps(2);
    },
  });

  await openSettled(ctx);
  assert.deepEqual(bodyStates(ctx.mount), ['error'], '第一次失败应进错误态');
  assert.equal(ctx.loaderCalls.length, 1, '失败也只请求一次');
  const errText = textOf(partOf(ctx.mount, '.ss-error').querySelector('p'));
  assert.ok(errText.includes('boom'), `错误态应带上原因，实际：${errText}`);

  const retry = partOf(ctx.mount, '.ss-retry');
  assert.ok(retry, '错误态要有重试按钮');
  retry.click();
  assert.deepEqual(bodyStates(ctx.mount), ['skeleton'], '重试应先回到骨架');
  await tick();
  ctx.timers.runAll();
  await tick();

  assert.equal(ctx.loaderCalls.length, 2, '重试应再请求一次');
  assert.deepEqual(bodyStates(ctx.mount), ['steps'], '重试成功应显示步骤');
  assert.equal(stepNodes(ctx.mount).length, 2, '重试后的步骤数');
  ctx.sheet.destroy();
});

test('update() 带别的 taskId：不把上一个分身的统计写到当前这份', async () => {
  const ctx = setup({ load: () => makeSteps(3) });
  await openSettled(ctx);
  const cells = () => partOf(ctx.mount, '.ss-stats').querySelectorAll('.ss-stat');
  const before = cells().map((cell) => textOf(cell.querySelector('b')));

  // 慢响应的 A 晚到了，但当前开的是 B：校验不过，顶部不动
  assert.equal(ctx.sheet.update({ taskId: 'task-other', steps: 99, tools: 99 }), false);
  assert.deepEqual(cells().map((cell) => textOf(cell.querySelector('b'))), before, '统计不能被旧响应改写');

  // 同一份的更新照常生效
  assert.equal(ctx.sheet.update({ taskId: TASK.taskId, steps: 7, tools: 2 }), true);
  assert.equal(textOf(cells()[1].querySelector('b')), '7', '步骤数应更新');
  assert.equal(textOf(cells()[2].querySelector('b')), '2', '工具数应更新');
});

test('update() 只改顶部身份区，正文节点原地不动', async () => {
  const ctx = setup({ load: () => makeSteps(3) });
  await openSettled(ctx);

  const flow = flowOf(ctx.mount);
  const before = stepNodes(ctx.mount).map((node) => node);
  assert.equal(before.length, 3, '打开后的步骤数');

  const ok = ctx.sheet.update({
    status: 'running',
    steps: 9,
    tools: 4,
    durationMs: 61000,
    model: 'gpt-x',
  });
  assert.equal(ok, true, 'update 应返回 true');

  const status = partOf(ctx.mount, '.ss-status');
  assert.equal(textOf(status), '运行中', '状态文案应更新');
  assert.equal(status.dataset.status, 'running', 'data-status 应更新');

  const cells = partOf(ctx.mount, '.ss-stats').querySelectorAll('.ss-stat');
  assert.deepEqual(cells.map((cell) => textOf(cell.querySelector('b'))), ['1分01秒', '9', '4'],
    '统计数值应更新');
  assert.equal(textOf(partOf(ctx.mount, '.ss-role')), '只读调查 · gpt-x', '模型应更新');

  const after = stepNodes(ctx.mount);
  assert.equal(after.length, 3, '正文步骤数不该被 update 改动');
  assert.equal(after[0], before[0], '正文节点应原地保留（重建就等于重画正文）');
  assert.deepEqual(bodyStates(ctx.mount), ['steps'], '正文仍应是步骤态');
  assert.equal(flow.parentNode, partOf(ctx.mount, '.ss-panel'), '正文容器不该被换掉');

  // 关掉之后 update 什么都不做
  ctx.sheet.close('api');
  assert.equal(ctx.sheet.update({ status: 'done' }), false, '关闭后 update 应返回 false');
  ctx.sheet.destroy();
});

test('点遮罩关闭：reason=backdrop，幂等，动画收尾后节点才移除', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);

  partOf(ctx.mount, '.ss-backdrop').click();
  assert.deepEqual(ctx.dismissals, ['backdrop'], 'onDismiss 的 reason');
  assert.equal(ctx.sheet.isOpen(), false, 'isOpen() 应立即变 false');
  const root = rootOf(ctx.mount);
  assert.equal(root.dataset.state, 'closing', '关的过程状态应是 closing');
  assert.ok(root.parentNode, '动画期间节点还在文档里（让位移能播完）');

  assert.equal(ctx.sheet.close('backdrop'), false, '重复 close 应返回 false');
  assert.equal(ctx.dismissals.length, 1, '重复 close 不该再回调 onDismiss');

  ctx.timers.runAll();
  await tick();
  assert.equal(rootOf(ctx.mount), null, '动画结束后根节点应移除');
  ctx.sheet.destroy();
});

test('点 ✕ 关闭：reason=close', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);

  partOf(ctx.mount, '.ss-close').click();
  assert.deepEqual(ctx.dismissals, ['close'], '✕ 的 reason');
  assert.equal(ctx.sheet.isOpen(), false, '应已关闭');
  ctx.timers.runAll();
  await tick();
  assert.equal(rootOf(ctx.mount), null, '节点应移除');
  ctx.sheet.destroy();
});

test('下滑关闭：>80px 才关，≤80px 回弹；正文没滚到顶时不接管', async () => {
  // 未过阈值：回弹，面板位移被撤掉
  const rebound = setup({ load: () => makeSteps() });
  await openSettled(rebound);
  dragHead(rebound, 400, 480);            // dy = 80，正好不关（契约是「> 80」）
  assert.equal(rebound.sheet.isOpen(), true, '正好 80px 不该关闭');
  assert.deepEqual(rebound.dismissals, [], '不该回调 onDismiss');
  await tick();
  rebound.timers.runAll();
  await tick();
  const panel = partOf(rebound.mount, '.ss-panel');
  assert.equal(String(panel.style.transform || ''), '', '松手后应撤掉跟手位移交给 CSS 回弹');

  // 跟手过程中位移是数值，写在面板上
  const head = partOf(rebound.mount, '.ss-head');
  head.dispatchEvent({ type: 'pointerdown', clientY: 400 });
  pointerOnRoot(rebound, 'pointermove', 460);
  assert.equal(partOf(rebound.mount, '.ss-panel').style.transform, 'translateY(60px)', '拖动跟手');
  pointerOnRoot(rebound, 'pointerup', 460);

  // 过阈值：关闭，reason=drag
  const closing = setup({ load: () => makeSteps() });
  await openSettled(closing);
  dragHead(closing, 400, 481);            // dy = 81
  assert.deepEqual(closing.dismissals, ['drag'], '下滑关闭的 reason');
  assert.equal(closing.sheet.isOpen(), false, '过阈值应关闭');
  closing.timers.runAll();
  await tick();
  assert.equal(rootOf(closing.mount), null, '节点应移除');

  // 正文已经滚动：这一下是滚正文，不接管
  const scrolled = setup({ load: () => makeSteps() });
  await openSettled(scrolled);
  flowOf(scrolled.mount).scrollTop = 120;
  const scrolledHead = partOf(scrolled.mount, '.ss-head');
  scrolledHead.dispatchEvent({ type: 'pointerdown', clientY: 400 });
  pointerOnRoot(scrolled, 'pointermove', 700);
  assert.equal(partOf(scrolled.mount, '.ss-panel').style.transform, undefined,
    'scrollTop>0 时不该跟手');
  pointerOnRoot(scrolled, 'pointerup', 700);
  assert.equal(scrolled.sheet.isOpen(), true, '滚过的正文不该被下拉关掉');
  assert.deepEqual(scrolled.dismissals, [], '不该回调 onDismiss');

  // 点在 ✕ 上的按下不当拖动起点
  const onClose = setup({ load: () => makeSteps() });
  await openSettled(onClose);
  partOf(onClose.mount, '.ss-close').dispatchEvent({ type: 'pointerdown', clientY: 400 });
  pointerOnRoot(onClose, 'pointermove', 700);
  assert.equal(partOf(onClose.mount, '.ss-panel').style.transform, undefined, '✕ 上按下不拖面板');
  pointerOnRoot(onClose, 'pointerup', 700);
  assert.equal(onClose.sheet.isOpen(), true, '还开着');

  for (const ctx of [rebound, closing, scrolled, onClose]) ctx.sheet.destroy();
});

test('重复 open：先丢掉上一份再重开，不串内容也不误报关闭', async () => {
  const load = (target) => (target.taskId === 'task-b'
    ? [{ kind: 'say', title: '结论B', meta: null, text: 'B 的过程', status: 'ok' }]
    : [{ kind: 'tool', title: 'read', meta: 'web/a.js', text: 'A 的过程', status: 'ok' }]);
  const ctx = setup({ load });

  await openSettled(ctx, makeTarget({ taskId: 'task-a', name: '甲' }));
  assert.equal(textOf(partOf(ctx.mount, '.ss-name')), '甲', '第一次的名字');
  assert.equal(textOf(stepNodes(ctx.mount)[0].querySelector('b')), 'read', '第一次的正文');

  await openSettled(ctx, makeTarget({ taskId: 'task-b', name: '乙' }));

  assert.equal(ctx.mount.querySelectorAll('.subagent-sheet').length, 1, '只能有一份根节点');
  assert.equal(textOf(partOf(ctx.mount, '.ss-name')), '乙', '名字应换成新的');
  assert.equal(rootOf(ctx.mount).dataset.taskId, 'task-b', '数据集应换成新的');
  const steps = stepNodes(ctx.mount);
  assert.equal(steps.length, 1, '正文应是新的一份');
  assert.equal(textOf(steps[0].querySelector('b')), '结论B', '不该残留上一份正文');
  assert.equal(ctx.loaderCalls.length, 2, '重开应重新取一次正文');
  assert.deepEqual(ctx.dismissals, [], '重开不是关闭，不该回调 onDismiss');

  ctx.sheet.destroy();
});

test('destroy()：节点消失，之后 open/update/close 全都不响应，且可重复调用', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);
  assert.equal(ctx.sheet.isOpen(), true, 'destroy 前是开的');

  ctx.sheet.destroy();
  assert.equal(rootOf(ctx.mount), null, 'destroy 应移除节点');
  assert.equal(ctx.sheet.isOpen(), false, 'destroy 后 isOpen 为 false');
  assert.deepEqual(ctx.dismissals, [], 'destroy 不当作一次用户关闭');

  assert.equal(ctx.sheet.open(makeTarget()), false, 'destroy 后 open 应返回 false');
  assert.equal(rootOf(ctx.mount), null, 'destroy 后不该再建 DOM');
  assert.equal(ctx.sheet.update({ status: 'running' }), false, 'destroy 后 update 返回 false');
  assert.equal(ctx.sheet.close('api'), false, 'destroy 后 close 返回 false');

  // 节点已经拆掉：再往原来的挂载点派发也不该出异常、更不该把状态改回去
  ctx.mount.dispatchEvent({ type: 'pointermove', clientY: 600 });
  ctx.mount.dispatchEvent({ type: 'pointerup', clientY: 600 });
  assert.equal(ctx.sheet.isOpen(), false, '仍应是关闭');

  ctx.sheet.destroy();
  assert.equal(rootOf(ctx.mount), null, '重复 destroy 安全');
});

test('步骤渲染：kind/status 落数据集，meta 与正文各就各位，脏条目跳过', async () => {
  const steps = [
    null,
    {},
    { kind: 'weird', title: '怪种类' },
    { kind: 'think', text: '只有正文' },
    { kind: 'say', title: '结论', meta: 'web/a.js', text: '第一段\n第二段', status: 'failed' },
  ];
  const ctx = setup({ load: () => steps });
  await openSettled(ctx);

  const rows = stepNodes(ctx.mount);
  assert.equal(rows.length, 3, '空条目被跳过，剩下三条');

  assert.equal(rows[0].dataset.kind, 'note', '认不出的 kind 归 note');
  assert.equal(rows[0].dataset.status, 'ok', '缺 status 记 ok');
  assert.equal(textOf(rows[0].querySelector('b')), '怪种类', '标题');

  assert.equal(rows[1].dataset.kind, 'think', 'think 种类');
  assert.equal(textOf(rows[1].querySelector('b')), '思考', '缺标题按种类兜一句');
  assert.equal(textOf(rows[1].querySelector('.ss-step-text')), '只有正文', '正文');
  assert.equal(rows[1].querySelector('.ss-step-text').hidden, false, '有正文不该隐藏');

  assert.equal(rows[2].dataset.kind, 'say', 'say 种类');
  assert.equal(rows[2].dataset.status, 'failed', '失败状态落到 data-status');
  assert.equal(textOf(rows[2].querySelector('.ss-step-title').children[1]), 'web/a.js',
    'meta 进标题行的次要位');
  assert.equal(textOf(rows[2].querySelector('.ss-step-text')), '第一段\n第二段', '正文保留换行');
  assert.ok(rows[2].querySelector('.ss-dot'), '每条步骤都有一粒点');

  ctx.sheet.destroy();
});

test('关闭动画期间重开：不叠加根节点，旧的那份立刻让位', async () => {
  const ctx = setup({ load: () => makeSteps(1) });
  await openSettled(ctx);

  ctx.sheet.close('backdrop');                 // 进 closing，节点还在文档里
  assert.equal(rootOf(ctx.mount).dataset.state, 'closing', '先在 closing 态');

  await openSettled(ctx, makeTarget({ taskId: 'task-2', name: '催花清雨' }));
  assert.equal(ctx.mount.querySelectorAll('.subagent-sheet').length, 1, '只应剩一份根节点');
  assert.equal(textOf(partOf(ctx.mount, '.ss-name')), '催花清雨', '应该是新打开的那份');

  // 旧那份排着的收尾定时器已被清掉，不会再跑来拆新节点
  ctx.timers.runAll();
  await tick();
  assert.equal(rootOf(ctx.mount) !== null, true, '新节点不该被旧的收尾定时器拆掉');
  assert.equal(ctx.sheet.isOpen(), true, '新的一份仍开着');

  ctx.sheet.destroy();
});

test('关闭时把焦点交回 focusReturn（契约 2.5）', async () => {
  let returns = 0;
  const ctx = setup({ load: () => makeSteps(), focusReturn: () => { returns += 1; } });
  await openSettled(ctx);

  ctx.sheet.close('api');
  assert.equal(returns, 1, '关闭时调用一次 focusReturn');
  ctx.sheet.close('api');
  assert.equal(returns, 1, '重复关闭不该再调');

  ctx.sheet.destroy();
  ctx.timers.runAll();
  await tick();
});

test('参数校验：缺 document 抛明确错误，缺省 mount 落到 doc.body', async () => {
  assert.throws(() => createSubagentSheet({}), /document/, '缺 document 应抛 TypeError 并点名');

  const h = createHarness({ debug: false });
  const sheet = createSubagentSheet({ document: h.doc, timers: createTimers() });
  assert.equal(sheet.open(makeTarget({ sessionId: null })), true, '缺省 mount 应能打开');
  assert.ok(h.doc.body.querySelector('.subagent-sheet'), '缺省 mount 挂到 body');
  sheet.destroy();
  assert.equal(h.doc.body.querySelector('.subagent-sheet'), null, 'destroy 后 body 上不残留');
});

/* ---------------------------------- 视图与折叠 ---------------------------------- */

test('视图开关：默认沉静，切经典跟着换，坏值落回沉静', async () => {
  const ctx = setup();
  await openSettled(ctx);
  const root = rootOf(ctx.mount);
  assert.equal(root.dataset.view, 'serene', '默认应是沉静');
  assert.equal(ctx.sheet.setViewMode('classic'), true);
  assert.equal(root.dataset.view, 'classic');
  ctx.sheet.setViewMode('???');
  assert.equal(root.dataset.view, 'serene', '脏值一律归沉静');
  ctx.sheet.destroy();
});

test('在位切到经典：折叠行与 is-folded 当场撤掉，思考不留按钮语义', async () => {
  // 不重开。这正是 setViewMode 只改 data-view 时的漏点：已渲染的折叠行和 is-folded 不会重算。
  const ctx = setup();
  await openSettled(ctx);
  const flow = flowOf(ctx.mount);
  assert.equal(flow.classList.contains('is-folded'), true, '前提：沉静下是收起的');
  assert.ok(flow.querySelector('.ss-fold-toggle'), '前提：沉静下挂着折叠行');
  const think = stepNodes(ctx.mount).find((row) => row.dataset.kind === 'think');
  assert.equal(think.getAttribute('role'), 'button', '前提：沉静下思考行是按钮');

  ctx.sheet.setViewMode('classic');

  assert.equal(rootOf(ctx.mount).dataset.view, 'classic', '模式应跟着换');
  const flowAfter = flowOf(ctx.mount);
  assert.equal(flowAfter.classList.contains('is-folded'), false, '经典下不该还收着');
  assert.equal(flowAfter.querySelector('.ss-fold-toggle'), null, '经典下不该还留着折叠行');
  const thinkAfter = stepNodes(ctx.mount).find((row) => row.dataset.kind === 'think');
  assert.ok(thinkAfter, '步骤应重画出来');
  // 经典给思考全文，所以既不该有展开入口（CSS 也不该再 clamp，那条规则只看 data-view）
  assert.equal(thinkAfter.getAttribute('role'), null, '经典不该再挂按钮语义');
  assert.equal(thinkAfter.getAttribute('tabindex'), null, '经典不该出现能聚焦却按不动的行');
  assert.equal(thinkAfter.classList.contains('is-expanded'), false, '重画后不该带旧的展开态');
  assert.equal(stepNodes(ctx.mount).length, 3, '步骤一条不少');
  ctx.sheet.destroy();
});

test('在位切回沉静：折叠行当场补出来（另一个方向也得重画）', async () => {
  const ctx = setup();
  await openSettled(ctx);
  ctx.sheet.setViewMode('classic');
  assert.equal(flowOf(ctx.mount).querySelector('.ss-fold-toggle'), null, '前提：经典下没有折叠行');

  ctx.sheet.setViewMode('serene');
  const flow = flowOf(ctx.mount);
  assert.equal(flow.classList.contains('is-folded'), true, '沉静应重新收起');
  const toggle = flow.querySelector('.ss-fold-toggle');
  assert.ok(toggle, '沉静下要补出折叠行');
  assert.ok(/思考/.test(textOf(toggle)), `折叠行应报思考段数，实际：${textOf(toggle)}`);
  ctx.sheet.destroy();
});

test('在位切换不动顶部：身份区与统计不因重画正文而丢', async () => {
  const ctx = setup();
  await openSettled(ctx);
  ctx.sheet.setViewMode('classic');
  assert.equal(textOf(partOf(ctx.mount, '.ss-name')), '寻迹', '名字还在');
  const cells = partOf(ctx.mount, '.ss-stats').querySelectorAll('.ss-stat');
  assert.deepEqual(cells.map((cell) => textOf(cell.querySelector('b'))), ['12s', '5', '3'],
    '统计还在');
  assert.equal(partOf(ctx.mount, '.ss-panel').querySelectorAll('.ss-flow').length, 1,
    '正文容器只该有一块');
  ctx.sheet.destroy();
});

 test('沉静下点思考行才展开，再点收回；经典下既不挂按钮语义也不响应点击', async () => {
  const ctx = setup();
  await openSettled(ctx);
  const thinks = stepNodes(ctx.mount).filter((row) => row.dataset.kind === 'think');
  assert.ok(thinks.length > 0, '夹具里应有思考行');
  const row = thinks[0];
  assert.equal(row.classList.contains('is-expanded'), false, '默认不展开');
  assert.equal(row.getAttribute('aria-expanded'), 'false', '默认应收着');
  row.dispatchEvent({ type: 'click' });
  assert.equal(row.classList.contains('is-expanded'), true, '点一下要展开');
  assert.equal(row.getAttribute('aria-expanded'), 'true', '展开态要同步给读屏');
  row.dispatchEvent({ type: 'click' });
  assert.equal(row.classList.contains('is-expanded'), false, '再点收回');

  ctx.sheet.setViewMode('classic');
  const classicRow = stepNodes(ctx.mount).find((node) => node.dataset.kind === 'think');
  classicRow.dispatchEvent({ type: 'click' });
  assert.equal(classicRow.classList.contains('is-expanded'), false, '经典给全文，点了不该变');
  ctx.sheet.destroy();
});

test('键盘：沉静下思考行 Enter / 空格都能展开收起（和点击共用一套状态）', async () => {
  const ctx = setup();
  await openSettled(ctx);
  const row = stepNodes(ctx.mount).find((node) => node.dataset.kind === 'think');
  assert.equal(row.getAttribute('tabindex'), '0', '沉静下应能聚焦');

  row.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(row.classList.contains('is-expanded'), true, 'Enter 应展开');
  assert.equal(row.getAttribute('aria-expanded'), 'true', '读屏要能听见展开');

  row.dispatchEvent({ type: 'keydown', key: ' ' });
  assert.equal(row.classList.contains('is-expanded'), false, '空格应收回');

  row.dispatchEvent({ type: 'keydown', key: 'a' });
  assert.equal(row.classList.contains('is-expanded'), false, '别的键不该动它');
  ctx.sheet.destroy();
});

test('沉静：过程默认收起（只留结论），点三角铺开，再点收回', async () => {
  const ctx = setup();
  await openSettled(ctx);
  const flow = flowOf(ctx.mount);
  assert.equal(flow.classList.contains('is-folded'), true, '沉静下默认收起');
  const toggle = flow.querySelector('.ss-fold-toggle');
  assert.ok(toggle, '折叠时要有展开入口');
  assert.ok(/思考/.test(textOf(toggle)), `过程行应报思考段数，实际：${textOf(toggle)}`);
  assert.ok(/操作/.test(textOf(toggle)), `过程行应报操作数，实际：${textOf(toggle)}`);
  assert.equal(toggle.getAttribute('type'), 'button', '按钮要声明 type');
  assert.ok(flow.id, '正文容器要有 id');
  assert.equal(toggle.getAttribute('aria-controls'), flow.id, 'aria-controls 要指到正文容器');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', '收起态要给读屏听见');

  toggle.dispatchEvent({ type: 'click' });
  assert.equal(flow.classList.contains('is-folded'), false, '点一下要展开');
  assert.equal(toggle.dataset.expanded, '1');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', '展开态要同步');
  toggle.dispatchEvent({ type: 'click' });
  assert.equal(flow.classList.contains('is-folded'), true, '再点收回');
  assert.equal(toggle.dataset.expanded, '0');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', '收回去也要同步');
  ctx.sheet.destroy();
});

test('折叠时把逐行展开态清掉：收起来的那几行不该留着看不见的展开状态', async () => {
  const ctx = setup();
  await openSettled(ctx);
  const flow = flowOf(ctx.mount);
  flow.querySelector('.ss-fold-toggle').dispatchEvent({ type: 'click' });   // 先铺开
  const row = stepNodes(ctx.mount).find((node) => node.dataset.kind === 'think');
  row.dispatchEvent({ type: 'click' });
  assert.equal(row.classList.contains('is-expanded'), true, '前提：这段思考被点开了');

  flow.querySelector('.ss-fold-toggle').dispatchEvent({ type: 'click' });   // 再收起
  assert.equal(flow.classList.contains('is-folded'), true, '应回到收起态');
  assert.equal(row.classList.contains('is-expanded'), false, '展开态应被清掉');
  assert.equal(row.getAttribute('aria-expanded'), 'false', '读屏也要回到收起');
  ctx.sheet.destroy();
});

test('经典：重开后不收起、也不给折叠入口', async () => {
  const ctx = setup();
  await openSettled(ctx);
  ctx.sheet.setViewMode('classic');
  await openSettled(ctx);
  assert.equal(flowOf(ctx.mount).classList.contains('is-folded'), false, '经典视图不收起');
  assert.equal(flowOf(ctx.mount).querySelector('.ss-fold-toggle'), null, '经典不需要展开入口');
  ctx.sheet.destroy();
});

test('折叠行只在真有可折叠步骤时出现：全是结论就不画（点了什么也不会变）', async () => {
  const ctx = setup({ load: () => [
    { kind: 'say', title: '结论', text: '就这些' },
    { kind: 'ask', title: '交给它的事', text: '查一下' },
  ] });
  await openSettled(ctx);
  const flow = flowOf(ctx.mount);
  assert.equal(flow.classList.contains('is-folded'), false, '没有可折叠的东西就别收');
  assert.equal(flow.querySelector('.ss-fold-toggle'), null, '不该出现一行按了没反应的折叠行');
  assert.equal(stepNodes(ctx.mount).length, 2, '结论仍要照常画出来');
  ctx.sheet.destroy();
});

test('折叠行的计数不许瞒下 note：认不出的 kind 归「操作」', async () => {
  const ctx = setup({ load: () => [
    { kind: 'think', title: '思考', text: '想了想' },
    { kind: 'weird', title: '脏 kind', text: '会被折叠掉的一条' },
    { kind: 'say', title: '结论', text: '好了' },
  ] });
  await openSettled(ctx);
  const toggle = flowOf(ctx.mount).querySelector('.ss-fold-toggle');
  assert.ok(toggle, '有 think 就该有折叠行');
  assert.equal(textOf(toggle), '思考 1 段 · 操作 1', `note 也要算进操作，实际：${textOf(toggle)}`);
  // CSS 折叠的是 :not(say):not(ask)，行文里的计数必须与它一致
  assert.equal(stepNodes(ctx.mount).length, 3, 'note 仍是一条步骤');
  ctx.sheet.destroy();
});

/* ---------------- 身份副标题：label · model ---------------- */

test('身份副标题：label 是这次派活的短标签，与 name 相同或为空时不重复显示', async () => {
  const cases = [
    [{ name: '寻迹', label: '审3：theme 模块', model: 'claude-sonnet' }, '审3：theme 模块 · claude-sonnet'],
    [{ name: '寻迹', label: '寻迹', model: 'claude-sonnet' }, 'claude-sonnet'],          // 跟名字一样：不重复
    [{ name: '寻迹', label: '  ', model: 'claude-sonnet' }, 'claude-sonnet'],            // 空标签：只剩模型
    [{ name: '寻迹', label: null, model: 'gpt-x' }, 'gpt-x'],
    [{ name: '寻迹', label: '审3', model: null }, '审3'],
    [{ name: '寻迹', label: null, model: null }, null],                                 // 两样都没：整行不占位
  ];

  for (const [patch, expected] of cases) {
    const ctx = setup({ load: () => [] });
    await openSettled(ctx, makeTarget({ ...patch, taskId: `t-${String(expected)}` }));
    const role = partOf(ctx.mount, '.ss-role');
    if (expected === null) {
      assert.equal(role.hidden, true, `label=${patch.label} model=${patch.model} 时应隐藏副标题`);
      assert.equal(textOf(role), '', '隐藏时也不该有字');
    } else {
      assert.equal(role.hidden, false, '有内容时不该隐藏');
      assert.equal(textOf(role), expected, `label=${patch.label} model=${patch.model} 的副标题`);
    }
    ctx.sheet.destroy();
  }
});

/* ---------------- 样式契约：假 DOM 不上 CSS，只能读文本 ---------------- */

test('CSS：限高与折叠规则都只在沉静视图下生效（掉了前缀经典也会跟着收）', () => {
  const rules = cssRules();
  const guarded = rules.filter((rule) => /-webkit-line-clamp/.test(rule.body)
    || /is-folded|ss-fold-(toggle|caret|text)/.test(rule.selector));
  assert.ok(guarded.length >= 6, `应能找到折叠/限高规则，实际 ${guarded.length} 条`);
  for (const rule of guarded) {
    assert.ok(
      rule.selector.includes('[data-view="serene"]'),
      `这条规则掉了 [data-view="serene"] 前缀，经典视图会跟着收起来：${rule.selector}`,
    );
  }
  // 思考行的三行限高必须已经不在了：经典给全文（产品裁决）
  assert.equal(/-webkit-line-clamp:\s*3/.test(readFileSync(
    fileURLToPath(new URL('../web/subagent-sheet.css', import.meta.url)), 'utf8',
  )), false, '不该再有全局三行限高');
});


/* ---------------- 键盘：Escape 关层与冒泡边界 ---------------- */

/** 在节点上派发一记按键，并把 preventDefault / stopPropagation 换成可观测的计数。 */
function fireKey(node, key, extra = {}) {
  const seen = { prevented: 0, stopped: 0 };
  node.dispatchEvent({
    type: 'keydown',
    key,
    target: node,
    preventDefault: () => { seen.prevented += 1; },
    stopPropagation: () => { seen.stopped += 1; },
    ...extra,
  });
  return seen;
}

test('Escape：焦点在 sheet 里时关掉这一层，reason=escape 且不再往下层传', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);
  const panel = partOf(ctx.mount, '.ss-panel');

  const seen = fireKey(panel, 'Escape');
  assert.equal(seen.stopped, 1, '要点掉冒泡，不能让下层再关一层');
  assert.deepEqual(ctx.dismissals, ['escape'], 'reason 应是 escape');
  assert.equal(ctx.sheet.isOpen(), false, 'isOpen 应立即变 false');

  ctx.timers.runAll();
  await tick();
  assert.equal(rootOf(ctx.mount), null, '动画收尾后节点应移除');

  // 收尾之后同一条链上的旧节点再按也不该有反应（监听随收尾一起没了）
  fireKey(panel, 'Escape');
  assert.deepEqual(ctx.dismissals, ['escape'], '关闭完成后不该再回调一次');
  ctx.sheet.destroy();
});

test('Escape：焦点明显落在别处时不抢（只关最上面那层）', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);
  const composer = ctx.doc.createElement('textarea');
  ctx.mount.appendChild(composer);
  ctx.doc.activeElement = composer;          // 页面明确落点：输入框

  const seen = fireKey(composer, 'Escape');
  assert.equal(seen.stopped, 0, '不该吞掉这记按键');
  assert.deepEqual(ctx.dismissals, [], '焦点在别处时不该关 sheet');
  assert.equal(ctx.sheet.isOpen(), true, '仍应开着');

  // 焦点回到面板里：照常响应
  ctx.doc.activeElement = partOf(ctx.mount, '.ss-panel');
  fireKey(partOf(ctx.mount, '.ss-panel'), 'Escape');
  assert.deepEqual(ctx.dismissals, ['escape'], '焦点回来后才归 sheet');
  ctx.timers.runAll();
  await tick();
  ctx.sheet.destroy();
});

/* ---------------- 环保护：祖先链自指 / 成环 ---------------- */

test('环保护：祖先链自指或成环时不死循环，一律按「不在面板里」处理', async () => {
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);
  const panel = partOf(ctx.mount, '.ss-panel');

  // 自指：parentNode 指回自己（被 remove() 过的节点在部分宿主上就是这个样子）。
  // 上一版就是在这里挂死的：while (cur) cur = cur.parentNode 永不退出。
  const selfLoop = ctx.doc.createElement('button');
  selfLoop.parentNode = selfLoop;
  ctx.doc.activeElement = selfLoop;

  let seen = fireKey(panel, 'Tab');
  assert.equal(seen.prevented, 0, '焦点不在面板里：Tab 不抢');

  // 成环：A → B → A
  const a = ctx.doc.createElement('button');
  const b = ctx.doc.createElement('button');
  a.parentNode = b;
  b.parentNode = a;
  ctx.doc.activeElement = a;
  seen = fireKey(panel, 'Tab');
  assert.equal(seen.prevented, 0, '成环同样按「不在面板里」处理');

  // Escape 也走同一条链：不吞、也不该把这层关掉
  seen = fireKey(panel, 'Escape', { target: a });
  assert.equal(seen.stopped, 0, '不属于这里的 Escape 不吞掉');
  assert.deepEqual(ctx.dismissals, [], '焦点在环里：不该关掉这层');
  assert.equal(ctx.sheet.isOpen(), true, '仍应开着');

  // 关闭时把焦点递回：落点是环就当「已经不在文档上」，只跳过，不能挂
  ctx.sheet.close('api');
  ctx.timers.runAll();
  await tick();
  const calls = spyFocus(selfLoop);
  ctx.doc.activeElement = selfLoop;
  await openSettled(ctx);
  ctx.sheet.close('api');
  assert.equal(calls.length, 0, '落点不在文档上（或是个环）：不硬塞焦点');
  ctx.timers.runAll();
  await tick();
  ctx.sheet.destroy();
});

/* ---------------- 背景滚动锁：按原值锁、按原值还 ---------------- */

test('滚动锁：打开锁住 html/body，关闭后按原值（空串）精确还原', async () => {
  const ctx = setup({ load: () => makeSteps() });
  const html = ctx.doc.documentElement;
  const body = ctx.doc.body;
  assert.equal(String(html.style.overflow || ''), '', '前提：一开始没设过');

  ctx.sheet.open(makeTarget());
  for (const el of [html, body]) {
    assert.equal(el.style.overflow, 'hidden', '打开期间 overflow 应锁住');
    assert.equal(el.style.overscrollBehavior, 'none', '打开期间 overscroll-behavior 应锁住');
  }

  ctx.sheet.close('api');
  ctx.timers.runAll();
  await tick();
  for (const el of [html, body]) {
    assert.equal(el.style.overflow, '', '原来没设过 → 还原成空串，不是写死 auto');
    assert.equal(el.style.overscrollBehavior, '', 'overscroll-behavior 同样回到空串');
  }
  ctx.sheet.destroy();
});

test('滚动锁：宿主原本设过值就还回原值，二次开关不叠锁不漏锁', async () => {
  const ctx = setup({ load: () => makeSteps() });
  const html = ctx.doc.documentElement;
  const body = ctx.doc.body;
  html.style.overflow = 'scroll';
  html.style.overscrollBehavior = 'contain';
  body.style.overflow = 'auto';
  body.style.overscrollBehavior = 'auto';

  await openSettled(ctx);
  assert.equal(html.style.overflow, 'hidden', '先锁上');
  await openSettled(ctx);                          // 同一实例重开（开→关→开）
  assert.equal(html.style.overflow, 'hidden', '重开后仍是锁着的');

  ctx.sheet.close('api');
  ctx.timers.runAll();
  await tick();
  assert.equal(html.style.overflow, 'scroll', 'html 的 overflow 回到宿主原值');
  assert.equal(html.style.overscrollBehavior, 'contain', 'html 的 overscroll 回到原值');
  assert.equal(body.style.overflow, 'auto', 'body 的 overflow 回到宿主原值');
  assert.equal(body.style.overscrollBehavior, 'auto', 'body 的 overscroll 回到原值');

  // 再开再关一轮：不叠锁、也不漏锁
  await openSettled(ctx);
  assert.equal(body.style.overflow, 'hidden', '第二轮照样锁上');
  ctx.sheet.close('api');
  ctx.timers.runAll();
  await tick();
  assert.equal(body.style.overflow, 'auto', '第二轮关闭后照样还原');
  ctx.sheet.destroy();
});

test('滚动锁：destroy 与关闭动画期间重开都不漏锁', async () => {
  // destroy：开着直接拆，也要把背景解锁
  const dying = setup({ load: () => makeSteps() });
  await openSettled(dying);
  assert.equal(dying.doc.body.style.overflow, 'hidden', '前提：开着且锁着');
  dying.sheet.destroy();
  assert.equal(dying.doc.body.style.overflow, '', 'destroy 必须解锁，不能把页面锁死');

  // 关闭动画还没收尾就重开：旧锁先还再锁，最后关掉时只剩一次还原
  const ctx = setup({ load: () => makeSteps() });
  await openSettled(ctx);
  ctx.sheet.close('backdrop');                    // 进 closing，锁还在
  assert.equal(ctx.doc.documentElement.style.overflow, 'hidden', '动画期间仍锁着');
  await openSettled(ctx);                          // 重开
  assert.equal(ctx.doc.documentElement.style.overflow, 'hidden', '重开后仍锁着');
  ctx.sheet.close('api');
  ctx.timers.runAll();
  await tick();
  assert.equal(ctx.doc.documentElement.style.overflow, '', '最终一次还原到位，不残留');
  ctx.sheet.destroy();
  dying.sheet.destroy();
});

/* ---------------- 焦点陷阱：Tab 在面板里循环 ---------------- */

/**
 * 给已存在的节点换上可观测的 focus：假 DOM 的 focus() 是空函数，不换就无从断言
 * 「焦点落到哪个节点上」。
 *
 * 注意：这里只能比 className，**不能**把节点对象放进 assert.deepEqual——
 * 假 DOM 节点的 previousElementSibling 每次取都新建数组，失败信息生成时 inspect
 * 会把整棵树连同这些新对象一起展开，表现就是用例永久不返回（比死循环更难查）。
 */
function spyFocus(...nodes) {
  const calls = [];
  for (const node of nodes) node.focus = (arg) => { calls.push({ node, arg }); };
  return calls;
}

const focusedNames = (calls) => calls.map((c) => c.node.className || c.node.tagName);

test('Tab 陷阱：到两头改道并 preventDefault，中间站交回浏览器', async () => {
  const ctx = setup({ load: () => makeSteps(3) });      // 默认沉静：过程折叠着
  await openSettled(ctx);
  const panel = partOf(ctx.mount, '.ss-panel');
  const close = partOf(ctx.mount, '.ss-close');
  const fold = partOf(ctx.mount, '.ss-fold-toggle');
  assert.ok(fold, '前提：沉静下挂着折叠行');
  const calls = spyFocus(panel, close, fold);

  // 最后一站 Tab：改道回第一站
  ctx.doc.activeElement = fold;
  let seen = fireKey(panel, 'Tab');
  assert.equal(seen.prevented, 1, '越界必须 preventDefault');
  assert.deepEqual(focusedNames(calls), ['ss-close'], '应改道到第一站（关闭按钮）');

  // 中间站：不拦，交给浏览器
  calls.length = 0;
  ctx.doc.activeElement = close;
  seen = fireKey(panel, 'Tab');
  assert.equal(seen.prevented, 0, '中间站不该拦');
  assert.equal(calls.length, 0, '中间站不该由 sheet 移焦');

  // 第一站 Shift+Tab：改道回最后一站
  seen = fireKey(panel, 'Tab', { shiftKey: true });
  assert.equal(seen.prevented, 1, '反向越界也要 preventDefault');
  assert.deepEqual(focusedNames(calls), ['ss-fold-toggle'], '应改道到最后一站（折叠行）');

  // 最后一站 Shift+Tab：中间站，不拦
  calls.length = 0;
  ctx.doc.activeElement = fold;
  seen = fireKey(panel, 'Tab', { shiftKey: true });
  assert.equal(seen.prevented, 0, '反向中间站也不拦');
  assert.equal(calls.length, 0, '反向中间站不由 sheet 移焦');
  ctx.sheet.destroy();
});

test('Tab 陷阱：tabindex="-1" 与沉静下被折叠的步骤行都不算站，铺开后才算', async () => {
  const ctx = setup({ load: () => makeSteps(3) });
  await openSettled(ctx);
  const panel = partOf(ctx.mount, '.ss-panel');
  const close = partOf(ctx.mount, '.ss-close');
  const fold = partOf(ctx.mount, '.ss-fold-toggle');
  const thinkRow = stepNodes(ctx.mount).find((row) => row.dataset.kind === 'think');
  assert.equal(thinkRow.getAttribute('tabindex'), '0', '前提：沉静下思考行本来可聚焦');
  assert.equal(thinkRow.hidden, false, '它自身没 hidden——靠的是折叠行（CSS）');
  const calls = spyFocus(panel, close, fold, thinkRow);

  // tabindex="-1" 的节点（程序化落点）不算站：摆在面板最后，越界改道也不该落到它头上
  const programmatic = ctx.doc.createElement('div');
  programmatic.className = 'ss-probe';
  programmatic.setAttribute('tabindex', '-1');
  panel.appendChild(programmatic);
  const probeCalls = spyFocus(programmatic);

  // 折叠时：最后一站是折叠行，不是藏起来的思考行
  ctx.doc.activeElement = close;
  fireKey(panel, 'Tab', { shiftKey: true });
  assert.deepEqual(focusedNames(calls), ['ss-fold-toggle'], '折叠着的思考行不该被当成最后一站');
  assert.equal(probeCalls.length, 0, 'tabindex="-1" 的节点不该进 Tab 序列');

  // 铺开之后：思考行重新入列，成了真正的最后一站
  calls.length = 0;
  fold.dispatchEvent({ type: 'click' });
  assert.equal(flowOf(ctx.mount).classList.contains('is-folded'), false, '前提：已铺开');
  ctx.doc.activeElement = close;
  fireKey(panel, 'Tab', { shiftKey: true });
  assert.deepEqual(focusedNames(calls), ['ss-step'], '铺开后思考行应回到 Tab 序列');
  ctx.sheet.destroy();
});

test('Tab 陷阱：面板里一个可聚焦元素都没有时，退化为聚焦面板自己', async () => {
  const ctx = setup({ load: () => [] });                  // 空态：只有关闭按钮一站
  await openSettled(ctx);
  const panel = partOf(ctx.mount, '.ss-panel');
  const close = partOf(ctx.mount, '.ss-close');
  const calls = spyFocus(panel, close);
  close.hidden = true;                                    // 把唯一的站抽掉
  ctx.doc.activeElement = panel;

  const seen = fireKey(panel, 'Tab');
  assert.equal(seen.prevented, 1, '没有站时必须 preventDefault，否则焦点漏到背后的页面');
  assert.deepEqual(focusedNames(calls), ['ss-panel'], '焦点回到面板自己');
  ctx.sheet.destroy();
});

/* ---------------- 焦点：打开时收进面板、关闭时递回 ---------------- */

/**
 * 给此后创建的每个节点包一层 focus 观测：假 DOM 的 focus() 是空函数，
 * 不记下来就无从断言「焦点到底落到哪个节点上」。
 */
function watchFocus(doc) {
  const calls = [];
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = create(tag);
    const own = node.focus;
    node.focus = (arg) => {
      calls.push({ node, arg });
      if (typeof own === 'function') own.call(node);
    };
    return node;
  };
  return calls;
}

test('open：面板带 tabindex="-1"，打开就把焦点收进面板（前面页面的落点先记下）', () => {
  const ctx = setup({ load: () => makeSteps() });
  const calls = watchFocus(ctx.doc);
  const trigger = ctx.doc.createElement('button');      // 代表胶囊 / 卡片上的入口
  ctx.mount.appendChild(trigger);
  ctx.doc.activeElement = trigger;

  ctx.sheet.open(makeTarget());
  const panel = partOf(ctx.mount, '.ss-panel');
  assert.equal(panel.getAttribute('tabindex'), '-1', '面板要能用 focus() 收下焦点，又不进 Tab 序列');
  assert.equal(calls.length, 1, '打开只需一次移焦（不多次抢焦点）');
  assert.equal(calls[0].node, panel, '焦点应落在面板上');
  assert.deepEqual(calls[0].arg, { preventScroll: true }, '移焦不能把背后的页面滚一下');
  ctx.sheet.destroy();
});

test('没接 focusReturn：关闭时 sheet 自己把焦点递回打开前的元素', async () => {
  const ctx = setup({ load: () => makeSteps() });         // 不传 focusReturn
  const calls = watchFocus(ctx.doc);
  const trigger = ctx.doc.createElement('button');
  ctx.mount.appendChild(trigger);
  ctx.doc.activeElement = trigger;

  await openSettled(ctx);
  calls.length = 0;
  ctx.sheet.close('api');

  assert.equal(calls.length, 1, '关闭应递回一次焦点');
  assert.equal(calls[0].node, trigger, '递回给打开前的那个元素');
  ctx.timers.runAll();
  await tick();
  ctx.sheet.destroy();
});

test('接了 focusReturn：交回由装配方做，sheet 不再自己抢；触发元素已消失时不抛', async () => {
  let returns = 0;
  const ctx = setup({ load: () => makeSteps(), focusReturn: () => { returns += 1; } });
  const calls = watchFocus(ctx.doc);
  const trigger = ctx.doc.createElement('button');
  ctx.mount.appendChild(trigger);
  ctx.doc.activeElement = trigger;

  await openSettled(ctx);
  calls.length = 0;
  ctx.sheet.close('api');
  assert.equal(returns, 1, '钩子被调用');
  assert.deepEqual(calls, [], '接了钩子就不该再由 sheet 自己移焦');
  ctx.timers.runAll();
  await tick();

  // 没接钩子、但触发元素已经从文档上摘掉：静静地不递回，不抛
  const gone = setup({ load: () => makeSteps() });
  const goneCalls = watchFocus(gone.doc);
  const doomed = gone.doc.createElement('button');
  gone.mount.appendChild(doomed);
  gone.doc.activeElement = doomed;
  await openSettled(gone);
  goneCalls.length = 0;
  doomed.remove();
  assert.equal(gone.sheet.close('api'), true, '关闭本身仍该成功');
  assert.deepEqual(goneCalls, [], '触发元素不在了就不硬塞焦点');
  gone.timers.runAll();
  await tick();
  ctx.sheet.destroy();
  gone.sheet.destroy();
});

/* ---------------------------------- 跑 ---------------------------------- */

// 跑测循环必须留在文件末尾：放在中间的话，后面 test(...) 只会 push 进已遍历完的数组，
// 既不会报错也不会变红，等于把所有用例静默摘掉。
test('只有 startedAt 没有 durationMs：用时按起点现算，不显示「—」', async () => {
  const ctx = setup({ load: () => makeSteps(2) });
  // 宿主在跑的过程中只给起点，durationMs 要跑完才补；这段区间不能永远空着
  await openSettled(ctx, makeTarget({ status: 'running', durationMs: null, startedAt: Date.now() - 4200 }));
  const first = textOf(partOf(ctx.mount, '.ss-stats').querySelectorAll('.ss-stat')[0].querySelector('b'));
  assert.notEqual(first, '—', 'running 且有起点时必须算出来');
  assert.match(first, /^\d+(\.\d+)?s$/, `应是一段秒数，实际是 ${first}`);
});

test('宿主补了 durationMs：以宿主为准，不再按起点现算', async () => {
  const ctx = setup({ load: () => makeSteps(2) });
  await openSettled(ctx, makeTarget({ status: 'running', durationMs: null, startedAt: Date.now() - 4200 }));
  assert.equal(ctx.sheet.update({ durationMs: 90000 }), true);
  const cell = partOf(ctx.mount, '.ss-stats').querySelectorAll('.ss-stat')[0];
  assert.equal(textOf(cell.querySelector('b')), '1分30秒', '宿主时长优先，不能被现算覆盖');
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    const message = err && err.message ? err.message : String(err);
    console.log(`      ${message.split('\n').join('\n      ')}`);
  }
}

if (bad === 0) console.log(`\nALL PASS（${tests.length} 个用例）`);
else console.log(`\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
