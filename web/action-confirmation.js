/* web/action-confirmation.js — 卡片与工作区动作确认弹窗
 *
 * 核心安全原则：
 * 1. 默认拒绝：任何未显式授权的操作（取消、关闭、按 ESC、销毁、队列溢出、超时、DOM缺失）一律返回 false；
 * 2. 文本隔离：所有展示内容使用 textContent 注入，防御 XSS 攻击；
 * 3. 队列防洪与串行化：限制最大排队数量，按序弹窗确认，无 DOM 时即刻释放不卡死队列；
 * 4. 超时安全：支持配置超时机制，定时器在所有结束分支严格清理；
 * 5. 对象防御：details 参数安全序列化，杜绝循环引用与巨型对象挂死。
 */

function formatDetails(details) {
  if (details === undefined || details === null) return '';
  const MAX_DETAILS_LENGTH = 4096;
  const TRUNCATED_SUFFIX = '\n... (truncated)';
  if (typeof details === 'string') {
    return details.length > MAX_DETAILS_LENGTH
      ? details.slice(0, MAX_DETAILS_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
      : details;
  }
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(details, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }, 2);
    if (!str) return '';
    return str.length > MAX_DETAILS_LENGTH
      ? str.slice(0, MAX_DETAILS_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
      : str;
  } catch (err) {
    return `[Unserializable details: ${String(err?.message || err)}]`;
  }
}

/**
 * 创建动作确认控制器
 * @param {object} [options]
 * @param {Document} [options.document] 宿主 DOM Document 对象
 * @param {number} [options.maxQueueSize] 最大排队上限，默认 10
 * @param {number} [options.timeoutMs] 单次确认超时毫秒数，默认 0（不自动超时）
 * @returns {{ confirm: (opts?: { title?: string, message?: string, details?: any }) => Promise<boolean>, close: () => void, cancelAll: () => void, isOpen: () => boolean, destroy: () => void }} 控制器接口
 */
export function createActionConfirmation({
  document: doc = globalThis.document,
  maxQueueSize = 10,
  timeoutMs = 60000
} = {}) {
  let container = null;
  let titleEl = null;
  let messageEl = null;
  let detailsEl = null;
  let cancelBtn = null;
  let allowBtn = null;

  let currentRequest = null;
  let currentTimer = null;
  const queue = [];

  function ensureDOM() {
    if (container || !doc || !doc.body) return;

    container = doc.createElement('div');
    container.className = 'h-confirm-overlay';
    container.style.display = 'none';

    const modal = doc.createElement('div');
    modal.className = 'h-confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const header = doc.createElement('div');
    header.className = 'h-confirm-header';
    titleEl = doc.createElement('h3');
    titleEl.className = 'h-confirm-title';
    header.appendChild(titleEl);

    const body = doc.createElement('div');
    body.className = 'h-confirm-body';
    messageEl = doc.createElement('p');
    messageEl.className = 'h-confirm-message';
    detailsEl = doc.createElement('pre');
    detailsEl.className = 'h-confirm-details';
    body.appendChild(messageEl);
    body.appendChild(detailsEl);

    const actions = doc.createElement('div');
    actions.className = 'h-confirm-actions';
    cancelBtn = doc.createElement('button');
    cancelBtn.className = 'h-confirm-btn h-confirm-btn-cancel';
    cancelBtn.textContent = '拒绝';

    allowBtn = doc.createElement('button');
    allowBtn.className = 'h-confirm-btn h-confirm-btn-allow';
    allowBtn.textContent = '允许执行';

    actions.appendChild(cancelBtn);
    actions.appendChild(allowBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);
    container.appendChild(modal);

    cancelBtn.addEventListener('click', () => {
      resolveCurrent(false);
    });

    allowBtn.addEventListener('click', () => {
      resolveCurrent(true);
    });

    // 默认点击遮罩或外部区域按拒绝处理
    container.addEventListener('click', (e) => {
      if (e.target === container) {
        resolveCurrent(false);
      }
    });

    // 全局按键监听
    if (doc.addEventListener) {
      doc.addEventListener('keydown', onKeyDown);
    }

    doc.body.appendChild(container);
  }

  function onKeyDown(e) {
    if (!currentRequest) return;
    if (e.key === 'Escape') {
      resolveCurrent(false);
    }
  }

  function clearCurrentTimer() {
    if (currentTimer) {
      clearTimeout(currentTimer);
      currentTimer = null;
    }
  }

  function clearQueuedTimer(item) {
    if (item && item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }
  }

  function expireQueued(item) {
    const idx = queue.indexOf(item);
    if (idx === -1) return;
    queue.splice(idx, 1);
    clearQueuedTimer(item);
    try {
      item.resolve(false);
    } catch {
      // 忽略外界回调异常
    }
  }

  function resolveCurrent(allowed) {
    clearCurrentTimer();
    if (!currentRequest) return;
    const req = currentRequest;
    currentRequest = null;
    hide();
    try {
      req.resolve(Boolean(allowed));
    } catch {
      // 忽略外界回调异常
    }
    processNext();
  }

  function show(req) {
    ensureDOM();
    if (!container) {
      currentRequest = null;
      try {
        req.resolve(false);
      } catch {
        // ignore
      }
      processNext();
      return;
    }

    titleEl.textContent = req.title || '操作确认';
    messageEl.textContent = req.message || '是否允许此卡片执行该操作？';

    const formatted = formatDetails(req.details);
    if (formatted) {
      detailsEl.textContent = formatted;
      detailsEl.style.display = 'block';
    } else {
      detailsEl.textContent = '';
      detailsEl.style.display = 'none';
    }

    if (req.deadline > 0) {
      const remaining = req.deadline - Date.now();
      if (remaining <= 0) {
        resolveCurrent(false);
        return;
      }
      currentTimer = setTimeout(() => {
        resolveCurrent(false);
      }, remaining);
    }

    container.style.display = 'flex';
  }

  function hide() {
    if (container) {
      container.style.display = 'none';
    }
  }

  function processNext() {
    if (currentRequest || queue.length === 0) return;
    const item = queue.shift();
    clearQueuedTimer(item);
    if (item.deadline > 0 && item.deadline <= Date.now()) {
      try { item.resolve(false); } catch { /* ignore */ }
      processNext();
      return;
    }
    currentRequest = item;
    show(currentRequest);
  }

  /**
   * 唤起操作确认
   * @param {object} [params]
   * @param {string} [params.title] 标题
   * @param {string} [params.message] 提示消息
   * @param {any} [params.details] 详细参数信息
   * @returns {Promise<boolean>}
   */
  function confirm({ title, message, details } = {}) {
    return new Promise((resolve) => {
      const item = {
        title,
        message,
        details,
        resolve,
        deadline: timeoutMs > 0 ? Date.now() + timeoutMs : 0,
        timer: null
      };
      if (!currentRequest) {
        currentRequest = item;
        show(item);
      } else {
        if (queue.length >= maxQueueSize) {
          // 防洪保护：超出队列容量直接默认拒绝
          resolve(false);
          return;
        }
        if (item.deadline > 0) {
          // 排队期间也开始计时，不能等弹窗展示时才起算
          item.timer = setTimeout(() => expireQueued(item), timeoutMs);
        }
        queue.push(item);
      }
    });
  }

  function close() {
    resolveCurrent(false);
  }

  function cancelAll() {
    clearCurrentTimer();
    while (queue.length > 0) {
      const req = queue.shift();
      clearQueuedTimer(req);
      try { req.resolve(false); } catch { /* ignore */ }
    }
    if (currentRequest) {
      resolveCurrent(false);
    }
  }

  function isOpen() {
    return Boolean(currentRequest);
  }

  function destroy() {
    cancelAll();
    if (doc.removeEventListener) {
      doc.removeEventListener('keydown', onKeyDown);
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  }

  return {
    confirm,
    close,
    cancelAll,
    isOpen,
    destroy
  };
}
