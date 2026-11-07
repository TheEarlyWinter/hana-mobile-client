/* web/notifications.js — 「这一轮答完了」的手机通知
 *
 * 只做一件判断：一轮回复结束时，该不该弹一条系统通知，弹什么字。
 * 真正的发送交给注入的 notify()（移动端是 native-bridge → 原生通知；桌面浏览器里
 * 什么都没有，于是安静降级——这条链路上不许抛错，也不许把页面弄崩）。
 *
 * 权威信号是 `stream_turn_end`（由 event-router 的 onTurnEnd 注入点转成 info）：
 *   { sessionId, sessionPath, streamId, aborted, truncated }
 * 它没有 title、没有正文、也没有 failed——所以文案只按「完成 / 被截断」两档，
 * 绝不把回复正文塞进通知（锁屏上是公开可见的）。
 *
 * 四条规矩：
 *  1. 前台不发：人正看着屏幕，通知栏再来一条只是噪音；
 *  2. 同一 sessionId+streamId 只发一次：stream_turn_end 与 turn_end 可能都到；
 *  3. aborted 不发：用户自己按的停止，不该被通知「完成了」；
 *  4. 权限问过一次就不再问：denied / unsupported 之后一律不再请求。
 *
 * 契约：
 *   createNotifications({ notify, requestPermission, isForeground, agentName, now }) -> {
 *     onTurnEnd(info): Promise<'sent'|'skipped-…'|'unsupported'|'ignored'|'error'>,
 *     ensurePermission(): Promise<'granted'|'denied'|'unsupported'|'pending'|'unknown'>,
 *     permissionState(): string,
 *     reset(): void,
 *   }
 */

/** 助手名拿不到时的兜底（原生通知的标题）。 */
const DEFAULT_AGENT_NAME = 'Hana';
/** 默认正文：只说「完成了」，不塞正文摘要。 */
export const BODY_DONE = '回复已完成';
/** 被截断（stopReason:"length"）时的正文：让用户知道还有内容没生成完。 */
export const BODY_TRUNCATED = '回复被截断，可能还没写完';
/** 记多少个已发过的回合；再多也没意义，只防内存无限长。 */
const MAX_REMEMBERED_TURNS = 64;
/** 没有 streamId 时靠时间窗去重：两个结束事件通常前后脚到。 */
const NO_STREAM_ID_MIN_GAP_MS = 1500;
/** 权限没结论（原生超时没回执）时隔多久再问一次，别每轮都问。 */
const PERMISSION_RETRY_MS = 60000;

/** 默认的「前台」判断：页面可见就算人在看。Android WebView 切后台会给 hidden。 */
function defaultIsForeground() {
  const doc = typeof document === 'undefined' ? null : document;
  if (!doc) return true;
  return doc.visibilityState !== 'hidden';
}

/**
 * @param {object} options
 * @param {(title: string, body: string) => (boolean|Promise<boolean>)} [options.notify]
 *   发一条通知。返回 false / 抛错都算没发出去。
 * @param {() => Promise<'granted'|'denied'|'unsupported'|'unknown'>} [options.requestPermission]
 *   要通知权限。没有原生桥时应返回 'unsupported'。
 * @param {() => boolean} [options.isForeground]
 * @param {string|(() => string)} [options.agentName] 标题用的助手名
 * @param {() => number} [options.now] 测试用的时钟
 */
export function createNotifications({
  notify = () => false,
  requestPermission = async () => 'unsupported',
  isForeground = defaultIsForeground,
  agentName = DEFAULT_AGENT_NAME,
  now = () => Date.now(),
} = {}) {
  /** 已经发过通知的回合：sessionId|streamId（或 |seq:n）。 */
  const seen = new Set();
  /** 权限状态机：unknown → pending → granted / denied / unsupported。 */
  let permission = 'unknown';
  let permissionInFlight = null;
  let permissionRetryAt = 0;
  /** 上一次真的发出去的时间，只给「没有 streamId」的去重兜底用。 */
  let lastSentAt = 0;

  function agentTitle() {
    const raw = typeof agentName === 'function' ? agentName() : agentName;
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text || DEFAULT_AGENT_NAME;
  }

  function remember(key) {
    seen.add(key);
    if (seen.size <= MAX_REMEMBERED_TURNS) return;
    // Set 记住插入顺序，删最早那条就行。
    const oldest = seen.values().next().value;
    seen.delete(oldest);
  }

  /**
   * 回合指纹。缺 streamId 时退到 seq；两样都没有就只能靠时间窗（见 onTurnEnd）。
   * session 部分用 sessionId，没有就用 sessionPath——同一个会话的两个字段。
   */
  function turnKey(info) {
    const session = info.sessionId || info.sessionPath || '';
    const stream = info.streamId
      || (typeof info.seq === 'number' ? 'seq:' + info.seq : '');
    return stream ? session + '|' + stream : '';
  }

  function settlePermission(result) {
    if (result === 'granted' || result === 'denied' || result === 'unsupported') {
      permission = result;
      return;
    }
    // 'unknown'：原生没回执（用户可能还开着系统权限框）。保持「没结论」，过一会儿再问。
    permissionRetryAt = now() + PERMISSION_RETRY_MS;
  }

  /** 懒请求：第一次真要发通知时才要权限；同一时刻只发一次请求。 */
  async function ensurePermission() {
    if (permission === 'granted' || permission === 'denied' || permission === 'unsupported') {
      return permission;
    }
    if (permissionInFlight) return permissionInFlight;
    if (now() < permissionRetryAt) return 'pending';
    permissionInFlight = (async () => {
      let result = 'unsupported';
      try {
        result = await requestPermission();
      } catch (err) {
        // 桥断了之类：当不支持，别让异常冒到页面。
        console.warn('[notify] 请求通知权限失败', err);
        result = 'unsupported';
      }
      settlePermission(result);
      return permission;
    })();
    try {
      return await permissionInFlight;
    } finally {
      permissionInFlight = null;
    }
  }

  async function send(title, body) {
    try {
      const result = await notify(title, body);
      return result !== false;
    } catch (err) {
      console.warn('[notify] 发送通知失败', err);
      return false;
    }
  }

  /**
   * 一轮回复结束。永远不抛错、永远 resolve（event-router 里是同步调用，抛出来会变成
   * 页面顶上的未捕获异常横幅）。返回值只给测试和排错看。
   */
  async function onTurnEnd(info) {
    const verdict = await decide(info);
    // 每轮一行，看得出到底是因为什么没发（日志会转发到 logcat 的 HanaWebConsole）。
    console.info(`[notify] 回合结束 → ${verdict}`);
    return verdict;
  }

  async function decide(info) {
    try {
      if (!info || typeof info !== 'object') return 'ignored';
      // 用户自己按的停止：不该被通知「完成了」。
      if (info.aborted === true) return 'skipped-aborted';

      const key = turnKey(info);
      if (key) {
        if (seen.has(key)) return 'skipped-duplicate';
        remember(key);
      } else {
        // 两个字段都没有：只能靠时间窗挡住「同一轮的两个结束事件」。
        const at = now();
        if (at - lastSentAt < NO_STREAM_ID_MIN_GAP_MS) return 'skipped-duplicate';
      }

      // 人正看着屏幕：不打扰。
      if (isForeground()) return 'skipped-foreground';

      const state = await ensurePermission();
      if (state !== 'granted') return state === 'unsupported' ? 'unsupported' : 'skipped-permission';

      const body = info.truncated === true ? BODY_TRUNCATED : BODY_DONE;
      const sent = await send(agentTitle(), body);
      if (!sent) return 'skipped-bridge';
      lastSentAt = now();
      return 'sent';
    } catch (err) {
      console.warn('[notify] 回合结束处理失败', err);
      return 'error';
    }
  }

  function reset() {
    seen.clear();
    permission = 'unknown';
    permissionInFlight = null;
    permissionRetryAt = 0;
    lastSentAt = 0;
  }

  return {
    onTurnEnd,
    ensurePermission,
    permissionState: () => permission,
    reset,
  };
}
