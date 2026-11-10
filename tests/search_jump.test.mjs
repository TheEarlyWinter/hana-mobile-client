/* tests/search_jump.test.mjs — 搜索结果点进去之后「跳到那条消息」
 *
 * 契约：web/search-jump.js 的 locate / cancel / isLocating / dispose，
 * 以及 web/chat-renderer.js 的 findTurnByText（按文本找 turn）。
 *
 * 为什么全部用注入时钟：这个模块的每一处等待（截止时间、高亮停留）都是定时的。
 * 真定时器会让用例既慢又飘——本文件从头到尾没有 sleep，只用手写 tick 推进：
 * 时间由 createClock 管，翻页由注入的 loadOlder 管，DOM 由 app_harness 的假节点管。
 *
 * 覆盖（父代理给的验收点，一条一个用例）：
 *   1. 首页命中；2. 翻 2 页后命中；3. 没有更多历史；4. 超过 maxPages 停手；
 *   5. 超时；6. 空 query；7. 新调用取消旧调用；8. dispose 后不再动 DOM；
 *   9. 高亮定时器到点被移除；10. 重复 dispose 安全。
 * 另外补的边界：no-container、cancel()、高亮互斥、loadOlder 抛错、
 * 自带查找器不依赖 querySelectorAll（环引用也不卡死）、chat-renderer 的 findTurnByText
 * 与 turn 标记。
 *
 * H9 补的两组（第 2、3、4 条）：
 *   A. 锚点回退：原词找不到时用 snippet 里的无标点长片段（12–40 字，长的优先、超长切窗口）；
 *   B. title 命中且正文无锚点：滚到会话开头并提示「标题命中，已到会话开头」；
 *   C. 翻页预算：正文命中按 messageCount 估页数、有 snippet 无总数多给两页、title 不扩、硬上限封顶。
 *
 * 纪律：所有用例必须登记在文件末尾的跑测循环之前——历史事故里写在循环后的用例
 * 从未执行，却照样打印了 ALL PASS。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createSearchJump } from '../web/search-jump.js';
import { createChatRenderer, findTurnByText as rendererFindTurnByText } from '../web/chat-renderer.js';

const h = createHarness({ debug: false });

/* --------------------------- 可控时钟 --------------------------- */

/** 与 tests/connection_banner.test.mjs 同一套：到期时间最近的一个先触发。 */
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
    pending: () => timers.size,
  };
}

/** 只推进微任务，不等真时间（本文件禁用 sleep）。 */
async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/* --------------------------- 夹具 --------------------------- */

function makeTurn(text, role = 'assistant') {
  const node = h.makeNode('div');
  node.className = `turn ${role}`;
  node.textContent = text;
  return node;
}

function makeContainer(turns = []) {
  const box = h.makeNode('div');
  box.id = 'transcript';
  for (const turn of turns) box.appendChild(turn);
  return box;
}

/** 更早的一页是插到容器最前面的（真实路径是 historyView.append → insertBefore 锚点）。 */
function prepend(box, node) {
  box.insertBefore(node, box.firstChild);
}

/**
 * 只有 children / classList / dataset / textContent 的极简节点：**没有 querySelector(All)**。
 * 用来证明「按文本找 turn」不依赖选择器引擎。
 */
function bareNode(className = '', text = '') {
  const classes = new Set(String(className).split(/\s+/).filter(Boolean));
  const kids = [];
  const node = {
    className,
    dataset: {},
    children: kids,
    parentNode: null,
    textContent: text,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    appendChild(child) {
      kids.push(child);
      child.parentNode = node;
      return child;
    },
  };
  return node;
}

/**
 * @param {object} [options]
 * @param {Element} [options.container] 消息区；默认空容器
 * @param {() => Promise<boolean>} [options.loadOlder] 翻页实现；默认「没有更早的」
 * @param {object} [options.rest] 其余参数原样交给 createSearchJump（可覆盖 getContainer 等）
 */
function createFixture(options = {}) {
  const { container = makeContainer(), loadOlder, ...rest } = options;
  const clock = createClock(1000);
  const scrolls = [];
  const calls = { loadOlder: 0 };
  const behavior = { loadOlder: loadOlder || (async () => false) };

  const jump = createSearchJump({
    document: h.doc,
    getContainer: () => container,
    loadOlder: () => {
      calls.loadOlder += 1;
      return behavior.loadOlder();
    },
    scrollIntoView: (node) => scrolls.push(node),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...rest,
  });

  return { clock, container, scrolls, calls, behavior, jump };
}

/* --------------------------- 用例登记 --------------------------- */

const cases = [];

function test(name, run) {
  cases.push({ name, run });
}

test('首页已加载的内容命中：不翻页，滚过去并高亮', async () => {
  const first = makeTurn('随便一句');
  const target = makeTurn('这里是 季度报告 的正文');
  const last = makeTurn('收尾的一句');
  const { jump, scrolls, calls, clock } = createFixture({ container: makeContainer([first, target, last]) });

  const res = await jump.locate({ query: '季度报告' });

  assert.equal(res.reason, 'found');
  assert.equal(res.found, true);
  assert.equal(res.pagesLoaded, 0);
  assert.equal(calls.loadOlder, 0, '已经命中就不该翻页');
  assert.ok(scrolls.length === 1 && scrolls[0] === target, '要滚到命中的那一轮');
  assert.equal(target.classList.contains('search-hit-flash'), true, '命中的 turn 要带高亮 class');
  assert.equal(first.classList.contains('search-hit-flash'), false, '没命中的不能带高亮');
  assert.equal(jump.isLocating(), false);
  assert.equal(clock.pending(), 1, '只应剩高亮那一个定时器');
});

test('翻 2 页后命中：loadOlder 恰好两次，pagesLoaded=2', async () => {
  const container = makeContainer([makeTurn('最新的消息')]);
  const pages = [
    [makeTurn('第一页旧消息')],
    [makeTurn('第二页旧消息'), makeTurn('很久以前 的 关键句子')],
  ];
  let index = 0;
  const { jump, calls } = createFixture({
    container,
    loadOlder: async () => {
      if (index >= pages.length) return false;
      for (const node of pages[index]) prepend(container, node);
      index += 1;
      return true;
    },
  });

  const res = await jump.locate({ query: '关键句子' });

  assert.equal(res.reason, 'found');
  assert.equal(res.pagesLoaded, 2);
  assert.equal(calls.loadOlder, 2, '两页就够，不能多翻');
});

test('loadOlder 回 false：no-more-history，只翻一次就停', async () => {
  const { jump, calls, clock } = createFixture({ loadOlder: async () => false });

  const res = await jump.locate({ query: '不存在的词' });

  assert.equal(res.reason, 'no-more-history');
  assert.equal(res.found, false);
  assert.equal(res.pagesLoaded, 0);
  assert.equal(calls.loadOlder, 1);
  assert.equal(clock.pending(), 0, '收尾之后不该留任何定时器');
});

test('一直翻不到时在 maxPages 处停手', async () => {
  const container = makeContainer([makeTurn('现场')]);
  const { jump, calls } = createFixture({
    container,
    maxPages: 3,
    loadOlder: async () => {
      prepend(container, makeTurn('更早的一条'));
      return true;
    },
  });

  const res = await jump.locate({ query: '根本没有' });

  assert.equal(res.reason, 'no-more-history', '翻够预算对调用方就等于没更多了');
  assert.equal(res.found, false);
  assert.equal(calls.loadOlder, 3, '最多只能翻 maxPages 页');
  assert.equal(res.pagesLoaded, 3);
});

test('预算用完时说的是「还在更早」，不是谎称「没找到」', async () => {
  const container = makeContainer([makeTurn('现场')]);
  const hints = [];
  const { jump } = createFixture({
    container,
    maxPages: 2,
    loadOlder: async () => { prepend(container, makeTurn('更早的一条')); return true; },
    showHint: (text) => hints.push(text),
  });

  const res = await jump.locate({ query: '根本没有的词', matchKind: 'content', messageCount: 3000 });

  assert.equal(res.reason, 'no-more-history', '对调用方仍等价于「没更多了」');
  assert.equal(res.hint, '翻了设定的页数还没找到，可能还在更早的历史里');
  assert.deepEqual(hints, ['翻了设定的页数还没找到，可能还在更早的历史里'],
    '几千条的会话只扫了几页就说「没找到」是谎');
});

test('loadOlder 挂住时按 timeoutMs 超时，并且不再翻页', async () => {
  let release = null;
  const hang = new Promise((resolve) => { release = resolve; });
  const { jump, clock, calls } = createFixture({ timeoutMs: 5000, loadOlder: () => hang });

  const p = jump.locate({ query: '永远等不到' });
  await flush();
  assert.equal(calls.loadOlder, 1, '夹具：已经翻过一次');
  assert.equal(jump.isLocating(), true);

  clock.advance(4999);
  await flush();
  assert.equal(jump.isLocating(), true, '没到截止时间不能判超时');

  clock.advance(1);   // 到点：截止定时器触发
  const res = await p;

  assert.equal(res.reason, 'timeout');
  assert.equal(res.found, false);
  assert.equal(jump.isLocating(), false);

  clock.advance(60000);
  await flush();
  assert.equal(calls.loadOlder, 1, '超时之后不能再翻页');
  release(true);      // 收尾：让挂住的 loadOlder 落地
});

test('空 query 直接 empty-query，不翻页也不留定时器', async () => {
  const { jump, clock, calls } = createFixture();

  for (const query of ['', '   ', undefined, null]) {
    const res = await jump.locate({ query });
    assert.equal(res.reason, 'empty-query');
    assert.equal(res.found, false);
    assert.equal(res.pagesLoaded, 0);
  }

  assert.equal(calls.loadOlder, 0);
  assert.equal(clock.pending(), 0, '空 query 不该排任何定时器');
});

test('新定位取消旧定位：旧的以 cancelled 收场且不再翻页', async () => {
  const target = makeTurn('第二次要找到的句子');
  const container = makeContainer([target]);
  let loadCount = 0;
  let release = null;
  const hang = new Promise((resolve) => { release = resolve; });

  const { jump } = createFixture({
    container,
    loadOlder: () => {
      loadCount += 1;
      return loadCount === 1 ? hang : Promise.resolve(false);
    },
  });

  const first = jump.locate({ query: '第一次' });
  await flush();
  assert.equal(loadCount, 1, '夹具：第一次已经翻了一页在等');
  assert.equal(jump.isLocating(), true);

  const second = jump.locate({ query: '第二次' });   // 新调用：旧的必须让位
  const firstRes = await first;
  assert.equal(firstRes.reason, 'cancelled', '旧的那次必须以 cancelled 结束');
  assert.equal(firstRes.found, false);

  const secondRes = await second;
  assert.equal(secondRes.reason, 'found');
  assert.equal(secondRes.pagesLoaded, 0, '第二次在首页就命中了');
  assert.equal(jump.isLocating(), false);

  release(true);      // 旧的 loadOlder 后来才回来
  await flush();
  assert.equal(loadCount, 1, '旧循环不能在取消之后继续翻页');
});

test('dispose：摘掉高亮、清定时器，之后不再动 DOM', async () => {
  const target = makeTurn('要闪一下的那条');
  const { jump, clock, scrolls } = createFixture({ container: makeContainer([target]) });

  const res = await jump.locate({ query: '要闪一下' });
  assert.equal(res.reason, 'found');
  assert.equal(target.classList.contains('search-hit-flash'), true);
  assert.equal(clock.pending(), 1, '夹具：高亮定时器排上了');

  jump.dispose();
  assert.equal(target.classList.contains('search-hit-flash'), false, 'dispose 要把自己加的 class 摘掉');
  assert.equal(clock.pending(), 0, '高亮定时器必须被清掉');

  const scrollsBefore = scrolls.length;
  const after = await jump.locate({ query: '要闪一下' });
  assert.equal(after.reason, 'cancelled');

  clock.advance(5000);
  await flush();
  assert.equal(target.classList.contains('search-hit-flash'), false, 'dispose 之后不能再往 DOM 写');
  assert.equal(scrolls.length, scrollsBefore, 'dispose 之后不能再滚动');
});

test('高亮到点自动撤掉（注入定时器推进，不 sleep）', async () => {
  const target = makeTurn('高亮的句子');
  const { jump, clock } = createFixture({ container: makeContainer([target]), highlightMs: 800 });

  await jump.locate({ query: '高亮的句子' });
  assert.equal(target.classList.contains('search-hit-flash'), true);

  clock.advance(799);
  assert.equal(target.classList.contains('search-hit-flash'), true, '没到时间不能提前撤');

  clock.advance(1);
  assert.equal(target.classList.contains('search-hit-flash'), false, '到点必须撤掉');
  assert.equal(clock.pending(), 0);
});

test('重复 dispose 安全，之后 locate 一律 cancelled', async () => {
  const { jump, clock } = createFixture();

  jump.dispose();
  jump.dispose();
  jump.dispose();

  assert.equal(jump.isLocating(), false);
  assert.equal(clock.pending(), 0);

  const res = await jump.locate({ query: '随便什么' });
  assert.equal(res.reason, 'cancelled');
  assert.equal(res.found, false);
});

test('拿不到容器：no-container，不翻页', async () => {
  const { jump, calls } = createFixture({ getContainer: () => null });

  const res = await jump.locate({ query: '随便什么' });

  assert.equal(res.reason, 'no-container');
  assert.equal(res.found, false);
  assert.equal(calls.loadOlder, 0, '没有容器连扫都扫不了，更不该翻页');
});

test('cancel() 主动停手：在途定位以 cancelled 结束，不再翻页', async () => {
  let loadCount = 0;
  const hang = new Promise(() => {});
  const { jump, clock } = createFixture({
    loadOlder: () => {
      loadCount += 1;
      return hang;
    },
  });

  const p = jump.locate({ query: '挂着' });
  await flush();
  assert.equal(loadCount, 1);

  jump.cancel();
  assert.equal(jump.isLocating(), false, 'cancel 之后 isLocating 必须立刻变 false');

  const res = await p;
  assert.equal(res.reason, 'cancelled');

  await flush();
  assert.equal(loadCount, 1, 'cancel 之后不许再翻页');
  assert.equal(clock.pending(), 0);
});

test('第二次命中会摘掉上一次的高亮（同一时刻只有一个落点）', async () => {
  const a = makeTurn('第一句 alpha');
  const b = makeTurn('第二句 beta');
  const { jump } = createFixture({ container: makeContainer([a, b]) });

  await jump.locate({ query: 'alpha' });
  assert.equal(a.classList.contains('search-hit-flash'), true);

  await jump.locate({ query: 'beta' });
  assert.equal(a.classList.contains('search-hit-flash'), false, '旧落点要摘掉，不能两个都闪');
  assert.equal(b.classList.contains('search-hit-flash'), true);
});

test('loadOlder 抛错（同步 / 异步）都按没更多历史收场，不把异常甩出去', async () => {
  const asyncFail = createFixture({ loadOlder: async () => { throw new Error('boom'); } });
  const resA = await asyncFail.jump.locate({ query: '找不到' });
  assert.equal(resA.reason, 'no-more-history');
  assert.equal(asyncFail.calls.loadOlder, 1);

  const syncFail = createFixture({ loadOlder: () => { throw new Error('sync boom'); } });
  const resB = await syncFail.jump.locate({ query: '也找不到' });
  assert.equal(resB.reason, 'no-more-history');
  assert.equal(syncFail.calls.loadOlder, 1);
});

test('注入的 findTurnByText 优先使用（不再自己遍历）', async () => {
  const target = makeTurn('和搜索词无关的文本');
  const asked = [];
  const { jump } = createFixture({
    container: makeContainer([target]),
    findTurnByText: (query) => {
      asked.push(query);
      return target;
    },
  });

  const res = await jump.locate({ query: '任意' });

  assert.equal(res.reason, 'found');
  assert.deepEqual(asked, ['任意']);
  assert.equal(target.classList.contains('search-hit-flash'), true);
});

test('自带查找器：不依赖 querySelectorAll，忽略大小写与空白差异', async () => {
  const box = bareNode('transcript');
  const turn = bareNode('turn assistant', 'Hello   World\n第二行 内容');
  box.appendChild(turn);
  assert.equal(typeof box.querySelectorAll, 'undefined', '夹具：这里根本没有选择器引擎');

  const { jump } = createFixture({ container: box });
  const res = await jump.locate({ query: '  hello world 第二行 ' });

  assert.equal(res.reason, 'found');
  assert.ok(turn.classList.contains('search-hit-flash'));
});

test('假节点互相引用成环时不会卡死', async () => {
  const a = bareNode('wrapper');
  const b = bareNode('wrapper');
  a.children.push(b);
  b.children.push(a);      // 直接造环：绕开 appendChild 的祖先检查

  const { jump } = createFixture({ container: a });
  const res = await jump.locate({ query: '永远找不到' });

  assert.equal(res.reason, 'no-more-history');
  assert.equal(res.found, false);
});

/* ------------------- chat-renderer：turn 标记与按文本查找 ------------------- */

function bootRenderer() {
  const transcript = h.getEl('transcript');
  transcript.innerHTML = '';

  const state = {
    session: { sessionId: 's-search', agentId: 'a1', agentName: 'Hana' },
    userName: '你',
    agentName: 'Hana',
    turn: null,
    turnBody: null,
    turnFootEl: null,
    turnMeta: null,
    thinkAt: 0,
    textEl: null,
    streamingRaw: '',
    moodEl: null,
    moodRaw: '',
    replaying: false,
  };

  const historyView = {
    append(node) { transcript.appendChild(node); },
    isPrepending: () => false,
  };

  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => historyView,
    cardController: null,
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    paintAvatar: () => {},
    agentAvatarUrlById: () => '',
    userAvatarUrl: () => '',
    flash: () => {},
  });

  return { transcript, renderer, state };
}

test('chat-renderer：每轮都带 turnKey，历史条目优先用消息 id', () => {
  const { transcript, renderer } = bootRenderer();

  renderer.appendUser('今天 的 会议纪要', [], [], Date.now());
  renderer.startAssistantTurn();
  renderer.addAssistantText('好的，纪要如下');

  const turns = transcript.children.filter((node) => node.classList.contains('turn'));
  assert.equal(turns.length, 2, '夹具：应有两轮');
  for (const turn of turns) {
    assert.equal(typeof turn.dataset.turnKey, 'string');
    assert.ok(turn.dataset.turnKey.length > 0, '每个 turn 都要有稳定标记');
  }
  assert.notEqual(turns[0].dataset.turnKey, turns[1].dataset.turnKey, '标记不能撞');

  // 历史回放带消息 id：用 id 打标，跨重绘还认得出是哪一条
  renderer.beginHistoryPage();
  renderer.renderEntry({ id: '42', role: 'user', message: { role: 'user', content: '历史里的一条' } });
  renderer.endHistoryPage();

  const historyTurn = transcript.children[transcript.children.length - 1];
  assert.equal(historyTurn.dataset.turnKey, 'm:42');
});

test('chat-renderer.findTurnByText：按文本找回、跳过占位块、不用 querySelectorAll', () => {
  const box = h.makeNode('div');
  const pending = h.makeNode('div');
  pending.className = 'turn assistant pending-tip';
  pending.textContent = '正在思考';
  const turn = h.makeNode('div');
  turn.className = 'turn user';
  turn.textContent = '这里 有 Keyword';
  box.appendChild(pending);
  box.appendChild(turn);

  // 把选择器引擎从夹具上摘掉，证明实现走的是 children 遍历
  box.querySelectorAll = undefined;
  turn.querySelectorAll = undefined;

  assert.ok(rendererFindTurnByText(box, 'keyword') === turn, '忽略大小写与空白');
  assert.equal(rendererFindTurnByText(box, '正在思考'), null, '占位块不能当落点');
  assert.equal(rendererFindTurnByText(box, '   '), null);
  assert.equal(rendererFindTurnByText(null, 'keyword'), null);
  assert.equal(rendererFindTurnByText(box, '完全不存在'), null);
});

/* --------------- H9 第 2 条：snippet 锚点回退（原词找不到时） --------------- */

test('锚点回退：原词不在正文里时，用 snippet 里最长的无标点片段命中', async () => {
  const decoy = makeTurn('另一个话题的回复');
  const target = makeTurn('上周讨论过排序算法的稳定性问题，结论是先按时间排');
  const { jump, scrolls } = createFixture({ container: makeContainer([decoy, target]) });

  const res = await jump.locate({
    query: '季度报告',
    snippet: '...上周讨论过排序算法的稳定性问题...结论...',
    matchKind: 'content',
  });

  assert.equal(res.reason, 'found');
  assert.equal(res.found, true);
  assert.ok(res.anchorIndex >= 1, '命中必须来自 snippet 锚点，不是原词');
  assert.ok(String(res.anchor).length >= 12, 'snippet 锚点至少 12 字');
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0], target, '要滚到 snippet 命中的那一轮');
  assert.equal(decoy.classList.contains('search-hit-flash'), false);
});

test('锚点回退：顺序是「原词 → 长片段 → 次长片段」，短于 12 字的碎片不试', async () => {
  const asked = [];
  const { jump } = createFixture({
    findTurnByText: (query) => { asked.push(query); return null; },
    maxPages: 0,
  });

  const res = await jump.locate({
    query: '原词',
    snippet: '我们先把结论说清楚再讨论细节，另外还有几处需要补充说明。好',
    matchKind: 'content',
  });

  assert.equal(res.found, false);
  assert.deepEqual(asked, ['原词', '我们先把结论说清楚再讨论细节', '另外还有几处需要补充说明']);
});

test('锚点回退：snippet 碎到没有 12 字片段时取最长一段，碎片太短则只用原词', async () => {
  const asked = [];
  const { jump } = createFixture({
    findTurnByText: (query) => { asked.push(query); return null; },
    maxPages: 0,
  });

  await jump.locate({
    query: '报告',
    snippet: '...把 **季度报告** 的结论整理如下：一、收入同比增长 12%，二、毛利率回升...',
    matchKind: 'content',
  });
  assert.deepEqual(asked, ['报告', '的结论整理如下'], '主路径凑不出 12 字才用最长那段');

  asked.length = 0;
  await jump.locate({ query: '报告', snippet: '...好，行，可以...', matchKind: 'content' });
  assert.deepEqual(asked, ['报告'], '全是「好」「行」这种碎片时不拿它们去撞别的轮次');
});

test('锚点回退：超过 40 字的长片段切成头/中/尾三个窗口轮流试', async () => {
  const longSeg = '定位时要尽量使用足够长又足够独特并且不含标点的片段作为锚点'
    + '如果整段拿来比对失败就把长片段切成互相重叠的窗口轮流试';
  const n = longSeg.length;
  assert.ok(n > 40, '夹具：这段必须长过窗口');

  const asked = [];
  const { jump } = createFixture({
    findTurnByText: (query) => { asked.push(query); return null; },
    maxPages: 0,
  });

  await jump.locate({ query: '原词', snippet: `...${longSeg}...`, matchKind: 'content' });

  const mid = Math.floor((n - 40) / 2);
  assert.equal(asked.length, 4, '原词 + 三个窗口，不能更多');
  assert.equal(asked[0], '原词');
  assert.equal(asked[1], longSeg.slice(0, 40), '第一个窗口取片段的开头');
  assert.equal(asked[2], longSeg.slice(mid, mid + 40), '第二个窗口取中间');
  assert.equal(asked[3], longSeg.slice(n - 40), '第三个窗口取结尾');
});

test('锚点回退：长片段的窗口命中即停，不再试后面的窗口', async () => {
  const longSeg = '定位时要尽量使用足够长又足够独特并且不含标点的片段作为锚点'
    + '如果整段拿来比对失败就把长片段切成互相重叠的窗口轮流试';
  const lastWindow = longSeg.slice(longSeg.length - 40);
  const decoy = makeTurn('无关的一轮');
  const target = makeTurn(`前面还有一句 ${lastWindow} 后面这些就不算了`);
  const { jump, scrolls } = createFixture({ container: makeContainer([decoy, target]) });

  const res = await jump.locate({ query: '原词', snippet: `...${longSeg}...`, matchKind: 'content' });

  assert.equal(res.reason, 'found');
  assert.equal(res.anchorIndex, 3, '命中的是第三个窗口');
  assert.equal(scrolls[0], target);
  assert.equal(decoy.classList.contains('search-hit-flash'), false);
});

/* ------------- H9 第 3 条：title 命中、正文无锚点 → 退到会话开头 ------------- */

test('title 命中且正文没有锚点：滚回会话顶部，并提示「标题命中，已到会话开头」', async () => {
  const box = makeContainer([makeTurn('最近的回复'), makeTurn('再早一点')]);
  box.scrollTop = 480;
  const hints = [];
  const { jump } = createFixture({
    container: box,
    loadOlder: async () => false,
    showHint: (text) => hints.push(text),
  });

  const res = await jump.locate({ query: '标题里的词', matchKind: 'title', messageCount: 4 });

  assert.equal(res.found, false);
  assert.equal(res.reason, 'title-top');
  assert.equal(box.scrollTop, 0, '必须滚回会话开头，不能静默停在底部');
  assert.deepEqual(hints, ['标题命中，已到会话开头']);
});

test('正文命中（content）但没找到：不滚顶部，但要说一句（不再静默）', async () => {
  const box = makeContainer([makeTurn('最近的一条')]);
  box.scrollTop = 400;
  const hints = [];
  const { jump } = createFixture({
    container: box,
    loadOlder: async () => false,
    showHint: (text) => hints.push(text),
  });

  const res = await jump.locate({
    query: '找不到的词',
    snippet: '这段正文里也找不到的片段内容',
    matchKind: 'content',
  });

  assert.equal(res.reason, 'no-more-history');
  assert.equal(res.hint, '没找到包含这段内容的轮次');
  assert.equal(box.scrollTop, 400, 'content 失败不该动滚动位置');
  assert.deepEqual(hints, ['没找到包含这段内容的轮次'], '翻完没找到要告诉用户，否则看起来像没生效');
});

test('超时也要说一句：长会话翻不完时提示「慢」，而不是谎称没找到', async () => {
  const box = makeContainer([makeTurn('最近的一条')]);
  const hints = [];
  let release = null;
  const hang = new Promise((resolve) => { release = resolve; });
  const { jump, clock } = createFixture({
    container: box,
    timeoutMs: 5000,
    loadOlder: () => hang,
    showHint: (text) => hints.push(text),
  });

  const p = jump.locate({ query: '在前面的某一条里', matchKind: 'content' });
  await flush();
  clock.advance(5000);
  const res = await p;

  assert.equal(res.reason, 'timeout');
  assert.equal(res.hint, '搜索太慢，没能在时限内翻完；换个更短的关键词试试');
  assert.deepEqual(hints, ['搜索太慢，没能在时限内翻完；换个更短的关键词试试'],
    '真机上这里沉默 45 秒，用户以为点了没反应');
  assert.equal(box.scrollTop, 0, '超时不该动滚动位置');
  release(true);
});

test('title 命中但正文里其实找得到：正常高亮，不提示、不滚顶部', async () => {
  const box = makeContainer([makeTurn('标题里的词 其实出现在正文')]);
  box.scrollTop = 200;
  const hints = [];
  const { jump, scrolls } = createFixture({
    container: box,
    showHint: (text) => hints.push(text),
  });

  const res = await jump.locate({ query: '标题里的词', matchKind: 'title', messageCount: 1 });

  assert.equal(res.reason, 'found');
  assert.equal(scrolls.length, 1);
  assert.equal(box.scrollTop, 200, '找到落点时滚动交给 reveal，不该被抬到顶部');
  assert.deepEqual(hints, []);
});

test('title 命中但定位超时：不乱说「已到开头」，也不乱滚', async () => {
  const box = makeContainer([makeTurn('最近的一条')]);
  box.scrollTop = 300;
  const hints = [];
  const { jump, clock } = createFixture({
    container: box,
    timeoutMs: 5000,
    loadOlder: () => new Promise(() => {}),
    showHint: (text) => hints.push(text),
  });

  const p = jump.locate({ query: '标题里的词', matchKind: 'title', messageCount: 40 });
  await flush();
  clock.advance(5000);
  const res = await p;

  assert.equal(res.reason, 'timeout');
  assert.equal(box.scrollTop, 300, '没翻完就不能说「已到会话开头」');
  assert.deepEqual(hints, []);
});

/* ------------------- H9 第 4 条：翻页预算按会话体量估 ------------------- */

test('翻页预算：正文命中按 messageCount 估页数，不再撞默认 5 页上限', async () => {
  const container = makeContainer([makeTurn('最新的一轮')]);
  let n = 0;
  const { jump, calls } = createFixture({
    container,
    maxPages: 5,
    loadOlder: async () => {
      n += 1;
      prepend(container, makeTurn(`更早的一轮 ${n}`));
      return true;
    },
  });

  const res = await jump.locate({
    query: '找不到的词',
    snippet: '一段足够长的正文片段用来做锚点',
    matchKind: 'content',
    messageCount: 400,
  });

  assert.equal(res.reason, 'no-more-history');
  assert.equal(calls.loadOlder, 9, '400 条 / 每页 50 = 8 页，再加 1 页重叠余量');
});

test('翻页预算：title 命中不按 messageCount 扩预算（正文可能压根没有那个词）', async () => {
  const container = makeContainer([makeTurn('最新的一轮')]);
  let n = 0;
  const { jump, calls } = createFixture({
    container,
    maxPages: 5,
    loadOlder: async () => {
      n += 1;
      prepend(container, makeTurn(`更早的一轮 ${n}`));
      return true;
    },
  });

  const res = await jump.locate({ query: '标题里的词', matchKind: 'title', messageCount: 400 });

  assert.equal(res.reason, 'title-top');
  assert.equal(calls.loadOlder, 5, '标题命中只翻基础预算');
});

test('翻页预算：有正文 snippet 但没有 messageCount 时，比基础预算多给两页', async () => {
  const container = makeContainer([makeTurn('最新的一轮')]);
  let n = 0;
  const { jump, calls } = createFixture({
    container,
    maxPages: 5,
    loadOlder: async () => {
      n += 1;
      prepend(container, makeTurn(`更早的一轮 ${n}`));
      return true;
    },
  });

  await jump.locate({
    query: '找不到的词',
    snippet: '一段足够长的正文片段用来做锚点',
    matchKind: 'content',
  });

  assert.equal(calls.loadOlder, 7, '5 + 2');
});

test('翻页预算：超长会话按硬上限封顶，maxPageCap 可调', async () => {
  const container = makeContainer([makeTurn('最新的一轮')]);
  let n = 0;
  const count = () => {
    n += 1;
    prepend(container, makeTurn(`更早的一轮 ${n}`));
    return true;
  };

  const first = createFixture({ container, maxPages: 5, loadOlder: async () => count() });
  await first.jump.locate({ query: '找不到的词', snippet: '一段足够长的正文片段用来做锚点', matchKind: 'content', messageCount: 100000 });
  assert.equal(first.calls.loadOlder, 12, '默认硬上限 12 页');

  const box2 = makeContainer([makeTurn('最新的一轮')]);
  const second = createFixture({ container: box2, maxPages: 5, maxPageCap: 6, loadOlder: async () => true });
  await second.jump.locate({ query: '找不到的词', snippet: '一段足够长的正文片段用来做锚点', matchKind: 'content', messageCount: 100000 });
  assert.equal(second.calls.loadOlder, 6, 'maxPageCap 可以压低硬上限');
});

/* --------------------------- 截止时间按会话规模放宽 --------------------------- */

/** 一个永远不结束的翻页：用来把定位拖到截止时间上。 */
function hangingLoadOlder() {
  return new Promise(() => {});
}

test('大会话正文命中：不传 timeoutMs 时按页数放宽，12 秒不再一撞就死', async () => {
  const box = makeContainer([makeTurn('最新一条')]);
  const { clock, jump } = createFixture({ container: box, loadOlder: hangingLoadOlder });

  const pending = jump.locate({ query: '找不到的词', snippet: '一段正文片段', matchKind: 'content', messageCount: 600 });
  await flush();

  clock.advance(13000);
  await flush();
  assert.equal(jump.isLocating(), true, '大会话按页放宽后，13 秒不应该收场（实测一页要 7.5–8.4 秒）');

  clock.advance(32000);
  await flush();
  const res = await pending;
  assert.equal(res.reason, 'timeout');
  assert.equal(res.pagesLoaded, 0);
});

test('小会话：不传 timeoutMs 也保持 12 秒，不为慢网背锅', async () => {
  const box = makeContainer([makeTurn('最新一条')]);
  const { clock, jump } = createFixture({ container: box, loadOlder: hangingLoadOlder });

  const pending = jump.locate({ query: '找不到的词', matchKind: 'content', messageCount: 60 });
  await flush();
  clock.advance(12000);
  await flush();
  const res = await pending;
  assert.equal(res.reason, 'timeout');
});

test('标题命中：大会话也不放宽（正文里可能压根没那个词）', async () => {
  const box = makeContainer([makeTurn('最新一条')]);
  const { clock, jump } = createFixture({ container: box, loadOlder: hangingLoadOlder });

  const pending = jump.locate({ query: '标题里的词', matchKind: 'title', messageCount: 600 });
  await flush();
  clock.advance(12000);
  await flush();
  const res = await pending;
  assert.equal(res.reason, 'timeout');
});

test('显式传 timeoutMs：完全听调用方，不自动放宽', async () => {
  const box = makeContainer([makeTurn('最新一条')]);
  const { clock, jump } = createFixture({ container: box, loadOlder: hangingLoadOlder, timeoutMs: 5000 });

  const pending = jump.locate({ query: '找不到的词', matchKind: 'content', messageCount: 600 });
  await flush();
  clock.advance(5000);
  await flush();
  const res = await pending;
  assert.equal(res.reason, 'timeout');
});

/* --------------------------- 跑测循环（必须在全部用例之后） --------------------------- */

let failed = 0;
for (const item of cases) {
  try {
    await item.run();
    console.log(`PASS  ${item.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${item.name}\n      ${err.stack || err.message}`);
  }
}

console.log(failed === 0 ? `\nALL PASS（${cases.length} 个用例）` : `\nFAILED (${failed} tests failed)`);
process.exit(failed === 0 ? 0 : 1);
