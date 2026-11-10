/* web/session-actions.js
 *
 * 会话操作：重命名 / 置顶 / 归档 / 还原。
 *
 * 这个模块管什么：
 *   1. 把「对某个会话点某个操作」翻译成「发什么请求 + 列表怎么变」的纯函数（plan*）。
 *      一条 plan 同时带着 request 与 apply，两边一一对应，不存在只改一边的情况。
 *   2. 乐观更新的执行器（createSessionActions）：先本地改，再发请求；失败把原列表
 *      提交回去，并把错误放进返回值与 onError 回调，不静默吞。
 *   3. 一个动作菜单视图（createSessionActionsView）：只往调用方给的 mount 里挂节点，
 *      不自己找别人的 DOM。
 *
 * 这个模块不管什么：
 *   - 不发请求：fetch 由调用方注入（fetchImpl）。模块里没有 http 客户端，
 *     不 import app.js，不读全局 S，不查 document.getElementById。
 *   - 不管列表从哪来、谁来重渲染：列表通过 getList / commitList 交给调用方，
 *     状态存储与排序分组都在 app 层。
 *   - 不管「彻底删除」：宿主没有「删除活跃会话」的路由，只有针对已归档会话的
 *     /api/sessions/archived/delete，所以这里只做归档，文案也只叫「归档」。
 *
 * 宿主契约（URL 前缀 /api，需要权限 sessions.write）：
 *   POST /api/sessions/rename    { path, title }          title 必须是非空字符串，否则 400
 *   POST /api/sessions/pin       { pinned, sessionId?, sessionPath? }
 *   POST /api/sessions/archive   { sessionId?, sessionPath? }
 *   POST /api/sessions/restore   { sessionId?, sessionPath? }
 * 字段名不统一是宿主现状：rename 用 path，其余三个用 sessionPath。别「顺手统一」。
 *
 * 会话行字段容错（列表里的行有的只有 path，有的只有 sessionId）：
 *   路径：path / sessionPath
 *   标识：sessionId / id
 *   标题：title / name
 *   置顶：pinned（布尔）/ pinnedAt（时间戳）
 */

/** 会话操作规划/执行阶段的错误。code 是给调用方判分支用的稳定标识。 */
export class SessionActionError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'SessionActionError';
    this.code = code;
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const WIN_DRIVE = /^[a-zA-Z]:\//;

/**
 * 路径归一：反斜杠转正斜杠 + 去首尾空白。
 *
 * 大小写只有盘符路径忽略：Windows 文件系统不区分，POSIX 区分——真挂 POSIX 主机时
 * `/work/A` 与 `/work/a` 是两个会话，无条件转小写会把它们并成一个（见 file-source.js
 * 的 matchWorkspaceRoot，同一个口径）。
 * 非路径的键（sessionId）也走这里比对，它们不带盘符，因此大小写原样保留。
 */
function normalizePath(value) {
  const p = text(value).replace(/\\/g, '/');
  return WIN_DRIVE.test(p) ? p.toLowerCase() : p;
}

/** 取会话文件路径。path 优先，其次 sessionPath。 */
export function sessionPathOf(session) {
  if (!session || typeof session !== 'object') return '';
  return text(session.path) || text(session.sessionPath);
}

/** 取会话 id。sessionId 优先，其次 id。 */
export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return '';
  return text(session.sessionId) || text(session.id);
}

/** 是否已置顶。pinned 布尔优先，其次 pinnedAt 这种时间戳写法。 */
export function isPinned(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.pinned === true) return true;
  if (session.pinned === false) return false;
  if (session.pinned != null && session.pinned !== '') return Boolean(session.pinned);
  return Boolean(session.pinnedAt);
}

/**
 * 两行是否同一个会话。路径是主身份（斜杠/大小写不敏感）；
 * 只有两边都缺路径时才退回 id 比对，避免「一侧有路径一侧只有 id」被错配。
 */
export function sameSession(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ap = sessionPathOf(a);
  const bp = sessionPathOf(b);
  if (ap && bp) return normalizePath(ap) === normalizePath(bp);
  const ai = sessionIdOf(a);
  const bi = sessionIdOf(b);
  if (ai && bi) return ai === bi;
  return false;
}

function assertList(list) {
  if (!Array.isArray(list)) {
    throw new TypeError(`会话操作需要一个会话数组，实际收到 ${describe(list)}`);
  }
  return list;
}

/** 不可变地改行：未命中的行保持同一引用。 */
function patchRows(list, target, patch) {
  assertList(list);
  return list.map((row) => (sameSession(row, target) ? { ...row, ...patch } : row));
}

function missingTarget() {
  return new SessionActionError(
    'missing-target',
    '会话既没有 sessionId 也没有路径，无法确定要操作哪一条',
  );
}

/** pin / archive / restore 共用的身份字段（宿主用 sessionPath 这个名字）。 */
function identityBody(session) {
  const body = {};
  const id = sessionIdOf(session);
  const path = sessionPathOf(session);
  if (id) body.sessionId = id;
  if (path) body.sessionPath = path;
  if (!id && !path) throw missingTarget();
  return body;
}

function normalizeTitle(title) {
  if (typeof title !== 'string') {
    throw new SessionActionError('invalid-title', `标题必须是非空字符串，实际收到 ${describe(title)}`);
  }
  const clean = title.trim();
  if (!clean) throw new SessionActionError('invalid-title', '标题不能为空');
  return clean;
}

/* ------------------------------------------------------------------ */
/* 规划：纯函数，只算「发什么」和「列表怎么变」                          */
/* ------------------------------------------------------------------ */

/**
 * 重命名。
 * @returns {{ action: 'rename', target: object,
 *             request: { method: string, url: string, body: object },
 *             apply: (list: object[]) => object[] }}
 */
export function planRename(session, title) {
  const path = sessionPathOf(session);
  const id = sessionIdOf(session);
  if (!path && !id) throw missingTarget();

  const clean = normalizeTitle(title);
  // rename 的请求体只认 path，没有路径就不能改名（只有 id 时无法定位文件）。
  if (!path) {
    throw new SessionActionError('missing-path', '重命名需要会话路径，当前会话只有 sessionId');
  }

  return {
    action: 'rename',
    target: session,
    request: { method: 'POST', url: '/api/sessions/rename', body: { path, title: clean } },
    apply: (list) => patchRows(list, { path }, { title: clean }),
  };
}

/**
 * 置顶开关：把当前 pinned 取反。视图层不自己算布尔，交给这里，避免两处口径打架。
 */
export function planTogglePin(session) {
  const body = identityBody(session);
  const pinned = !isPinned(session);
  return {
    action: 'pin',
    target: session,
    request: { method: 'POST', url: '/api/sessions/pin', body: { pinned, ...body } },
    apply: (list) => patchRows(list, session, { pinned }),
  };
}

/**
 * 归档。归档后的会话会从活跃列表里消失，所以 apply 直接把它摘掉。
 * 注意：这不是删除，宿主支持从归档区还原。
 */
export function planArchive(session) {
  const body = identityBody(session);
  return {
    action: 'archive',
    target: session,
    request: { method: 'POST', url: '/api/sessions/archive', body },
    apply: (list) => {
      assertList(list);
      return list.filter((row) => !sameSession(row, session));
    },
  };
}

/**
 * 还原（把已归档的会话放回活跃区）。
 * apply 只把列表里已存在的行标回 archived=false；无法凭空算出它该插在哪儿，
 * 真正的排序交给下一次列表刷新。
 */
export function planRestore(session) {
  const body = identityBody(session);
  return {
    action: 'restore',
    target: session,
    request: { method: 'POST', url: '/api/sessions/restore', body },
    apply: (list) => patchRows(list, session, { archived: false }),
  };
}

/* ------------------------------------------------------------------ */
/* 执行器：乐观更新 + 回滚                                              */
/* ------------------------------------------------------------------ */

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 创建会话操作执行器。
 *
 * @param {object} [options]
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl]
 *   注入的 fetch（缺省读 globalThis.fetch）。模块不自己建客户端。
 * @param {() => object[]} [options.getList] 读当前列表
 * @param {(list: object[], meta?: {action: string, target: object, phase: 'optimistic'|'rollback'}) => void} [options.commitList]
 *   落地列表（乐观更新与回滚都走它；meta 供装配层只同步目标会话）
 * @param {() => any} [options.getContext] 可选身份/上下文快照；await 后若变化，
 *   不再提交回滚、不再触发 onError，结果以 stale=true 返回
 * @param {(event: object) => void} [options.onError] 失败回调，用于闪提示
 * @param {number} [options.timeoutMs=15000] 单次请求超时
 * @returns {{
 *   run: (plan: object) => Promise<object>,
 *   rename: (session: object, title: string) => Promise<object>,
 *   togglePin: (session: object) => Promise<object>,
 *   archive: (session: object) => Promise<object>,
 *   restore: (session: object) => Promise<object>
 * }}
 *
 * 每个方法都解析成同一个结果形状，不 reject（避免调用方漏 catch）：
 *   成功 { ok: true,  action, phase: 'request', list, stale }
 *   失败 { ok: false, action, phase: 'plan' | 'request', error,
 *          rolledBack: boolean, stale: boolean, list }
 *   - phase 'plan'：规划阶段就被拒（空标题、缺身份），没有发请求、没动列表。
 *   - phase 'request'：请求失败。rolledBack=true 表示已把乐观更新回滚。
 *   - stale=true：失败时列表已经被别的操作替换，此时不强行回滚（会把别人的新状态顶掉），
 *     rolledBack 报 false，以错误回调里的 stale 提示调用方刷新。
 */
export function createSessionActions({
  fetchImpl,
  getList = () => [],
  commitList = () => {},
  getContext,
  onError = () => {},
  timeoutMs = 15000,
} = {}) {
  function readList() {
    const list = getList();
    return Array.isArray(list) ? list : [];
  }

  // 读数失败也不能把异常漏给调用方：统一退化成空列表，只影响本次判断。
  function safeReadList() {
    try {
      return readList();
    } catch {
      return [];
    }
  }

  /**
   * 报错。phase 由调用方给（'plan' | 'request'），只往回调与返回结果里带，不参与流程判定。
   * @param {string} action
   * @param {any} error
   * @param {{ phase?: 'plan'|'request', rolledBack?: boolean, stale?: boolean }} [options]
   */
  function reportError(action, error, { phase, rolledBack = false, stale = false } = {}) {
    const list = safeReadList();
    try {
      onError({ type: 'error', action, error, phase, rolledBack, stale, list });
    } catch {
      // 回调抛异常不能盖住原始错误
    }
    return { ok: false, action, error, phase, rolledBack, stale, list };
  }

  async function perform(request) {
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new SessionActionError('no-fetch', '没有可用的 fetch 实现，无法发送会话操作请求');
    }

    // 注解不能省：doFetch 是「注入实现」与 globalThis.fetch 的联合，实参得同时满足
    // RequestInit；不标注时 credentials 会被推成 string，对不上 RequestCredentials。
    /** @type {RequestInit} */
    const init = {
      method: request.method || 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body === undefined ? {} : request.body),
    };

    let timer = null;
    if (timeoutMs > 0 && typeof AbortController === 'function') {
      const control = new AbortController();
      init.signal = control.signal;
      timer = setTimeout(() => {
        try {
          control.abort();
        } catch {
          // 忽略 abort 异常
        }
      }, timeoutMs);
    }

    let res;
    try {
      res = await doFetch(request.url, init);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new SessionActionError('timeout', `请求超时：${request.url}`);
      }
      if (error instanceof Error) throw error;
      throw new SessionActionError('request-failed', String(error));
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (res && res.ok === false) {
      let body = null;
      try {
        const raw = typeof res.text === 'function' ? await res.text() : '';
        body = raw ? JSON.parse(raw) : raw;
      } catch {
        body = null;
      }
      const detail = (body && (body.detail || body.error || body.message)) || res.statusText || '';
      throw new SessionActionError('request-failed', `${res.status || ''} ${detail}`.trim(), {
        status: Number(res.status) || 0,
        body,
      });
    }
    return res;
  }

  async function run(plan) {
    if (!plan || typeof plan.apply !== 'function' || !plan.request || !plan.request.url) {
      return reportError(plan && plan.action ? plan.action : 'unknown',
        new SessionActionError('invalid-plan', '无效的会话操作计划'), { phase: 'plan' });
    }

    const action = plan.action || 'unknown';
    const context = typeof getContext === 'function' ? getContext() : undefined;
    const contextChanged = () => typeof getContext === 'function' && getContext() !== context;
    const before = safeReadList();

    let after;
    try {
      after = plan.apply(before);
    } catch (error) {
      return reportError(action, error, { phase: 'plan' });
    }

    // 乐观更新：先让界面动，再发请求。
    try {
      commitList(after, { action, target: plan.target, phase: 'optimistic' });
    } catch (error) {
      return reportError(action, error, { phase: 'plan' });
    }

    try {
      await perform(plan.request);
      return { ok: true, action, phase: 'request', list: after, stale: contextChanged() };
    } catch (error) {
      // await 后身份已换：旧请求既不能回滚新列表，也不能把旧错误闪到新界面。
      if (contextChanged()) {
        return {
          ok: false,
          action,
          error,
          phase: 'request',
          rolledBack: false,
          stale: true,
          list: safeReadList(),
        };
      }
      // 只有列表还停在自己的乐观结果上才回滚；否则说明用户/别的操作已经改了列表。
      let stillMine = false;
      try {
        stillMine = sameList(readList(), after);
      } catch {
        stillMine = false;
      }
      if (stillMine) {
        try {
          commitList(before, { action, target: plan.target, phase: 'rollback' });
        } catch {
          stillMine = false;
        }
      }
      return reportError(action, error, {
        phase: 'request',
        rolledBack: stillMine,
        stale: !stillMine,
      });
    }
  }

  // 规划阶段的拒绝也要走同一条错误通道，返回值形状保持一致。
  function guarded(action, build) {
    let plan;
    try {
      plan = build();
    } catch (error) {
      return Promise.resolve(reportError(action, error, { phase: 'plan' }));
    }
    return run(plan);
  }

  return {
    run,
    rename: (session, title) => guarded('rename', () => planRename(session, title)),
    togglePin: (session) => guarded('pin', () => planTogglePin(session)),
    archive: (session) => guarded('archive', () => planArchive(session)),
    restore: (session) => guarded('restore', () => planRestore(session)),
  };
}

/* ------------------------------------------------------------------ */
/* 视图：动作菜单                                                       */
/* ------------------------------------------------------------------ */

/* 标题解析：优先级与「会话列表」完全一致。
 * 规则抄自 web/session-list-view.js 的 sessionTitle（title → name → firstMessage 前 60 字
 * → '(无标题)'），不 import 那边是为了不让两个视图模块互相依赖（它还会拖进头像渲染）。
 * 改这里的规则时必须同步改 session-list-view.js，否则菜单标题会和列表行对不上。
 *
 * 宿主现状：/api/sessions 返回的行 title 恒为 null，会话名只存在于 firstMessage，
 * 所以只读 title / name 会让菜单永远显示「(无标题)」。
 */
const TITLE_FALLBACK = '(无标题)';
const TITLE_PREVIEW_CHARS = 60;

function resolveTitle(session) {
  if (!session) return TITLE_FALLBACK;
  const named = session.title || session.name;
  if (named && String(named).trim()) return String(named).trim();
  const first = session.firstMessage && String(session.firstMessage).trim();
  if (first) return first.slice(0, TITLE_PREVIEW_CHARS);
  return TITLE_FALLBACK;
}

/** 重命名输入框的预填值：与标题同一套回退，但不把占位串预填进去，否则用户得先删掉它。 */
function renameSeed(session) {
  const title = resolveTitle(session);
  return title === TITLE_FALLBACK ? '' : title;
}

/**
 * 创建会话动作菜单视图。
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂（必填，杜绝全局隐式读取）
 * @param {Element} [options.mount] 宿主容器（必填）：菜单挂在这里，模块不找别人的节点
 * @param {(event: object) => void} [options.onAction] 动作回调：
 *   { type: 'pin', session }
 *   { type: 'archive', session }（只会在归档确认态里再点一次之后发出）
 *   { type: 'rename', session, title }（title 已 trim，非空）
 * @param {object[]} [options.list] 初始会话列表，用来按 path / sessionId 反查最新行
 * @returns {{
 *   open: (target: object|string) => boolean,
 *   close: () => void,
 *   back: () => boolean,
 *   isOpen: () => boolean,
 *   setList: (list: object[]) => void,
 *   setBusy: (busy: boolean) => void,
 *   dispose: () => void
 * }}
 *
 * open(target) 接受会话对象或 path / sessionId 字符串；字符串必须能在 list 里命中，
 * 命中不到返回 false 且不挂任何 DOM。传对象时优先用 list 里的同一行（pinned/title 可能更新）。
 * 视图只负责「切哪个场景」和「标题是不是空的」，不发请求、不碰列表。
 * setBusy(true) 只是禁用按钮防重复提交；请求结束后必须由调用方 setBusy(false) 恢复。
 *
 * 场景机（都在同一个 sheet 里换面板，不弹第二个窗）：
 *   actions —动作列表：重命名 / 置顶 / 归档
 *   rename  —重命名输入
 *   archive —归档二次确认（点归档不直接执行，必须在这里再确认一次）
 * 返回类交互（Escape、遮罩、关闭按钮、壳的返回键）走 back()：
 *   子场景先退一层，回到动作列表后菜单仍在；已在动作列表才真关。
 *   back() 返回 true 表示「这一下网页已处理」，false 表示菜单本来就没开（退出权交回壳）。
 * close() 是程序化全关，不区分场景；给导航/切换用户这类调用方用。
 */
export function createSessionActionsView({
  document: doc,
  mount,
  onAction = () => {},
  list = [],
} = {}) {
  if (!doc) throw new Error('createSessionActionsView requires { document }');
  if (!mount) throw new Error('createSessionActionsView requires { mount }');

  let items = Array.isArray(list) ? list : [];
  let current = null;
  // actions：动作列表；rename：重命名输入；archive：归档二次确认。
  // 三个场景共用同一个 sheet，只换面板，不开第二个弹窗。
  let mode = 'actions';
  let busy = false;
  let disposed = false;

  let root = null;
  let sheet = null;
  let actionsPanel = null;
  let renamePanel = null;
  let confirmPanel = null;
  let confirmTextEl = null;
  let confirmCancelBtn = null;
  let confirmOkBtn = null;
  let nameEl = null;
  let pinBtn = null;
  let renameInput = null;
  let errorEl = null;
  let saveBtn = null;
  let cancelBtn = null;
  let closeBtn = null;

  const bindings = [];
  let escapeBound = false;

  function el(tag, cls, label) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (label != null) node.textContent = label;
    return node;
  }

  function bind(node, type, handler) {
    node.addEventListener(type, handler);
    bindings.push([node, type, handler]);
  }

  function resolveTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      const key = target.trim();
      if (!key) return null;
      const wanted = normalizePath(key);
      return (
        items.find((row) => {
          const rowPath = sessionPathOf(row);
          if (rowPath && normalizePath(rowPath) === wanted) return true;
          return sessionIdOf(row) === key;
        }) || null
      );
    }
    if (typeof target !== 'object') return null;
    // 列表里的同一行才是最新状态（pinned 可能刚被改过）；列表里没有就用传入对象。
    return items.find((row) => sameSession(row, target)) || target;
  }

  function isAttached(node, parent) {
    return Boolean(node) && node.parentNode === parent;
  }

  function showPanel(panel) {
    for (const candidate of [actionsPanel, renamePanel, confirmPanel]) {
      if (!candidate) continue;
      if (candidate === panel && !isAttached(candidate, sheet)) sheet.appendChild(candidate);
      else if (candidate !== panel && isAttached(candidate, sheet)) sheet.removeChild(candidate);
    }
  }

  function paintBusy() {
    for (const btn of [pinBtn, saveBtn, cancelBtn, confirmCancelBtn, confirmOkBtn]) {
      if (btn) btn.disabled = busy;
    }
    for (const btn of actionButtons()) btn.disabled = busy;
  }

  function actionButtons() {
    if (!actionsPanel) return [];
    const out = [];
    for (const child of actionsPanel.children || []) {
      if (child && child.tagName === 'BUTTON') out.push(child);
    }
    return out;
  }

  function paint() {
    if (!root) return;
    nameEl.textContent = current ? resolveTitle(current) : '';
    pinBtn.textContent = isPinned(current) ? '取消置顶' : '置顶';

    if (mode === 'rename') {
      renameInput.value = current ? renameSeed(current) : '';
      showPanel(renamePanel);
    } else if (mode === 'archive') {
      showPanel(confirmPanel);
    } else {
      showPanel(actionsPanel);
    }
    paintBusy();
  }

  function ensureDom() {
    if (root) return;
    root = el('div', 'sa-overlay');
    root.style.display = 'none';
    root.setAttribute('role', 'presentation');
    root.setAttribute('aria-hidden', 'true');

    sheet = el('div', 'sa-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', '会话操作');

    const head = el('div', 'sa-head');
    nameEl = el('div', 'sa-session-name', '');
    closeBtn = el('button', 'sa-close', '关闭');
    closeBtn.setAttribute('type', 'button');
    head.appendChild(nameEl);
    head.appendChild(closeBtn);

    actionsPanel = el('div', 'sa-actions');
    const renameBtn = el('button', 'sa-action', '重命名');
    renameBtn.setAttribute('type', 'button');
    pinBtn = el('button', 'sa-action', '置顶');
    pinBtn.setAttribute('type', 'button');
    const archiveBtn = el('button', 'sa-action sa-danger', '归档');
    archiveBtn.setAttribute('type', 'button');
    actionsPanel.appendChild(renameBtn);
    actionsPanel.appendChild(pinBtn);
    actionsPanel.appendChild(archiveBtn);

    renamePanel = el('div', 'sa-rename-panel');
    renameInput = el('input', 'sa-rename-input');
    renameInput.setAttribute('type', 'text');
    renameInput.setAttribute('placeholder', '会话标题');
    const renameRow = el('div', 'sa-btn-row');
    cancelBtn = el('button', 'sa-btn', '取消');
    cancelBtn.setAttribute('type', 'button');
    saveBtn = el('button', 'sa-btn sa-btn-primary', '保存');
    saveBtn.setAttribute('type', 'button');
    renameRow.appendChild(cancelBtn);
    renameRow.appendChild(saveBtn);
    renamePanel.appendChild(renameInput);
    renamePanel.appendChild(renameRow);

    // 归档二次确认：文案把后果说全（宿主能还原，但手机端没有归档列表入口）。
    confirmPanel = el('div', 'sa-confirm');
    confirmPanel.setAttribute('role', 'group');
    confirmPanel.setAttribute('aria-label', '确认归档');
    confirmTextEl = el('div', 'sa-confirm-text', '归档后从列表移除，可在桌面端恢复');
    const confirmRow = el('div', 'sa-btn-row');
    confirmCancelBtn = el('button', 'sa-btn sa-confirm-cancel', '取消');
    confirmCancelBtn.setAttribute('type', 'button');
    confirmOkBtn = el('button', 'sa-btn sa-btn-danger', '归档');
    confirmOkBtn.setAttribute('type', 'button');
    confirmRow.appendChild(confirmCancelBtn);
    confirmRow.appendChild(confirmOkBtn);
    confirmPanel.appendChild(confirmTextEl);
    confirmPanel.appendChild(confirmRow);

    // 错误行放在 sheet 层（不属于任何一个面板）：重命名/置顶失败后切到确认态也不会被吃掉。
    errorEl = el('div', 'sa-error', '');
    errorEl.style.display = 'none';

    sheet.appendChild(head);
    sheet.appendChild(errorEl);
    sheet.appendChild(actionsPanel);
    root.appendChild(sheet);
    mount.appendChild(root);

    // 事件全部绑在模块自己创建的节点上，不依赖宿主的选择器约定。
    bind(closeBtn, 'click', () => back());
    bind(renameBtn, 'click', () => {
      if (busy || !current) return;
      setMode('rename');
      if (typeof renameInput.focus === 'function') renameInput.focus();
    });
    bind(pinBtn, 'click', () => act('pin'));
    // 归档不直接执行：先进确认态，点第二下才发 intent。
    bind(archiveBtn, 'click', () => {
      if (busy || !current) return;
      setMode('archive');
    });
    bind(cancelBtn, 'click', () => setMode('actions'));
    bind(saveBtn, 'click', () => submitRename());
    bind(renameInput, 'keydown', (event) => {
      if (event && event.key === 'Enter') submitRename();
    });
    bind(confirmCancelBtn, 'click', () => setMode('actions'));
    bind(confirmOkBtn, 'click', () => act('archive'));
    bind(root, 'click', (event) => {
      // 只有点到遮罩本身才退；点面板内不退。
      if (event && event.target === root) back();
    });

    if (typeof doc.addEventListener === 'function' && !escapeBound) {
      doc.addEventListener('keydown', onKeyDown);
      escapeBound = true;
    }
  }

  function onKeyDown(event) {
    if (event && event.key === 'Escape') back();
  }

  function setMode(next) {
    mode = next;
    // 进入重命名时清掉上一次的提示；退出重命名不清，否则失败反馈会被下一个场景吃掉。
    if (next === 'rename') clearError();
    paint();
  }

  function clearError() {
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  /**
   * 返回键 / 遮罩 / 关闭按钮的统一入口。
   * 有子场景（确认归档、重命名）先只退一层，菜单留着；已经是动作列表才真关。
   * 返回值按壳的约定：true = 这一下网页已处理（不论只退了一层还是关了菜单）。
   */
  function back() {
    if (!current) return false;
    if (mode !== 'actions') {
      setMode('actions');
      return true;
    }
    close();
    return true;
  }

  function close() {
    current = null;
    mode = 'actions';
    if (root) {
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }

  function submitRename() {
    if (busy || !current) return;
    const raw = renameInput.value;
    const title = typeof raw === 'string' ? raw.trim() : '';
    if (!title) {
      showError('标题不能为空');
      return;
    }
    const session = current;
    onAction({ type: 'rename', session, title });
    close();
  }

  function act(type) {
    if (busy || !current) return;
    const session = current;
    onAction({ type, session });
    close();
  }

  function open(target) {
    if (disposed) return false;
    const session = resolveTarget(target);
    if (!session) return false;
    current = session;
    mode = 'actions';
    ensureDom();
    clearError();
    paint();
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');
    return true;
  }

  function setList(next) {
    items = Array.isArray(next) ? next : [];
  }

  function setBusy(value) {
    busy = Boolean(value);
    if (root) paintBusy();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    current = null;
    mode = 'actions';
    for (const [node, type, handler] of bindings) {
      if (node && typeof node.removeEventListener === 'function') {
        node.removeEventListener(type, handler);
      }
    }
    bindings.length = 0;
    if (escapeBound && doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('keydown', onKeyDown);
      escapeBound = false;
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    sheet = null;
    actionsPanel = null;
    renamePanel = null;
    confirmPanel = null;
    confirmTextEl = null;
    confirmCancelBtn = null;
    confirmOkBtn = null;
    nameEl = null;
    pinBtn = null;
    renameInput = null;
    errorEl = null;
    saveBtn = null;
    cancelBtn = null;
    closeBtn = null;
  }

  return { open, close, back, isOpen: () => Boolean(current), setList, setBusy, dispose };
}
