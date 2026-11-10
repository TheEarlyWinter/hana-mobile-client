/* web/echo-guard.js — 「这条回显是不是我刚发的」
 *
 * 服务端会把自己发出去的用户消息再回显一遍。气泡在发送成功那一刻已经乐观画好了，
 * 回显要是再画一次，屏上就是两条一模一样的用户消息。所以发送时记一笔，收到回显时核销：
 *   1. 回显带 inputId：按 id 认（一条只核销一次；32 条是留给断线重连的余量）；
 *   2. 回显不带 id：5 秒内文本完全相同也当成自己发的。
 *
 * 这两份记账原先挂在 app 的 S 上（composer 写、event-router 读），S 因此替两个模块存
 * 私有状态。现在收成一份实例，装配层建一个同时注入两边，读写都只经过这里。
 *
 * backing 只服务老单测：composer_controller / pending_state / send_race 直接构造 state
 * 并读写 state.sentInputs、state.lastLocalUser。传 backing 时读写落在它上面（缺字段就补），
 * 不传就用自己这两份。生产装配不传。
 */

/** 记住最近多少个已发 inputId。回显几秒内就到，32 条足够覆盖重连后迟到的回显。 */
const MAX_SENT_IDS = 32;

/** 不带 id 的回显：文本相同且落在这个窗口内，就当自己发的。 */
const LOCAL_USER_WINDOW_MS = 5000;

/**
 * @param {object|null} [backing] 可选的老式 state：读写它的 sentInputs / lastLocalUser
 * @returns {{
 *   noteSent: (inputId: string, text: string, now?: number) => void,
 *   takeEcho: (inputId: string) => boolean,
 *   matchesRecent: (text: string, now?: number, windowMs?: number) => boolean,
 *   ids: Set<string>,
 *   lastLocalUser: {text: string, at: number}|null,
 *   reset: () => void,
 * }}
 */
export function createEchoGuard(backing = null) {
  /** 不传 backing 时自己的两份记账。 */
  const ownIds = new Set();
  let ownLastUser = null;

  /**
   * 当前那份 id 集合。backing 上还没有这个字段就按需补一个：有的老夹具只给
   * lastLocalUser，有的什么都不给（那几份只测别的分支），都要能跑。
   */
  function idsOf() {
    if (!backing) return ownIds;
    if (!(backing.sentInputs instanceof Set)) backing.sentInputs = new Set();
    return backing.sentInputs;
  }

  function lastUserOf() {
    return backing ? backing.lastLocalUser ?? null : ownLastUser;
  }

  function setLastUser(value) {
    if (backing) backing.lastLocalUser = value;
    else ownLastUser = value;
  }

  /**
   * 记一条「我刚发出去的消息」。只有帧真的写出去了才会调到这里。
   * @param {string} inputId 发送帧里的 inputId
   * @param {string} text 发出去的正文（没有 id 的回显靠它比对）
   * @param {number} [now] 当前时间；用例可以传假时钟
   */
  function noteSent(inputId, text, now = Date.now()) {
    if (typeof inputId === 'string' && inputId) {
      const ids = idsOf();
      ids.add(inputId);
      // 超上限只丢最老的：还没回来的回显只可能是最近这几条。
      while (ids.size > MAX_SENT_IDS) {
        const oldest = ids.values().next().value;
        if (!oldest) break;
        ids.delete(oldest);
      }
    }
    // 回显也可能不带 id，正文与时间就是唯一线索：每次发送都整条换掉，不留上一条。
    setLastUser({ text, at: now });
  }

  /**
   * 核销一条 id：这次回显是我们自己发的那条吗？是就删掉并返回 true。
   * 删掉之后同一条回显再来就认不出来了——一条消息只回显一次，重复的交给下游去重。
   * @param {string} inputId 回显里的 inputId / clientMessageId
   */
  function takeEcho(inputId) {
    if (typeof inputId !== 'string' || !inputId) return false;
    const ids = idsOf();
    if (!ids.has(inputId)) return false;
    ids.delete(inputId);
    return true;
  }

  /**
   * 没带 id 的回显：最近一次发送的正文相同、且还在这 5 秒窗口里，就当自己发的。
   * 窗口从发送那一刻算，不是从上次核销算。
   */
  function matchesRecent(text, now = Date.now(), windowMs = LOCAL_USER_WINDOW_MS) {
    const last = lastUserOf();
    if (!last) return false;
    return last.text === text && now - last.at < windowMs;
  }

  /** 两份记账一起清空（退出登录、用例复位）。 */
  function reset() {
    idsOf().clear();
    setLastUser(null);
  }

  return {
    noteSent,
    takeEcho,
    matchesRecent,
    /** 当前那份 Set（兼容层与测试看；业务代码不要绕过 noteSent 往里写）。 */
    get ids() {
      return idsOf();
    },
    /** 最近一次发送 { text, at }；没有就是 null。 */
    get lastLocalUser() {
      return lastUserOf();
    },
    reset,
  };
}
