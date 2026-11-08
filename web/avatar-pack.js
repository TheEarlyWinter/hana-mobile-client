/* web/avatar-pack.js
 *
 * 头像包：一次请求取回一批头像，避免每个 `<img>` 各走一次往返。
 *
 * 为什么需要：手机端一次打开要显示 6~13 个头像，每个头像走隧道都是一次往返
 * （单程约 200ms）。把 N 次合并成 1 次，视觉上就不再「一个一个蹦」。
 *
 * 端点（网关侧的聚合接口）：`GET /api/mobile/avatars?ids=a,b,user`
 *   200 -> { avatars: { id: "data:image/png;base64,..." }, skipped: ["too-big"] }
 *
 * 这里只管缓存与去重，不碰 DOM、不碰其它 web 模块。调用方拿到 urlFor(id)
 * 的 data URL 后，照常塞进 `<img src>` 即可；没命中就退回原来的接口地址。
 */

const DEFAULT_URL = '/api/mobile/avatars';
const DEFAULT_MAX_IDS = 32;

/** 只接受非空字符串 id：别的（数字、对象、null）一律当没传，绝不抛。 */
function isUsableId(id) {
  return typeof id === 'string' && id.length > 0;
}

/** 去重且保序：请求里重复的 id 只会拉一次。 */
function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!isUsableId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 便于测试注入；默认用全局 fetch
 * @param {string} [options.url] 聚合端点
 * @param {number} [options.maxIds] 单次请求最多带几个 id（网关侧上限 32）
 */
export function createAvatarPack({ fetchImpl = null, url = DEFAULT_URL, maxIds = DEFAULT_MAX_IDS } = {}) {
  const cache = new Map();      // id -> data URL
  const inflight = new Map();   // id -> 正在进行的请求 promise（同 id 并发合并）
  const limit = Number.isFinite(maxIds) && maxIds > 0 ? Math.floor(maxIds) : DEFAULT_MAX_IDS;

  function pickFetch() {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  /** 把一次请求的结果写进缓存；坏数据逐项丢弃，不因为一条坏值丢掉整批。 */
  function absorb(payload) {
    const avatars = payload && typeof payload === 'object' ? payload.avatars : null;
    if (!avatars || typeof avatars !== 'object') return;
    for (const [id, value] of Object.entries(avatars)) {
      if (!isUsableId(id) || typeof value !== 'string' || !value) continue;
      cache.set(id, value);
    }
  }

  async function fetchChunk(ids) {
    const doFetch = pickFetch();
    if (!doFetch) return;
    const target = `${url}?ids=${encodeURIComponent(ids.join(','))}`;
    let res;
    try {
      res = await doFetch(target, { headers: { accept: 'application/json' } });
    } catch {
      return; // 网络失败就静默：调用方继续用逐张的旧地址
    }
    if (!res || !res.ok) return;
    let payload;
    try {
      payload = await res.json();
    } catch {
      return;
    }
    absorb(payload);
  }

  function runChunk(ids) {
    const promise = fetchChunk(ids).finally(() => {
      for (const id of ids) {
        if (inflight.get(id) === promise) inflight.delete(id);
      }
    });
    for (const id of ids) inflight.set(id, promise);
    return promise;
  }

  return {
    /** 预取一批头像；已在缓存或正在路上的 id 不会重复请求。永不 reject。 */
    prime(ids) {
      const wanted = uniqueIds(ids).filter((id) => !cache.has(id) && !inflight.has(id));
      if (!wanted.length) return Promise.resolve();
      const jobs = chunk(wanted, limit).map(runChunk);
      return Promise.all(jobs).then(() => undefined, () => undefined);
    },

    /** 命中返回 data URL，否则 null（调用方退回逐张地址）。 */
    urlFor(id) {
      if (!isUsableId(id)) return null;
      return cache.get(id) || null;
    },

    has(id) {
      return this.urlFor(id) !== null;
    },

    size() {
      return cache.size;
    },

    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}
