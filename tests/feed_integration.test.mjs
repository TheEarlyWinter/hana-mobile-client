/* Real web/app.js wiring through the shared app harness. All upstream data, DOM and WS are fake. */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createFeedFeature } from '../web/features/feed.js';

const ID_A = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'fi_0123456789ABCDEFGHJKMNPQRT';
const ISO = '2026-11-06T00:00:00.000Z';

function item(itemId, extra = {}) {
  return {
    itemId,
    revision: 2,
    lane: 'task',
    laneKind: 'task',
    template: 'folio-card',
    title: `日报 ${itemId.slice(-1)}`,
    ask: '要追问哪一点？',
    topics: ['验收'],
    source: { sourceId: 'source-1', agentId: 'agent-1', displayName: '日报助手' },
    createdAt: ISO,
    unread: true,
    favorite: false,
    task: { state: 'pending', actions: [{ id: 'host-action-42', kind: 'confirm', label: '完成' }] },
    ...extra,
  };
}

const state = {
  slateCalls: [],
  favoriteCalls: [],
  hideCalls: [],
  taskCalls: [],
  prepareCalls: [],
  createCalls: [],
  logoutCalls: 0,
  sessionListCalls: 0,
  messageCalls: 0,
  // 阅读计时用例：可控 revision、慢上游与信号记录
  currentRevision: 2,
  slateDelayMs: 0,
  slateDelayFor: null,
  cardCalls: [],
  signalCalls: [],
};
const h = createHarness();
// 共享 fake DOM 不解析首页真实层级；本测试只显式装配本次入口合同涉及的 composer dock。
h.getEl('homeComposerDock').appendChild(h.getEl('homeComposer'));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function createIsolatedQuestionFeature({ createGate = null, prepareGate = null, senderMode = 'ws' } = {}) {
  const isolated = createHarness({ debug: false });
  const identity = { id: 'isolated-user' };
  const calls = { create: [], prepare: [], open: [], send: [], frames: [], frameWasWritten: false, releaseSend: null };
  let epoch = 10;
  let session = { path: '/old/session', sessionId: 'old-session' };
  const api = async (path) => {
    if (path.startsWith('/api/feed/slate')) {
      return {
        slateId: 'isolated-slate',
        items: [item(ID_A, { revision: 8 }), item(ID_B, { revision: 9 })],
        unreadTaskCount: 0,
        cursor: null,
        nextPatrolAt: null,
      };
    }
    if (path === '/api/sessions/new') {
      calls.create.push(path);
      if (createGate) await createGate.promise;
      return { path: '/fake/session.jsonl', sessionId: `isolated-${calls.create.length}`, agentId: 'agent-1' };
    }
    if (path === '/api/feed/send/prepare') {
      calls.prepare.push(path);
      if (prepareGate) await prepareGate.promise;
      return { ok: true, feedCard: { itemId: ID_A, revision: 8, title: '冻结卡片' } };
    }
    if (path === '/api/feed/signals') return { accepted: 2, unreadTaskCount: 0 };
    throw new Error(`unexpected isolated fake api path: ${path}`);
  };
  const feature = createFeedFeature({
    api,
    document: isolated.doc,
    window: isolated.window,
    getIdentity: () => identity,
    getNavigationEpoch: () => epoch,
    getSession: () => session,
    openSession: async (next) => {
      calls.open.push(next);
      epoch += 1;
      session = next;
    },
    sendPrepared: (options) => {
      calls.send.push(options);
      return new Promise((resolve) => {
        if (senderMode === 'written-late') {
          calls.frames.push(options.text);
          calls.frameWasWritten = true;
          calls.releaseSend = () => resolve({
            frameWritten: true,
            committed: false,
            inputId: 'written-late',
            error: new Error('late local settlement failure'),
          });
          return;
        }
        calls.releaseSend = () => {
          if (options.isCurrent()) {
            calls.frames.push(options.text);
            calls.frameWasWritten = true;
            resolve({ frameWritten: true, committed: true, inputId: 'ws-ready' });
          } else {
            resolve({ frameWritten: false, committed: false, inputId: null });
          }
        };
      });
    },
  });
  await feature.open();
  const row = (id) => isolated.findAll(isolated.doc.body, '.feed-item').find((node) => node.dataset.itemId === id);
  return { isolated, feature, calls, row };
}

/* 受控可见性：只有用例显式 fire 相交，卡片才会准备；tracker 的可见性也走同一入口。 */
class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) { this.targets.add(target); }

  unobserve(target) { this.targets.delete(target); }

  disconnect() { this.targets.clear(); }

  takeRecords() { return []; }
}

function fireIntersection(target) {
  for (const io of FakeIntersectionObserver.instances) {
    if (!io.targets.has(target)) continue;
    io.callback([{ target, isIntersecting: true, intersectionRatio: 1 }], io);
  }
}

// 假 DOM 没有原生 IntersectionObserver / isConnected / iframe.contentWindow：补最小能力，
// 让 tracker 的可见性、停靠判断和卡片 ready 走真实代码路径。
h.window.IntersectionObserver = FakeIntersectionObserver;
{
  const createElement = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const node = createElement(tag);
    Object.defineProperty(node, 'isConnected', {
      configurable: true,
      get() {
        let cur = node;
        while (cur) {
          if (cur === h.doc.body) return true;
          cur = cur.parentNode;
        }
        return false;
      },
    });
    if (String(tag).toLowerCase() === 'iframe') node.contentWindow = { postMessage() {} };
    return node;
  };
}
h.setFetch(async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const path = parsed.pathname;
  const method = String(init.method || 'GET').toUpperCase();
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/fake-home',
    });
  }
  if (path === '/api/web-auth/logout') {
    state.logoutCalls += 1;
    return h.jsonRes({ ok: true });
  }
  if (path === '/api/feed/slate') {
    state.slateCalls.push({ cursor: parsed.searchParams.get('cursor'), method, at: Date.now() });
    // 固定延迟之外允许按请求序号给不同延迟，用于两个刷新请求错时完成的场景。
    const delayMs = typeof state.slateDelayFor === 'function'
      ? state.slateDelayFor(state.slateCalls.length)
      : state.slateDelayMs;
    if (delayMs > 0) await h.delay(delayMs);
    const more = parsed.searchParams.get('cursor') === 'CURSOR-2';
    const lane = parsed.searchParams.get('lanes') || '';
    const revision = state.currentRevision;
    return h.jsonRes({
      slateId: lane ? `slate-${lane}` : more ? 'slate-more' : 'slate-first',
      items: lane
        ? [item(ID_B, { title: '日报 B', revision, lane: 'content', laneKind: 'content', task: undefined })]
        : more
          ? [item(ID_B, { title: '日报 B', revision, task: undefined })]
          : [item(ID_A, { title: '日报 A', revision })],
      unreadTaskCount: more ? 1 : 2,
      cursor: more ? null : 'CURSOR-2',
      nextPatrolAt: null,
    });
  }
  if (path.endsWith('/card') && method === 'POST') {
    const segments = path.split('/');
    const itemId = decodeURIComponent(segments[segments.length - 2]);
    state.cardCalls.push({ itemId, revision: state.currentRevision });
    return h.jsonRes({
      cardId: `card-${state.currentRevision}`,
      revision: state.currentRevision,
      documentPath: 'card/index.html',
    });
  }
  if (path.endsWith('/favorite') && method === 'PUT') {
    state.favoriteCalls.push(JSON.parse(init.body || '{}'));
    return h.jsonRes({ favorite: true });
  }
  if (path.endsWith('/hide') && method === 'POST') {
    state.hideCalls.push(JSON.parse(init.body || '{}'));
    return h.jsonRes({ hiddenAt: ISO });
  }
  if (path.endsWith('/task') && method === 'POST') {
    state.taskCalls.push(JSON.parse(init.body || '{}'));
    return h.jsonRes({ task: { state: 'done', actions: [] } });
  }
  if (path === '/api/feed/send/prepare') {
    const body = JSON.parse(init.body || '{}');
    state.prepareCalls.push(body);
    return h.jsonRes({ ok: true, feedCard: { itemId: body.feedItemId, revision: body.revision, title: '冻结的日报标题' } });
  }
  if (path === '/api/sessions/new') {
    const body = JSON.parse(init.body || '{}');
    state.createCalls.push(body);
    const n = state.createCalls.length;
    return h.jsonRes({ path: `C:/fake-sessions/feed-${n}.jsonl`, sessionId: `feed-session-${n}` });
  }
  if (path === '/api/sessions/messages') {
    state.messageCalls += 1;
    return h.jsonRes({ entries: [], messages: [], blocks: [], hasMore: false });
  }
  if (path === '/api/sessions' || path.startsWith('/api/sessions/list')) {
    state.sessionListCalls += 1;
    return h.jsonRes({ sessions: [] });
  }
  if (path === '/api/feed/signals') {
    const body = JSON.parse(init.body || '{}');
    state.signalCalls.push({ at: Date.now(), signals: body.signals || [] });
    return h.jsonRes({ accepted: body.signals?.length || 0, unreadTaskCount: 1 });
  }
  if (path.startsWith('/api/')) return h.jsonRes({});
  throw new Error(`unexpected fetch: ${url}`);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成', 5000);
const feed = hana.features.get('feed');
const row = (itemId) => h.findAll(h.doc.body, '.feed-item').find((node) => node.dataset.itemId === itemId) || null;
const feedButton = () => h.getEl('homeComposerDock').children.find((node) => node.id === 'btnFeed') || null;
const entryBadge = () => h.find(feedButton(), '.feed-entry-badge');
const promptFrames = () => h.MockWebSocket.instances.flatMap((ws) => ws.frames('prompt'));
const waitForRequestsToSettle = async () => {
  await h.delay(320);
  await h.settle(5);
};

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function openFeedWithReadyCard(revision) {
  feed.reset();
  state.slateDelayMs = 0;
  state.slateDelayFor = null;
  state.currentRevision = revision;
  state.cardCalls.length = 0;
  state.signalCalls.length = 0;
  h.doc.visibilityState = 'visible';
  const slateBefore = state.slateCalls.length;
  await feed.open();
  await h.waitFor(() => row(ID_A) && row(ID_A).dataset.revision === String(revision), '首屏条目与 revision');
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '首屏请求');
  await h.settle(4);
  assert.equal(h.findAll(h.doc.body, 'iframe').length, 0, '列表阶段零 iframe、零正文请求');
  assert.equal(state.cardCalls.length, 0, '列表阶段不得铸造卡片');

  // 阅读计时只有在用户点开阅读层后才开始：卡片节点在阅读层里。
  h.find(row(ID_A), '.feed-read').click();
  await h.waitFor(() => state.cardCalls.length === 1, '阅读层卡片准备请求');
  await h.waitFor(() => h.find(h.doc.body, '.feed-reader iframe'), '阅读层 iframe 挂载');
  const card = h.find(h.doc.body, '.feed-reader .feed-card');
  assert.ok(card, '阅读层卡片占位应存在');
  fireIntersection(card);
  const iframe = h.find(h.doc.body, '.feed-reader iframe');
  h.fireWindow('message', { source: iframe.contentWindow, data: { __hanaCardHeight: 320 } });
  await h.settle(3);
  return { card, iframe };
}

/** 刷新/重开之后重新进入阅读层并把卡片置为 ready。 */
async function reopenReaderReady(revision) {
  h.find(row(ID_A), '.feed-read').click();
  await h.waitFor(() => h.find(h.doc.body, '.feed-reader iframe'), '阅读层 iframe 重新挂载');
  const card = h.find(h.doc.body, '.feed-reader .feed-card');
  fireIntersection(card);
  const iframe = h.find(h.doc.body, '.feed-reader iframe');
  h.fireWindow('message', { source: iframe.contentWindow, data: { __hanaCardHeight: 320 } });
  await h.settle(3);
  assert.equal(row(ID_A).dataset.revision, String(revision), '阅读层对应当前 revision');
  return { card, iframe };
}

/** 已累计一部分阅读时间（<600ms）但尚未结算。 */
async function accumulatePartialDwell(ms = 250) {
  assert.equal(state.signalCalls.length, 0, '开始前不应有阅读信号');
  await h.delay(ms);
  assert.equal(state.signalCalls.length, 0, '不足 600ms 不得结算');
}

test('真实 app 注册 home 入口，登录后角标轻量刷新并在无 session 时转发 feed-changed', async () => {
  assert.ok(feed, 'feed 必须由正式 feature registry 组装');
  const button = feedButton();
  const dock = h.getEl('homeComposerDock');
  assert.ok(button, '日报入口必须挂载');
  assert.equal(button.parentNode, dock, '入口必须挂到输入岛左上沿的局部定位容器');
  assert.ok(button.parentNode.children.indexOf(button) < button.parentNode.children.indexOf(h.getEl('homeComposer')));
  assert.equal(h.getEl('btnRefresh').parentNode, h.getEl('homeHeadActions'), '首页刷新仍留在顶部操作区');
  await feed.refresh();
  await h.waitFor(() => state.slateCalls.length > 0, '登录轻量刷新');
  const before = state.slateCalls.length;
  assert.equal(S.session, null, '此处没有活动聊天会话');
  hana.handleEvent({ type: 'app_event', event: { type: 'feed-changed', reason: 'server' } });
  hana.handleEvent({ type: 'app_event', event: { type: 'feed-changed', reason: 'server-duplicate' } });
  await waitForRequestsToSettle();
  assert.equal(state.slateCalls.length, before + 1, '无 session 的全局事件也应短窗合并后刷新一次');
  assert.equal(entryBadge().textContent, '2');
  assert.equal(entryBadge().hidden, false);
});

test('实际 view action：open/more/favorite/task 走控制器与客户端的正式路由', async () => {
  const openRefreshBefore = state.slateCalls.length;
  feedButton().click();
  await h.waitFor(() => feed.isOpen() && row(ID_A), '日报首屏与 A 条目');
  await h.waitFor(() => state.slateCalls.length === openRefreshBefore + 1, '日报首屏请求发出');
  await h.settle(5);
  assert.equal(h.find(row(ID_A), '.feed-item-title').textContent, '日报 A');
  const stableRow = row(ID_A);
  assert.equal(h.findAll(h.doc.body, 'iframe').length, 0, '列表不挂任何 iframe');
  const changedBefore = state.slateCalls.length;
  hana.handleEvent({ type: 'app_event', event: { type: 'feed-changed', reason: 'open-refresh' } });
  hana.handleEvent({ type: 'app_event', event: { type: 'feed-changed', reason: 'open-duplicate' } });
  await h.waitFor(() => state.slateCalls.length === changedBefore + 1, '打开中的合并刷新请求');
  await h.settle(5);
  assert.equal(row(ID_A), stableRow, '未变revision的刷新不得重建列表行');
  assert.equal(state.cardCalls.length, 0, '列表刷新不取正文');

  h.find(h.doc.body, '.feed-more').click();
  await h.waitFor(() => row(ID_B), '加载更多后的 B 条目');
  assert.equal(state.slateCalls.at(-1).cursor, 'CURSOR-2');

  h.find(row(ID_A), '.feed-favorite').click();
  await h.waitFor(() => state.favoriteCalls.length === 1, '收藏请求');
  await h.waitFor(() => h.find(row(ID_A), '.feed-favorite').textContent === '已收藏', '收藏本地状态');
  await h.waitFor(() => !row(ID_A).classList.contains('is-pending'), '收藏操作结算');
  assert.deepEqual(state.favoriteCalls[0], { clientKind: 'mobile' });

  h.find(row(ID_A), '.feed-task-action').click();
  await h.waitFor(() => state.taskCalls.length === 1, '任务请求');
  await h.waitFor(() => !row(ID_A).classList.contains('is-pending'), '任务操作结算');
  assert.deepEqual(state.taskCalls[0], { clientKind: 'mobile', actionId: 'host-action-42' }, '必须提交宿主 action.id');
  assert.equal(feed.isOpen(), true);
});

test('追问在确认后冻结真实卡片、创建来源 Agent home 会话并只写一条 prepared prompt', async () => {
  h.find(row(ID_A), '.feed-ask-open').click();
  const question = h.find(row(ID_A), '.feed-question-input');
  question.value = '请结合卡片解释';
  h.find(row(ID_A), '.feed-question-send').click();
  await h.waitFor(() => state.createCalls.length === 1, '追问创建 session');
  assert.deepEqual(state.createCalls[0], { agentId: 'agent-1', namespace: 'home' });
  await h.waitFor(() => state.prepareCalls.length === 1, '真实 prepare 快照');
  assert.deepEqual(state.prepareCalls[0], {
    sessionId: 'feed-session-1',
    feedItemId: ID_A,
    revision: 2,
  });
  await h.waitFor(() => S.session?.sessionId === 'feed-session-1', '追问打开的会话');
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '追问 WS');
  const socket = h.MockWebSocket.instances.at(-1);
  socket.open();
  await h.waitFor(() => promptFrames().length === 1, 'prepared prompt 写帧');
  const frame = promptFrames()[0];
  assert.equal(frame.text, '请结合卡片解释');
  assert.equal(frame.feedItemId, ID_A);
  assert.equal(frame.feedRevision, 2);
  assert.equal(frame.displayMessage.feedCard, undefined, '客户端不伪造展示用 feedCard');
  assert.equal(promptFrames().length, 1);
});

test('后台不刷新；前台 focus 与 visibilitychange 短窗只合并一次 refresh', async () => {
  assert.ok(S.principal, '夹具此时仍是已登录身份');
  const before = state.slateCalls.length;
  h.doc.visibilityState = 'hidden';
  h.fireWindow('focus');
  await waitForRequestsToSettle();
  assert.equal(state.slateCalls.length, before, '后台不生成 feed 请求');

  h.doc.visibilityState = 'visible';
  h.fireWindow('focus');
  h.fireDocument('visibilitychange');
  await waitForRequestsToSettle();
  assert.equal(state.slateCalls.length, before + 1, '两个前台入口应被 controller 短窗合并');
});

test('前台刷新：慢刷新先暂停计时，旧revision不发信号；重开阅读层后重新满600ms才结算', async () => {
  await openFeedWithReadyCard(11);
  const oldCard = h.find(h.doc.body, '.feed-reader .feed-card');
  await accumulatePartialDwell(250);

  state.slateDelayMs = 900;
  state.currentRevision = 12;
  const slateBefore = state.slateCalls.length;
  h.fireWindow('focus');
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '前台刷新请求已发出');
  await h.delay(800);
  assert.equal(state.signalCalls.length, 0, '刷新 pending 超过600ms也不得发旧revision的阅读信号');

  await h.waitFor(() => row(ID_A).dataset.revision === '12', '刷新落地新revision');
  await h.settle(4);
  // 版本漂移必须释放旧阅读层，不能拿旧版本继续。
  assert.equal(h.find(h.doc.body, '.feed-reader').hidden, true, 'revision 漂移退出阅读层');
  assert.notEqual(h.find(h.doc.body, '.feed-reader .feed-card'), oldCard, '旧阅读卡片已释放');
  assert.equal(state.signalCalls.length, 0, '新卡未 ready/相交前不得结算');

  // 新结果：重新打开阅读层 + 重新相交 + 上报高度，必须重新完整累计 600ms
  await reopenReaderReady(12);
  await h.delay(350);
  assert.equal(state.signalCalls.length, 0, '新卡 ready 不足600ms不得结算');
  await h.waitFor(() => state.signalCalls.length === 1, '新卡满600ms后结算一次', 2500);
  assert.equal(state.signalCalls.length, 1, '整轮刷新只允许一次结算');
  assert.deepEqual(state.signalCalls[0].signals.map((s) => s.type), ['impression', 'dwell']);
  assert.equal(state.signalCalls[0].signals[1].value >= 600, true);
  await h.delay(300);
  assert.equal(state.signalCalls.length, 1, '同一 revision 只结算一次');
  feed.close();
  state.slateDelayMs = 0;
});

test('面板手动刷新：同样暂停→等待完成→恢复，慢刷新期间不发旧信号', async () => {
  await openFeedWithReadyCard(13);
  await accumulatePartialDwell(250);

  state.slateDelayMs = 900;
  state.currentRevision = 14;
  const slateBefore = state.slateCalls.length;
  h.find(h.doc.body, '.feed-refresh').click();
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '面板刷新请求已发出');
  await h.delay(800);
  assert.equal(state.signalCalls.length, 0, '手动刷新 pending 超过600ms也不得发旧revision信号');

  await h.waitFor(() => row(ID_A).dataset.revision === '14', '手动刷新落地新revision');
  await h.settle(4);
  assert.equal(h.find(h.doc.body, '.feed-reader').hidden, true, 'revision 漂移退出阅读层');

  await reopenReaderReady(14);
  await h.delay(350);
  assert.equal(state.signalCalls.length, 0, '新卡 ready 不足600ms不得结算');
  await h.waitFor(() => state.signalCalls.length === 1, '新卡满600ms后结算一次', 2500);
  assert.deepEqual(state.signalCalls[0].signals.map((s) => s.type), ['impression', 'dwell']);
  feed.close();
  state.slateDelayMs = 0;
});

test('重叠刷新：陈旧的丢弃请求先完成也不得恢复计时，当前请求在途时0信号', async () => {
  await openFeedWithReadyCard(21);
  await accumulatePartialDwell(250);

  const base = state.slateCalls.length;
  // 前台 refresh 只排 250ms 窗口；用户立刻手动刷新先发出请求 M（400ms），
  // 窗口到期后另发 A（1200ms）并抬高新 listToken；M 先返回且被 controller 丢弃。
  state.slateDelayFor = (index) => (index === base + 1 ? 400 : index === base + 2 ? 1200 : 0);
  state.currentRevision = 22;
  h.fireWindow('focus');
  h.find(h.doc.body, '.feed-refresh').click();
  await h.waitFor(() => state.slateCalls.length === base + 2, '两个刷新请求错时发出', 2500);
  await h.delay(900);
  assert.equal(state.signalCalls.length, 0, '被丢弃的旧请求完成后不得恢复旧卡计时');
  assert.equal(row(ID_A).dataset.revision, '21', '被丢弃的请求不得落地');

  await h.waitFor(() => row(ID_A).dataset.revision === '22', '当前请求落地新revision', 3000);
  await h.settle(4);
  assert.equal(state.signalCalls.length, 0, '新卡未 ready/相交前不得结算');

  await reopenReaderReady(22);
  await h.delay(350);
  assert.equal(state.signalCalls.length, 0, '新卡 ready 不足600ms不得结算');
  await h.waitFor(() => state.signalCalls.length === 1, '新卡满600ms后结算一次', 2500);
  assert.deepEqual(state.signalCalls[0].signals.map((s) => s.type), ['impression', 'dwell']);
  await h.delay(300);
  assert.equal(state.signalCalls.length, 1, '整轮错时刷新只结算一次');
  feed.close();
  state.slateDelayMs = 0;
  state.slateDelayFor = null;
});

test('刷新pending期间关闭或登出，完成后不得恢复阅读计时', async () => {
  await openFeedWithReadyCard(15);
  await accumulatePartialDwell(200);
  state.slateDelayMs = 900;
  state.currentRevision = 16;
  let slateBefore = state.slateCalls.length;
  h.find(h.doc.body, '.feed-refresh').click();
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '关闭前的慢刷新已发出');
  feed.close();
  assert.equal(feed.isOpen(), false, '面板已关闭');
  await h.delay(1300);
  assert.equal(state.signalCalls.length, 0, '关闭后的迟到刷新不得恢复计时或发信号');

  // 登出：app 的清理顺序是身份置空 + feed.reset()。
  await openFeedWithReadyCard(17);
  await accumulatePartialDwell(200);
  const owner = S.principal;
  state.slateDelayMs = 900;
  state.currentRevision = 18;
  slateBefore = state.slateCalls.length;
  h.fireWindow('focus');
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '登出前的慢刷新已发出');
  S.principal = null;
  feed.reset();
  assert.equal(feed.isOpen(), false, '登出后日报不保留');
  S.principal = owner;
  await h.delay(1300);
  assert.equal(state.signalCalls.length, 0, '登出期间的迟到刷新不得恢复计时或发信号');
  feed.reset();
  state.slateDelayMs = 0;
});

test('隐藏与筛选移除卡片时取消在途 dwell，不发送曝光', async () => {
  await openFeedWithReadyCard(33);
  await accumulatePartialDwell(250);
  const hideBefore = state.hideCalls.length;
  h.find(row(ID_A), '.feed-hide').click();
  await h.waitFor(() => state.hideCalls.length === hideBefore + 1, '隐藏操作已返回');
  await h.waitFor(() => !row(ID_A), '隐藏条目从列表移除');
  await h.delay(450);
  assert.equal(state.signalCalls.length, 0, '隐藏从列表移除的卡不再完成 dwell');

  await openFeedWithReadyCard(34);
  await accumulatePartialDwell(250);
  const slateBefore = state.slateCalls.length;
  const contentLane = h.findAll(h.doc.body, '.feed-lane').find((node) => node.dataset.lane === 'content');
  contentLane.click();
  await h.waitFor(() => state.slateCalls.length === slateBefore + 1, '内容筛选刷新完成');
  await h.waitFor(() => !row(ID_A) && row(ID_B), '筛选从列表移除 A');
  await h.delay(450);
  const allLane = h.findAll(h.doc.body, '.feed-lane').find((node) => node.dataset.lane === 'all');
  allLane.click();
  await h.waitFor(() => row(ID_A), '恢复全部筛选');
  const signalCount = state.signalCalls.length;
  feed.close();
  assert.equal(signalCount, 0, '筛选移除的在途卡不再发送阅读信号');
});

test('native back 一次退提问编辑、再退日报；logout 销毁 view 并清所有问题草稿', async () => {
  assert.equal(feed.isOpen(), false, '已写帧后应回到新会话视图，不保留遮挡面板');
  hana.backToList();
  feedButton().click();
  await h.waitFor(() => feed.isOpen() && row(ID_A), '重新打开日报');
  h.find(row(ID_A), '.feed-ask-open').click();
  const question = h.find(row(ID_A), '.feed-question-input');
  question.value = '未发送草稿';

  assert.equal(h.window.HanaMobile.back(), true);
  assert.equal(feed.isOpen(), true, '第一层返回只退出问题编辑');
  assert.equal(h.find(row(ID_A), '.feed-question').hidden, true);
  assert.equal(h.window.HanaMobile.back(), true);
  assert.equal(feed.isOpen(), false, '第二层返回关闭日报');
  hana.handleEvent({ type: 'app_event', event: { type: 'feed-changed', reason: 'closed-refresh' } });
  await waitForRequestsToSettle();
  assert.equal(h.findAll(h.doc.body, '.feed-item').length, 0, '闭面板刷新只动角标，不重建隐藏卡DOM');

  feedButton().click();
  await h.waitFor(() => feed.isOpen() && row(ID_A), '登出前再次打开');
  h.find(row(ID_A), '.feed-ask-open').click();
  h.find(row(ID_A), '.feed-question-input').value = '登出必须清除';
  // 阅读层也在登出时必须释放：不留 iframe、不留面板。
  h.find(row(ID_A), '.feed-read').click();
  assert.equal(h.find(h.doc.body, '.feed-reader').hidden, false, '阅读层已打开');
  await h.waitFor(() => h.find(h.doc.body, '.feed-reader iframe'), '阅读层 iframe 挂载');
  assert.equal(await hana.loginController.logout(), true);
  assert.equal(state.logoutCalls, 1);
  assert.equal(feed.isOpen(), false);
  assert.equal(h.find(h.doc.body, '.feed-view'), null, 'logout 应销毁 view，不只隐藏');
  assert.equal(h.find(h.doc.body, '.feed-reader'), null, 'logout 必须释放阅读层');
  assert.equal(h.findAll(h.doc.body, 'iframe').length, 0, 'logout 后不留阅读 iframe');
  assert.equal(entryBadge().hidden, true);
});

test('切换条目取消 create 等待中的 A；迟到创建结果不再启动 prepare', async () => {
  const createGate = deferred();
  const fixture = await createIsolatedQuestionFeature({ createGate });
  const { isolated, feature, calls, row: localRow } = fixture;
  isolated.find(localRow(ID_A), '.feed-ask-open').click();
  isolated.find(localRow(ID_A), '.feed-question-input').value = 'A 的问题';
  isolated.find(localRow(ID_A), '.feed-question-send').click();
  await isolated.waitFor(() => calls.create.length === 1, 'A create 进入受控等待');

  isolated.find(localRow(ID_B), '.feed-ask-open').click();
  const bEditorStayedOpen = !isolated.find(localRow(ID_B), '.feed-question').hidden;
  createGate.resolve();
  await isolated.settle(8);
  const prepareCount = calls.prepare.length;
  feature.dispose();

  assert.equal(bEditorStayedOpen, true, '切换后 B 编辑器应立即打开');
  assert.equal(prepareCount, 0, 'A create 迟到成功不能进入 prepare');
});

test('切换条目使 prepare 等待中的 A 失效，不得打开 session 或发送', async () => {
  const prepareGate = deferred();
  const fixture = await createIsolatedQuestionFeature({ prepareGate });
  const { isolated, feature, calls, row: localRow } = fixture;
  isolated.find(localRow(ID_A), '.feed-ask-open').click();
  isolated.find(localRow(ID_A), '.feed-question-input').value = 'A 的冻结等待';
  isolated.find(localRow(ID_A), '.feed-question-send').click();
  await isolated.waitFor(() => calls.prepare.length === 1, 'A 已进入 prepare 等待');

  isolated.find(localRow(ID_B), '.feed-ask-open').click();
  const bEditorStayedOpen = !isolated.find(localRow(ID_B), '.feed-question').hidden;
  prepareGate.resolve();
  await isolated.settle(8);
  const openedOrSent = calls.open.length > 0 || calls.send.length > 0;
  feature.dispose();

  assert.equal(bEditorStayedOpen, true);
  assert.equal(openedOrSent, false, 'A prepare 迟到结果不能打开追问 session 或进入 sender');
});

test('切换条目使 WS 等待中的 A 失效；迟到 ready 不写帧也不关闭 B', async () => {
  const fixture = await createIsolatedQuestionFeature({ senderMode: 'ws' });
  const { isolated, feature, calls, row: localRow } = fixture;
  isolated.find(localRow(ID_A), '.feed-ask-open').click();
  isolated.find(localRow(ID_A), '.feed-question-input').value = 'A 的 WS 等待';
  isolated.find(localRow(ID_A), '.feed-question-send').click();
  await isolated.waitFor(() => calls.send.length === 1, 'A 等待 fake WS ready');

  isolated.find(localRow(ID_B), '.feed-ask-open').click();
  isolated.find(localRow(ID_B), '.feed-question-input').value = 'B 的草稿';
  const bEditorStayedOpen = !isolated.find(localRow(ID_B), '.feed-question').hidden;
  calls.releaseSend();
  await isolated.settle(8);
  const frameCount = calls.frames.length;
  const bEditorAfterReady = localRow(ID_B) && !isolated.find(localRow(ID_B), '.feed-question').hidden;
  const bDraftAfterReady = localRow(ID_B) && isolated.find(localRow(ID_B), '.feed-question-input').value;
  feature.dispose();

  assert.equal(frameCount, 0, '取消后的迟到 WS ready 不可写 A prompt');
  assert.equal(bEditorStayedOpen, true);
  assert.equal(bEditorAfterReady, true, 'A 的迟到结果不能关闭 B editor/日报');
  assert.equal(bDraftAfterReady, 'B 的草稿', 'A 的迟到结果不能覆盖 B 草稿');
});

test('已写帧后的迟到 SendResult 不关闭 B 编辑器或面板', async () => {
  const fixture = await createIsolatedQuestionFeature({ senderMode: 'written-late' });
  const { isolated, feature, calls, row: localRow } = fixture;
  isolated.find(localRow(ID_A), '.feed-ask-open').click();
  isolated.find(localRow(ID_A), '.feed-question-input').value = 'A 已写帧';
  isolated.find(localRow(ID_A), '.feed-question-send').click();
  await isolated.waitFor(() => calls.frameWasWritten, 'fake sender 越过写帧边界');
  const hasCurrentGuard = typeof calls.send[0]?.isCurrent === 'function';

  isolated.find(localRow(ID_B), '.feed-ask-open').click();
  isolated.find(localRow(ID_B), '.feed-question-input').value = 'B 的独立草稿';
  const bEditorBeforeResult = !isolated.find(localRow(ID_B), '.feed-question').hidden;
  const oldSenderStillCurrent = calls.send[0]?.isCurrent?.() ?? null;
  calls.releaseSend();
  await isolated.settle(8);
  const bEditorAfterResult = localRow(ID_B) && !isolated.find(localRow(ID_B), '.feed-question').hidden;
  const bDraftAfterResult = localRow(ID_B) && isolated.find(localRow(ID_B), '.feed-question-input').value;
  const frameCount = calls.frames.length;
  feature.dispose();

  assert.equal(hasCurrentGuard, true);
  assert.equal(oldSenderStillCurrent, false, '切换编辑器后旧 sender 归属失效');
  assert.equal(calls.frameWasWritten, true, '用例明确覆盖已写帧，不假装可撤回');
  assert.equal(frameCount, 1, '不得回滚或重复已写帧');
  assert.equal(bEditorBeforeResult, true);
  assert.equal(bEditorAfterResult, true, '已写帧的晚结果不能关闭 B editor');
  assert.equal(bDraftAfterResult, 'B 的独立草稿');
});

let failed = 0;
for (const entry of cases) {
  try {
    await entry.fn();
    console.log(`PASS  ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${entry.name}\n      ${error.stack || error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exitCode = 1;
