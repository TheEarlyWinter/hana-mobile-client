/* web/avatar-view.js
 *
 * 头像渲染与辅助函数。
 * 从 web/app.js 抽取，提供纯函数计算与闭包 DOM 渲染。
 */

/**
 * 取名字的首字母或首字符。
 * 英文字母自动大写，其它字符（如中文）保留原字符；空值返回居中点。
 */
export function initialOf(name) {
  const s = String(name || '').trim();
  if (!s) return '·';
  return /[a-zA-Z]/.test(s[0]) ? s[0].toUpperCase() : s[0];
}

/**
 * Agent 头像地址计算。
 * 显式给定 url 优先；若仅声明 hasAvatar 则拼装编码后的 API 地址；无头像返回 null。
 */
export function agentAvatarUrl(agent) {
  if (!agent) return null;
  const given = agent.avatarUrl || agent.avatar?.url;
  if (given) return given;
  if (!agent.hasAvatar) return null;
  const id = agent.id || agent.agentId;
  return id ? `/api/agents/${encodeURIComponent(id)}/avatar` : null;
}

/**
 * 创建头像视图控制器。
 *
 * 闭包仅持有传入的 document 工厂，杜绝隐式全局读取；
 * 保持原生 error 兜底、alt、eager/async 配置，严格使用 DOM 操作避免 innerHTML 注入。
 */
export function createAvatarView({ document: doc } = {}) {
  if (!doc) {
    throw new Error('createAvatarView requires { document }');
  }

  function paintAvatar(host, { url = null, name = '', fallback = '' } = {}) {
    if (!host) return;
    const initial = initialOf(fallback || name || 'H');
    host.textContent = '';
    if (!url) {
      host.textContent = initial;
      return;
    }
    const img = doc.createElement('img');
    img.alt = name || '';
    img.loading = 'eager';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.remove();
      host.textContent = initial;
    }, { once: true });
    img.src = url;
    host.appendChild(img);
  }

  return {
    paintAvatar,
  };
}
