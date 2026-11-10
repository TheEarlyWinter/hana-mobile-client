/* web/message-search.js — 消息与会话搜索面板
 *
 * 宿主搜索能力分析结论：
 *   宿主服务端原生提供了完整的搜索接口：GET /api/sessions/search
 *   支持参数：
 *     - q: 搜索关键词
 *     - phase: "title"（会话标题）或 "content"（消息全文）
 *     - limit: 返回上限（默认 30，最大 50）
 *     - namespace: "home" | "code"
 *   返回包含命中片段（snippet）、匹配阶段（matchKind）及对应会话路径（path）与 sessionId。
 *   若在无网络或离线场景下由父代理降级为「本地过滤」，则受限于客户端内存，
 *   仅能检索已加载到内存中的会话列表标题与首包正文，无法检索远端全量历史消息。
 *
 * 设计纪律：
 *   - 严格解耦：零外部模块 import，所有依赖（document, container, onSearch, onSelect, onClose）均由参数注入
 *   - 面板由模块独立挂载与管理，关闭与销毁具备完备生命周期清理
 *   - 安全：高亮渲染严格进行 HTML 转义，杜绝 XSS
 *   - 三态文案：区分加载中、空结果及具体的错误原因（网络连接异常 vs 服务端接口不存在 404 等）
 */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function highlightSnippet(text, query) {
  const safe = escapeHtml(text || '');
  const q = String(query || '').trim();
  if (!q) return safe;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(escaped, 'gi'), (m) => `<mark class="search-highlight">${m}</mark>`);
}

function formatTime(val) {
  if (!val) return '';
  const ts = typeof val === 'number' ? val : Date.parse(val);
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${m}-${day} ${h}:${min}`;
}

function formatError(err) {
  if (!err) return '搜索遇到未知问题';
  const msg = typeof err === 'string' ? err : (err.message || '');
  const status = err.status || (typeof err.code === 'number' ? err.code : 0);
  if (status === 404 || /404|not\s*found|接口不存在/i.test(msg)) {
    return '搜索服务不可用（服务端未提供搜索接口）';
  }
  if (status === 403 || /403|unauthorized|forbidden|权限/i.test(msg)) {
    return '搜索权限不足，请确认登录凭据状态';
  }
  if (err.name === 'AbortError' || /abort|timeout|超时/i.test(msg)) {
    return '搜索请求超时，请检查网络连接后重试';
  }
  if (err instanceof TypeError || /failed to fetch|network|网络/i.test(msg)) {
    return '网络连接异常，请检查网络设置';
  }
  return `搜索请求失败：${msg || '未知错误'}`;
}

/**
 * 创建消息搜索组件实例
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 容器所在的文档对象
 * @param {HTMLElement} [options.container] 搜索面板挂载的父容器（默认 document.body）
 * @param {(query: string) => Promise<Array<{sessionTitle?: string, snippet?: string, path: string, sessionId?: string, timestamp?: number|string}>>} [options.onSearch] 搜索异步回调
 * @param {(result: object) => void} [options.onSelect] 选中单项搜索结果的回调
 * @param {() => void} [options.onClose] 面板关闭时的回调
 * @param {number} [options.debounceMs] 输入防抖延时（默认 150ms，测试中可传 0 立即触发）
 */
export function createMessageSearch({
  document: doc = globalThis.document,
  window: winOption,
  container,
  onSearch,
  onSelect,
  onClose,
  debounceMs = 150,
} = {}) {
  if (!doc) throw new TypeError('createMessageSearch requires a valid document object');
  const targetContainer = container || doc.body;

  let _isOpen = false;
  let _activeTimer = null;
  let _searchSeq = 0;
  let _viewportBound = false;
  // 真机上 doc.defaultView 就是 window；测试的假 DOM 没有这个属性，所以也允许显式传入。
  const win = winOption || doc.defaultView || null;

  // DOM 元素构建
  const root = doc.createElement('div');
  root.className = 'message-search-overlay';
  root.hidden = true;

  const dialog = doc.createElement('div');
  dialog.className = 'message-search-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = doc.createElement('div');
  header.className = 'message-search-header';

  const inputWrap = doc.createElement('div');
  inputWrap.className = 'message-search-input-wrap';

  const input = doc.createElement('input');
  input.type = 'search';
  input.className = 'message-search-input';
  input.placeholder = '搜索会话或消息内容...';
  input.setAttribute('aria-label', '搜索关键词');

  const clearBtn = doc.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'message-search-clear';
  clearBtn.title = '清空输入';
  clearBtn.textContent = '✕';
  clearBtn.hidden = true;

  inputWrap.appendChild(input);
  inputWrap.appendChild(clearBtn);

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'message-search-close';
  closeBtn.textContent = '取消';

  header.appendChild(inputWrap);
  header.appendChild(closeBtn);

  const body = doc.createElement('div');
  body.className = 'message-search-body';

  const statusEl = doc.createElement('div');
  statusEl.className = 'message-search-status';
  statusEl.hidden = true;

  const listEl = doc.createElement('ul');
  listEl.className = 'message-search-results';

  body.appendChild(statusEl);
  body.appendChild(listEl);

  dialog.appendChild(header);
  dialog.appendChild(body);
  root.appendChild(dialog);

  if (targetContainer && typeof targetContainer.appendChild === 'function') {
    targetContainer.appendChild(root);
  }

  function clearTimer() {
    if (_activeTimer !== null) {
      clearTimeout(_activeTimer);
      _activeTimer = null;
    }
  }

  function renderResults(items, query) {
    listEl.innerHTML = '';
    for (const item of items) {
      if (!item) continue;
      const li = doc.createElement('li');
      li.className = 'message-search-item';

      const itemHeader = doc.createElement('div');
      itemHeader.className = 'message-search-item-header';

      const titleSpan = doc.createElement('span');
      titleSpan.className = 'message-search-item-title';
      titleSpan.textContent = item.sessionTitle || item.title || '未命名会话';

      const timeSpan = doc.createElement('span');
      timeSpan.className = 'message-search-item-time';
      timeSpan.textContent = formatTime(item.timestamp || item.modified);

      itemHeader.appendChild(titleSpan);
      itemHeader.appendChild(timeSpan);
      li.appendChild(itemHeader);

      const snippetDiv = doc.createElement('div');
      snippetDiv.className = 'message-search-item-snippet';
      snippetDiv.innerHTML = highlightSnippet(item.snippet || item.firstMessage || '', query);
      li.appendChild(snippetDiv);

      li.addEventListener('click', () => {
        if (typeof onSelect === 'function') {
          onSelect(item);
        }
        close();
      });

      listEl.appendChild(li);
    }
  }

  async function executeSearch(query) {
    const q = (query || '').trim();
    if (!q) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      listEl.innerHTML = '';
      return;
    }

    if (typeof onSearch !== 'function') {
      statusEl.hidden = false;
      statusEl.textContent = '未配置搜索处理程序';
      listEl.innerHTML = '';
      return;
    }

    _searchSeq += 1;
    const currentSeq = _searchSeq;

    statusEl.hidden = false;
    statusEl.textContent = '正在搜索消息...';
    listEl.innerHTML = '';

    try {
      const results = await onSearch(q);
      if (currentSeq !== _searchSeq || !_isOpen) return;

      if (!results || !Array.isArray(results) || results.length === 0) {
        statusEl.hidden = false;
        statusEl.textContent = '未找到相关消息';
        listEl.innerHTML = '';
        return;
      }

      statusEl.hidden = true;
      statusEl.textContent = '';
      renderResults(results, q);
    } catch (err) {
      if (currentSeq !== _searchSeq || !_isOpen) return;
      statusEl.hidden = false;
      statusEl.textContent = formatError(err);
      listEl.innerHTML = '';
    }
  }

  function handleInput() {
    if (!_isOpen) return;
    const val = input.value;
    clearBtn.hidden = !val;

    clearTimer();
    if (debounceMs <= 0) {
      executeSearch(val);
    } else {
      _activeTimer = setTimeout(() => {
        executeSearch(input.value);
      }, debounceMs);
    }
  }

  function handleClear() {
    input.value = '';
    clearBtn.hidden = true;
    clearTimer();
    statusEl.hidden = true;
    statusEl.textContent = '';
    listEl.innerHTML = '';
    input.focus?.();
  }

  function open() {
    if (_isOpen) return;
    _isOpen = true;
    root.hidden = false;
    // 软键盘顶着的时候，100vh 还是整个屏幕，结果列表下半截会被盖住。
    // 用 visualViewport 的高度差算出被遮住的高度，写进 --kb 让样式让位。
    bindViewport();
    syncKeyboardInset();
    input.focus?.();
  }

  function close() {
    if (!_isOpen) return;
    _isOpen = false;
    root.hidden = true;
    unbindViewport();
    // 别把 --kb 留给别的视图：它属于这次搜索面板的临时状态
    setKeyboardInset(0);
    clearTimer();
    if (typeof onClose === 'function') {
      onClose();
    }
  }

  /** 把被软键盘遮住的高度写到 :root 的 --kb 上，目前只在本面板打开期间维护。 */
  function setKeyboardInset(px) {
    const rootEl = doc.documentElement;
    if (rootEl && rootEl.style && typeof rootEl.style.setProperty === 'function') {
      rootEl.style.setProperty('--kb', `${px}px`);
    }
  }

  function syncKeyboardInset() {
    const vv = win && win.visualViewport;
    if (!vv) {
      setKeyboardInset(0);
      return;
    }
    const innerH = Number(win.innerHeight) || 0;
    const visibleH = Number(vv.height) || 0;
    if (!innerH || !visibleH) return;
    setKeyboardInset(Math.max(0, Math.round(innerH - visibleH)));
  }

  function bindViewport() {
    if (!win) return;
    const vv = win.visualViewport;
    if (vv && typeof vv.addEventListener === 'function') vv.addEventListener('resize', syncKeyboardInset);
    if (typeof win.addEventListener === 'function') win.addEventListener('resize', syncKeyboardInset);
    _viewportBound = true;
  }

  function unbindViewport() {
    if (!win || !_viewportBound) return;
    const vv = win.visualViewport;
    if (vv && typeof vv.removeEventListener === 'function') vv.removeEventListener('resize', syncKeyboardInset);
    if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', syncKeyboardInset);
    _viewportBound = false;
  }

  function isOpen() {
    return _isOpen;
  }

  function destroy() {
    close();
    input.value = '';
    if (listEl) listEl.innerHTML = '';
    input.removeEventListener('input', handleInput);
    clearBtn.removeEventListener('click', handleClear);
    closeBtn.removeEventListener('click', close);
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

  // 挂载交互监听
  input.addEventListener('input', handleInput);
  clearBtn.addEventListener('click', handleClear);
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    open,
    close,
    isOpen,
    destroy,
  };
}
