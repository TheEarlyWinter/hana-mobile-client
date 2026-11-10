/* web/code-panel.js — 只读的「仓库现状」面板（分支 / 工作树 / 改动 / 单文件 diff）
 *
 * 为什么只读：
 *   宿主只暴露了 GET /api/code/{branches,worktrees,status,changes,diff} 这几个读接口，
 *   没有 checkout / stage / commit / push，也没有建工作树的 HTTP 入口。手机端能看到仓库
 *   现在什么样就够了；写操作属另一件事，不在这个模块里做——这里不写任何文件、不做 git
 *   操作、不发 POST。
 *
 * 管什么：
 *   - createCodePanel({ doc, mount, api, getSession }) 造一个模态面板；
 *   - open() 时串行拉四类数据：branches/worktrees 用 getSession().cwd，
 *     status/changes 用 getSession().sessionId。四块各自 try/catch，一块坏了不牵连其它；
 *   - 顶部：仓库根、当前分支（detached 单独写「游离 HEAD」）、ahead/behind、改动文件数；
 *   - 工作树列表：branch + path，标出 isMain / isCurrent / locked / prunable / 目录不存在；
 *   - 改动列表：状态中文 + ±行数 + 是否已暂存；点一行拉 /api/code/diff，在面板里看文本差异；
 *   - 刷新按钮重新拉一遍：拉取中禁用，块内显示加载态；
 *   - 关闭：点背景 / ✕ / Esc（看差异时 Esc 先退回列表），close() 幂等。
 *
 * 为什么 403 要单独讲：
 *   /api/code/* 在宿主权限表里是 studio_owner 级。本机回环直连 200，但手机经网关走 LAN
 *   很可能被 403 挡住（studio_owner_required）。这不是网络故障，也不能说成「加载失败」，
 *   否则排查会走错方向：必须直说「这台设备没有查看仓库信息的权限」。
 *
 * 不管什么：
 *   - 不碰 app.js / index.html / style.css / chat-renderer.js：类名统一 code-panel- 前缀，
 *     样式在 web/code-panel.css，装配与样式登记由主代理做；
 *   - 不读全局状态：doc / api / getSession 都是注入的依赖，模块顶层不摸 document，
 *     方便用假 DOM 在 Node 里测。
 */

/* ------------------------------ 纯函数 ------------------------------ */

/** 改动状态 → 中文。只认宿主实测会发的几个；未知值原样显示，不吞掉新状态。 */
export const CHANGE_STATUS_LABELS = Object.freeze({
  untracked: '未跟踪',
  added: '新增',
  deleted: '删除',
  modified: '修改',
  renamed: '重命名',
});

/**
 * 改动状态的中文文案。
 *
 * @param {unknown} status 宿主给的 status 字段
 * @returns {string} 中文（未知状态返回原样的小写串；空值给「未知改动」）
 */
export function changeStatusLabel(status) {
  const key = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!key) return '未知改动';
  return CHANGE_STATUS_LABELS[key] || key;
}

/** 状态映射成安全的类名后缀：宿主万一给个怪值，也不至于拼出非法 class。 */
function statusClass(status) {
  const key = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return key.replace(/[^a-z0-9_-]/g, '') || 'unknown';
}

function errorCodeOf(err) {
  const body = err && err.body;
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (body.error && typeof body.error === 'object' && typeof body.error.code === 'string') {
      return body.error.code.trim();
    }
    if (typeof body.code === 'string' && body.code.trim()) return body.code.trim();
  }
  return typeof err?.code === 'string' ? err.code.trim() : '';
}

/**
 * 把宿主 / 网关的失败统一成一句能直接给用户看的话。
 *
 * 分档的理由：
 *   - 403（studio_owner_required 或权限不足）是权限问题，不是「加载失败」，必须说清楚；
 *   - invalid_cwd / cwd_not_found 是目录问题，让用户知道该换会话而不是点重试；
 *   - 404 且没有业务 code，多半是这台设备的宿主还没有 /api/code/*；
 *   - 其余才是笼统的读取失败。
 *
 * @param {unknown} err api() 抛出的错误（http-client 会带 status / body）
 * @returns {{kind: string, message: string, hint: string}}
 */
export function describeCodeError(err) {
  const status = Number(err?.status) || 0;
  const code = errorCodeOf(err);
  const raw = String((err && err.message) || err || '').trim() || '未知错误';

  if (
    status === 403
    || code === 'studio_owner_required'
    || code === 'forbidden'
    || /(^|\D)403(\D|$)/.test(raw)
    || raw.includes('studio_owner_required')
  ) {
    return {
      kind: 'forbidden',
      message: '这台设备没有查看仓库信息的权限',
      hint: '宿主把 /api/code/* 归为 studio owner 权限：账号或网关没放行，不是网络故障，重试也不会通过。',
    };
  }
  if (code === 'timeout' || raw.startsWith('请求超时')) {
    return {
      kind: 'timeout',
      message: '请求超时，请稍后重试',
      hint: '手机网络可能刚切走；点「刷新」再读一次。',
    };
  }
  if (code === 'invalid_cwd' || code === 'cwd_not_found') {
    return {
      kind: 'bad-path',
      message: '仓库目录不可用（路径不存在或不是目录）',
      hint: raw,
    };
  }
  if (status === 404) {
    return {
      kind: 'unsupported',
      message: '宿主没有提供仓库信息接口',
      hint: '这台设备的宿主版本可能还不支持 /api/code/*，需要先升级宿主。',
    };
  }
  return { kind: 'error', message: `读取失败：${raw}`, hint: '' };
}

/**
 * /api/code/status 的展示拆解。纯函数，不碰 DOM。
 *
 * @param {object|null} data { branch, detached, upstream, ahead, behind, changedFileCount }
 * @returns {{branch: string, sync: string, upstream: string, detached: boolean}}
 */
export function describeStatus(data) {
  if (!data || typeof data !== 'object') {
    return { branch: '', sync: '', upstream: '', detached: false };
  }
  const detached = data.detached === true;
  const rawBranch = typeof data.branch === 'string' ? data.branch.trim() : '';
  const branch = detached ? '游离 HEAD' : (rawBranch || '未知分支');
  const ahead = Number.isFinite(data.ahead) ? data.ahead : null;
  const behind = Number.isFinite(data.behind) ? data.behind : null;
  const upstream = typeof data.upstream === 'string' ? data.upstream.trim() : '';
  let sync = '';
  if (ahead !== null && behind !== null) sync = `领先 ${ahead} / 落后 ${behind}`;
  return { branch, sync, upstream, detached };
}

/* ------------------------------ 工厂 ------------------------------ */

/** 面板里四类请求；status 不单独成块，它的数据画在顶部摘要里。 */
const BLOCK_NAMES = Object.freeze(['branches', 'worktrees', 'status', 'changes']);
/** 有三块是列表，status 只进摘要。 */
const SECTION_NAMES = Object.freeze(['branches', 'worktrees', 'changes']);
const SECTION_TITLES = Object.freeze({ branches: '分支', worktrees: '工作树', changes: '改动' });

const PANEL_TITLE = '仓库现状';
const MISSING_SESSION_TEXT = '这个会话没有关联仓库目录';

let instanceSeq = 0;

/**
 * 造一个只读的仓库现状面板。
 *
 * @param {object} [options]
 * @param {Document} [options.doc] 默认 globalThis.document
 * @param {Element} [options.mount] 挂载容器，默认 doc.body
 * @param {(pathname: string) => Promise<any>} [options.api] 同源 JSON 客户端（app.js 里的 api）
 * @param {() => ({cwd?: string, sessionId?: string}|null)} [options.getSession] 当前会话
 * @returns {{open: Function, close: Function, isOpen: Function}}
 */
export function createCodePanel({
  doc = globalThis.document,
  mount = null,
  api,
  getSession,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createCodePanel 需要一个能 createElement 的 document');
  }
  const host = mount || doc.body;
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createCodePanel 需要一个能 appendChild 的挂载容器');
  }
  if (typeof api !== 'function') {
    throw new TypeError('createCodePanel 需要 api 函数（例如 createApiClient() 的返回值）');
  }
  if (typeof getSession !== 'function') {
    throw new TypeError('createCodePanel 需要 getSession 函数（例如 () => S.session）');
  }

  instanceSeq += 1;
  const titleId = `code-panel-title-${instanceSeq}`;

  const makeBlock = () => ({
    /** 'idle' | 'loading' | 'ready' | 'error' */
    phase: 'idle',
    data: null,
    error: '',
    hint: '',
    forbidden: false,
    kind: '',
  });

  const state = {
    open: false,
    /** 每次拉取换代；关掉面板或重新拉取都会推进，晚到的结果自然作废。 */
    seq: 0,
    loading: false,
    session: { cwd: '', sessionId: '' },
    blocks: {
      branches: makeBlock(),
      worktrees: makeBlock(),
      status: makeBlock(),
      changes: makeBlock(),
    },
    detail: {
      active: false,
      token: 0,
      path: '',
      file: null,
      /** 'loading' | 'ready' | 'error' */
      phase: 'idle',
      diff: '',
      omitted: null,
      error: '',
      hint: '',
    },
  };

  /* --------------------------- DOM 引用 --------------------------- */

  let root = null;
  let sheet = null;
  let bodyEl = null;
  let refreshBtn = null;
  let summaryEl = null;
  let repoPathEl = null;
  let branchLineEl = null;
  let noticeEl = null;
  let noticeHintEl = null;
  let sectionsEl = null;
  const sectionRefs = {};
  let detailSection = null;
  let detailPathEl = null;
  let detailMetaEl = null;
  let detailBodyEl = null;

  /* --------------------------- 小工具 --------------------------- */

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const part = (cls, text) => el('span', cls, text);

  const makeButton = (cls, label, text) => {
    const btn = el('button', cls, text);
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    return btn;
  };

  function setLine(ref, visible, parts) {
    if (!ref) return;
    ref.hidden = !visible;
    if (!visible) {
      ref.replaceChildren();
      return;
    }
    ref.replaceChildren(...(parts || []));
  }

  function setNotice(text, hint) {
    if (!noticeEl) return;
    noticeEl.textContent = text || '';
    noticeEl.hidden = !text;
    if (noticeHintEl) {
      noticeHintEl.textContent = hint || '';
      noticeHintEl.hidden = !hint;
    }
  }

  const isCurrent = (seq) => state.open && seq === state.seq;

  function readSession() {
    let session = null;
    try {
      session = getSession();
    } catch {
      session = null;
    }
    if (!session || typeof session !== 'object') return { cwd: '', sessionId: '' };
    return {
      cwd: typeof session.cwd === 'string' ? session.cwd.trim() : '',
      sessionId: typeof session.sessionId === 'string' ? session.sessionId.trim() : '',
    };
  }

  /* --------------------------- DOM 构建 --------------------------- */

  function build() {
    root = el('div', 'code-panel-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', titleId);
    root.addEventListener('click', onBackdropClick);

    sheet = el('div', 'code-panel-sheet');
    sheet.setAttribute('tabindex', '-1');

    const head = el('div', 'code-panel-head');
    const title = el('h2', 'code-panel-title', PANEL_TITLE);
    title.id = titleId;
    const actions = el('div', 'code-panel-head-actions');
    refreshBtn = makeButton('code-panel-refresh', '刷新仓库信息', '刷新');
    refreshBtn.addEventListener('click', onRefresh);
    const closeBtn = makeButton('code-panel-close', '关闭仓库信息', '×');
    closeBtn.setAttribute('title', '关闭');
    closeBtn.addEventListener('click', () => close());
    actions.appendChild(refreshBtn);
    actions.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(actions);

    bodyEl = el('div', 'code-panel-body');

    /* 顶部摘要：仓库根 / 分支 / 同步状态 / 提示 */
    summaryEl = el('div', 'code-panel-summary');
    repoPathEl = el('p', 'code-panel-summary-line code-panel-repo-path');
    repoPathEl.hidden = true;
    branchLineEl = el('p', 'code-panel-summary-line code-panel-branch-line');
    branchLineEl.hidden = true;
    noticeEl = el('p', 'code-panel-notice');
    noticeEl.hidden = true;
    noticeEl.setAttribute('role', 'status');
    noticeEl.setAttribute('aria-live', 'polite');
    noticeHintEl = el('p', 'code-panel-notice-hint');
    noticeHintEl.hidden = true;
    summaryEl.appendChild(repoPathEl);
    summaryEl.appendChild(branchLineEl);
    summaryEl.appendChild(noticeEl);
    summaryEl.appendChild(noticeHintEl);

    /* 三块列表：分支 / 工作树 / 改动 */
    sectionsEl = el('div', 'code-panel-sections');
    for (const name of SECTION_NAMES) {
      const section = el('section', `code-panel-section code-panel-section-${name}`);
      const heading = el('h3', 'code-panel-section-title', SECTION_TITLES[name]);
      const content = el('div', 'code-panel-section-body');
      section.appendChild(heading);
      section.appendChild(content);
      sectionsEl.appendChild(section);
      sectionRefs[name] = { section, title: heading, body: content };
    }

    /* 单文件差异：点改动列表里的文件后切换到这个子视图 */
    detailSection = el('section', 'code-panel-detail');
    detailSection.hidden = true;
    const detailHead = el('div', 'code-panel-detail-head');
    const detailTitle = el('div', 'code-panel-detail-title');
    detailPathEl = el('p', 'code-panel-detail-path');
    detailMetaEl = el('p', 'code-panel-detail-meta');
    detailTitle.appendChild(detailPathEl);
    detailTitle.appendChild(detailMetaEl);
    const backBtn = makeButton('code-panel-detail-back', '返回改动列表', '返回');
    backBtn.addEventListener('click', () => closeDetail());
    detailHead.appendChild(detailTitle);
    detailHead.appendChild(backBtn);
    detailBodyEl = el('div', 'code-panel-detail-body');
    detailSection.appendChild(detailHead);
    detailSection.appendChild(detailBodyEl);

    bodyEl.appendChild(summaryEl);
    bodyEl.appendChild(sectionsEl);
    bodyEl.appendChild(detailSection);

    sheet.appendChild(head);
    sheet.appendChild(bodyEl);
    root.appendChild(sheet);
  }

  /* --------------------------- 仓库状态判定 --------------------------- */

  function block(name) {
    return state.blocks[name] || makeBlock();
  }

  /** 'repo' | 'not-repo' | 'unknown'：只认真的回来了 isRepository 的那些块。 */
  function repoState() {
    const responded = BLOCK_NAMES.map(block).filter((b) => b.phase === 'ready' && b.data);
    if (!responded.length) return 'unknown';
    if (responded.some((b) => b.data.isRepository === true)) return 'repo';
    if (responded.some((b) => b.data.isRepository === false)) return 'not-repo';
    return 'unknown';
  }

  const anyForbidden = () => BLOCK_NAMES.some((name) => block(name).forbidden);
  const anyReady = () => BLOCK_NAMES.some((name) => block(name).phase === 'ready');

  /**
   * 三块列表要不要整块收起来：
   *   - 没有会话（cwd / sessionId 缺一个）→ 顶部只有一句「这个会话没有关联仓库目录」；
   *   - 目录不是 git 仓库 → 列表没有意义，顶部一句「这个目录不是 git 仓库」；
   *   - 全是 403 且一块也没成功 → 顶部一句权限提示，下面不再摞三条同样的错误。
   * 只要有一块成功了就照常展开：单块出错时，那块自己显示错误，其余块照常。
   */
  function sectionsBlocked() {
    const { cwd, sessionId } = state.session;
    if (!cwd || !sessionId) return true;
    if (repoState() === 'not-repo') return true;
    return anyForbidden() && !anyReady();
  }

  /* --------------------------- 渲染：摘要 --------------------------- */

  /** 仓库根：优先 worktrees 的 repoRoot；拿不到就退回会话目录，但标签改叫「会话目录」。 */
  function repoInfo() {
    const wt = block('worktrees');
    if (wt.phase === 'ready' && wt.data && typeof wt.data.repoRoot === 'string') {
      const path = wt.data.repoRoot.trim();
      if (path) return { path, label: '仓库根' };
    }
    return { path: state.session.cwd, label: '会话目录' };
  }

  function renderSummary() {
    if (!state.open || !summaryEl) return;
    const { cwd, sessionId } = state.session;

    if (!cwd || !sessionId) {
      setLine(repoPathEl, false);
      setLine(branchLineEl, false);
      setNotice(MISSING_SESSION_TEXT, '只有 Code 会话才知道仓库在哪；换到一个 Code 会话再打开这里。');
      return;
    }

    const info = repoInfo();
    setLine(repoPathEl, true, [
      part('code-panel-key', info.label),
      part(info.path ? 'code-panel-value code-panel-path' : 'code-panel-value is-muted', info.path || '未知'),
    ]);
    repoPathEl.setAttribute('title', info.path || '');

    const st = block('status');
    if (repoState() === 'not-repo') {
      // 非仓库时不在摘要里再说一遍：上面已经给了一句「这个目录不是 git 仓库」
      setLine(branchLineEl, false);
    } else if (st.phase === 'error') {
      setLine(branchLineEl, true, [
        part('code-panel-key', '仓库状态'),
        part('code-panel-value is-error', st.error || '读取失败'),
      ]);
    } else if (st.phase === 'ready') {
      const described = describeStatus(st.data);
      const parts = [
        part('code-panel-key', '当前分支'),
        part(described.detached ? 'code-panel-value is-warn' : 'code-panel-value is-strong', described.branch),
      ];
      if (described.sync) parts.push(part('code-panel-value is-muted', described.sync));
      if (described.upstream && !described.detached) {
        parts.push(part('code-panel-value is-muted', `上游 ${described.upstream}`));
      }
      const changed = st.data ? st.data.changedFileCount : null;
      if (Number.isFinite(changed)) parts.push(part('code-panel-value is-muted', `${changed} 个文件改动`));
      setLine(branchLineEl, true, parts);
    } else {
      setLine(branchLineEl, true, [
        part('code-panel-key', '仓库状态'),
        part('code-panel-value is-muted', '正在读取…'),
      ]);
    }

    if (anyForbidden()) {
      setNotice(
        '这台设备没有查看仓库信息的权限',
        '宿主把 /api/code/* 归为 studio owner 权限：账号或网关没放行，不是网络故障，重试也不会通过。'
      );
    } else if (repoState() === 'not-repo') {
      setNotice('这个目录不是 git 仓库', '分支、工作树、改动都要在 git 仓库里才看得到。');
    } else {
      setNotice('', '');
    }
  }

  /* --------------------------- 渲染：三块列表 --------------------------- */

  function sectionTitle(name) {
    const base = SECTION_TITLES[name];
    const data = block(name);
    if (data.phase !== 'ready' || !data.data || data.data.isRepository === false) return base;
    let count = 0;
    if (name === 'branches' && Array.isArray(data.data.branches)) count = data.data.branches.length;
    if (name === 'worktrees' && Array.isArray(data.data.worktrees)) count = data.data.worktrees.length;
    if (name === 'changes' && Array.isArray(data.data.files)) count = data.data.files.length;
    return `${base}（${count}）`;
  }

  function renderBlockError(content, data) {
    // 权限问题在顶部已经完整说了一遍，块里只留一句「没有查看权限」，不重复整句
    content.appendChild(el('p', 'code-panel-block-error', data.forbidden ? '没有查看权限' : (data.error || '读取失败')));
    if (data.hint) content.appendChild(el('p', 'code-panel-block-hint', data.hint));
  }

  function renderBranches(content, payload) {
    const list = Array.isArray(payload.branches)
      ? payload.branches.filter((name) => typeof name === 'string' && name.trim())
      : [];
    if (!list.length) {
      content.appendChild(el('p', 'code-panel-empty', '没有分支'));
      return;
    }
    const current = typeof payload.current === 'string' ? payload.current.trim() : '';
    const wrap = el('ul', 'code-panel-branch-list');
    for (const name of list) {
      const isCurrentBranch = Boolean(current) && name === current;
      const item = el('li', isCurrentBranch ? 'code-panel-branch-item is-current' : 'code-panel-branch-item');
      item.appendChild(el('span', 'code-panel-branch-name', name));
      if (isCurrentBranch) item.appendChild(el('span', 'code-panel-badge is-current', '当前'));
      wrap.appendChild(item);
    }
    content.appendChild(wrap);
  }

  function renderWorktrees(content, payload) {
    const list = Array.isArray(payload.worktrees)
      ? payload.worktrees.filter((item) => item && typeof item === 'object')
      : [];
    if (!list.length) {
      content.appendChild(el('p', 'code-panel-empty', '没有工作树'));
      return;
    }
    const wrap = el('ul', 'code-panel-worktree-list');
    for (const item of list) {
      const branch = typeof item.branch === 'string' && item.branch.trim() ? item.branch.trim() : '游离 HEAD';
      const path = typeof item.path === 'string' ? item.path : '';
      const row = el('li', item.isCurrent ? 'code-panel-worktree-item is-current' : 'code-panel-worktree-item');
      const head = el('div', 'code-panel-worktree-head');
      head.appendChild(el('span', 'code-panel-worktree-branch', branch));
      const badges = el('span', 'code-panel-badges');
      if (item.isMain) badges.appendChild(el('span', 'code-panel-badge is-main', '主工作树'));
      if (item.isCurrent) badges.appendChild(el('span', 'code-panel-badge is-current', '当前'));
      if (item.locked) badges.appendChild(el('span', 'code-panel-badge is-locked', '锁定'));
      if (item.prunable) badges.appendChild(el('span', 'code-panel-badge is-prunable', '可清理'));
      if (item.exists === false) badges.appendChild(el('span', 'code-panel-badge is-missing', '目录不存在'));
      if (badges.children.length) head.appendChild(badges);
      const pathEl = el('span', 'code-panel-worktree-path', path);
      pathEl.setAttribute('title', path);
      row.appendChild(head);
      row.appendChild(pathEl);
      wrap.appendChild(row);
    }
    content.appendChild(wrap);
  }

  function renderChanges(content, payload) {
    const files = Array.isArray(payload.files)
      ? payload.files.filter((file) => file && typeof file.path === 'string' && file.path)
      : [];
    if (!files.length) {
      content.appendChild(el('p', 'code-panel-empty', '没有改动'));
      return;
    }
    const wrap = el('ul', 'code-panel-change-list');
    for (const file of files) {
      const row = el('li', 'code-panel-change-wrap');
      const btn = el('button', 'code-panel-change-item');
      btn.type = 'button';
      btn.setAttribute('aria-label', `查看 ${file.path} 的差异`);
      btn.setAttribute('title', file.path);
      btn.appendChild(el('span', 'code-panel-change-path', file.path));
      const meta = el('span', 'code-panel-change-meta');
      meta.appendChild(el('span', `code-panel-change-status is-${statusClass(file.status)}`, changeStatusLabel(file.status)));
      const stats = el('span', 'code-panel-change-stats');
      if (Number.isFinite(file.additions)) stats.appendChild(el('span', 'code-panel-stat-add', `+${file.additions}`));
      if (Number.isFinite(file.deletions)) stats.appendChild(el('span', 'code-panel-stat-del', `−${file.deletions}`));
      if (stats.children.length) meta.appendChild(stats);
      meta.appendChild(el(
        'span',
        file.staged ? 'code-panel-change-staged is-staged' : 'code-panel-change-staged is-unstaged',
        file.staged ? '已暂存' : '未暂存'
      ));
      btn.appendChild(meta);
      btn.addEventListener('click', () => openDetail(file));
      row.appendChild(btn);
      wrap.appendChild(row);
    }
    content.appendChild(wrap);
  }

  function renderBlock(name) {
    const refs = sectionRefs[name];
    if (!refs) return;
    refs.title.textContent = sectionTitle(name);
    refs.body.replaceChildren();
    const data = block(name);

    if (data.phase === 'ready' && data.data) {
      if (data.data.isRepository === false) {
        refs.body.appendChild(el('p', 'code-panel-empty', '不是 git 仓库'));
        return;
      }
      if (name === 'branches') renderBranches(refs.body, data.data);
      else if (name === 'worktrees') renderWorktrees(refs.body, data.data);
      else renderChanges(refs.body, data.data);
      return;
    }
    if (data.phase === 'error') {
      renderBlockError(refs.body, data);
      return;
    }
    // idle / loading：串行拉取时后面几块也在「等」，统一显示加载态而不是空白
    refs.body.appendChild(el('p', 'code-panel-loading', '正在读取…'));
  }

  /* --------------------------- 渲染：差异 --------------------------- */

  const OMIT_TEXT = Object.freeze({
    binary: '二进制文件，不显示差异',
    'too-large': '差异过大，已省略',
  });

  function renderDetail() {
    if (!state.open || !detailSection) return;
    const detail = state.detail;
    if (!detail.active) return;

    detailPathEl.textContent = detail.path;
    detailPathEl.setAttribute('title', detail.path);
    const file = detail.file || {};
    const meta = [changeStatusLabel(file.status), file.staged ? '已暂存' : '未暂存'];
    detailMetaEl.textContent = meta.join(' · ');

    detailBodyEl.replaceChildren();
    if (detail.phase === 'error') {
      detailBodyEl.appendChild(el('p', 'code-panel-block-error', detail.error || '读取失败'));
      if (detail.hint) detailBodyEl.appendChild(el('p', 'code-panel-block-hint', detail.hint));
      return;
    }
    if (detail.phase !== 'ready') {
      detailBodyEl.appendChild(el('p', 'code-panel-loading', '正在读取差异…'));
      return;
    }
    if (detail.omitted) {
      const reason = detail.omitted.reason;
      detailBodyEl.appendChild(el('p', 'code-panel-detail-note', OMIT_TEXT[reason] || `差异已省略（${reason}）`));
      return;
    }
    if (!detail.diff) {
      detailBodyEl.appendChild(el('p', 'code-panel-detail-note', '这个文件没有文本差异'));
      return;
    }
    // 纯文本渲染：宿主给的 highlight 只是语言提示，不参与着色，也不做 HTML 解析
    detailBodyEl.appendChild(el('pre', 'code-panel-diff-text', detail.diff));
  }

  function renderAll() {
    if (!state.open) return;
    renderSummary();
    for (const name of SECTION_NAMES) renderBlock(name);
    renderDetail();
    syncVisibility();
  }

  function syncVisibility() {
    const detailOpen = state.detail.active;
    if (summaryEl) summaryEl.hidden = detailOpen;
    if (sectionsEl) sectionsEl.hidden = detailOpen || sectionsBlocked();
    if (detailSection) detailSection.hidden = !detailOpen;
  }

  function syncRefresh() {
    if (!refreshBtn) return;
    refreshBtn.disabled = state.loading;
    refreshBtn.classList.toggle('is-busy', state.loading);
    refreshBtn.setAttribute('aria-busy', state.loading ? 'true' : 'false');
  }

  /* --------------------------- 拉取 --------------------------- */

  function requestList({ cwd, sessionId }) {
    return [
      ['branches', `/api/code/branches?cwd=${encodeURIComponent(cwd)}`],
      ['worktrees', `/api/code/worktrees?cwd=${encodeURIComponent(cwd)}`],
      ['status', `/api/code/status?sessionId=${encodeURIComponent(sessionId)}`],
      ['changes', `/api/code/changes?sessionId=${encodeURIComponent(sessionId)}`],
    ];
  }

  async function load(seq) {
    const { cwd, sessionId } = state.session;
    // 缺 cwd 或 sessionId 就一个请求都不发：宿主这两种参数缺失时只会回 400/404，
    // 打过去除了在网关上留一条失败日志没有别的作用。
    if (!cwd || !sessionId) return;
    for (const [name, url] of requestList({ cwd, sessionId })) {
      if (!isCurrent(seq)) return;
      try {
        const payload = await api(url);
        if (!isCurrent(seq)) return;
        state.blocks[name] = {
          ...makeBlock(),
          phase: 'ready',
          data: payload && typeof payload === 'object' ? payload : {},
        };
      } catch (err) {
        if (!isCurrent(seq)) return;
        const info = describeCodeError(err);
        state.blocks[name] = {
          ...makeBlock(),
          phase: 'error',
          error: info.message,
          hint: info.hint,
          forbidden: info.kind === 'forbidden',
          kind: info.kind,
        };
      }
      renderAll();
    }
  }

  function startLoad() {
    if (!state.open) return;
    state.seq += 1;
    const seq = state.seq;
    state.session = readSession();
    state.loading = true;
    for (const name of BLOCK_NAMES) state.blocks[name] = { ...makeBlock(), phase: 'loading' };
    closeDetail({ render: false });
    syncRefresh();
    renderAll();
    // 单块失败已经在 load 里吃掉了；这里兜的是渲染层自己抛错，退回一句可读提示，
    // 不让它冒成未处理的 Promise 拒绝把整页白屏。
    void load(seq).catch((err) => {
      if (!isCurrent(seq)) return;
      const info = describeCodeError(err);
      setNotice(info.message || '读取仓库信息时出错', info.hint);
    }).finally(() => {
      if (!isCurrent(seq)) return;
      state.loading = false;
      syncRefresh();
      renderAll();
    });
  }

  async function loadDiff(token) {
    const detail = state.detail;
    if (!state.open || !detail.active || detail.token !== token) return;
    const sessionId = state.session.sessionId;
    if (!sessionId) {
      state.detail = { ...state.detail, phase: 'error', error: MISSING_SESSION_TEXT, hint: '' };
      renderAll();
      return;
    }
    const url = `/api/code/diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(detail.path)}`;
    try {
      const payload = await api(url);
      if (!state.open || state.detail.token !== token || !state.detail.active) return;
      const data = payload && typeof payload === 'object' ? payload : {};
      const omitted = data.omitted && typeof data.omitted === 'object' && typeof data.omitted.reason === 'string'
        ? { reason: data.omitted.reason }
        : null;
      state.detail = {
        ...state.detail,
        phase: 'ready',
        diff: typeof data.diff === 'string' ? data.diff : '',
        omitted,
        error: '',
        hint: '',
      };
    } catch (err) {
      if (!state.open || state.detail.token !== token || !state.detail.active) return;
      const info = describeCodeError(err);
      state.detail = { ...state.detail, phase: 'error', error: info.message, hint: info.hint };
    }
    renderAll();
  }

  /* --------------------------- 交互 --------------------------- */

  function openDetail(file) {
    if (!state.open || !file || typeof file.path !== 'string' || !file.path) return;
    state.detail = {
      active: true,
      token: state.detail.token + 1,
      path: file.path,
      file,
      phase: 'loading',
      diff: '',
      omitted: null,
      error: '',
      hint: '',
    };
    if (bodyEl) bodyEl.scrollTop = 0;
    renderAll();
    void loadDiff(state.detail.token);
  }

  function closeDetail({ render = true } = {}) {
    if (!state.detail.active) return false;
    state.detail = { ...state.detail, active: false, token: state.detail.token + 1, phase: 'idle', diff: '', omitted: null, error: '', hint: '' };
    if (render && state.open) renderAll();
    return true;
  }

  function onRefresh() {
    if (!state.open || state.loading) return;
    startLoad();
  }

  function onBackdropClick(event) {
    if (!state.open) return;
    // 只有点在遮罩本身才关；点面板内部任何位置都不关
    if (event && event.target && event.target !== root) return;
    close();
  }

  function onKeyDown(event) {
    if (!state.open || !event || event.key !== 'Escape') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    // 看差异时 Esc 先退回列表，再按一次才关面板——和移动端返回键的习惯一致
    if (closeDetail()) return;
    close();
  }

  /* --------------------------- 生命周期 --------------------------- */

  function teardown() {
    doc.removeEventListener('keydown', onKeyDown);
    if (root && typeof root.removeEventListener === 'function') {
      root.removeEventListener('click', onBackdropClick);
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    sheet = null;
    bodyEl = null;
    refreshBtn = null;
    summaryEl = null;
    repoPathEl = null;
    branchLineEl = null;
    noticeEl = null;
    noticeHintEl = null;
    sectionsEl = null;
    detailSection = null;
    detailPathEl = null;
    detailMetaEl = null;
    detailBodyEl = null;
    for (const key of Object.keys(sectionRefs)) delete sectionRefs[key];

    state.open = false;
    state.loading = false;
    // 推进代次：还在路上的请求回来后 isCurrent() 为假，不会往已拆掉的 DOM 上画东西
    state.seq += 1;
    state.detail = {
      active: false,
      token: state.detail.token + 1,
      path: '',
      file: null,
      phase: 'idle',
      diff: '',
      omitted: null,
      error: '',
      hint: '',
    };
  }

  /**
   * 打开面板。已经在打开状态时是空操作（不叠 DOM、不重复发请求）。
   *
   * @returns {boolean} 这次是否真的打开了
   */
  function open() {
    if (state.open) return false;
    state.session = readSession();
    state.blocks = {
      branches: makeBlock(),
      worktrees: makeBlock(),
      status: makeBlock(),
      changes: makeBlock(),
    };
    state.seq += 1;
    build();
    host.appendChild(root);
    state.open = true;
    doc.addEventListener('keydown', onKeyDown);
    if (sheet && typeof sheet.focus === 'function') sheet.focus();
    startLoad();
    return true;
  }

  /**
   * 关闭面板。幂等：没打开时调用什么也不做。
   *
   * @returns {boolean} 这次是否真的关掉了
   */
  function close() {
    if (!state.open) return false;
    teardown();
    return true;
  }

  function isOpen() {
    return state.open;
  }

  return { open, close, isOpen };
}
