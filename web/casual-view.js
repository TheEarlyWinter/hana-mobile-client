/* web/casual-view.js — Hana 宿主闲聊（Casual Chat）视图层
 *
 * 独立于沉浸式/Serene 聊天渲染器，专为轻量高频的私聊场景设计。
 * 气泡紧凑轻量，针对平板与横屏高分屏优化首屏密度与阅读体验。
 *
 * 契约：
 *   createCasualView({ document, onSend, onLoadEarlier, onMarkRead, onOpenStickers, onRetry, onClose })
 *   -> { setState, open, close, reset, isOpen, destroy, scrollToLatest }
 *
 * onMarkRead 可以返回 Promise<boolean>：View 等结果再记账，失败（false / reject）不记账，
 * 下一次状态更新会重试。返回 undefined 的同步实现按老语义「调用即记账」。
 */

import { createScrollPin } from './scroll-pin.js';

/** 5分钟的时间戳毫秒差，用于连续消息的时间分隔 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** 加载更早历史的节流间隔（毫秒） */
const LOAD_EARLIER_THROTTLE_MS = 300;

/**
 * 格式化相对时间：刚刚 / n 分钟前 / HH:mm / 昨天 HH:mm / MM-DD HH:mm
 * @param {number|string|Date} timestamp
 * @param {number} [now]
 * @returns {string}
 */
function formatCasualTime(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(String(timestamp));
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const nowDate = new Date(now);
  const diffMs = now - time;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);

  // 1分钟内
  if (diffMin < 1 && diffSec >= 0) {
    return '刚刚';
  }
  // 60分钟内
  if (diffMin < 60 && diffMin >= 1) {
    return `${diffMin}分钟前`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  // 同一天
  const isSameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate();

  if (isSameDay) {
    return hhmm;
  }

  // 昨天
  const yesterday = new Date(nowDate);
  yesterday.setDate(nowDate.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `昨天 ${hhmm}`;
  }

  // 同一年
  const isSameYear = date.getFullYear() === nowDate.getFullYear();
  const mmdd = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  if (isSameYear) {
    return `${mmdd} ${hhmm}`;
  }

  // 跨年
  return `${date.getFullYear()}-${mmdd} ${hhmm}`;
}

/**
 * 格式化文件大小为易读形式
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 创建并初始化闲聊视图
 * @param {object} options
 * @param {Document} [options.document]
 * @param {(text: string) => void} [options.onSend]
 * @param {() => void} [options.onLoadEarlier]
 * @param {(entryId: string|number) => (void|boolean|Promise<boolean>)} [options.onMarkRead]
 * @param {() => void} [options.onOpenStickers]
 * @param {(clientMessageId: string|number) => void} [options.onRetry]
 * @param {() => void} [options.onClose]
 */
export function createCasualView({
  document = globalThis.document,
  onSend,
  onLoadEarlier,
  onMarkRead,
  onOpenStickers,
  onRetry,
  onClose,
} = {}) {
  if (!document) {
    throw new Error('createCasualView: document is required');
  }

  // 内部状态
  let _isOpen = false;
  let _state = {
    agentName: '',
    avatarUrl: '',
    entries: [],
    hasMore: false,
    typing: false,
    unread: 0,
    loading: false,
    loadingEarlier: false,
    error: null,
    stylePackId: null,
  };

  // 已确认上报成功的条目 id。失败不记，否则一次网络抖动就把这条永久挡住（store 还能重试）。
  const _markedReadIds = new Set();
  // 正在上报中的条目 id：状态更新可能连着来几次，同一条不要并发发请求。
  const _markReadInFlight = new Set();
  // 上报代次：reset / 换 Agent 时推进，旧请求回来不许把上一段会话的 id 记回来。
  let _readGen = 0;
  let _lastLoadEarlierTime = 0;

  /* ---------------------------- 构建 DOM 树 ---------------------------- */

  const root = document.createElement('div');
  root.className = 'casual-view';
  root.hidden = true;

  // 1. 顶部导航栏
  const header = document.createElement('div');
  header.className = 'casual-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'casual-header-back';
  backBtn.type = 'button';
  backBtn.textContent = '返回';
  backBtn.setAttribute('aria-label', '返回');

  const titleEl = document.createElement('div');
  titleEl.className = 'casual-header-title';
  titleEl.textContent = '闲聊';

  const stickerBtn = document.createElement('button');
  stickerBtn.className = 'casual-header-sticker';
  stickerBtn.type = 'button';
  stickerBtn.textContent = '表情';
  stickerBtn.setAttribute('aria-label', '打开表情包');

  header.appendChild(backBtn);
  header.appendChild(titleEl);
  header.appendChild(stickerBtn);

  // 2. 错误信息条（挂在顶部栏下方）
  const errorBar = document.createElement('div');
  errorBar.className = 'casual-error-bar';
  errorBar.hidden = true;

  // 3. 消息滚动容器与列表
  const messagesWrap = document.createElement('div');
  messagesWrap.className = 'casual-messages';

  // 顶部「加载更早历史」指示器
  const loadingEarlierEl = document.createElement('div');
  loadingEarlierEl.className = 'casual-loading-earlier';
  loadingEarlierEl.hidden = true;
  loadingEarlierEl.textContent = '正在加载更早消息…';

  // 首屏骨架屏
  const skeletonEl = document.createElement('div');
  skeletonEl.className = 'casual-skeleton';
  skeletonEl.hidden = true;
  for (let i = 0; i < 4; i += 1) {
    const sRow = document.createElement('div');
    sRow.className = `casual-skeleton-row casual-skeleton-row--${i % 2 === 0 ? 'agent' : 'user'}`;
    const sBubble = document.createElement('div');
    sBubble.className = 'casual-skeleton-bubble';
    sRow.appendChild(sBubble);
    skeletonEl.appendChild(sRow);
  }

  // 空态：加载完了但一条消息都没有时给一句话，别让用户对着一片白。
  const emptyEl = document.createElement('div');
  emptyEl.className = 'casual-empty';
  emptyEl.hidden = true;
  emptyEl.textContent = '还没有消息';

  // 消息列表实体
  const listEl = document.createElement('div');
  listEl.className = 'casual-list';

  /** 贴底规则与聊天主界面共用一份（web/scroll-pin.js），阈值沿用闲聊原来的 48。 */
  const scrollPin = createScrollPin({ element: messagesWrap, threshold: 48 });

  // 末尾「对方正在输入…」指示器
  const typingEl = document.createElement('div');
  typingEl.className = 'casual-typing';
  typingEl.hidden = true;
  const dotsEl = document.createElement('span');
  dotsEl.className = 'casual-typing-dots';
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'casual-typing-dot';
    dotsEl.appendChild(dot);
  }
  const typingText = document.createElement('span');
  typingText.className = 'casual-typing-text';
  typingText.textContent = '对方正在输入…';
  typingEl.appendChild(dotsEl);
  typingEl.appendChild(typingText);

  messagesWrap.appendChild(loadingEarlierEl);
  messagesWrap.appendChild(skeletonEl);
  messagesWrap.appendChild(emptyEl);
  messagesWrap.appendChild(listEl);
  messagesWrap.appendChild(typingEl);

  // 4. 底部输入区
  const composer = document.createElement('div');
  composer.className = 'casual-composer';

  const inputEl = document.createElement('input');
  inputEl.className = 'casual-input';
  inputEl.type = 'text';
  inputEl.placeholder = '输入消息…';
  inputEl.setAttribute('aria-label', '输入闲聊内容');

  const sendBtn = document.createElement('button');
  sendBtn.className = 'casual-send-btn';
  sendBtn.type = 'button';
  sendBtn.textContent = '发送';

  composer.appendChild(inputEl);
  composer.appendChild(sendBtn);

  // 组装根节点并追加到 body
  root.appendChild(header);
  root.appendChild(errorBar);
  root.appendChild(messagesWrap);
  root.appendChild(composer);

  if (document.body) {
    document.body.appendChild(root);
  }

  /* ---------------------------- 事件监听与交互 ---------------------------- */

  function handleSend() {
    const val = (inputEl.value || '').trim();
    if (!val) return;
    inputEl.value = '';
    // 自己发的那条一定要看到，哪怕刚才正在翻上面的历史。
    scrollPin.reset();
    onSend?.(val);
  }

  backBtn.addEventListener('click', () => {
    onClose?.();
  });

  stickerBtn.addEventListener('click', () => {
    onOpenStickers?.();
  });

  sendBtn.addEventListener('click', () => {
    handleSend();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  // 滚动监听：到顶附近触发 onLoadEarlier，并检查未读已读标记
  function handleScroll() {
    if (!_isOpen) return;

    // 「贴着底」交给 scroll-pin：它认得出哪次 scroll 是程序滚底、哪次是用户自己翻。
    scrollPin.onScroll();

    // 检查滚动到顶部附近
    if (messagesWrap.scrollTop <= 40 && _state.hasMore && !_state.loadingEarlier) {
      const now = Date.now();
      if (now - _lastLoadEarlierTime >= LOAD_EARLIER_THROTTLE_MS) {
        _lastLoadEarlierTime = now;
        onLoadEarlier?.();
      }
    }

    // 检查未读状态标记
    checkMarkRead();
  }

  messagesWrap.addEventListener('scroll', handleScroll);
  // 图片/贴纸异步撑高会把视口顶上去，用捕获阶段统一接住。
  listEl.addEventListener('load', handleMediaLoad, true);

  /* ---------------------------- 未读已读逻辑 ---------------------------- */

  function checkMarkRead() {
    if (!_isOpen || !_state.unread || _state.unread <= 0) return;
    const entries = _state.entries || [];
    if (!entries.length) return;

    // 最早未读条目的位置：从末尾往前数 unread 条
    const firstUnreadIndex = Math.max(0, entries.length - _state.unread);
    const firstUnreadEntry = entries[firstUnreadIndex];
    if (!firstUnreadEntry || firstUnreadEntry.id === undefined) return;

    const entryId = firstUnreadEntry.id;
    if (_markedReadIds.has(entryId) || _markReadInFlight.has(entryId)) return;

    // 记账必须等结果：以前是先记账再调用，失败一次这个 id 就永久作废，
    // 而 store 的失败分支本来是会重试的。现在只有确认成功才记；回调没返回
    // Promise 时（同步实现）保持老语义，避免把同步调用方变成每次都重发。
    const result = onMarkRead?.(entryId);
    if (!result || typeof result !== 'object' || typeof result.then !== 'function') {
      _markedReadIds.add(entryId);
      return;
    }

    const generation = _readGen;
    _markReadInFlight.add(entryId);
    Promise.resolve(result).then(
      (ok) => {
        _markReadInFlight.delete(entryId);
        if (generation !== _readGen) return; // 期间 reset 过，别把旧上下文的 id 记回来
        if (ok === false) return; // 没上报成功：下一次 setState / 滚动会再试
        _markedReadIds.add(entryId);
      },
      () => {
        _markReadInFlight.delete(entryId);
      },
    );
  }

  /* ---------------------------- 渲染逻辑 ---------------------------- */

  /**
   * 渲染单个消息气泡内部的内容（严格防注入，采用 textContent）
   * @param {object} item
   * @returns {{ element: HTMLElement, transparentBubble?: boolean, isSystem?: boolean }}
   */
  function renderItemContent(item) {
    const kind = item?.kind;
    const wrap = document.createElement('div');
    wrap.className = `casual-item casual-item--${kind || 'unknown'}`;

    switch (kind) {
      case 'text': {
        const textNode = document.createElement('div');
        textNode.className = 'casual-text';
        textNode.textContent = item?.text || '';
        wrap.appendChild(textNode);
        return { element: wrap, transparentBubble: false };
      }

      case 'sticker': {
        const stickerWrap = document.createElement('div');
        stickerWrap.className = 'casual-sticker';
        const img = document.createElement('img');
        img.className = 'casual-sticker-img';
        img.src = item?.url || '';
        img.alt = item?.note || '表情';
        stickerWrap.appendChild(img);
        wrap.appendChild(stickerWrap);
        return { element: wrap, transparentBubble: true };
      }

      case 'image': {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'casual-image-wrap';
        const img = document.createElement('img');
        img.className = 'casual-image';
        img.src = item?.url || '';
        img.alt = '图片';
        imgWrap.appendChild(img);
        wrap.appendChild(imgWrap);
        return { element: wrap, transparentBubble: false };
      }

      case 'card': {
        const cardBox = document.createElement('div');
        cardBox.className = 'casual-card';
        const cTitle = document.createElement('div');
        cTitle.className = 'casual-card-title';
        cTitle.textContent = item?.title || '卡片';
        cardBox.appendChild(cTitle);
        if (item?.block) {
          const cBlock = document.createElement('div');
          cBlock.className = 'casual-card-block';
          cBlock.textContent = typeof item.block === 'string' ? item.block : JSON.stringify(item.block);
          cardBox.appendChild(cBlock);
        }
        wrap.appendChild(cardBox);
        return { element: wrap, transparentBubble: false };
      }

      case 'file': {
        const fileBox = document.createElement('div');
        fileBox.className = 'casual-file';
        const fIcon = document.createElement('div');
        fIcon.className = 'casual-file-icon';
        fIcon.textContent = '[文件]';
        const fInfo = document.createElement('div');
        fInfo.className = 'casual-file-info';
        const fName = document.createElement('div');
        fName.className = 'casual-file-name';
        fName.textContent = item?.name || '未知文件';
        const fMeta = document.createElement('div');
        fMeta.className = 'casual-file-meta';
        const metaParts = [item?.mime, item?.size ? formatFileSize(item.size) : null].filter(Boolean);
        fMeta.textContent = metaParts.join(' · ') || '文件';
        fInfo.appendChild(fName);
        fInfo.appendChild(fMeta);
        fileBox.appendChild(fIcon);
        fileBox.appendChild(fInfo);
        wrap.appendChild(fileBox);
        return { element: wrap, transparentBubble: false };
      }

      case 'approval': {
        const appBox = document.createElement('div');
        appBox.className = 'casual-approval';
        const head = document.createElement('div');
        head.className = 'casual-approval-head';
        const aTitle = document.createElement('div');
        aTitle.className = 'casual-approval-title';
        aTitle.textContent = item?.title || '审批事项';
        const aStatus = document.createElement('span');
        aStatus.className = 'casual-approval-status';
        aStatus.textContent = item?.status || '待处理';
        head.appendChild(aTitle);
        head.appendChild(aStatus);
        appBox.appendChild(head);
        if (item?.detail) {
          const aDetail = document.createElement('div');
          aDetail.className = 'casual-approval-detail';
          aDetail.textContent = item.detail;
          appBox.appendChild(aDetail);
        }
        wrap.appendChild(appBox);
        return { element: wrap, transparentBubble: false };
      }

      case 'reset': {
        const resetTip = document.createElement('div');
        resetTip.className = 'casual-system-tip casual-reset';
        const tag = document.createElement('span');
        tag.className = 'casual-system-tip-text';
        tag.textContent = '会话已重置';
        resetTip.appendChild(tag);
        wrap.appendChild(resetTip);
        return { element: wrap, transparentBubble: true, isSystem: true };
      }

      case 'voice': {
        const voiceBox = document.createElement('div');
        voiceBox.className = 'casual-text casual-voice';
        voiceBox.textContent = `语音：${item?.text || ''}`;
        wrap.appendChild(voiceBox);
        return { element: wrap, transparentBubble: false };
      }

      default: {
        // 未知 kind 降级兜底，严禁抛错崩溃
        const unknownBox = document.createElement('div');
        unknownBox.className = 'casual-unsupported';
        unknownBox.textContent = `[暂不支持的消息: ${kind || 'unknown'}]`;
        wrap.appendChild(unknownBox);
        return { element: wrap, transparentBubble: false };
      }
    }
  }

  /**
   * 刷新整棵消息列表 DOM
   */
  function renderMessages() {
    // 1. 骨架屏与更早加载提示
    const hasEntries = Array.isArray(_state.entries) && _state.entries.length > 0;
    if (_state.loading && !hasEntries) {
      skeletonEl.hidden = false;
      listEl.hidden = true;
    } else {
      skeletonEl.hidden = true;
      listEl.hidden = false;
    }

    // 空态只在「不在加载、且确实没有条目」时露脸：骨架屏一收就是一片白，
    // 用户分不清「没有消息」和「没加载出来」。
    emptyEl.hidden = hasEntries || _state.loading === true;

    loadingEarlierEl.hidden = !_state.loadingEarlier;

    // 清空现有列表
    listEl.replaceChildren();

    if (!hasEntries) return;

    const entries = _state.entries;
    const unreadCount = typeof _state.unread === 'number' && _state.unread > 0 ? _state.unread : 0;
    const unreadStartIndex = unreadCount > 0 ? Math.max(0, entries.length - unreadCount) : -1;

    let lastTime = 0;

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const entryTime = entry.occurredAt ? new Date(entry.occurredAt).getTime() : 0;

      // 超过 5 分钟间隔或者首条有效时间插入时间分隔
      if (entryTime && (!lastTime || Math.abs(entryTime - lastTime) >= FIVE_MINUTES_MS)) {
        const timeDivider = document.createElement('div');
        timeDivider.className = 'casual-time-divider';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'casual-time-divider-text';
        timeSpan.textContent = formatCasualTime(entryTime);
        timeDivider.appendChild(timeSpan);
        listEl.appendChild(timeDivider);
        lastTime = entryTime;
      }

      // 未读分隔线：插入在第一条未读消息之前
      if (unreadStartIndex !== -1 && i === unreadStartIndex) {
        const unreadDivider = document.createElement('div');
        unreadDivider.className = 'casual-unread-divider';
        const lineLeft = document.createElement('span');
        lineLeft.className = 'casual-unread-divider-line';
        const unreadLabel = document.createElement('span');
        unreadLabel.className = 'casual-unread-divider-text';
        unreadLabel.textContent = '以下为新消息';
        const lineRight = document.createElement('span');
        lineRight.className = 'casual-unread-divider-line';

        unreadDivider.appendChild(lineLeft);
        unreadDivider.appendChild(unreadLabel);
        unreadDivider.appendChild(lineRight);
        listEl.appendChild(unreadDivider);
      }

      // 渲染消息项
      const { element: itemContent, transparentBubble, isSystem } = renderItemContent(entry.item);

      // 系统提示（如 reset）作为独立居中节点
      if (isSystem) {
        const sysRow = document.createElement('div');
        sysRow.className = 'casual-row-system';
        sysRow.appendChild(itemContent);
        listEl.appendChild(sysRow);
        continue;
      }

      const row = document.createElement('div');
      const actor = entry.actor === 'user' ? 'user' : 'agent';
      row.className = `casual-row casual-row--${actor} casual-row-id-${entry.id}`;
      row.dataset.actor = actor;
      if (entry.id !== undefined) row.dataset.entryId = String(entry.id);

      // 计算前后连续 actor 关系，方便圆角与紧凑间距控制
      const prev = entries[i - 1];
      const next = entries[i + 1];
      const isConsecutivePrev = prev && prev.actor === entry.actor && prev.item?.kind !== 'reset';
      const isConsecutiveNext = next && next.actor === entry.actor && next.item?.kind !== 'reset';
      if (isConsecutivePrev) row.classList.add('casual-row--consecutive');
      if (!isConsecutivePrev && isConsecutiveNext) row.classList.add('casual-row--group-start');
      if (isConsecutivePrev && !isConsecutiveNext) row.classList.add('casual-row--group-end');

      // 对方头像（连续消息可弱化占位或隐去）
      if (actor === 'agent') {
        const avatarBox = document.createElement('div');
        avatarBox.className = 'casual-avatar';
        if (!isConsecutiveNext) {
          if (_state.avatarUrl) {
            const avatarImg = document.createElement('img');
            avatarImg.className = 'casual-avatar-img';
            avatarImg.src = _state.avatarUrl;
            avatarImg.alt = _state.agentName || '对方';
            avatarBox.appendChild(avatarImg);
          } else {
            const avatarChar = document.createElement('span');
            avatarChar.className = 'casual-avatar-char';
            avatarChar.textContent = (_state.agentName || 'H').slice(0, 1);
            avatarBox.appendChild(avatarChar);
          }
        } else {
          avatarBox.classList.add('casual-avatar--empty');
        }
        row.appendChild(avatarBox);
      }

      // 气泡包裹区
      const bubbleWrap = document.createElement('div');
      bubbleWrap.className = 'casual-bubble-wrap';

      const bubble = document.createElement('div');
      bubble.className = 'casual-bubble';
      if (transparentBubble) {
        bubble.classList.add('casual-bubble--transparent');
      }
      bubble.appendChild(itemContent);
      bubbleWrap.appendChild(bubble);

      // 状态标记（发送中 / 失败重试）
      if (entry.pending) {
        const pendingEl = document.createElement('span');
        pendingEl.className = 'casual-status casual-status--pending';
        pendingEl.textContent = '发送中';
        bubbleWrap.appendChild(pendingEl);
      } else if (entry.failed) {
        const failedBtn = document.createElement('button');
        failedBtn.className = 'casual-status casual-status--failed';
        failedBtn.type = 'button';
        failedBtn.textContent = '!';
        failedBtn.title = '发送失败，点击重试';
        failedBtn.setAttribute('aria-label', '发送失败，点击重试');
        failedBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          onRetry?.(entry.id);
        });
        bubbleWrap.appendChild(failedBtn);
      }

      row.appendChild(bubbleWrap);
      listEl.appendChild(row);
    }

    // 列表是整棵重建的，滚动位置会跟着归零。
    // 用户本来就贴着底（刚打开、自己刚发消息、或者一直在看最新）就跟着走；
    // 回头看历史的人由 scroll-pin 里的意图标记拦住每 4 秒一次的轮询。
    if (_isOpen) scrollPin.follow();
  }

  /* ---------------------------- 公开 API 实现 ---------------------------- */

  /**
   * 滚动到消息流底部。
   * 贴底/脱钩/补帧的规则全在 web/scroll-pin.js，这里只表达「现在要贴底」。
   */
  function scrollToLatest() {
    scrollPin.pin();
  }

  /**
   * 图片、贴纸是异步撑高的：撑开时用户本来就贴着底，就继续贴着底。
   */
  function handleMediaLoad(e) {
    if (!_isOpen) return;
    const target = e && e.target;
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tag === 'IMG') scrollToLatest();
  }

  /**
   * 设置新状态并触发界面刷新
   * @param {object} partial
   */
  function setState(partial) {
    if (!partial || typeof partial !== 'object') return;
    _state = { ..._state, ...partial };

    // 1. 样式包挂载
    if (_state.stylePackId) {
      root.dataset.stylePack = _state.stylePackId;
    } else {
      delete root.dataset.stylePack;
    }

    // 2. 标题
    titleEl.textContent = _state.agentName || '闲聊';

    // 3. 错误栏
    if (_state.error) {
      errorBar.hidden = false;
      errorBar.textContent = String(_state.error);
    } else {
      errorBar.hidden = true;
      errorBar.textContent = '';
    }

    // 4. 输入状态
    typingEl.hidden = !_state.typing;

    // 5. 渲染消息
    renderMessages();

    // 若当前已处于打开状态且有未读消息，尝试触发已读
    if (_isOpen) {
      checkMarkRead();
    }
  }

  function open() {
    _isOpen = true;
    root.hidden = false;
    // 打开时数据可能还没到，先挂钩；条目回来重建列表时再跟一次底。
    scrollPin.reset();
    scrollToLatest();
    checkMarkRead();
  }

  function close() {
    _isOpen = false;
    root.hidden = true;
  }

  /** 清空输入框草稿：换 Agent / 登出时不能把旧草稿带给新对象。 */
  function clearDraft() {
    inputEl.value = '';
  }

  /**
   * 清掉只属于「这一段会话」的本地记账：草稿、已读去重、加载更早的节流。
   * 旧条目的 id 一律作废，新对象/新登录从头开始。
   */
  function reset() {
    _readGen += 1;
    _markedReadIds.clear();
    _markReadInFlight.clear();
    _lastLoadEarlierTime = 0;
    clearDraft();
  }

  function isOpen() {
    return _isOpen;
  }

  function destroy() {
    _isOpen = false;
    messagesWrap.removeEventListener('scroll', handleScroll);
    listEl.removeEventListener('load', handleMediaLoad, true);
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

  return {
    setState,
    open,
    close,
    reset,
    clearDraft,
    isOpen,
    destroy,
    scrollToLatest,
  };
}
