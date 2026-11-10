/* file-source.js — 会话文件的「地址从哪来」
 *
 * 纯函数，不碰 DOM、不发请求、不读全局状态。app.js 负责把工作区根喂进来，
 * file-card.js 只拿最终字符串。这样这段最容易被改坏的路径逻辑能单独测。
 *
 * 为什么需要它：
 *   - 宿主给的文件描述是绝对路径（C:\...\x.docx）或 fileId（sf_…）；
 *   - 壳的下载白名单只放行 /api/mobile/workspace/content（见
 *     MainActivity.isWorkspaceContentUrl），用 /api/resources/<fileId>/content
 *     在 App 里点下载只会弹「只允许下载同源 workspace content 文件」；
 *   - 所以优先把绝对路径映射到工作区，映射不上才退回资源地址。
 */

const WIN_DRIVE = /^[a-zA-Z]:\//;

/** 统一成正斜杠、去掉末尾分隔符；不是字符串就返回空串。 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 把绝对路径落到某个工作区根上。
 *
 * @param {string} filePath  宿主的 filePath（Windows 反斜杠或 POSIX 都行）
 * @param {Array<{mountId: string, path: string}>} roots 工作区根（nativeRootPath）
 * @returns {{mountId: string, subdir: string, name: string}|null}
 *
 * 规则：最长前缀优先（嵌套工作区不会被外层吞掉）；大小写不敏感只对盘符路径生效，
 * POSIX 路径保持大小写敏感——那才是文件系统的真实语义。
 */
export function matchWorkspaceRoot(filePath, roots) {
  const target = normalizePath(filePath);
  if (!target || !Array.isArray(roots) || !roots.length) return null;
  const caseInsensitive = WIN_DRIVE.test(target);

  const candidates = [];
  for (const root of roots) {
    const base = normalizePath(root?.path);
    const mountId = typeof root?.mountId === 'string' ? root.mountId.trim() : '';
    if (!base || !mountId) continue;
    const same = caseInsensitive
      ? target.toLowerCase().startsWith(base.toLowerCase() + '/')
      : target.startsWith(base + '/');
    if (!same) continue;
    const rel = target.slice(base.length + 1);
    if (!rel) continue;
    candidates.push({ mountId, base, rel });
  }
  if (!candidates.length) return null;

  // 最长 base 胜出：工作区可以互相嵌套
  candidates.sort((a, b) => b.base.length - a.base.length);
  const { mountId, rel } = candidates[0];
  const slash = rel.lastIndexOf('/');
  const subdir = slash >= 0 ? rel.slice(0, slash) : '';
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  if (!name) return null;
  return { mountId, subdir, name };
}

/**
 * 拼工作区同源内容地址。参数一律走 URLSearchParams，空格编码成 %20
 * （表单编码的 + 在宿主侧会被当字面加号）。
 *
 * @param {Partial<{mountId: string, agentId?: string, subdir?: string, name: string}>} [parts]
 */
export function buildWorkspaceContentUrl({ mountId, agentId = '', subdir = '', name } = {}) {
  if (typeof mountId !== 'string' || !mountId.trim()) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  const q = new URLSearchParams();
  q.set('mountId', mountId.trim());
  if (typeof agentId === 'string' && agentId.trim()) q.set('agentId', agentId.trim());
  if (typeof subdir === 'string' && subdir.trim()) q.set('subdir', subdir.trim());
  q.set('name', name.trim());
  return `/api/mobile/workspace/content?${q.toString().replace(/\+/g, '%20')}`;
}

/**
 * 只有绝对路径和会话自己的工作区名时，尽力猜出相对路径。
 *
 * 为什么需要它：`/api/studio/workspaces` 对手机身份返回的工作区不带 `nativeRootPath`
 * （主机路径不外洩），所以上面那条「枚举工作区根」的路在手机上拿不到根。
 * 但会话自己带着 `workspaceMountId` 和 `workspaceLabel`，文件路径里又确实有那段目录名，
 * 于是可以按「最后一个 /<label>/ 之后的部分」当相对路径。找不到就不猜。
 *
 * @param {string} filePath
 * @param {string} label  会话的 workspaceLabel（例如 工作区）
 * @returns {{subdir: string, name: string}|null}
 */
export function matchWorkspaceByLabel(filePath, label) {
  const target = normalizePath(filePath);
  const tag = normalizePath(label);
  if (!target || !tag || tag.includes('/')) return null;
  const lower = target.toLowerCase();
  const idx = lower.lastIndexOf('/' + tag.toLowerCase() + '/');
  if (idx < 0) return null;
  const rel = target.slice(idx + tag.length + 2);
  if (!rel) return null;
  const slash = rel.lastIndexOf('/');
  const subdir = slash >= 0 ? rel.slice(0, slash) : '';
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  if (!name) return null;
  return { subdir, name };
}

/**
 * 一次性给出「这个文件该用哪个地址」。
 *
 * @param {{filePath?: string, fileId?: string, id?: string}} file
 * @param {Array<{mountId: string, path: string}>} roots
 * @param {string} agentId
 * @returns {string|null} 工作区地址优先；映射不上返回 null，由调用方决定退路
 */
export function workspaceUrlForFile(file, roots, agentId = '') {
  const hit = matchWorkspaceRoot(file?.filePath, roots);
  if (!hit) return null;
  return buildWorkspaceContentUrl({ ...hit, agentId });
}
