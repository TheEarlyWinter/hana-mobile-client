/* 前台恢复：手机回到前台后，当前会话要追上宿主运行态和完整回复
 *
 * 用户序列（主控已实跑复现）：
 *   电脑上回复完成 → 手机切回来只收到 focus（Android 的 visibilityState 恒为 visible）
 *   → 页面既不重连、也不重报前台/续流 → 本地 busy 永远为真 → 历史补拉被 busy 门禁挡住
 *   → 屏幕上只剩半截回复，必须退出重进才看得到完整内容。
 *
 * 本文件锁的是真实接线，不是源码文本：
 *   - 真的 web/app.js（createHarness 提供假 DOM / 假 WebSocket / 路由化 fetch）；
 *   - focus / visibilitychange 是真实窗口事件；
 *   - busy 由真实的 status / text_delta 事件推出来，不直接改 S.busy；
 *   - 历史补拉看的是 /api/sessions/messages 的实际 GET 次数与 transcript 的可见文本。
 *
 * 覆盖：
 *   1. focus-only 与 stale-ready（wsReady 陈旧、底层 socket 已死）都要真重连；
 *      同一窗口内重复 focus/visible 去重为一条连接；重连后重报 attention/resume。
 *   2. stream_resume 空 events + runtimeIsStreaming:false：收掉 busy 与本轮，补完整历史。
 *   3. 等待首字（busy 但没有 state.turn）时收到 status:false：清 busy、清占位、补历史。
 *   4. 快照 isStreaming:false 但 runtimeIsStreaming:true：不收尾、不清 busy、不替换正文。
 *   5. runtimeIsStreaming 缺失或非布尔：不推断 idle。
 *   6. 别的会话的 stream_resume：先按会话过滤，外层 false 也不能收本会话。
 *   7. 重复 idle 帧由 400ms 防抖合并成一次历史 GET。
 *   8. 隐藏 / 失焦 / 切会话 / 登出都会取消待执行恢复；隐藏仍取消确认框。
 *   9. 恢复与补拉都不重发用户 prompt。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
// notifications 的 isForeground 会读 document.hasFocus()；夹具里补一个真实实现。
h.doc.hasFocus = () => true;

const SESSION_ID = 'fg-resume-main';
const SESSION_PATH = 'C:/offline-fixtures/fg-resume-main.jsonl';
const SESSION = {
  path: SESSION_PATH,
  sessionId: SESSION_ID,
  title: '前台恢复',
  agentId: 'agent-fg-resume',
};
const OTHER_SESSION = {
  path: 'C:/offline-fixtures/fg-resume-other.jsonl',
  sessionId: 'fg-resume-other',
  title: '另一个会话',
  agentId: 'agent-fg-resume',
};

const requests = { history: [] };

function userMessage(id, text) {
  return {
    id: String(id),
    role: 'user',
    content: text,
    timestamp: '2026-11-05T12:00:00.000Z',
  };
}

function assistantMessage(id, text) {
  return {
    id: String(id),
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: '2026-11-05T12:01:00.000Z',
  };
}

function historyWith(marker) {
  return {
    messages: [userMessage(1, 'FG_USER_PROMPT'), assistantMessage(2, marker)],
    blocks: [],
    hasMore: false,
  };
}

let historyFixture = {
  messages: [userMessage(1, 'FG_USER_PROMPT')],
  blocks: [],
  hasMore: false,
};

h.setFetch(async (url, init = {}) => {
  const parsed = new URL(String(url), h.window.location.origin);
  if (parsed.pathname === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'offline-user' } });
  }
  if (parsed.pathname === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: SESSION.agentId, name: 'Offline Fixture Agent', isPrimary: true }],
      userName: 'offline-fixture',
      homeFolder: 'C:/offline-fixtures',
    });
  }
  if (parsed.pathname === '/api/sessions/messages') {
    requests.history.push({
      method: init.method || 'GET',
      sessionId: parsed.searchParams.get('sessionId'),
      path: parsed.searchParams.get('path'),
      limit: parsed.searchParams.get('limit'),
      before: parsed.searchParams.get('before'),
    });
    return h.jsonRes(historyFixture);
  }
  if (parsed.pathname === '/api/sessions') return h.jsonRes([]);
  throw new Error(`unexpected offline fetch: ${parsed.pathname}`);
});

const transcriptText = () => h.textOf(h.getEl('transcript'));
const socketCount = () => h.ws.instances.length;
const lastSocket = () => h.ws.instances.at(-1);
const historyCount = () => requests.history.length;
const promptFrameCount = () => h.ws.instances
  .reduce((sum, socket) => sum + socket.frames('prompt').length, 0);

/**
 * 通知判定是真实 notifications 模块经 console.info 打出来的。这里只旁听，
 * 不替换模块、不伪造完成：用来断言「本轮结束时没有再走一次结束通知」。
 */
const notifyLog = [];
const originalConsoleInfo = console.info;
console.info = (...args) => {
  const first = String(args[0] || '');
  if (first.startsWith('[notify] 回合结束')) {
    notifyLog.push(args.map(String).join(' '));
    return;
  }
  originalConsoleInfo(...args);
};

/** 等到确实新建了一条连接；超时说明「根本没重连」。 */
async function waitForNewSocket(before, label) {
  await h.waitFor(() => socketCount() === before + 1, label, 2500);
  return lastSocket();
}

function pushStatus(socket, isStreaming, streamId) {
  socket.push({
    type: 'status',
    isStreaming,
    sessionId: SESSION_ID,
    sessionPath: SESSION_PATH,
    ...(streamId ? { streamId } : {}),
  });
}

async function startLiveTurn(socket, { streamId, text }) {
  pushStatus(socket, true, streamId);
  socket.push({
    type: 'text_delta',
    delta: text,
    sessionId: SESSION_ID,
    sessionPath: SESSION_PATH,
    streamId,
  });
  await h.settle(5);
  assert.equal(hana.S.busy, true, '夹具：真实 status/text_delta 应进入生成态');
  assert.ok(R.turn, '夹具：真实 text_delta 应开出一轮');
}

/**
 * 把主会话重新变成「已连接、idle」的干净起点。
 * 前面的用例可能停在别的会话（切会话）或已经登出（登出在后，但允许单独选跑）。
 */
async function ensureMainSessionReady() {
  const S = hana.S;
  if (S.session?.sessionId !== SESSION_ID) {
    const before = socketCount();
    await hana.openSession(SESSION);
    await h.waitFor(() => socketCount() === before + 1, '回到主会话应建立新连接', 2000);
    lastSocket().open();
    await h.waitFor(() => S.wsReady, '主会话连接就绪', 2000);
    await h.settle(4);
  } else if (!S.wsReady) {
    lastSocket().open();
    await h.waitFor(() => S.wsReady, '主会话连接就绪', 2000);
    await h.settle(4);
  }
  // 会话切换/重连可能排了空闲补拉：等它落地，再让调用方记基线。
  await h.delay(450);
  await h.settle(6);
}

let bad = 0;
let caseIndex = 0;
// 诊断安全：对象身份/空值断言一律用布尔 assert.ok，
// 避免断言失败时 Node 对整棵假 DOM / WS 对象做差异格式化（实次会卡死进程）。
const ONLY = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--only='));
  if (!arg) return null;
  return new Set(arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
})();

async function t(name, fn) {
  caseIndex += 1;
  if (ONLY && !ONLY.has(String(caseIndex))) {
    console.log(`SKIP  ${name}`);
    return;
  }
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

let hana = null;
let R = null;
try {
  hana = await h.loadApp();
  /* 渲染进度袋：D2 起测试直接读它，S 上不再转发这些字段。 */
  R = hana.rendererState;
  const S = hana.S;
  await h.waitFor(() => S.currentAgent, 'boot 完成');

  await hana.openSession(SESSION);
  await h.waitFor(() => socketCount() === 1, '打开会话应建立一条 WebSocket');
  lastSocket().open();
  await h.waitFor(() => S.wsReady, '初始连接就绪');
  assert.equal(historyCount(), 1, '夹具：打开会话应拉一次历史');
  console.log('INFO actualApp=web/app.js harness=tests/support/app_harness.mjs network=fetch-mock');

  /* ------------------------------------------------------------------ */
  /* 1. focus-only + stale-ready：真的重建连接，重复事件去重              */
  /* ------------------------------------------------------------------ */

  await t('focus-only 与 stale-ready 都真的重建连接；重复 focus/visible 只建一条', async () => {
    // Android 回到前台时 visibilityState 仍是 visible，只有 focus。
    h.doc.visibilityState = 'visible';
    const live = lastSocket();
    const before = socketCount();

    h.fireWindow('focus');
    h.fireDocument('visibilitychange');   // visible
    h.fireWindow('focus');                // 同一合并窗口内重复

    const first = await waitForNewSocket(before, 'focus 应真正新建一条 WS（不能只信 wsReady）');
    assert.ok(S.ws === first, '当前连接必须换成新建的这条');
    assert.equal(S.wsReady, false, '新连接未 open 前不能沿用旧的就绪态');
    assert.ok(live.closeCalls >= 1, '旧连接必须被替换关闭');

    await h.delay(180);
    assert.equal(socketCount(), before + 1, '100ms 合并窗口内重复 focus/visible 只能建一条连接');

    first.open();
    await h.waitFor(() => S.wsReady, '重连后的 WS 就绪');
    assert.equal(first.frames('client_attention').length, 1, '重连后要重报前台一次');
    assert.equal(first.frames('resume_stream').length, 1, '重连后要续流一次');
    assert.equal(first.frames('context_usage').length, 1, '连接 open 的既有上下文用量请求不能丢');

    // stale-ready：底层 socket 已经关闭，页面还留着 wsReady=true（WebView 被挂起后的真实形态）。
    first.readyState = h.MockWebSocket.CLOSED;
    assert.equal(S.wsReady, true, '夹具：页面仍以为连接可用');
    const beforeStale = socketCount();
    h.fireWindow('focus');
    const second = await waitForNewSocket(beforeStale, 'wsReady 陈旧时也必须真重连');
    assert.ok(second !== first, '必须换一条真正的新连接');
    second.open();
    await h.waitFor(() => S.wsReady, 'stale-ready 重连后的 WS 就绪');
    assert.equal(second.frames('resume_stream').length, 1, 'stale-ready 重连后同样要续流');
  });

  // 让 focus 顺带排下的 400ms 空闲补拉落地，后续用例从干净的计数开始。
  await h.delay(450);
  await h.settle(6);

  /* ------------------------------------------------------------------ */
  /* 2. 空 events + runtimeIsStreaming:false：权威收尾并补完整历史        */
  /* ------------------------------------------------------------------ */

  await t('空 events + runtime=false：收掉 busy 与本轮，完整历史回复上屏', async () => {
    const socket = lastSocket();
    await startLiveTurn(socket, { streamId: 'stream-empty-events', text: 'PARTIAL_EMPTY_EVENTS' });
    historyFixture = historyWith('COMPLETE_EMPTY_EVENTS');
    const beforeGet = historyCount();

    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'stream-empty-events',
      sinceSeq: 0,
      isStreaming: false,          // 缓存快照，不是当前态
      runtimeIsStreaming: false,   // 当前运行态才是权威
      events: [],
    });

    await h.waitFor(() => S.busy === false, 'runtime=false 必须收掉 busy', 1500);
    assert.ok(!R.turn, '权威收尾后不能留着活动轮');
    await h.waitFor(
      () => historyCount() === beforeGet + 1,
      '收尾后应发一次历史补拉（无 state.turn 也要补）',
      2500,
    );
    await h.waitFor(
      () => transcriptText().includes('COMPLETE_EMPTY_EVENTS'),
      '完整假回复应替换半截流式内容',
      2000,
    );
    assert.ok(!transcriptText().includes('PARTIAL_EMPTY_EVENTS'), '半截流式正文必须被完整历史替换');
    assert.equal(historyCount(), beforeGet + 1, '一次收尾只能补拉一次历史');
  });

  /* ------------------------------------------------------------------ */
  /* 3. 等待首字无 turn；真实 status:false 也补历史、清占位               */
  /* ------------------------------------------------------------------ */

  await t('等待首字（busy 无 turn）时 status:false：清 busy、清占位、补历史', async () => {
    const socket = lastSocket();
    assert.ok(!R.turn, '夹具：上一条历史回放后没有活动轮');

    // 真实回显一笔用户消息：占位块挂着，模型还没吐字。
    socket.push({
      type: 'session_user_message',
      inputId: 'fg-incoming-1',
      message: { text: 'FG_WAITING_PROMPT' },
    });
    await h.settle(4);
    assert.ok(
      h.getEl('transcript').querySelector('.pending-tip'),
      '夹具：刚回显用户消息时应挂「正在思考」占位块',
    );

    historyFixture = historyWith('COMPLETE_STATUS_FALSE');
    const beforeGet = historyCount();

    pushStatus(socket, true, 'stream-waiting-first-token');
    await h.settle(4);
    assert.equal(S.busy, true, '夹具：status:true 应进入生成态');
    assert.ok(!R.turn, 'status:true 本身不能凭空建轮');

    pushStatus(socket, false, 'stream-waiting-first-token');
    await h.settle(4);
    assert.equal(S.busy, false, '真实 status:false 必须清 busy');
    assert.ok(
      !h.getEl('transcript').querySelector('.pending-tip'),
      'status:false 之后等待占位块必须收掉',
    );

    await h.waitFor(
      () => historyCount() === beforeGet + 1,
      '无 state.turn 的权威结束也要补拉历史',
      2500,
    );
    await h.waitFor(
      () => transcriptText().includes('COMPLETE_STATUS_FALSE'),
      '补拉到的完整回复应上屏',
      2000,
    );
    assert.equal(historyCount(), beforeGet + 1, '不得重复补拉');
  });

  /* ------------------------------------------------------------------ */
  /* 4. 运行态 true、快照 false：不能误判完成                             */
  /* ------------------------------------------------------------------ */

  await t('runtime=true 且快照 isStreaming=false：不收尾、不清 busy、不替换正文', async () => {
    const socket = lastSocket();
    await startLiveTurn(socket, { streamId: 'stream-still-running', text: 'PARTIAL_STILL_RUNNING' });
    historyFixture = historyWith('COMPLETE_MUST_NOT_REPLACE');
    const beforeGet = historyCount();

    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'stream-still-running',
      sinceSeq: 0,
      isStreaming: false,          // 过期的快照：不能据此判定完成
      runtimeIsStreaming: true,    // 当前运行态：还在生成
      events: [],
    });

    await h.delay(500);
    await h.settle(6);
    assert.equal(S.busy, true, '运行态还在生成时不能清 busy');
    assert.ok(R.turn, '还在生成的活动轮不能被收掉');
    assert.ok(transcriptText().includes('PARTIAL_STILL_RUNNING'), '正在生成的内容不能被历史替换');
    assert.ok(!transcriptText().includes('COMPLETE_MUST_NOT_REPLACE'), '不能拿缓存快照当完成信号');
    assert.equal(historyCount(), beforeGet, '还在生成时不该补拉历史');
  });

  /* ------------------------------------------------------------------ */
  /* 5. 缺字段 / 非布尔：不推断完成                                       */
  /* ------------------------------------------------------------------ */

  await t('runtimeIsStreaming 缺失或非布尔：不推断 idle', async () => {
    const socket = lastSocket();
    const beforeGet = historyCount();

    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'stream-still-running',
      sinceSeq: 0,
      events: [],                  // 两个运行态字段都没有
    });
    await h.delay(450);
    await h.settle(5);
    assert.equal(S.busy, true, '缺字段不能推断完成');
    assert.ok(R.turn, '缺字段不能收掉活动轮');
    assert.equal(historyCount(), beforeGet, '缺字段不能补拉历史');

    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'stream-still-running',
      sinceSeq: 0,
      isStreaming: 'false',        // 字符串也不是布尔
      runtimeIsStreaming: 'false',
      events: [],
    });
    await h.delay(450);
    await h.settle(5);
    assert.equal(S.busy, true, '非布尔字段同样不能推断完成');
    assert.ok(R.turn);
    assert.equal(historyCount(), beforeGet, '非布尔字段不能补拉历史');
  });

  /* ------------------------------------------------------------------ */
  /* 6. 别的会话：会话过滤先于外层运行态                                  */
  /* ------------------------------------------------------------------ */

  await t('别的会话的 stream_resume：即使 runtime=false 也不能收本会话', async () => {
    const socket = lastSocket();
    const beforeGet = historyCount();

    socket.push({
      type: 'stream_resume',
      sessionId: 'fg-resume-foreign',
      sessionPath: 'C:/offline-fixtures/fg-resume-foreign.jsonl',
      streamId: 'stream-still-running',
      sinceSeq: 0,
      runtimeIsStreaming: false,
      events: [
        { seq: 1, event: { type: 'text_delta', delta: 'FOREIGN_TEXT' } },
      ],
    });

    await h.delay(450);
    await h.settle(5);
    assert.equal(S.busy, true, '别的会话的 idle 不能收掉本会话的生成态');
    assert.ok(R.turn);
    assert.ok(!transcriptText().includes('FOREIGN_TEXT'), '别的会话的正文不能串进来');
    assert.equal(historyCount(), beforeGet, '别的会话的恢复帧不能触发本会话补拉');

    // 外层属于本会话、内层 replay event 属于别的会话：逐条身份过滤也不能收本会话。
    const innerNotifyBefore = notifyLog.length;
    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'stream-still-running',
      runtimeIsStreaming: true,
      events: [{
        seq: 1,
        event: {
          type: 'status',
          isStreaming: false,
          sessionId: 'fg-resume-foreign',
          sessionPath: 'C:/offline-fixtures/fg-resume-foreign.jsonl',
        },
      }],
    });
    await h.settle(6);
    assert.equal(S.busy, true, '外层是本会话时，内层 foreign 的 idle 也不能收本会话');
    assert.ok(R.turn);
    assert.ok(transcriptText().includes('PARTIAL_STILL_RUNNING'), '本会话的部分回复必须保留');
    assert.equal(historyCount(), beforeGet, '内层 foreign 不能触发本会话补拉');
    assert.equal(notifyLog.length, innerNotifyBefore, '内层 foreign 不能触发结束通知');
    assert.equal(hana.streamState.snapshot().lastSeq, 0, 'foreign inner 不得推进回放游标');

    // 收尾，给下一用例一个干净的 idle。
    pushStatus(socket, false, 'stream-still-running');
    await h.waitFor(() => S.busy === false, '夹具：本会话 status:false 收尾', 1500);
    await h.waitFor(() => historyCount() === beforeGet + 1, '夹具：收尾补拉', 2500);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 7. 重复 idle 帧合并成一次补拉                                        */
  /* ------------------------------------------------------------------ */

  await t('等待首字时重复的权威 idle 帧：清 busy 且只补拉一次历史', async () => {
    const socket = lastSocket();

    // 真实事件推到「等待首字」：busy 为真、没有 state.turn。
    pushStatus(socket, true, 'stream-duplicate-idle');
    await h.settle(4);
    assert.equal(S.busy, true, '夹具：status:true 应进入生成态');
    assert.ok(!R.turn, '夹具：等待首字时没有活动轮');

    const beforeGet = historyCount();
    for (let i = 0; i < 2; i += 1) {
      socket.push({
        type: 'stream_resume',
        sessionId: SESSION_ID,
        sessionPath: SESSION_PATH,
        streamId: 'stream-duplicate-idle',
        sinceSeq: 0,
        runtimeIsStreaming: false,
        events: [],
      });
    }

    await h.waitFor(() => S.busy === false, 'runtime=false：没有活动轮也要清 busy', 1500);
    await h.waitFor(() => historyCount() === beforeGet + 1, '重复 idle 应合并成一次补拉', 2500);
    await h.delay(250);
    await h.settle(4);
    assert.equal(historyCount(), beforeGet + 1, '防抖窗口内不得发出第二次历史请求');
  });

  /* ------------------------------------------------------------------ */
  /* 8. 隐藏 / 失焦取消待执行恢复；隐藏仍取消确认框                        */
  /* ------------------------------------------------------------------ */

  await t('隐藏与失焦取消待执行的重连；隐藏仍取消确认框', async () => {
    h.doc.visibilityState = 'visible';
    const before = socketCount();
    let cancelled = 0;
    const originalCancel = hana.actionConfirmation.cancelAll;
    hana.actionConfirmation.cancelAll = () => {
      cancelled += 1;
      if (typeof originalCancel === 'function') originalCancel();
    };

    try {
      h.fireWindow('focus');
      await h.delay(20);
      h.doc.visibilityState = 'hidden';
      h.fireDocument('visibilitychange');
      await h.delay(200);
      assert.ok(cancelled >= 1, '隐藏必须继续取消所有挂起的确认框');
      assert.equal(socketCount(), before, '隐藏后待执行的恢复不能再建连接');

      h.doc.visibilityState = 'visible';
      h.fireWindow('focus');
      h.fireWindow('blur');
      await h.delay(200);
      assert.equal(socketCount(), before, '失焦后待执行的恢复不能再建连接');
    } finally {
      hana.actionConfirmation.cancelAll = originalCancel;
      h.doc.visibilityState = 'visible';
    }
  });

  // 让隐藏/失焦前那次 focus 顺带排下的空闲补拉落地。
  await h.delay(450);
  await h.settle(6);

  /* ------------------------------------------------------------------ */
  /* 9. 切会话：旧恢复不重连、旧计时器不补拉新归属                         */
  /* ------------------------------------------------------------------ */

  await t('切会话后：旧恢复不重连，旧补拉计时器不碰新会话', async () => {
    h.doc.visibilityState = 'visible';
    const beforeSockets = socketCount();
    h.fireWindow('focus');                       // 排一个 100ms 恢复

    const switching = hana.openSession(OTHER_SESSION);  // 同步换掉归属
    await switching;
    const afterSwitchSockets = socketCount();
    assert.equal(afterSwitchSockets, beforeSockets + 1, '切会话自己只应建一条新连接');
    await h.waitFor(() => S.session?.sessionId === OTHER_SESSION.sessionId, '会话已切换');

    const afterSwitchGet = historyCount();
    await h.delay(500);                          // 覆盖旧恢复的 100ms 与旧补拉的 400ms
    await h.settle(6);
    assert.equal(socketCount(), afterSwitchSockets, '旧会话的待执行恢复不能给新会话再建连接');
    assert.equal(historyCount(), afterSwitchGet, '旧会话的补拉计时器不能拿新会话发历史请求');

    // 把新会话的连接打开，保持后续状态一致。
    lastSocket().open();
    await h.waitFor(() => S.wsReady, '新会话连接就绪');
  });

  /* ------------------------------------------------------------------ */
  /* 10. C1：初始 idle + runtimeIsStreaming=true 必须恢复生成态            */
  /* ------------------------------------------------------------------ */

  await t('C1: 初始 idle + runtime=true：恢复 busy，focus 补拉不得替换内容', async () => {
    await ensureMainSessionReady();
    assert.equal(S.busy, false, '夹具：应从 idle 开始');
    assert.ok(!R.turn, '夹具：idle 时没有活动轮');

    historyFixture = historyWith('C1_INITIAL_HISTORY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('C1_INITIAL_HISTORY'), '夹具：初始历史应上屏', 2000);

    const socket = lastSocket();
    const beforeGet = historyCount();
    const beforeNotify = notifyLog.length;
    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'c1-runtime-true-idle',
      sinceSeq: 0,
      isStreaming: false,          // 缓存快照：不能作为完成依据
      runtimeIsStreaming: true,    // 当前运行态：还在生成
      events: [],
    });
    await h.settle(6);
    assert.equal(S.busy, true, 'runtime=true 必须把初始 idle 的客户端恢复成生成态');
    assert.ok(!R.turn, '恢复 busy 不能凭空造一个活动轮');

    // focus 的 400ms 空闲补拉必须被 busy 门禁挡住，不能整页替换正在生成的内容。
    historyFixture = historyWith('C1_MUST_NOT_REPLACE');
    h.doc.visibilityState = 'visible';
    h.fireWindow('focus');
    await h.delay(650);            // > 100ms 重连 + 400ms 补拉
    await h.settle(6);
    assert.equal(historyCount(), beforeGet, 'runtime=true 期间 focus 不得发历史 GET');
    assert.ok(transcriptText().includes('C1_INITIAL_HISTORY'), '初始内容不能被替换');
    assert.ok(!transcriptText().includes('C1_MUST_NOT_REPLACE'), '正在生成时不能拿历史刷新');
    assert.equal(notifyLog.length, beforeNotify, 'runtime=true 不是结束，不能走结束通知');

    // 清理：focus 已换了一条连接，打开它并推送权威 false 收尾。
    const fresh = lastSocket();
    if (!S.wsReady) {
      fresh.open();
      await h.waitFor(() => S.wsReady, 'focus 重连后的连接就绪', 2000);
    }
    const beforeIdle = historyCount();
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'c1-runtime-true-idle',
      runtimeIsStreaming: false,
      events: [],
    });
    await h.waitFor(() => S.busy === false, '夹具：权威 idle 收尾', 1500);
    await h.waitFor(() => historyCount() === beforeIdle + 1, '夹具：权威 idle 补拉', 2500);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 11. C2：同帧回放整轮终态 + 外层 runtime=true 只推进游标，不产生副作用 */
  /* ------------------------------------------------------------------ */

  await t('C2: 同帧回放旧整轮终态 + runtime=true：不收尾、不通知、不补拉，游标仍推进', async () => {
    await ensureMainSessionReady();
    const socket = lastSocket();
    historyFixture = historyWith('C2_LIVE_HISTORY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('C2_LIVE_HISTORY'), '夹具：基线历史上屏', 2000);
    await startLiveTurn(socket, { streamId: 'c2-live-stream', text: 'C2_LIVE_PARTIAL' });
    const turnBefore = R.turn;
    const beforeGet = historyCount();
    const beforeNotify = notifyLog.length;

    const terminals = [
      { seq: 1, type: 'status', isStreaming: false },
      { seq: 2, type: 'session_status', isStreaming: false },
      { seq: 3, type: 'turn_end' },
      { seq: 4, type: 'done' },
      { seq: 5, type: 'complete' },
    ];
    for (const term of terminals) {
      socket.push({
        type: 'stream_resume',
        sessionId: SESSION_ID,
        sessionPath: SESSION_PATH,
        streamId: 'c2-live-stream',
        runtimeIsStreaming: true,
        isStreaming: false,
        events: [{
          seq: term.seq,
          event: {
            ...term,
            sessionId: SESSION_ID,
            sessionPath: SESSION_PATH,
            streamId: 'c2-live-stream',
          },
        }],
      });
      await h.settle(8);
      assert.equal(S.busy, true, `${term.type} 回放不能清掉生成态`);
      assert.ok(R.turn === turnBefore, `${term.type} 回放不能收掉活动轮`);
      assert.ok(transcriptText().includes('C2_LIVE_PARTIAL'), `${term.type} 回放不能替换正文`);
      assert.equal(historyCount(), beforeGet, `${term.type} 回放不能触发历史补拉`);
      assert.equal(notifyLog.length, beforeNotify, `${term.type} 回放不能触发结束通知`);
    }
    assert.equal(hana.streamState.snapshot().lastSeq, 5, '冲突终态只跳过分派，序号仍要推进');

    // 回放里的正文/段结束照常处理：不能因为外层 true 就整批丢弃。
    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'c2-live-stream',
      runtimeIsStreaming: true,
      events: [
        { seq: 6, event: { type: 'text_delta', delta: 'C2_REPLAYED_CONTENT' } },
        { seq: 7, event: { type: 'stream_turn_end', aborted: true } },
        { seq: 8, event: { type: 'status', isStreaming: false } },
      ],
    });
    await h.settle(8);
    assert.ok(transcriptText().includes('C2_REPLAYED_CONTENT'), '回放正文必须照常上屏');
    assert.equal(S.busy, true, '回放里的段结束/旧终态都不能结束整轮');
    assert.ok(R.turn === turnBefore, '活动轮仍是同一轮');
    assert.equal(historyCount(), beforeGet, '回放内容不能触发历史补拉');
    assert.equal(notifyLog.length, beforeNotify, '回放内容不能触发结束通知');
    assert.equal(hana.streamState.snapshot().lastSeq, 8, '回放游标继续推进');

    // 冲突终态/回放内容都不能排下 400ms 后的历史补拉。
    await h.delay(450);
    await h.settle(4);
    assert.equal(historyCount(), beforeGet, '冲突回放在防抖窗口后也不能补拉历史');

    // 清理：真实 status:false 结束这一轮。
    pushStatus(socket, false, 'c2-live-stream');
    await h.waitFor(() => S.busy === false, '夹具：真实 status:false 收尾', 1500);
    await h.waitFor(() => historyCount() === beforeGet + 1, '夹具：收尾补拉', 2500);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 12. I1：无 turn 的 idle 不能把旧段 aborted 元数据留给下一轮           */
  /* ------------------------------------------------------------------ */

  await t('I1: 无 turn 的 runtime idle 清掉旧段元数据，新轮不被 skipped-aborted 压掉', async () => {
    await ensureMainSessionReady();
    const socket = lastSocket();
    assert.ok(!R.turn, '夹具：应从无活动轮开始');
    assert.equal(S.busy, false, '夹具：应从 idle 开始');

    const beforeIdleGet = historyCount();
    socket.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'i1-old-aborted-stream',
      runtimeIsStreaming: false,
      events: [{ seq: 1, event: { type: 'stream_turn_end', aborted: true } }],
    });
    await h.waitFor(() => historyCount() === beforeIdleGet + 1, '无 turn idle 的补拉', 2500);
    await h.settle(6);

    const beforeNotify = notifyLog.length;
    const beforeTurnGet = historyCount();
    pushStatus(socket, true, 'i1-new-stream');
    socket.push({
      type: 'text_delta',
      delta: 'I1_NEW_NON_ABORTED_REPLY',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'i1-new-stream',
    });
    pushStatus(socket, false, 'i1-new-stream');
    await h.waitFor(() => notifyLog.length === beforeNotify + 1, '新轮结束应有且只有一次通知判定', 2000);
    await h.waitFor(() => historyCount() === beforeTurnGet + 1, '新轮结束补拉', 2500);
    await h.settle(6);
    const verdict = notifyLog.at(-1).split(' → ').at(-1);
    assert.equal(verdict, 'skipped-foreground', `旧段 aborted 不得压掉新轮通知，实际 ${verdict}`);
    assert.equal(S.busy, false, '新轮结束后应回到 idle');
    assert.ok(!R.turn, '新轮结束后不应留有活动轮');
  });

  /* ------------------------------------------------------------------ */
  /* 13. visibility-only：没有 focus 也要独立恢复一次                      */
  /* ------------------------------------------------------------------ */

  await t('visibility-only（无 focus）独立触发一次真实重连并续流', async () => {
    await ensureMainSessionReady();
    const before = socketCount();
    h.doc.visibilityState = 'visible';
    h.fireDocument('visibilitychange');    // 不派发 focus

    const sock = await waitForNewSocket(before, '仅 visibilitychange(visible) 也应重连');
    assert.ok(S.ws === sock, '当前连接必须换成 visible 新建的这条');
    await h.delay(180);
    assert.equal(socketCount(), before + 1, '重复 visible 事件仍只建一条连接');

    sock.open();
    await h.waitFor(() => S.wsReady, 'visibility-only 重连就绪', 2000);
    assert.equal(sock.frames('client_attention').length, 1, 'visible 重连后要重报前台一次');
    assert.equal(sock.frames('resume_stream').length, 1, 'visible 重连后要续流一次');
    await h.delay(450);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 14. 登出取消待执行恢复                                               */
  /* ------------------------------------------------------------------ */

  await t('登出后待执行恢复不得再建连接', async () => {
    h.doc.visibilityState = 'visible';
    const before = socketCount();
    h.fireWindow('focus');
    hana.resetAfterLogout();                     // 真实的退出登录本地收尾
    await h.delay(250);
    assert.equal(socketCount(), before, '登出后旧恢复不能偷偷重连');
    assert.ok(S.session === null, '登出必须清会话归属');
    assert.equal(S.wsReady, false, '登出必须断开连接');
  });

  /* ------------------------------------------------------------------ */
  /* 15. 全程没有重发用户 prompt                                          */
  /* ------------------------------------------------------------------ */

  await t('恢复与补拉全程不重发用户 prompt', async () => {
    assert.equal(promptFrameCount(), 0, '前台恢复链路绝不能重发 prompt 帧');
    for (const [index, socket] of h.ws.instances.entries()) {
      assert.equal(socket.frames('prompt').length, 0, `第 ${index + 1} 条连接上出现了 prompt 帧`);
    }
  });

  if (bad > 0) {
    console.log(`\n${bad} TESTS FAILED`);
  } else {
    console.log(`\nALL PASS (scenarios=${h.ws.instances.length} sockets, historyGET=${historyCount()})`);
  }
} catch (err) {
  bad += 1;
  console.error('HARNESS FAILURE\n' + (err.stack || err.message));
} finally {
  process.exit(bad > 0 ? 1 : 0);
}
