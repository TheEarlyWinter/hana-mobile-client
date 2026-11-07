/* web/draft-store.js
 *
 * 会话草稿的本地存取（B2 地基模块，纯逻辑、不碰 DOM）。
 *
 * 管什么：
 * 1. save / get / clear / list：按会话 key 存一段草稿文本，空文本等于删除；
 * 2. 容量：单条 32 KiB，总量 256 KiB。超量时先丢最旧的，再丢最大的；
 * 3. prune()：清掉超期草稿（默认 7 天）并压回预算；
 * 4. 任何 storage 异常、任何脏数据都不往外抛——草稿丢了顶多让用户重打一遍，
 *    不能让整个聊天界面起不来。
 *
 * 不管什么：
 * 1. 不知道「会话 key」是怎么拼的，那是装配层的事，这里只把它当不透明字符串；
 * 2. 不做防抖、不监听 input，什么时候 save 由调用方决定；
 * 3. 不读写 DOM，不在模块顶层摸 localStorage（storage 靠注入，不传才退回 localStorage）。
 *
 * 存储布局（单键整包，便于算总预算和整体裁剪）：
 *   hana.drafts.v1 = {
 *     "version": 1,
 *     "drafts": {
 *       "<会话 key>": { "text": "……", "savedAt": 1700000000000 }
 *     }
 *   }
 *
 * 两个容易踩的点：
 *   - storage 在隐私模式下连 getItem 都会抛，setItem 还会因配额满抛，所有访问都包了 try；
 *   - 写不下（单条超限 / 整包超预算）时宁可把该 key 清空，也不能留一版旧草稿冒充当前内容，
 *     否则用户重进会话会看见一段自己没写的文字，甚至误发出去。
 */

/** 整包草稿的存储键（前缀 hana.，和 hana.chatViewMode 等保持一致）。 */
export const DRAFT_STORAGE_KEY = 'hana.drafts.v1';

/** 单条草稿上限：32 KiB。 */
export const DEFAULT_MAX_DRAFT_BYTES = 32 * 1024;

/** 所有草稿加起来的总预算：256 KiB。 */
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;

/** 草稿保留时长：7 天。 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** 按 UTF-8 算字节数；极老的运行环境没有 TextEncoder 时按字符数兜底。 */
function byteLength(text) {
  if (typeof text !== 'string') return 0;
  if (encoder) return encoder.encode(text).length;
  return text.length;
}

/** 内存版 storage：localStorage 不可用时的兜底，保证本次会话内行为一致。 */
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
    // 没有 removeItem 的 storage（比如最简的内存桩）退而求其次写空串
    store.setItem(key, '');
    return true;
  } catch {
    return false;
  }
}

function normalizeLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 建一个草稿库。
 *
 * @param {object} [options]
 * @param {{ getItem: Function, setItem: Function, removeItem?: Function }} [options.storage] 存储后端，测试可注入假 storage
 * @param {() => number} [options.now] 当前时间（毫秒），测试可注入假时钟
 * @param {number} [options.maxBytes] 总预算，默认 256 KiB
 * @param {number} [options.maxEntryBytes] 单条上限，默认 32 KiB
 * @param {number} [options.ttlMs] 保留时长，默认 7 天
 * @returns {{
 *   save: (key: string, text: string) => { ok: boolean, reason: string | null },
 *   get: (key: string) => string,
 *   clear: (key: string) => boolean,
 *   list: () => Array<{ key: string, text: string, savedAt: number }>,
 *   prune: () => { removed: number, remaining: number },
 * }}
 */
export function createDraftStore({
  storage,
  now = Date.now,
  maxBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxEntryBytes = DEFAULT_MAX_DRAFT_BYTES,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const store = resolveStorage(storage);
  const clock = typeof now === 'function' ? now : Date.now;
  const budget = normalizeLimit(maxBytes, DEFAULT_MAX_TOTAL_BYTES);
  const entryLimit = normalizeLimit(maxEntryBytes, DEFAULT_MAX_DRAFT_BYTES);
  const ttl = normalizeLimit(ttlMs, DEFAULT_TTL_MS);

  /** @type {Map<string, { text: string, savedAt: number }>} */
  const drafts = new Map();

  /** 序列化口径与 persist 完全一致，算预算和落盘不能有两套标准。 */
  function serialize() {
    if (drafts.size === 0) return '';
    // 用 null 原型，避免 __proto__ 之类的 key 把对象原型改掉
    const container = Object.create(null);
    for (const [key, value] of drafts) {
      container[key] = { text: value.text, savedAt: value.savedAt };
    }
    const payload = Object.create(null);
    payload.version = 1;
    payload.drafts = container;
    try {
      return JSON.stringify(payload);
    } catch {
      return '';
    }
  }

  /** 当前整包占的字节数；空库算 0（空库不占存储键）。 */
  function totalBytes() {
    const raw = serialize();
    return raw === '' ? 0 : byteLength(raw);
  }

  /** 落盘；写不进去只返回 false，不影响内存状态。 */
  function persist() {
    if (drafts.size === 0) return safeRemoveItem(store, DRAFT_STORAGE_KEY);
    const raw = serialize();
    if (raw === '') return false;
    try {
      store.setItem(DRAFT_STORAGE_KEY, raw);
      return true;
    } catch {
      return false;
    }
  }

  /** 清掉存储里的脏数据。 */
  function wipe() {
    drafts.clear();
    safeRemoveItem(store, DRAFT_STORAGE_KEY);
  }

  /**
   * 压回预算：先按 savedAt 从旧到新丢，只剩一条还放不下时再丢最大（也就是这一条）。
   * @returns {number} 被丢掉的数量
   */
  function trim() {
    let removed = 0;

    // 阶段一：先丢最旧的，至少给最新的一条留个机会
    while (drafts.size > 1 && totalBytes() > budget) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, value] of drafts) {
        if (value.savedAt < oldestAt) {
          oldestAt = value.savedAt;
          oldestKey = key;
        }
      }
      if (oldestKey == null) break;
      drafts.delete(oldestKey);
      removed += 1;
    }

    // 阶段二：只剩一条还超预算，就丢最大的
    while (drafts.size > 0 && totalBytes() > budget) {
      let largestKey = null;
      let largestBytes = -1;
      for (const [key, value] of drafts) {
        const size = byteLength(value.text);
        if (size > largestBytes) {
          largestBytes = size;
          largestKey = key;
        }
      }
      if (largestKey == null) break;
      drafts.delete(largestKey);
      removed += 1;
    }

    return removed;
  }

  /** 从存储恢复；脏数据一律丢弃并清键，绝不让首屏因此崩掉。 */
  function load() {
    const raw = safeGetItem(store, DRAFT_STORAGE_KEY);
    if (raw == null || raw === '') return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      wipe();
      return;
    }

    const field =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.drafts : null;
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      wipe();
      return;
    }

    const nowTs = clock();
    let dropped = false;

    for (const [key, value] of Object.entries(field)) {
      if (typeof key !== 'string' || key.trim() === '') {
        dropped = true;
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        dropped = true;
        continue;
      }
      const { text, savedAt } = value;
      if (typeof text !== 'string' || !Number.isFinite(savedAt)) {
        dropped = true;
        continue;
      }
      if (nowTs - savedAt > ttl) {
        // 陈年草稿：首屏恢复时不该翻出来
        dropped = true;
        continue;
      }
      drafts.set(key, { text, savedAt });
    }

    // 载入时就压回预算，避免上一版留下的超量包一直撑着
    if (trim() > 0) dropped = true;
    if (dropped) persist();
  }

  /**
   * 存一条草稿。空文本（含纯空白）等于删除。
   * @returns {{ ok: boolean, reason: string | null }} reason: 'bad-key' | 'too-large' | 'over-budget' | 'write-failed'
   */
  function save(key, text) {
    const name = typeof key === 'string' && key.trim() !== '' ? key : '';
    if (!name) return { ok: false, reason: 'bad-key' };

    const value = typeof text === 'string' ? text : '';

    if (value.trim() === '') {
      const existed = drafts.delete(name);
      if (existed) persist();
      return { ok: true, reason: null };
    }

    if (byteLength(value) > entryLimit) {
      // 写不下这么长的草稿：宁可空着，也不能让旧版本冒充当前内容
      const existed = drafts.delete(name);
      if (existed) persist();
      return { ok: false, reason: 'too-large' };
    }

    // 先删再插，让 Map 的插入顺序跟着保存顺序走
    drafts.delete(name);
    drafts.set(name, { text: value, savedAt: clock() });
    trim();

    if (!drafts.has(name)) {
      persist();
      return { ok: false, reason: 'over-budget' };
    }

    const written = persist();
    return written ? { ok: true, reason: null } : { ok: false, reason: 'write-failed' };
  }

  /** 读一条草稿；没有就是空字符串。 */
  function get(key) {
    const name = typeof key === 'string' ? key : '';
    if (!name) return '';
    const found = drafts.get(name);
    return found ? found.text : '';
  }

  /** 删一条草稿；返回是否真的删掉了东西。 */
  function clear(key) {
    const name = typeof key === 'string' ? key : '';
    if (!name) return false;
    const existed = drafts.delete(name);
    if (existed) persist();
    return existed;
  }

  /** 所有草稿的快照，按 savedAt 倒序（同一毫秒按 key 排序，保证顺序稳定）。 */
  function list() {
    const out = [];
    for (const [key, value] of drafts) {
      out.push({ key, text: value.text, savedAt: value.savedAt });
    }
    out.sort((a, b) => {
      if (b.savedAt !== a.savedAt) return b.savedAt - a.savedAt;
      if (a.key === b.key) return 0;
      return a.key < b.key ? -1 : 1;
    });
    return out;
  }

  /**
   * 清理超期与超量条目。首屏或定时调一次即可。
   * @returns {{ removed: number, remaining: number }}
   */
  function prune() {
    const nowTs = clock();
    let removed = 0;

    for (const [key, value] of [...drafts]) {
      if (nowTs - value.savedAt > ttl) {
        drafts.delete(key);
        removed += 1;
      }
    }
    removed += trim();
    if (removed > 0) persist();

    return { removed, remaining: drafts.size };
  }

  load();

  return { save, get, clear, list, prune };
}
