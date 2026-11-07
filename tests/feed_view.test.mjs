/* web/feed/view.js + cards.js 界面契约测试
 *
 * 用 tests/support/app_harness.mjs 的 createHarness() 直接给 doc/window/makeNode，
 * 不加载 web/app.js、不开真实浏览器、不请求网络。覆盖：
 * - view：文本只走 textContent、条目行复用不重铸卡片、任务 action.id、edit 映射本地
 *   问题编辑、确认才 ask、返回先 ask-cancel 再 close、关闭再开重建卡片、错误/空态、
 *   更多/筛选/pending、恶意标题不执行 HTML、destroy。
 * - cards：IO 触发前不铸卡、同 item 并发只请求一次、沙箱与高度消息来源校验、
 *   无 documentPath/准备或首高度超时可重试、reset 释放 observer/监听、缺少
 *   IntersectionObserver 不崩不自动加载。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createFeedView } from '../web/feed/view.js';
import { createFeedCards } from '../web/feed/cards.js';

const ID_A = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'fi_ZYXWVTSRQPNMKJHGFEDCBA9876';
const ID_C = 'fi_0123456789ABCDEFGHJKMNPQRT';
const IDENTITY = { ownerId: 'owner-1', deviceId: 'dev-1', clientKind: 'mobile' };
const ISO = '2026-11-05T09:00:00.000Z';

let bad = 0;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function createTimeoutClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function makeItem(itemId, extra = {}) {
  return {
    itemId,
    revision: 1,
    lane: 'task',
    laneKind: 'task',
    template: 'folio-card',
    title: `标题-${itemId.slice(-1)}`,
    ask: '要跟进这件事吗？',
    topics: ['工作'],
    source: { sourceId: 'src-1', displayName: '日报助手' },
    createdAt: ISO,
    unread: true,
    favorite: false,
    ...extra,
  };
}

function snapshot(items, extra = {}) {
  return {
    open: true,
    loading: false,
    loadingMore: false,
    error: null,
    items,
    cursor: null,
    slateId: 'slate-1',
    unreadTaskCount: 0,
    nextPatrolAt: null,
    lane: 'all',
    pendingIds: [],
    ...extra,
  };
}

function setupView({ releaseCard } = {}) {
  const h = createHarness({ debug: false });
  const actions = [];
  const cardCalls = [];
  const releaseCalls = [];
  const view = createFeedView({
    document: h.doc,
    onAction: (action) => actions.push(action),
    releaseCard: releaseCard || ((node) => releaseCalls.push(node)),
    renderCard: (item, context) => {
      cardCalls.push({ item, context });
      const node = h.makeNode('div');
      node.className = 'fake-card';
      node.dataset.itemId = item.itemId;
      node.textContent = `card:${item.itemId}:${item.revision}`;
      return node;
    },
  });
  return { h, view, actions, cardCalls, releaseCalls };
}

function panelOf(h) {
  return h.find(h.doc.body, '.feed-view');
}

function rowOf(h, itemId) {
  return h.findAll(h.doc.body, '.feed-item').find((row) => row.dataset.itemId === itemId);
}

function buttonByText(h, row, selector, text) {
  return h.findAll(row, selector).find((node) => node.textContent === text);
}

/* ---- view 基础 ---- */

t('render：列表只给元数据与阅读入口，不铸任何卡片；render 本身不派发动作', () => {
  const { h, view, actions, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)], { unreadTaskCount: 3 }));

  const rows = h.findAll(h.doc.body, '.feed-item');
  assert.equal(rows.length, 2);
  assert.equal(h.find(rowOf(h, ID_A), '.feed-item-title').textContent, '标题-S');
  assert.equal(h.find(panelOf(h), '.feed-badge').textContent, '3');
  assert.equal(h.find(panelOf(h), '.feed-badge').hidden, false);
  // 列表零卡片：不调 renderCard、不留 iframe，避免进列表就批量取正文。
  assert.equal(cardCalls.length, 0, '列表阶段不得请求任何卡片正文');
  assert.equal(h.findAll(h.doc.body, '.feed-card').length, 0);
  assert.equal(h.findAll(h.doc.body, 'iframe').length, 0);
  assert.equal(actions.length, 0, 'imperative render/open 不反向派发动作');
  assert.ok(h.find(rowOf(h, ID_A), '.feed-item-title-btn'), '标题仍是可点开的按钮');
  assert.ok(h.find(rowOf(h, ID_A), '.feed-read'), '每条都有阅读全文按钮');
  assert.ok(h.find(rowOf(h, ID_A), '.feed-item-meta').textContent.includes('日报助手'));
  view.destroy();
});

t('恶意 title 只走 textContent，不产生 HTML 节点', () => {
  const { h, view } = setupView();
  const evil = '<img src=x onerror="window.__pwned=1">今天';
  view.open();
  view.render(snapshot([makeItem(ID_A, { title: evil })]));

  const title = h.find(rowOf(h, ID_A), '.feed-item-title');
  assert.equal(title.textContent, evil);
  assert.equal(h.findAll(h.doc.body, 'img').length, 0, '不能解析出 img');
  assert.equal(h.window.__pwned, undefined);
  view.destroy();
});

t('收藏更新：同一 revision 复用行节点，不重建列表、不产生卡片', () => {
  const { h, view, actions, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  const firstRow = rowOf(h, ID_A);
  const firstTitle = h.find(firstRow, '.feed-item-title');
  assert.equal(cardCalls.length, 0);

  const favorite = h.find(rowOf(h, ID_A), '.feed-favorite');
  assert.equal(favorite.textContent, '收藏');
  favorite.click();
  assert.deepEqual(actions[0], { type: 'favorite', itemId: ID_A, value: true });

  actions.length = 0;
  view.render(snapshot([makeItem(ID_A, { favorite: true }), makeItem(ID_B)]));
  assert.equal(cardCalls.length, 0, '收藏更新不请求卡片');
  assert.equal(rowOf(h, ID_A), firstRow, '行节点保持同一个');
  assert.equal(h.find(rowOf(h, ID_A), '.feed-item-title'), firstTitle);
  assert.equal(h.find(rowOf(h, ID_A), '.feed-favorite').textContent, '已收藏');
  assert.equal(actions.length, 0);
  view.destroy();
});

t('revision 变化只替换行节点，不请求正文', () => {
  const { h, view, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  const oldRow = rowOf(h, ID_A);
  assert.equal(cardCalls.length, 0);

  view.render(snapshot([makeItem(ID_A, { revision: 2 })]));
  assert.equal(cardCalls.length, 0, '换版本也不在列表里取正文');
  assert.notEqual(rowOf(h, ID_A), oldRow, '换版本重建行');
  assert.equal(h.find(rowOf(h, ID_A), '.feed-item-title').textContent, '标题-S');
  view.destroy();
});

/* ---- 任务与问题编辑 ---- */

t('任务按钮：confirm/dismiss 传实际 action.id，未知 kind 明确不可用', () => {
  const { h, view, actions } = setupView();
  const item = makeItem(ID_A, {
    task: {
      state: 'pending',
      actions: [
        { id: 'act-done', kind: 'confirm', label: '完成' },
        { id: 'act-drop', kind: 'dismiss', label: '忽略' },
        { id: 'act-snooze', kind: 'snooze', label: '明天再说' },
      ],
    },
  });
  view.open();
  view.render(snapshot([item]));
  const row = rowOf(h, ID_A);

  buttonByText(h, row, '.feed-task-action', '完成').click();
  assert.deepEqual(actions[0], { type: 'task', itemId: ID_A, actionId: 'act-done' });
  assert.equal('value' in actions[0], false);
  assert.equal('kind' in actions[0], false);

  actions.length = 0;
  const unsupported = buttonByText(h, row, '.feed-task-action', '明天再说');
  assert.equal(unsupported.disabled, true);
  unsupported.click();
  assert.equal(actions.length, 0, '未识别的 kind 不猜语义、不发动作');

  buttonByText(h, row, '.feed-task-action', '忽略').click();
  assert.deepEqual(actions[0], { type: 'task', itemId: ID_A, actionId: 'act-drop' });
  view.destroy();
});

t('edit 动作只打开本地问题编辑，确认后才发 ask，不发 task', () => {
  const { h, view, actions } = setupView();
  const item = makeItem(ID_A, {
    task: {
      state: 'pending',
      actions: [
        { id: 'act-edit', kind: 'edit', label: '改写' },
        { id: 'act-done', kind: 'confirm', label: '完成' },
      ],
    },
  });
  view.open();
  view.render(snapshot([item]));
  const row = rowOf(h, ID_A);
  const question = h.find(row, '.feed-question');
  assert.equal(question.hidden, true);

  buttonByText(h, row, '.feed-task-action', '改写').click();
  assert.equal(question.hidden, false, 'edit 打开条目内问题编辑');
  assert.equal(actions.length, 0, '只打开编辑，不提交 task，也不自动 ask');

  const input = h.find(row, '.feed-question-input');
  assert.equal(input.value, item.ask);
  input.value = '帮我把这条改短一点';
  h.find(row, '.feed-question-send').click();
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { type: 'ask', itemId: ID_A, text: '帮我把这条改短一点' });
  assert.equal(input.disabled, true, '确认发送后立即锁定问题输入框');
  assert.equal(actions.some((action) => action.type === 'task'), false);

  actions.length = 0;
  h.find(row, '.feed-question-send').click();
  assert.equal(actions.length, 0, '发送后本地单飞，等待 feature 回传状态');

  view.setQuestionState({ itemId: ID_A, text: '帮我把这条改短一点', pending: true });
  assert.equal(h.find(row, '.feed-question-send').disabled, true);
  assert.equal(h.find(row, '.feed-question-send').textContent, '发送中…');

  view.setQuestionState({ itemId: ID_A, text: '帮我把这条改短一点', pending: false, error: '网络没通，先留着问题' });
  assert.equal(h.find(row, '.feed-question-send').disabled, false);
  assert.equal(input.disabled, false, '失败后重新允许编辑');
  assert.equal(h.find(row, '.feed-question-error').textContent, '网络没通，先留着问题');
  assert.equal(h.find(row, '.feed-question-error').hidden, false);
  assert.equal(input.value, '帮我把这条改短一点', '失败保留问题');
  view.destroy();
});

t('切换、移除或换 revision 时取消旧追问且不误取消新编辑器', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));

  h.find(rowOf(h, ID_A), '.feed-ask-open').click();
  h.find(rowOf(h, ID_A), '.feed-question-input').value = 'A 的问题';
  h.find(rowOf(h, ID_A), '.feed-question-send').click();
  view.setQuestionState({ itemId: ID_A, text: 'A 的问题', pending: true });

  h.find(rowOf(h, ID_B), '.feed-ask-open').click();
  assert.deepEqual(actions.map((action) => action.type), ['ask', 'ask-cancel']);
  assert.equal(actions[1].itemId, ID_A, '切换只取消旧 A');
  assert.equal(h.find(rowOf(h, ID_A), '.feed-question').hidden, true);
  assert.equal(h.find(rowOf(h, ID_B), '.feed-question').hidden, false, '新 B 编辑器保持打开');

  view.render(snapshot([makeItem(ID_B, { revision: 2 })]));
  assert.equal(actions.at(-1).type, 'ask-cancel');
  assert.equal(actions.at(-1).itemId, ID_B, '换版本取消旧 B editor');
  h.find(rowOf(h, ID_B), '.feed-ask-open').click();
  view.render(snapshot([]));
  assert.equal(actions.at(-1).type, 'ask-cancel');
  assert.equal(actions.at(-1).itemId, ID_B, '移除当前行取消对应 editor');
  view.destroy();
});

t('移除、替换、关闭和销毁行不产生卡片释放（列表没有卡片）', () => {
  const { h, view, releaseCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  const firstA = rowOf(h, ID_A);

  view.render(snapshot([makeItem(ID_A, { revision: 2 })]));
  assert.equal(releaseCalls.length, 0, '换版本与移除行都不需要释放卡片');
  assert.notEqual(rowOf(h, ID_A), firstA);

  view.close();
  assert.equal(releaseCalls.length, 0, '关闭列表不释放卡片');
  assert.equal(h.findAll(h.doc.body, '.feed-item').length, 0, '关闭仍清空旧行');

  view.open();
  view.render(snapshot([makeItem(ID_A, { revision: 2 })]));
  view.destroy();
  assert.equal(releaseCalls.length, 0, 'destroy 也不留列表卡片需要释放');
});

t('继续聊：没有 task 也能打开问题编辑；空问题本地拦截', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A, { ask: '' })]));
  const row = rowOf(h, ID_A);
  h.find(row, '.feed-ask-open').click();
  assert.equal(h.find(row, '.feed-question').hidden, false);
  assert.equal(actions.length, 0);

  h.find(row, '.feed-question-send').click();
  assert.equal(actions.length, 0, '空问题不发送');
  assert.equal(h.find(row, '.feed-question-error').hidden, false);

  h.find(row, '.feed-question-input').value = '今天有什么变化？';
  h.find(row, '.feed-question-send').click();
  assert.deepEqual(actions[0], { type: 'ask', itemId: ID_A, text: '今天有什么变化？' });
  view.destroy();
});

t('back：第一次只关编辑，第二次才关日报', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  const row = rowOf(h, ID_A);
  h.find(row, '.feed-ask-open').click();
  actions.length = 0;

  view.back();
  assert.deepEqual(actions.map((action) => action.type), ['ask-cancel']);
  assert.equal(actions[0].itemId, ID_A);
  assert.equal(h.find(row, '.feed-question').hidden, true);
  assert.equal(view.isOpen(), true);
  assert.equal(panelOf(h).hidden, false);

  view.back();
  assert.deepEqual(actions.map((action) => action.type), ['ask-cancel', 'close']);
  assert.equal(view.isOpen(), false);
  assert.equal(panelOf(h).hidden, true);
  view.destroy();
});

t('back 没有编辑器时只发 close', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  actions.length = 0;
  view.back();
  assert.deepEqual(actions.map((action) => action.type), ['close']);
  view.destroy();
});

t('顶栏返回按钮 click 调用既有 back 并关闭日报', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  actions.length = 0;
  const backButton = h.find(panelOf(h), '.feed-back');

  assert.ok(backButton, '顶栏应存在真实返回按钮');
  assert.doesNotThrow(() => backButton.click(), '点击顶栏返回不能抛错');
  assert.equal(view.isOpen(), false, '实际按钮 click 应关闭日报');
  assert.equal(panelOf(h).hidden, true);
  assert.deepEqual(actions.map((action) => action.type), ['close']);
  view.destroy();
});

/* ---- 关闭再开与状态 ---- */

t('imperative close/open 不发动作；关闭清空旧行，重开后重建行但仍不取正文', () => {
  const { h, view, actions, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  const oldRow = rowOf(h, ID_A);
  actions.length = 0;

  view.close();
  assert.equal(actions.length, 0, 'imperative close 不派发 close/ask-cancel');
  assert.equal(view.isOpen(), false);
  assert.equal(h.findAll(h.doc.body, '.feed-item').length, 0, '关闭释放旧行');
  assert.equal(panelOf(h).hidden, true);

  view.open();
  assert.equal(actions.length, 0, 'imperative open 也不派发动作');
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  assert.equal(cardCalls.length, 0, '重新打开也不在列表里取正文');
  assert.notEqual(rowOf(h, ID_A), oldRow, '不能复用已释放的旧行节点');
  view.destroy();
});

t('加载、错误与空列表是不同界面；401 文案不显示成没有日报', () => {
  const { h, view, actions } = setupView();
  view.open();

  view.render(snapshot([], { loading: true }));
  assert.equal(h.find(panelOf(h), '.feed-loading').hidden, false);
  assert.equal(h.find(panelOf(h), '.feed-empty').hidden, true);
  assert.equal(h.find(panelOf(h), '.feed-error').hidden, true);

  view.render(snapshot([], { error: { code: 'feed_unauthorized', message: '登录已过期，请重新登录' } }));
  const errorBox = h.find(panelOf(h), '.feed-error');
  assert.equal(errorBox.hidden, false);
  assert.equal(h.find(errorBox, '.feed-state-text').textContent, '登录已过期，请重新登录');
  assert.equal(h.find(panelOf(h), '.feed-empty').hidden, true, '错误不能伪装成空列表');
  h.find(errorBox, '.feed-retry').click();
  assert.deepEqual(actions[0], { type: 'refresh' });

  actions.length = 0;
  view.render(snapshot([]));
  assert.equal(h.find(panelOf(h), '.feed-empty').hidden, false);
  assert.equal(h.find(panelOf(h), '.feed-error').hidden, true);
  assert.equal(h.find(panelOf(h), '.feed-empty').textContent.includes('还没有日报'), true);
  view.destroy();
});

t('错误但已有条目：保留列表并显示可重试提示', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)], { error: { code: 'feed_network', message: '刷新失败' } }));
  assert.equal(h.findAll(h.doc.body, '.feed-item').length, 1);
  assert.equal(h.find(panelOf(h), '.feed-error').hidden, false);
  h.find(panelOf(h), '.feed-retry').click();
  assert.deepEqual(actions[0], { type: 'refresh' });
  view.destroy();
});

t('更多、筛选与 pending 状态', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)], { cursor: 'CUR-2' }));
  const more = h.find(panelOf(h), '.feed-more');
  assert.equal(more.hidden, false);
  more.click();
  assert.deepEqual(actions[0], { type: 'more' });

  const lane = h.findAll(panelOf(h), '.feed-lane').find((node) => node.dataset.lane === 'task');
  lane.click();
  assert.deepEqual(actions[1], { type: 'lane', value: 'task' });

  view.render(snapshot([makeItem(ID_A)], { lane: 'task', loadingMore: true, cursor: 'CUR-2' }));
  assert.equal(more.disabled, true);
  assert.equal(more.textContent, '加载中…');
  assert.equal(lane.classList.contains('is-active'), true);

  view.render(snapshot([makeItem(ID_A)], { pendingIds: [ID_A] }));
  const row = rowOf(h, ID_A);
  assert.equal(h.find(row, '.feed-favorite').disabled, true);
  assert.equal(h.find(row, '.feed-hide').disabled, true);
  assert.equal(h.find(row, '.feed-ask-open').disabled, true);
  actions.length = 0;
  h.find(row, '.feed-favorite').click();
  assert.equal(actions.length, 0, 'pending 条目不能再提交');
  view.destroy();
});

t('destroy 释放面板；来源缺 agentId 不崩也不静默换人', () => {
  const { h, view } = setupView();
  view.open();
  view.render(snapshot([
    makeItem(ID_A, { source: { sourceId: 'src-1', displayName: '没有 Agent 的来源' } }),
  ]));
  assert.ok(h.find(rowOf(h, ID_A), '.feed-item-meta').textContent.includes('没有 Agent 的来源'));
  view.destroy();
  assert.equal(panelOf(h), null);
  assert.equal(view.isOpen(), false);
});

/* ---- cards ---- */

function setupCards({ timeoutMs = 25, ioClass, clock = null } = {}) {
  const h = createHarness({ debug: false });
  const makeNode = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const node = makeNode(tag);
    if (String(tag).toLowerCase() === 'iframe') {
      let contentWindow = null;
      // 模拟真实 iframe：进入文档前 contentWindow 为 null，进入后才有 WindowProxy。
      Object.defineProperty(node, 'contentWindow', {
        configurable: true,
        get() {
          if (!node.parentNode) return null;
          if (!contentWindow) contentWindow = { postMessage() {} };
          return contentWindow;
        },
      });
    }
    return node;
  };

  const ioInstances = [];
  class FakeIO {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.disconnected = false;
      ioInstances.push(this);
    }

    observe(element) {
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }

    fire(entries) {
      this.callback(entries.map(([target, ratio]) => ({
        target,
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
      })));
    }
  }

  const prepares = [];
  let prepImpl = (item) => ({
    cardId: 'card-1',
    revision: item.revision,
    url: `/gw/feed/${item.itemId}/r${item.revision}/`,
  });
  const errors = [];
  const observed = [];
  const ready = [];
  const unobserved = [];
  const readTracker = {
    observe(element, item, context) {
      observed.push({ element, item, context });
    },
    unobserve(element) {
      unobserved.push(element);
    },
    markReady(itemId, revision) {
      ready.push([itemId, revision]);
    },
    setActive() {},
    reset() {},
    destroy() {},
  };

  const Observer = ioClass === undefined ? FakeIO : ioClass;
  const options = {
    document: h.doc,
    window: h.window,
    prepareCard: (item) => {
      prepares.push(item);
      return prepImpl(item);
    },
    readTracker,
    getIdentity: () => IDENTITY,
    onError: (err) => errors.push(err),
    timeoutMs,
  };
  if (Observer !== undefined) options.IntersectionObserver = Observer;
  if (clock) {
    options.setTimeout = clock.setTimeout;
    options.clearTimeout = clock.clearTimeout;
  }
  const cards = createFeedCards(options);

  return {
    h,
    cards,
    prepares,
    errors,
    observed,
    unobserved,
    ready,
    ioInstances,
    lastIO: () => ioInstances[ioInstances.length - 1],
    setPrepare: (fn) => {
      prepImpl = fn;
    },
  };
}

function mountCard(s, item = makeItem(ID_A)) {
  const node = s.cards.render(item, { slateId: 'slate-1', position: 0 });
  s.h.doc.body.appendChild(node);
  return node;
}

t('cards：IO 触发前不铸卡；沙箱、登记来源后才收高度并 markReady', async () => {
  const s = setupCards();
  const node = mountCard(s);
  assert.equal(s.prepares.length, 0, 'IO 触发前不请求卡片');
  assert.equal(s.h.find(node, '.feed-card-frame'), null);
  assert.equal(s.observed.length, 1);
  assert.deepEqual(s.observed[0].context, { slateId: 'slate-1', position: 0 });

  s.lastIO().fire([[node, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1);
  const frame = s.h.find(node, '.feed-card-frame');
  assert.ok(frame, '准备成功后挂 iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(String(frame.getAttribute('sandbox')).includes('allow-same-origin'), false);
  assert.equal(frame.getAttribute('allow'), null);
  assert.equal(frame.src, `/gw/feed/${ID_A}/r1/`);
  assert.equal(s.ready.length, 0, '没有有效高度前不能算 ready');

  s.h.fireWindow('message', { data: { __hanaCardHeight: 240 }, source: frame.contentWindow });
  assert.equal(frame.style.height, '240px');
  assert.deepEqual(s.ready, [[ID_A, 1]]);

  s.h.fireWindow('message', { data: { __hanaCardHeight: 320 }, source: frame.contentWindow });
  assert.equal(frame.style.height, '320px');
  assert.equal(s.ready.length, 1, '同一卡片只 markReady 一次');

  s.h.fireWindow('message', { data: { __hanaCardHeight: 999 }, source: { other: true } });
  assert.equal(frame.style.height, '320px', '不接收陌生来源的高度');
  s.h.fireWindow('message', { data: { __hanaCardAction: 'open' }, source: frame.contentWindow });
  assert.equal(frame.style.height, '320px', '不接收任意 postMessage 动作');
  s.cards.destroy();
});

t('cards：documentPath 缺失显示可重试错误，重试成功后挂 iframe', async () => {
  const s = setupCards();
  const item = makeItem(ID_A);
  s.setPrepare(() => ({ cardId: 'card-1', revision: item.revision, url: null }));
  const node = mountCard(s, item);
  s.lastIO().fire([[node, 1]]);
  await tick();
  await tick();

  assert.equal(s.h.find(node, '.feed-card-frame'), null, '没有正文不挂白 iframe');
  const error = s.h.find(node, '.feed-card-error');
  assert.ok(error);
  assert.equal(error.textContent.includes('正文'), true);
  const retry = s.h.find(node, '.feed-card-retry');
  assert.ok(retry);

  s.setPrepare(() => ({ cardId: 'card-2', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` }));
  retry.click();
  await tick();
  await tick();
  assert.equal(s.prepares.length, 2);
  assert.ok(s.h.find(node, '.feed-card-frame'));
  s.cards.destroy();
});

t('cards：未知模板/宿主拒绝时显示宿主消息并可重试', async () => {
  const s = setupCards();
  // 原生文档模板（automation-digest）在列表里只给「阅读全文」提示、不铸卡；
  // 这里覆盖其余模板被宿主拒绝时的错误与重试契约。
  const item = makeItem(ID_A, { template: 'plain-note' });
  const err = new Error('该模板暂不支持网页正文');
  err.code = 'feed_card_unsupported';
  s.setPrepare(() => Promise.reject(err));
  const node = mountCard(s, item);
  s.lastIO().fire([[node, 1]]);
  await tick();
  await tick();

  assert.equal(s.h.find(node, '.feed-card-frame'), null);
  assert.equal(s.h.find(node, '.feed-card-error').textContent.includes('该模板暂不支持网页正文'), true);
  assert.ok(s.h.find(node, '.feed-card-retry'));
  assert.equal(s.errors[0].code, 'feed_card_unsupported');
  s.cards.destroy();
});

t('cards：准备超时后重试发起新请求，迟到旧结果不盖新请求', async () => {
  const clock = createTimeoutClock();
  const s = setupCards({ timeoutMs: 15, clock });
  const pending = [];
  s.setPrepare(() => new Promise((resolve) => pending.push(resolve)));
  const item = makeItem(ID_A);
  const first = mountCard(s, item);
  s.lastIO().fire([[first, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1);
  clock.advance(15);
  await tick();
  await tick();

  assert.equal(s.h.find(first, '.feed-card-frame'), null);
  assert.equal(s.h.find(first, '.feed-card-error').textContent.includes('超时'), true);
  assert.equal(s.errors[0].code, 'feed_card_timeout');
  s.h.find(first, '.feed-card-retry').click();
  await tick();
  await tick();
  assert.equal(s.prepares.length, 2, '超时释放旧 inflight 后必须新发请求');

  const second = mountCard(s, item);
  s.lastIO().fire([[second, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 2, '重试的新请求仍按 itemId+revision 合并');

  pending[0]({ cardId: 'old', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` });
  await tick();
  await tick();
  assert.equal(s.h.find(first, '.feed-card-frame'), null, '迟到旧结果不能挂载');
  assert.equal(s.h.find(second, '.feed-card-frame'), null, '旧结果不能盖过新在途请求');

  const third = mountCard(s, item);
  s.lastIO().fire([[third, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 2, '旧结果不能删掉新请求的 inflight 记录');

  pending[1]({ cardId: 'new', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` });
  await tick();
  await tick();
  assert.ok(s.h.find(first, '.feed-card-frame'));
  assert.ok(s.h.find(second, '.feed-card-frame'));
  assert.ok(s.h.find(third, '.feed-card-frame'));
  s.cards.destroy();
});

t('cards：iframe 挂载后首高度超时移除并允许重试', async () => {
  const clock = createTimeoutClock();
  const s = setupCards({ timeoutMs: 15, clock });
  const node = mountCard(s);
  s.lastIO().fire([[node, 1]]);
  await tick();
  await tick();
  const firstFrame = s.h.find(node, '.feed-card-frame');
  assert.ok(firstFrame, '准备完成后 iframe 已挂载');
  const firstSource = firstFrame.contentWindow;
  assert.equal(firstFrame.style.visibility, 'hidden');
  assert.equal(s.ready.length, 0);

  clock.advance(15);
  await tick();
  await tick();
  assert.equal(s.h.find(node, '.feed-card-frame'), null, '高度超时后移除旧 iframe');
  assert.equal(firstFrame.src, 'about:blank');
  assert.equal(s.h.find(node, '.feed-card-error').textContent.includes('超时'), true);
  assert.equal(s.errors[0].code, 'feed_card_height_timeout');
  s.h.fireWindow('message', { data: { __hanaCardHeight: 280 }, source: firstSource });
  assert.equal(s.ready.length, 0, '超时后迟到高度不复活旧 iframe');
  assert.ok(s.h.find(node, '.feed-card-error'), '迟到消息不能清掉可重试错误');

  s.h.find(node, '.feed-card-retry').click();
  await tick();
  await tick();
  const retryFrame = s.h.find(node, '.feed-card-frame');
  assert.ok(retryFrame, '错误状态允许用户重试挂载');
  assert.equal(s.prepares.length, 2);
  s.cards.destroy();
});

t('cards：同一 itemId+revision 并发 render 只发一次准备请求', async () => {
  const s = setupCards();
  const item = makeItem(ID_A);
  let resolvePrepare;
  s.setPrepare(() => new Promise((resolve) => { resolvePrepare = resolve; }));
  const first = mountCard(s, item);
  const second = mountCard(s, item);
  s.lastIO().fire([[first, 1], [second, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1, '在途准备请求按 itemId+revision 合并');

  resolvePrepare({ cardId: 'card-1', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` });
  await tick();
  await tick();
  assert.ok(s.h.find(first, '.feed-card-frame'));
  assert.ok(s.h.find(second, '.feed-card-frame'));
  s.cards.destroy();
});

t('卡片被替换/释放后丢弃 late prepare、height 与 tracker 回调（直接驱动 cards）', async () => {
  const s = setupCards();
  const pending = [];
  s.setPrepare((item) => new Promise((resolve) => pending.push({ item, resolve })));
  const host = s.h.doc.createElement('div');
  host.className = 'feed-reader-body';
  s.h.doc.body.appendChild(host);
  const mount = (revision) => {
    const node = s.cards.render(makeItem(ID_A, { revision }), { mode: 'reader' });
    host.appendChild(node);
    return node;
  };

  const oldCard = mount(1);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1, '旧 revision prepare 已进入受控等待');

  s.cards.release(oldCard);
  assert.ok(s.unobserved.includes(oldCard), '释放时同步 unobserve 旧 tracker target');

  s.setPrepare((item) => ({
    cardId: `card-${item.revision}`,
    revision: item.revision,
    url: `/gw/feed/${item.itemId}/r${item.revision}/`,
  }));
  const currentCard = mount(2);
  await tick();
  await tick();
  const currentFrame = s.h.find(currentCard, '.feed-card-frame');
  assert.ok(currentFrame, '新 revision 可正常挂载');
  const currentSource = currentFrame.contentWindow;
  const currentReadyCount = s.ready.length;

  pending[0].resolve({ cardId: 'late-1', revision: 1, url: `/gw/feed/${ID_A}/r1/` });
  await tick();
  await tick();
  assert.equal(s.h.find(oldCard, '.feed-card-frame'), null, '旧 prepare 结果不能给已释放节点挂 iframe');
  assert.equal(s.prepares.length, 2, '旧结果不能触发新请求');

  s.cards.release(currentCard);
  assert.equal(currentFrame.src, 'about:blank', '释放将旧 iframe 导航到空白页');
  assert.equal(currentFrame.parentNode, null, '旧 iframe 从旧卡 DOM 脱离');
  assert.ok(s.unobserved.includes(currentCard));
  s.h.fireWindow('message', { data: { __hanaCardHeight: 520 }, source: currentSource });
  assert.equal(s.ready.length, currentReadyCount, '旧 frame 的迟到高度不能标记新/旧卡 ready');

  const latest = mount(3);
  await tick();
  await tick();
  assert.ok(s.h.find(latest, '.feed-card-frame'), '释放后可再次正常挂载');
  s.cards.destroy();
});

t('cards：reset 清空在途结果与 observer，旧请求不能重新挂载；destroy 后消息无效', async () => {
  const s = setupCards();
  const item = makeItem(ID_A);
  let resolvePrepare;
  s.setPrepare(() => new Promise((resolve) => { resolvePrepare = resolve; }));
  const node = mountCard(s, item);
  s.lastIO().fire([[node, 1]]);
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1);

  s.cards.reset();
  assert.equal(s.lastIO().disconnected, true, 'reset 断开 observer');
  resolvePrepare({ cardId: 'card-1', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` });
  await tick();
  await tick();
  assert.equal(s.h.find(node, '.feed-card-frame'), null, 'reset 后旧准备结果不能重新挂载');

  s.setPrepare(() => ({ cardId: 'card-2', revision: item.revision, url: `/gw/feed/${ID_A}/r1/` }));
  const fresh = mountCard(s, item);
  s.lastIO().fire([[fresh, 1]]);
  await tick();
  await tick();
  const frame = s.h.find(fresh, '.feed-card-frame');
  assert.ok(frame);
  const frameSource = frame.contentWindow;
  s.cards.reset();
  s.h.fireWindow('message', { data: { __hanaCardHeight: 300 }, source: frameSource });
  assert.equal(frame.style.height, '', 'reset 后不再响应旧 iframe 的高度消息');
  assert.equal(s.ready.length, 0);

  s.cards.destroy();
  s.h.fireWindow('message', { data: { __hanaCardHeight: 400 }, source: frameSource });
  assert.equal(s.ready.length, 0);
});

t('cards：缺少 IntersectionObserver 不崩、不自动加载；用户点重试才请求', async () => {
  const s = setupCards({ ioClass: null });
  const node = mountCard(s);
  assert.equal(s.prepares.length, 0);
  assert.equal(s.h.find(node, '.feed-card-frame'), null);
  const error = s.h.find(node, '.feed-card-error');
  assert.ok(error);
  assert.ok(s.h.find(node, '.feed-card-retry'));

  s.h.find(node, '.feed-card-retry').click();
  await tick();
  await tick();
  assert.equal(s.prepares.length, 1, '重试是用户手势，允许直接准备');
  assert.ok(s.h.find(node, '.feed-card-frame'));
  s.cards.destroy();
});

/* ---- 运行 ---- */

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

if (bad) {
  console.log(`\n${bad} 个用例失败（共 ${tests.length} 个）`);
  process.exitCode = 1;
} else {
  console.log(`\nALL PASS（${tests.length} 个用例）`);
}
