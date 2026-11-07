/* 浏览器同源 HTTP 客户端：从 web/app.js 的 api() 原样抽出。
 *
 * 只负责 JSON 请求/解析与超时，不持业务状态、不碰 DOM。默认 fetch 在每次
 * 调用时读取 globalThis.fetch，方便测试替换，也让宿主运行时可以换实现。
 */

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 自定义 fetch；缺省用调用时的 globalThis.fetch
 * @param {number} [options.timeoutMs] 覆盖 fetch + res.text 的总超时，默认 15000
 * @returns {(pathname: string, init?: object) => Promise<any>}
 */
export function createApiClient({ fetchImpl, timeoutMs = 15000 } = {}) {
  return async function api(pathname, init = {}) {
    const headers = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    };
    // 千万别再带 X-Hana-Input-Draft-Owner。服务端会对这个头做严格比对：
    // 必须是 S3e(principal, runtimeContext) 算出来的 `hana.input-draft-owner.v1:<sha256>`，
    // 随便填个字符串会直接被 409 input_owner_changed 挡掉（新建会话就是这么挂的）。
    // 服务端对「不带这个头」是放行的，而我们本来也不用服务端的草稿槽。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let raw;
    try {
      // 默认每次调用时再取 globalThis.fetch，不在工厂初始化时捕获
      const doFetch = fetchImpl || globalThis.fetch;
      res = await doFetch(pathname, { credentials: 'same-origin', ...init, headers, signal: ctrl.signal });
      raw = await res.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // 超时不是 HTTP 响应：带 code='timeout' 让调用方能把「等太久」和「服务端报错」
        // 分开处理（历史分页靠它决定不再重试），message 保持中文原样给界面直接展示，
        // 不填 status/body，否则会被当成服务端真实报错去重试。
        const timeout = new Error(`请求超时：${pathname}`);
        timeout.code = 'timeout';
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (!res.ok) {
      const msg = (body && (body.detail || body.error || body.message)) || body || res.statusText;
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  };
}
