/* web/message-actions.js — 单条消息的操作（复制 / 引用 / 重试 / 重发 / 编辑重发）
 *
 * 管什么：
 *  - 纯函数 actionsForMessage(message, context)：判断某条消息有哪些操作、每个操作
 *    是否可用、为什么不可用、可用时执行计划是什么；
 *  - 「引用」只产出 plan { kind: 'quote', text, author?, at }：引用条与拼正文由
 *    app 层（web/quote-bar.js）接管，本模块不读写输入框；
 *  - 请求体构造：retry 用 { sessionId, sessionPath }，replay 用 { path }；
 *  - 剪贴板复制与降级（navigator.clipboard → document.execCommand）；
 *  - 底部操作菜单视图 createMessageActionsMenu({ mount, onRun })；
 *  - 可选的执行器 runMessageAction(action, adapters)：只调用调用方注入的适配器。
 *
 * 不管什么：
 *  - 不 import app.js、不读全局 S、不直接 fetch；请求由调用方注入；
 *  - 不监听或改写消息 DOM，不决定菜单由长按、右键还是按钮触发；
 *  - 不自动发送、不自动重载历史、不判断服务端是否正在流式（由 context.streaming 传入）；
 *  - 不操作 mount 以外的节点，菜单只 append 到调用方给的 mount。
 *
 * 宿主接口（1.5.48-beta bundle 已核对）：
 *  - POST /api/sessions/turns/retry
 *      body 接受 { sessionId, sessionPath }；sessionId 存在时服务端会解析当前 locator，
 *      若同时给的 path 与 locator 不一致会返回 409，所以这里原样带当前会话的两个字段。
 *  - POST /api/sessions/latest-user-message/replay
 *      只认 body.path（也兼容 sessionPath），所以只能重发最后一条用户消息。
 *  - 没有「编辑历史消息」的接口。因此「编辑重发」不是服务端改写：把该条用户消息的
 *    正文原样填回输入框并聚焦，由用户自己确认发送。不要在这里伪造 clientMessageId
 *    或 replacementText。
 *
 * 分层：
 *  - 纯函数层不碰 DOM / 网络，可直接在 Node 里测；
 *  - 视图层只依赖 document 的最小 API，onRun 收到 { action, message, context }；
 *  - 执行器把 plan 翻译成 api / fillComposer / copy 调用，异常一律转成结果对象。
 */

const RETRY_PATH = '/api/sessions/turns/retry';
const REPLAY_PATH = '/api/sessions/latest-user-message/replay';

const COPY_LABEL = '复制全文';
const QUOTE_LABEL = '引用';
const RETRY_LABEL = '重试';
const REPLAY_LABEL = '重发';
const EDIT_LABEL = '编辑重发';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 消息正文：兼容宿主历史里的 text / content 字符串 / content 文本块数组。 */
function textOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  if (isNonEmptyString(message.text)) return message.text;
  if (isNonEmptyString(message.content)) return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block === 'string') return block;
        return typeof block?.text === 'string' ? block.text : '';
      })
      .filter((part) => part !== '')
      .join('\n');
  }
  return '';
}

/**
 * 消息自带的说话人显示名。宿主历史与渲染层字段不统一，按常见几个字段名取第一个非空值；
 * 都拿不到就返回空串，由 quoteAction 用 context 里的 userName/agentName 兜底。
 */
function speakerNameOfMessage(message) {
  for (const key of ['author', 'name', 'speakerName']) {
    if (isNonEmptyString(message?.[key])) return message[key].trim();
  }
  return '';
}

/** 时间戳：毫秒数或 ISO 字符串都原样带走，没有就返回 null（不放进 plan）。 */
function messageAtOf(message) {
  for (const key of ['at', 'ts', 'timestamp', 'createdAt', 'time']) {
    const value = message?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function normalizeMessage(message) {
  const role = message?.role === 'user' || message?.role === 'assistant' ? message.role : null;
  return {
    role,
    id: message?.id ?? null,
    text: textOfMessage(message),
    author: speakerNameOfMessage(message),
    at: messageAtOf(message),
    isLastAssistant: message?.isLastAssistant,
    isLastUser: message?.isLastUser,
  };
}

/** 会话引用：当前 app 用 path，宿主请求体用 sessionPath，两者都收。 */
function normalizeSession(session) {
  if (!session || typeof session !== 'object') return { sessionId: '', path: '' };
  const sessionId = isNonEmptyString(session.sessionId) ? session.sessionId.trim() : '';
  const path = isNonEmptyString(session.path)
    ? session.path
    : (isNonEmptyString(session.sessionPath) ? session.sessionPath : '');
  return { sessionId, path };
}

function hasSession(session) {
  return Boolean(session.sessionId || session.path);
}

/**
 * 是否最后一条。
 *
 * 消息自带 isLastAssistant / isLastUser 时以它为准（实时追加的消息没有历史 id，
 * 但渲染方知道它是不是最后一条）；否则用 context 里的 lastAssistantId/lastUserId
 * 与消息 id 比较。两边都不知道就按「不是最后一条」处理，宁可不给入口。
 */
function isLastMessage(message, context, role) {
  const flag = role === 'assistant' ? message.isLastAssistant : message.isLastUser;
  if (typeof flag === 'boolean') return flag;
  const lastId = role === 'assistant' ? context.lastAssistantId : context.lastUserId;
  if (lastId == null || message.id == null) return false;
  return String(lastId) === String(message.id);
}

/**
 * 造一条菜单项。
 *
 * options 的类型必须写成 JSDoc 参数块：available 是无默认值的解构绑定，tsc 推 JS 形参时
 * 只留下有默认值的几个（hidden/plan/reason/reasonCode），底下各条规则里的 available: true
 * 就全成了多余属性。
 *
 * @param {'copy'|'quote'|'retry'|'replay'|'edit-resend'} id 与外层 actionsForMessage 声明的五个入口对齐
 * @param {string} label
 * @param {{ available?: boolean, hidden?: boolean, reason?: string, reasonCode?: any, plan?: any }} [options]
 */
function makeAction(id, label, { available, hidden = false, reason = '', reasonCode = null, plan = null } = {}) {
  const enabled = Boolean(available) && !hidden;
  return {
    id,
    label,
    available: enabled,
    hidden: Boolean(hidden),
    reason: enabled ? '' : reason,
    reasonCode: enabled ? null : reasonCode,
    plan: enabled ? plan : null,
  };
}

function unavailable(id, label, reasonCode, reason, { hidden = false } = {}) {
  return makeAction(id, label, {
    available: false,
    hidden,
    reasonCode,
    reason,
  });
}

/** 复制：只要正文非空就可用；流式中复制不受影响。 */
function copyAction(message) {
  if (!isNonEmptyString(message.text)) {
    return unavailable('copy', COPY_LABEL, 'empty-text', '这条消息没有可复制的文字', { hidden: true });
  }
  return makeAction('copy', COPY_LABEL, {
    available: true,
    plan: { kind: 'copy', text: message.text },
  });
}

/**
 * 引用：把这条消息的正文做成一条引用，交给 app 层的引用条。
 *
 * 纯本地动作：不需要会话、也不受「正在生成」限制 —— 引用一条旧消息不该被
 * 当前这一轮生成挡住。唯一的结构性不可用是没有正文（和 copy 一样直接不画）。
 *
 * @param {{role: 'user'|'assistant'|null, text: string, author: string, at: number|string|null}} message
 * @param {{userName?: string, agentName?: string}} [context] 没有消息级说话人名时的兜底
 * @param {object} [_session] 与其它 action 构造器保持同一签名；引用不依赖会话
 */
function quoteAction(message, context, _session) {
  if (!isNonEmptyString(message.text)) {
    return unavailable('quote', QUOTE_LABEL, 'empty-text', '这条消息没有可引用的文字', { hidden: true });
  }
  const plan = { kind: 'quote', text: message.text };
  const author = quoteAuthor(message, context);
  if (author) plan.author = author;
  if (message.at != null) plan.at = message.at;
  return makeAction('quote', QUOTE_LABEL, { available: true, plan });
}

/** 引用里的说话人：消息自带优先，否则助手用 agentName、用户用 userName。 */
function quoteAuthor(message, context) {
  if (isNonEmptyString(message.author)) return message.author;
  const fallback = message.role === 'assistant' ? context?.agentName : context?.userName;
  return isNonEmptyString(fallback) ? fallback.trim() : '';
}

/** 重试上一轮：只对最后一条助手回复开放；流式中禁用并说明原因。 */
function retryAction(message, context, session) {
  if (!isLastMessage(message, context, 'assistant')) {
    return unavailable('retry', RETRY_LABEL, 'not-last', '只有最后一条助手回复可以重试', { hidden: true });
  }
  if (!hasSession(session)) {
    return unavailable('retry', RETRY_LABEL, 'no-session', '没有打开的会话');
  }
  if (context.streaming === true) {
    return unavailable('retry', RETRY_LABEL, 'streaming', '正在生成回复，结束后才能重试');
  }
  const plan = buildRetryRequest(session);
  if (!plan) {
    return unavailable('retry', RETRY_LABEL, 'no-session', '没有打开的会话');
  }
  return makeAction('retry', RETRY_LABEL, { available: true, plan });
}

/** 重发最后一条用户消息：服务端只接受 path，且天然只能作用于最新一条。 */
function replayAction(message, context, session) {
  if (!isLastMessage(message, context, 'user')) {
    return unavailable('replay', REPLAY_LABEL, 'not-last', '只能重发最后一条用户消息', { hidden: true });
  }
  if (!session.path) {
    if (!session.sessionId) {
      return unavailable('replay', REPLAY_LABEL, 'no-session', '没有打开的会话');
    }
    return unavailable('replay', REPLAY_LABEL, 'no-session-path', '缺少会话路径，无法重发');
  }
  if (context.streaming === true) {
    return unavailable('replay', REPLAY_LABEL, 'streaming', '正在生成回复，结束后才能重发');
  }
  const plan = buildReplayRequest(session);
  if (!plan) {
    return unavailable('replay', REPLAY_LABEL, 'no-session-path', '缺少会话路径，无法重发');
  }
  return makeAction('replay', REPLAY_LABEL, { available: true, plan });
}

/** 编辑重发：只做「回填输入框 + 聚焦」的本地计划，不是服务端改写。 */
function editResendAction(message, context, session) {
  if (!isNonEmptyString(message.text)) {
    return unavailable('edit-resend', EDIT_LABEL, 'empty-text', '这条消息没有可回填的文字', { hidden: true });
  }
  if (context.streaming === true) {
    return unavailable('edit-resend', EDIT_LABEL, 'streaming', '正在生成回复，结束后再编辑发送');
  }
  if (!hasSession(session)) {
    return unavailable('edit-resend', EDIT_LABEL, 'no-session', '没有打开的会话');
  }
  return makeAction('edit-resend', EDIT_LABEL, {
    available: true,
    plan: { kind: 'edit', text: message.text },
  });
}

/**
 * 一条消息能做什么。
 *
 * @param {object} message
 *   { id?, role: 'user'|'assistant', text?, content?, author?, name?, at?, ts?,
 *     isLastAssistant?, isLastUser? }
 *   text 优先；没有 text 时兼容 content 字符串或文本块数组。
 *   author/name/at/ts 只有引用用得到，缺了就不写进 plan。
 * @param {object} [context]
 *   {
 *     session: { sessionId?, path? } | null,
 *     streaming: boolean,             // 当前是否正在生成回复
 *     lastAssistantId?: string|number,
 *     lastUserId?: string|number,
 *     userName?: string,              // 引用时给用户消息兜底说话人
 *     agentName?: string              // 引用时给助手消息兜底说话人
 *   }
 * @returns {{ role: 'user'|'assistant'|null, actions: Array<{
 *   id: 'copy'|'quote'|'retry'|'replay'|'edit-resend',
 *   label: string,
 *   available: boolean,
 *   hidden: boolean,                 // true = 连入口都不该画（结构性不适用）
 *   reason: string,                  // available=false 时的中文原因
 *   reasonCode: string|null,         // no-session / streaming / not-last / empty-text …
 *   plan: object|null                // 可用时的执行计划
 * }> }}
 */
export function actionsForMessage(message, context = {}) {
  const normalized = normalizeMessage(message);
  if (!normalized.role) return { role: null, actions: [] };

  const ctx = context && typeof context === 'object' ? context : {};
  const session = normalizeSession(ctx.session);

  const actions = normalized.role === 'assistant'
    ? [copyAction(normalized), quoteAction(normalized, ctx), retryAction(normalized, ctx, session)]
    : [copyAction(normalized), quoteAction(normalized, ctx), editResendAction(normalized, ctx, session), replayAction(normalized, ctx, session)];

  return { role: normalized.role, actions };
}

/**
 * 重试计划。body 里只放确实存在的字段：sessionId 能让服务端解析 locator，
 * sessionPath 是当前会话路径；两者都没有就返回 null，不发空请求。
 */
export function buildRetryRequest(session) {
  const ref = normalizeSession(session);
  if (!ref.sessionId && !ref.path) return null;
  const body = {};
  if (ref.sessionId) body.sessionId = ref.sessionId;
  if (ref.path) body.sessionPath = ref.path;
  return { kind: 'http', method: 'POST', path: RETRY_PATH, body };
}

/** 重发计划。服务端 replay 只认 path，缺 path 就不构造。 */
export function buildReplayRequest(session) {
  const ref = normalizeSession(session);
  if (!ref.path) return null;
  return {
    kind: 'http',
    method: 'POST',
    path: REPLAY_PATH,
    body: { path: ref.path },
  };
}

/**
 * 复制文本到系统剪贴板。
 *
 * 优先 navigator.clipboard.writeText（安全上下文 + 有用户手势时可用），
 * 失败或不支持时退回 document.execCommand('copy')（老 WebView 的唯一办法）。
 * 无论哪条路失败都返回明确状态，不抛异常。
 *
 * @returns {Promise<{ok: boolean, via?: 'clipboard'|'execCommand', code?: string, message: string}>}
 */
export async function copyTextToClipboard(text, {
  navigator: nav = globalThis.navigator,
  document: doc = globalThis.document,
} = {}) {
  if (!isNonEmptyString(text)) {
    return { ok: false, code: 'empty', message: '没有可复制的文字' };
  }

  const clipboard = nav && nav.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return { ok: true, via: 'clipboard', message: '已复制' };
    } catch {
      // 权限/非安全上下文/WebView 限制：继续走 execCommand，不在这里判死刑。
    }
  }

  return copyWithExecCommand(text, doc);
}

function copyWithExecCommand(text, doc) {
  if (
    !doc
    || typeof doc.createElement !== 'function'
    || !doc.body
    || typeof doc.execCommand !== 'function'
  ) {
    return { ok: false, code: 'unsupported', message: '当前环境不支持复制，请长按选择文字手动复制' };
  }

  let area = null;
  let previous = null;
  try {
    previous = doc.activeElement || null;
    area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    if (area.style) {
      area.style.position = 'fixed';
      area.style.top = '-9999px';
      area.style.left = '-9999px';
    }
    doc.body.appendChild(area);
    if (typeof area.focus === 'function') area.focus();
    if (typeof area.select === 'function') area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length);

    const copied = Boolean(doc.execCommand('copy'));
    if (copied) return { ok: true, via: 'execCommand', message: '已复制' };
    return { ok: false, code: 'copy-failed', message: '复制失败，请长按选择文字手动复制' };
  } catch {
    return { ok: false, code: 'copy-failed', message: '复制失败，请长按选择文字手动复制' };
  } finally {
    if (area && area.parentNode) area.parentNode.removeChild(area);
    if (previous && previous !== doc.body && typeof previous.focus === 'function') {
      try { previous.focus(); } catch { /* 恢复焦点失败不影响复制结果 */ }
    }
  }
}

function normalizeCopyResult(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  if (result === true) return { ok: true, code: 'copied', message: '已复制' };
  return { ok: false, code: 'copy-failed', message: '复制失败，请长按选择文字手动复制' };
}

/**
 * 执行一个操作计划。适配器全部由调用方注入：
 *   api(path, init)        同源请求函数（app 的 createApiClient 即可）
 *   fillComposer(text)     把正文填回输入框并聚焦（不发送）
 *   copy(text)             可选，默认 copyTextToClipboard
 *
 * 成功/失败都返回结果对象，绝不抛异常；HTTP 409 归为 session-busy。
 */
export async function runMessageAction(action, adapters = {}) {
  const plan = action && action.available === true && action.plan
    ? action.plan
    : null;
  if (!plan || typeof plan !== 'object') {
    return { ok: false, code: 'unavailable', message: action?.reason || '这个操作当前不可用' };
  }

  try {
    if (plan.kind === 'copy') {
      const copy = typeof adapters.copy === 'function' ? adapters.copy : copyTextToClipboard;
      return normalizeCopyResult(await copy(plan.text));
    }

    if (plan.kind === 'edit') {
      if (typeof adapters.fillComposer !== 'function') {
        return { ok: false, code: 'composer-unavailable', message: '输入框不可用，无法编辑重发' };
      }
      await adapters.fillComposer(plan.text);
      return { ok: true, code: 'composer-filled', message: '已填回输入框，确认后发送' };
    }

    // 引用不走通用执行器：本模块只产出 plan，引用条与拼正文由 app 层接管。
    // 这里显式返回，不让它落到下面的 unknown-plan。
    if (plan.kind === 'quote') {
      return { ok: false, code: 'quote-delegated', message: '引用由消息菜单直接处理，不经过执行器' };
    }

    if (plan.kind === 'http') {
      if (typeof adapters.api !== 'function') {
        return { ok: false, code: 'api-unavailable', message: '请求执行器未注入' };
      }
      const response = await adapters.api(plan.path, {
        method: plan.method || 'POST',
        body: JSON.stringify(plan.body || {}),
      });
      return { ok: true, code: 'request-ok', message: '已提交', response };
    }

    return { ok: false, code: 'unknown-plan', message: '不支持的操作类型' };
  } catch (err) {
    const status = err && typeof err === 'object' ? err.status : undefined;
    const serverCode = err?.body?.error || err?.code || '';
    if (plan.kind === 'http' && status === 409 && (serverCode === 'session_busy' || /session_busy/.test(String(err?.message || '')))) {
      return { ok: false, code: 'session-busy', status, message: '会话正在生成回复，稍后再试' };
    }
    if (plan.kind === 'copy') {
      return { ok: false, code: 'copy-failed', message: '复制失败，请长按选择文字手动复制' };
    }
    if (plan.kind === 'edit') {
      return { ok: false, code: 'composer-failed', message: '输入框写入失败，请手动复制' };
    }
    return {
      ok: false,
      code: 'request-failed',
      status,
      message: `请求失败：${err?.message || String(err)}`,
    };
  }
}

/**
 * 底部操作菜单。
 *
 * 只 append 到调用方给的 mount（通常是一个全屏浮层或 document.body），
 * 不读取、不改写入参消息节点。open() 自己计算 actionsForMessage，hidden
 * 为 true 的操作不画；不可用的操作画出来但不可点，并显示原因。
 *
 * @param {object} [options]
 * @param {Element} [options.mount] 菜单挂载容器（必须支持 appendChild）
 * @param {(payload: {action: object, message: object, context: object}) => any} [options.onRun]
 * @param {(err: Error) => void} [options.onError] onRun 同步抛错或异步 reject 时调用
 * @param {Document} [options.document]
 * @returns {{ open: Function, close: Function, destroy: Function, isOpen: Function }}
 */
export function createMessageActionsMenu({
  mount,
  onRun,
  onError,
  document: doc = globalThis.document,
} = {}) {
  if (!mount || typeof mount.appendChild !== 'function') {
    throw new TypeError('createMessageActionsMenu requires { mount }');
  }

  let root = null;
  let panel = null;
  let list = null;
  let cancelButton = null;
  let itemButtons = [];
  let openState = null;
  let savedFocus = null;
  let disposed = false;

  function reportError(err) {
    if (typeof onError === 'function') {
      try { onError(err); } catch { /* 调用方的错误处理也不能拖垮菜单 */ }
      return;
    }
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[message-actions]', err);
    }
  }

  function ensureDom() {
    if (disposed) return false;
    if (root) return true;
    if (!doc || typeof doc.createElement !== 'function') return false;

    root = doc.createElement('div');
    root.className = 'msg-actions';
    root.hidden = true;
    root.setAttribute('role', 'presentation');

    root.addEventListener('click', (event) => {
      if (event && event.target === root) close();
    });
    root.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Escape') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      close();
    });

    panel = doc.createElement('div');
    panel.className = 'msg-actions-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', '消息操作');

    const title = doc.createElement('div');
    title.className = 'msg-actions-title';
    title.textContent = '消息操作';

    list = doc.createElement('div');
    list.className = 'msg-actions-list';

    cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'msg-actions-cancel';
    cancelButton.textContent = '取消';
    cancelButton.addEventListener('click', () => close());

    panel.appendChild(title);
    panel.appendChild(list);
    panel.appendChild(cancelButton);
    root.appendChild(panel);
    mount.appendChild(root);
    return true;
  }

  function render(actions) {
    for (const node of [...list.children]) list.removeChild(node);
    itemButtons = [];

    for (const action of actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'msg-actions-item';
      button.setAttribute('data-action', action.id);
      button.setAttribute('role', 'menuitem');

      const label = doc.createElement('span');
      label.className = 'msg-actions-label';
      label.textContent = action.label;
      button.appendChild(label);

      if (!action.available) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        button.title = action.reason;
        const reason = doc.createElement('span');
        reason.className = 'msg-actions-reason';
        reason.textContent = action.reason;
        button.appendChild(reason);
      } else {
        button.addEventListener('click', () => choose(action));
      }

      list.appendChild(button);
      itemButtons.push(button);
    }
  }

  function choose(action) {
    const current = openState;
    close();
    if (!current || typeof onRun !== 'function') return;
    try {
      const pending = onRun({
        action,
        message: current.message,
        context: current.context,
      });
      if (pending && typeof pending.then === 'function') {
        Promise.resolve(pending).catch((err) => reportError(err));
      }
    } catch (err) {
      reportError(err);
    }
  }

  function open({ message, context } = {}) {
    if (disposed) return false;
    const result = actionsForMessage(message, context);
    const visible = result.actions.filter((action) => !action.hidden);
    if (!visible.length) {
      close();
      return false;
    }
    if (!ensureDom()) return false;

    openState = {
      message,
      context: context && typeof context === 'object' ? context : {},
    };
    render(visible);
    savedFocus = doc.activeElement || null;
    root.hidden = false;

    const firstEnabled = itemButtons.find((button) => !button.disabled);
    if (firstEnabled && typeof firstEnabled.focus === 'function') {
      try { firstEnabled.focus(); } catch { /* 焦点不是功能必需 */ }
    }
    return true;
  }

  function close() {
    const wasOpen = Boolean(root && root.hidden === false);
    if (root) root.hidden = true;
    openState = null;
    const focusTarget = savedFocus;
    savedFocus = null;
    // 不把焦点还给输入框：长按消息时输入框可能还处于聚焦态，还回去会把键盘重新弹起来。
    const editable = focusTarget && (
      focusTarget.isContentEditable === true
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(focusTarget.tagName || '').toUpperCase())
    );
    if (wasOpen && focusTarget && !editable && focusTarget !== doc?.body && typeof focusTarget.focus === 'function') {
      try { focusTarget.focus(); } catch { /* 恢复焦点失败不影响关闭 */ }
    }
  }

  function destroy() {
    disposed = true;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    panel = null;
    list = null;
    cancelButton = null;
    itemButtons = [];
    openState = null;
    savedFocus = null;
  }

  function isOpen() {
    return Boolean(root && root.hidden === false);
  }

  return { open, close, destroy, isOpen };
}
