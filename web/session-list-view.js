/* web/session-list-view.js
 *
 * 会话列表视图控制器与纯函数工具。
 * 从 web/app.js 抽取，负责会话列表的渲染、格式化、DOM 构建及交互事件处理。
 */

import { createAvatarView, agentAvatarUrl } from './avatar-view.js';
import { isPinned } from './session-actions.js';

/**
 * 提取路径中的基名 (basename)。
 * 支持 Windows 反斜杠及 POSIX 斜杠，自动忽略尾部斜杠。
 */
export function baseName(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * 计算会话排序与展示的时间戳。
 * 优先级：modified > updatedAt > lastActiveAt > mtime > createdAt。
 */
export function sessionTime(s) {
  if (!s) return 0;
  const raw = s.modified || s.updatedAt || s.lastActiveAt || s.mtime || s.createdAt;
  if (!raw) return 0;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 格式化相对时间。
 * 缺省或 0 返回空字符串；支持注入当前时间基准。
 */
export function fmtAgo(ts, nowMs = Date.now()) {
  if (!ts) return '';
  const diff = nowMs - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 今天 / 昨天 / 最近一周 / 更早 —— 按本地日期分段。
 * 支持注入当前时间基准。
 */
export function dayBucket(ts, nowMs = Date.now()) {
  if (!ts) return '更早';
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - 86400e3) return '昨天';
  if (ts >= startOfToday - 7 * 86400e3) return '最近一周';
  return '更早';
}

/**
 * 提取会话标题。
 * 优先级：title || name -> firstMessage(前60字) -> '(无标题)'。
 */
export function sessionTitle(s) {
  if (!s) return '(无标题)';
  const t = s.title || s.name;
  if (t && String(t).trim()) return String(t).trim();
  const first = s.firstMessage && String(s.firstMessage).trim();
  if (first) return first.slice(0, 60);
  return '(无标题)';
}

/**
 * 计算会话所属文件夹展示名。
 * 保证先 basename 后 homeFolder fallback。
 */
export function sessionFolder(s, homeFolder = '') {
  if (!s) return homeFolder || '';
  const base = baseName(s.cwd || s.workspace || s.folder || s.homeFolder || '');
  return base || homeFolder || '';
}

/**
 * 创建会话列表视图。
 *
 * @param {object} options
 * @param {Document} options.document - DOM 工厂实例，杜绝全局隐式读取
 * @param {HTMLElement} options.container - 列表挂载容器
 * @param {Function} options.getContext - 获取实时上下文 { agentName, homeFolder, agents }
 * @param {Function} options.onOpenSession - 会话项点击回调
 * @param {Function} [options.onRowAction] - 长按 / 右键回调，用于会话操作菜单
 * @param {Function} [options.now=() => Date.now()] - 时间基准生成函数，便于单测精确控制
 */
export function createSessionListView({
  document: doc,
  container,
  getContext,
  onOpenSession,
  onRowAction,
  now = () => Date.now(),
} = {}) {
  if (!doc) {
    throw new Error('createSessionListView requires { document }');
  }
  if (!container) {
    throw new Error('createSessionListView requires { container }');
  }

  const { paintAvatar } = createAvatarView({ document: doc });

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function showLoading() {
    container.innerHTML = '';
    container.appendChild(el('div', 'empty', '载入中…'));
  }

  function showError(error) {
    const msg = typeof error === 'string' ? error : (error?.message || String(error || ''));
    container.innerHTML = '';
    container.appendChild(el('div', 'empty', '拉取会话失败：' + msg));
  }

  function row(s) {
    const rowEl = el('div', 'session-item');
    const ctx = getContext?.() || {};

    const agent = s.agentName || s.agentId || ctx.agentName || '';
    const av = el('div', 'avatar avatar-agent');

    // 智能体头像：仅按 id 匹配
    const matchedAgent = s.agentId ? (ctx.agents || []).find((a) => a.id === s.agentId) : null;
    const avatarUrl = matchedAgent ? agentAvatarUrl(matchedAgent) : null;

    paintAvatar(av, { url: avatarUrl, name: agent, fallback: agent });
    av.title = agent;

    const body = el('div', 'session-body');
    body.appendChild(el('div', 'session-title', sessionTitle(s)));

    const metaBits = [];
    if (agent) metaBits.push(agent);
    if (s.messageCount != null) metaBits.push(`${s.messageCount} 条`);
    const folder = sessionFolder(s, ctx.homeFolder);
    if (folder) metaBits.push(folder);

    const meta = el('div', 'session-meta', metaBits.join(' · '));
    // Code 会话在 meta 里多一枚轻量标识；Chat 行布局与文案保持原样。
    if (s.namespace === 'code') {
      const badge = el('span', 'session-ns-badge', 'Code');
      if (typeof meta.insertBefore === 'function') meta.insertBefore(badge, meta.firstChild || null);
      else meta.appendChild(badge);
    }
    body.appendChild(meta);

    const when = fmtAgo(sessionTime(s), now());

    rowEl.appendChild(av);
    rowEl.appendChild(body);
    rowEl.appendChild(el('div', 'session-time', when));

    /*
     * 长按 / 右键：把这一行交给上层开会话操作菜单（重命名、置顶、归档）。
     * 长按触发后要吞掉紧随的 click，否则松手会先弹出菜单又立刻把会话打开。
     */
    let suppressClick = false;
    if (typeof onRowAction === 'function') {
      let timer = null;
      const cancel = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      rowEl.addEventListener('pointerdown', () => {
        cancel();
        timer = setTimeout(() => {
          timer = null;
          suppressClick = true;
          onRowAction(s);
        }, 480);
      });
      rowEl.addEventListener('pointerup', cancel);
      rowEl.addEventListener('pointercancel', cancel);
      rowEl.addEventListener('pointerleave', cancel);
      rowEl.addEventListener('touchmove', cancel, { passive: true });
      rowEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        cancel();
        suppressClick = true;
        onRowAction(s);
      });
    }

    rowEl.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onOpenSession?.(s);
    });
    return rowEl;
  }

  function render(list) {
    container.innerHTML = '';
    const rawList = Array.isArray(list) ? list : (list?.sessions || []);
    if (!rawList.length) {
      container.appendChild(el('div', 'empty', '还没有会话。'));
      return;
    }

    // 严禁改动原数组：浅拷贝后按时间降序排序
    const sorted = [...rawList].sort((a, b) => sessionTime(b) - sessionTime(a));

    // 置顶的单独成组放最前面，剩下的才按日期分组（日期从剩下的里算，避免把置顶挤掉）
    const pinned = sorted.filter((s) => isPinned(s));
    const rest = sorted.filter((s) => !isPinned(s));
    if (pinned.length) {
      container.appendChild(el('div', 'group-label', '置顶'));
      for (const s of pinned) container.appendChild(row(s));
    }

    const currentNow = now();
    const buckets = new Map();
    for (const s of rest) {
      const key = dayBucket(sessionTime(s), currentNow);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(s);
    }

    for (const [label, items] of buckets) {
      container.appendChild(el('div', 'group-label', label));
      for (const s of items) container.appendChild(row(s));
    }
  }

  return {
    render,
    row,
    showLoading,
    showError,
  };
}
