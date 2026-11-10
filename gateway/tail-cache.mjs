/**
 * 会话尾部缓存（tail cache）
 * ---------------------------
 * 为什么要有它：手机上冷开一个长会话，最贵的一步是
 * `GET /api/sessions/messages?sessionId=..&path=..&limit=50`——上游要把 transcript 读全、
 * 投影成 messages/blocks 再序列化，实测 3.4 秒。而这一条请求在息屏恢复、切前后台、
 * 断线重连之后会被原样重复打好几次，每次都要等满整条链路。它要的东西是「最近 50 条」，
 * 几十秒内的重复请求拿同一份内容完全够用。
 *
 * 所以这里只做一件事：按 (Cookie 身份, sessionId, limit) 把这一条接口的响应体存住。
 * 新鲜窗口内直接回缓存；陈旧窗口内先回旧内容，再由调用方在后台刷新一次。
 * 不碰 HTTP：哪些请求能进、怎么取怎么存、什么时候淘汰，全是纯函数和纯内存状态，
 * 单测能直接跑（`node tests/tail_cache.test.mjs`），不需要网络也不需要文件系统。
 *
 * 判定规则（tests/tail_cache.test.mjs 逐条覆盖，改这里必须同步改那边）：
 *   1. 只认 `GET`；路径必须正好是 `/api/sessions/messages`。结尾斜杠、大小写、
 *      百分号编码、带 `?` 的整串都不算——认不出就不缓存，宁可慢一次也不误命中。
 *   2. query 必须有非空 `sessionId`；`limit` 缺省按 50，写出来时只接受 1..200 的
 *      十进制正整数（`0`、`-1`、`1.5`、`1e2`、`201`、空值都不进缓存）。
 *      `limit` 用数值归一：`050` 与 `50` 是同一个 key（对上游也是同一个 limit）。
 *   3. query 里出现任何分页游标——`before` / `after` / `cursor` / `offset` / `until` /
 *      `maxId` / `minId` / `anchor`，大小写不敏感，出现即拒（值写成空也算出现）——
 *      不进缓存。翻历史有自己的路径和自己的游标，绝不能让「尾部」的缓存把两页搅在一起。
 *   4. `get` 的判定以注入时钟为准：`now - storedAt <= freshMs` → fresh；
 *      `<= maxStaleMs` → stale；再旧就是 miss，并把这条删掉——它已经服务不了任何请求，
 *      留着只会占字节、把真正有用的条目挤出去。
 *   5. 淘汰按 LRU：超过 `maxEntries` 或累计字节超过 `maxTotalBytes` 时从最久未访问的
 *      删起，`get` 与 `set` 都算访问（Map 的插入顺序就是新旧顺序，命中时删了再塞回尾）。
 *      `hits` / `staleHits` 只在命中时加，miss 单独计。
 *   6. `beginRefresh` 用 Set 记「正在刷新」的 key，同一 key 已在刷返回 false；`endRefresh`
 *      清掉；`invalidate` 同时清刷新标记——不然一个被作废的 key 会永远停在「正在刷新」，
 *      后台刷新永远起不来。
 *   7. 不存 header 全集，只存可选 `etag`：调用方以后要用它和上游对账（304 短路），
 *      存整个 header 表等于把上游的偶发头、过期日期一起冻在这儿。
 *
 * 调用方（接线侧）必须知道的边界：
 *   - `get` 返回的 `entry` 是**冻结的只读快照**。`set` 从不改写已有的 entry 对象，只把
 *     Map 里的引用换掉，所以「stale 期间拿到的那份 entry」在后续 `set` 之后仍然指向旧
 *     内容，不会被新内容串改（可以被安全地异步写回响应）。`entry.body` 是与缓存共享的
 *     Buffer，属于只读约定：调用方要改就自己 copy。
 *   - 这里不判断 body 是不是合法 JSON、是不是 200：那是接线侧的事。只有确实要缓存的
 *     成功响应才该调 `set`；错误体、登录页 HTML、304 空体都不该进来。
 *   - 会话来了新消息、被删除、切了分支时，接线侧必须自己 `invalidate(key)`：网关没有
 *     上游推送，这里无从知道内容已经变了。
 *   - 判定函数两处都能拿到：模块级 `isTailRequest` / `parseTailRequest`，以及实例上的
 *     `cache.isTailRequest` / `cache.parseTailRequest`（接线层手里往往只有实例）。
 *     是同一对函数，不另存状态，因此无论从哪边问，答案必然一致。
 */

import { createHash } from 'node:crypto';

/** 新鲜窗口：这段时间内直接回缓存，一个上游请求都不发。 */
export const DEFAULT_FRESH_MS = 30_000;
/** 陈旧窗口：这段时间内先回旧内容、后台刷新；超过它就当没有。 */
export const DEFAULT_MAX_STALE_MS = 10 * 60_000;
/** 条目数上限：会话数由用户决定，不封顶就是一条内存增长路径。 */
export const DEFAULT_MAX_ENTRIES = 64;
/** 全部条目 body 的字节上限。 */
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** 单条 body 上限：50 条消息正常 100KB 上下，2MB 已经很宽松。 */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 精确路径：`/api/sessions/messages/x`、`/api/sessions/messages/` 都不算。 */
export const TAIL_PATH = '/api/sessions/messages';

/** `limit` 缺省值：与 web/history-pager.js、app.js 发的一致。 */
export const DEFAULT_TAIL_LIMIT = 50;
/** 上游允许的最大页大小；再大就是调用方拼错了。 */
export const MAX_TAIL_LIMIT = 200;

/**
 * 分页游标参数名（小写）。出现任何一个就说明这是一次翻历史，
 * 尾部缓存不参与——它只缓存「最近一页」。
 */
const CURSOR_PARAM_NAMES = new Set([
  'before',
  'after',
  'cursor',
  'offset',
  'until',
  'maxid',
  'minid',
  'anchor',
]);

/** 同一个参数出现多次时按「全部值」判断：`URLSearchParams` 的 getAll。 */
function valuesOf(query, name) {
  if (typeof query?.getAll === 'function') return query.getAll(name);
  const single = query?.get?.(name);
  return single == null ? [] : [single];
}

/** 重复参数值不一致：谁在前谁生效取决于上游实现，这种请求不该被缓存。 */
function isAmbiguous(values) {
  return values.length > 1 && new Set(values).size > 1;
}

/**
 * 把一条请求解析成「能不能进缓存 + 进缓存的参数的归一值」。
 *
 * `isTailRequest` 只是它的布尔投影：接线侧要拼 key，就得拿到与判定完全同一份
 * `sessionId` / `limit`，两处各写一遍解析迟早会写漂（比如一处按 50 缺省、另一处按
 * 上游缺省），那时缓存会对不上号。
 *
 * @param {string} method  原始请求方法，必须是 `GET`
 * @param {string} urlPath 已解析的 pathname（不带 `?`）
 * @param {URLSearchParams} query 这个请求自己的 query
 * @returns {{ ok: true, sessionId: string, limit: number }
 *          | { ok: false, reason: string }} reason 只用于日志/诊断，不是契约
 */
export function parseTailRequest(method, urlPath, query) {
  // 规则 1：只认 GET。HEAD 没有 body，大写以外的写法不是 HTTP 里的 GET。
  if (method !== 'GET') return { ok: false, reason: 'method' };
  if (urlPath !== TAIL_PATH) return { ok: false, reason: 'path' };
  if (!query || typeof query.get !== 'function' || typeof query.keys !== 'function') {
    return { ok: false, reason: 'query' };
  }

  // 规则 3：游标先判——带游标就是翻历史，后面 sessionId/limit 合不合法都无所谓。
  for (const name of query.keys()) {
    if (CURSOR_PARAM_NAMES.has(String(name).toLowerCase())) {
      return { ok: false, reason: 'cursor' };
    }
  }

  // 规则 2：sessionId 必填，空串/纯空白都当没填。空白 id 不可能是真会话，
  // 放进来只会白白占一个 key。
  const sessionIds = valuesOf(query, 'sessionId');
  if (sessionIds.length === 0) return { ok: false, reason: 'no_session' };
  if (isAmbiguous(sessionIds)) return { ok: false, reason: 'ambiguous_session' };
  const sessionId = sessionIds[0];
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return { ok: false, reason: 'bad_session' };
  }

  // 规则 2 续：limit 缺省 50；写出来就必须是 1..200 的十进制正整数。
  // 只收纯数字串，`+50`、` 50`、`50.0`、`1e2` 都不认——上游对它们的解释未必一样。
  const limits = valuesOf(query, 'limit');
  if (isAmbiguous(limits)) return { ok: false, reason: 'ambiguous_limit' };
  let limit = DEFAULT_TAIL_LIMIT;
  if (limits.length > 0) {
    const raw = limits[0];
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
      return { ok: false, reason: 'bad_limit' };
    }
    limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TAIL_LIMIT) {
      return { ok: false, reason: 'bad_limit' };
    }
  }

  return { ok: true, sessionId, limit };
}

/**
 * 这个请求该不该进缓存：只看得到 method/url，不解析 body（GET 也没有 body）。
 * 签名是接线契约，返回布尔；要拿归一后的 sessionId/limit 用 `parseTailRequest`。
 */
export function isTailRequest(method, urlPath, query) {
  return parseTailRequest(method, urlPath, query).ok;
}

/**
 * 建一个尾部缓存。
 *
 * @param {object} [options]
 * @param {number} [options.freshMs]      新鲜窗口
 * @param {number} [options.maxStaleMs]   陈旧窗口上限（必须 >= freshMs 才有意义）
 * @param {number} [options.maxEntries]   条目数上限
 * @param {number} [options.maxTotalBytes] 总字节上限
 * @param {number} [options.maxBodyBytes] 单条 body 上限
 * @param {Function} [options.now]        时间源，测试注入；只在 get/set 里读
 */
export function createTailCache({
  freshMs = DEFAULT_FRESH_MS,
  maxStaleMs = DEFAULT_MAX_STALE_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = () => Date.now(),
} = {}) {
  /** key -> { key, body, etag, storedAt, bytes }。Map 的插入顺序 = LRU 顺序，尾部最新。 */
  const entries = new Map();
  /** 正在后台刷新的 key。Set 而不是挂在 entry 上：key 失效重存后刷新仍应互斥。 */
  const refreshing = new Set();

  let totalBytes = 0;
  let hits = 0;
  let staleHits = 0;
  let misses = 0;
  let stores = 0;
  let evictions = 0;

  /**
   * 缓存键。用 JSON 数组拼料，避免 `a\nb` 与 `a\nb\n` 这类分隔符撞车
   * （sessionId 里什么字符都可能有）。sha256 取前 16 hex：64 位，
   * 对 64 条量级的表来说碰撞概率可以完全忽略，也足够短、便于日志。
   */
  function key(cookieHash, sessionId, limit) {
    const material = JSON.stringify([
      String(cookieHash ?? ''),
      String(sessionId ?? ''),
      String(limit),
    ]);
    return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  }

  /** 命中即「访问」：删了再塞回尾部，Map 的顺序就变成 LRU 顺序。 */
  function touch(entryKey) {
    const entry = entries.get(entryKey);
    if (!entry) return;
    entries.delete(entryKey);
    entries.set(entryKey, entry);
  }

  /** 删一条并把字节从预算里退回。返回是否真的删掉了。 */
  function drop(entryKey) {
    const entry = entries.get(entryKey);
    if (!entry) return false;
    entries.delete(entryKey);
    totalBytes -= entry.bytes;
    return true;
  }

  /**
   * 规则 5：容量淘汰。从最久未访问的删起，直到条数与字节都回到预算内。
   * 至少保留刚写入的那一条：如果连单条都超过 `maxTotalBytes`（配置错了），
   * 淘汰自己再淘汰别人只会变成空转，`set` 那边已经先把它拒了，这里只兜底。
   */
  function evict() {
    while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
      if (entries.size <= 1) break;
      const oldest = entries.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
      evictions += 1;
    }
  }

  /**
   * 查一条。
   * @returns {{ state: 'fresh'|'stale', entry: object } | { state: 'miss' }}
   */
  function get(entryKey) {
    const entry = typeof entryKey === 'string' ? entries.get(entryKey) : undefined;
    if (!entry) {
      misses += 1;
      return { state: 'miss' };
    }

    // 规则 4：窗口判定只看注入时钟。时钟回拨（age < 0）算新鲜：宁可多回一次旧内容，
    // 也不该在时间源抖动时把整表清空。
    const age = now() - entry.storedAt;
    if (age <= freshMs) {
      hits += 1;
      touch(entryKey);
      return { state: 'fresh', entry };
    }
    if (age <= maxStaleMs) {
      staleHits += 1;
      touch(entryKey);
      return { state: 'stale', entry };
    }

    drop(entryKey);
    misses += 1;
    return { state: 'miss' };
  }

  /**
   * 存一条。`body` 是 Buffer 或字符串（按 UTF-8 转 Buffer）。
   * 返回 false 表示**没进缓存**：空 body、超过 `maxBodyBytes`、或者超过整个
   * `maxTotalBytes` 预算（存进去也会被自己挤掉，不如直接说存不下）。调用方可以忽略
   * 返回值——缓存不进只是慢，不是错。
   */
  function set(entryKey, body, { etag = '' } = {}) {
    if (typeof entryKey !== 'string' || !entryKey) return false;

    let buffer;
    if (Buffer.isBuffer(body)) buffer = body;
    else if (typeof body === 'string') buffer = Buffer.from(body, 'utf8');
    else return false;

    const size = buffer.length;
    if (size === 0) return false;
    if (size > maxBodyBytes) return false;
    if (size > maxTotalBytes) return false;

    // 覆盖旧值：先把旧字节退回预算，否则同一 key 反复 set 会把预算越吃越小。
    drop(entryKey);

    // 新的 entry 对象，绝不改写旧的：旧指针可能正被一个 async 写回到响应里。
    const entry = Object.freeze({
      key: entryKey,
      body: buffer,
      etag: typeof etag === 'string' ? etag : '',
      storedAt: now(),
      bytes: size,
    });
    entries.set(entryKey, entry);
    totalBytes += size;
    stores += 1;
    evict();
    return true;
  }

  /** 规则 6：同一 key 只允许一个后台刷新在跑；返回 false 表示已在刷，别重复起。 */
  function beginRefresh(entryKey) {
    if (typeof entryKey !== 'string' || !entryKey) return false;
    if (refreshing.has(entryKey)) return false;
    refreshing.add(entryKey);
    return true;
  }

  function endRefresh(entryKey) {
    refreshing.delete(entryKey);
  }

  /**
   * 作废一条（会话有新消息、被删、切分支时由接线侧调用）。
   * 返回 true 表示确实删掉了缓存条目；只清了刷新标记返回 false。
   */
  function invalidate(entryKey) {
    const removed = drop(entryKey);
    refreshing.delete(entryKey);
    return removed;
  }

  /** 清空内容与刷新标记。累计计数（hits/misses/…）不清：那是进程级诊断量。 */
  function clear() {
    entries.clear();
    refreshing.clear();
    totalBytes = 0;
  }

  function stats() {
    return {
      entries: entries.size,
      bytes: totalBytes,
      hits,
      staleHits,
      misses,
      stores,
      evictions,
    };
  }

  return {
    key,
    get,
    set,
    beginRefresh,
    endRefresh,
    invalidate,
    clear,
    stats,
    // 判定也从实例上给一份：网关接线层（gateway/tail-serve.mjs）拿到的只有实例，没有模块
    // 命名空间。挂的是同一对函数，不复制逻辑，所以判定和 key 永远不会两处写漂。
    isTailRequest,
    parseTailRequest,
    get size() {
      return entries.size;
    },
  };
}
