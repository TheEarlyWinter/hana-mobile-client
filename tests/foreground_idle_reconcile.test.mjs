/* 前台恢复对账：回到前台后「一条事件都没来」时，靠历史自证收尾
 *
 * 缺陷背景（真机）：手机息屏再亮屏回到 App，回复停在半截；退出会话再进才看得到完整内容。
 * 链路断点：
 *   前台恢复会强制重连并排一次「当前会话历史刷新」；socket open 后发 resume_stream。但
 *   回放为空、或回包不带运行态时，宿主没有任何权威 idle，本地 busy 不会被清；随后
 *   conversation-controller 调 loadHistory()，又被 history-pager 的 !busy 门控拦住
 *   ——GET 根本不发。既没有权威 idle，也没有历史补拉，屏幕就停在半截回复。
 *
 * 本文件锁的是新加的「前台对账」：只在前台恢复后的一个短窗口里动手，判据是
 * 「能自证刚刚没有任何新事件」。覆盖：
 *   1. 空回放 + 不带运行态 + 窗口内无任何事件 → 窗口到期后放行一次历史 GET；
 *      历史里有更完整的回复时收尾、清 busy、屏上换完整回复（不弹结束通知、不重复补拉）。
 *   2. 窗口内来了 token 事件 → 不收尾、不放行历史 GET，流继续。
 *   3. 回放带 runtimeIsStreaming:false → 走既有权威路径立即收尾，老行为不改坏，
 *      且对账不会再多发一次 GET。
 *   4. 历史里没有新内容（离线期间没产生回复）→ 只合并不收尾：busy 保持、屏上内容不动。
 *   5. 只触发一次：一个窗口过完不会再排第二个；重新进后台再回来会重置（重新开窗）。
 *
 * 写法与 foreground_resume.test.mjs 一致：真 web/app.js + 假 DOM/假 WS/路由化 fetch，
 * busy 由真实的 status / text_delta 推出来，历史补拉看的是 /api/sessions/messages 的
 * 实际 GET 次数与 transcript 的可见文本；focus / visibilitychange 是真实窗口事件。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
// notifications 的 isForeground 会读 document.hasFocus()；夹具里补一个真实实现。
h.doc.hasFocus = () => true;

const SESSION_ID = 'fg-reconcile-main';
const SESSION_PATH = 'C:/offline-fixtures/fg-reconcile-main.jsonl';
const SESSION = {
  path: SESSION_PATH,
  sessionId: SESSION_ID,
  title: '前台对账',
  agentId: 'agent-fg-reconcile',
};

/** 对账窗口 2000ms（event-router 的 DEFAULT_IDLE_RECONCILE_WINDOW_MS）。 */
const WINDOW_MS = 2000;
/** 窗口到期 + 一次 GET 的余量。 */
const AFTER_WINDOW_MS = WINDOW_MS + 1200;

const requests = { history: [] };

function userMessage(id, text) {
  return {
    id: String(id),
    role: 'user',
    content: text,
    timestamp: '2026-11-08T12:00:00.000Z',
  };
}

function assistantMessage(id, text) {
  return {
    id: String(id),
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: '2026-11-08T12:01:00.000Z',
  };
}

function historyWith(text, { assistantId = 2 } = {}) {
  return {
    messages: [userMessage(1, 'RECON_USER_PROMPT'), assistantMessage(assistantId, text)],
    blocks: [],
    hasMore: false,
  };
}

let historyFixture = historyWith('RECON_BASELINE_REPLY');

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
const countIn = (haystack, needle) => String(haystack).split(needle).length - 1;

/**
 * 结束通知是真实 notifications 模块经 console.info 打出来的。这里只旁听：
 * 用来断言「对账收尾不该走结束通知」（宿主没发结束事件，不是一轮正常结束）。
 */
const notifyLog = [];
const originalConsoleInfo = console.info;
console.info = (...args) => {
  const first = String(args[0] || '');
  if (first.startsWith('[notify] 回合结束')) {
    notifyLog.push(args.map(String).join(' '));
    return;
  };
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
  await h.settle(6);
  assert.ok(hana.S.busy === true, '夹具：真实 status/text_delta 应进入生成态');
  assert.ok(Boolean(hana.S.turn), '夹具：真实 text_delta 应开出一轮');
  assert.ok(transcriptText().includes(text), '夹具：实时正文应上屏');
}

/** 回到前台：真实 focus 事件 → 100ms 后重连 → 打开新连接。 */
async function resumeForeground() {
  h.doc.visibilityState = 'visible';
  const before = socketCount();
  h.fireWindow('focus');
  const socket = await waitForNewSocket(before, '前台恢复应真正重连');
  socket.open();
  await h.waitFor(() => hana.S.wsReady, '重连后的连接就绪', 2000);
  return socket;
}

/** 干净的 idle 起点：会话就位、连接就绪、没有生成态、历史补拉已落地。 */
async function ensureIdleMainSession() {
  const S = hana.S;
  if (S.session?.sessionId !== SESSION_ID) {
    const before = socketCount();
    await hana.openSession(SESSION);
    await h.waitFor(() => socketCount() === before + 1, '回到主会话应建立新连接', 2000);
    lastSocket().open();
    await h.waitFor(() => S.wsReady, '主会话连接就绪', 2000);
  }
  if (!S.wsReady) {
    lastSocket().open();
    await h.waitFor(() => S.wsReady, '主会话连接就绪', 2000);
  }
  // 上一用例可能留着生成态：用真实 status:false 收尾（走既有权威路径）。
  if (S.busy) {
    pushStatus(lastSocket(), false);
    await h.waitFor(() => S.busy === false, '夹具：收尾到 idle', 2500);
  }
  // 会话切换 / 收尾会排 400ms 历史补拉：等它落地，调用方再记基线。
  await h.delay(480);
  await h.settle(6);
}

let bad = 0;
let caseIndex = 0;
// 诊断安全：对象身份/空值断言一律用布尔 assert.ok，
// 避免断言失败时 Node 对整棵假 DOM / WS 对象做差异格式化（实测会卡死进程）。
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
try {
  hana = await h.loadApp();
  const S = hana.S;
  await h.waitFor(() => S.currentAgent, 'boot 完成');

  await hana.openSession(SESSION);
  await h.waitFor(() => socketCount() === 1, '打开会话应建立一条 WebSocket');
  lastSocket().open();
  await h.waitFor(() => S.wsReady, '初始连接就绪');
  assert.equal(historyCount(), 1, '夹具：打开会话应拉一次历史');
  console.log('INFO actualApp=web/app.js harness=tests/support/app_harness.mjs network=fetch-mock');

  /* ------------------------------------------------------------------ */
  /* 1. 空回放 + 不带运行态 + 窗口内无事件：放行一次 GET 并收尾换屏        */
  /* ------------------------------------------------------------------ */

  await t('空回放 + 无事件：窗口到期放行一次历史 GET，完整回复上屏并清 busy', async () => {
    await ensureIdleMainSession();
    historyFixture = historyWith('RECON_BASELINE_REPLY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('RECON_BASELINE_REPLY'), '夹具：基线历史上屏', 2000);

    const socket = lastSocket();
    await startLiveTurn(socket, { streamId: 'recon-a', text: 'RECON_A_PART' });
    historyFixture = historyWith('RECON_A_PART 离线期间补完的完整回复 RECON_A_DONE');
    const beforeGet = historyCount();
    const beforeNotify = notifyLog.length;

    // 回到前台：重连 + 排一次历史刷新（这次刷新会被 busy 门控拦住，就是缺陷本身）。
    const fresh = await resumeForeground();
    // 宿主回包：回放为空，且不带运行态（既没有 idle，也没有还在生成）。
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-a',
      sinceSeq: 0,
      isStreaming: false,        // 缓存快照，不是当前态
      events: [],                // 空回放：宿主什么都没说
    });

    // 窗口内必须先什么都不做：既不收尾，也不许提前发 GET。
    await h.delay(600);
    await h.settle(6);
    assert.ok(S.busy === true, '窗口未到期前不能清 busy');
    assert.ok(Boolean(S.turn), '窗口未到期前不能收掉活动轮');
    assert.equal(historyCount(), beforeGet, '窗口未到期前不得发历史 GET');

    // 窗口到期：放行一次历史补拉 → 历史比屏上更完整 → 收尾换屏。
    await h.waitFor(() => historyCount() === beforeGet + 1, '窗口到期后应放行一次历史 GET', AFTER_WINDOW_MS + 1500);
    await h.waitFor(() => S.busy === false, '对账收尾应清 busy', 3000);
    await h.waitFor(() => transcriptText().includes('RECON_A_DONE'), '完整回复应上屏', 2000);

    assert.ok(!S.turn, '对账收尾后不能留着活动轮');
    assert.equal(countIn(transcriptText(), 'RECON_A_PART'), 1, '半截实时正文必须被完整历史替换，不能各留一份');
    assert.equal(notifyLog.length, beforeNotify, '对账收尾不是宿主结束事件，不应走结束通知');
    // 收尾不再排第二次补拉：历史就是这次对账自己取回来的那份。
    await h.delay(700);
    await h.settle(6);
    assert.equal(historyCount(), beforeGet + 1, '对账收尾后不得重复补拉历史');
  });

  /* ------------------------------------------------------------------ */
  /* 2. 窗口内来了 token：不许收尾、不许发 GET，流继续                     */
  /* ------------------------------------------------------------------ */

  await t('窗口内来了 token：不收尾、不放行历史 GET，流继续', async () => {
    await ensureIdleMainSession();
    historyFixture = historyWith('RECON_BASELINE_REPLY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('RECON_BASELINE_REPLY'), '夹具：基线历史上屏', 2000);

    await startLiveTurn(lastSocket(), { streamId: 'recon-b', text: 'RECON_B_PART' });
    // 历史故意给一份「更完整」的回复：只要对账敢动手，屏幕就会被换掉。
    historyFixture = historyWith('RECON_B_PART 本不该被用到的完整回复 RECON_B_DONE');
    const beforeGet = historyCount();

    const fresh = await resumeForeground();
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-b',
      sinceSeq: 0,
      events: [],
    });
    await h.settle(6);
    // 窗口内真的来了正文事件：窗口必须立刻作废。
    fresh.push({
      type: 'text_delta',
      delta: 'RECON_B_MORE',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-b',
    });
    await h.settle(6);
    assert.ok(transcriptText().includes('RECON_B_MORE'), '夹具：实时事件应照常上屏');

    // 等过整个窗口 + 余量：都不许动手。
    await h.delay(AFTER_WINDOW_MS);
    await h.settle(8);
    assert.equal(S.busy, true, '窗口内来过事件时不能清 busy');
    assert.ok(Boolean(S.turn), '窗口内来过事件时不能收掉活动轮');
    assert.equal(historyCount(), beforeGet, '窗口内来过事件时不得发历史 GET');
    assert.ok(transcriptText().includes('RECON_B_PART'), '屏上实时正文不能被历史替换');
    assert.ok(!transcriptText().includes('RECON_B_DONE'), '历史内容不得混进正在生成的这一轮');

    // 清理：真实 status:false 走既有收尾。
    pushStatus(fresh, false, 'recon-b');
    await h.waitFor(() => S.busy === false, '夹具：真实 status:false 收尾', 2000);
    await h.delay(600);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 3. 回放带 runtimeIsStreaming:false：既有权威路径立即收尾（老行为）    */
  /* ------------------------------------------------------------------ */

  await t('回放 runtimeIsStreaming:false：立即收尾，对账不再多发一次 GET', async () => {
    await ensureIdleMainSession();
    historyFixture = historyWith('RECON_BASELINE_REPLY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('RECON_BASELINE_REPLY'), '夹具：基线历史上屏', 2000);

    await startLiveTurn(lastSocket(), { streamId: 'recon-c', text: 'RECON_C_PART' });
    historyFixture = historyWith('RECON_C_PART 权威 idle 之后的完整回复 RECON_C_DONE');
    const beforeGet = historyCount();
    const beforeNotify = notifyLog.length;

    const fresh = await resumeForeground();
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-c',
      isStreaming: false,
      runtimeIsStreaming: false,   // 当前运行态：权威 idle
      events: [],
    });

    // 必须「立即」收尾：远早于 2s 对账窗口。
    await h.waitFor(() => S.busy === false, 'runtime=false 必须走既有路径立即收尾', 1200);
    await h.waitFor(() => historyCount() === beforeGet + 1, '权威 idle 的补拉', 2500);
    await h.waitFor(() => transcriptText().includes('RECON_C_DONE'), '完整历史应上屏', 2000);
    assert.ok(!S.turn, '权威收尾后不应留着活动轮');
    assert.ok(notifyLog.length === beforeNotify + 1, '权威 idle 是真实结束事件，仍应走一次结束通知判定');

    // 窗口应该已经被这条 resume 事件取消：再等一个窗口也不会多出 GET。
    await h.delay(AFTER_WINDOW_MS);
    await h.settle(8);
    assert.equal(historyCount(), beforeGet + 1, '既有收尾之后对账不能再补一次历史');
  });

  /* ------------------------------------------------------------------ */
  /* 4. 历史里没有新内容：只合并、不收尾                                   */
  /* ------------------------------------------------------------------ */

  await t('历史里没有新内容：只合并不收尾，busy 与屏上内容都不动', async () => {
    await ensureIdleMainSession();
    historyFixture = historyWith('RECON_BASELINE_REPLY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('RECON_BASELINE_REPLY'), '夹具：基线历史上屏', 2000);

    await startLiveTurn(lastSocket(), { streamId: 'recon-d', text: 'RECON_D_PART' });
    // 离线期间什么都没跑出来：历史最后一条 assistant 是上一轮的回复，
    // 比实时正文长，但完全不包含它——必须判成「没有新内容」。
    historyFixture = historyWith('RECON_D_PREVIOUS_REPLY 这是上一轮的完整回复，比实时正文更长但不相干');
    const beforeGet = historyCount();
    const turnBefore = S.turn;

    const fresh = await resumeForeground();
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-d',
      sinceSeq: 0,
      events: [],
    });

    await h.waitFor(() => historyCount() === beforeGet + 1, '窗口到期仍应取一页来对照', AFTER_WINDOW_MS + 1500);
    await h.delay(400);
    await h.settle(8);

    assert.equal(S.busy, true, '历史没有新内容时不能清 busy');
    assert.ok(S.turn === turnBefore, '活动轮必须还是原来那一轮');
    assert.ok(transcriptText().includes('RECON_D_PART'), '屏上实时正文必须保留');
    assert.ok(transcriptText().includes('RECON_BASELINE_REPLY'), '整页历史不能被换掉');
    assert.ok(!transcriptText().includes('RECON_D_PREVIOUS_REPLY'), '旧回复不能顶掉正在生成的这一轮');
    assert.equal(historyCount(), beforeGet + 1, '一次对账只取一页');

    // 清理：真实 status:false 走既有收尾。
    pushStatus(fresh, false, 'recon-d');
    await h.waitFor(() => S.busy === false, '夹具：真实 status:false 收尾', 2000);
    await h.delay(600);
    await h.settle(6);
  });

  /* ------------------------------------------------------------------ */
  /* 5. 只触发一次：窗口过完不再排第二个；重新进后台再回来会重置           */
  /* ------------------------------------------------------------------ */

  await t('对账只触发一次；重新进后台再回来会重置（重新开窗）', async () => {
    await ensureIdleMainSession();
    historyFixture = historyWith('RECON_BASELINE_REPLY');
    await hana.loadHistory();
    await h.waitFor(() => transcriptText().includes('RECON_BASELINE_REPLY'), '夹具：基线历史上屏', 2000);

    await startLiveTurn(lastSocket(), { streamId: 'recon-e', text: 'RECON_E_PART' });
    // 历史没有新内容 → 对账跑完仍然 busy，方便观察「会不会再排第二次」。
    historyFixture = historyWith('RECON_E_PREVIOUS_REPLY 上一轮的回复');
    const beforeGet = historyCount();

    const fresh = await resumeForeground();
    fresh.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-e',
      sinceSeq: 0,
      events: [],
    });
    await h.waitFor(() => historyCount() === beforeGet + 1, '第一次窗口到期应放行一次 GET', AFTER_WINDOW_MS + 1500);
    await h.settle(6);

    // 窗口已经用完：再等一整个窗口都不该再排第二次（对账不是轮询）。
    await h.delay(WINDOW_MS + 600);
    await h.settle(8);
    assert.equal(historyCount(), beforeGet + 1, '对账只能触发一次，不能变成轮询');
    assert.equal(S.busy, true, '夹具：这一轮仍然 busy');

    // 重新进后台再回来：窗口重置，再放行一次（且只有一次）。
    h.doc.visibilityState = 'hidden';
    h.fireDocument('visibilitychange');
    await h.delay(120);
    h.doc.visibilityState = 'visible';
    const beforeSecond = socketCount();
    h.fireWindow('focus');
    const second = await waitForNewSocket(beforeSecond, '重新回到前台应再重连一次');
    second.open();
    await h.waitFor(() => S.wsReady, '第二次恢复的连接就绪', 2000);
    second.push({
      type: 'stream_resume',
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      streamId: 'recon-e',
      sinceSeq: 0,
      events: [],
    });

    await h.waitFor(
      () => historyCount() === beforeGet + 2,
      '重新回到前台后应重新开窗并再放行一次',
      AFTER_WINDOW_MS + 1500,
    );
    await h.delay(WINDOW_MS + 600);
    await h.settle(8);
    assert.equal(historyCount(), beforeGet + 2, '第二次恢复同样只放行一次');
    assert.equal(S.busy, true, '仍然没有新内容，busy 保持');

    // 清理：真实 status:false 走既有收尾。
    pushStatus(second, false, 'recon-e');
    await h.waitFor(() => S.busy === false, '夹具：真实 status:false 收尾', 2000);
    await h.delay(600);
    await h.settle(6);
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
