/* web/abort-queue.js — 断线时点的「停止」：只装 0 或 1 条待补发 abort 的小队列
 *
 * 场景：连接断着的时候用户点了「停止」，abort 帧发不出去。那一轮服务端其实还在跑，
 * 本地不能假装停了（重连后 resume_stream 会把它拉回来）。所以把这次「停止」记下来，
 * 等连接恢复后先补发，再决定要不要续流。
 *
 * 同一时刻只有一个待补发：同一轮重复点停止没有新语义，后到的覆盖先到的。
 *
 * 这个模块只管存那 0/1 条数据，不做会话归属判断——「换了会话就把排队作废」是
 * websocket-client 补发时才有的判断（它需要当前会话和 stream 游标，队列两样都没有）。
 *
 * 条目原样收、原样给：不做字段转换、不补默认值，调用方塞什么形状就取什么形状
 * （当前调用方用的形状是 { sessionId?, sessionPath, streamId? }）。
 */

export function createAbortQueue() {
  /** 当前待补发条目。整个队列只有这一格；null 表示空。 */
  let entry = null;

  /**
   * 入队。已经有一条时用新的覆盖旧的：同一时刻只留一条。
   * @param {object} pending 待补发的 abort 条目；传空值等同于 clear()
   * @returns {boolean} true = 原来空着、这次新排上；false = 覆盖了已有条目（或传了空值）
   */
  function push(pending) {
    if (!pending) {
      entry = null;
      return false;
    }
    const wasEmpty = entry === null;
    entry = pending;
    return wasEmpty;
  }

  /** 看当前条目但不取走；没有就是 null。返回的就是入队时那个引用，不复制。 */
  function peek() {
    return entry;
  }

  /** 取走并清空；没有返回 null。 */
  function take() {
    const current = entry;
    entry = null;
    return current;
  }

  /** 清空。 */
  function clear() {
    entry = null;
  }

  /** 0（没有待补发）或 1（排着一条）。 */
  function size() {
    return entry === null ? 0 : 1;
  }

  return { push, peek, take, clear, size };
}
