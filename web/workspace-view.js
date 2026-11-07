/* web/workspace-view.js
 *
 * 工作区视图控制器。
 * 负责工作区文件抽屉挂载、真实根选择器、目录导航、面包屑渲染、重名拦截上传、
 * 并发锁控制、以及光栅图片 ObjectURL 与纯文本 textContent 安全只读预览。
 */

import {
  detectRasterImageMime,
  isTextPreviewable,
  normalizeSubdir,
  validateFileName,
  MOBILE_MAX_SINGLE_FILE_BYTES,
  MOBILE_MAX_TOTAL_UPLOAD_BYTES,
  MOBILE_MAX_UPLOAD_FILES_COUNT,
  TEXT_PREVIEW_MAX_BYTES,
} from './workspace-service.js';
import { startDownload } from './download.js';

/**
 * 格式化文件大小。
 */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 判定文件扩展名是否可能为光栅图片。
 */
function mightBeRasterImage(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  const rasterExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'];
  return rasterExts.some((ext) => lower.endsWith(ext));
}

/**
 * 创建工作区视图管理器。
 *
 * @param {object} options
 * @param {object} options.service - workspace-service 实例
 * @param {Document} options.document - DOM 文档对象
 * @param {Function} [options.confirmAction] - 交互确认函数 (async ({ title, message, target, fileNames }) => boolean)，缺省 fail-closed (返回 false)
 * @param {Function} [options.toast] - 提示消息浮条
 * @param {Function} [options.download=startDownload] - 下载入口（WebView 只认导航 + Content-Disposition）
 * @param {Function} [options.now=() => Date.now()] - 时间戳生成器
 */
export function createWorkspaceView({
  service,
  document: doc,
  confirmAction = async () => false, // 修复：缺省必须 fail-closed
  toast = (msg) => console.log(msg),
  download = startDownload,
  now = () => Date.now(),
} = {}) {
  if (!service) throw new Error('createWorkspaceView requires { service }');
  if (!doc) throw new Error('createWorkspaceView requires { document }');

  let domCreated = false;
  let isOpenState = false;
  let currentSnapshot = null;
  let globalReqSeq = 0;
  let currentPreviewSeq = 0;
  let activePreviewUrl = null;
  let isUploading = false; // 并发上传锁
  let availableRoots = [];

  // DOM 节点引用
  let maskEl = null;
  let drawerEl = null;
  let titleEl = null;
  let subTitleEl = null;
  let rootSelectEl = null;
  let breadcrumbEl = null;
  let bodyEl = null;
  let fileInputEl = null;
  let previewModalEl = null;
  let previewTitleEl = null;
  let previewBodyEl = null;

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /** 懒初始化 DOM 结构，首次 open 时挂载到 body */
  function ensureDom() {
    if (domCreated) return;
    domCreated = true;

    // 1. 遮罩层
    maskEl = el('div', 'workspace-mask');
    maskEl.hidden = true;
    maskEl.addEventListener('click', close);
    doc.body.appendChild(maskEl);

    // 2. 抽屉面板
    drawerEl = el('div', 'workspace-drawer');
    drawerEl.setAttribute('aria-hidden', 'true');
    drawerEl.hidden = true;

    // 抽屉头部
    const head = el('div', 'workspace-head');
    const titleBox = el('div', 'workspace-title-box');
    titleEl = el('div', 'workspace-title', '工作区文件');
    subTitleEl = el('div', 'workspace-subtitle', '');
    titleBox.appendChild(titleEl);
    titleBox.appendChild(subTitleEl);

    const headActions = el('div', 'workspace-head-actions');
    const closeBtn = el('button', 'workspace-icon-btn', '✕');
    closeBtn.setAttribute('title', '关闭');
    closeBtn.addEventListener('click', close);
    headActions.appendChild(closeBtn);

    head.appendChild(titleBox);
    head.appendChild(headActions);
    drawerEl.appendChild(head);

    // 动作工具条与面包屑
    const toolbar = el('div', 'workspace-toolbar');
    breadcrumbEl = el('div', 'workspace-breadcrumb');

    rootSelectEl = el('select', 'workspace-root-select');
    rootSelectEl.setAttribute('aria-label', '选择工作区根');
    rootSelectEl.hidden = true;
    rootSelectEl.addEventListener('change', onRootSelectChange);

    const uploadBtn = el('button', 'workspace-upload-btn');
    uploadBtn.textContent = '↑ 上传文件';
    uploadBtn.addEventListener('click', () => {
      if (isUploading) {
        toast('已有上传任务进行中，请稍候');
        return;
      }
      if (fileInputEl) fileInputEl.click();
    });

    toolbar.appendChild(rootSelectEl);
    toolbar.appendChild(breadcrumbEl);
    toolbar.appendChild(uploadBtn);
    drawerEl.appendChild(toolbar);

    // 文件列表主体
    bodyEl = el('div', 'workspace-body');
    drawerEl.appendChild(bodyEl);

    // 隐藏的文件上传 input
    fileInputEl = doc.createElement('input');
    fileInputEl.type = 'file';
    fileInputEl.multiple = true;
    fileInputEl.style.display = 'none';
    fileInputEl.addEventListener('change', async (ev) => {
      try {
        const files = Array.from(ev.target?.files || []);
        if (!files.length) return;
        await handleFileInputFiles(files);
      } catch (err) {
        toast('上传处理异常：' + (err.message || String(err)));
      } finally {
        // 关键修复：异常或完成时必清理 input.value，防止 unhandledrejection
        if (fileInputEl) fileInputEl.value = '';
      }
    });
    drawerEl.appendChild(fileInputEl);

    // 3. 安全预览弹窗
    previewModalEl = el('div', 'workspace-preview-modal');
    previewModalEl.hidden = true;

    const prevHead = el('div', 'workspace-preview-head');
    previewTitleEl = el('div', 'workspace-preview-title', '预览');
    const prevCloseBtn = el('button', 'workspace-icon-btn', '✕');
    prevCloseBtn.style.color = '#FFFDF9';
    prevCloseBtn.addEventListener('click', closePreview);
    prevHead.appendChild(previewTitleEl);
    prevHead.appendChild(prevCloseBtn);

    previewBodyEl = el('div', 'workspace-preview-body');
    previewModalEl.appendChild(prevHead);
    previewModalEl.appendChild(previewBodyEl);

    doc.body.appendChild(drawerEl);
    doc.body.appendChild(previewModalEl);

    renderRootOptions();
  }

  function isOpen() {
    return isOpenState;
  }

  function rootKey(root) {
    return JSON.stringify([String(root?.mountId ?? ''), String(root?.agentId ?? '')]);
  }

  function normalizeRoot(root) {
    if (!root || typeof root !== 'object') return null;
    const mountId = typeof root.mountId === 'string' ? root.mountId : '';
    if (!mountId.trim()) return null;
    const agentId = typeof root.agentId === 'string' ? root.agentId : '';
    // default 根仍然必须绑定 agentId；named root 可以不带
    if (mountId === 'default' && !agentId) return null;
    const label = typeof root.label === 'string' && root.label ? root.label : mountId;
    return { ...root, mountId, agentId, label };
  }

  /** 只重绘选择器；不打开、不导航、不发任何请求。 */
  function renderRootOptions() {
    if (!rootSelectEl) return;
    rootSelectEl.innerHTML = '';

    const activeKey = currentSnapshot ? rootKey(currentSnapshot) : '';
    const hasActive = !!activeKey && availableRoots.some((root) => rootKey(root) === activeKey);

    if (!hasActive && availableRoots.length) {
      const placeholder = el('option', 'workspace-root-option', '选择工作区根');
      placeholder.value = '';
      placeholder.disabled = true;
      rootSelectEl.appendChild(placeholder);
    }

    for (const root of availableRoots) {
      const option = el('option', 'workspace-root-option', root.label);
      option.value = rootKey(root);
      rootSelectEl.appendChild(option);
    }

    rootSelectEl.hidden = availableRoots.length === 0;
    rootSelectEl.value = hasActive ? activeKey : '';
  }

  /**
   * 父级注入 roots。接受两种形状：
   *   1) 数组：[{ mountId: 'default', agentId, label }, ...listRoots().workspaces]
   *   2) listRoots() 的原样返回：{ workspaces: [...] }
   * 形状不认识时明确提示——绝不把「传错形状」静默当成「没有具名根」（真机上就这样只剩默认项）。
   * 只重绘选择器，不隐式 open、不发送写请求；去重键为 mountId + agentId。
   */
  function setRoots(roots) {
    const candidates = Array.isArray(roots)
      ? roots
      : roots && typeof roots === 'object' && Array.isArray(roots.workspaces)
        ? roots.workspaces
        : null;
    if (candidates === null && roots != null) {
      toast('工作区根列表格式异常，已忽略');
    }

    const list = [];
    const seen = new Set();
    for (const candidate of candidates || []) {
      const root = normalizeRoot(candidate);
      if (!root) continue;
      const key = rootKey(root);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(root);
    }
    availableRoots = list;
    renderRootOptions();
  }

  async function onRootSelectChange(ev) {
    const value = ev?.target?.value ?? rootSelectEl?.value;
    const selected = availableRoots.find((root) => rootKey(root) === value);
    if (!selected) {
      toast('未知工作区根，已忽略');
      renderRootOptions();
      return;
    }
    await open({ mountId: selected.mountId, agentId: selected.agentId, label: selected.label });
  }

  /**
   * 打开指定工作区。
   *
   * @param {object} params
   * @param {string} [params.mountId='default']
   * @param {string} [params.agentId]
   * @param {string} [params.label]
   */
  async function open({ mountId = 'default', agentId, label } = {}) {
    const resolvedMountId = mountId || 'default';
    // default 根必须带 agentId；named root 可以不带，绝不用路径猜测替代身份。
    if (resolvedMountId === 'default' && !agentId) {
      toast('默认工作区需要指定 Agent');
      return { cancelled: true, reason: 'agent_id_required' };
    }

    ensureDom();
    isOpenState = true;
    closePreview();

    // 捕获不可变快照对象与全局单调自增序号
    currentSnapshot = Object.freeze({
      mountId: resolvedMountId,
      agentId,
      label: label || (resolvedMountId === 'default' ? '默认工作区' : resolvedMountId),
      subdir: '',
      currentFiles: [],
      reqSeq: ++globalReqSeq,
    });

    titleEl.textContent = currentSnapshot.label;
    subTitleEl.textContent = agentId ? `Agent: ${agentId}` : '';
    renderRootOptions();

    maskEl.hidden = false;
    drawerEl.hidden = false;
    drawerEl.setAttribute('aria-hidden', 'false');

    await loadFiles(currentSnapshot);
  }

  function close() {
    if (!isOpenState) return;
    isOpenState = false;
    globalReqSeq += 1; // 废弃在途所有列表请求
    currentSnapshot = null;
    closePreview();

    if (maskEl) maskEl.hidden = true;
    if (drawerEl) {
      drawerEl.hidden = true;
      drawerEl.setAttribute('aria-hidden', 'true');
    }
  }

  /** 预览层是否真的开着：只认 view 自己的实际状态，不向调用方暴露 DOM。 */
  function isPreviewOpen() {
    return !!previewModalEl && previewModalEl.hidden === false;
  }

  /**
   * 同步返回键：一次只退一层。
   * - 预览打开：只 closePreview()，保留 currentSnapshot、根与目录列表，也不废弃在途目录请求；
   * - 预览不在且面板打开：走 close() 彻底关闭并废弃在途请求；
   * - 都未打开：返回 false，交还给上层（聊天/首页）。
   * Android evaluateJavascript 需要同步返回值，故这里不能是 Promise。
   *
   * @returns {boolean} 是否消费了这次返回
   */
  function back() {
    if (isPreviewOpen()) {
      closePreview();
      return true;
    }
    if (!isOpenState) return false;
    close();
    return true;
  }

  async function navigateTo(subdir) {
    if (!currentSnapshot || !isOpenState) return;
    closePreview();

    const cleanSubdir = normalizeSubdir(subdir);
    currentSnapshot = Object.freeze({
      mountId: currentSnapshot.mountId,
      agentId: currentSnapshot.agentId,
      label: currentSnapshot.label,
      subdir: cleanSubdir,
      currentFiles: currentSnapshot.currentFiles || [],
      reqSeq: ++globalReqSeq,
    });

    await loadFiles(currentSnapshot);
  }

  async function loadFiles(snapshot) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(el('div', 'workspace-loading', '载入中…'));
    renderBreadcrumbs(snapshot.subdir);

    try {
      const res = await service.list(snapshot, snapshot.subdir);
      // 关键修复 1：严格比对对象身份 + reqSeq + isOpenState
      if (!isOpenState || currentSnapshot !== snapshot || currentSnapshot.reqSeq !== snapshot.reqSeq) {
        return;
      }

      // 更新当前快照的文件列表引用
      const updatedSnapshot = Object.freeze({
        ...snapshot,
        currentFiles: res.files || [],
      });
      currentSnapshot = updatedSnapshot;

      renderFileList(updatedSnapshot);
    } catch (err) {
      // 严格比对对象身份 + reqSeq + isOpenState
      if (!isOpenState || currentSnapshot !== snapshot || currentSnapshot.reqSeq !== snapshot.reqSeq) {
        return;
      }
      bodyEl.innerHTML = '';
      bodyEl.appendChild(
        el('div', 'workspace-error', '读取工作区失败：' + (err.message || String(err)))
      );
    }
  }

  function renderBreadcrumbs(subdir) {
    breadcrumbEl.innerHTML = '';
    const rootBtn = el('button', 'workspace-crumb-btn', '根目录');
    if (!subdir) rootBtn.classList.add('active');
    rootBtn.addEventListener('click', () => navigateTo(''));
    breadcrumbEl.appendChild(rootBtn);

    if (!subdir) return;

    const parts = subdir.split('/').filter(Boolean);
    let accum = '';
    for (let i = 0; i < parts.length; i += 1) {
      breadcrumbEl.appendChild(el('span', '', '/'));
      accum = accum ? `${accum}/${parts[i]}` : parts[i];
      const targetPath = accum;
      const crumb = el('button', 'workspace-crumb-btn', parts[i]);
      if (i === parts.length - 1) crumb.classList.add('active');
      crumb.addEventListener('click', () => navigateTo(targetPath));
      breadcrumbEl.appendChild(crumb);
    }
  }

  function renderFileList(snapshot) {
    bodyEl.innerHTML = '';
    const files = snapshot.currentFiles;
    if (!files.length) {
      bodyEl.appendChild(el('div', 'workspace-empty', '当前目录下暂无文件'));
      return;
    }

    for (const item of files) {
      const row = el('div', 'workspace-item');

      const icon = el('div', 'workspace-item-icon', item.isDir ? '📁' : '📄');
      row.appendChild(icon);

      const info = el('div', 'workspace-item-info');
      const name = el('div', 'workspace-item-name', item.name);
      const meta = el(
        'div',
        'workspace-item-meta',
        item.isDir ? '文件夹' : formatSize(item.size)
      );
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      const actions = el('div', 'workspace-item-actions');
      if (!item.isDir) {
        const dlLink = el('a', 'workspace-download-link', '↓');
        dlLink.setAttribute('title', '下载');
        dlLink.setAttribute('download', item.name);
        const href = service.downloadUrl(snapshot, { subdir: snapshot.subdir, name: item.name });
        dlLink.setAttribute('href', href);
        // 阻止冒泡避免触发预览；下载统一走 download.js 那一个入口：
        // WebView 不认 <a download>，得靠导航 + Content-Disposition，地址也要在壳的白名单里。
        dlLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          download(href, { onReject: () => toast('这个文件没有 App 认的下载地址，暂时下不了') });
        });
        actions.appendChild(dlLink);
      }
      row.appendChild(actions);

      row.addEventListener('click', () => {
        if (item.isDir) {
          const next = snapshot.subdir ? `${snapshot.subdir}/${item.name}` : item.name;
          navigateTo(next);
        } else {
          previewFile(item.name);
        }
      });

      bodyEl.appendChild(row);
    }
  }

  function isTargetCurrent(snapshot, reqSeq) {
    return (
      isOpenState &&
      currentSnapshot === snapshot &&
      currentSnapshot?.reqSeq === reqSeq
    );
  }

  /** 整个选择/确认/读取/上传流程共用一把锁，进入时立即占用，finally 释放。 */
  function tryAcquireUploadLock() {
    if (isUploading) return false;
    isUploading = true;
    return true;
  }

  /** Windows 真实部署大小写不敏感：已列文件名与批内名称统一 toLowerCase 查重。 */
  function collectDuplicateNames(snapshot, names) {
    const existing = new Set(
      (snapshot.currentFiles || []).map((f) => String(f?.name ?? '').toLowerCase())
    );
    const seen = new Set();
    const duplicates = [];
    for (const name of names) {
      const key = name.toLowerCase();
      if (existing.has(key) || seen.has(key)) duplicates.push(name);
      seen.add(key);
    }
    return duplicates;
  }

  /** 写操作确认：缺省/异常/false/任何非严格 true 都 fail-closed。 */
  async function askUploadConfirmation(snapshot, names) {
    try {
      const answer = await confirmAction({
        title: '上传文件确认',
        target: {
          mountId: snapshot.mountId,
          agentId: snapshot.agentId,
          subdir: snapshot.subdir,
        },
        fileNames: [...names],
        message: `确认上传 ${names.length} 个文件至 [${snapshot.label}] /${snapshot.subdir || ''}：\n${names.join(', ')}？`,
      });
      return answer === true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 处理已编码文件的上传（集成 API）。
   * 进入时捕获目标快照；确认/上传每个 await 恢复后都校验目标仍然有效。
   */
  async function handleFilesSelected(fileObjects) {
    if (!Array.isArray(fileObjects) || !fileObjects.length) return { cancelled: true };
    if (!currentSnapshot || !isOpenState) return { cancelled: true };
    if (!tryAcquireUploadLock()) {
      toast('已有上传任务进行中，请稍候');
      return { cancelled: true, reason: 'upload_busy' };
    }

    // 在第一个 await 之前冻结目标快照与序号
    const targetSnapshot = currentSnapshot;
    const targetReqSeq = targetSnapshot.reqSeq;
    const selected = fileObjects.slice();

    try {
      let names;
      try {
        names = selected.map((f) => validateFileName(f?.name));
      } catch (err) {
        toast(`拒绝上传：文件名不合法（${err.message || String(err)}）`);
        return { cancelled: true, reason: 'invalid_file_name', error: err.message || String(err) };
      }

      const duplicates = collectDuplicateNames(targetSnapshot, names);
      if (duplicates.length > 0) {
        toast(`拒绝上传：文件 "${duplicates.join(', ')}" 已存在。为防止无原子 noclobber 意外覆盖，请在本地改名后重试。`);
        return { cancelled: true, reason: 'duplicate_name_rejected' };
      }

      const confirmed = await askUploadConfirmation(targetSnapshot, names);
      if (!confirmed) {
        toast('已取消上传');
        return { cancelled: true, reason: 'not_confirmed' };
      }

      // 确认挂起恢复后，目标可能已换 root/目录或关闭
      if (!isTargetCurrent(targetSnapshot, targetReqSeq)) {
        toast('工作区目录已切换或已关闭，上传已安全取消');
        return { cancelled: true, reason: 'target_changed' };
      }

      toast('正在上传文件…');
      const uploadFiles = selected.map((f, i) => ({
        name: names[i],
        contentBase64: f?.contentBase64,
      }));
      const res = await service.upload(targetSnapshot, {
        subdir: targetSnapshot.subdir,
        files: uploadFiles,
      });

      if (res && res.ok === false) {
        const failedItems = (res.results || []).filter((r) => !r.ok);
        const failMsg = failedItems.map((f) => `${f.name}: ${f.error}`).join('; ');
        toast(`部分文件上传失败：${failMsg}`);
      } else {
        toast('文件上传成功');
      }

      // 仅当目标快照仍为当前活跃快照且抽屉仍打开时刷新
      if (isTargetCurrent(targetSnapshot, targetReqSeq)) {
        await loadFiles(targetSnapshot);
      }
      return res;
    } catch (err) {
      toast('上传失败：' + (err.message || String(err)));
      throw err;
    } finally {
      isUploading = false;
    }
  }

  /**
   * 处理原生 File 列表上传：
   * 1. 进入即占锁并冻结目标；所有 File 先做 size/count/total/名称检查；
   * 2. 一次明确目标与文件列表确认；
   * 3. 单 file 读取 Base64 -> 单 file upload -> 释放 Base64 -> 下一个，绝不批量堆积。
   */
  async function handleFileInputFiles(files) {
    if (!Array.isArray(files) || !files.length) return { cancelled: true };
    if (!currentSnapshot || !isOpenState) return { cancelled: true };
    if (!tryAcquireUploadLock()) {
      toast('已有上传任务进行中，请稍候');
      return { cancelled: true, reason: 'upload_busy' };
    }

    const targetSnapshot = currentSnapshot;
    const targetReqSeq = targetSnapshot.reqSeq;
    const fileList = files.slice();
    let activeFile = null;

    try {
      if (fileList.length > MOBILE_MAX_UPLOAD_FILES_COUNT) {
        const msg = `文件数量超过限制（最多 ${MOBILE_MAX_UPLOAD_FILES_COUNT} 个）`;
        toast(msg);
        throw new Error(msg);
      }

      let totalSize = 0;
      const names = [];
      for (const f of fileList) {
        const name = validateFileName(f?.name);
        const size = f?.size;
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
          const msg = `文件 "${name}" 的大小无效`;
          toast(msg);
          throw new Error(msg);
        }
        if (size === 0) {
          const msg = `文件 "${name}" 为 0 字节，暂不支持空文件上传`;
          toast(msg);
          throw new Error(msg);
        }
        if (size > MOBILE_MAX_SINGLE_FILE_BYTES) {
          const msg = `文件 "${name}" (${formatSize(size)}) 超过单文件 10MiB 限制`;
          toast(msg);
          throw new Error(msg);
        }
        totalSize += size;
        if (totalSize > MOBILE_MAX_TOTAL_UPLOAD_BYTES) {
          const msg = `上传总大小 (${formatSize(totalSize)}) 超过 20MiB 限制`;
          toast(msg);
          throw new Error(msg);
        }
        names.push(name);
      }

      const duplicates = collectDuplicateNames(targetSnapshot, names);
      if (duplicates.length > 0) {
        toast(`拒绝上传：文件 "${duplicates.join(', ')}" 已存在。为防止无原子 noclobber 意外覆盖，请在本地改名后重试。`);
        return { cancelled: true, reason: 'duplicate_name_rejected' };
      }

      const confirmed = await askUploadConfirmation(targetSnapshot, names);
      if (!confirmed) {
        toast('已取消上传');
        return { cancelled: true, reason: 'not_confirmed' };
      }

      if (!isTargetCurrent(targetSnapshot, targetReqSeq)) {
        toast('工作区目录已切换或已关闭，上传已安全取消');
        return { cancelled: true, reason: 'target_changed' };
      }

      toast('正在上传文件…');
      const results = [];
      let failed = false;

      for (let i = 0; i < fileList.length; i += 1) {
        if (!isTargetCurrent(targetSnapshot, targetReqSeq)) {
          toast('工作区目录已切换或已关闭，上传已安全取消');
          return { cancelled: true, ok: false, results };
        }

        const name = names[i];
        let b64 = null;
        activeFile = fileList[i];

        try {
          b64 = await readFileAsBase64(activeFile);
        } catch (err) {
          results.push({ name, ok: false, error: 'read_failed: ' + (err.message || String(err)) });
          failed = true;
          break;
        } finally {
          activeFile = null;
        }

        // 读取期间换 root/close：不得 POST，也不得借用新 root
        if (!isTargetCurrent(targetSnapshot, targetReqSeq)) {
          b64 = null;
          toast('工作区目录已切换或已关闭，上传已安全取消');
          return { cancelled: true, ok: false, results };
        }

        try {
          const res = await service.upload(targetSnapshot, {
            subdir: targetSnapshot.subdir,
            files: [{ name, contentBase64: b64 }],
          });

          if (res && res.ok === false) {
            const items = Array.isArray(res.results) && res.results.length
              ? res.results
              : [{ name, ok: false, error: res.error || 'upload_failed' }];
            results.push(...items);
            failed = true;
          } else {
            const item = (res?.results || []).find((r) => r.name === name) || { name, ok: true };
            results.push(item);
            if (item.ok === false) failed = true;
          }
        } catch (err) {
          results.push({ name, ok: false, error: err.message || String(err) });
          failed = true;
        } finally {
          // 单文件 Base64 与 File 引用都不继续持有
          b64 = null;
          activeFile = null;
        }

        if (failed) break;
      }

      if (failed) {
        const failedItems = results.filter((r) => r.ok === false);
        const failMsg = failedItems.map((f) => `${f.name}: ${f.error || 'upload_failed'}`).join('; ');
        toast(`部分文件上传失败：${failMsg}`);
      } else {
        toast('文件上传成功');
      }

      if (isTargetCurrent(targetSnapshot, targetReqSeq)) {
        await loadFiles(targetSnapshot);
      }

      return { ok: !failed, results };
    } finally {
      activeFile = null;
      isUploading = false;
    }
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : url);
      };
      reader.onerror = () => reject(reader.error || new Error('read_file_failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * 安全只读预览文件。
   * - 拦截未知或大型二进制，不无端发起网络拉取；
   * - 文本文件走 readTextPreview (<=64KiB)，严格 textContent 展示，标注截断；
   * - 栅格图片走 readFullBytes (<=8MiB)，magic bytes 嗅探，生成 ObjectURL，关闭或换根及时 revoke；
   * - 引入 currentPreviewSeq，慢请求不覆盖快请求或已关闭的预览。
   */
  async function previewFile(filename) {
    if (!currentSnapshot || !isOpenState) return;
    ensureDom();
    closePreview();

    const thisPreviewSeq = ++currentPreviewSeq;
    const previewSnapshot = currentSnapshot;

    previewTitleEl.textContent = `预览：${filename}`;
    previewBodyEl.innerHTML = '';
    previewBodyEl.appendChild(el('div', 'workspace-loading', '正在读取预览内容…'));
    previewModalEl.hidden = false;

    const downloadHref = service.downloadUrl(previewSnapshot, {
      subdir: previewSnapshot.subdir,
      name: filename,
    });

    // 关键优化 5：未知或不支持的二进制类型直接引导下载，绝不先拉取 8MiB
    if (!isTextPreviewable(filename) && !mightBeRasterImage(filename)) {
      renderUnsupportedPreview(filename, '此文件类型暂不支持在线安全预览，请直接下载。', downloadHref);
      return;
    }

    try {
      // 关键优化 5：文本文件走有界 readTextPreview，最多读 64KiB，不读全量 8MiB
      if (isTextPreviewable(filename)) {
        const res = await service.readTextPreview(previewSnapshot, {
          subdir: previewSnapshot.subdir,
          name: filename,
          maxBytes: TEXT_PREVIEW_MAX_BYTES,
        });

        // 关键修复 4：检查 previewSeq 序号与上下文有效性
        if (
          thisPreviewSeq !== currentPreviewSeq ||
          !isOpenState ||
          currentSnapshot !== previewSnapshot
        ) {
          return;
        }

        previewBodyEl.innerHTML = '';
        const pre = el('pre', 'workspace-preview-text');
        // 关键安全点：严格纯文本 textContent，绝不用 innerHTML
        pre.textContent = res.text;

        if (res.truncated) {
          const hint = el(
            'div',
            'workspace-subtitle',
            `（文件较长，已仅展示前 64KiB 内容；完整内容请下载查看）`
          );
          hint.style.padding = '8px 0';
          previewBodyEl.appendChild(hint);
        }
        previewBodyEl.appendChild(pre);
        return;
      }

      // 栅格图片走 readFullBytes
      const res = await service.readFullBytes(previewSnapshot, {
        subdir: previewSnapshot.subdir,
        name: filename,
      });

      // 关键修复 4：检查 previewSeq 序号与上下文有效性
      if (
        thisPreviewSeq !== currentPreviewSeq ||
        !isOpenState ||
        currentSnapshot !== previewSnapshot
      ) {
        return;
      }

      if (res.oversized) {
        renderUnsupportedPreview(
          filename,
          `图片较大（${formatSize(res.totalBytes)}），超出安全在线预览限制，请直接下载。`,
          downloadHref
        );
        return;
      }

      const bytes = res.bytes;
      const detectedMime = detectRasterImageMime(bytes);

      if (detectedMime) {
        previewBodyEl.innerHTML = '';
        const blob = new Blob([bytes], { type: detectedMime });
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          activePreviewUrl = URL.createObjectURL(blob);
          const img = doc.createElement('img');
          img.className = 'workspace-preview-img';
          img.alt = filename;
          img.setAttribute('src', activePreviewUrl);
          img.src = activePreviewUrl;
          previewBodyEl.appendChild(img);
        } else {
          renderUnsupportedPreview(filename, '环境不支持 ObjectURL，请直接下载。', downloadHref);
        }
        return;
      }

      renderUnsupportedPreview(filename, '非受支持的光栅图片格式，请直接下载。', downloadHref);
    } catch (err) {
      if (
        thisPreviewSeq !== currentPreviewSeq ||
        !isOpenState ||
        currentSnapshot !== previewSnapshot
      ) {
        return;
      }
      const tooLarge = err?.status === 413;
      renderUnsupportedPreview(
        filename,
        tooLarge
          ? '文件超过宿主 20MiB 分块读取上限，无法在线预览，请直接下载。'
          : `读取失败：${err.message || String(err)}`,
        downloadHref
      );
    }
  }

  function renderUnsupportedPreview(filename, message, downloadHref) {
    previewBodyEl.innerHTML = '';
    const box = el('div', 'workspace-preview-unsupported');
    box.appendChild(el('div', '', message));

    const dlBtn = el('a', 'workspace-upload-btn', '立即下载文件');
    dlBtn.setAttribute('href', downloadHref);
    dlBtn.setAttribute('download', filename);
    dlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      download(downloadHref, { onReject: () => toast('这个文件没有 App 认的下载地址，暂时下不了') });
    });
    box.appendChild(dlBtn);

    previewBodyEl.appendChild(box);
  }

  function closePreview() {
    currentPreviewSeq += 1; // 关键修复 4：递增使在途预览回包失效
    if (activePreviewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(activePreviewUrl);
      activePreviewUrl = null;
    }
    if (previewModalEl) {
      previewModalEl.hidden = true;
    }
  }

  return {
    open,
    close,
    back,
    isOpen,
    setRoots,
    navigateTo,
    previewFile,
    closePreview,
    handleFilesSelected,
    handleFileInputFiles,
  };
}
