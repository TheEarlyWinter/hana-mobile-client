/* web/login-view.js
 *
 * 登录视图：账号密码单模式。
 *
 * 只负责 DOM 状态与用户意图：
 *   - 提交只把 { username, password } 交给 onSubmit，并立即清空密码；
 *   - 退出登录只把意图交给 onSwitchLogin，本视图不发请求、不判断权限；
 *   - 不读剪贴板、URL、任何持久化存储，也不记录秘密。
 */

/**
 * @param {object} options
 * @param {Document} options.document - DOM 工厂
 * @param {(payload: {username: string, password: string}) => any} [options.onSubmit]
 * @param {() => void} [options.onSwitchLogin]
 * @returns {{ setState: (state?: {pending?: boolean, error?: string}) => void, clearSecrets: () => void, dispose: () => void }}
 */
export function createLoginView({
  document: doc,
  onSubmit = () => {},
  onSwitchLogin = () => {},
} = {}) {
  if (!doc) {
    throw new Error('createLoginView requires { document }');
  }

  const byId = (id) => (typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);

  const els = {
    user: byId('inUser'),
    pass: byId('inPass'),
    submit: byId('btnLogin'),
    error: byId('loginErr'),
    switchLogin: byId('btnSwitchLogin'),
  };

  const submitLabel = (els.submit && typeof els.submit.textContent === 'string' && els.submit.textContent.trim()) || '登录';
  const pendingLabel = '登录中…';

  let pending = false;
  let disabled = false;
  let submitLocked = false;
  const listeners = [];

  function listen(el, type, handler) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, handler);
    listeners.push({ el, type, handler });
  }

  function setError(value) {
    if (els.error) els.error.textContent = value;
  }

  function applyPending() {
    for (const el of [els.submit, els.user, els.pass, els.switchLogin]) {
      if (el) el.disabled = pending;
    }
    if (els.submit) els.submit.textContent = pending ? pendingLabel : submitLabel;
  }

  function clearSecrets() {
    if (els.pass) els.pass.value = '';
  }

  function setState(options = {}) {
    if (disabled) return;
    const state = options && typeof options === 'object' ? options : {};
    if (typeof state.pending === 'boolean') {
      pending = state.pending;
      if (!pending) submitLocked = false;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'error')) {
      setError(typeof state.error === 'string' ? state.error : '');
    }
    applyPending();
  }

  function buildPayload() {
    return {
      username: els.user ? els.user.value.trim() : '',
      password: els.pass ? els.pass.value : '',
    };
  }

  function releaseSubmitLock() {
    submitLocked = false;
  }

  function submit() {
    if (disabled || pending || submitLocked) return;

    const payload = buildPayload();
    // 捕获后立刻清密码；随后无论成功失败都不在视图里残留。
    clearSecrets();
    submitLocked = true;

    let result;
    try {
      result = onSubmit(payload);
    } catch (err) {
      releaseSubmitLock();
      throw err;
    }

    if (result && typeof result.then === 'function') {
      result.then(releaseSubmitLock, releaseSubmitLock);
    } else {
      Promise.resolve().then(releaseSubmitLock);
    }
  }

  function onKeydown(event) {
    // IME 组合输入中的 Enter 用于确认候选词，不能当提交。
    if (!event || event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    submit();
  }

  function handleSwitchLogin() {
    if (disabled || pending) return;
    onSwitchLogin();
  }

  listen(els.submit, 'click', submit);
  listen(els.user, 'keydown', onKeydown);
  listen(els.pass, 'keydown', onKeydown);
  listen(els.switchLogin, 'click', handleSwitchLogin);

  applyPending();

  function dispose() {
    if (disabled) return;
    disabled = true;
    while (listeners.length > 0) {
      const { el, type, handler } = listeners.pop();
      if (typeof el.removeEventListener === 'function') el.removeEventListener(type, handler);
    }
    // 首次 dispose 顺手清掉尚未提交的密码；重复 dispose 直接返回，
    // 避免清掉随后重建的新视图输入。
    clearSecrets();
  }

  return { setState, clearSecrets, dispose };
}
