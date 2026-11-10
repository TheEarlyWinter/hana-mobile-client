/* 日报界面：只做 DOM 与用户动作，不发 HTTP。
 *
 * - 服务端文字一律走 textContent，不拼 innerHTML。
 * - 行与卡片按 itemId+revision 保留；收藏/任务更新只改行内状态，不重铸 iframe。
 * - 任务只有 confirm/dismiss 会转成 task 动作并携带宿主 action.id；edit 打开条目内的
 *   问题编辑，用户确认后才发 ask。view 拥有编辑 DOM 与草稿，结果由 feature 回传。
 * - 阅读层是 view 自己的叠层：标题按钮与「阅读全文」打开唯一阅读层，列表 DOM 与滚动位置
 *   不动；返回顺序是提问编辑 → 阅读层 → 日报。“继续聊”先回列表再复用原提问编辑。
 * - imperative 的 open/close/render 不反向派发动作；只有用户手势发 onAction。
 */

/**
 * @typedef {object} FeedViewAction
 * @property {'refresh'|'more'|'lane'|'favorite'|'hide'|'task'|'less-like'|'explain'|'ask'|'ask-cancel'|'close'} type
 * @property {string} [itemId]
 * @property {string|boolean} [value]
 * @property {string} [actionId]
 * @property {string} [text]
 */

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (typeof error.code === 'string' && error.code) return error.code;
  return '日报加载失败';
}

function laneLabel(lane) {
  if (lane === 'task') return '待办';
  if (lane === 'content') return '内容';
  return '';
}

function taskStateLabel(state) {
  if (typeof state !== 'string') return '';
  if (state === 'pending') return '待处理';
  if (state === 'done') return '已完成';
  if (state === 'dismissed') return '已忽略';
  if (state === 'snoozed') return '已延后';
  return state;
}

/**
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {(action: FeedViewAction) => void} [options.onAction]
 * @param {(item: import('./client.js').FeedItem, context: {slateId:string|null, position:number, mode?:'list'|'reader'}) => Node} [options.renderCard]
 * @param {(node: Node) => void} [options.releaseCard]
 */
export function createFeedView({
  document: doc = globalThis.document,
  onAction,
  renderCard,
  releaseCard,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createFeedView 需要 document');

  let panel = null;
  let badgeEl = null;
  let laneEls = [];
  let listEl = null;
  let loadingEl = null;
  let errorEl = null;
  let errorTextEl = null;
  let emptyEl = null;
  let moreEl = null;
  let noticeEl = null;
  let readerEl = null;
  let readerTitleEl = null;
  let readerBodyEl = null;
  let currentSnapshot = null;
  let isOpenFlag = false;
  let destroyed = false;

  const rows = new Map();
  const drafts = new Map();
  let activeQuestion = null;
  /** @type {{itemId:string, revision:number, node:Node|null}|null} */
  let reader = null;

  function send(action) {
    if (destroyed) return;
    if (typeof onAction === 'function') onAction(action);
  }

  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeButton(className, text, handler) {
    const button = make('button', className, text);
    button.type = 'button';
    if (handler) button.addEventListener('click', handler);
    return button;
  }

  function attach(parent, ...children) {
    for (const child of children) parent.appendChild(child);
    return parent;
  }

  function ensurePanel() {
    if (panel) return panel;

    panel = make('section', 'feed-view');
    panel.hidden = true;
    const head = make('header', 'feed-head');
    const backButton = makeButton('feed-back', '返回', () => back());
    backButton.setAttribute('aria-label', '返回日报列表');
    const title = make('div', 'feed-title', '日报');
    badgeEl = make('span', 'feed-badge', '0');
    badgeEl.hidden = true;
    const refresh = makeButton('feed-refresh', '刷新', () => send({ type: 'refresh' }));
    refresh.setAttribute('aria-label', '刷新日报');
    attach(head, backButton, title, badgeEl, refresh);

    const lanes = make('nav', 'feed-lanes');
    const definitions = [
      ['all', '全部'],
      ['task', '待办'],
      ['content', '内容'],
    ];
    laneEls = definitions.map(([lane, label]) => {
      const button = makeButton('feed-lane', label, () => send({ type: 'lane', value: lane }));
      button.dataset.lane = lane;
      lanes.appendChild(button);
      return button;
    });

    const body = make('div', 'feed-body');
    loadingEl = make('div', 'feed-state feed-loading', '正在取今天的日报…');
    errorEl = make('div', 'feed-state feed-error');
    errorEl.hidden = true;
    errorTextEl = make('p', 'feed-state-text', '');
    const retry = makeButton('feed-retry', '重试', () => send({ type: 'refresh' }));
    attach(errorEl, errorTextEl, retry);
    emptyEl = make('div', 'feed-state feed-empty', '今天还没有日报');
    emptyEl.hidden = true;
    noticeEl = make('div', 'feed-notice', '');
    noticeEl.hidden = true;
    noticeEl.setAttribute?.('role', 'status');
    listEl = make('div', 'feed-list');
    attach(body, loadingEl, errorEl, emptyEl, noticeEl, listEl);

    const foot = make('footer', 'feed-foot');
    moreEl = makeButton('feed-more', '加载更多', () => {
      if (moreEl.disabled) return;
      send({ type: 'more' });
    });
    moreEl.hidden = true;
    foot.appendChild(moreEl);

    attach(panel, head, lanes, body, foot);
    doc.body.appendChild(panel);
    return panel;
  }

  function openQuestion(itemId) {
    const row = rows.get(itemId);
    if (!row || destroyed) return;
    if (activeQuestion && activeQuestion.itemId === itemId) {
      row.questionEl.hidden = false;
      return;
    }
    if (activeQuestion) cancelActiveQuestion({ discard: false });
    activeQuestion = { itemId, row };
    row.questionEl.hidden = false;
    const draft = drafts.has(itemId)
      ? drafts.get(itemId)
      : typeof row.item?.ask === 'string'
        ? row.item.ask
        : '';
    row.questionInput.value = draft;
    row.questionError.hidden = true;
    row.questionError.textContent = '';
    row.questionPending = false;
    row.questionInput.disabled = false;
    row.questionSubmitted = false;
    row.questionSend.disabled = false;
    row.questionSend.textContent = '发送';
  }

  function closeQuestion({ discard = false } = {}) {
    if (!activeQuestion) return;
    const { itemId, row } = activeQuestion;
    if (!discard && row.questionInput) drafts.set(itemId, row.questionInput.value);
    row.questionEl.hidden = true;
    activeQuestion = null;
  }

  function cancelActiveQuestion({ discard = false } = {}) {
    if (!activeQuestion) return;
    const itemId = activeQuestion.itemId;
    closeQuestion({ discard });
    send({ type: 'ask-cancel', itemId });
  }

  /* ---- 阅读层 ---- */

  function ensureReader() {
    if (readerEl) return readerEl;
    readerEl = make('section', 'feed-reader');
    readerEl.hidden = true;
    const head = make('header', 'feed-reader-head');
    const backButton = makeButton('feed-reader-back', '返回列表', () => backFromReader());
    backButton.setAttribute('aria-label', '返回日报列表');
    readerTitleEl = make('div', 'feed-reader-title', '');
    attach(head, backButton, readerTitleEl);
    readerBodyEl = make('div', 'feed-reader-body');
    const foot = make('footer', 'feed-reader-foot');
    const askButton = makeButton('feed-reader-ask', '继续聊', () => continueChat());
    foot.appendChild(askButton);
    attach(readerEl, head, readerBodyEl, foot);
    (panel || doc.body).appendChild(readerEl);
    return readerEl;
  }

  function hideNotice() {
    if (!noticeEl) return;
    noticeEl.hidden = true;
    noticeEl.textContent = '';
  }

  function showNotice(text) {
    if (!noticeEl) return;
    noticeEl.textContent = text;
    noticeEl.hidden = false;
  }

  function closeReader() {
    const current = reader;
    reader = null;
    if (current?.node && typeof releaseCard === 'function') releaseCard(current.node);
    if (readerBodyEl) readerBodyEl.replaceChildren();
    if (readerEl) readerEl.hidden = true;
  }

  function backFromReader() {
    const itemId = reader?.itemId;
    closeReader();
    const row = itemId ? rows.get(itemId) : null;
    if (row?.titleButton && typeof row.titleButton.focus === 'function') {
      // preventScroll：从长条目靠下的入口进阅读层再返回时，列表不能被拉回标题。
      row.titleButton.focus({ preventScroll: true });
    }
  }

  /** 阅读层“继续聊”：先回到列表同一条目，再复用原提问编辑；不自动建会话也不发送。 */
  function continueChat() {
    const current = reader;
    if (!current) return;
    const itemId = current.itemId;
    closeReader();
    openQuestion(itemId);
  }

  function openReader(itemId) {
    if (destroyed) return;
    const row = rows.get(itemId);
    if (!row) return;
    if (reader && reader.itemId === itemId && reader.revision === row.item.revision) return;
    // 换条目（或版本）时只保留一个阅读层；已打开的提问编辑先收回（保留草稿，不发 ask-cancel）。
    closeReader();
    if (activeQuestion) closeQuestion({ discard: false });
    hideNotice();
    ensureReader();
    reader = { itemId, revision: row.item.revision, node: null };
    readerTitleEl.textContent = textOf(row.item.title);
    readerBodyEl.replaceChildren();
    readerEl.hidden = false;

    let node = null;
    try {
      node = renderCard(row.item, {
        mode: 'reader',
        slateId: currentSnapshot?.slateId ?? null,
        position: typeof row.position === 'number' ? row.position : 0,
      });
    } catch (err) {
      const failed = make('div', 'feed-reader-error', errorText(err) || '阅读层加载失败');
      readerBodyEl.appendChild(failed);
      return;
    }
    if (node) {
      reader.node = node;
      readerBodyEl.appendChild(node);
    } else {
      readerBodyEl.appendChild(make('div', 'feed-reader-error', '这条日报暂时无法显示正文'));
    }
  }

  /**
   * 刷新落地后核对阅读层归属：同 revision 保留 iframe；版本漂移或条目消失则释放旧层，
   * 避免拿旧版本继续追问。
   */
  function syncReader(items) {
    if (!reader) return;
    const item = items.find((entry) => entry.itemId === reader.itemId);
    if (!item) {
      closeReader();
      showNotice('这条日报已不在列表，已退出阅读');
      return;
    }
    if (item.revision !== reader.revision) {
      closeReader();
      showNotice('这条日报已更新，已退出阅读，请重新打开');
      return;
    }
    if (readerTitleEl) readerTitleEl.textContent = textOf(item.title);
  }

  function cancelQuestion() {
    cancelActiveQuestion({ discard: false });
  }

  function confirmQuestion(row) {
    if (!activeQuestion || activeQuestion.row !== row) return;
    if (row.questionPending || row.questionSubmitted) return;
    const text = String(row.questionInput.value || '').trim();
    if (!text) {
      row.questionError.textContent = '先写下要问的问题';
      row.questionError.hidden = false;
      return;
    }
    drafts.set(row.item.itemId, text);
    row.questionSubmitted = true;
    row.questionPending = true;
    row.questionInput.disabled = true;
    row.questionError.hidden = true;
    row.questionSend.disabled = true;
    row.questionSend.textContent = '发送中…';
    send({ type: 'ask', itemId: row.item.itemId, text });
  }

  function rebuildTasks(row, item, pending) {
    row.tasksEl.replaceChildren();
    if (!item.task) {
      row.tasksEl.hidden = true;
      return;
    }
    row.tasksEl.hidden = false;
    const state = make('span', 'feed-task-state', taskStateLabel(item.task.state));
    row.tasksEl.appendChild(state);
    const actions = Array.isArray(item.task.actions) ? item.task.actions : [];
    for (const action of actions) {
      if (!action || typeof action.id !== 'string') continue;
      const label = typeof action.label === 'string' && action.label ? action.label : action.kind;
      const button = make('button', 'feed-task-action', textOf(label));
      button.type = 'button';
      const supported = action.kind === 'confirm' || action.kind === 'dismiss' || action.kind === 'edit';
      if (!supported) {
        button.disabled = true;
        button.title = '这个操作暂不支持';
      } else if (pending) {
        button.disabled = true;
      } else {
        button.addEventListener('click', () => {
          if (row.pending) return;
          if (action.kind === 'edit') {
            openQuestion(row.item.itemId);
            return;
          }
          send({ type: 'task', itemId: row.item.itemId, actionId: action.id });
        });
      }
      row.tasksEl.appendChild(button);
    }
  }

  function applyRow(row, item, snapshotValue, pending) {
    row.pending = pending;
    row.el.dataset.revision = String(item.revision);
    row.el.classList.toggle('is-pending', pending);
    row.el.classList.toggle('is-unread', Boolean(item.unread));

    const title = textOf(item.title);
    row.titleButton.textContent = title;
    row.titleButton.setAttribute('aria-label', `阅读全文：${title}`);
    row.titleButton.setAttribute('title', '阅读全文');
    row.titleButton.disabled = pending;
    const sourceName =
      item.source && typeof item.source === 'object'
        ? textOf(item.source.displayName) || textOf(item.source.sourceId)
        : '';
    row.metaEl.textContent = [sourceName, laneLabel(item.lane)].filter(Boolean).join(' · ');
    row.unreadEl.hidden = !item.unread;

    const explain = textOf(item.explain);
    row.explainEl.textContent = explain;
    row.explainEl.hidden = !explain || !row.explainOpen;
    row.explainBtn.hidden = !explain;
    row.explainBtn.disabled = pending;

    const topics = Array.isArray(item.topics) ? item.topics.filter((topic) => typeof topic === 'string') : [];
    row.topicsEl.textContent = topics.join(' · ');
    row.topicsEl.hidden = topics.length === 0;

    row.favoriteBtn.textContent = item.favorite ? '已收藏' : '收藏';
    row.favoriteBtn.classList.toggle('is-on', Boolean(item.favorite));
    row.favoriteBtn.disabled = pending;
    row.hideBtn.disabled = pending;
    row.lessBtn.disabled = pending;
    row.readBtn.disabled = pending;
    row.askOpenBtn.disabled = pending;

    const taskSig = JSON.stringify({ task: item.task || null, pending });
    if (taskSig !== row.taskSig) {
      rebuildTasks(row, item, pending);
      row.taskSig = taskSig;
    }

    if (activeQuestion && activeQuestion.itemId === item.itemId) {
      row.questionInput.disabled = Boolean(row.questionPending);
      row.questionSend.disabled = Boolean(row.questionPending);
    }
  }

  function createRow(item, snapshotValue, index) {
    const el = make('article', 'feed-item');
    el.dataset.itemId = item.itemId;

    const head = make('header', 'feed-item-head');
    const titleEl = make('h2', 'feed-item-title');
    const titleButton = makeButton('feed-item-title-btn', '');
    titleEl.appendChild(titleButton);
    const metaEl = make('div', 'feed-item-meta');
    const unreadEl = make('span', 'feed-item-unread', '未读');
    attach(head, titleEl, metaEl, unreadEl);

    const explainEl = make('p', 'feed-item-explain');
    explainEl.hidden = true;
    const topicsEl = make('div', 'feed-item-topics');
    topicsEl.hidden = true;
    const tasksEl = make('div', 'feed-item-tasks');
    tasksEl.hidden = true;

    const actionsEl = make('div', 'feed-item-actions');
    const favoriteBtn = makeButton('feed-favorite', '收藏', () => {
      if (row.pending) return;
      send({ type: 'favorite', itemId: row.item.itemId, value: !row.item.favorite });
    });
    const hideBtn = makeButton('feed-hide', '隐藏', () => {
      if (row.pending) return;
      send({ type: 'hide', itemId: row.item.itemId });
    });
    const lessBtn = makeButton('feed-less-like', '少推这类', () => {
      if (row.pending) return;
      send({ type: 'less-like', itemId: row.item.itemId });
    });
    const explainBtn = makeButton('feed-explain', '为什么看到', () => {
      if (row.pending) return;
      row.explainOpen = !row.explainOpen;
      explainEl.hidden = !explainEl.textContent || !row.explainOpen;
      send({ type: 'explain', itemId: row.item.itemId });
    });
    explainBtn.hidden = true;
    const readBtn = makeButton('feed-read', '阅读全文', () => {
      if (row.pending) return;
      openReader(row.item.itemId);
    });
    const askOpenBtn = makeButton('feed-ask-open', '继续聊', () => {
      if (row.pending) return;
      openQuestion(row.item.itemId);
    });
    attach(actionsEl, favoriteBtn, hideBtn, lessBtn, explainBtn, readBtn, askOpenBtn);

    const questionEl = make('div', 'feed-question');
    questionEl.hidden = true;
    const questionInput = make('textarea', 'feed-question-input');
    questionInput.rows = 2;
    const questionError = make('div', 'feed-question-error');
    questionError.hidden = true;
    const questionActions = make('div', 'feed-question-actions');
    const questionCancel = makeButton('feed-question-cancel', '取消', () => cancelQuestion());
    const questionSend = makeButton('feed-question-send', '发送', () => confirmQuestion(row));
    attach(questionActions, questionCancel, questionSend);
    attach(questionEl, questionInput, questionError, questionActions);

    attach(el, head, explainEl, topicsEl, tasksEl, actionsEl, questionEl);

    const row = {
      el,
      item,
      titleEl,
      titleButton,
      metaEl,
      unreadEl,
      explainEl,
      explainBtn,
      explainOpen: true,
      topicsEl,
      tasksEl,
      taskSig: null,
      favoriteBtn,
      hideBtn,
      lessBtn,
      readBtn,
      askOpenBtn,
      questionEl,
      questionInput,
      questionError,
      questionSend,
      questionCancel,
      questionPending: false,
      questionSubmitted: false,
      pending: false,
      position: 0,
    };

    // row 自引用：标题按钮在 row 对象建好后才绑定点击，避免在构造前引用它。
    titleButton.addEventListener('click', () => {
      if (row.pending) return;
      openReader(row.item.itemId);
    });

    // 列表不铸卡、不取正文：正文只在用户点开阅读层后才请求。
    return row;
  }

  function reorder(desired) {
    let cursor = listEl.firstChild;
    for (const el of desired) {
      if (el === cursor) {
        cursor = el.nextSibling;
        continue;
      }
      listEl.insertBefore(el, cursor);
    }
  }

  function render(snapshotValue) {
    if (destroyed) return;
    ensurePanel();
    const value = snapshotValue && typeof snapshotValue === 'object' ? snapshotValue : {};
    currentSnapshot = value;
    const items = Array.isArray(value.items) ? value.items : [];
    const pending = new Set(Array.isArray(value.pendingIds) ? value.pendingIds : []);

    const count = Number.isSafeInteger(value.unreadTaskCount) ? value.unreadTaskCount : 0;
    badgeEl.hidden = count <= 0;
    badgeEl.textContent = count > 99 ? '99+' : String(count);

    const lane = value.lane === 'task' || value.lane === 'content' ? value.lane : 'all';
    for (const button of laneEls) {
      button.classList.toggle('is-active', button.dataset.lane === lane);
    }

    const hasItems = items.length > 0;
    loadingEl.hidden = !(Boolean(value.loading) && !hasItems);
    errorEl.hidden = !value.error;
    if (value.error) errorTextEl.textContent = errorText(value.error);
    emptyEl.hidden = !(!value.loading && !value.error && !hasItems);
    listEl.hidden = !hasItems;

    const desired = [];
    const seen = new Set();
    items.forEach((item, index) => {
      if (!item || typeof item.itemId !== 'string' || seen.has(item.itemId)) return;
      seen.add(item.itemId);
      let row = rows.get(item.itemId);
      if (row && row.item.revision !== item.revision) {
        if (activeQuestion && activeQuestion.itemId === item.itemId) {
          cancelActiveQuestion({ discard: true });
        }
        row.el.remove();
        rows.delete(item.itemId);
        row = null;
      }
      if (!row) {
        row = createRow(item, value, index);
        rows.set(item.itemId, row);
      }
      row.item = item;
      row.position = index;
      applyRow(row, item, value, pending.has(item.itemId));
      desired.push(row.el);
    });

    for (const [itemId, row] of [...rows]) {
      if (seen.has(itemId)) continue;
      if (activeQuestion && activeQuestion.itemId === itemId) {
        cancelActiveQuestion({ discard: true });
      }
      row.el.remove();
      rows.delete(itemId);
    }

    reorder(desired);
    syncReader(items);

    const cursor = typeof value.cursor === 'string' && value.cursor ? value.cursor : null;
    moreEl.hidden = !cursor;
    moreEl.disabled = Boolean(value.loadingMore);
    moreEl.textContent = value.loadingMore ? '加载中…' : '加载更多';
  }

  function open() {
    if (destroyed) return;
    ensurePanel();
    panel.hidden = false;
    isOpenFlag = true;
  }

  function close() {
    if (!panel) {
      isOpenFlag = false;
      return;
    }
    panel.hidden = true;
    isOpenFlag = false;
    closeReader();
    hideNotice();
    closeQuestion({ discard: true });
    listEl.replaceChildren();
    rows.clear();
  }

  function back() {
    if (destroyed) return;
    if (activeQuestion) {
      const itemId = activeQuestion.itemId;
      closeQuestion({ discard: false });
      send({ type: 'ask-cancel', itemId });
      return;
    }
    // 返回顺序：提问编辑 → 阅读层 → 日报。
    if (reader) {
      closeReader();
      return;
    }
    close();
    send({ type: 'close' });
  }

  function setQuestionState({ itemId, text, pending, error } = {}) {
    if (!activeQuestion || activeQuestion.itemId !== itemId) return;
    const row = rows.get(itemId);
    if (!row) return;
    if (typeof text === 'string') {
      row.questionInput.value = text;
      drafts.set(itemId, text);
    }
    row.questionPending = Boolean(pending);
    row.questionInput.disabled = row.questionPending;
    if (row.questionPending) {
      row.questionSend.disabled = true;
      row.questionSend.textContent = '发送中…';
    } else {
      row.questionSend.disabled = false;
      row.questionSend.textContent = '发送';
      row.questionSubmitted = false;
    }
    if (error) {
      row.questionError.textContent = errorText(error);
      row.questionError.hidden = false;
    } else {
      row.questionError.hidden = true;
      row.questionError.textContent = '';
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    closeReader();
    closeQuestion({ discard: true });
    rows.clear();
    if (panel) panel.remove();
    panel = null;
    listEl = null;
    badgeEl = null;
    laneEls = [];
    noticeEl = null;
    readerEl = null;
    readerTitleEl = null;
    readerBodyEl = null;
    isOpenFlag = false;
  }

  return {
    render,
    open,
    close,
    isOpen: () => isOpenFlag,
    back,
    setQuestionState,
    destroy,
  };
}
