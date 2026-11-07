/* web/outbox.js
 *
 * 待发送队列（B2 地基模块，纯逻辑、不碰 DOM）。
 *
 * **当前未接线**（2026-11-04 决定）：自动重试的前提是「发送失败就把文字从输入框拿走、
 * 改由队列持有」，而现有语义是「失败后草稿留在输入框、由用户再点一次发送」
 * （`tests/home_send_reliability.test.mjs` 锁着这条）。两者互斥，选了后者。
 * 模块与 43 条测试保留，等以后想清楚「自动重试 vs 手动重发」怎么共存再接。
 *
 * 一句话：失败的消息必须留在队列里，不能假装成功。
 *
 * 管什么：
 * 1. enqueue()：把一条要发的消息放进队列，返回稳定 id；
 * 2. flush()：按加入顺序把「到期」的条目逐条发出去，成功出队、失败记 attempts 与
 *    nextAttemptAt（指数退避）；达到 maxAttempts 后转 failed 并保留，等人工 retry；
 * 3. retry(id)：把某条重置为待发并立即尝试；
 * 4. list()：队列快照，含 status（pending / sending / failed）与 attempts；
 * 5. 落盘 + 重启恢复：换了页面、崩了 WebView，没发出去的消息还在。
 *
 * 不管什么：
 * 1. 不知道消息怎么发——send 靠注入，返回 Promise，resolve 算成功、reject 算失败；
 * 2. 不管界面怎么展示、怎么弹「重发」按钮；
 * 3. 不自己起定时器。该什么时候再 flush，看 flush() 返回的 nextDueAt / nextDueAt()，
 *    由装配层决定 setTimeout 还是等 WebSocket 重连。
 *
 * 三个容易踩的点：
 *   - flush() 单飞：跑着的时候再调必须复用同一次，否则同一条消息会被发两遍；
 *   - 重启时残留的 sending 一律回落成 pending。发送结果未知，宁可多发一次（至多一次语义
 *     不成立），也不能静默丢消息；
 *   - storage 写失败（配额满 / 隐私模式）不影响内存队列继续工作，只是这次重启会丢。
 *
 * 存储布局：
 *   hana.outbox.v1 = {
 *     "version": 1,
 *     "items": [
 *       {
 *         "id": "ob_xxx", "sessionKey": "……", "text": "……", "attachments": [],
 *         "status": "pending" | "sending" | "failed",
 *         "attempts": 1, "nextAttemptAt": 1700000000000,
 *         "createdAt": 1700000000000, "updatedAt": 1700000000000,
 *         "lastError": "network down" | null
 *       }
 *     ]
 *   }
 */

/** 队列的存储键（前缀 hana.，和 hana.drafts.v1 等保持一致）。 */
export const OUTBOX_STORAGE_KEY = 'hana.outbox.v1';

/** 默认最多尝试次数：超过就当 failed 留着等人工处理。 */
export const DEFAULT_MAX_ATTEMPTS = 6;

/** 默认退避梯度（毫秒）：1s、2s、4s、8s、16s、32s。 */
export const DEFAULT_RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000, 16000, 32000]);

/** 条目状态。sending 只在 send 的 Promise 未落定时出现，落盘后重启会回落成 pending。 */
export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  FAILED: 'failed',
});

/** flush({ wait: true }) 里最多等多少轮，纯粹防注入的 sleep 不推进时钟导致死循环。 */
const MAX_WAIT_CYCLES = 100;

/** 内存版 storage：localStorage 不可用时的兜底。 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** 不传 storage 时用 globalThis.localStorage；取不到（或被沙箱挡住）就退内存。 */
function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch {
    // 隐私模式下读 globalThis.localStorage 属性本身就会抛 SecurityError
  }
  return createMemoryStorage();
}

function safeGetItem(store, key) {
  try {
    const value = store.getItem(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function safeRemoveItem(store, key) {
  try {
    if (typeof store.removeItem === 'function') {
      store.removeItem(key);
      return true;
    }
    store.setItem(key, '');
    return true;
  } catch {
    return false;
  }
}

function normalizeDelayList(value) {
  if (!Array.isArray(value)) return [...DEFAULT_RETRY_DELAYS];
  const list = value
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .map((ms) => Math.floor(ms));
  return list.length > 0 ? list : [...DEFAULT_RETRY_DELAYS];
}

/** 附件只做浅拷贝：字符串原样带过去，对象做一层副本，避免外部改到队列里的数据。 */
function cloneAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object') continue;
    if (Array.isArray(attachment)) continue;
    out.push({ ...attachment });
  }
  return out;
}

/**
 * 建一个待发送队列。
 *
 * @param {object} options
 * @param {(payload: { id: string, sessionKey: string, text: string, attachments: object[], attempt: number }) => Promise<any>} options.send
 *        真正发送的函数：resolve 算成功（resolve(false) 或 { ok: false } 算失败），reject 算失败。
 * @param {{ getItem: Function, setItem: Function, removeItem?: Function }} [options.storage] 存储后端
 * @param {() => number} [options.now] 当前时间（毫秒）
 * @param {(ms: number) => Promise<void>} [options.sleep] 等待实现，测试可注入假 sleep
 * @param {number} [options.maxAttempts] 最多尝试次数，默认 6
 * @param {number[]} [options.retryDelays] 退避梯度（毫秒），默认 [1000, 2000, 4000, 8000, 16000, 32000]
 */
export function createOutbox({
  send,
  storage,
  now = Date.now,
  sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelays = DEFAULT_RETRY_DELAYS,
} = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createOutbox 需要注入 send 函数');
  }

  const store = resolveStorage(storage);
  const clock = typeof now === 'function' ? now : Date.now;
  const delay =
    typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attemptLimit =
    Number.isFinite(maxAttempts) && maxAttempts >= 1
      ? Math.floor(maxAttempts)
      : DEFAULT_MAX_ATTEMPTS;
  const delays = normalizeDelayList(retryDelays);

  /** @type {Array<object>} 按加入顺序保存，顺序就是发送顺序 */
  const items = [];

  /** 正在跑的那次 flush；并发调用靠它复用。 */
  let inflight = null;

  /** 同毫秒内也能拿到不同 id 的自增序号。 */
  let seq = 0;

  function makeId() {
    seq += 1;
    const stamp = Math.floor(clock()).toString(36);
    const rand = Math.random().toString(36).slice(2, 8) || '000000';
    return `ob_${stamp}_${seq.toString(36)}_${rand}`;
  }

  function findById(id) {
    for (const item of items) {
      if (item.id === id) return item;
    }
    return null;
  }

  function payloadOf(item) {
    return {
      id: item.id,
      sessionKey: item.sessionKey,
      text: item.text,
      attachments: cloneAttachments(item.attachments),
      attempt: item.attempts + 1,
    };
  }

  function snapshot(item) {
    return {
      id: item.id,
      sessionKey: item.sessionKey,
      text: item.text,
      attachments: cloneAttachments(item.attachments),
      status: item.status,
      attempts: item.attempts,
      nextAttemptAt: item.nextAttemptAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastError: item.lastError,
    };
  }

  /** 落盘；写不进去只返回 false，内存队列照常工作。 */
  function persist() {
    if (items.length === 0) return safeRemoveItem(store, OUTBOX_STORAGE_KEY);
    const payload = {
      version: 1,
      items: items.map((item) => ({
        id: item.id,
        sessionKey: item.sessionKey,
        text: item.text,
        attachments: item.attachments,
        status: item.status,
        attempts: item.attempts,
        nextAttemptAt: item.nextAttemptAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastError: item.lastError,
      })),
    };
    try {
      store.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function wipe() {
    items.length = 0;
    safeRemoveItem(store, OUTBOX_STORAGE_KEY);
  }

  /** 校验一条从存储读回来的条目；结构不对就返回 null（只丢这一条）。 */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || raw.id === '') return null;
    // 文本都读不出来这条就没法重发，留着只会一直失败
    if (typeof raw.text !== 'string') return null;

    // 重启时 sending 一律回落成 pending：发送结果未知，宁可多发一次也不能丢
    const status = raw.status === OUTBOX_STATUS.FAILED ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING;

    return {
      id: raw.id,
      sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey : '',
      text: raw.text,
      attachments: cloneAttachments(raw.attachments),
      status,
      attempts: Number.isFinite(raw.attempts) && raw.attempts > 0 ? Math.floor(raw.attempts) : 0,
      nextAttemptAt:
        Number.isFinite(raw.nextAttemptAt) && raw.nextAttemptAt > 0 ? raw.nextAttemptAt : 0,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : clock(),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : clock(),
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    };
  }

  function load() {
    const raw = safeGetItem(store, OUTBOX_STORAGE_KEY);
    if (raw == null || raw === '') return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      wipe();
      return;
    }

    const field =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.items : null;
    if (!Array.isArray(field)) {
      wipe();
      return;
    }

    const seen = new Set();
    let dropped = false;
    for (const entry of field) {
      const item = normalizeItem(entry);
      if (!item || seen.has(item.id)) {
        dropped = true;
        continue;
      }
      seen.add(item.id);
      items.push(item);
    }
    if (dropped) persist();
  }

  /** 第 n 次失败后该等多久；超出梯度长度就按最后一档。 */
  function delayFor(attempts) {
    if (delays.length === 0) return 0;
    const index = Math.min(Math.max(attempts - 1, 0), delays.length - 1);
    return delays[index] || 0;
  }

  /** 下一条「现在就能发」的条目；不到期的不动，避免队头阻塞。 */
  function pickDue() {
    const nowTs = clock();
    for (const item of items) {
      if (item.status === OUTBOX_STATUS.PENDING && item.nextAttemptAt <= nowTs) return item;
    }
    return null;
  }

  /** 最早一条待发条目的可发时间；没有待发条目就是 null。 */
  function nextDueAt() {
    let best = null;
    for (const item of items) {
      if (item.status !== OUTBOX_STATUS.PENDING) continue;
      if (best == null || item.nextAttemptAt < best) best = item.nextAttemptAt;
    }
    return best;
  }

  /**
   * 发一次。成功出队，失败记退避；返回 'sent' | 'retry' | 'gave-up'。
   * 状态在 await 之前就置成 sending，所以同一实例内不会重复发同一条。
   */
  async function attempt(item) {
    item.status = OUTBOX_STATUS.SENDING;
    item.updatedAt = clock();
    persist();

    let ok = false;
    let error = null;
    try {
      const result = await send(payloadOf(item));
      // 有的发送函数用 resolve(false) / { ok: false } 表示失败，这两种都不能算成功
      if (result === false) {
        error = 'send-rejected';
      } else if (result && typeof result === 'object' && result.ok === false) {
        error = result.error == null ? 'send-rejected' : String(result.error);
      } else {
        ok = true;
      }
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }

    if (ok) {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      persist();
      return 'sent';
    }

    item.attempts += 1;
    item.lastError = String(error == null ? '发送失败' : error).slice(0, 200) || '发送失败';
    item.updatedAt = clock();

    if (item.attempts >= attemptLimit) {
      item.status = OUTBOX_STATUS.FAILED;
      item.nextAttemptAt = 0; // 不再自动重试，等 retry()
    } else {
      item.status = OUTBOX_STATUS.PENDING;
      item.nextAttemptAt = clock() + delayFor(item.attempts);
    }
    persist();
    return item.status === OUTBOX_STATUS.FAILED ? 'gave-up' : 'retry';
  }

  async function runFlush(wait) {
    const sent = [];
    const failed = [];
    let waitCycles = 0;

    for (;;) {
      const item = pickDue();
      if (!item) {
        if (!wait) break;
        const due = nextDueAt();
        if (due == null) break;
        const gap = due - clock();
        if (!(gap > 0)) break; // 防御：没有可等的时间就别再转圈
        if (waitCycles >= MAX_WAIT_CYCLES) break;
        waitCycles += 1;
        await delay(gap);
        continue;
      }

      const outcome = await attempt(item);
      if (outcome === 'sent') sent.push(item.id);
      else if (outcome === 'gave-up') failed.push(item.id);
    }

    return { sent, failed, remaining: items.length, nextDueAt: nextDueAt() };
  }

  /**
   * 把队列里到期的条目按顺序发一遍。
   * 正在跑时再调会复用同一次（同一个 Promise），不会重复发送。
   *
   * @param {{ wait?: boolean }} [options] wait=true 时没到期的条目会被等（用注入的 sleep），
   *        适合「刚重连，把队列清干净」这种场景；默认只跑一趟就返回。
   * @returns {Promise<{ sent: string[], failed: string[], remaining: number, nextDueAt: number | null }>}
   */
  function flush(options = {}) {
    if (inflight) return inflight;
    const wait = Boolean(options && options.wait);
    let chained = null;
    chained = runFlush(wait).finally(() => {
      if (inflight === chained) inflight = null;
    });
    inflight = chained;
    return chained;
  }

  /**
   * 把一条消息重新放回待发并立刻尝试。
   * 注意：内部会跑一次 flush，顺带把其他到期条目也发掉。
   *
   * @param {string} id
   * @returns {Promise<{ ok: boolean, reason?: string, sent?: boolean, item?: object | null }>}
   */
  async function retry(id) {
    const item = findById(id);
    if (!item) return { ok: false, reason: 'not-found', sent: false, item: null };

    item.status = OUTBOX_STATUS.PENDING;
    item.attempts = 0;
    item.nextAttemptAt = clock();
    item.lastError = null;
    item.updatedAt = clock();
    persist();

    // 等上一轮 flush 收尾，避免这一条被两轮同时盯上
    if (inflight) {
      try {
        await inflight;
      } catch {
        // 上一轮的异常不该挡住人工重试
      }
    }
    await flush();

    const left = findById(id);
    return { ok: true, sent: left == null, item: left ? snapshot(left) : null };
  }

  /**
   * 入队一条待发消息。
   * @param {{ sessionKey?: string, text?: string, attachments?: object[] }} draft
   * @returns {string} 这条消息的稳定 id（重试、定位都用它）
   */
  function enqueue({ sessionKey = '', text = '', attachments = [] } = {}) {
    const nowTs = clock();
    let id = makeId();
    while (findById(id)) id = makeId(); // 理论上撞不上，撞了就换一个

    items.push({
      id,
      sessionKey: typeof sessionKey === 'string' ? sessionKey : String(sessionKey ?? ''),
      text: typeof text === 'string' ? text : String(text ?? ''),
      attachments: cloneAttachments(attachments),
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      nextAttemptAt: nowTs,
      createdAt: nowTs,
      updatedAt: nowTs,
      lastError: null,
    });
    persist();
    return id;
  }

  /** 队列快照（按加入顺序）。 */
  function list() {
    return items.map(snapshot);
  }

  load();

  return { enqueue, flush, retry, list, nextDueAt };
}
