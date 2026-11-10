/* web/toast.js — 读到完的提示条（E5）
 *
 * 原来的 flash() 是「4 秒自灭的浮条」：长报错根本读不完，正文被挤在小字号里，
 * 也没有任何关闭入口；出错本身又最需要用户看清。这里把显示逻辑收成一个可注入
 * 依赖的工厂，app.js 只保留同名的 flash() 做接线，十几个把 flash 当依赖注入的
 * 模块（chat-renderer / conversation-controller / event-router / composer-controller …）
 * 一行都不用改。
 *
 * 契约：
 *   createToaster({ doc, mount, now }) -> { show(text, opts), dismiss(id), clear(), dispose() }
 *   show(text, { level = 'error', detail = '' })
 *
 * 行为：
 *   1. level:'error' 是业务性错误，**不自动消失**，必须点 ✕ 关；level:'info' 3 秒后自消；
 *   2. 长文本（超过 120 字或带换行）先折成 2 行 + 「展开」，展开后限高 40vh 可滚动；
 *   3. 带 detail（Error.stack、原始报错文本）时给「详情」入口，点开显示等宽原文，可复制；
 *   4. 同时最多 3 条，第 4 条进来时最旧的一条自动关掉；
 *   5. 同一文案在 2 秒内重复出现就合并成一条，计数显示 ×2，不刷屏；
 *   6. 容器 role="status"，错误条 role="alert"，✕ 有 aria-label。
 *
 * 两个刻意的设计：
 *   - 根节点仍叫 #flashBar：既有测试和样式都按这个 id 找它，改名是没有收益的破坏。
 *   - 根节点每次 show 都用 doc.getElementById 重新解析，不缓存死引用：退出登录、
 *     页面清空这类路径会把整棵提示树摘掉，能自愈才能保证下一条错误一定看得见。
 */

/** 根节点 id（对外契约：测试与样式都按它找）。 */
export const ROOT_ID = 'flashBar';
/** 同时最多显示几条。 */
export const MAX_VISIBLE = 3;
/** info 自动消失的时间。 */
export const INFO_TIMEOUT_MS = 3000;
/** 同文案合并窗口。 */
export const MERGE_WINDOW_MS = 2000;
/** 超过这个字数（或带换行）就要折叠。 */
export const LONG_TEXT_LIMIT = 120;
/** 详情原文上限：一条超长 stack 不该把 DOM 和内存撑爆。 */
const MAX_DETAIL_CHARS = 8000;
const DETAIL_TRUNCATED_SUFFIX = '\n…（详情过长，已截断）';

/**
 * 造一个提示条工厂。不摸全局 document，所有依赖从参数进，便于假 DOM 测试。
 *
 * @param {object} [options]
 * @param {Document} [options.doc] 宿主 document
 * @param {Element} [options.mount] 挂载点，默认 doc.body
 * @param {() => number} [options.now] 取当前时间（合并窗口与计时都走它）
 * @returns {{ show: Function, dismiss: Function, clear: Function, dispose: Function }}
 */
export function createToaster({ doc = globalThis.document, mount = null, now = () => Date.now() } = {}) {
  const host = mount || (doc && doc.body) || null;
  const clock = typeof now === 'function' ? now : () => Date.now();

  /** 显示中的提示，按加入顺序排；数组长度为 0 时整棵树收起。 */
  const records = [];
  /** 当前根节点。每次 ensureRoot 会重新解析，所以它只是「上一次的引用」。 */
  let root = null;
  let disposed = false;
  let seq = 0;

  /* ------------------------------ 小工具 ------------------------------ */

  function make(tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function setTimer(fn, ms) {
    const view = doc && doc.defaultView;
    if (view && typeof view.setTimeout === 'function') return view.setTimeout(fn, ms);
    if (typeof globalThis.setTimeout === 'function') return globalThis.setTimeout(fn, ms);
    return null;
  }

  function clearTimer(handle) {
    if (handle == null) return;
    const view = doc && doc.defaultView;
    if (view && typeof view.clearTimeout === 'function') {
      view.clearTimeout(handle);
      return;
    }
    if (typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(handle);
  }

  function isLong(text) {
    return text.length > LONG_TEXT_LIMIT || text.includes('\n');
  }

  function truncateDetail(detail) {
    if (detail.length <= MAX_DETAIL_CHARS) return detail;
    return detail.slice(0, MAX_DETAIL_CHARS - DETAIL_TRUNCATED_SUFFIX.length) + DETAIL_TRUNCATED_SUFFIX;
  }

  /* ------------------------------ 根节点 ------------------------------ */

  function ensureRoot() {
    if (disposed || !host) return null;
    let node = null;
    if (doc && typeof doc.getElementById === 'function') node = doc.getElementById(ROOT_ID);
    if (!node) {
      node = make('div');
      node.id = ROOT_ID;
    }
    node.classList.add('toast-stack');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    if (root && root !== node) {
      // 根被外部换掉（页面清空 / 退出登录重建）：还活着的提示搬过去，别丢用户没读的报错
      for (const rec of records) {
        if (rec.el.parentNode !== node) node.appendChild(rec.el);
      }
    }
    root = node;
    if (node.parentNode !== host) host.appendChild(node);
    return node;
  }

  function syncRoot() {
    if (!root) return;
    root.hidden = records.length === 0;
  }

  /* ------------------------------ 单条提示 ------------------------------ */

  function applyLevel(rec) {
    rec.el.className = `toast toast--${rec.level}`;
    rec.el.setAttribute('data-level', rec.level);
    if (rec.level === 'error') rec.el.setAttribute('role', 'alert');
    // 极简假 DOM 未必实现 removeAttribute；info 本来就不该带 role，缺方法时跳过即可
    else if (typeof rec.el.removeAttribute === 'function') rec.el.removeAttribute('role');
  }

  function buildToast(rec) {
    const el = make('div', 'toast');
    // 先挂回 rec：后面的 applyLevel / 事件回调都按 rec.el 找这条提示
    rec.el = el;
    el.setAttribute('data-toast-id', String(rec.id));

    const row = make('div', 'toast-row');

    rec.textEl = make('div', 'toast-text', rec.text);
    rec.long = isLong(rec.text);
    if (rec.long) rec.textEl.classList.add('is-clamped');

    const actions = make('div', 'toast-actions');

    // 「展开」：长文本折成 2 行时才出现。
    rec.expandBtn = make('button', 'toast-btn toast-expand', '展开');
    rec.expandBtn.setAttribute('type', 'button');
    rec.expandBtn.setAttribute('aria-label', '展开全文');
    rec.expandBtn.setAttribute('aria-expanded', 'false');
    rec.expandBtn.hidden = !rec.long;
    rec.expandBtn.addEventListener('click', () => toggleExpand(rec));
    actions.appendChild(rec.expandBtn);

    // 「详情」：原始报错文本（Error.stack 等）。没有 detail 时收起来，合并时再显示。
    rec.detailBtn = make('button', 'toast-btn toast-detail-btn', '详情');
    rec.detailBtn.setAttribute('type', 'button');
    rec.detailBtn.setAttribute('aria-label', '查看详情');
    rec.detailBtn.setAttribute('aria-expanded', 'false');
    rec.detailBtn.hidden = true;
    rec.detailBtn.addEventListener('click', () => toggleDetail(rec));
    actions.appendChild(rec.detailBtn);

    // 合并计数：只有 reopen 过才显示。
    rec.countEl = make('span', 'toast-count', '');
    rec.countEl.hidden = true;

    rec.closeBtn = make('button', 'toast-btn toast-close', '✕');
    rec.closeBtn.setAttribute('type', 'button');
    rec.closeBtn.setAttribute('aria-label', '关闭提示');
    rec.closeBtn.addEventListener('click', () => {
      if (!disposed) close(rec);
    });
    actions.appendChild(rec.closeBtn);

    row.appendChild(rec.textEl);
    row.appendChild(rec.countEl);
    row.appendChild(actions);
    el.appendChild(row);

    // 详情面板：等宽、可选中、可滚动。
    rec.panelEl = make('div', 'toast-detail-wrap');
    rec.panelEl.hidden = true;
    const panelHead = make('div', 'toast-detail-head');
    panelHead.appendChild(make('span', 'toast-detail-label', '详情'));
    rec.copyBtn = make('button', 'toast-btn toast-copy', '复制');
    rec.copyBtn.setAttribute('type', 'button');
    rec.copyBtn.setAttribute('aria-label', '复制详情');
    rec.copyBtn.addEventListener('click', () => copyDetail(rec));
    panelHead.appendChild(rec.copyBtn);
    rec.detailEl = make('pre', 'toast-detail', '');
    rec.panelEl.appendChild(panelHead);
    rec.panelEl.appendChild(rec.detailEl);
    el.appendChild(rec.panelEl);

    applyLevel(rec);
    return el;
  }

  function renderCount(rec) {
    const repeated = rec.count > 1;
    rec.countEl.textContent = repeated ? `×${rec.count}` : '';
    rec.countEl.hidden = !repeated;
    if (repeated) rec.countEl.setAttribute('aria-label', `重复 ${rec.count} 次`);
    else rec.countEl.removeAttribute?.('aria-label');
  }

  function toggleExpand(rec) {
    if (disposed) return;
    rec.expanded = !rec.expanded;
    // 用 add/remove 而不是 classList.toggle：项目里的极简假 DOM 未必实现 toggle
    if (rec.expanded) {
      rec.textEl.classList.remove('is-clamped');
      rec.textEl.classList.add('is-expanded');
    } else {
      rec.textEl.classList.remove('is-expanded');
      rec.textEl.classList.add('is-clamped');
    }
    rec.expandBtn.textContent = rec.expanded ? '收起' : '展开';
    rec.expandBtn.setAttribute('aria-label', rec.expanded ? '收起全文' : '展开全文');
    rec.expandBtn.setAttribute('aria-expanded', rec.expanded ? 'true' : 'false');
  }

  function toggleDetail(rec) {
    if (disposed || !rec.detail) return;
    rec.detailOpen = !rec.detailOpen;
    rec.panelEl.hidden = !rec.detailOpen;
    rec.detailBtn.textContent = rec.detailOpen ? '收起详情' : '详情';
    rec.detailBtn.setAttribute('aria-expanded', rec.detailOpen ? 'true' : 'false');
  }

  function setDetail(rec, detail) {
    const text = detail == null ? '' : String(detail);
    rec.detail = text ? truncateDetail(text) : '';
    rec.detailEl.textContent = rec.detail;
    rec.detailBtn.hidden = !rec.detail;
    if (!rec.detail) {
      rec.detailOpen = false;
      rec.panelEl.hidden = true;
      rec.detailBtn.textContent = '详情';
      rec.detailBtn.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * 复制详情原文。手机 WebView 里 navigator.clipboard 常常没有，退回 execCommand；
   * 两条路都不通就只改按钮文案，绝不抛出去打断主流程。
   */
  function copyDetail(rec) {
    const text = rec.detail || '';
    if (!text) return;
    let done = false;
    try {
      const nav = (doc && doc.defaultView && doc.defaultView.navigator) || globalThis.navigator;
      const clipboard = nav && nav.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') {
        Promise.resolve(clipboard.writeText(text)).then(
          () => { if (!disposed && !rec.closed) rec.copyBtn.textContent = '已复制'; },
          () => { if (!disposed && !rec.closed) rec.copyBtn.textContent = '复制失败'; },
        );
        return;
      }
      done = legacyCopy(text);
    } catch {
      done = false;
    }
    if (!disposed) rec.copyBtn.textContent = done ? '已复制' : '复制失败';
  }

  /** 老路子：临时 textarea + execCommand('copy')。 */
  function legacyCopy(text) {
    try {
      const area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      (doc.body || host).appendChild(area);
      if (typeof area.select === 'function') area.select();
      const ok = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
      if (area.parentNode) area.parentNode.removeChild(area);
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  function stopTimer(rec) {
    if (rec.timer != null) {
      clearTimer(rec.timer);
      rec.timer = null;
    }
  }

  function startTimer(rec) {
    stopTimer(rec);
    if (rec.level !== 'info') return;
    rec.timer = setTimer(() => {
      rec.timer = null;
      close(rec);
    }, INFO_TIMEOUT_MS);
  }

  function close(rec) {
    if (!rec || rec.closed) return;
    rec.closed = true;
    stopTimer(rec);
    const index = records.indexOf(rec);
    if (index !== -1) records.splice(index, 1);
    if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    syncRoot();
  }

  /** 元素被外部摘掉（例如有人把根节点 textContent 清空）时，记录也要跟着失效。 */
  function pruneDetached() {
    if (!root) return;
    for (const rec of records.slice()) {
      if (rec.el.parentNode !== root) {
        stopTimer(rec);
        rec.closed = true;
        records.splice(records.indexOf(rec), 1);
      }
    }
  }

  function snapshot(rec) {
    return {
      id: rec.id,
      text: rec.text,
      level: rec.level,
      count: rec.count,
      detail: rec.detail,
    };
  }

  /**
   * 显示一条提示。
   * @param {string} text 正文（必填，空串直接忽略）
   * @param {{ level?: 'error'|'info', detail?: string }} [opts]
   * @returns {object|null} 这条提示的快照；被忽略或实例已销毁时返回 null
   */
  function show(text, opts = {}) {
    if (disposed) return null;
    const message = text == null ? '' : String(text);
    if (!message) return null;
    const options = opts || {};
    const level = options.level === 'info' ? 'info' : 'error';
    const detail = options.detail == null ? '' : String(options.detail);
    const stamp = Number(clock()) || 0;

    pruneDetached();
    const stack = ensureRoot();
    if (!stack) return null;

    // 同一文案 2 秒内重复出现：合并到已有那条，计数 +1，不刷屏。
    const twin = records.find((rec) => rec.text === message && stamp >= rec.at && stamp - rec.at <= MERGE_WINDOW_MS);
    if (twin) {
      twin.count += 1;
      twin.at = stamp;
      renderCount(twin);
      if (level === 'error' && twin.level !== 'error') {
        // 同一句话升级成错误：原来的 info 计时必须停掉，否则用户还没看就消失了
        twin.level = 'error';
        applyLevel(twin);
        stopTimer(twin);
      } else {
        startTimer(twin);
      }
      if (detail && !twin.detail) setDetail(twin, detail);
      return snapshot(twin);
    }

    const rec = {
      id: ++seq,
      text: message,
      level,
      detail: '',
      count: 1,
      at: stamp,
      closed: false,
      expanded: false,
      detailOpen: false,
      long: false,
      timer: null,
    };
    rec.el = buildToast(rec);
    records.push(rec);
    stack.appendChild(rec.el);
    if (detail) setDetail(rec, detail);
    renderCount(rec);
    startTimer(rec);

    // 最多 3 条：超出时最旧的一条自动关（records 按加入顺序，[0] 就是最旧的）
    while (records.length > MAX_VISIBLE) close(records[0]);

    syncRoot();
    return snapshot(rec);
  }

  /** 清空所有提示（不动实例，之后还能继续 show）。 */
  function clear() {
    for (const rec of records.slice()) close(rec);
    pruneDetached();
  }

  /**
   * 关掉指定那一条（按 show 返回的 id）。
   *
   * 给「先报错、后恢复」的场景用：错误提示常驻是故意的，但状态真恢复了就得把旧话收掉，
   * 否则屏幕上同时写着「没加载成功」和「已重新加载」。id 已关或不存在时什么事都不做。
   */
  function dismiss(id) {
    const rec = records.find((item) => item.id === id);
    if (!rec) return;
    close(rec);
    syncRoot();
  }

  /** 销毁实例：清计时器、摘掉整棵提示树，之后 show / clear 都不再碰 DOM。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const rec of records.slice()) {
      rec.closed = true;
      stopTimer(rec);
    }
    records.length = 0;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  return { show, dismiss, clear, dispose };
}
