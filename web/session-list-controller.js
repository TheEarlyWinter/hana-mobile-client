/* web/session-list-controller.js
 *
 * 会话列表目录筛选控制器。
 *
 * 独占「当前命名空间」与请求序号：负责 home/code 列表请求、切换筛选、
 * 竞态收敛（最近一次 load 获胜）与 dispose。不碰 DOM、不读全局状态、
 * 不引入依赖；列表渲染仍由 session-list-view.js 负责。
 *
 * 契约：
 *   createSessionListController({ api, initialNamespace, onLoading, onLoaded,
 *                                 onError, onNamespaceChange })
 *     -> { load, getNamespace, dispose }
 *   - getNamespace() 返回当前筛选，初始 'home'，只可能是 'home' / 'code'。
 *   - load(namespace?) 切换筛选并发起请求；省略时刷新当前筛选。
 *     显式 URL：/api/sessions?namespace=<value>。namespace 变化时同步回调
 *     onNamespaceChange(ns)，每次 load 都先回调 onLoading(ns)。
 *   - 只有最近一次 load 的结果能落地：旧成功/旧失败（含同筛选刷新）静默丢弃。
 *   - onLoaded(list, ns) / onError(error, ns)。失败只走 onError，不伪装空成功。
 *   - dispose() 使所有在途结果失效；之后的 load 为无操作。
 *   - reset() 只废弃在途结果并把筛选退回初始值；控制器之后仍可 load
 *     （与 dispose 不同，用于登录/切换用户后丢掉旧用户的列表响应）。
 *     不触发 onNamespaceChange/onLoading，调用方自己回写 tabs 与列表。
 *   - load 返回 Promise：最终获胜的成功请求解析为规范化列表，其余为 undefined。
 *     请求/响应错误已经通过 onError 上报，因此不 reject（避免调用方漏 catch）。
 *
 * 行级规则：
 *   - 响应必须是数组或 { sessions: [...] }，否则抛格式错误交给 onError。
 *   - 行缺 namespace（undefined/null/''）按 home 归类，code 只收显式 'code'。
 *   - 显式 namespace 与当前筛选不一致（含 'app' 等未知值）的行不混入列表。
 *   - 非对象行（null/数组/原始值）跳过，不影响其余合法行。
 *   - 行对象原样保留（身份、path、agentId、label、workspaceId 等），
 *     不注入字段、不按 label/workspaceId 猜路径、不排序、不去重。
 */

const NAMESPACES = new Set(['home', 'code']);
const NAMESPACE_HINT = '（只接受 home / code）';

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

function assertNamespace(value) {
  if (!NAMESPACES.has(value)) {
    throw new TypeError(`不支持的会话命名空间：${describe(value)}${NAMESPACE_HINT}`);
  }
}

// 响应行归类：缺省/空 namespace 视为 legacy home；其馀必须是明确 home/code。
function rowNamespace(row) {
  if (row.namespace == null || row.namespace === '') return 'home';
  return row.namespace;
}

function toSessionList(raw, namespace) {
  let rows;
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.sessions)) {
    rows = raw.sessions;
  } else {
    throw new Error(
      `会话列表响应格式不正确：期望数组或 { sessions: [...] }，实际收到 ${describe(raw)}`,
    );
  }

  const list = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (rowNamespace(row) === namespace) list.push(row);
  }
  return list;
}

/**
 * 创建会话列表控制器。
 *
 * @param {object} options
 * @param {(pathname: string) => Promise<any>} options.api 同源请求函数（如 http-client 的 api）
 * @param {'home'|'code'} [options.initialNamespace='home'] 初始筛选
 * @param {(namespace: string) => void} [options.onLoading] 每次 load 开始
 * @param {(list: object[], namespace: string) => void} [options.onLoaded] 获胜请求成功
 * @param {(error: Error, namespace: string) => void} [options.onError] 当前请求失败/响应非法
 * @param {(namespace: string) => void} [options.onNamespaceChange] 筛选发生改变
 * @returns {{ load: (namespace?: string) => Promise<object[]|undefined>, getNamespace: () => string, reset: () => void, dispose: () => void }}
 */
export function createSessionListController({
  api,
  initialNamespace = 'home',
  onLoading = () => {},
  onLoaded = () => {},
  onError = () => {},
  onNamespaceChange = () => {},
} = {}) {
  if (typeof api !== 'function') {
    throw new TypeError('createSessionListController requires { api }');
  }
  assertNamespace(initialNamespace);

  let namespace = initialNamespace;
  let requestSeq = 0;
  let disposed = false;

  function getNamespace() {
    return namespace;
  }

  function isLatest(seq) {
    return !disposed && seq === requestSeq;
  }

  function load(nextNamespace) {
    const target = nextNamespace === undefined ? namespace : nextNamespace;
    assertNamespace(target);
    if (disposed) return Promise.resolve();

    if (target !== namespace) {
      namespace = target;
      onNamespaceChange(target);
    }

    const seq = ++requestSeq;
    onLoading(target);
    // onLoading 内可能 dispose 或触发下一次 load：此次请求已过期，不再发出。
    if (disposed || seq !== requestSeq) return Promise.resolve();

    let pending;
    try {
      pending = api(`/api/sessions?namespace=${target}`);
    } catch (error) {
      if (isLatest(seq)) onError(error, target);
      return Promise.resolve();
    }

    return Promise.resolve(pending).then(
      (raw) => {
        if (!isLatest(seq)) return undefined;
        let list;
        try {
          list = toSessionList(raw, target);
        } catch (error) {
          onError(error, target);
          return undefined;
        }
        onLoaded(list, target);
        return list;
      },
      (error) => {
        if (!isLatest(seq)) return undefined;
        onError(error, target);
        return undefined;
      },
    );
  }

  function reset() {
    if (disposed) return;
    // 递增序号：旧用户在途的成功/失败都变成旧响应，不能回填新登录用户。
    requestSeq += 1;
    // 新登录默认 Chat，不继承上一个用户的筛选；不做回调，避免触发一次多余请求。
    namespace = initialNamespace;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    // 递增序号让所有在途请求（成功或失败）都变成旧响应。
    requestSeq += 1;
  }

  return { load, getNamespace, reset, dispose };
}
