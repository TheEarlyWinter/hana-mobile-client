/* tests/pending_state.test.mjs — E4「已送达感」：点发送到模型出字之间不能像没发出去
 *
 * 缺陷背景：用户气泡是乐观画的（发出即出现），但助手侧在第一条 delta 到达之前
 * 界面上什么都没有。网络慢的时候那几秒完全像「没发出去」。
 *
 * 本文件锁住渲染器新增的占位块（chat-renderer.showPending / clearPending）与
 * event-router 的接线，全部用真模块 + 假 DOM：
 *   1. 用户消息事件之后出现唯一占位块，位置在列表末尾、用户气泡之后；
 *   2. 自己发的消息（回显被 sentInputs 吞掉）同样要出占位块——那才是最关键的一刻；
 *   3. 第一条 assistant 正文 / 思考 / 工具事件都要把占位块收掉，正文照常渲染；
 *   4. showPending 幂等：连着调两次只有一个块；
 *   5. 一轮结束、出错、切换会话、清屏重绘之后都不许残留孤儿占位块；
 *   6. 30 秒没回应自动消失（假时钟），且不冒充成功、不弹提示；
 *   7. 用户正在往上翻旧消息时，占位块出现不改变 scrollTop；
 *   8. 断线回放（stream_resume）里的历史用户消息不产生占位块。
 *
 * 夹具用法与 tests/mood_event.test.mjs 一致：先落 DOM，再 import 真模块。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 夹具必须在真模块 import 之前落地：web/*.js 在模块作用域里就会摸 document / window。 */
const h = createHarness();
const { createChatRenderer } = await import('../web/chat-renderer.js');
const { createEventRouter } = await import('../web/event-router.js');
const { createHistoryPaginationView } = await import('../web/history-pagination-view.js');
const { createStreamState } = await import('../web/stream-state.js');

const failures = [];
function test(name, run) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

const SESSION = { sessionId: 's-pending', path: 'C:/sessions/pending' };

/** 假时钟：只记账，不真的等 30 秒。 */
function createFakeTimers() {
  const list = [];
  return {
    list,
    setTimer(fn, ms) {
      const entry = { fn, ms, cleared: false };
      list.push(entry);
      return entry;
    },
    clearTimer(entry) {
      if (entry) entry.cleared = true;
    },
    live() {
      return list.filter((entry) => !entry.cleared);
    },
    fire(entry) {
      entry.fn();
    },
  };
}

/**
 * 一件干净的沙盘：真的 chat-renderer + 真的 event-router + 真的历史分页视图，
 * 和 app.js 的接线方式一致，只换掉 DOM 与几个边界。
 */
function bootChat({ timers = createFakeTimers() } = {}) {
  const transcript = h.getEl('transcript');
  transcript.replaceChildren();
  transcript.scrollTop = 0;
  transcript.scrollHeight = 600;
  transcript.clientHeight = 600;

  const state = {
    session: { ...SESSION, agentName: 'Hana' },
    agentName: 'Hana',
    userName: '你',
    // 流式状态（app.js 里 S 的同名子集）
    turn: null,
    turnBody: null,
    turnFootEl: null,
    turnMeta: null,
    textEl: null,
    streamingRaw: '',
    thinkAt: 0,
    replaying: false,
    moodEl: null,
    moodRaw: '',
    busy: false,
    turnStart: 0,
    firstTokenMs: 0,
    charCount: 0,
    speed: 0,
    // 事件分发用到的两个去重游标
    sentInputs: new Set(),
    lastLocalUser: null,
  };

  const historyView = createHistoryPaginationView({
    document: h.doc,
    container: transcript,
    onLoadOlder: () => {},
  });

  const rendererOptions = {
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => historyView,
    cardController: { render: () => h.makeNode('div') },
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    paintAvatar: () => {},
    agentAvatarUrlById: () => '',
    userAvatarUrl: () => '',
    flash: () => {},
    onBusyChange: () => {},
  };
  if (timers) {
    rendererOptions.setTimer = timers.setTimer;
    rendererOptions.clearTimer = timers.clearTimer;
  }
  const renderer = createChatRenderer(rendererOptions);

  const router = createEventRouter({
    state,
    getElement: (id) => h.getEl(id),
    renderer,
    sockets: { requestContextUsage() {} },
    cardBridge: null,
    streamState: createStreamState(),
    flash: () => {},
    setBusy: () => {},
    loadSessions: async () => {},
    loadHistory: async () => {},
    chatSubtitle: () => '',
    debug: false,
  });

  return { state, renderer, router, transcript, historyView, send: (ev) => router.handleEvent(ev) };
}

/** 消息区里现在有几个占位块。 */
const pendings = (transcript) => transcript.querySelectorAll('.pending-tip');
const onlyPending = (transcript) => {
  const list = pendings(transcript);
  assert.equal(list.length, 1, `应只有一个占位块，实际 ${list.length} 个`);
  return list[0];
};

test('默认沙盘不登记真实的 30 秒防呆计时器', () => {
  const originalSetTimeout = globalThis.setTimeout;
  let realPendingTimers = 0;
  globalThis.setTimeout = function (fn, ms, ...args) {
    if (ms === 30000) {
      realPendingTimers += 1;
      return { unref() {} };
    }
    return originalSetTimeout.call(this, fn, ms, ...args);
  };

  try {
    const { send } = bootChat();
    send({ type: 'session_user_message', message: { text: '用可控时间' } });
    assert.equal(realPendingTimers, 0, '测试沙盘必须注入假时钟');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

/* ------------------------------------------------------------------ */
/* 1. 用户消息之后立刻出现占位块                                        */
/* ------------------------------------------------------------------ */

test('用户消息事件之后，列表末尾出现唯一占位块（三颗跳动的点 + 正在思考）', () => {
  const { transcript, send } = bootChat();

  send({ type: 'session_user_message', message: { text: '在吗' } });

  const tip = onlyPending(transcript);
  assert.equal(transcript.lastChild, tip, '占位块要落在消息列表末尾');
  assert.deepEqual(pendings(transcript).length, 1, '同一时刻只能有一个占位块');

  const dots = tip.querySelectorAll('.pending-dot');
  assert.equal(dots.length, 3, `占位块要有三个点，实际 ${dots.length} 个`);
  assert.equal(h.textOf(tip.querySelector('.pending-text')).trim(), '正在思考');

  // 骨架与真实助手消息一致：头像 + 名字 + 正文列，第一个 delta 到达时同位置换内容
  assert.ok(tip.classList.contains('turn') && tip.classList.contains('assistant'), '复用 .turn.assistant 骨架');
  assert.ok(tip.querySelector('.avatar'), '要有助手头像的位置');
  assert.equal(h.textOf(tip.querySelector('.turn-name')).trim(), 'Hana');

  const userTurn = transcript.querySelector('.turn.user');
  assert.ok(userTurn, '用户消息照常渲染');
  assert.equal(tip.previousElementSibling, userTurn, '占位块在用户气泡之后');
});

test('自己发的消息（回显被 sentInputs 吞掉）同样要出占位块', () => {
  const { state, transcript, send } = bootChat();
  state.sentInputs.add('in-7');

  send({ type: 'session_user_message', inputId: 'in-7', message: { text: '发出去的那条' } });

  // 去重与「不重复画气泡」的旧行为一个字都没变
  assert.equal(state.sentInputs.size, 0, '回显仍要被 sentInputs 吃掉');
  assert.equal(transcript.querySelectorAll('.turn.user').length, 0, '自己的消息不再画第二个气泡');
  onlyPending(transcript);
});

/* ------------------------------------------------------------------ */
/* 2. 有回应就收占位块                                                  */
/* ------------------------------------------------------------------ */

test('第一个 assistant delta 到达：占位块消失，正文正常渲染', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '讲个笑话' } });
  onlyPending(transcript);

  send({ type: 'assistant_delta', delta: '从前有座山' });

  assert.equal(pendings(transcript).length, 0, 'delta 到了占位块就该收');
  const text = transcript.querySelector('.turn-assistant-text');
  assert.ok(text, '正文节点要在');
  assert.ok(h.textOf(text).includes('从前有座山'), `正文内容不对：${h.textOf(text)}`);
});

test('思考事件也算「有回应」：占位块收起，思考折叠条出现', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '想一下' } });
  onlyPending(transcript);

  send({ type: 'thinking_delta', delta: '先看看上下文' });

  assert.equal(pendings(transcript).length, 0);
  const meta = transcript.querySelector('.turn-meta');
  assert.ok(meta, '思考要落到本轮的折叠条里');
  assert.ok(h.textOf(meta.querySelector('.meta-think')).includes('先看看上下文'));
});

test('工具事件也算「有回应」：占位块收起，工具行进本轮', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '查一下' } });
  onlyPending(transcript);

  send({ type: 'tool_start', toolName: 'read', toolCallId: 'c1' });

  assert.equal(pendings(transcript).length, 0);
  assert.equal(transcript.querySelectorAll('.meta-tool').length, 1);
});

test('thinking_start（还没吐字）同样收起占位块', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '想想' } });
  send({ type: 'thinking_start' });
  assert.equal(pendings(transcript).length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. 幂等                                                              */
/* ------------------------------------------------------------------ */

test('连续两次 showPending 只有一个块，加一次防呆计时器', () => {
  const timers = createFakeTimers();
  const { renderer, transcript } = bootChat({ timers });

  const first = renderer.showPending();
  const second = renderer.showPending();

  assert.equal(pendings(transcript).length, 1, '幂等：只有一块');
  assert.equal(first, second, '第二次要复用同一个节点');
  assert.equal(timers.live().length, 1, '重复调用只保留一个计时器');
});

test('两条连续的用户消息事件也只留一个占位块', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '第一条' } });
  send({ type: 'session_user_message', message: { text: '第二条' } });
  assert.equal(pendings(transcript).length, 1);
});

/* ------------------------------------------------------------------ */
/* 4. 绝不留孤儿                                                        */
/* ------------------------------------------------------------------ */

test('一轮结束（stream_turn_end）不残留占位块', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '问一句' } });
  onlyPending(transcript);

  send({ type: 'stream_turn_end' });
  assert.equal(pendings(transcript).length, 0);
});

test('出错事件不残留占位块（错误条照旧由原来的分支画）', () => {
  const { transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '问一句' } });
  onlyPending(transcript);

  send({ type: 'error', message: '上游超时' });
  assert.equal(pendings(transcript).length, 0);
  assert.ok(transcript.querySelector('.msg-system.error'), '错误提示仍然照旧');
});

test('切换会话（resetTurnState + 清屏）后不残留，且新会话能重新挂上', () => {
  const { state, renderer, transcript, send } = bootChat();
  send({ type: 'session_user_message', message: { text: '旧会话里的问题' } });
  onlyPending(transcript);

  // conversation-controller.openSession 的两个固定动作
  renderer.resetTurnState();
  transcript.innerHTML = ''; // replaceTranscriptHistory
  assert.equal(pendings(transcript).length, 0, '切会话后不能把上一个会话的占位块带过来');

  state.session = { sessionId: 's-next', path: 'C:/sessions/next', agentName: 'Hana' };
  send({ type: 'session_user_message', message: { text: '新会话里的问题' } });
  assert.equal(pendings(transcript).length, 1, '清屏后要能重新挂上，而不是被悬空引用挡住');
});

test('innerHTML=\'\' 清屏后不悬空：再次 showPending 只多一块', () => {
  const { renderer, transcript } = bootChat();
  renderer.showPending();
  transcript.innerHTML = '';

  renderer.showPending();
  assert.equal(pendings(transcript).length, 1);
  assert.equal(transcript.children.length, 1, '旧的悬空节点不能再回到 DOM 里');
});

/* ------------------------------------------------------------------ */
/* 5. 30 秒防呆                                                         */
/* ------------------------------------------------------------------ */

test('30 秒没有任何回应：占位块自动消失，不冒充成功也不弹提示', () => {
  const timers = createFakeTimers();
  const { transcript, send } = bootChat({ timers });

  send({ type: 'session_user_message', message: { text: '断网了' } });
  onlyPending(transcript);

  const live = timers.live();
  assert.equal(live.length, 1, '要有且只有一个防呆计时器');
  assert.equal(live[0].ms, 30000, `防呆时长应为 30 秒，实际 ${live[0].ms}`);

  timers.fire(live[0]);

  assert.equal(pendings(transcript).length, 0, '超时后占位块消失');
  assert.equal(transcript.querySelectorAll('.msg-system').length, 0, '不冒充成功、也不弹错误（错误提示归 E5）');
});

test('占位块被清掉时防呆计时器一起取消，旧计时器误触发也不误删新块', () => {
  const timers = createFakeTimers();
  const { renderer, transcript, send } = bootChat({ timers });

  send({ type: 'session_user_message', message: { text: '有回应' } });
  assert.equal(timers.live().length, 1);
  send({ type: 'assistant_delta', delta: '在。' });
  assert.equal(timers.live().length, 0, '清了占位块就不该再挂着计时器');

  // 已经取消的计时器即便被误触发，也不能把后面的新占位块删掉
  const stale = timers.list[0];
  renderer.showPending();
  onlyPending(transcript);
  stale.fn();
  onlyPending(transcript);
});

/* ------------------------------------------------------------------ */
/* 6. 滚动                                                              */
/* ------------------------------------------------------------------ */

test('用户正在翻旧消息时，占位块出现不改变 scrollTop；贴底时立刻可见', () => {
  const { renderer, transcript } = bootChat();
  transcript.scrollHeight = 3000;
  transcript.clientHeight = 600;

  transcript.scrollTop = 400; // 距底部 2000px：正在看历史
  renderer.showPending();
  onlyPending(transcript);
  assert.equal(transcript.scrollTop, 400, '不能把正在翻旧消息的用户拽到底部');

  transcript.scrollTop = 2400; // 贴底
  renderer.showPending(); // 幂等路径也要按当时的贴底判定
  assert.equal(transcript.scrollTop, 3000, '贴底时占位块要立刻可见');
});

/* ------------------------------------------------------------------ */
/* 7. 断线回放                                                          */
/* ------------------------------------------------------------------ */

test('stream_resume 回放里的历史用户消息不产生占位块', () => {
  const { transcript, send } = bootChat();

  send({
    type: 'stream_resume',
    streamId: 'st-1',
    sessionId: SESSION.sessionId,
    sessionPath: SESSION.path,
    events: [
      { seq: 1, event: { type: 'session_user_message', message: { text: '断线前的消息' } } },
      { seq: 2, event: { type: 'assistant_delta', delta: '断线前已经写出来的正文' } },
    ],
  });

  assert.equal(pendings(transcript).length, 0, '回放是历史，不是「刚发出去」');
  assert.ok(h.textOf(transcript).includes('断线前已经写出来的正文'));
});

/* ------------------------------------------------------------------ */
/* 8. 占位块不吃正文区的旁路内容                                        */
/* ------------------------------------------------------------------ */

test('占位块在场上时，文件卡不会落进占位块里被一起摘掉', () => {
  const { renderer, transcript } = bootChat();
  renderer.startAssistantTurn();
  renderer.addAssistantText('上一轮的正文');
  renderer.finishTurn();

  renderer.showPending();
  const tip = onlyPending(transcript);

  renderer.appendFileCards([{ fileId: 'f-1', label: '笔记.md', ext: 'md' }]);

  // 假 DOM 的 querySelector 只认最后一段选择器，这里按节点自己筛，别靠后代选择器
  const realTurns = Array.from(transcript.querySelectorAll('.turn.assistant'))
    .filter((node) => !node.classList.contains('pending-tip'));
  assert.equal(realTurns.length, 1, '上一轮正文还在');
  assert.equal(tip.querySelectorAll('.file-card').length, 0, '文件卡不能落进占位块里');
  assert.equal(realTurns[0].querySelectorAll('.file-card').length, 1, '文件卡要落在上一条助手正文末尾');
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\n${failures.length} pending-state test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
