/* tests/chat_renderer_history_live.test.mjs — 历史页边界的「保住实时轮」
 *
 * 契约：历史契约（生成中翻页）的 2.3 / 3（单元 B）。
 *
 * 背景：生成中允许「加载更早」后，一边在跑流式、一边往上面 prepend 历史页。
 * 历史回放同样走 startAssistantTurn，会把历史轮写进 state.turn 等实时轮指针；
 * 页边界原来一律清空，于是正在跑的那一轮当场丢了指针——后面的 delta 另起一轮，
 * 实时气泡永远停在「正在进行」。
 *
 * 这里钉住四件事：
 *   1. 不带参时行为一个字不变：页边界清空实时轮指针，历史轮不被实时路由接管；
 *   2. preserveLiveTurn：begin 仍然清空（否则历史轮顶掉实时轮），end 原样还原，
 *      之后的 addAssistantText / addThinking / addTool 继续写回原来那一轮；
 *   3. 只 begin(preserve) 不 end（中途抛错、调用方忘了配对）之后，一次普通 begin
 *      必须把暂存丢掉，回到默认语义，不留永久脏状态；
 *   4. 中途抛错本身不需要特殊清理：下一次普通页边界就能自愈。
 *
 * 夹具照 tests/subagent_view.test.mjs / chat_renderer_serene.test.mjs：真渲染器 +
 * app_harness 的假 DOM，historyView 用一个最小桩（append + isPrepending）。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createChatRenderer } from '../web/chat-renderer.js';

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

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/* 节点身份一律用 assert.ok(a === b)：假 DOM 的节点互相指向、环很大，
   assert.equal 在失败时会把两棵树 util.inspect 一遍，断言没命中就变成挂死。 */
const same = (a, b) => a === b;

/** 实时轮指针的十个字段（与 clearLiveTurn 同一组）。断言里逐条点名，便于定位。 */
function assertCleared(state, where) {
  assert.equal(state.turn, null, `${where}：state.turn 必须清空`);
  assert.equal(state.turnBody, null, `${where}：state.turnBody 必须清空`);
  assert.equal(state.turnFootEl, null, `${where}：state.turnFootEl 必须清空`);
  assert.equal(state.turnMeta, null, `${where}：state.turnMeta 必须清空`);
  assert.equal(state.thinkAt, 0, `${where}：state.thinkAt 必须归零`);
  assert.equal(state.textEl, null, `${where}：state.textEl 必须清空`);
  assert.equal(state.streamingRaw, '', `${where}：state.streamingRaw 必须清空`);
  assert.equal(state.moodEl, null, `${where}：state.moodEl 必须清空`);
  assert.equal(state.moodRaw, '', `${where}：state.moodRaw 必须清空`);
  assert.equal(state.replaying, false, `${where}：state.replaying 必须复位`);
}

/** 断言用的紧凑文本：假 DOM 的兄弟文本之间会补空格，这里统一抹掉。 */
const flat = (node) => String(node?.textContent ?? '').replace(/\s+/g, '');

function assistantEntry(text) {
  return {
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: '2026-11-05T10:00:00.000Z',
  };
}

function boot(overrides = {}) {
  const h = createHarness({ debug: false });
  const transcript = h.getEl('transcript');
  transcript.innerHTML = '';

  const state = {
    session: { sessionId: 's-live', path: 'C:/sessions/live', agentName: 'Hana' },
    userName: '你',
    agentName: 'Hana',
    // 实时轮指针的十个字段（与 clearLiveTurn 同一组）
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

  // 只在用例需要时让 append 抛错，模拟「回放中途出错」。
  const flags = { failAppend: false };
  const historyView = {
    append(node) {
      if (flags.failAppend) throw new Error('夹具：append 失败');
      transcript.appendChild(node);
    },
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
    onBusyChange: () => {},
    ...overrides,
  });

  const turns = () => transcript.querySelectorAll('.turn');
  const lastTurn = () => {
    const all = turns();
    return all[all.length - 1] || null;
  };
  return { h, state, flags, renderer, transcript, turns, lastTurn };
}

/** 造一轮「正在生成」的实时轮：思考 + 工具 + 已吐的正文都在。 */
function startLiveTurn({ renderer, state }) {
  renderer.startAssistantTurn();
  renderer.addThinking('实时思考');
  renderer.addTool('read', undefined, '运行中', 'live-1');
  renderer.addAssistantText('实时正文');
  assert.ok(state.turn, '夹具：应有实时轮');
  assert.ok(state.turnMeta && state.textEl && state.turnFootEl, '夹具：实时轮的过程行与正文都该在');
  return {
    turn: state.turn,
    body: state.turnBody,
    meta: state.turnMeta,
    text: state.textEl,
    foot: state.turnFootEl,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 默认语义不变                                                      */
/* ------------------------------------------------------------------ */

await t('默认：页边界清空实时轮指针，历史轮不会被实时路由接管', () => {
  const { h, state, renderer, lastTurn } = boot();
  const live = startLiveTurn({ renderer, state });
  const liveTextBefore = flat(live.turn);

  renderer.beginHistoryPage();
  assertCleared(state, 'beginHistoryPage() 之后');

  assert.equal(renderer.renderEntry(assistantEntry('历史正文')), true, '历史 entry 应画出来');
  const histTurn = lastTurn();
  assert.ok(!same(histTurn, live.turn), '历史轮必须是新的一轮，不能是实时轮');
  assert.ok(flat(histTurn).includes('历史正文'), '历史轮要带自己的正文');
  // 页内 startAssistantTurn 会把历史轮写进 state.turn（同页合并要用），这是页内行为；
  // 关键是它指向历史轮，而不是把实时轮留给实时路由。
  assert.ok(same(state.turn, histTurn), '页内 state.turn 指向本页历史轮（合并用）');

  renderer.endHistoryPage();
  assertCleared(state, 'endHistoryPage() 之后');
  assert.ok(!flat(live.turn).includes('历史正文'), '实时轮不能被历史正文写脏');
  assert.equal(flat(live.turn), liveTextBefore, '实时轮内容应逐字未变');
});

await t('默认：end 之后不再还给实时轮（指针已丢，实时路径另起一轮）', () => {
  const { state, renderer, lastTurn } = boot();
  const live = startLiveTurn({ renderer, state });

  renderer.beginHistoryPage();
  renderer.renderEntry(assistantEntry('历史正文'));
  renderer.endHistoryPage();

  // 实时路由看到 state.turn 为空会开新轮：这里直接起一轮代表它。
  renderer.startAssistantTurn();
  const next = lastTurn();
  assert.ok(!same(next, live.turn), '结束后不应把指针还给旧轮（默认语义就是丢）');
  assert.ok(!same(state.turn, live.turn), 'state.turn 不能被历史页还给旧轮');
});

/* ------------------------------------------------------------------ */
/* 2. preserveLiveTurn：暂存 → 清空 → 还原 → 继续写回原轮                */
/* ------------------------------------------------------------------ */

await t('preserveLiveTurn：begin 仍然清空，回放不改写实时轮，结束后继续写回原轮', async () => {
  const { h, state, renderer, lastTurn } = boot();
  const live = startLiveTurn({ renderer, state });

  renderer.beginHistoryPage({ preserveLiveTurn: true });
  // 关键：保护 ≠ 不清。留着指针，回放的历史轮会直接盖掉实时轮。
  assertCleared(state, 'beginHistoryPage({preserveLiveTurn:true}) 之后');

  // 一页里两条连续 assistant：本页内仍然合并成一轮历史轮
  renderer.renderEntry(assistantEntry('历史一'));
  renderer.renderEntry(assistantEntry('历史二'));
  const histTurn = lastTurn();
  assert.ok(!same(histTurn, live.turn), '回放要开自己的历史轮');
  assert.ok(flat(histTurn).includes('历史一') && flat(histTurn).includes('历史二'), '同页合并后两条正文都在');

  renderer.endHistoryPage({ preserveLiveTurn: true });

  assert.ok(same(state.turn, live.turn), '结束时必须把实时轮指针原样还原');
  assert.ok(same(state.turnBody, live.body), 'turnBody 应还原到实时轮的正文');
  assert.ok(same(state.turnMeta, live.meta), 'turnMeta 应还原到实时轮的过程行');
  assert.ok(same(state.turnFootEl, live.foot), 'turnFootEl 应还原到实时轮的尾注');
  assert.ok(same(state.textEl, live.text), 'textEl 应还原到实时轮的正文节点');
  assert.equal(state.streamingRaw, '实时正文', 'streamingRaw 应还原成实时轮已吐的正文');
  assert.equal(state.replaying, false, 'replaying 不能留在回放状态');
  assert.ok(!flat(histTurn).includes('实时正文'), '历史轮不能被实时正文写脏');
  assert.ok(!flat(live.turn).includes('历史'), '实时轮不能被历史内容写脏');

  // 后续实时 delta：必须续进原来那一轮
  renderer.addAssistantText('继续');
  await h.settle(4);   // 流式重绘走 requestAnimationFrame
  assert.ok(flat(live.turn).includes('实时正文继续'), `delta 应续进实时轮，实际：${flat(live.turn)}`);
  assert.ok(!flat(histTurn).includes('继续'), 'delta 不能落进历史轮');

  // 后续思考：过程行也必须写在实时轮上
  renderer.addThinking('第二段思考');
  assert.ok(flat(live.meta).includes('第二段思考'), `思考应写进实时轮的过程行，实际：${flat(live.meta)}`);
  assert.ok(!flat(histTurn).includes('第二段思考'), '思考不能写进历史轮');

  // 后续工具调用：同一份过程行，追加新行
  renderer.addTool('bash', undefined, '运行中', 'live-2');
  const liveRows = live.meta.querySelectorAll('.meta-tool');
  assert.equal(liveRows.length, 2, `实时轮应有两行工具，实际 ${liveRows.length}`);
  assert.ok(flat(liveRows[1]).includes('bash'), '新工具行应在实时轮的过程行里');
  assert.equal(histTurn.querySelectorAll('.meta-tool').length, 0, '历史轮不该多出实时工具行');
});

await t('preserveLiveTurn：还原的指针就是原来那一轮，不是新建的一轮', () => {
  const { state, renderer, turns, transcript } = boot();
  const live = startLiveTurn({ renderer, state });
  const countBefore = turns().length;

  renderer.beginHistoryPage({ preserveLiveTurn: true });
  renderer.renderEntry(assistantEntry('历史正文'));
  renderer.endHistoryPage({ preserveLiveTurn: true });

  assert.equal(turns().length, countBefore + 1, '只应多出历史轮本身，不该为还原另建节点');
  assert.ok(same(state.turn, live.turn), '还原的是同一份引用');
  assert.ok(same(state.turn.parentNode, transcript), '还原的轮仍挂在消息区上');
  assert.ok(same(state.turnBody.parentNode.parentNode, live.turn), '还原的正文仍在原来那一轮里');
});

/* ------------------------------------------------------------------ */
/* 3. 只 begin(preserve) 不 end：下一次普通 begin 回到干净状态            */
/* ------------------------------------------------------------------ */

await t('只 begin(preserve) 不 end：下一次普通 begin 丢掉暂存，不会把脏轮还回来', () => {
  const { h, state, renderer } = boot();
  const live = startLiveTurn({ renderer, state });

  renderer.beginHistoryPage({ preserveLiveTurn: true });
  renderer.renderEntry(assistantEntry('历史一'));
  // 这里故意不调 endHistoryPage：模拟调用方漏了配对（异常、提前 return）。

  renderer.beginHistoryPage();   // 下一次普通的页边界（下一页 / 整页替换）
  assertCleared(state, '普通 beginHistoryPage() 之后');

  renderer.renderEntry(assistantEntry('历史二'));
  // 用带参的 end 去探针：暂存真的被丢掉了，就不会把上面那一轮的指针还回来。
  renderer.endHistoryPage({ preserveLiveTurn: true });

  assertCleared(state, '普通 begin + end({preserveLiveTurn:true}) 之后');
  assert.ok(!same(state.turn, live.turn), '暂存必须已被丢弃，不能留永久脏状态');
  assert.ok(!flat(live.turn).includes('历史'), '实时轮不能被历史内容写脏');
  assert.ok(h.doc, '夹具仍可用');
});

/* ------------------------------------------------------------------ */
/* 4. 中途抛错：不需要特殊清理，下一次普通页边界自愈                      */
/* ------------------------------------------------------------------ */

await t('回放中途抛错：不需要特殊清理，下一次普通 begin 就能自愈', () => {
  const { h, state, flags, renderer } = boot();
  const live = startLiveTurn({ renderer, state });

  flags.failAppend = true;
  renderer.beginHistoryPage({ preserveLiveTurn: true });
  assert.throws(
    () => renderer.renderEntry(assistantEntry('历史一')),
    /append 失败/,
    '夹具：这一页应该在 append 时炸掉',
  );
  // 异常已经抛出，调用方走不到 endHistoryPage —— 这正是契约要求能自愈的形状。
  flags.failAppend = false;

  renderer.beginHistoryPage();
  assertCleared(state, '异常后普通 beginHistoryPage() 之后');
  assert.equal(renderer.renderEntry(assistantEntry('历史二')), true, '自愈后历史页仍能正常渲染');
  renderer.endHistoryPage({ preserveLiveTurn: true });
  assertCleared(state, '异常后普通页边界走完');
  assert.ok(!same(state.turn, live.turn), '异常前暂存的实时轮不能被还回来');
  assert.ok(!flat(live.turn).includes('历史二'), '实时轮不能被后一页的历史内容写脏');
  assert.ok(h.doc, '夹具仍可用');
});

/* ------------------------------------------------------------------ */
/* 5. 契约没写的一条：已有暂存时再 begin(preserve) 不覆盖（解释见回执）    */
/* ------------------------------------------------------------------ */

await t('连续两个 preserve 页而前一个没 end：不覆盖已有暂存，结束时还原真正的实时轮', () => {
  const { state, renderer } = boot();
  const live = startLiveTurn({ renderer, state });

  renderer.beginHistoryPage({ preserveLiveTurn: true });
  renderer.renderEntry(assistantEntry('历史一'));
  // 没 end（模拟异常）就来了第二个 preserve 页：这时 state 已被清成一片 null，
  // 再抄一遍只会把真正的实时轮指针换成 null。
  renderer.beginHistoryPage({ preserveLiveTurn: true });
  renderer.renderEntry(assistantEntry('历史二'));
  renderer.endHistoryPage({ preserveLiveTurn: true });

  assert.ok(same(state.turn, live.turn), '应还原第一次暂存的实时轮，而不是一份 null');
  assert.equal(state.streamingRaw, '实时正文', 'streamingRaw 应来自真正的实时轮');
});

t('生成中 prepend 一页含 user 条目：不把 busy 假复位、也不收占位块', async () => {
  const busyCalls = [];
  const { renderer, state, transcript } = boot({ onBusyChange: (value) => busyCalls.push(value) });

  renderer.startAssistantTurn();
  renderer.addAssistantText('实时正文');
  renderer.showPending();
  const live = state.turn;
  const pendingBefore = transcript.querySelector('.pending-tip');
  assert.ok(live && pendingBefore, '夹具：实时轮与占位块都该在');
  const mark = busyCalls.length;

  // 历史页里一定有 user 条目：它会走 appendUser → resetTurnState。
  // 回放期间那一步只能结束合并，不能报 busy、不能收占位块。
  renderer.beginHistoryPage({ preserveLiveTurn: true });
  renderer.renderEntry({
    role: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '早先的问题' }] },
    timestamp: '2026-11-05T09:00:00.000Z',
  });
  renderer.endHistoryPage();

  const leaked = busyCalls.slice(mark).filter((value) => value === false);
  assert.equal(leaked.length, 0, `回放 user 条目不能报 busy=false，实际：${JSON.stringify(busyCalls.slice(mark))}`);
  assert.ok(transcript.querySelector('.pending-tip'), '生成中的占位块不能被历史翻页收掉');
  assert.ok(same(state.turn, live), '实时轮指针要原样还原');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
