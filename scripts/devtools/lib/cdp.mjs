// 极简 CDP 客户端：发现 target、连 WebSocket、Runtime.evaluate。
//
// 只用 Node 自带的全局 WebSocket（Node 22+）和 fetch，不引第三方库。
// 失败一律抛 DevtoolsError，把「端口没通 / 对面不是调试器 / 没有 WebView 页面」区分开，
// 因为真机上这三种情况长得一模一样，报同一句「连不上」等于没说。

import { DevtoolsError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 10000;

function describeFetchError(err, port, path) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return new DevtoolsError(
      `本机端口 ${port} 上没有调试服务（连接被拒绝）`,
      '转发存在但对面没在监听：WebView 调试没开（要 debuggable 构建），或者 App 已经被系统杀掉',
    );
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT')) {
    return new DevtoolsError(
      `访问 http://127.0.0.1:${port}${path} 超时`,
      '设备可能断开了；adb devices 看一下，必要时重插 USB',
    );
  }
  return new DevtoolsError(
    `访问 http://127.0.0.1:${port}${path} 失败`,
    '确认 adb forward 还在（adb forward --list），设备没掉线',
    code || (err && err.message) || '',
  );
}

/** 取 /json/list 这类纯 JSON 接口；返回解析后的值。 */
export async function fetchDebugJson(port, path = '/json/list', { timeout = DEFAULT_TIMEOUT_MS, baseUrl = null } = {}) {
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}${path}` : `http://127.0.0.1:${port}${path}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw describeFetchError(err, port, path);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new DevtoolsError(
      `${url} 返回 HTTP ${res.status}`,
      '端口打到别的服务上了？确认转发的是 webview_devtools_remote_<pid> 而不是别的套接字',
      text.slice(0, 300),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DevtoolsError(
      `${url} 返回的不是调试器 JSON（可能是某个网页的 404 页）`,
      '这个端口后面大概率不是 WebView 调试端点；用 adb shell cat /proc/net/unix | grep devtools 确认套接字名',
      text.slice(0, 300),
    );
  }
}

/** 列出调试端点上的 targets。 */
export async function listTargets(port, opts = {}) {
  const data = await fetchDebugJson(port, '/json/list', opts);
  if (!Array.isArray(data)) {
    throw new DevtoolsError(
      `/json/list 返回的不是数组（拿到 ${typeof data}）`,
      '这个端点不像 Chrome/WebView 的调试端点',
      JSON.stringify(data).slice(0, 300),
    );
  }
  return data;
}

function targetLabel(t) {
  const title = t.title ? `「${t.title}」` : '';
  return `${title}${t.url || '(无 url)'}`;
}

/**
 * 从 targets 里挑出主页面。
 *
 * WebView 正常只有一个 page；多出来的一般是 iframe/worker 或者干脆是别的 App（Chrome）。
 * 多个 page 时优先 url 是 http(s) 的那个，其余打一行提示，不静默丢。
 */
export function pickTarget(targets, { match = '', log = () => {} } = {}) {
  const pages = targets.filter((t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  const others = targets.filter((t) => !pages.includes(t));

  if (pages.length === 0) {
    const kinds = targets.length
      ? targets.map((t) => `${t.type || '?'}:${t.url || ''}`).join('、')
      : '（一个 target 都没有）';
    throw new DevtoolsError(
      `这个调试端点上没有可调试的 WebView 页面，只有：${kinds}`,
      'WebView 还没加载页面（白屏/未登录）也可能这样；确认 App 停在 Hana 页面上再试',
    );
  }

  let pool = pages;
  if (match) {
    pool = pages.filter((t) => `${t.url || ''} ${t.title || ''}`.includes(match));
    if (pool.length === 0) {
      throw new DevtoolsError(
        `没有 url/title 里含「${match}」的页面`,
        `现有页面：${pages.map(targetLabel).join('；')}`,
      );
    }
  }

  const scored = pool.slice().sort((a, b) => {
    const score = (t) => (/^https?:/i.test(t.url || '') ? 2 : 0) + (t.url && t.url !== 'about:blank' ? 1 : 0);
    return score(b) - score(a);
  });
  if (scored.length > 1) log(`提示：有 ${scored.length} 个可调试页面，用第一个（${targetLabel(scored[0])}）`);
  for (const t of others) log(`提示：忽略非 page 的 target（${t.type || '?'}:${t.url || ''}）`);
  return scored[0];
}

/** WebView 的 UA 一定带 "; wv)"；不带的大概率是 Chrome 或别的东西。 */
export function isWebViewUserAgent(ua) {
  return /;\s*wv\)/.test(String(ua || ''));
}

/** 一个 CDP 会话：request(id 配对) + evaluate 的薄封装。 */
export class CdpSession {
  constructor(wsUrl, socket) {
    this.wsUrl = wsUrl;
    this.ws = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeError = null;

    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('close', () => this.onClose('调试连接已断开（App 被杀 / WebView 重建 / adb 转发被移除）'));
    this.ws.addEventListener('error', () => this.onClose('调试连接出错'));
  }

  static async connect(wsUrl, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new DevtoolsError(
        '当前 Node 没有内置 WebSocket（需要 Node 22 以上）',
        `现在跑的是 ${process.version}；换新一点的 Node 再来`,
      );
    }
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* 已经关了就算了 */ }
        reject(new DevtoolsError(
          `连调试 WebSocket 超时（${Math.round(timeout / 1000)} 秒）：${wsUrl}`,
          '设备可能掉线了；adb devices 看一下',
        ));
      }, timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new DevtoolsError(
          '连不上调试 WebSocket（拿不到 targets 里那条 webSocketDebuggerUrl）',
          '通常意味着 App 刚好重启、pid 变了；重跑一次本工具',
        ));
      }, { once: true });
    });
    return new CdpSession(wsUrl, socket);
  }

  onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return; // 事件流里偶有非 JSON 的垃圾，忽略
    }
    if (!msg || msg.id == null) return; // 订阅事件（Runtime.consoleAPICalled 之类）不处理
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new DevtoolsError(
        `CDP ${pending.method} 返回错误：${msg.error.message || '（无说明）'}`,
        '页面可能刚导航/刷新，重跑一次',
        JSON.stringify(msg.error),
      ));
    } else {
      pending.resolve(msg.result || {});
    }
  }

  onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new DevtoolsError(reason, '重跑一次；如果反复断开，先用 adb logcat -s HanaMobile 看壳是不是在重启'));
    }
    this.pending.clear();
  }

  request(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) {
      return Promise.reject(new DevtoolsError(this.closeError || '调试连接已关闭', '重跑一次'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DevtoolsError(`CDP ${method} 超时（${Math.round(timeout / 1000)} 秒）`, '页面可能卡住了，看看手机上是不是有弹窗或长任务'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 在页面里跑一段表达式。
   * 返回 { ok, value } 或 { ok:false, error }；页面里的异常不抛，交给调用方决定怎么说。
   */
  async evaluate(expression, { timeout = DEFAULT_TIMEOUT_MS, awaitPromise = true } = {}) {
    const res = await this.request(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
        includeCommandLineAPI: false,
      },
      { timeout },
    );
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails;
      const text = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || '页面内执行抛错';
      return { ok: false, error: String(text) };
    }
    const result = res.result || {};
    if (result.unserializableValue !== undefined) return { ok: true, value: result.unserializableValue, type: result.type };
    if (result.type === 'undefined') return { ok: true, value: undefined, type: 'undefined' };
    return { ok: true, value: result.value, type: result.type };
  }

  close() {
    try {
      this.onClose('调试连接已关闭');
      this.ws.close();
    } catch {
      /* 关不掉就算了，进程马上退出 */
    }
  }
}
