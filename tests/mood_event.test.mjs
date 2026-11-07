/* mood 流式事件的跨模块契约（回归：Uncaught TypeError: renderer.ensureMoodEl is not a function）
 *
 * 背景：web/app.js 拆成多模块时，event-router 里新增了 mood_start 分支，但
 * chat-renderer 的导出清单没跟着同步。单模块测试各自是绿的——它们要么只测自己的
 * 内部函数，要么给 event-router 塞一个「假 renderer」；假 renderer 天然带
 * ensureMoodEl，正好把这条漏掉的导出掩盖掉。真机上表现为：打开一个已有对话、
 * 发一条消息，页面底部弹出未捕获异常，mood 那一整条链路是死的。
 *
 * 所以这里**不造假 renderer**：真的 chat-renderer + 真的 event-router，只把
 * DOM（tests/support/app_harness.mjs）、socket、卡片控制器这些边界换成夹具，
 * 和 app.js 里接线的方式保持一致。
 *
 * 钉住三件事：
 * 1. mood_start / mood_text / mood_end 走完整条分派链路不抛错，容器落在本轮正文里；
 * 2. 增量拼接与游标（state.moodEl / moodRaw）的语义：结束清游标，但已画的字留下；
 * 3. 静态网：event-router / app.js 等消费方对 renderer 的每次调用，都必须在导出
 *    清单里——这正是当初漏掉的那一类漏洞。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/* ------------------------------------------------------------------ */
/* 一页最小的聊天：真的模块，边界是夹具                                  */
/* ------------------------------------------------------------------ */

function bootChat() {
  // 每个用例一件干净的沙盘：同一个夹具里复用 #transcript，只清孩子。
  const transcript = h.getEl('transcript');
  transcript.children.length = 0;

  const state = {
    session: { sessionId: 's-mood', path: 'C:/sessions/mood' },
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
  };

  const historyView = createHistoryPaginationView({
    document: h.doc,
    container: transcript,
    onLoadOlder: () => {},
  });

  const renderer = createChatRenderer({
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
  });

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

  return { state, renderer, router, transcript, send: (ev) => router.handleEvent(ev) };
}

/* ------------------------------------------------------------------ */
/* 1. 主回归：真机那条链                                                */
/* ------------------------------------------------------------------ */

test('mood_start 通过 event-router 分派到 renderer：不抛错，嘀咕条落在本轮正文里', () => {
  const { state, send } = bootChat();

  // 真实顺序：助手这一轮先开（thinking_start），mood 才在这一轮里展开
  send({ type: 'thinking_start' });
  assert.ok(state.turn, 'thinking_start 应该开出这一轮');
  const body = state.turnBody;
  assert.equal(body.querySelector('.mood-strip'), null, 'mood_start 之前不该有嘀咕条');

  // 真机崩在这一行：renderer.ensureMoodEl is not a function
  send({ type: 'mood_start' });

  const strip = body.querySelector('.mood-strip');
  assert.ok(strip, 'mood_start 应该在本轮正文里建出嘀咕条');
  assert.equal(strip.tagName, 'DETAILS', '默认是折叠的 details，不抢正文空间');
  assert.equal(h.textOf(strip.querySelector('summary')).trim(), '心里的嘀咕');
  assert.ok(strip.querySelector('.mood-body'), '要留出写字的容器');
  assert.equal(state.moodEl, strip, '渲染器的游标必须指向这条新容器');
});

/* ------------------------------------------------------------------ */
/* 2. 增量与收尾                                                        */
/* ------------------------------------------------------------------ */

test('mood_text 增量拼接，mood_end 清游标但保留已画的字', () => {
  const { state, send } = bootChat();
  send({ type: 'thinking_start' });
  send({ type: 'mood_start' });
  send({ type: 'mood_text', delta: '心里有点' });
  send({ type: 'mood_text', delta: '发涩，但还好' });

  const box = state.turnBody.querySelector('.mood-body');
  assert.equal(h.textOf(box), '心里有点发涩，但还好', '两次增量要拼在同一处');
  assert.equal(state.moodRaw, '心里有点发涩，但还好');

  send({ type: 'mood_end' });
  assert.equal(state.moodEl, null, '游标要清：下一轮的 mood 不能写进这一轮');
  assert.equal(state.moodRaw, '');
  assert.equal(h.textOf(box), '心里有点发涩，但还好', '已经画出来的字不能因为 mood_end 消失');
});

test('下一轮的 mood 落在下一轮正文里，不串到上一轮', () => {
  const { state, send } = bootChat();
  send({ type: 'thinking_start' });
  send({ type: 'mood_start' });
  send({ type: 'mood_text', delta: '第一轮' });
  const firstBody = state.turnBody;

  // 分段结束不收尾：stream_turn_end 只冻结本段，整轮结束信号是 status{isStreaming:false}。
  // 断言用 ok(...) 而不是 equal(...)：失败时 Node 会对两个 DOM 节点做差异比对，
  // 那一步能把进程挂死（实测 cpu 跑满、几分钟不退），这也是这个文件“卡住”的真因。
  send({ type: 'stream_turn_end' });
  assert.ok(state.turn, 'stream_turn_end 只是分段，本轮不应收尾');
  send({ type: 'status', isStreaming: false });
  assert.ok(state.turn === null, '整轮结束后本轮游标要清');

  send({ type: 'thinking_start' });
  const secondBody = state.turnBody;
  assert.notEqual(secondBody, firstBody, '新一轮要有自己的正文容器');
  send({ type: 'mood_start' });
  send({ type: 'mood_text', delta: '第二轮' });

  assert.equal(h.textOf(firstBody.querySelector('.mood-body')), '第一轮');
  assert.equal(h.textOf(secondBody.querySelector('.mood-body')), '第二轮');
});

/* ------------------------------------------------------------------ */
/* 3. 同类漏洞的静态网                                                  */
/* ------------------------------------------------------------------ */

test('消费方对 renderer 的每次调用都在 chat-renderer 的导出清单里', () => {
  const { renderer } = bootChat();
  const api = new Set(Object.keys(renderer));
  const consumers = [
    'event-router.js',
    'app.js',
    'composer-controller.js',
    'conversation-controller.js',
    'mobile-lifecycle.js',
  ];

  const missing = [];
  for (const file of consumers) {
    const source = readFileSync(fileURLToPath(new URL(`../web/${file}`, import.meta.url)), 'utf8');
    // 只认「调用」：renderer.xxx( / renderer.xxx?.( 。
    // 这样 import 路径里的 './chat-renderer.js'（拆模块时它被误扫成 renderer.js）不会误命中。
    for (const m of source.matchAll(/\brenderer\.([A-Za-z_$][\w$]*)\s*(?:\?\.)?\(/g)) {
      if (!api.has(m[1])) missing.push(`${file}: renderer.${m[1]}()`);
    }
  }

  assert.deepEqual(missing, [], `调用了 chat-renderer 没导出的成员：\n${missing.join('\n')}`);
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.error(`\n${failures.length} mood-event test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
