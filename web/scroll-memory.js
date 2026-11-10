/* web/scroll-memory.js — 每个会话「读到哪儿」的本地记忆
 *
 * 退出会话再进来时，消息区默认被强制贴到底（openSession → renderer.scrollToBottom(true)），
 * 用户原来读到中间也看不到了。这份记忆只做一件事：记下每个会话最后停在哪、当时是不是
 * 贴着底，下次打开时由 conversation-controller 决定恢复还是照旧贴底。
 *
 * 边界：
 *   - 纯逻辑，不摸 document / localStorage；storage 由调用方注入（浏览器里是 localStorage，
 *     测试里是假对象）。没注入或读写抛异常（隐私模式、配额满）就退化成仅内存，永不外抛；
 *   - 节流自己做：scroll 每帧都会来，不能每次 remember 都 JSON.stringify 整份记忆。
 *     首次立即写，之后同一窗口内的读数只更新内存，窗口结束时补写一次最新值；
 *     离开会话这种关键时机由调用方 flush()；
 *   - 超过 7 天或超过 50 条的记录在写入时顺手清掉；prune() 可手动触发。
 */

const DEFAULT_STORAGE_KEY = 'hana.scroll-memory.v1';
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天
const DEFAULT_THROTTLE_MS = 400;
// 与 chat-renderer 的 nearBottom() 同一个阈值：贴底判定必须和「自动滚到底」一致。
const BOTTOM_SLACK_PX = 160;

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} [options]
 * @param {{getItem: Function, setItem: Function, removeItem: Function}|null} [options.storage]
 *   持久化入口；缺失或抛异常时只保留内存记忆
 * @param {number} [options.maxEntries=50] 最多保留多少条会话记录
 * @param {number} [options.maxAgeMs] 记录最长保留多久（默认 7 天）
 * @param {number} [options.throttleMs=400] 两次落盘之间的最小间隔
 * @param {string} [options.storageKey] 落盘用的 key
 * @param {() => number} [options.now] 时钟（测试注入假时钟）
 * @param {(fn: Function, ms: number) => any} [options.schedule] 定时器
 * @param {(id: any) => void} [options.cancelSchedule] 取消定时器
 * @returns {{
 *   remember: (key: string, position: {scrollTop: number, scrollHeight: number, clientHeight: number}) => ({scrollTop: number, atBottom: boolean}|null),
 *   recall: (key: string) => ({scrollTop: number, atBottom: boolean, ts: number}|null),
 *   forget: (key: string) => boolean,
 *   list: () => Array<{key: string, scrollTop: number, atBottom: boolean, ts: number}>,
 *   prune: (at?: number) => number,
 *   flush: () => void,
 *   clearAll: () => void,
 * }}
 */
export function createScrollMemory({
  storage = null,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  throttleMs = DEFAULT_THROTTLE_MS,
  storageKey = DEFAULT_STORAGE_KEY,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = (id) => clearTimeout(id),
} = {}) {
  const limit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
  const ageLimit = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  const windowMs = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : DEFAULT_THROTTLE_MS;
  const key = typeof storageKey === 'string' && storageKey ? storageKey : DEFAULT_STORAGE_KEY;

  /** key → { key, scrollTop, atBottom, ts }；recall 永远先看这里，读数不会比 storage 旧。 */
  const cache = new Map();
  let timer = null;
  // 第一次 remember 必须立即落盘（页面可能随时被系统杀掉），所以起点是 -Infinity。
  let lastWriteAt = -Infinity;

  /* ------------------------------ 持久化 ------------------------------ */

  function readRaw() {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      return storage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeRaw(text) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(key, text);
    } catch (err) {
      // 隐私模式 / 配额满：这份记忆退化成仅内存，不影响聊天。
    }
  }

  function removeRaw() {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try {
      storage.removeItem(key);
    } catch (err) {
      // 同上，删不掉也不能把异常甩给调用方。
    }
  }

  function serialize() {
    // 数组比对象安全：会话路径里出现任何字符都不会碰到 __proto__ 这类键。
    return JSON.stringify(Array.from(cache.values()));
  }

  function persist() {
    lastWriteAt = now();
    writeRaw(serialize());
  }

  function clearTimer() {
    if (timer == null) return;
    try {
      cancelSchedule(timer);
    } catch (err) {
      // 取消失败也要把引用丢掉，否则后续永远不再补写。
    }
    timer = null;
  }

  /** 节流写：窗口外立即写；窗口内只记一个待写，窗口结束时把最新读数补上。 */
  function schedulePersist() {
    const t = now();
    if (timer == null && t - lastWriteAt >= windowMs) {
      persist();
      return;
    }
    if (timer != null) return;
    const wait = Math.max(0, windowMs - (t - lastWriteAt));
    timer = schedule(() => {
      timer = null;
      persist();
    }, wait);
  }

  /* ------------------------------ 清理 ------------------------------ */

  function trimOverflow() {
    if (cache.size <= limit) return;
    // 按时间从旧到新，丢到只剩 limit 条。
    const oldest = Array.from(cache.values()).sort((a, b) => a.ts - b.ts);
    const drop = cache.size - limit;
    for (let i = 0; i < drop; i += 1) cache.delete(oldest[i].key);
  }

  function expire(at) {
    for (const [entryKey, entry] of cache) {
      if (!(at - entry.ts <= ageLimit)) cache.delete(entryKey);
    }
  }

  /* ------------------------------ 载入 ------------------------------ */

  (function load() {
    const raw = readRaw();
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return; // 坏 JSON：当作没记过，下一次 remember 会整份覆盖
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)
        ? parsed.entries
        : null;
    if (!items) return;

    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entryKey = typeof item.key === 'string' ? item.key : '';
      if (!entryKey) continue;
      if (!Number.isFinite(item.scrollTop) || !Number.isFinite(item.ts)) continue;
      cache.set(entryKey, {
        key: entryKey,
        scrollTop: Math.max(0, item.scrollTop),
        atBottom: item.atBottom === true,
        ts: item.ts,
      });
    }
    expire(now());
    trimOverflow();
  })();

  /* ------------------------------ 对外 API ------------------------------ */

  /**
   * 记下某个会话的阅读位置。scrollTop 越界/字段缺失都不报错，坏数字按 0 算。
   * 返回真正存下的读数，方便调用方核对。
   */
  function remember(sessionKey, position) {
    if (typeof sessionKey !== 'string' || !sessionKey) return null;
    if (!position || typeof position !== 'object') return null;

    const scrollTop = Math.max(0, toFinite(position.scrollTop));
    const scrollHeight = Math.max(0, toFinite(position.scrollHeight));
    const clientHeight = Math.max(0, toFinite(position.clientHeight));
    const ts = now();
    const entry = {
      key: sessionKey,
      scrollTop,
      // 与 chat-renderer.nearBottom() 同口径：留 160px 余量，避免「差一点点」被当成没贴底。
      atBottom: scrollHeight - scrollTop - clientHeight < BOTTOM_SLACK_PX,
      ts,
    };
    cache.delete(sessionKey);
    cache.set(sessionKey, entry);
    expire(ts);
    trimOverflow();
    schedulePersist();
    return { scrollTop: entry.scrollTop, atBottom: entry.atBottom };
  }

  function recall(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey) return null;
    const entry = cache.get(sessionKey);
    if (!entry) return null;
    return { scrollTop: entry.scrollTop, atBottom: entry.atBottom, ts: entry.ts };
  }

  function forget(sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey) return false;
    const existed = cache.delete(sessionKey);
    if (existed) {
      clearTimer();
      persist();
    }
    return existed;
  }

  function list() {
    return Array.from(cache.values())
      .sort((a, b) => b.ts - a.ts)
      .map((entry) => ({ ...entry }));
  }

  /** 清掉过期与超量的记录，返回删了几条。 */
  function prune(at = now()) {
    const before = cache.size;
    expire(Number.isFinite(at) ? at : now());
    trimOverflow();
    if (cache.size !== before) persist();
    return before - cache.size;
  }

  /** 把待写的读数立刻落盘（离开会话 / 切会话时用，别等节流窗口）。 */
  function flush() {
    clearTimer();
    persist();
  }

  /** 换账号 / 退出登录：内存与 storage 一起清，待写定时器一并收掉。 */
  function clearAll() {
    cache.clear();
    clearTimer();
    removeRaw();
  }

  return { remember, recall, forget, list, prune, flush, clearAll };
}
