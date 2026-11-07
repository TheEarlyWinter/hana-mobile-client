/**
 * 消息搜索特性。
 *
 * 一个入口按钮、一个搜索面板、两种查询阶段（先标题后正文）。
 * 依赖注入，不 import 应用层的任何东西；`app.js` 只负责登记与把会话打开的动作传进来。
 */

import { createMessageSearch } from '../message-search.js';

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.getElement
 * @param {(path: string, init?: object) => Promise<any>} deps.api
 * @param {() => string} deps.getNamespace 当前命名空间（home / code）
 * @param {(session: object) => void} deps.openSession 选中结果后打开会话
 * @param {Document} deps.document
 */
export function createSearchFeature({ getElement, api, getNamespace, openSession, document: doc }) {
  let mounted = false;
  let view = null;

  /**
   * 搜一次：先标题、不够再扫正文。
   * 宿主两个 phase 是分开的接口（title 快、content 慢），全量扫描会白白拖慢首次响应，
   * 所以标题结果够多就不扫正文；不够时才补，并按 path 去重合并。
   */
  async function searchSessionMessages(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const enc = encodeURIComponent(q);
    const namespace = getNamespace() === 'code' ? 'code' : 'home';

    const stamp = (items) =>
      (Array.isArray(items) ? items : []).map((r) =>
        r && typeof r === 'object' ? { ...r, searchNamespace: namespace } : r,
      );

    const first = await api(`/api/sessions/search?q=${enc}&phase=title&limit=20&namespace=${namespace}`);
    const titles = stamp(first?.results);
    if (titles.length >= 5) return titles;

    const second = await api(`/api/sessions/search?q=${enc}&phase=content&limit=20&namespace=${namespace}`);
    const more = stamp(second?.results);
    const seen = new Set(titles.map((r) => r.path));
    return titles.concat(more.filter((r) => r && !seen.has(r.path)));
  }

  function ensureView() {
    if (view) return view;
    view = createMessageSearch({
      document: doc,
      container: doc.body,
      onSearch: (query) => searchSessionMessages(query),
      onSelect: (result) => {
        if (!result || !result.path) return;
        view.close();
        // 搜索按发起搜索时的命名空间归属，且转发结果自带的全部会话元数据
        openSession({
          ...result,
          path: result.path,
          sessionId: result.sessionId,
          title: result.title || result.sessionTitle || '会话',
          firstMessage: result.firstMessage,
          agentId: result.agentId || null,
          agentName: result.agentName || null,
          cwd: result.cwd || null,
          workspaceMountId: result.workspaceMountId || null,
          workspaceLabel: result.workspaceLabel || null,
          namespace: result.searchNamespace || (getNamespace() === 'code' ? 'code' : 'home'),
        });
      },
    });
    return view;
  }

  function open() {
    ensureView().open();
  }

  function close() {
    view?.close();
  }

  function toggle() {
    const v = ensureView();
    if (v.isOpen()) v.close();
    else v.open();
  }

  /** 入口按钮：挂在主页头部的新建按钮旁。不在 index.html 里写死，避免与列表布局耦合。 */
  function mount() {
    if (mounted) return;
    const anchor = getElement('btnRefresh');
    // 优先用显式容器：假 DOM 里没有 parentNode，拿不到就挂了。
    const holder = getElement('homeHeadActions') || (anchor ? anchor.parentNode : null);
    if (!holder || typeof doc.createElement !== 'function') return;

    const btn = doc.createElement('button');
    btn.className = 'icon-btn liquid-btn';
    btn.id = 'btnSearch';
    btn.title = '搜索消息';
    btn.setAttribute('aria-label', '搜索消息');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>';
    btn.addEventListener('click', () => toggle());
    if (anchor && anchor.parentNode === holder) holder.insertBefore(btn, anchor);
    else holder.appendChild(btn);
    mounted = true;
  }

  function reset() {
    if (view) {
      view.close();
      if (typeof view.destroy === 'function') {
        view.destroy();
      }
      view = null;
    }
  }

  return {
    mount,
    open,
    close,
    reset,
    toggle,
    isOpen: () => Boolean(view && view.isOpen()),
    search: searchSessionMessages,
  };
}
