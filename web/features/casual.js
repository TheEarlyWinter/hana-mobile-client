/**
 * 闲聊（Casual Chat）特性。
 *
 * 这一个文件负责闲聊的全部：入口按钮、未读角标、面板、表情包、状态机、WS 事件分流。
 * `app.js` 只做四件事——把依赖传进来、挂一次按钮、把它看到的消息/连接状态转给它，
 * 以及在切助手时通知它。业务逻辑一条都不留在 `app.js`。
 *
 * 依赖全部注入（state / getElement / api / flash / avatarUrl），本模块不 import 应用层任何东西。
 */

import { createCasualClient } from '../casual-client.js';
import { createCasualStore } from '../casual-store.js';
import { createCasualView } from '../casual-view.js';
import { createStickerPanel } from '../casual-stickers.js';

/** WS 连着时的轮询间隔：只做兜底校正，不靠它拿新消息。 */
const POLL_MS_LIVE = 30000;
/** WS 断开时的轮询间隔。 */
const POLL_MS_OFFLINE = 4000;

/**
 * @param {object} deps
 * @param {{currentAgent: object|null, agentName?: string}} deps.state
 * @param {(id: string) => any} deps.getElement
 * @param {(path: string, init?: object) => Promise<any>} deps.api
 * @param {(text: string) => void} deps.flash
 * @param {(agent: object|null) => string|null} deps.avatarUrl
 * @param {Document} deps.document
 */
export function createCasualFeature({ state, getElement, api, flash, avatarUrl, document: doc }) {
  const initialAgentId = state.currentAgent?.id || null;
  const client = createCasualClient({
    request: (path, init) => api(path, init),
    agentId: initialAgentId,
  });

  let badgeEl = null;
  let mounted = false;
  let badgeSeq = 0;

  const view = createCasualView({
    document: doc,
    onSend: (text) => { void store.send(text); },
    onLoadEarlier: () => { void store.loadEarlier(); },
    // 视图传的是条目 id（服务端条目是 sourceEntryId），store 两种都认。
    // 必须把 Promise 递回去：View 要等结果才记账，失败才能重试。
    onMarkRead: (entryId) => store.markReadThrough(entryId),
    onOpenStickers: () => { stickers.open(); },
    onRetry: (entryId) => { void store.retry(entryId); },
    // 返回只关面板不够：还要停轮询，否则后台每 4 秒还在拉。
    onClose: () => close(),
  });

  const stickers = createStickerPanel({
    document: doc,
    // 接口返回 { packs }，面板要数组，在这里解包。
    loadPacks: async () => {
      const res = await client.loadStickerPacks();
      return Array.isArray(res?.packs) ? res.packs : [];
    },
    onPick: (pick) => {
      const sticker = pick && pick.sticker ? pick.sticker : pick;
      if (!sticker || typeof sticker.id !== 'string' || !sticker.id) return;
      void store.send({ stickerId: sticker.id, stickerUrl: sticker.url });
    },
  });

  const store = createCasualStore({
    client,
    onState: (snapshot) => {
      if (!store.isOpen()) {
        updateBadge(snapshot.unread);
      } else {
        hideBadge();
      }
      view.setState({
        agentName: state.currentAgent?.name || state.agentName || 'Hana',
        avatarUrl: avatarUrl(state.currentAgent),
        entries: snapshot.entries,
        hasMore: snapshot.hasMore,
        typing: snapshot.typing,
        unread: snapshot.unread,
        loading: snapshot.loading,
        loadingEarlier: snapshot.loadingEarlier,
        error: snapshot.error ? String(snapshot.error.message || snapshot.error) : null,
      });
    },
  });

  if (initialAgentId) {
    store.setAgentId(initialAgentId);
  }

  function hideBadge() {
    if (!badgeEl) return;
    badgeEl.hidden = true;
    badgeEl.textContent = '';
  }

  function updateBadge(unread) {
    if (!badgeEl) return;
    const n = Number(unread) || 0;
    if (n <= 0) {
      hideBadge();
      return;
    }
    badgeEl.textContent = n > 9 ? '9+' : String(n);
    badgeEl.hidden = false;
  }

  /** 入口按钮上的未读角标：只靠 summary 一个请求，失败就安静隐藏。 */
  async function refreshBadge() {
    const dot = badgeEl;
    const agentId = state.currentAgent?.id;
    if (!dot) return;
    if (!agentId) {
      hideBadge();
      return;
    }
    const mySeq = ++badgeSeq;
    try {
      client.setAgentId(agentId);
      const summary = await client.loadSummary();
      if (mySeq !== badgeSeq || state.currentAgent?.id !== agentId) return;
      if (store.isOpen()) {
        hideBadge();
        return;
      }
      updateBadge(summary?.unread);
    } catch {
      if (mySeq === badgeSeq && state.currentAgent?.id === agentId) {
        hideBadge();
      }
    }
  }

  /** 打开闲聊：先把当前助手同步给数据层，再开视图。 */
  function open() {
    const agentId = state.currentAgent?.id;
    if (!agentId) {
      flash('还没选好助手，稍等再试');
      return;
    }
    if (store.getState().agentId !== agentId) {
      // 换人时旧连接要先收掉，否则旧 agent 的轮询会盖到新界面上
      store.close();
      store.setAgentId(agentId);
    }
    view.open();
    void store.open();
    hideBadge();
  }

  function close() {
    store.close();
    view.close();
  }

  /**
   * 宿主在同一个 WS 上推 casual_* 事件，这里接住并返回 true，调用方就不再往下传。
   * 不是闲聊事件返回 false，让调用方继续走会话路由。
   */
  function handleSocketMessage(ev) {
    if (!ev || typeof ev.type !== 'string' || !ev.type.startsWith('casual_')) return false;
    store.applyEvent(ev);
    return true;
  }

  /**
   * WS 连上时把轮询放宽，断开时收回。
   *
   * 重连后不能只改间隔就完事：断线期间漏掉的推送没人补，面板开着也要等一个 30 秒兜底轮询，
   * 面板关着则根本没有轮询。所以连上时如果面板是开的，立刻对一次账（refresh 自带单飞，
   * 正在加载时直接复用它）。对账没结束前不放宽间隔，避免「刚连上就放宽、账还没对」的窗口。
   */
  function setSocketLive(ready) {
    if (!ready) {
      store.setPollMs(POLL_MS_OFFLINE);
      return;
    }
    if (!store.isOpen()) {
      store.setPollMs(POLL_MS_LIVE);
      return;
    }
    // 对账没成功就不算「已对完账」：保持收紧的间隔，下一轮早点重试。
    store.refresh().then(
      (ok) => store.setPollMs(ok === false ? POLL_MS_OFFLINE : POLL_MS_LIVE),
      () => store.setPollMs(POLL_MS_OFFLINE),
    );
  }

  /** 换助手：视图和轮询先收掉，角标按新助手重拉。 */
  function setAgent() {
    view.close();
    // 旧草稿是写给旧助手的，不能带到新会话里。
    view.reset();
    store.close();
    const agentId = state.currentAgent?.id;
    if (agentId) {
      client.setAgentId(agentId);
      store.setAgentId(agentId);
    }
    void refreshBadge();
  }

  /**
   * 在头部按钮组里插一个闲聊入口。
   * 不写死在 index.html 里，是为了不让布局与这个功能耦合；
   * 容器优先用 #homeHeadActions，没有才退回锚点的父节点（假 DOM / 老页面）。
   */
  function mount() {
    if (mounted) return;
    const anchor = getElement('btnSearch') || getElement('btnRefresh');
    const holder = getElement('homeHeadActions') || (anchor ? anchor.parentNode : null);
    if (!holder || typeof doc.createElement !== 'function') return;

    const btn = doc.createElement('button');
    btn.className = 'icon-btn liquid-btn';
    btn.id = 'btnCasual';
    btn.title = '闲聊';
    btn.setAttribute('aria-label', '闲聊');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-4.5A8 8 0 0 1 12 4a8 8 0 0 1 9 8Z" /></svg>';
    const dot = doc.createElement('span');
    dot.className = 'casual-dot';
    dot.hidden = true;
    // 直接留引用：不靠 querySelector 回查（假 DOM 对隐藏节点的选择行为不一定一致）。
    badgeEl = dot;
    btn.appendChild(dot);
    btn.addEventListener('click', () => open());
    if (anchor && anchor.parentNode === holder) holder.insertBefore(btn, anchor);
    else holder.appendChild(btn);
    mounted = true;
  }

  function back() {
    if (stickers && typeof stickers.isOpen === 'function' && stickers.isOpen()) {
      stickers.close();
      return true;
    }
    if (store.isOpen()) {
      close();
      return true;
    }
    return false;
  }

  function reset() {
    badgeSeq++;
    if (stickers && typeof stickers.reset === 'function') {
      stickers.reset();
    } else if (stickers && typeof stickers.isOpen === 'function' && stickers.isOpen()) {
      stickers.close();
    }
    close();
    hideBadge();
    store.reset?.();
    // 登出后输入框、已读去重、节流都不属于下一段会话。
    view.reset();
  }

  return {
    mount,
    open,
    close,
    reset,
    back,
    isOpen: () => store.isOpen(),
    handleSocketMessage,
    setSocketLive,
    setAgent,
    refreshBadge,
    /** 测试与调试用：拿到底层状态机，不给业务用。 */
    getStore: () => store,
  };
}
