/* 日报阅读计时：只统计「与视口相交 + document 可见 + 卡片已 ready + 面板 active」
 * 的连续停留，满 600ms 才成对发 impression/dwell。
 *
 * 不用常驻 interval：只有进入可计时状态才排一个 600ms 定时器，隐藏、关闭或销毁时取消。
 * 每个 itemId+revision 成功结算一次；发送失败不回调 onRead，也不自动循环重试，
 * 等用户再次看到这条时才允许重新计时。
 */

const DWELL_MIN_MS = 600;

function documentVisible(doc) {
  if (!doc) return true;
  return doc.visibilityState !== 'hidden';
}

function keyOf(item) {
  return `${item.itemId}:${item.revision}`;
}

/**
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {typeof IntersectionObserver} [options.IntersectionObserver]
 * @param {(signals: object[]) => Promise<any>} [options.sendSignals]
 * @param {(itemId: string, revision: number) => void} [options.onRead]
 * @param {() => number} [options.now]
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 */
export function createFeedReadTracker({
  document: doc = globalThis.document,
  IntersectionObserver: Observer = globalThis.IntersectionObserver,
  sendSignals,
  onRead,
  now = Date.now,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (typeof sendSignals !== 'function') throw new TypeError('createFeedReadTracker 需要 sendSignals');

  const entries = new Map();
  const settled = new Set();
  let observer = null;
  let active = true;
  let destroyed = false;
  let eventSeq = 0;
  let session = 0;

  function newEventId() {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      try {
        return cryptoObj.randomUUID();
      } catch {
        // 某些内嵌 WebView 在非安全上下文里会抛错，落到下面的本地 ID。
      }
    }
    eventSeq += 1;
    return `feed-${now().toString(36)}-${eventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function canCount(entry) {
    return (
      !destroyed &&
      active &&
      documentVisible(doc) &&
      entry.element?.isConnected === true &&
      entry.visible &&
      entry.ready &&
      !settled.has(keyOf(entry.item))
    );
  }

  function cancel(entry) {
    if (entry.timer !== null) {
      clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    entry.startedAt = null;
  }

  function settle(entry) {
    if (destroyed || !canCount(entry)) return;
    const item = entry.item;
    const key = keyOf(item);
    if (settled.has(key)) return;

    settled.add(key);
    const settleSession = session;
    const startedAt = entry.startedAt;
    entry.startedAt = null;
    entry.timer = null;
    const at = new Date(now()).toISOString();
    const elapsed = startedAt === null ? DWELL_MIN_MS : now() - startedAt;
    const value = Math.max(DWELL_MIN_MS, Math.round(elapsed));
    const base = { itemId: item.itemId };
    const context = entry.context || {};
    if (typeof context.slateId === 'string' && context.slateId) base.slateId = context.slateId;
    if (typeof context.position === 'number' && Number.isFinite(context.position)) {
      base.position = context.position;
    }

    const signals = [
      { eventId: newEventId(), ...base, type: 'impression', at },
      { eventId: newEventId(), ...base, type: 'dwell', at, value },
    ];

    Promise.resolve()
      .then(() => sendSignals(signals))
      .then((result) => {
        if (destroyed || settleSession !== session) return;
        // 服务端只收下部分信号时不算已读，也不立刻重排；下次重新可见再试。
        if (result && typeof result.accepted === 'number' && result.accepted < signals.length) {
          settled.delete(key);
          return;
        }
        if (typeof onRead !== 'function') return;
        try {
          onRead(item.itemId, item.revision);
        } catch {
          // onRead 是界面回调，出错不能影响后续条目计时。
        }
      })
      .catch(() => {
        // 失败不伪装已读，也不立刻重排；下次重新可见时才可能再试。
        if (settleSession === session) settled.delete(key);
      });
  }

  function schedule(entry) {
    if (!canCount(entry) || entry.timer !== null) return;
    entry.startedAt = now();
    entry.timer = setTimeoutFn(() => {
      entry.timer = null;
      settle(entry);
    }, DWELL_MIN_MS);
  }

  function scheduleAll() {
    for (const entry of entries.values()) schedule(entry);
  }

  function cancelAll() {
    for (const entry of entries.values()) cancel(entry);
  }

  function ensureObserver() {
    if (observer || typeof Observer !== 'function') return observer;
    try {
      observer = new Observer(
        (records) => {
          if (destroyed) return;
          for (const record of records) {
            const entry = entries.get(record.target);
            if (!entry) continue;
            if (entry.element.isConnected === true) entry.wasConnected = true;
            const visible = record.isIntersecting === true;
            if (visible === entry.visible) {
              if (visible) schedule(entry);
              continue;
            }
            entry.visible = visible;
            if (visible) schedule(entry);
            else cancel(entry);
          }
        },
        { threshold: 0 }
      );
    } catch {
      observer = null;
    }
    return observer;
  }

  function onVisibilityChange() {
    if (destroyed) return;
    if (!documentVisible(doc)) cancelAll();
    else scheduleAll();
  }

  /** 只清理确实曾连接文档、之后又脱离的旧卡；新批次尚未挂载的卡先保留。 */
  function pruneDetached() {
    for (const [element, entry] of entries) {
      if (!element) continue;
      if (element.isConnected === true) {
        entry.wasConnected = true;
        continue;
      }
      if (element.isConnected !== false || !entry.wasConnected) continue;
      cancel(entry);
      entries.delete(element);
      observer?.unobserve?.(element);
    }
  }

  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  function unobserve(element) {
    const entry = entries.get(element);
    if (!entry) return;
    cancel(entry);
    entries.delete(element);
    observer?.unobserve?.(element);
  }

  function observe(element, item, context = {}) {
    if (destroyed || !element || !item || typeof item.itemId !== 'string') return;
    pruneDetached();
    const existing = entries.get(element);
    if (existing) {
      if (existing.item.itemId === item.itemId && existing.item.revision === item.revision) {
        existing.item = { itemId: item.itemId, revision: item.revision };
        existing.context = context || {};
        return;
      }
      cancel(existing);
      entries.delete(element);
      observer?.unobserve?.(element);
    }
    const entry = {
      element,
      item: { itemId: item.itemId, revision: item.revision },
      context: context || {},
      visible: false,
      ready: false,
      wasConnected: element.isConnected === true,
      timer: null,
      startedAt: null,
    };
    entries.set(element, entry);
    ensureObserver()?.observe(element);
  }

  function markReady(itemId, revision) {
    if (destroyed) return;
    for (const entry of entries.values()) {
      if (entry.item.itemId !== itemId || entry.item.revision !== revision) continue;
      if (entry.element.isConnected === true) entry.wasConnected = true;
      entry.ready = true;
      schedule(entry);
    }
  }

  function setActive(value) {
    if (destroyed) return;
    const next = Boolean(value);
    if (active === next) return;
    active = next;
    if (active) scheduleAll();
    else cancelAll();
  }

  function reset() {
    session += 1;
    cancelAll();
    entries.clear();
    settled.clear();
    observer?.disconnect?.();
    observer = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    session += 1;
    cancelAll();
    entries.clear();
    settled.clear();
    observer?.disconnect?.();
    observer = null;
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
  }

  return { observe, unobserve, markReady, setActive, reset, destroy };
}
