/**
 * 归档会话特性。
 *
 * 宿主的归档是**真的移动文件**（`sessions/archived/` 下），不是本地标记：
 *   列表  GET  /api/sessions/archived            → { sessions: [...] }
 *   归档  POST /api/sessions/archive             { sessionId?, sessionPath? }
 *   还原  POST /api/sessions/restore             { sessionId?, sessionPath? }（传归档行里的 path）
 *
 * 归档行字段：`path / sessionId / title / archivedAt / sizeBytes / agentId / agentName`。
 * 注意归档接口不带 namespace，返回的是多个助手混在一起的集合，所以这里如实展示 agentName，
 * 不再假装按 Chat/Code 过滤。
 *
 * 本模块零依赖（不 import 应用层任何东西），面板惰性创建，样式复用全局类。
 */

const PANEL_CLASS = 'archive-panel';

/** 归档时间只显示到分钟，读起来比 ISO 串顺眼。 */
function formatArchivedAt(value) {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.getElement
 * @param {(path: string, init?: object) => Promise<any>} deps.api
 * @param {(text: string) => void} deps.flash
 * @param {() => void} deps.onRestored 还原成功后通知外层刷新活跃列表
 * @param {Document} deps.document
 */
export function createArchiveFeature({ getElement, api, flash, onRestored, document: doc }) {
  let panel = null;
  let listEl = null;
  let emptyEl = null;
  let statusEl = null;
  let mounted = false;
  let loading = false;
  let rows = [];
  let loadSeq = 0;
  // 退出登录代次：只保护 restore 的迟到回调；普通 close 不推进，恢复 UI 不能被关面板废掉。
  let resetGen = 0;

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function buildPanel() {
    if (panel) return panel;
    if (!doc || typeof doc.createElement !== 'function') return null;

    panel = doc.createElement('div');
    panel.className = PANEL_CLASS;
    panel.hidden = true;

    const head = doc.createElement('div');
    head.className = `${PANEL_CLASS}-head`;

    const title = doc.createElement('span');
    title.className = `${PANEL_CLASS}-title`;
    title.textContent = '归档会话';
    head.appendChild(title);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = `icon-btn ${PANEL_CLASS}-close`;
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', () => close());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    statusEl = doc.createElement('div');
    statusEl.className = `${PANEL_CLASS}-status`;
    statusEl.hidden = true;
    panel.appendChild(statusEl);

    listEl = doc.createElement('div');
    listEl.className = `${PANEL_CLASS}-list`;
    panel.appendChild(listEl);

    emptyEl = doc.createElement('div');
    emptyEl.className = `${PANEL_CLASS}-empty`;
    emptyEl.textContent = '还没有归档的会话。长按会话可以归档。';
    emptyEl.hidden = true;
    panel.appendChild(emptyEl);

    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(panel);
    return panel;
  }

  function renderRows() {
    if (!listEl) return;
    listEl.innerHTML = '';
    for (const row of rows) {
      const item = doc.createElement('div');
      item.className = `${PANEL_CLASS}-row`;

      const main = doc.createElement('div');
      main.className = `${PANEL_CLASS}-main`;

      const name = doc.createElement('div');
      name.className = `${PANEL_CLASS}-name`;
      name.textContent = row.title || '未命名会话';
      main.appendChild(name);

      const meta = doc.createElement('div');
      meta.className = `${PANEL_CLASS}-meta`;
      const parts = [];
      if (row.agentName) parts.push(row.agentName);
      const when = formatArchivedAt(row.archivedAt);
      if (when) parts.push(`归档于 ${when}`);
      meta.textContent = parts.join(' · ');
      main.appendChild(meta);

      const restoreBtn = doc.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = `${PANEL_CLASS}-restore`;
      restoreBtn.textContent = '还原';
      restoreBtn.addEventListener('click', () => { void restore(row, restoreBtn); });
      main.appendChild(restoreBtn);

      item.appendChild(main);
      listEl.appendChild(item);
    }
    emptyEl.hidden = rows.length > 0;
  }

  async function load() {
    if (loading) return;
    loading = true;
    const mySeq = ++loadSeq;
    setStatus('正在读取…');
    try {
      const res = await api('/api/sessions/archived');
      if (mySeq !== loadSeq) return;
      const list = Array.isArray(res?.sessions) ? res.sessions : Array.isArray(res) ? res : [];
      // 只保留能定位到文件的条目：没有 path 的行既打不开也还原不了。
      rows = list.filter((row) => row && typeof row.path === 'string' && row.path);
      renderRows();
      setStatus('');
    } catch (err) {
      if (mySeq !== loadSeq) return;
      rows = [];
      renderRows();
      setStatus(err && err.message ? `读取失败：${err.message}` : '读取失败');
    } finally {
      if (mySeq === loadSeq) {
        loading = false;
      }
    }
  }

  async function restore(row, btn) {
    const gen = resetGen;
    if (btn) btn.disabled = true;
    setStatus('');
    try {
      await api('/api/sessions/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 归档行的 path 就是归档后的路径，宿主要的就是它。
        body: JSON.stringify({
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
          sessionPath: row.path,
        }),
      });
      if (gen !== resetGen) return;
      rows = rows.filter((r) => r.path !== row.path);
      renderRows();
      onRestored?.();
      flash?.('已还原到会话列表');
    } catch (err) {
      if (gen !== resetGen) return;
      if (btn) btn.disabled = false;
      setStatus(err && err.message ? `还原失败：${err.message}` : '还原失败');
    }
  }

  async function open() {
    const el = buildPanel();
    if (!el) return;
    el.hidden = false;
    await load();
  }

  function close() {
    if (panel) panel.hidden = true;
  }

  function isOpen() {
    return Boolean(panel && !panel.hidden);
  }

  /** 抽屉里的入口按钮。放在会话类型切换下面，属于「列表的另一种视角」。 */
  function mount() {
    if (mounted) return;
    const anchor = getElement('sessionList');
    const holder = anchor && anchor.parentNode ? anchor.parentNode : null;
    if (!holder || typeof doc.createElement !== 'function') return;

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = 'btnArchivedList';
    btn.className = 'archive-entry';
    btn.textContent = '归档会话';
    btn.addEventListener('click', () => { void open(); });

    if (anchor && anchor.parentNode === holder) holder.insertBefore(btn, anchor);
    else holder.appendChild(btn);
    mounted = true;
  }

  function reset() {
    resetGen += 1;
    loadSeq++;
    loading = false;
    close();
    rows = [];
    renderRows();
    setStatus('');
  }

  return {
    mount,
    open,
    close,
    reset,
    isOpen,
    reload: load,
    /** 测试用：当前渲染出来的归档行。 */
    getRows: () => rows.slice(),
    _restore: restore,
  };
}
