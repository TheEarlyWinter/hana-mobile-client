/* web/file-urls.js — 会话文件的「读地址」与「下载地址」
 *
 * 为什么必须分成两个（真机事实，别合并回去）：
 *   - 读内容走 fetch() / <img src>，是同源请求，壳不拦；`/api/resources/<fileId>/content`
 *     在 WebView 里读得通，也是只拿得到 fileId 的文件唯一的读法；
 *   - 「下载到本地」在壳里是**一次导航**（WebView 不吃 `<a download>`），而
 *     MainActivity.isWorkspaceContentUrl 只放行 `/api/mobile/workspace/content`，
 *     别的地址点了只会弹「只允许下载同源 workspace content 文件」。
 *
 * 所以：
 *   downloadUrl —— 只在能把文件映射到工作区时给，且一定是白名单地址，否则 null；
 *   readUrl     —— 优先用同一个工作区地址（少一条权限路径）；映射不上但有 filePath 时走
 *                  网关的按路径读 `/gw/file/<b64url(path)>`（宿主对 agent 生成/外部存储的
 *                  文件在 `/api/resources/<fileId>/content` 上回 400，那是真机上的 400 根因）；
 *                  都没有才退回资源地址。三者都没有才返回 null（真的没法读）。
 *                  `/gw/file/…` 只能读，不能当下载地址（壳的下载白名单只认工作区 content）。
 *
 * 纯逻辑 + 一个显式注入的 service；不碰 DOM、不读全局 S。
 */

/** 会话文件（sf_… 这种 fileId）→ 服务端的资源内容地址。 */
export function resourceContentUrl(fileId) {
  if (typeof fileId !== 'string' || !fileId.trim()) return null;
  return `/api/resources/${encodeURIComponent(fileId.trim())}/content`;
}

/** 任意字节串 → base64url（URL 安全，去填充）。 */
export function b64url(value) {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 服务端存的绝对路径 → 网关上的可读地址（消息里的图片/文件引用用）。 */
export function fileUrlFor(realPath) {
  if (typeof realPath !== 'string' || !realPath.trim()) return null;
  return `/gw/file/${b64url(realPath.trim())}`;
}

/**
 * @param {object} options
 * @param {{ listRoots: () => Promise<any> }} options.service 工作区服务（/api/studio/workspaces）
 * @param {() => object|null} [options.getSession] 当前会话（找 agentId / workspaceMountId / label）
 * @param {() => object|null} [options.getPrincipal] 当前登录身份（工作区根缓存按人隔离）
 * @param {(file: object, roots: Array<{mountId: string, path: string}>, agentId: string) => string|null} options.workspaceUrlForFile
 * @param {(filePath: string, label: string) => ({subdir: string, name: string}|null)} options.matchWorkspaceByLabel
 * @param {(parts: object) => string|null} options.buildWorkspaceContentUrl
 */
export function createSessionFileUrls({
  service,
  getSession = () => null,
  getPrincipal = () => null,
  workspaceUrlForFile,
  matchWorkspaceByLabel,
  buildWorkspaceContentUrl,
} = {}) {
  if (!service || typeof service.listRoots !== 'function') {
    throw new TypeError('createSessionFileUrls requires { service.listRoots }');
  }

  let roots = null;            // 只缓存成功结果；失败不缓存，下一次调用还要再试
  let rootsOwner = '';         // roots 属于哪个身份；只有成功提交才更新
  let loading = null;
  let loadingOwner = '';       // 当前在途请求属于哪个身份
  let lastError = '';
  // 缓存代次：reset() 递增。在途请求只允许把结果写回自己发起时的代次，
  // 否则退出登录 / 换身份之后迟到的成功或失败会污染新身份的缓存与错误。
  let epoch = 0;

  /** 当前登录身份的可比较标记（principal 是对象，不能直接当缓存键）。 */
  function ownerKey() {
    const p = getPrincipal();
    if (!p) return '';
    return String(p.id ?? p.userId ?? p.name ?? p.email ?? '');
  }

  /** 登录身份变化 / 退出登录时丢掉工作区根缓存，别把上一个人的根用在这一回。 */
  function reset() {
    epoch += 1;
    roots = null;
    rootsOwner = '';
    loading = null;
    loadingOwner = '';
    lastError = '';
  }

  async function ensureRoots() {
    const owner = ownerKey();
    // 缓存只认「成功提交时记下的 owner」：当前请求换了身份，不能把上一个人留下的 roots
    // 当成新身份的缓存返回（此时 roots 还在，但 rootsOwner 不是这个人）。
    if (roots && rootsOwner === owner) return roots;
    // 在途请求只给同一身份用；身份换过就重新发一次，不能拿上一个人的根凑合。
    if (loading && loadingOwner === owner) return loading;

    const requestEpoch = epoch;
    const requestOwner = owner;
    // 提交前同时核对：还是当前这条请求、代次没变、owner 没换。
    // 只看 epoch / owner 会漏掉「A1 在途 → B1 → A2，owner 又回到 A」时的旧 A1：
    // 那时 epoch 没变、身份也确实是 A，但当前请求已经是 A2。
    const ownsCache = () => (
      loading === request
      && requestEpoch === epoch
      && loadingOwner === requestOwner
      && ownerKey() === requestOwner
    );

    loadingOwner = owner;
    const request = service.listRoots()
      .then((res) => {
        const list = (res?.workspaces || [])
          .filter((w) => w && typeof w.mountId === 'string' && typeof w.nativeRootPath === 'string')
          .map((w) => ({ mountId: w.mountId, path: w.nativeRootPath }));
        if (!ownsCache()) return list;   // 旧代次 / 旧身份 / 已被新请求接替：不写当前缓存
        roots = list;
        rootsOwner = requestOwner;
        lastError = '';
        return list;
      })
      .catch((err) => {
        // 取不到不等于「没有工作区」：不缓存空结果，下一次调用还要再试。
        if (ownsCache()) {
          lastError = String(err?.message || err);
          roots = null;
          rootsOwner = '';
        }
        throw err;
      })
      .finally(() => {
        if (loading === request) {
          loading = null;
          loadingOwner = '';
        }
      });
    loading = request;
    return request;
  }

  /** 只解析下载地址：映射到工作区才有，否则 null。 */
  async function downloadUrlFor(file) {
    // 先锁定这次解析所属的会话：等根回来期间用户可能已经切走，
    // 那之后不能拿新会话的 mountId / 目录名去映射旧文件。
    const session = getSession();
    let list = [];
    try {
      list = (await ensureRoots()) || [];
    } catch {
      list = [];   // 取根失败不阻断：还能靠会话自带的 mountId + 工作区目录名反推
    }
    const agentId = session?.agentId || '';
    // 1) 能枚举到带真实路径的工作区根，就精确匹配
    // 2) 手机身份拿不到根路径：用会话自带的 mountId + 工作区目录名反推相对路径
    let url = workspaceUrlForFile ? workspaceUrlForFile(file, list, agentId) : null;
    if (!url && session?.workspaceMountId && matchWorkspaceByLabel && buildWorkspaceContentUrl) {
      const rel = matchWorkspaceByLabel(file?.filePath, session.workspaceLabel || session.folder);
      if (rel) url = buildWorkspaceContentUrl({ ...rel, mountId: session.workspaceMountId, agentId });
    }
    return url || null;
  }

  /**
   * 一个文件的两个地址。
   * @returns {Promise<{readUrl: string|null, downloadUrl: string|null}>}
   */
  async function forFile(file) {
    const downloadUrl = await downloadUrlFor(file);
    // 映射不到工作区、但条目自带绝对路径：按路径读（网关只读，不参与下载）。
    const pathUrl = downloadUrl ? null : fileUrlFor(file?.filePath);
    const readUrl = downloadUrl || pathUrl || resourceContentUrl(file?.fileId || file?.id);
    return { readUrl, downloadUrl };
  }

  return {
    forFile,
    downloadUrlFor,
    ensureRoots,
    reset,
    getError: () => lastError,
  };
}
