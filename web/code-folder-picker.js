/* web/code-folder-picker.js — 新建 Code 会话时的目录选择器（移动端）
 *
 * 为什么要它：
 * 宿主 POST /api/sessions/new 强制要求请求里点名 cwd，且必须是「绝对路径 + 真实存在」，
 * 否则直接 400 code_repository_required。手机端没有文件系统选择器，原来只能复用列表里
 * 最近一个 Code 会话的 cwd（web/app.js 的 codeFolderForNewSession），列表里没有 Code
 * 会话时就没有任何办法。宿主其实已经有工作区根数据（GET /api/studio/workspaces），
 * workspace-service.js 的 listRoots() 就是现成的封装。
 *
 * 管什么：
 *  - createCodeFolderPicker({ doc, mount, listRoots }) 造一个模态选择器，返回
 *    { open({ title }) → Promise<string|null>, close(), isOpen(), getState() }；
 *  - open() 里调 listRoots() 拿工作区根，先列 nativeRootPath 非空且 rootAvailable === true 的；
 *    再把 payload.recent（会话历史里的 cwd）接在后面并标「最近」——宿主只对 loopback 披露
 *    nativeRootPath，远端客户端（手机）拿到的工作区永远没路径，只剩这条可用；
 *  - 每项显示 label + 路径（中间省略，title 给全路径），点一项返回该 nativeRootPath 原样字符串；
 *  - 底部固定「手动输入路径」：trim 后非空即返回，不在这里校验存在性（宿主管）；
 *  - 没有可用根 / 读取失败时不留白：空态与错误态都写明原因，手动输入仍然可用，错误态可「重试」；
 *  - 取消 / 关闭按钮 / 点背景 / Esc 一律 resolve(null) 并清掉 DOM；一个实例重复 open() 先收尾上一次。
 *
 * 不管什么：
 *  - 不碰 app.js / index.html / style.css / workspace-service.js：类名统一 code-folder- 前缀，
 *    样式在 web/code-folder-picker.css，装配与样式登记由主代理做；
 *  - 不自己发请求、不读全局状态：listRoots 是注入的依赖（正式接线传 workspaceService.listRoots）；
 *  - 不校验路径是否存在、不改写分隔符、不拼路径，宿主才是权威。
 *
 * 依赖注入：doc / mount / listRoots / keyTarget 都从参数进，模块顶层不摸 document，方便假 DOM 测试。
 */

/** 路径中间省略的目标长度（含省略号）。手机窄屏下一行放得下 42 个等宽字符左右。 */
export const MAX_PATH_CHARS = 42;

const DEFAULT_TITLE = '选择代码目录';

/* ------------------------------ 纯函数 ------------------------------ */

/**
 * 路径太长时保留头尾、中间用省略号，避免只看到盘符或只看到项目名。
 *
 * @param {string} value 完整路径
 * @param {number} [maxChars] 目标长度（含省略号），至少 4
 * @returns {string} 省略后的显示文本（短路径原样返回）
 */
export function shortenMiddle(value, maxChars = MAX_PATH_CHARS) {
  const text = typeof value === 'string' ? value : '';
  const limit = Number.isFinite(maxChars) && maxChars >= 4 ? Math.floor(maxChars) : MAX_PATH_CHARS;
  if (text.length <= limit) return text;
  const keep = limit - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function basenameOf(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path);
}

/**
 * 从 listRoots() 的返回值里挑出「能当代码目录」的根。纯函数，不碰 DOM。
 *
 * 只认 nativeRootPath 非空字符串 + rootAvailable === true 的项：
 * 没有本机真实路径的根（远端挂载）没法给宿主当 cwd；rootAvailable 为假的目录
 * 宿主自己也打不开，列出来只会让用户点了再失败。
 *
 * @param {object|Array} payload listRoots() 的返回值（{ workspaces: [...], recent: [...] } 或数组）
 * @returns {Array<{mountId: string, label: string, path: string, source: 'workspace'|'recent'}>}
 */
export function pickUsableRoots(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.workspaces) ? payload.workspaces : []);
  const recent = Array.isArray(payload?.recent) ? payload.recent : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.rootAvailable !== true) continue;
    const raw = item.nativeRootPath;
    if (typeof raw !== 'string') continue;
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim()
      : basenameOf(path);
    out.push({
      mountId: typeof item.mountId === 'string' ? item.mountId : '',
      label,
      path,
      source: 'workspace',
    });
  }
  // 远端客户端拿不到工作区绝对路径（宿主只对 loopback 披露），但会话列表里的 cwd 是合法数据。
  // 这类候选排在后面，标成「最近」：它们是历史值，可能已经不存在，不宣称是工作区。
  for (const item of recent) {
    const raw = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? (item.path ?? item.cwd) : null);
    if (typeof raw !== 'string') continue;
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const label = item && typeof item === 'object' && typeof item.label === 'string' && item.label.trim()
      ? item.label.trim()
      : basenameOf(path);
    out.push({ mountId: '', label, path, source: 'recent' });
  }
  return out;
}

/* ------------------------------ 工厂 ------------------------------ */

let instanceSeq = 0;

/**
 * 造一个目录选择器。
 *
 * @param {object} options
 * @param {Document} [options.doc] 默认 globalThis.document
 * @param {Element} [options.mount] 挂载容器，默认 doc.body
 * @param {() => Promise<object>} options.listRoots 工作区根来源（正式接线传 workspaceService.listRoots）
 * @param {EventTarget} [options.keyTarget] Esc 的监听挂点，默认 doc（假 DOM 的 document 不转发
 *   key 字段，测试可以换成普通节点）
 * @returns {{open: Function, close: Function, isOpen: Function, getState: Function}}
 */
export function createCodeFolderPicker({
  doc = globalThis.document,
  mount = null,
  listRoots,
  keyTarget = null,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createCodeFolderPicker 需要一个能 createElement 的 document');
  }
  const host = mount || doc.body;
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createCodeFolderPicker 需要一个能 appendChild 的挂载容器');
  }
  if (typeof listRoots !== 'function') {
    throw new TypeError('createCodeFolderPicker 需要 listRoots 函数（例如 workspaceService.listRoots）');
  }

  const keyHost = keyTarget && typeof keyTarget.addEventListener === 'function' ? keyTarget : doc;

  instanceSeq += 1;
  const titleId = `code-folder-title-${instanceSeq}`;
  const inputId = `code-folder-input-${instanceSeq}`;

  const state = {
    open: false,
    generation: 0,
    /** 当前这次 open() 的 { generation, resolve }；null 表示没有悬挂的 Promise。 */
    pending: null,
    roots: [],
    error: '',
  };

  let root = null;
  let sheet = null;
  let statusEl = null;
  let hintEl = null;
  let listEl = null;
  let inputEl = null;
  let manualErrorEl = null;
  let retryBtn = null;

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const setAttrs = (node, attrs) => {
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  };

  const makeButton = (cls, label, text) => {
    const btn = el('button', `${cls} code-folder-btn`, text);
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    return btn;
  };

  /* --------------------------- 文案状态 --------------------------- */

  function setStatus(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = tone ? `code-folder-status is-${tone}` : 'code-folder-status';
  }

  function setHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text || '';
    hintEl.hidden = !text;
  }

  function showManualError(text) {
    if (!manualErrorEl) return;
    manualErrorEl.textContent = text || '';
    manualErrorEl.hidden = !text;
  }

  function setRetryVisible(visible) {
    if (retryBtn) retryBtn.hidden = !visible;
  }

  /* --------------------------- DOM 构建 --------------------------- */

  function build(title) {
    root = el('div', 'code-folder-root');
    setAttrs(root, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    root.addEventListener('click', onBackdropClick);

    sheet = el('div', 'code-folder-sheet');
    sheet.setAttribute('tabindex', '-1');

    const head = el('div', 'code-folder-head');
    const titleEl = el('h2', 'code-folder-title', title);
    titleEl.id = titleId;
    const closeBtn = makeButton('code-folder-close', '关闭目录选择', '×');
    closeBtn.setAttribute('title', '关闭');
    closeBtn.addEventListener('click', () => cancel());
    head.appendChild(titleEl);
    head.appendChild(closeBtn);

    const body = el('div', 'code-folder-body');
    statusEl = el('p', 'code-folder-status is-loading', '正在读取工作区目录…');
    setAttrs(statusEl, { role: 'status', 'aria-live': 'polite' });
    hintEl = el('p', 'code-folder-hint');
    hintEl.hidden = true;
    listEl = el('ul', 'code-folder-list');
    listEl.hidden = true;

    const manual = el('div', 'code-folder-manual');
    const manualLabel = el('label', 'code-folder-manual-label', '手动输入路径');
    manualLabel.setAttribute('for', inputId);
    const manualRow = el('div', 'code-folder-manual-row');
    inputEl = doc.createElement('input');
    inputEl.className = 'code-folder-input';
    inputEl.id = inputId;
    inputEl.type = 'text';
    setAttrs(inputEl, {
      inputmode: 'text',
      autocapitalize: 'off',
      autocorrect: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '例如 C:\\work\\my-project',
      'aria-label': '代码目录绝对路径',
    });
    inputEl.addEventListener('keydown', onInputKeyDown);
    inputEl.addEventListener('input', () => showManualError(''));
    const submitBtn = makeButton('code-folder-submit', '使用手动输入的路径', '使用');
    submitBtn.addEventListener('click', () => submitManual());
    manualRow.appendChild(inputEl);
    manualRow.appendChild(submitBtn);
    manualErrorEl = el('p', 'code-folder-manual-error');
    manualErrorEl.setAttribute('role', 'alert');
    manualErrorEl.hidden = true;
    manual.appendChild(manualLabel);
    manual.appendChild(manualRow);
    manual.appendChild(manualErrorEl);

    body.appendChild(statusEl);
    body.appendChild(hintEl);
    body.appendChild(listEl);
    body.appendChild(manual);

    const foot = el('div', 'code-folder-foot');
    retryBtn = makeButton('code-folder-retry', '重新读取工作区目录', '重试');
    retryBtn.hidden = true;
    retryBtn.addEventListener('click', () => startLoad());
    const cancelBtn = makeButton('code-folder-cancel', '取消选择目录', '取消');
    cancelBtn.addEventListener('click', () => cancel());
    foot.appendChild(retryBtn);
    foot.appendChild(cancelBtn);

    sheet.appendChild(head);
    sheet.appendChild(body);
    sheet.appendChild(foot);
    root.appendChild(sheet);
  }

  /* --------------------------- 渲染 --------------------------- */

  function clearList() {
    if (listEl) listEl.replaceChildren();
  }

  function makeItem(item) {
    const wrap = el('li', 'code-folder-item-wrap');
    const btn = el('button', 'code-folder-item');
    btn.type = 'button';
    btn.setAttribute('aria-label', `选择 ${item.label}：${item.path}`);
    btn.setAttribute('title', item.path);
    const name = el('span', 'code-folder-name', item.label);
    if (item.source === 'recent') {
      const tag = el('span', 'code-folder-tag', '最近');
      name.appendChild(tag);
    }
    const path = el('span', 'code-folder-path', shortenMiddle(item.path));
    path.setAttribute('title', item.path);
    btn.appendChild(name);
    btn.appendChild(path);
    btn.addEventListener('click', () => settle(item.path));
    wrap.appendChild(btn);
    return wrap;
  }

  function renderRoots(roots) {
    clearList();
    if (!roots.length) {
      if (listEl) listEl.hidden = true;
      setStatus('没有可用的工作区目录', 'empty');
      setHint('工作区必须是本机真实存在的目录；也可以在下面手动输入绝对路径。');
      // 空态也留重试：刚接上外接盘、刚授权完目录时，用户值得再读一次
      setRetryVisible(true);
      focusSheet();
      return;
    }
    if (listEl) {
      for (const item of roots) listEl.appendChild(makeItem(item));
      listEl.hidden = false;
    }
    const onlyRecent = roots.every((item) => item.source === 'recent');
    setStatus(`选择要作为代码目录的目录（共 ${roots.length} 个）`, 'ready');
    // 全是「最近会话」时把话说清楚：这些是历史路径，不是宿主公开的工作区
    setHint(onlyRecent ? '这台设备看不到宿主机的工作区路径，上面是你最近 Code 会话用过的目录；也可以在下面手动输入。' : '');
    setRetryVisible(false);
    focusSheet();
  }

  function focusSheet() {
    if (!sheet || typeof sheet.focus !== 'function') return;
    // 用户已经在面板里打字（哪怕列表还在路上）就别把焦点抢回容器，否则软键盘会收起
    const active = doc.activeElement;
    if (active && typeof sheet.contains === 'function' && sheet.contains(active)) return;
    sheet.focus();
  }

  /* --------------------------- 载入 --------------------------- */

  function isCurrent(generation) {
    return state.open && state.pending != null && state.pending.generation === generation;
  }

  async function load(generation) {
    if (!isCurrent(generation)) return;
    state.error = '';
    state.roots = [];
    clearList();
    if (listEl) listEl.hidden = true;
    setStatus('正在读取工作区目录…', 'loading');
    setHint('');
    setRetryVisible(false);
    showManualError('');

    let payload;
    try {
      payload = await listRoots();
    } catch (err) {
      // 关掉 / 重开之后才回来的失败结果一律作废（generation 已经不匹配）
      if (!isCurrent(generation)) return;
      const message = String((err && err.message) || err || '未知错误');
      state.error = message;
      setStatus(`无法读取工作区目录：${message}`, 'error');
      setHint('可以点「重试」再读一次，或在下面手动输入绝对路径。');
      setRetryVisible(true);
      return;
    }
    if (!isCurrent(generation)) return;

    const roots = pickUsableRoots(payload);
    state.roots = roots;
    renderRoots(roots);
    // 工作区列表读失败但还有最近会话可选：给个交代，否则用户会以为工作区真的一个都没有
    if (payload && payload.degraded === true && roots.some((item) => item.source === 'recent')) {
      setHint('工作区列表读取失败，只列出了最近 Code 会话用过的目录。');
    }
  }

  /** 发起（或重新发起）一次读取：换代，旧请求的结果自然作废。 */
  function startLoad() {
    if (!state.open || !state.pending) return 0;
    state.generation += 1;
    state.pending.generation = state.generation;
    const generation = state.generation;
    void load(generation);
    return generation;
  }

  /* --------------------------- 交互 --------------------------- */

  function onBackdropClick(event) {
    if (!state.open) return;
    // 只有点在遮罩本身才关；点面板内部的任何位置都不关
    if (event && event.target && event.target !== root) return;
    cancel();
  }

  function onKeyDown(event) {
    if (!state.open || !event || event.key !== 'Escape') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    cancel();
  }

  function onInputKeyDown(event) {
    if (!event || event.key !== 'Enter') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    submitManual();
  }

  function submitManual() {
    if (!inputEl) return;
    const value = String(inputEl.value == null ? '' : inputEl.value).trim();
    if (!value) {
      showManualError('请输入目录路径');
      if (typeof inputEl.focus === 'function') inputEl.focus();
      return;
    }
    showManualError('');
    settle(value);
  }

  function cancel() {
    if (!state.open) return false;
    settle(null);
    return true;
  }

  /* --------------------------- 生命周期 --------------------------- */

  function teardown() {
    keyHost.removeEventListener('keydown', onKeyDown);
    if (root && typeof root.removeEventListener === 'function') {
      root.removeEventListener('click', onBackdropClick);
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    sheet = null;
    statusEl = null;
    hintEl = null;
    listEl = null;
    inputEl = null;
    manualErrorEl = null;
    retryBtn = null;
    state.open = false;
    state.pending = null;
    state.roots = [];
    state.error = '';
  }

  /** 唯一出口：先拆 DOM 再 resolve，调用方拿到结果时页面上已经没有这一层。 */
  function settle(value) {
    const pending = state.pending;
    if (!state.open || !pending) return;
    teardown();
    pending.resolve(value);
  }

  /**
   * 打开选择器。
   *
   * @param {object} [options]
   * @param {string} [options.title] 标题（默认「选择代码目录」）
   * @returns {Promise<string|null>} 选中的绝对路径；取消 / Esc / 点背景 → null
   */
  function open(options = {}) {
    const title = typeof options?.title === 'string' && options.title.trim()
      ? options.title.trim()
      : DEFAULT_TITLE;
    // 同一实例重复 open：上一次还没结束就先以 null 收尾，绝不叠出两层 DOM 或悬挂的 Promise
    if (state.open) settle(null);

    build(title);
    host.appendChild(root);
    state.open = true;

    let resolvePending = null;
    const promise = new Promise((resolve) => { resolvePending = resolve; });
    // generation 由 startLoad() 换代，这里先占位，避免 Promise 与面板不同步
    state.pending = { generation: state.generation, resolve: resolvePending };

    keyHost.addEventListener('keydown', onKeyDown);
    focusSheet();
    startLoad();
    return promise;
  }

  function close() {
    return cancel();
  }

  function isOpen() {
    return state.open;
  }

  /** 只读快照，给测试与装配层观察用。 */
  function getState() {
    return {
      open: state.open,
      roots: state.roots.map((item) => ({ ...item })),
      error: state.error,
      pending: state.pending != null,
    };
  }

  return { open, close, isOpen, getState };
}
