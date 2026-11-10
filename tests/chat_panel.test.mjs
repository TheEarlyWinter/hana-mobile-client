/* tests/chat_panel.test.mjs — 聊天区装配层（web/chat-panel.js）
 *
 * 为什么单独写：渲染器、search-jump、code-copy 各自的单测全绿，也不代表装配层接对了。
 * 一晚上三个真机 bug 里有两条就出在这一层：
 *   1. finder 签名接错——模块要 (query) => Element，渲染器给的是 (container, query) => Element，
 *      少包一层就等于把 query 当容器，永远返回 null；
 *   2. 定位早于首屏——openSession 的 Promise 回来时 #transcript 还空着，扫描变成空扫描。
 * 这里用真渲染器 + 共用假 DOM（tests/support/app_harness.mjs），把这两条钉在「装配」上：
 * 故意把 finder 改回没绑容器的写法，第 1 条必须变红（反向验证步骤见提交说明）。
 *
 * 另外三条：setViewMode 是否真的转发、缺必需注入是否出声、代码块复制是否真装上并且
 * 走的是注入的复制实现。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createChatPanel } from '../web/chat-panel.js';
import { createRendererState } from '../web/renderer-state.js';

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

/** 微任务冲刷：本文件里除了 waitForTranscript 的假计时器，其余全是同步 + Promise。 */
async function flush(n = 6) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/** 一段带围栏代码的 markdown：用户消息就能渲染出 .md-code，省掉造流式那一套。 */
const CODE_TEXT = ['看这段复制的接线', '', '```js', 'const a = 1;', '```'].join('\n');

/**
 * 装配一套聊天区：真渲染器 + 共用假 DOM。只把复制实现、翻页换成可观察的桩。
 *
 * @param {object} [overrides] 覆盖任意注入项（含 createRenderer 这个单测缝）
 */
function bootPanel(overrides = {}) {
  const h = createHarness({ debug: false });
  const transcript = h.getEl('transcript');
  transcript.innerHTML = '';

  const historyView = {
    append: (node) => transcript.appendChild(node),
    isPrepending: () => false,
  };

  const appState = {
    session: { sessionId: 's-panel', path: 'C:/sessions/panel', agentName: 'Hana' },
    userName: '你',
    agentName: 'Hana',
  };

  const copied = [];
  const panel = createChatPanel({
    document: h.doc,
    getElement: (id) => h.getEl(id),
    rendererState: createRendererState(),
    appState,
    getHistoryView: () => historyView,
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    avatars: { paint: () => {}, agentUrlById: () => '', userUrl: () => '' },
    flash: () => {},
    onBusyChange: () => {},
    // 复制实现由装配层注入（app 传 message-actions 的 copyTextToClipboard）；
    // 漏传时下面的用例会拿不到调用记录。
    copyText: async (text) => {
      copied.push(text);
      return { ok: true };
    },
    loadOlder: async () => false,
    ...overrides,
  });

  return { h, transcript, historyView, appState, copied, panel };
}

/* ------------------------------------------------------------------ */
/* 1. finder 必须绑容器                                                 */
/* ------------------------------------------------------------------ */

await t('1. finder 绑对了容器：searchJump.locate 命中真实渲染出的 turn', async () => {
  const { transcript, panel } = bootPanel();

  // 两条用户消息：命中只该落在第一条上。
  panel.renderer.appendUser('请看一下这段日志里的 finder 签名', [], [], Date.parse('2026-11-01T10:00:00.000Z'));
  panel.renderer.appendUser('第二条跟搜索无关的消息', [], [], Date.parse('2026-11-01T10:01:00.000Z'));

  const turns = transcript.querySelectorAll('.turn');
  assert.equal(turns.length, 2, '两次 appendUser 应该渲染出两轮');
  const target = turns[0];
  const other = turns[1];

  const res = await panel.searchJump.locate({ query: 'finder签名' });
  assert.equal(res.found, true, `定位应命中，实际 reason=${res.reason}`);
  assert.equal(res.pagesLoaded, 0, '首屏就命中时不该去翻历史');
  assert.ok(target.classList.contains('search-hit-flash'), '命中的那一轮应该被高亮');
  assert.ok(!other.classList.contains('search-hit-flash'), '没命中的轮次不该被高亮');
  // 高亮定时器（1600ms）收掉，别把进程多留一会儿。
  panel.searchJump.dispose();
});

/* ------------------------------------------------------------------ */
/* 2. waitForTranscript 的时序                                          */
/* ------------------------------------------------------------------ */

await t('2. waitForTranscript：空区先等（100ms 一轮），出现 .turn 才返回', async () => {
  const { h, transcript, panel } = bootPanel();

  // 假计时器：只收下回调，不真等。window 上的 rAF 也走同一份 setTimeout，
  // 所以这里接管期间不要跑渲染相关的路径（本用例只调 waitForTranscript）。
  const realSetTimeout = globalThis.setTimeout;
  const pending = [];
  globalThis.setTimeout = (fn, ms) => {
    pending.push({ fn, ms });
    return pending.length;
  };
  const pushRound = () => {
    const batch = pending.splice(0);
    for (const item of batch) item.fn();
    return batch;
  };
  const settleOrThrow = async (promise, label) => {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`等待超时：${label}`)), 1000);
    });
    try {
      await Promise.race([promise, guard]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  };

  try {
    let settled = false;
    const wait = panel.waitForTranscript().then(() => { settled = true; });

    await flush();
    assert.equal(settled, false, '消息区还空着就不该返回（定位会拿到一次空扫描）');
    assert.equal(pending.length, 1, '空区应该排了一次等待');
    assert.equal(pending[0].ms, 100, '轮询间隔应该是 100ms');

    // 第二轮仍然空：推一轮，还是不许返回。
    pushRound();
    await flush();
    assert.equal(settled, false, '仍然空的时候不该返回');
    assert.equal(pending.length, 1, '应该继续等下一轮');

    // 历史控制带先插进来（pager 发请求前就 emitState）：这不是首屏就绪，还要继续等。
    const bar = h.makeNode('div', 'history-pagination-bar');
    transcript.appendChild(bar);
    pushRound();
    await flush();
    assert.equal(settled, false, '只有控制带不算首屏就绪：定位会扫到空屏');

    // 真正的轮次到了：下一轮检查立刻返回，不再多排定时器。
    // （循环一次只排一个定时器，所以要「等微任务 → 推一轮」多跑几拍。）
    const turnNode = h.makeNode('div', '');
    turnNode.className = 'turn';
    transcript.appendChild(turnNode);
    for (let i = 0; i < 3 && !settled; i += 1) {
      await flush();
      pushRound();
    }
    await settleOrThrow(wait, '出现 .turn 后 waitForTranscript 应返回');
    assert.equal(settled, true, '有轮次后应该返回');
    assert.equal(pending.length, 0, '返回后不该再排定时器');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  // 已经有轮次时同步返回（不排任何定时器）。
  const before = pending.length;
  await panel.waitForTranscript();
  assert.equal(pending.length, before, '已经有轮次时应该直接返回，不进轮询');
});

/* ------------------------------------------------------------------ */
/* 3. setViewMode 转发                                                  */
/* ------------------------------------------------------------------ */

await t('3. setViewMode 真的转到渲染器（假渲染器注入也能装配）', () => {
  const seen = [];
  const { panel } = bootPanel({
    // 单测缝：只提供 setViewMode，装配层不该在这条路径上碰别的成员。
    createRenderer: (options) => {
      seen.push(options);
      return { setViewMode: (mode) => seen.push(mode) };
    },
  });

  assert.equal(seen.length, 1, '装配时应恰好建一次渲染器');
  const injected = seen[0];
  assert.equal(injected.appState.session.sessionId, 's-panel', '应用级状态应原样交给渲染器');
  assert.equal(injected.state.turn, null, '渲染进度袋子应是独立的那个实例');
  assert.equal(typeof injected.onBlocksRendered, 'function', '渲染后钩子必须由面板自己接（代码块复制靠它）');
  assert.equal(typeof injected.onBusyChange, 'function');

  panel.setViewMode('classic');
  panel.setViewMode('serene');
  assert.deepEqual(seen.slice(1), ['classic', 'serene'], 'setViewMode 必须逐次转发给渲染器');
});

/* ------------------------------------------------------------------ */
/* 4. 必需注入缺失就出声                                                */
/* ------------------------------------------------------------------ */

await t('4. 缺必需注入时抛 TypeError（挑三项关键的）', () => {
  const h = createHarness({ debug: false });
  const base = {
    document: h.doc,
    getElement: (id) => h.getEl(id),
    rendererState: createRendererState(),
    appState: { session: null, userName: '', agentName: '' },
    copyText: async () => ({ ok: true }),
  };
  const names = (needle) => (err) => err instanceof TypeError && err.message.includes(needle);

  assert.throws(() => createChatPanel(), names('document'), '一个参数都不给该抛 document 缺失');
  assert.throws(
    () => createChatPanel({ ...base, getElement: undefined }),
    names('getElement'),
    '缺 getElement 该抛（取不到 #transcript 就没法装复制、也没法定位）',
  );
  assert.throws(
    () => createChatPanel({ ...base, copyText: undefined }),
    names('copyText'),
    '缺 copyText 该抛（否则复制按钮点了只会显示「复制失败」）',
  );
});

/* ------------------------------------------------------------------ */
/* 5. 代码块复制的接线                                                  */
/* ------------------------------------------------------------------ */

await t('5. codeCopy 装上：渲染后自动补按钮，点击走注入的复制实现', async () => {
  const { transcript, copied, panel } = bootPanel();

  panel.renderer.appendUser(CODE_TEXT, [], [], Date.parse('2026-11-01T10:00:00.000Z'));

  const block = transcript.querySelector('.md-code');
  assert.ok(block, '夹具应渲染出代码块（.md-code）');
  const btn = block.querySelector('.code-copy-btn');
  assert.ok(btn, '代码块上应该自动补出复制按钮（onBlocksRendered → codeCopy.sync 的接线）');
  assert.ok(block.classList.contains('has-code-copy'), '补过按钮的块要打上 has-code-copy（CSS 靠它）');
  assert.equal(typeof panel.codeCopy.sync, 'function', 'codeCopy 应是 code-copy 的控制器（有 sync）');

  // 事件委托挂在 #transcript 上：点击要从容器派发（真 DOM 里按钮会冒泡上来）。
  transcript.dispatchEvent({ type: 'click', target: btn });
  await flush();

  assert.deepEqual(copied, ['const a = 1;'], '点击必须调用注入的 copyText，内容是 <pre> 的原文');
  assert.equal(btn.textContent, '已复制', '复制成功后按钮文案要反馈');
  assert.equal(panel.codeCopy.sync(transcript), 0, '再同步一次不该重复加按钮（幂等）');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
