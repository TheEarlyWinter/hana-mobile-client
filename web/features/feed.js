/* 日报特性只做装配与生命周期协调；wire 规则留在 feed/client 与 controller。 */

import { createFeedClient } from '../feed/client.js';
import { createFeedController } from '../feed/controller.js';
import { createFeedView } from '../feed/view.js';
import { createFeedCards } from '../feed/cards.js';
import { createFeedReadTracker } from '../feed/read-tracker.js';
import { createFeedConversation } from '../feed/conversation.js';

function eventId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // 非安全上下文的 WebView 可能没有 randomUUID，退到短本地 ID。
  }
  return `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {object} [deps]
 * @param {(path:string, init?:object)=>Promise<any>} [deps.api]
 * @param {Document} [deps.document]
 * @param {Window} [deps.window]
 * @param {()=>object|null} [deps.getIdentity]
 * @param {()=>number} [deps.getNavigationEpoch]
 * @param {()=>object|null} [deps.getSession]
 * @param {(session:object)=>Promise<void>} [deps.openSession]
 * @param {(input:{text:string,feed:object,isCurrent:()=>boolean})=>Promise<object>} [deps.sendPrepared]
 * @param {(message:string)=>void} [deps.toast]
 * @param {typeof globalThis.IntersectionObserver} [deps.IntersectionObserver]
 */
export function createFeedFeature({
  api,
  document: doc = globalThis.document,
  window: win = globalThis.window,
  getIdentity,
  getNavigationEpoch,
  getSession,
  openSession,
  sendPrepared,
  toast = () => {},
  IntersectionObserver,
} = {}) {
  if (typeof api !== 'function') throw new TypeError('createFeedFeature 需要 api');
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createFeedFeature 需要 document');
  if (typeof getIdentity !== 'function') throw new TypeError('createFeedFeature 需要 getIdentity');

  let disposed = false;
  let mounted = false;
  let opened = false;
  let button = null;
  let badge = null;
  let view = null;
  let askGeneration = 0;
  /**
   * 当前面板生命周期的暂停组。
   *
   * 前台短窗合并与手动刷新可能同时持有不同请求 Promise（先后完成），所以不能
   * “最后一个 finally 就恢复”；也不能用调用序号（合并窗口让较早的调用实际发请求更晚）。
   * 每次暂停计入同一组，组计数归零且仍是当前面板组才恢复；close/reset 换组，
   * 旧组请求的 finally 只会减旧组计数，永远不会影响重开后的新组。
   */
  let pauseGroup = { pending: 0 };

  const client = createFeedClient({ api });
  let controller = null;
  const readTracker = createFeedReadTracker({
    document: doc,
    IntersectionObserver,
    sendSignals: (signals) => controller.recordSignals(signals),
  });
  const cards = createFeedCards({
    document: doc,
    window: win,
    IntersectionObserver,
    // 只把模板名与 cards 给的失效归属回调交给 client；正文 HTML 与分片规则都在 client 里。
    prepareCard: (item, options) => client.card(item.itemId, item.revision, {
      template: item.template,
      isCurrent: options?.isCurrent,
    }),
    readTracker,
    getIdentity,
  });
  const conversation = createFeedConversation({
    api,
    client,
    getIdentity,
    getNavigationEpoch,
    getSession,
    openSession,
    sendPrepared,
    isActive: () => !disposed && Boolean(getIdentity()),
  });

  function paintBadge(count) {
    if (!badge) return;
    const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
    badge.hidden = value === 0;
    badge.textContent = value > 99 ? '99+' : String(value);
  }

  function onSnapshot(snapshot) {
    paintBadge(snapshot?.unreadTaskCount);
    // 隐藏面板只更新入口角标；绝不重建隐藏卡片/iframe DOM。
    if (snapshot?.open && view && !disposed) view.render(snapshot);
  }

  function makeView() {
    if (view || disposed) return view;
    view = createFeedView({
      document: doc,
      renderCard: (item, context) => cards.render(item, context),
      releaseCard: (node) => cards.release(node),
      onAction: handleAction,
    });
    return view;
  }

  function report(error) {
    const message = typeof error?.message === 'string' && error.message
      ? error.message
      : '日报追问失败，请稍后重试';
    try { toast(message); } catch { /* 提示层失败不能打断日报资源收尾。 */ }
  }

  function cancelAsk() {
    askGeneration += 1;
    conversation.reset();
  }

  async function ask(action) {
    const item = controller.getState().items.find((entry) => entry.itemId === action.itemId);
    if (!item) {
      view?.setQuestionState({ itemId: action.itemId, text: action.text, pending: false, error: '这条日报已不在列表，请刷新后再试' });
      return;
    }
    askGeneration += 1;
    const generation = askGeneration;
    view?.setQuestionState({ itemId: item.itemId, text: action.text, pending: true, error: null });
    const result = await conversation.ask({ item, text: action.text });
    if (disposed || generation !== askGeneration) return;
    if (result.frameWritten) {
      // Conversation 已先记下 frameWritten；之后才允许改提问 UI 或展示 toast。
      if (result.error) report(new Error('追问已发送，但本地显示未完成。请重新进入新会话查看。'));
      close();
      return;
    }
    if (controller.getState().open && view?.isOpen()) {
      view.setQuestionState({
        itemId: item.itemId,
        text: action.text,
        pending: false,
        error: result.error || '追问未发送，请检查连接后手动重试',
      });
    }
  }

  function handleAction(action) {
    if (!action || disposed) return;
    switch (action.type) {
      case 'open':
        void open();
        return;
      case 'close':
        close();
        return;
      case 'refresh':
        // 面板内刷新仍是立即强制刷新，但同样要暂停/恢复阅读计时。
        void refreshNow();
        return;
      case 'more':
        void controller.loadMore();
        return;
      case 'lane':
        void controller.setLane(action.value);
        return;
      case 'favorite':
        void controller.setFavorite(action.itemId, action.value);
        return;
      case 'hide':
        void controller.hide(action.itemId);
        return;
      case 'task':
        void controller.resolveTask(action.itemId, action.actionId);
        return;
      case 'less-like':
        void client.signals([{
          eventId: eventId(),
          itemId: action.itemId,
          type: 'less_like_this',
          at: new Date().toISOString(),
        }]).catch(report);
        return;
      case 'ask':
        void ask(action).catch(report);
        return;
      case 'ask-cancel':
        cancelAsk();
        return;
      case 'explain':
        return;
      default:
        return;
    }
  }

  controller = createFeedController({
    client,
    getIdentity,
    onChange: onSnapshot,
  });

  function mount() {
    if (mounted || disposed) return;
    const holder = doc.getElementById?.('homeComposerDock');
    const anchor = doc.getElementById?.('homeComposer');
    if (!holder || typeof doc.createElement !== 'function') return;

    button = doc.createElement('button');
    button.id = 'btnFeed';
    button.type = 'button';
    button.className = 'icon-btn liquid-btn feed-entry';
    button.title = '打开手机日报';
    button.setAttribute('aria-label', '打开手机日报');
    const label = doc.createElement('span');
    label.className = 'feed-entry-label';
    label.textContent = '日报';
    badge = doc.createElement('span');
    badge.className = 'feed-badge feed-entry-badge';
    badge.textContent = '0';
    badge.hidden = true;
    const newsWindow = doc.createElement('span');
    newsWindow.className = 'feed-entry-window';
    newsWindow.setAttribute('aria-hidden', 'true');
    button.appendChild(label);
    button.appendChild(badge);
    button.appendChild(newsWindow);
    button.addEventListener('click', () => { void open(); });
    if (anchor && anchor.parentNode === holder) holder.insertBefore(button, anchor);
    else holder.appendChild(button);
    mounted = true;
  }

  function open() {
    if (disposed) return Promise.resolve();
    opened = true;
    makeView()?.open();
    readTracker.setActive(true);
    return controller.open();
  }

  function close() {
    if (disposed) return;
    opened = false;
    // 换组：旧组在途刷新的 finally 不得恢复重开后面板的计时。
    pauseGroup = { pending: 0 };
    cancelAsk();
    view?.close();
    cards.reset();
    readTracker.setActive(false);
    controller.close();
  }

  function back() {
    if (!opened || !view?.isOpen()) return false;
    view.back();
    return true;
  }

  /**
   * 刷新期间暂停阅读计时，刷完再恢复。
   *
   * 阅读信号不带 revision：如果旧卡在刷新 pending 时满 600ms 结算，宿主会把这份
   * 停留算到刷新后的新 revision 上。所以前台/面板刷新和 feed-changed 都走这一条：
   * 暂停 → 等刷新真正完成（含新卡片重建）→ 核身份与面板状态 → 恢复计时。
   */
  async function withPausedReading(run) {
    const group = pauseGroup;
    const identity = getIdentity();
    const paused = opened && Boolean(view?.isOpen()) && !disposed;
    if (paused) {
      group.pending += 1;
      readTracker.setActive(false);
    }
    try {
      return await run();
    } finally {
      if (paused) {
        group.pending -= 1;
        if (
          group === pauseGroup &&
          group.pending === 0 &&
          !disposed &&
          identity === getIdentity() &&
          opened &&
          view?.isOpen() &&
          controller.getState().open
        ) {
          // 恢复后 tracker 从 0 重新计时：当前卡仍要重新满 600ms 才结算。
          readTracker.setActive(true);
        }
      }
    }
  }

  function refresh() {
    if (disposed || !getIdentity() || doc.visibilityState === 'hidden') return Promise.resolve();
    // 登录 / 前台 / 全局变更共用 controller 的短窗口合并。
    return withPausedReading(() => controller.onChanged());
  }

  /** 用户手动刷新：保留立即强制刷新语义，不走 250ms 合并窗口。 */
  function refreshNow() {
    if (disposed || !getIdentity() || doc.visibilityState === 'hidden') return Promise.resolve();
    return withPausedReading(() => controller.refresh());
  }

  function onChanged() {
    if (disposed) return Promise.resolve();
    return withPausedReading(() => controller.onChanged());
  }

  function reset() {
    // 登出/销毁同样是新生命周期：旧暂停组整体作废。
    pauseGroup = { pending: 0 };
    cancelAsk();
    opened = false;
    controller.reset();
    cards.reset();
    readTracker.reset();
    if (view) {
      view.destroy();
      view = null;
    }
    paintBadge(0);
  }

  function dispose() {
    if (disposed) return;
    reset();
    disposed = true;
    cards.destroy();
    readTracker.destroy();
    if (button) button.remove();
    button = null;
    badge = null;
    mounted = false;
  }

  return {
    mount,
    open,
    close,
    back,
    isOpen: () => opened,
    refresh,
    onChanged,
    reset,
    dispose,
  };
}
