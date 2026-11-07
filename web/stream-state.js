/* 流式游标状态：streamId + lastSeq 的闭包封装。
 *
 * app.js 只持有一个实例；普通事件走 observe，断线续流走 beginReplay +
 * acceptReplay。工厂每次返回完全独立的状态，方便单测。
 */

export function createStreamState() {
  let streamId = null;
  let lastSeq = 0;

  /** 清空流标识与游标（切会话、turn_end）。 */
  function reset() {
    streamId = null;
    lastSeq = 0;
  }

  /**
   * 普通事件：只做 streamId 切换重置和 number seq 的最大值推进。
   * 这里不做实时去重——事件该不该渲染由上层决定，游标只记录进度。
   */
  function observe(event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.streamId === 'string' && event.streamId) {
      if (event.streamId !== streamId) {
        streamId = event.streamId;
        lastSeq = 0;
      }
    }
    if (typeof event.seq === 'number') {
      lastSeq = Math.max(lastSeq, event.seq);
    }
  }

  /**
   * 回放开始：只处理 streamId 切换，不采用 envelope 上的 seq/nextSeq——
   * 游标必须由实际消费到的事件推进。
   */
  function beginReplay(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    if (typeof envelope.streamId === 'string' && envelope.streamId) {
      if (envelope.streamId !== streamId) {
        streamId = envelope.streamId;
        lastSeq = 0;
      }
    }
  }

  /** 回放事件：number 且不大于游标则拒绝（重复/倒退），否则推进；无 seq 放行不推进。 */
  function acceptReplay(seq) {
    if (typeof seq !== 'number') return true;
    if (seq <= lastSeq) return false;
    lastSeq = seq;
    return true;
  }

  function snapshot() {
    return { streamId, lastSeq };
  }

  /** 重连时 resume_stream 的字段；没有游标时 sinceSeq 回 0。 */
  function resumeFields() {
    return { streamId, sinceSeq: lastSeq || 0 };
  }

  return { reset, observe, beginReplay, acceptReplay, snapshot, resumeFields };
}
