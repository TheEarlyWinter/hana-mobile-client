/**
 * 头像聚合端点：`GET /api/mobile/avatars?ids=<id1>,<id2>,...,user`
 * ---------------------------------------------
 * 为什么要有它：手机端一次打开要显示 6~13 个头像，每个 `<img src="/api/agents/<id>/avatar">`
 * 都是一次独立的隧道往返（单程约 200ms），视觉上就是「头像一个一个蹦出来」。
 * 把 N 个请求压成 1 个：客户端只等一次往返，网关在上游侧本机逐个抓（回环，毫秒级）。
 *
 * 响应：200 `{ avatars: { id: "data:image/png;base64,..." }, skipped: ["too-big"] }`
 *   - 单张超过 128KB（上游原始字节）→ 进 skipped，不报错；
 *   - 整包序列化后超过 1.5MB（data URL 字节）→ 从超限的那张起剩下的都进 skipped；
 *   - 上游非 200 / content-type 不是 image/* / 超时 5s / 读失败 → 该 id 进 skipped，不影响其它 id。
 *
 * 安全边界（这是网关自己的端点，不是反代，上游鉴权不会替我们做）：
 *   - 先 `checkReadAuth(req)` 问上游登录态，不通过就用 `denyRead` 拒绝，与 `/api/sessions/new` 同一条路；
 *   - 只转发调用方的 Cookie；额外只带 `accept: image/*` 和 `user-agent`，
 *     绝不转发 `if-none-match` 之类的条件请求头（上游 304 会让这里拿不到图）；
 *   - id 只允许 `[A-Za-z0-9._:-]{1,64}`（`user` 是特例），拼不出别的上游路由；
 *     **另**：`.` 与 `..` 虽然命中这个字符集，仍然拒绝——它们会让上游把
 *     `/api/agents/../avatar` 归一化成 `/api/avatar`（路径上跳一层）。
 *     这条与契约正则字面不一致是有意的，见 parseAvatarIds。
 *
 * 缓存：进程内 `id -> { dataUrl, mime, ts }`，键里带 Cookie 身份（不同账号不串），
 * TTL 120s、最多 64 条、按 LRU 淘汰。**失败结果也存一份 `dataUrl: null`**：
 * 不存的话，一张超限/坏掉的头像会让每次开页都重新打一次上游（跳过的 id 也要回源），
 * 这一批就永远凑不齐缓存，下面「同 etag 直接 304」的短路一次也不会发生。
 * 但只缓存**确定性**失败（上游非 200 / 非图片 / 太大）：超时、连接被断、读到一半断掉
 * 是瞬时故障，缓存它们会让一次打嗝变成两分钟没头像，所以那些不缓存、下次重新试。
 * 304 判定完全基于这份缓存：缓存命中时不再发任何上游请求，只算 body 的 hash。
 *
 * 冷启动并发：`<身份哈希>\n<id>` 的在途回源会合并——页面同时开两屏、或者一次重试
 * 赶上上一次还没回来，不会让上游被同一个 id 打两遍。合并的只是「正在进行的这一次」，
 * 落定即从表里摘掉：成功已经进了上面的 LRU，失败留不留由 CACHEABLE_FAILURE_REASONS 决定。
 *
 * 纯逻辑为主（解析/序列化/缓存都能单独测），只有 `createAvatarPack` 里的
 * `requestAvatar` 碰网络，测试可注入 upstream / timeoutMs / 并发数。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { UPSTREAM } from './config.mjs';
import { etagMatches } from './etag.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';

/** 精确路径：与 server.mjs 的路由判定共用一份，避免两处写字面量写漂。 */
export const AVATAR_PACK_PATH = '/api/mobile/avatars';

/** 一次最多 32 个 id：超出是客户端拼批次拼错了，明确 400，不悄悄截断。 */
export const MAX_AVATAR_IDS = 32;
/** `user` 是用户头像的特例（走 /api/avatar/user），其余都按 agent 头像拼。 */
export const USER_AVATAR_ID = 'user';
const USER_AVATAR_PATH = '/api/avatar/user';
/** 单个 id 只允许这些字符：`/`、`?`、`..`、`%` 都进不来，拼不出别的上游路由。 */
const AVATAR_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export const AVATAR_UPSTREAM_TIMEOUT_MS = 5_000;
/** 单张上限按上游原始字节算（128KB 的图 base64 后约 171KB）。 */
export const MAX_AVATAR_BYTES = 128 * 1024;
/** 整包上限按实际要发出去的 data URL 字节算，1.5MB。 */
export const MAX_AVATAR_PACK_BYTES = 1536 * 1024;
export const AVATAR_FETCH_CONCURRENCY = 6;
export const AVATAR_CACHE_TTL_MS = 120_000;
export const AVATAR_CACHE_MAX_ENTRIES = 64;

const RESPONSE_CACHE_CONTROL = 'private, max-age=60';

/**
 * 哪些失败进缓存：只有**确定性**的失败才记（上游明确给了非 200 / 非图片 / 太大），
 * 这次不行下次也一样。记它们的原因是「跳过的 id 也要被缓存承接」：不记的话，
 * 每开一次页都会为同一张超限头像重新打一次上游，这一批永远凑不齐缓存，
 * 304 短路也就永远不成立。
 *
 * 超时、连接被断、读到一半断掉都是瞬时故障，**不**缓存：缓存它们等于把一次网络打嗝
 * 放大成两分钟没头像。下次请求重新试一遍才对。
 */
const CACHEABLE_FAILURE_REASONS = new Set(['upstream_status', 'not_image', 'too_large']);

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 `ids` 参数：逗号分隔、去空、去重保序、上限 32。
 *
 * 返回值两种：`{ ok: true, ids }` 或 `{ ok: false, status: 400, error: 'bad_ids' | 'bad_id' }`。
 * 非法 id 不静默丢弃：调用方拿到的 id 就是它要的 id，少一个会变成「头像莫名消失」，
 * 参数错误要显式回 400。
 */
export function parseAvatarIds(rawValue) {
  if (typeof rawValue !== 'string') return { ok: false, status: 400, error: 'bad_ids' };

  const ids = [];
  const seen = new Set();
  for (const part of rawValue.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  // 先判数量：参数形状不对（空 / 太多）比「其中某个 id 字符非法」更接近根因。
  if (ids.length === 0 || ids.length > MAX_AVATAR_IDS) {
    return { ok: false, status: 400, error: 'bad_ids' };
  }
  for (const id of ids) {
    if (id === USER_AVATAR_ID) continue;
    // 点段（`.` / `..`）能通过下面的字符集，但拼进 `/api/agents/<id>/avatar` 后会被
    // URL 归一化上跳一层（`/api/agents/../avatar` 就是 `/api/avatar`）。契约正则放行它，
    // 这里额外拒掉是有意的：现在只会上跳一层、拿到的还是调用方自己的头像，
    // 但「正则允许一个让路径上跳的段」本身就不该留着，将来谁换拼接方式就会出事。
    if (id === '.' || id === '..') return { ok: false, status: 400, error: 'bad_id' };
    if (!AVATAR_ID_RE.test(id)) return { ok: false, status: 400, error: 'bad_id' };
  }
  return { ok: true, ids };
}

/** id → 上游路径。`user` 是用户头像；其余按 agent 头像拼，id 整体转义。 */
export function upstreamPathForAvatarId(id) {
  if (id === USER_AVATAR_ID) return USER_AVATAR_PATH;
  return `/api/agents/${encodeURIComponent(id)}/avatar`;
}

/* ------------------------------------------------------------------ */
/* 序列化与 etag                                                       */
/* ------------------------------------------------------------------ */

/**
 * 上游 content-type 原样写进 data URL，只把 `;` 后面的空白去掉
 * （`image/png; charset=binary` 在 URL 里带空格不保险）。不是 `image/*` 返回 null。
 */
export function normalizeImageMime(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/;\s+/g, ';');
  if (!trimmed) return null;
  const base = trimmed.split(';')[0].trim().toLowerCase();
  if (!base.startsWith('image/') || base.length <= 'image/'.length) return null;
  return trimmed;
}

export function toDataUrl(mime, bytes) {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** 弱 etag：body 的 sha256 前 16 个 hex。同一个 body 必然同一个 etag。 */
export function etagForBody(body) {
  const hash = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}

/* ------------------------------------------------------------------ */
/* 抓单张                                                              */
/* ------------------------------------------------------------------ */

/**
 * 向上游要一张头像。永远 resolve 成 `{ ok: true, mime, bytes }` 或
 * `{ ok: false, reason }` —— 单张失败绝不能影响其它 id，所以不 reject。
 */
function requestAvatar({ upstream, timeoutMs, maxBytes, id, cookie, userAgent }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const headers = {
      host: `${upstream.host}:${upstream.port}`,
      cookie,
      accept: 'image/*',
      connection: 'close',
    };
    // 只带这三个：if-none-match 之类若透传，上游可能回 304，这里就拿不到图了。
    if (userAgent) headers['user-agent'] = userAgent;

    let req;
    try {
      req = http.request(
        {
          host: upstream.host,
          port: upstream.port,
          method: 'GET',
          path: upstreamPathForAvatarId(id),
          headers,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode || 0;
          if (status !== 200) {
            upstreamRes.resume();
            finish({ ok: false, reason: 'upstream_status' });
            return;
          }
          const mime = normalizeImageMime(upstreamRes.headers['content-type']);
          if (!mime) {
            upstreamRes.resume();
            finish({ ok: false, reason: 'not_image' });
            return;
          }

          const chunks = [];
          let size = 0;
          let tooLarge = false;
          upstreamRes.on('data', (chunk) => {
            if (tooLarge) return;
            size += chunk.length;
            // 超限就立刻停手：128KB 的头像不值得读完再说不要。
            if (size > maxBytes) {
              tooLarge = true;
              chunks.length = 0;
              upstreamRes.destroy();
              finish({ ok: false, reason: 'too_large' });
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            if (tooLarge) return;
            finish({ ok: true, mime, bytes: Buffer.concat(chunks) });
          });
          upstreamRes.on('error', () => finish({ ok: false, reason: 'read_failed' }));
          // 上游响应没读完就断开不会有 'end'：不接住 'close' 这个 promise 会永远挂着。
          upstreamRes.on('close', () => {
            if (!upstreamRes.complete) finish({ ok: false, reason: 'read_failed' });
          });
        },
      );
    } catch {
      finish({ ok: false, reason: 'request_failed' });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error(`avatar upstream idle > ${timeoutMs}ms`));
    });
    req.on('error', () => finish({ ok: false, reason: timedOut ? 'timeout' : 'request_failed' }));
    req.end();
  });
}

/** 并发上限内的 map：固定 workers 取队首，保证任意时刻在途数不超过 limit。 */
async function mapWithinLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.min(limit, items.length);
  const runners = [];
  for (let i = 0; i < width; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

/**
 * 极小的 LRU：Map 的插入顺序就是新旧顺序，命中时删了再塞回去即「触碰」。
 * 键是 `<cookie 身份的 sha256>\n<id>`，不同账号绝不会读到彼此的条目。
 */
function createAvatarCache({ ttlMs, maxEntries, now }) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (now() - entry.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      map.delete(key);
      map.set(key, entry);
      return entry;
    },
    set(key, entry) {
      map.delete(key);
      map.set(key, entry);
      while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    get size() {
      return map.size;
    },
  };
}

function cookieIdentityOf(cookie) {
  return createHash('sha256').update(String(cookie || ''), 'utf8').digest('hex');
}

/** 缓存与在途合并共用一个键：Cookie 身份哈希 + id。不同账号绝不共享同一条。 */
function entryKey(identity, id) {
  return `${identity}\n${id}`;
}

/* ------------------------------------------------------------------ */
/* 端点                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * @param {object} [options]
 * @param {{ host: string, port: number }} [options.upstream] 上游地址（默认取自 config）
 * @param {Function} [options.checkAuth]  鉴权实现，默认 checkReadAuth
 * @param {Function} [options.deny]       拒绝实现，默认 denyRead
 * @param {Function} [options.now]        时间源，测试可注入
 */
export function createAvatarPack({
  upstream = UPSTREAM,
  timeoutMs = AVATAR_UPSTREAM_TIMEOUT_MS,
  maxImageBytes = MAX_AVATAR_BYTES,
  maxPackBytes = MAX_AVATAR_PACK_BYTES,
  concurrency = AVATAR_FETCH_CONCURRENCY,
  cacheTtlMs = AVATAR_CACHE_TTL_MS,
  cacheMaxEntries = AVATAR_CACHE_MAX_ENTRIES,
  checkAuth = checkReadAuth,
  deny = denyRead,
  now = () => Date.now(),
} = {}) {
  const cache = createAvatarCache({ ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries, now });
  /**
   * `<身份哈希>\n<id>` → 在途 Promise。只装「正在进行的回源」，落定即摘（见 fetchAvatar）：
   * 留着成功值是多余的——LRU 已经有一份，TTL 与容量由它管；
   * 留着失败值更糟：一次超时会变成后来每一个请求的结果。
   * 条目数天然被在途请求约束（每个正在抓的 id 一条），不需要额外的淘汰逻辑。
   */
  const inflight = new Map();

  /** 回源一次并落缓存。永远 resolve 成一条缓存条目，同键并发共享这个 Promise。 */
  async function fetchAvatar({ key, id, cookie, userAgent }) {
    const outcome = await requestAvatar({
      upstream,
      timeoutMs,
      maxBytes: maxImageBytes,
      id,
      cookie,
      userAgent,
    });

    if (outcome.ok) {
      const entry = { dataUrl: toDataUrl(outcome.mime, outcome.bytes), mime: outcome.mime, ts: now() };
      cache.set(key, entry);
      return entry;
    }
    const entry = { dataUrl: null, mime: null, ts: now(), reason: outcome.reason };
    if (CACHEABLE_FAILURE_REASONS.has(outcome.reason)) cache.set(key, entry);
    return entry;
  }

  /** 抓一张并按「是否确定性失败」决定要不要记住结果；同一键的在途回源只发一次。 */
  async function resolveAvatar({ identity, id, cookie, userAgent }) {
    const key = entryKey(identity, id);
    const hit = cache.get(key);
    if (hit) return hit;

    const pending = inflight.get(key);
    if (pending) return pending;

    // 从上面的 get 到这里之间没有 await：同一 tick 里不会有两个调用者都走到这里。
    let task;
    task = fetchAvatar({ key, id, cookie, userAgent }).finally(() => {
      // 成功/失败都要摘：失败若留在表里，后来的请求会一直拿到那次失败（超时尤其明显）。
      if (inflight.get(key) === task) inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  }

  async function handle(req, res) {
    // 只接 GET：其它方法（含 HEAD）一律 405，并显式告诉调用方该用什么。
    if (String(req.method || '').toUpperCase() !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return;
    }

    // 这是网关自己的端点，/api/* 的反代鉴权流程到不了这里：必须自己问一次上游登录态。
    const auth = await checkAuth(req);
    if (!auth.ok) {
      deny(res, auth);
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'bad_ids' });
      return;
    }
    const parsed = parseAvatarIds(parsedUrl.searchParams.get('ids'));
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const { ids } = parsed;

    const cookie = String(req.headers.cookie || '');
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    const identity = cookieIdentityOf(cookie);

    // 先查缓存：全命中时这里一个上游请求都不发，304 判定就只靠缓存算 hash。
    const entries = new Array(ids.length).fill(null);
    const misses = [];
    for (let i = 0; i < ids.length; i += 1) {
      const hit = cache.get(entryKey(identity, ids[i]));
      if (hit) entries[i] = hit;
      else misses.push(i);
    }

    if (misses.length > 0) {
      const fetched = await mapWithinLimit(misses, concurrency, async (index) =>
        resolveAvatar({ identity, id: ids[index], cookie, userAgent }),
      );
      misses.forEach((index, slot) => {
        entries[index] = fetched[slot];
      });
    }

    // 按请求里的 id 顺序拼：同一个缓存状态必然拼出同一个 body，etag 才稳定。
    const avatars = Object.create(null);
    const skipped = [];
    let totalBytes = 0;
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const entry = entries[i];
      const dataUrl = entry?.dataUrl || '';
      if (!dataUrl) {
        skipped.push(id);
        continue;
      }
      const size = Buffer.byteLength(dataUrl);
      // 总预算用完：这张和后面所有成功的 id 都进 skipped，响应本身仍是 200。
      if (totalBytes + size > maxPackBytes) {
        skipped.push(id);
        continue;
      }
      totalBytes += size;
      avatars[id] = dataUrl;
    }

    const body = JSON.stringify({ avatars, skipped });
    const etag = etagForBody(body);

    // 客户端已经走了（关连接/宿主的对话超时）：既不用算也不用写。
    if (res.destroyed || res.writableEnded) return;

    // 条件请求命中本地缓存算出来的 etag：304 且不带 body，不为算 hash 再拉一遍上游。
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': RESPONSE_CACHE_CONTROL });
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': RESPONSE_CACHE_CONTROL,
      etag,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  return {
    handle,
    /** 仅供诊断/测试：当前缓存条数。 */
    cacheSize: () => cache.size,
  };
}

/* ------------------------------------------------------------------ */
/* 路由判定                                                            */
/* ------------------------------------------------------------------ */

/** 请求 URL 的 pathname（与 server.mjs 现有写法一致：按 origin-form 解析）。 */
export function avatarPackPathname(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/** 精确匹配 `/api/mobile/avatars`：`/api/mobile/avatars/x`、`/api/mobile/avatar%73` 都不算。 */
export function isAvatarPackPath(rawUrl) {
  return avatarPackPathname(rawUrl) === AVATAR_PACK_PATH;
}
