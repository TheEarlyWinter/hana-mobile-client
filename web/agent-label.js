/**
 * 会话归属 Agent 的显示名。
 *
 * 为什么需要单独一层：会话里存下来的 `agentName` 是**建会话那一刻**的快照。
 * Agent 改名之后，历史会话里留的还是旧名字（实测：会话属于 hanako，当前显示名
 * 是「小鲸鱼」，但会话记录里写着「Hakimi」）。直接拿它当用户看到的称呼，
 * 就会出现「引用 Hakimi」这种对不上人的情况。
 *
 * 规则：id 是最稳的锚点，先按 id 去 Agent 列表里找当前名字；id 找不到再退到
 * 名字匹配；都不行才用会话快照，最后才用全局兜底。
 *
 * @param {{
 *   session?: { agentId?: string|null, agentName?: string|null }|null,
 *   agents?: Array<{ id?: string, agentId?: string, name?: string, agentName?: string }>|null,
 *   fallback?: string|null
 * }} input
 * @returns {string} 可直接展示的名字；彻底拿不到时返回空串（调用方自己决定默认值）
 */
export function resolveAgentLabel(input = {}) {
  const session = input.session && typeof input.session === 'object' ? input.session : null;
  const agents = Array.isArray(input.agents) ? input.agents.filter((a) => a && typeof a === 'object') : [];
  const fallback = text(input.fallback);

  const sessionId = text(session?.agentId);
  if (sessionId) {
    const byId = agents.find((a) => text(a.id) === sessionId || text(a.agentId) === sessionId);
    if (byId) {
      const name = text(byId.name) || text(byId.agentName);
      if (name) return name;
    }
  }

  const sessionName = text(session?.agentName);
  if (sessionName) {
    // 会话里的名字可能已经过期，但若这个名字现在还挂在某个 Agent 上，
    // 就以那边的最新写法为准（大小写、空格这类改名）。
    const byName = agents.find((a) => text(a.name) === sessionName || text(a.agentName) === sessionName);
    if (byName) {
      const name = text(byName.name) || text(byName.agentName);
      if (name) return name;
    }
    return sessionName;
  }

  return fallback;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
