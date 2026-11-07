/* web/login-controller.js
 *
 * 手机版账号密码登录控制器：只把用户名/密码送进宿主既有 /api/web-auth/login，
 * 不碰 DOM、不读全局状态、不持久化 secret，也不自己给 principal 加权限。
 *
 * 宿主契约（源码核对，真机未验）：
 *   POST /api/web-auth/login   body: { username, password }
 *     成功：Set-Cookie HttpOnly，返回 { ok, expiresAt, principal }
 *   POST /api/web-auth/logout  清 Cookie。
 *
 * 边界：
 *   - 客户端绝不发送 credential / scopes / Authorization / owner 头，不伪造权限。
 *   - 不把 secret 拼进 URL、不写 localStorage/sessionStorage、不 console。
 *   - 错误只给已脱敏的中文提示，绝不回显 API 原始 body / err.message。
 *   - 全局在途锁：login / logout 同一时刻只允许一个；重复点击直接返回安全提示，
 *     不发第二个请求，也绝不自动重试。锁一直保持到 onAuthenticated / onLoggedOut
 *     完整结束（含 app 的 /session 核对与 boot）。
 *   - onAuthenticated 返回 false 表示“Cookie 有了但会话未生效”，不当作成功。
 *   - dispose 只废弃本控制器之后的回调；已经发出的登录/退出请求无法撤销
 *     （Cookie 的写入/清除由宿主完成），这里不做相反承诺。
 */

const SAFE = Object.freeze({
  busy: '正在处理，请稍候',
  missing: '请输入用户名和密码',
  badCredentials: '用户名或密码不正确',
  forbidden: '登录被拒绝，请检查用户名和密码',
  badRequest: '登录信息不完整或格式不正确',
  tooMany: '尝试次数过多，请稍后再试',
  server: 'Hana 暂时不可用，请稍后再试',
  network: '连不上 Hana，请检查网络后重试',
  failed: '登录失败，请稍后再试',
  notEffective: '登录没有生效，请重试',
  callbackFailed: '登录已提交，但页面初始化失败，请重试',
  logoutFailed: '退出登录失败，请稍后再试',
});

function statusOf(error) {
  return error && typeof error === 'object' && typeof error.status === 'number'
    ? error.status
    : null;
}

/** 登录失败 → 安全中文提示。绝不使用 error.message / response body。 */
function loginErrorText(error) {
  const status = statusOf(error);
  if (status === 401) return SAFE.badCredentials;
  if (status === 403) return SAFE.forbidden;
  if (status === 400 || status === 422) return SAFE.badRequest;
  if (status === 429) return SAFE.tooMany;
  if (status !== null && status >= 500) return SAFE.server;
  if (status !== null) return SAFE.failed;
  return SAFE.network;
}

function logoutErrorText(error) {
  const status = statusOf(error);
  if (status !== null && status >= 500) return SAFE.server;
  if (status !== null && status !== 401 && status !== 403) return SAFE.logoutFailed;
  if (status === null) return SAFE.network;
  return SAFE.logoutFailed;
}

/**
 * @param {object} options
 * @param {(pathname: string, init?: object) => Promise<any>} options.api 同源请求函数
 * @param {(result: object) => any} [options.onAuthenticated] 登录成功（Cookie 已由宿主写入）；
 *   调用方必须再用 /api/web-auth/session 核对官方 principal，返回 false 表示会话未生效。
 * @param {() => any} [options.onLoggedOut] 退出成功（Cookie 已由宿主清除）
 * @param {(state: {pending: boolean, error: string|null}) => void} [options.onState]
 * @returns {{ login: (input: {username?: string, password?: string}) => Promise<boolean>, logout: () => Promise<boolean>, dispose: () => void }}
 */
export function createLoginController({
  api,
  onAuthenticated = () => {},
  onLoggedOut = () => {},
  onState = () => {},
} = {}) {
  if (typeof api !== 'function') {
    throw new TypeError('createLoginController requires { api }');
  }

  let pending = false;
  let disposed = false;

  function emit(error) {
    if (disposed) return;
    onState({ pending, error: error || null });
  }

  async function login(input) {
    if (disposed) return false;
    // 锁优先：任何在途登录/退出期间的新请求都只给安全提示，不先做字段判断。
    if (pending) {
      emit(SAFE.busy);
      return false;
    }

    const username = input && typeof input.username === 'string' ? input.username.trim() : '';
    // 密码保持原样：空格可以是密码的一部分，不能 trim。
    const password = input && typeof input.password === 'string' ? input.password : '';
    if (!username || !password) {
      emit(SAFE.missing);
      return false;
    }

    pending = true;
    emit(null);

    let sent;
    try {
      // 同步调用 api：锁已经置上，第二个点击在同一个 tick 就会看到 pending。
      sent = api('/api/web-auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    } catch (error) {
      pending = false;
      emit(loginErrorText(error));
      return false;
    }

    let result;
    try {
      result = await Promise.resolve(sent);
    } catch (error) {
      pending = false;
      emit(loginErrorText(error));
      return false;
    }

    // dispose 后不再调用可控回调（已发出的 Cookie 请求无法撤回）。
    if (disposed) {
      pending = false;
      return false;
    }

    // 锁必须保持到官方 principal 核对 + boot 全部完成：此时若放开，
    // 第二次登录/退出会发出额外请求，旧回调还可能覆盖新登录。
    let verdict;
    try {
      verdict = await onAuthenticated(result && typeof result === 'object' ? result : { ok: true });
    } catch (error) {
      pending = false;
      emit(SAFE.callbackFailed);
      return false;
    }

    pending = false;
    if (disposed) return false;
    if (verdict === false) {
      emit(SAFE.notEffective);
      return false;
    }
    emit(null);
    return true;
  }

  async function logout() {
    if (disposed) return false;
    if (pending) {
      emit(SAFE.busy);
      return false;
    }

    pending = true;
    emit(null);

    let sent;
    try {
      sent = api('/api/web-auth/logout', { method: 'POST' });
    } catch (error) {
      pending = false;
      emit(logoutErrorText(error));
      return false;
    }

    try {
      await Promise.resolve(sent);
    } catch (error) {
      pending = false;
      emit(logoutErrorText(error));
      return false;
    }

    if (disposed) {
      pending = false;
      return false;
    }

    // 注销回调也等它（可能是 Promise）完整结束再解锁；失败不当成功。
    try {
      await onLoggedOut();
    } catch (error) {
      pending = false;
      emit(SAFE.logoutFailed);
      return false;
    }

    pending = false;
    if (disposed) return false;
    emit(null);
    return true;
  }

  function dispose() {
    disposed = true;
    pending = false;
  }

  return { login, logout, dispose };
}
