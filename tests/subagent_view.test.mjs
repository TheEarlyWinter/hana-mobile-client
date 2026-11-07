/* tests/subagent_view.test.mjs — 子代理（分身）卡片
 *
 * 宿主把 subagent 工具的 details 投影成 {type:'subagent'} 的块，两路过来：
 *   历史：/api/sessions/messages 的 blocks 里一条独立 entry（带 afterIndex）
 *   实时：content_block 事件 + block_update 状态补丁
 * web/ 里原来一个字节都没接（搜 subagent 命中 0 处），手机上既不报错也不显示。
 *
 * 这里钉住四件事：
 *   1. 历史 entry 画成卡片，落在「当前助手轮次」的正文里，名字/状态/结果都在；
 *   2. 实时两条事件（开始 → 运行中；结束 → 完成/失败 + 一句话）落在同一张卡上；
 *   3. reset() 之后旧会话的节点不再被写，同一个 taskId 会重新开一张卡；
 *   4. 缺字段、未知形状、没注入句柄时都不崩、不产出空卡片。
 *
 * 接线方式与 app.js 一致：真 chat-renderer + 真 event-router，subagent-view 由
 * 参数注入，没有任何一方 import 另一方。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 夹具先落地：web/*.js 在模块作用域里就会摸 document / window。 */
const h = createHarness({ debug: false });

const { createSubagentView } = await import('../web/subagent-view.js');
const { createChatRenderer } = await import('../web/chat-renderer.js');
const { createEventRouter } = await import('../web/event-router.js');
const { createHistoryPaginationView } = await import('../web/history-pagination-view.js');
const { createStreamState } = await import('../web/stream-state.js');

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
/* 一页最小的聊天：真模块，边界是夹具                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {object} [opts]
 * @param {boolean} [opts.inject] 是否把 subagent-view 注入两个消费方（默认注入）
 * @param {(target: object) => void} [opts.onOpenSession] 卡片点击回调
 */
function boot({ inject = true, onOpenSession = null } = {}) {
  const transcript = h.getEl('transcript');
  transcript.innerHTML = '';   // 每个用例一件干净沙盘

  const state = {
    session: { sessionId: 's-parent', path: 'C:/sessions/parent' },
    agentName: 'Hana',
    userName: '你',
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

  const view = createSubagentView({
    document: h.doc,
    onOpenSession: onOpenSession || (() => {}),
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
    ...(inject ? { renderSubagent: view.render } : {}),
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
    ...(inject ? { handleSubagentEvent: view.handleEvent } : {}),
  });

  return { state, renderer, view, router, transcript, send: (ev) => router.handleEvent(ev) };
}

const cards = (transcript) => transcript.querySelectorAll('.subagent-card');
const onlyCard = (transcript) => {
  const list = cards(transcript);
  assert.equal(list.length, 1, `应当恰好一张分身卡，实际 ${list.length} 张`);
  return list[0];
};
const textOfCard = (card) => h.textOf(card).replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ */
/* 1. 历史回放                                                          */
/* ------------------------------------------------------------------ */

await t('历史：subagent entry 画成一张卡，落在最近一条助手回复里', () => {
  const { renderer, transcript } = boot();

  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '我派了一个分身去查登录链路。' }] },
  });

  const drew = renderer.renderEntry({
    type: 'subagent',
    taskId: 't-1',
    agentName: '寻迹',
    taskTitle: '查登录链路',
    streamStatus: 'done',
    summary: '3 个文件受影响',
    sessionId: 's-child-1',
    streamKey: 'C:/sessions/child-1',
    afterIndex: 1,
  });

  assert.equal(drew, true, '画出来了就要返回 true（历史页靠它统计画了几条）');
  const card = onlyCard(transcript);
  assert.equal(card.dataset.taskId, 't-1');
  assert.equal(card.dataset.status, 'done', '状态要落到 dataset 上，样式靠它上色');
  assert.ok(card.closest('.turn.assistant'), '分身卡必须挂在助手轮次里，不能落在消息区根上');

  const text = textOfCard(card);
  assert.ok(text.includes('寻迹'), `卡片要带分身名字，实际：${text}`);
  assert.ok(text.includes('已完成'), `卡片要带状态，实际：${text}`);
  assert.ok(text.includes('3 个文件受影响'), `完成后要带一句话结果，实际：${text}`);
});

await t('历史：缺 taskId 的块不画卡（也不能把整页历史打断）', () => {
  const { renderer, transcript } = boot();
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] },
  });

  for (const entry of [
    { type: 'subagent' },
    { type: 'subagent', taskId: '' },
    { type: 'subagent', taskId: '   ' },
    { type: 'subagent', taskId: 42 },
    null,
    {},
  ]) {
    assert.doesNotThrow(() => renderer.renderEntry(entry), `形状 ${JSON.stringify(entry)} 不该抛错`);
  }
  assert.equal(cards(transcript).length, 0, '没有 taskId 就没有可画的东西，不能产出空卡片');
});

/* ------------------------------------------------------------------ */
/* 2. 实时：开始 → 运行中，结束 → 完成 / 失败                            */
/* ------------------------------------------------------------------ */

await t('实时：content_block 先画「运行中」占位', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });

  send({
    type: 'content_block',
    block: {
      type: 'subagent',
      taskId: 't-2',
      agentName: 'Luna',
      taskTitle: '审查接口契约',
      streamStatus: 'running',
      sessionId: 's-child-2',
      streamKey: 'C:/sessions/child-2',
    },
  });

  const card = onlyCard(transcript);
  assert.equal(card.dataset.status, 'running');
  const text = textOfCard(card);
  assert.ok(text.includes('Luna'), `要有名字，实际：${text}`);
  assert.ok(text.includes('运行中'), `要有「运行中」，实际：${text}`);
  assert.ok(text.includes('审查接口契约'), `运行中先显示它在做什么，实际：${text}`);
});

await t('实时：block_update(done) 把同一张卡收尾成「已完成」', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });
  send({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't-3', agentName: 'Luna', streamStatus: 'running', streamKey: 'C:/sessions/child-3' },
  });
  const first = onlyCard(transcript);

  send({ type: 'block_update', taskId: 't-3', patch: { streamStatus: 'done', summary: '没问题，2 条小建议' } });

  const after = onlyCard(transcript);
  assert.equal(after, first, '状态更新要落在原来那张卡上，不能另起一张');
  assert.equal(after.dataset.status, 'done');
  const text = textOfCard(after);
  assert.ok(text.includes('已完成'), `要有「已完成」，实际：${text}`);
  assert.ok(text.includes('没问题，2 条小建议'), `要有结果摘要，实际：${text}`);
});

await t('实时：block_update(failed) 出失败态，并带上错误摘要', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });
  send({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't-4', agentName: '寻迹', streamStatus: 'running', streamKey: 'C:/sessions/child-4' },
  });

  send({
    type: 'block_update',
    taskId: 't-4',
    patch: { streamStatus: 'failed', summary: '读不到 gateway/server.mjs: EACCES' },
  });

  const card = onlyCard(transcript);
  assert.equal(card.dataset.status, 'failed');
  const text = textOfCard(card);
  assert.ok(text.includes('失败'), `要有失败态文案，实际：${text}`);
  assert.ok(text.includes('EACCES'), `失败要带错误摘要，实际：${text}`);
});

await t('实时：先完成后开始（事件乱序）不能让卡片倒回「运行中」', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });

  // 前台子代理是阻塞的：finishRun 的 block_update 会先于 tool_end 的 content_block 到达
  send({ type: 'block_update', taskId: 't-5', patch: { streamStatus: 'done', summary: '改好了' } });
  assert.equal(cards(transcript).length, 0, '只有补丁、没有内容块时不该凭空造卡');

  send({
    type: 'content_block',
    block: {
      type: 'subagent',
      taskId: 't-5',
      agentName: 'Gem',
      taskTitle: '改样式',
      streamStatus: 'running',
      streamKey: 'C:/sessions/child-5',
    },
  });

  const card = onlyCard(transcript);
  assert.equal(card.dataset.status, 'done', '后到的 content_block 不能把已完成的卡打回运行中');
  const text = textOfCard(card);
  assert.ok(text.includes('已完成'), `实际：${text}`);
  assert.ok(text.includes('改好了'), `先到的摘要不能丢，实际：${text}`);
});

await t('实时：派发时的 block_update（带 streamKey）先出一张占位卡', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });

  send({
    type: 'block_update',
    taskId: 't-6',
    patch: { streamKey: 'C:/sessions/child-6', sessionId: 's-child-6', agentName: 'DeepSeek' },
  });

  const card = onlyCard(transcript);
  assert.equal(card.dataset.status, 'running');
  const text = textOfCard(card);
  assert.ok(text.includes('DeepSeek'), `要有分身名字，实际：${text}`);
  assert.ok(text.includes('运行中'), `实际：${text}`);

  // workflow 也发 block_update，但不带 streamKey：不能顺手造一张分身卡
  send({ type: 'block_update', taskId: 'wf-1', patch: { streamStatus: 'done', finishedAt: 1 } });
  assert.equal(cards(transcript).length, 1, '不认识的补丁不能凭空造卡');
});

/* ------------------------------------------------------------------ */
/* 3. reset：切会话                                                    */
/* ------------------------------------------------------------------ */

await t('reset 之后不再往旧会话的节点里写', () => {
  const { send, view, transcript } = boot();
  send({ type: 'thinking_start' });
  send({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't-7', agentName: 'Luna', streamStatus: 'running', streamKey: 'C:/sessions/child-7' },
  });

  const card = onlyCard(transcript);
  const statusEl = card.querySelector('.subagent-card-status');
  assert.equal(h.textOf(statusEl).trim(), '运行中');

  view.reset();

  send({ type: 'block_update', taskId: 't-7', patch: { streamStatus: 'done', summary: '旧会话的收尾' } });
  assert.equal(h.textOf(statusEl).trim(), '运行中', 'reset 之后旧节点一个字节都不该被改写');
  assert.equal(cards(transcript).length, 1, '没有卡片引用时补丁只能记着，不能凭空造卡');

  // 同一个 taskId 再来内容块：旧引用已经丢了，应当另起一张卡
  send({
    type: 'content_block',
    block: { type: 'subagent', taskId: 't-7', agentName: 'Luna', streamStatus: 'running', streamKey: 'C:/sessions/child-7' },
  });
  const list = cards(transcript);
  assert.equal(list.length, 2, 'reset 应当清掉自己的节点引用');
  assert.notEqual(list[1], card, '新卡必须是新节点');
  assert.equal(h.textOf(statusEl).trim(), '运行中', '旧卡保持原样');
});

await t('节点被清屏摘掉后（isConnected=false）重画，不往孤儿节点写', () => {
  const { renderer, transcript } = boot();
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '派活中' }] },
  });
  renderer.renderEntry({
    type: 'subagent',
    taskId: 't-7b',
    agentName: 'Luna',
    streamStatus: 'running',
    sessionId: 's-child-7b',
    streamKey: 'C:/sessions/child-7b',
  });

  const orphan = onlyCard(transcript);
  orphan.isConnected = false;   // 真浏览器里 innerHTML='' 之后就是这样

  renderer.renderEntry({ type: 'subagent', taskId: 't-7b', agentName: 'Luna', streamStatus: 'done', summary: '改完了' });

  const list = cards(transcript);
  assert.equal(list.length, 2, '孤儿引用不能挡住重画');
  assert.notEqual(list[1], orphan, '重画的必须是个新节点');
  assert.equal(list[1].dataset.status, 'done');
  assert.equal(h.textOf(orphan.querySelector('.subagent-card-status')).trim(), '运行中', '孤儿节点不再被写');
});

/* ------------------------------------------------------------------ */
/* 4. 脏输入与「没注入」                                                */
/* ------------------------------------------------------------------ */

await t('缺字段/未知形状的事件不崩，也不产出空卡片', () => {
  const { send, view, transcript } = boot();
  send({ type: 'thinking_start' });

  const junk = [
    null,
    undefined,
    {},
    { type: 'block_update' },
    { type: 'block_update', taskId: '' },
    { type: 'block_update', taskId: 'x' },
    { type: 'block_update', taskId: 'x', patch: null },
    { type: 'block_update', taskId: 'x', patch: 'done' },
    { type: 'content_block' },
    { type: 'content_block', block: null },
    { type: 'content_block', block: { type: 'subagent' } },
    { type: 'content_block', block: { type: 'file', label: 'a.txt' } },
    { type: 'weird_event', taskId: 'x' },
  ];
  for (const ev of junk) {
    assert.doesNotThrow(() => send(ev), `事件 ${JSON.stringify(ev)} 不该抛错`);
    assert.doesNotThrow(() => view.handleEvent(ev), `事件 ${JSON.stringify(ev)} 直接喂给 view 也不该抛错`);
  }
  assert.equal(cards(transcript).length, 0, '脏事件不能产出空卡片');

  // 状态是没见过的字符串：卡片要出来，但不能崩
  send({ type: 'content_block', block: { type: 'subagent', taskId: 't-8', agentName: 'Luna', streamStatus: 'weird' } });
  const card = onlyCard(transcript);
  assert.ok(textOfCard(card).includes('Luna'));
  assert.ok(textOfCard(card).length > 0, '卡片不能是空的');
});

await t('没注入时 chat-renderer / event-router 照旧跳过（不崩、不画）', () => {
  const { renderer, send, transcript } = boot({ inject: false });

  assert.doesNotThrow(() => renderer.renderEntry({ type: 'subagent', taskId: 't-9', agentName: 'Luna' }));
  assert.equal(renderer.renderEntry({ type: 'subagent', taskId: 't-9' }), false, '没注入就当没画');
  assert.doesNotThrow(() => send({ type: 'content_block', block: { type: 'subagent', taskId: 't-9' } }));
  assert.doesNotThrow(() => send({ type: 'block_update', taskId: 't-9', patch: { streamStatus: 'done' } }));
  assert.equal(cards(transcript).length, 0);
});

/* ------------------------------------------------------------------ */
/* 5. 点开                                                             */
/* ------------------------------------------------------------------ */

await t('点卡片把子会话身份交给 onOpenSession；没有身份就不回调', () => {
  const opened = [];
  const { renderer, transcript } = boot({ onOpenSession: (target) => opened.push(target) });
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '派活中' }] },
  });

  renderer.renderEntry({
    type: 'subagent',
    taskId: 't-10',
    agentName: 'Luna',
    streamStatus: 'running',
    sessionId: 's-child-10',
    streamKey: 'C:/sessions/child-10',
  });
  const openable = onlyCard(transcript);
  assert.ok(openable.classList.contains('is-openable'), '有子会话身份的卡才显得可点');
  openable.click();
  assert.equal(opened.length, 1, '有身份就该回调');
  assert.equal(opened[0].taskId, 't-10');
  assert.equal(opened[0].sessionId, 's-child-10');
  assert.equal(opened[0].sessionPath, 'C:/sessions/child-10');
  // 详情页要显示的身份信息一并带上，装配方不用再去猜宿主字段名
  assert.equal(opened[0].name, 'Luna', '回调里要带名字');
  assert.equal(opened[0].status, 'running', '回调里要带归一后的状态');

  renderer.renderEntry({ type: 'subagent', taskId: 't-11', agentName: '无身份', streamStatus: 'done' });
  const plain = cards(transcript).find((c) => c.dataset.taskId === 't-11');
  assert.ok(plain, '没有子会话身份也要照样画卡');
  assert.ok(!plain.classList.contains('is-openable'), '没有身份就不该显得可点');
  plain.click();
  assert.equal(opened.length, 1, '没有身份时点了不能有回调');
});

/* ------------------------------------------------------------------ */
/* 6. 身份行：label 是「这次派活的短标签」                              */
/* ------------------------------------------------------------------ */

await t('身份行：主标题是执行者 name，副标题是「label · model」', () => {
  const { renderer, transcript } = boot();
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '我派了个分身。' }] },
  });
  renderer.renderEntry({
    type: 'subagent',
    taskId: 'id-1',
    agentName: 'Luna',
    label: '审3：theme 模块',
    model: 'deepseek-v4',
    streamStatus: 'running',
    taskTitle: '审 theme 模块',
  });

  const card = onlyCard(transcript);
  const nameText = h.textOf(card.querySelector('.subagent-card-name')).trim();
  const subEl = card.querySelector('.subagent-card-sub');
  assert.ok(subEl, '卡片要有身份副标题节点');
  assert.equal(nameText, 'Luna', '主标题只放执行者名字');
  assert.ok(!nameText.includes('审3'), `label 不该再拼进主标题，实际：${nameText}`);
  assert.equal(h.textOf(subEl).trim(), '审3：theme 模块 · deepseek-v4', '副标题是 label · model');
  assert.equal(subEl.hidden, false);
});

await t('身份行：label 与名字相同或为空时不重复；没 label 只剩 model', () => {
  const { renderer, transcript } = boot();
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] },
  });
  const subOf = (taskId) => h.textOf(
    cards(transcript).find((c) => c.dataset.taskId === taskId).querySelector('.subagent-card-sub')
  ).trim();

  // label 与执行者同名：贴两遍只是噪音
  renderer.renderEntry({ type: 'subagent', taskId: 'id-2', agentName: 'Luna', label: 'Luna', model: 'deepseek-v4', streamStatus: 'running' });
  assert.equal(subOf('id-2'), 'deepseek-v4', '同名不重复显示 label');

  // 没有 label，但有 model：副标题只剩 model
  renderer.renderEntry({ type: 'subagent', taskId: 'id-3', agentName: 'Luna', model: 'deepseek-v4', streamStatus: 'running' });
  assert.equal(subOf('id-3'), 'deepseek-v4');

  // executorModel 也认（与卡片入口同一个字段名）
  renderer.renderEntry({ type: 'subagent', taskId: 'id-4', agentName: 'Luna', executorModel: 'deepseek-v4-pro', streamStatus: 'running' });
  assert.equal(subOf('id-4'), 'deepseek-v4-pro');

  // 两样都没有：不占行
  renderer.renderEntry({ type: 'subagent', taskId: 'id-5', agentName: 'Luna', streamStatus: 'running' });
  assert.equal(subOf('id-5'), '', '空副标题不能留一行空白');
  const sub5 = cards(transcript).find((c) => c.dataset.taskId === 'id-5').querySelector('.subagent-card-sub');
  assert.equal(sub5.hidden, true);
});

await t('身份行随补丁原地更新（label / model 后到也不重建卡片）', () => {
  const { send, transcript } = boot();
  send({ type: 'thinking_start' });
  send({
    type: 'content_block',
    block: { type: 'subagent', taskId: 'id-6', agentName: 'Luna', streamStatus: 'running', streamKey: 'C:/sessions/child-6' },
  });
  const card = onlyCard(transcript);
  const subEl = card.querySelector('.subagent-card-sub');
  assert.equal(subEl.hidden, true, '出生时没有 label / model，不占行');

  send({ type: 'block_update', taskId: 'id-6', patch: { label: '审3：theme 模块', model: 'deepseek-v4' } });
  assert.equal(onlyCard(transcript), card, '补丁只能改原来的卡');
  assert.equal(h.textOf(subEl).trim(), '审3：theme 模块 · deepseek-v4');
  assert.equal(subEl.hidden, false);
});

await t('点卡片：载荷带 label / model，与胶囊入口同一套字段名', () => {
  const opened = [];
  const { renderer, transcript } = boot({ onOpenSession: (target) => opened.push(target) });
  renderer.renderEntry({
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '派活中' }] },
  });
  renderer.renderEntry({
    type: 'subagent',
    taskId: 'id-7',
    agentName: 'Luna',
    label: '审3：theme 模块',
    model: 'deepseek-v4',
    streamStatus: 'running',
    sessionId: 's-child-7',
    streamKey: 'C:/sessions/child-7',
  });
  onlyCard(transcript).click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'Luna', '主标题用的名字');
  assert.equal(opened[0].label, '审3：theme 模块', 'label 原样透传给详情页');
  assert.equal(opened[0].model, 'deepseek-v4');
});

/* ------------------------------------------------------------------ */

if (bad > 0) {
  console.error(`\n${bad} subagent-view test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
