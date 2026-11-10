/**
 * 「离开期间哪个会话有新回复」的判定器。
 *
 * 判据来自网关 `/gw/session-digest` 给的两个数：每条会话的 `messageCount`
 * 与 `isStreaming`。不用时间戳——会话列表的 `modified` 只跟用户发消息走，
 * 助手回复不动它（真机验过，这是上一版失败的原因）。
 *
 * 用法：
 *   const notice = createFinishedNotice();
 *   notice.snapshot(list);          // 建立基线（前台看着列表的时候）
 *   ...
 *   const report = notice.diff(list);  // 回来时做差
 *   notice.snapshot(list);          // 报完立刻变成新基线
 *
 * 设计上刻意保守：
 * - 基线里没有的会话（新出现的）不报：分不清是新建还是别人的；
 * - 第一次 snapshot 之前调用 diff 一律空：基线没建好时宁可不说；
 * - 只有条数变多或「在跑 → 空闲」才算，条数不变只是标题变了这种噪声不报。
 */

/** 一次最多报几条；总数另给，界面可以写「等 N 个」。 */
export const MAX_NOTICE_ITEMS = 3;

function toId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** 摘要条目 → 基线用的最小结构；字段不合法就返回 null。 */
function toEntry(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const sessionId = toId(row.sessionId);
  const count = toCount(row.messageCount);
  if (!sessionId || count === null) return null;
  return {
    sessionId,
    title: typeof row.title === 'string' ? row.title : '',
    messageCount: count,
    isStreaming: row.isStreaming === true,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.maxItems] 报表里最多列几条
 */
export function createFinishedNotice({ maxItems = MAX_NOTICE_ITEMS } = {}) {
  /** @type {Map<string, {sessionId: string, title: string, messageCount: number, isStreaming: boolean}>} */
  let baseline = new Map();
  let primed = false;

  /** 记下当前状态当基线。返回是否成功建立了基线。 */
  function snapshot(list) {
    if (!Array.isArray(list)) return false;
    const next = new Map();
    for (const row of list) {
      const entry = toEntry(row);
      if (!entry) continue;
      next.set(entry.sessionId, entry);
    }
    baseline = next;
    // 空列表也算建立了基线：否则真机上登录后列表为空会把第一次当成「全没基线」一直不报。
    primed = true;
    return true;
  }

  /**
   * 与基线比较。
   * @returns {{total: number, items: Array<{sessionId: string, title: string, reason: 'replied'|'finished', delta: number}>}}
   */
  function diff(list) {
    if (!primed || !Array.isArray(list)) return { total: 0, items: [] };
    const found = [];
    for (const row of list) {
      const now = toEntry(row);
      if (!now) continue;
      const before = baseline.get(now.sessionId);
      if (!before) continue; // 基线里没有：新会话，不报
      const delta = now.messageCount - before.messageCount;
      if (delta > 0) {
        found.push({ sessionId: now.sessionId, title: now.title || before.title, reason: 'replied', delta });
      } else if (before.isStreaming && !now.isStreaming) {
        // 条数没变但在跑变空闲：这一轮可能被中断，也可能只是状态先到。
        found.push({ sessionId: now.sessionId, title: now.title || before.title, reason: 'finished', delta: 0 });
      }
    }
    found.sort((a, b) => b.delta - a.delta);
    const cap = Math.max(1, maxItems);
    return { total: found.length, items: found.slice(0, cap) };
  }

  /** 清空基线：退出登录、换账号时必须调用，避免拿别人的条数做差。 */
  function reset() {
    baseline = new Map();
    primed = false;
  }

  return {
    snapshot,
    diff,
    reset,
    get primed() {
      return primed;
    },
  };
}

/** 一句话提示文案（界面与测试共用，避免两边各写一份措辞）。 */
export function formatNotice(report) {
  if (!report || !report.total) return '';
  const first = report.items?.[0];
  if (report.total === 1 && first) return `「${first.title || '会话'}」有新回复`;
  if (first) return `${report.total} 个会话有新回复（含「${first.title || '会话'}」）`;
  return `${report.total} 个会话有新回复`;
}
